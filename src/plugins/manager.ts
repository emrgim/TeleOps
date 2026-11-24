/**
 * Plugins (Connectors → Plugins): code from a public GitHub repository, pinned to one commit, that runs inside
 * TeleOps. A plugin's main file exports `start(ctx)`; through ctx it reads events, reads and sends messages,
 * adds MCP tools and web addresses, and keeps settings and data. A plugin that keeps failing — or throws where
 * nobody catches it — is stopped; the server goes on. Code lives in <data>/plugins/<id>/<commit>/, the plugin's
 * own files in <data>/plugins/<id>/data/.
 */
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { z } from 'zod'
import { config, VERSION } from '../config.js'
import { now, upsertMany, type DbHandle } from '../db/index.js'
import { describeEvent, type BusEvent, type EventBus } from '../events.js'
import { tr, type Lang } from '../i18n.js'
import { logger } from '../log.js'
import type { AccountManager } from '../tg/manager.js'
import type { TgService } from '../tg/service.js'
import { AppError } from '../util.js'
import { downloadCommit, isSha, parseRepo, resolveRepo, type Resolved } from './github.js'
import { iconOf, localize, MANIFEST_FILE, readManifest, type Manifest } from './manifest.js'

export type PluginState = 'running' | 'starting' | 'stopped' | 'error' | 'settings'
type Values = Record<string, string | number | boolean>
type Row = {
  id: string
  repo: string
  ref: string | null
  branch: string | null
  sha: string
  manifest: string
  settings: string | null
  enabled: number
  error: string | null
  installed_at: number
  updated_at: number
}

type JsonSchemaLike = { type?: string; description?: string; enum?: unknown[]; items?: JsonSchemaLike; properties?: Record<string, JsonSchemaLike>; required?: string[] | boolean }

export type PluginToolDef = {
  name: string
  title?: string
  description: string
  /** read = only reads; send = changes something (default) */
  scope?: 'read' | 'send'
  /** JSON Schema of the arguments ({ type: 'object', properties, required }) or just the properties */
  input?: JsonSchemaLike | Record<string, JsonSchemaLike>
  run: (args: Record<string, unknown>, extra: { accounts: string[] | '*' }) => unknown
}
export type PluginRequest = { method: string; path: string; params: Record<string, string>; query: Record<string, unknown>; headers: Record<string, unknown>; body: unknown; rawBody: Buffer | null }
type RouteAuth = 'none' | 'read' | 'send' | 'admin'
export type PluginRouteDef = { method: string; path: string; auth: RouteAuth; run: (req: PluginRequest) => unknown }

type Running = {
  tools: Map<string, PluginToolDef>
  routes: PluginRouteDef[]
  timers: Set<ReturnType<typeof setTimeout>>
  listeners: ((ev: BusEvent) => void)[]
  stop?: () => unknown
  faults: number[]
}

export type PluginDeps = {
  h: DbHandle
  bus: EventBus
  accounts: Pick<AccountManager, 'list' | 'get'>
  svc: Pick<TgService, 'sendText' | 'getMessages' | 'listChats' | 'searchMessages'>
  /** public address of this TeleOps (for the web addresses of plugins) */
  origin: () => string
  language: () => string
}

const REPLY = Symbol('teleops.reply')
const toolPrefix = (id: string) => id.replace(/-/g, '_')
const sameRepo = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

function within<T>(p: Promise<T>, ms: number, err: () => Error): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(err()), ms)
    ;(t as { unref?: () => void }).unref?.()
    p.then(
      (v) => {
        clearTimeout(t)
        resolve(v)
      },
      (e) => {
        clearTimeout(t)
        reject(e)
      },
    )
  })
}

/** Errors are kept as the template of TeleOps' own errors (shown in the language of the page) or as text. */
function errText(e: unknown): string {
  if (e instanceof AppError) return JSON.stringify({ t: e.template, p: e.params })
  return String((e as Error)?.message ?? e).slice(0, 500)
}
function showErr(s: string | null, lang: Lang): string | null {
  if (!s) return null
  if (s.startsWith('{"t":')) {
    try {
      const o = JSON.parse(s) as { t: string; p: unknown[] }
      return tr(lang, o.t, o.p ?? [])
    } catch {
      /* plain text */
    }
  }
  return s
}

const matches = (want: string, type: string) => want === '*' || want === type || (want.endsWith('.*') && type.startsWith(want.slice(0, -1)))

function zodOf(p: JsonSchemaLike | undefined): z.ZodTypeAny {
  let t: z.ZodTypeAny
  switch (p?.type) {
    case 'string':
      t = Array.isArray(p.enum) && p.enum.length ? z.enum(p.enum.map(String) as [string, ...string[]]) : z.string()
      break
    case 'number':
      t = z.number()
      break
    case 'integer':
      t = z.number().int()
      break
    case 'boolean':
      t = z.boolean()
      break
    case 'array':
      t = z.array(p.items ? zodOf(p.items) : z.any())
      break
    case 'object':
      t = z.record(z.string(), z.any())
      break
    default:
      t = z.any()
  }
  return p?.description ? t.describe(String(p.description)) : t
}

/** MCP arguments of a plugin tool, from JSON Schema (or a plain map of properties). */
export function toShape(input: unknown): z.ZodRawShape {
  const i = (input ?? {}) as JsonSchemaLike
  const schema = i.type === 'object' || (i.properties && typeof i.properties === 'object')
  const props = (schema ? i.properties ?? {} : (input ?? {})) as Record<string, JsonSchemaLike>
  const required = new Set<string>(schema && Array.isArray(i.required) ? i.required : Object.entries(props).filter(([, p]) => p?.required === true).map(([k]) => k))
  const shape: Record<string, z.ZodTypeAny> = {}
  for (const [k, p] of Object.entries(props)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(k) || !p || typeof p !== 'object') continue
    const t = zodOf(p)
    shape[k] = required.has(k) ? t : t.optional()
  }
  return shape as z.ZodRawShape
}

function countFiles(dir: string): number {
  let n = 0
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) n += e.isDirectory() ? countFiles(path.join(dir, e.name)) : 1
  return n
}

export class PluginManager {
  readonly dir = path.join(config.dataDir, 'plugins')
  private rows = new Map<string, Row>()
  private running = new Map<string, Running>()
  private states = new Map<string, { state: PluginState; error: string | null }>()
  private busy = new Set<string>()
  private loads = 0

  constructor(private deps: PluginDeps) {}

  // ---------------------------------------------------------------- lifecycle

  /** At start: every installed plugin, the enabled ones running. */
  async loadAll(): Promise<void> {
    const rows = (await this.deps.h.db.selectFrom('plugins').selectAll().execute()) as Row[]
    for (const r of rows) {
      this.rows.set(r.id, r)
      this.states.set(r.id, { state: r.enabled ? 'starting' : 'stopped', error: r.enabled ? null : r.error })
    }
    for (const r of rows) if (r.enabled) await this.start(r.id)
    this.cleanStaging()
  }

  async stopAll(): Promise<void> {
    for (const id of [...this.running.keys()]) await this.teardown(id)
  }

  private row(id: string): Row {
    const r = this.rows.get(id)
    if (!r) throw new AppError('PLUGIN_NOT_FOUND', 'No plugin "{0}" is installed', 404, [id])
    return r
  }
  private manifestOf(r: Row): Manifest {
    return JSON.parse(r.manifest) as Manifest
  }
  private values(r: Row): Values {
    try {
      return { ...(JSON.parse(r.settings || '{}') as Values) }
    } catch {
      return {}
    }
  }
  /** The settings the plugin sees: what was saved, the manifest's defaults otherwise. */
  private effective(r: Row): Values {
    const v = this.values(r)
    const out: Values = {}
    for (const s of this.manifestOf(r).settings) {
      const x = v[s.key] ?? s.default
      if (x !== undefined && x !== '') out[s.key] = x
    }
    return out
  }
  private setState(id: string, state: PluginState, error: string | null) {
    this.states.set(id, { state, error })
  }
  private async saveError(id: string, error: string | null) {
    const r = this.rows.get(id)
    if (!r || r.error === error) return
    r.error = error
    await this.deps.h.db.updateTable('plugins').set({ error }).where('id', '=', id).execute()
  }
  private log(id: string) {
    return logger.child({ mod: 'plugin', plugin: id })
  }

  /** The code of the installed commit; after a restore on another computer it is downloaded again (same commit). */
  private async ensureFiles(r: Row): Promise<string> {
    const dir = path.join(this.dir, r.id, r.sha)
    if (fs.existsSync(path.join(dir, MANIFEST_FILE))) return dir
    const [owner, repo] = r.repo.split('/')
    const tmp = `${dir}.part-${process.pid}-${Date.now()}`
    try {
      await downloadCommit({ owner, repo, sha: r.sha }, tmp)
      fs.rmSync(dir, { recursive: true, force: true })
      fs.renameSync(tmp, dir)
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
    return dir
  }

  /** Start (or restart) one plugin. Failures are kept on the plugin (state error), never thrown. */
  private async start(id: string): Promise<void> {
    await this.teardown(id)
    const r = this.row(id)
    const m = this.manifestOf(r)
    const vals = this.effective(r)
    if (m.settings.some((s) => s.required && (vals[s.key] === undefined || vals[s.key] === ''))) {
      this.setState(id, 'settings', null)
      return
    }
    this.setState(id, 'starting', null)
    const run: Running = { tools: new Map(), routes: [], timers: new Set(), listeners: [], faults: [] }
    try {
      const dir = await this.ensureFiles(r)
      // a new URL for every start: a restart runs the module again
      const url = `${pathToFileURL(path.join(dir, m.main)).href}?load=${++this.loads}`
      const mod = (await import(url)) as Record<string, unknown>
      const entry = (mod.default ?? mod) as { start?: (ctx: unknown) => unknown; stop?: (ctx: unknown) => unknown } | ((ctx: unknown) => unknown)
      const startFn = typeof entry === 'function' ? entry : typeof entry?.start === 'function' ? entry.start.bind(entry) : null
      if (!startFn) throw new AppError('PLUGIN_NO_START', 'The plugin has no start function: its main file must export default { start(ctx) }', 400)
      this.running.set(id, run)
      const ctx = this.context(id, r, m, vals, run)
      const ret = await within(Promise.resolve(startFn(ctx)), 30_000, () => new AppError('PLUGIN_START_TIMEOUT', 'The plugin did not finish starting within {0} seconds', 504, [30]))
      if (typeof ret === 'function') run.stop = ret as () => unknown
      else if (typeof entry === 'object' && typeof entry?.stop === 'function') run.stop = () => entry.stop?.(ctx)
      this.setState(id, 'running', null)
      await this.saveError(id, null)
      this.log(id).info({ sha: r.sha.slice(0, 7) }, 'plugin started')
    } catch (e) {
      await this.teardown(id)
      const msg = errText(e)
      this.setState(id, 'error', msg)
      await this.saveError(id, msg).catch(() => undefined)
      logger.warn({ mod: 'plugins', plugin: id, err: String((e as Error)?.stack ?? e) }, 'plugin failed to start')
    }
  }

  /** Stop one plugin: its listeners, timers, tools and web addresses go away, then its own stop runs. */
  private async teardown(id: string): Promise<void> {
    const run = this.running.get(id)
    if (!run) return
    this.running.delete(id)
    for (const l of run.listeners) this.deps.bus.off('event', l)
    for (const t of run.timers) clearTimeout(t)
    run.timers.clear()
    if (run.stop) {
      try {
        await within(Promise.resolve(run.stop()), 5_000, () => new Error('stop took more than 5 seconds'))
      } catch (e) {
        this.log(id).warn({ err: String((e as Error)?.stack ?? e) }, 'plugin stop failed')
      }
    }
  }

  // ---------------------------------------------------------------- what a plugin gets

  private context(id: string, r: Row, m: Manifest, settings: Values, run: Running) {
    const log = this.log(id)
    const alive = () => {
      if (this.running.get(id) !== run) throw new AppError('PLUGIN_STOPPED', 'This plugin is stopped', 409)
    }
    // code the plugin hands to TeleOps (event handlers, timers): an error is the plugin's, never the server's
    const safe =
      <A extends unknown[]>(where: string, fn: (...a: A) => unknown) =>
      (...a: A) => {
        if (this.running.get(id) !== run) return
        try {
          const out = fn(...a)
          if (out && typeof (out as Promise<unknown>).then === 'function') (out as Promise<unknown>).then(undefined, (e) => this.fault(id, run, e, where))
        } catch (e) {
          this.fault(id, run, e, where)
        }
      }
    const acc = (a?: string | null) => this.deps.accounts.get(a ?? undefined)
    const dataDir = path.join(this.dir, id, 'data')
    fs.mkdirSync(dataDir, { recursive: true })
    const text = (v: unknown) => (v === undefined || v === null ? undefined : String(v))
    return Object.freeze({
      id,
      plugin: Object.freeze({ id, name: m.name, version: m.version ?? null, repo: r.repo, sha: r.sha }),
      teleops: Object.freeze({ version: VERSION, language: this.deps.language() }),
      settings: Object.freeze({ ...settings }),
      dataDir,
      log: Object.freeze({
        info: (msg: unknown, extra?: Record<string, unknown>) => log.info(extra ?? {}, String(msg)),
        warn: (msg: unknown, extra?: Record<string, unknown>) => log.warn(extra ?? {}, String(msg)),
        error: (msg: unknown, extra?: Record<string, unknown>) => log.error(extra ?? {}, String(msg)),
      }),
      on: (type: string, handler: (ev: unknown) => unknown) => {
        alive()
        if (typeof handler !== 'function') throw new TypeError('ctx.on(type, handler): handler must be a function')
        const call = safe(`event ${type}`, handler)
        const l = (ev: BusEvent) => {
          if (!ev.adminOnly && matches(String(type), ev.type)) call(this.publicEvent(ev))
        }
        this.deps.bus.on('event', l)
        run.listeners.push(l)
      },
      accounts: () =>
        this.deps.accounts.list().map((a) => {
          const s = a.status() as Record<string, unknown>
          return { id: s.id, kind: s.kind, name: s.name, username: s.username ?? null, state: s.state, default: !!s.default }
        }),
      send: async (o: { account?: string; to: string; text: string; parseMode?: string; replyTo?: string; silent?: boolean; threadId?: string; buttons?: unknown[] }) => {
        alive()
        return this.deps.svc.sendText(acc(o?.account), {
          to: String(o?.to ?? ''),
          text: String(o?.text ?? ''),
          parseMode: o?.parseMode as never,
          replyTo: text(o?.replyTo),
          silent: o?.silent,
          threadId: text(o?.threadId),
          buttons: o?.buttons as never,
        })
      },
      messages: async (o: { account?: string; chat: string; limit?: number; before?: string; after?: string }) => {
        alive()
        return this.deps.svc.getMessages(acc(o?.account), String(o?.chat ?? ''), { limit: o?.limit, before: o?.before, after: o?.after })
      },
      chats: async (o: { account?: string; limit?: number; query?: string } = {}) => {
        alive()
        return this.deps.svc.listChats(acc(o?.account), { limit: o?.limit, query: o?.query })
      },
      search: async (o: { account?: string; query: string; chat?: string; limit?: number; since?: string }) => {
        alive()
        return this.deps.svc.searchMessages(acc(o?.account), String(o?.query ?? ''), { chat: o?.chat, limit: o?.limit, since: o?.since })
      },
      tool: (def: PluginToolDef) => {
        alive()
        this.addTool(id, run, def)
      },
      route: (method: string, p: string, handler: PluginRouteDef['run'], opts?: { auth?: RouteAuth }) => {
        alive()
        this.addRoute(run, method, p, handler, opts)
      },
      reply: (status: number, body?: unknown, headers?: Record<string, string>) => ({ [REPLY]: true, status: Number(status) || 200, body, headers: headers ?? {} }),
      url: (sub = '') => `${this.deps.origin().replace(/\/+$/, '')}/plugins/${id}/${String(sub).replace(/^\/+/, '')}`,
      store: Object.freeze({
        get: (k: string) => this.kvGet(id, k),
        set: (k: string, v: unknown) => this.kvSet(id, k, v),
        delete: (k: string) => this.kvDel(id, k),
        keys: () => this.kvKeys(id),
      }),
      every: (ms: number, fn: () => unknown) => {
        alive()
        const t = setInterval(safe('timer', fn), Math.max(1000, Number(ms) || 0))
        ;(t as { unref?: () => void }).unref?.()
        run.timers.add(t)
        return () => {
          clearInterval(t)
          run.timers.delete(t)
        }
      },
      after: (ms: number, fn: () => unknown) => {
        alive()
        const call = safe('timer', fn)
        const t = setTimeout(() => {
          run.timers.delete(t)
          call()
        }, Math.max(0, Number(ms) || 0))
        ;(t as { unref?: () => void }).unref?.()
        run.timers.add(t)
        return () => {
          clearTimeout(t)
          run.timers.delete(t)
        }
      },
      fetch: (input: string | URL | Request, init?: RequestInit) => fetch(input, init),
    })
  }

  /** An event as webhooks get it, plus the line in plain words. */
  private publicEvent(ev: BusEvent) {
    let name: string | null = null
    let kind: string | null = null
    try {
      const a = this.deps.accounts.get(ev.account)
      name = a.displayName()
      kind = a.kind
    } catch {
      /* the account is gone */
    }
    return { id: ev.id, type: ev.type, account: ev.account, at: new Date(ev.at).toISOString(), data: ev.data, context: describeEvent(ev, name, kind) }
  }

  private addTool(id: string, run: Running, def: PluginToolDef) {
    if (!def || typeof def.run !== 'function') throw new TypeError('ctx.tool({ name, description, input, run }): run must be a function')
    const name = String(def.name ?? '')
    if (!/^[a-z][a-z0-9_]*$/.test(name) || toolPrefix(id).length + 1 + name.length > 64) throw new TypeError(`ctx.tool: "${name}" must be a-z, 0-9 and _, starting with a letter (with the plugin id at most 64 characters)`)
    if (!def.description || typeof def.description !== 'string') throw new TypeError(`ctx.tool("${name}"): a description is required (the agent reads it)`)
    run.tools.set(name, { ...def, name, scope: def.scope === 'read' ? 'read' : 'send' })
  }

  private addRoute(run: Running, method: string, p: string, handler: PluginRouteDef['run'], opts?: { auth?: RouteAuth }) {
    const m = String(method ?? '').toUpperCase()
    if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(m)) throw new TypeError('ctx.route(method, path, handler): method is GET, POST, PUT, PATCH or DELETE')
    if (typeof handler !== 'function') throw new TypeError('ctx.route(method, path, handler): handler must be a function')
    const clean = String(p ?? '').replace(/^\/+|\/+$/g, '')
    if (clean && !/^[A-Za-z0-9._~@:-]+(\/[A-Za-z0-9._~@:-]+)*$/.test(clean)) throw new TypeError(`ctx.route: "${p}" is not a valid path`)
    const auth = opts?.auth ?? 'admin'
    if (!['none', 'read', 'send', 'admin'].includes(auth)) throw new TypeError('ctx.route: auth is none, read, send or admin')
    run.routes.push({ method: m, path: clean, auth, run: handler })
  }

  /** The web address of a plugin that answers this request (GET /plugins/<id>/<path>). */
  route(id: string, method: string, sub: string): { def: PluginRouteDef; params: Record<string, string> } {
    const notFound = () => new AppError('NOT_FOUND', '{0} {1} not found', 404, [method, `/plugins/${id}/${sub}`])
    const run = this.running.get(id)
    if (!run) throw notFound()
    const segs = String(sub ?? '').split('/').filter(Boolean)
    for (const r of run.routes) {
      if (r.method !== method) continue
      const rs = r.path ? r.path.split('/') : []
      if (rs.length !== segs.length) continue
      const params: Record<string, string> = {}
      let ok = true
      for (let i = 0; i < rs.length && ok; i++) {
        if (rs[i].startsWith(':')) {
          try {
            params[rs[i].slice(1)] = decodeURIComponent(segs[i])
          } catch {
            ok = false
          }
        } else if (rs[i] !== segs[i]) ok = false
      }
      if (ok) return { def: r, params }
    }
    throw notFound()
  }

  async runRoute(id: string, def: PluginRouteDef, req: PluginRequest): Promise<{ status: number; headers: Record<string, string>; body: unknown }> {
    let out: unknown
    try {
      out = await within(Promise.resolve(def.run(req)), 60_000, () => new AppError('PLUGIN_TIMEOUT', 'The plugin did not answer within {0} seconds', 504, [60]))
    } catch (e) {
      if (e instanceof AppError) throw e
      this.log(id).warn({ err: String((e as Error)?.stack ?? e) }, `${def.method} /plugins/${id}/${def.path} failed`)
      throw new AppError('PLUGIN_FAILED', 'The plugin failed: {0}', 500, [String((e as Error)?.message ?? e).slice(0, 300)])
    }
    if (out && typeof out === 'object' && (out as Record<symbol, unknown>)[REPLY]) {
      const o = out as { status: number; body: unknown; headers: Record<string, string> }
      return { status: o.status, headers: o.headers, body: o.body }
    }
    if (out === undefined || out === null) return { status: 204, headers: {}, body: undefined }
    return { status: 200, headers: {}, body: out }
  }

  /** The MCP tools of the running plugins: <plugin>_<tool>. */
  tools(): { name: string; title: string; description: string; scope: 'read' | 'send'; shape: z.ZodRawShape; run: (args: Record<string, unknown>, extra: { accounts: string[] | '*' }) => Promise<unknown> }[] {
    const out: ReturnType<PluginManager['tools']> = []
    for (const [id, run] of this.running) {
      for (const t of run.tools.values()) {
        out.push({
          name: `${toolPrefix(id)}_${t.name}`,
          title: t.title || t.name,
          description: t.description,
          scope: t.scope === 'read' ? 'read' : 'send',
          shape: toShape(t.input),
          run: async (args, extra) => {
            if (this.running.get(id) !== run) throw new AppError('PLUGIN_STOPPED', 'This plugin is stopped', 409)
            return within(Promise.resolve(t.run(args, extra)), 120_000, () => new AppError('PLUGIN_TIMEOUT', 'The plugin did not answer within {0} seconds', 504, [120]))
          },
        })
      }
    }
    return out
  }

  // ---------------------------------------------------------------- errors of plugin code

  private fault(id: string, run: Running, e: unknown, where: string) {
    this.log(id).error({ err: String((e as Error)?.stack ?? e) }, `plugin error (${where})`)
    const t = Date.now()
    run.faults = run.faults.filter((x) => t - x < 60_000)
    run.faults.push(t)
    if (run.faults.length >= 20 && this.running.get(id) === run) {
      void this.crash(id, new AppError('PLUGIN_FAILING', 'The plugin failed too often and was stopped: {0}', 500, [String((e as Error)?.message ?? e).slice(0, 300)]))
    }
  }

  private async crash(id: string, e: unknown) {
    await this.teardown(id)
    const msg = errText(e)
    this.setState(id, 'error', msg)
    await this.saveError(id, msg).catch(() => undefined)
    logger.error({ mod: 'plugins', plugin: id, err: String((e as Error)?.stack ?? e) }, 'plugin stopped after an error')
  }

  /** Which running plugin an error comes from: its stack goes through that plugin's folder. */
  blame(e: unknown): string | null {
    const stack = String((e as Error)?.stack ?? '')
    if (!stack) return null
    for (const id of this.running.keys()) {
      const dir = path.join(this.dir, id) + path.sep
      if (stack.includes(dir) || stack.includes(pathToFileURL(dir).href)) return id
    }
    return null
  }

  /** An error thrown by plugin code that nobody caught: that plugin stops, the server goes on. */
  contain(e: unknown): boolean {
    const id = this.blame(e)
    if (!id) return false
    void this.crash(id, new AppError('PLUGIN_CRASHED', 'The plugin stopped with an error: {0}', 500, [String((e as Error)?.message ?? e).slice(0, 300)]))
    return true
  }

  /** A promise of plugin code failed and nobody handled it: an error of that plugin. */
  rejected(e: unknown): boolean {
    const id = this.blame(e)
    const run = id ? this.running.get(id) : undefined
    if (!id || !run) return false
    this.fault(id, run, e, 'unhandled rejection')
    return true
  }

  // ---------------------------------------------------------------- data of a plugin (ctx.store)

  private async kvGet(id: string, k: string): Promise<unknown> {
    const r = await this.deps.h.db.selectFrom('plugin_data').select('v').where('plugin_id', '=', id).where('k', '=', String(k)).executeTakeFirst()
    if (!r?.v) return undefined
    try {
      return JSON.parse(r.v as string)
    } catch {
      return undefined
    }
  }
  private async kvSet(id: string, k: string, v: unknown): Promise<void> {
    const key = String(k ?? '')
    if (!key || key.length > 191) throw new TypeError('ctx.store: a key is 1 to 191 characters')
    if (v === undefined) return this.kvDel(id, key)
    const json = JSON.stringify(v)
    if (json.length > 1_000_000) throw new TypeError('ctx.store: a value is at most 1 MB as JSON')
    await upsertMany(this.deps.h, 'plugin_data', [{ plugin_id: id, k: key, v: json, updated_at: now() }], ['plugin_id', 'k'])
  }
  private async kvDel(id: string, k: string): Promise<void> {
    await this.deps.h.db.deleteFrom('plugin_data').where('plugin_id', '=', id).where('k', '=', String(k)).execute()
  }
  private async kvKeys(id: string): Promise<string[]> {
    const rows = await this.deps.h.db.selectFrom('plugin_data').select('k').where('plugin_id', '=', id).orderBy('k').execute()
    return rows.map((r) => String(r.k))
  }

  // ---------------------------------------------------------------- install, update, settings

  private cleanStaging() {
    const base = path.join(this.dir, '.staging')
    if (!fs.existsSync(base)) return
    for (const e of fs.readdirSync(base)) {
      const p = path.join(base, e)
      try {
        if (Date.now() - fs.statSync(p).mtimeMs > 3600_000) fs.rmSync(p, { recursive: true, force: true })
      } catch {
        /* ignore */
      }
    }
  }

  /** Download a commit once: a check and then the install use the same files. */
  private async stage(res: Resolved): Promise<{ dir: string; manifest: Manifest; files: number }> {
    const dir = path.join(this.dir, '.staging', `${res.owner}-${res.repo}-${res.sha}`.toLowerCase())
    const done = path.join(dir, '.teleops-complete')
    if (!fs.existsSync(done)) {
      this.cleanStaging()
      const tmp = `${dir}.part-${process.pid}-${Date.now()}`
      try {
        await downloadCommit(res, tmp)
        fs.writeFileSync(path.join(tmp, '.teleops-complete'), String(Date.now()))
        fs.rmSync(dir, { recursive: true, force: true })
        fs.renameSync(tmp, dir)
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true })
      }
    }
    return { dir, manifest: readManifest(dir), files: countFiles(dir) - 1 }
  }

  /** Move a staged commit to the plugin's folder. */
  private place(stagedDir: string, id: string, sha: string): void {
    const final = path.join(this.dir, id, sha)
    fs.mkdirSync(path.dirname(final), { recursive: true })
    fs.rmSync(final, { recursive: true, force: true })
    fs.renameSync(stagedDir, final)
    fs.rmSync(path.join(final, '.teleops-complete'), { force: true })
  }

  /** What a repository holds, without installing it. */
  async preview(input: string, lang: Lang = 'en') {
    const res = await resolveRepo(parseRepo(input))
    const st = await this.stage(res)
    const m = st.manifest
    const repo = `${res.owner}/${res.repo}`
    const existing = this.rows.get(m.id)
    const l = localize(m, lang)
    return {
      id: m.id,
      name: l.name,
      description: l.description,
      version: m.version ?? null,
      author: m.author ?? null,
      homepage: m.homepage ?? `https://github.com/${repo}`,
      repo,
      repoUrl: `https://github.com/${repo}`,
      ref: res.ref,
      branch: res.branch,
      sha: res.sha,
      commitUrl: `https://github.com/${repo}/commit/${res.sha}`,
      files: st.files,
      settings: l.settings.map((s) => ({ key: s.key, label: s.label, type: s.type, required: !!s.required })),
      installed: !!existing && sameRepo(existing.repo, repo),
      conflict: existing && !sameRepo(existing.repo, repo) ? existing.repo : null,
    }
  }

  async install(input: string, lang: Lang = 'en') {
    const res = await resolveRepo(parseRepo(input))
    const st = await this.stage(res)
    const m = st.manifest
    const repo = `${res.owner}/${res.repo}`
    const existing = this.rows.get(m.id)
    if (existing && !sameRepo(existing.repo, repo)) throw new AppError('PLUGIN_ID_TAKEN', 'Another plugin with the id "{0}" is installed (from {1}): remove it first', 409, [m.id, existing.repo])
    if (existing) throw new AppError('PLUGIN_INSTALLED', 'This plugin is already installed: use Update on its page', 409)
    if (this.busy.has(m.id)) throw new AppError('PLUGIN_BUSY', 'This plugin is being installed or updated: wait a moment', 409)
    this.busy.add(m.id)
    try {
      this.place(st.dir, m.id, res.sha)
      const t = now()
      const row: Row = { id: m.id, repo, ref: res.ref, branch: res.branch, sha: res.sha, manifest: JSON.stringify(m), settings: '{}', enabled: 1, error: null, installed_at: t, updated_at: t }
      await this.deps.h.db.insertInto('plugins').values(row).execute()
      this.rows.set(m.id, row)
      logger.info({ mod: 'plugins', plugin: m.id, repo, sha: res.sha }, 'plugin installed')
      await this.start(m.id)
      return this.status(m.id, lang)
    } finally {
      this.busy.delete(m.id)
    }
  }

  /** Is there a newer commit on the branch (or tag) the plugin follows? */
  async check(id: string) {
    const r = this.row(id)
    if (isSha(r.ref)) return { sha: r.sha, latest: r.sha, available: false, pinned: true }
    const [owner, repo] = r.repo.split('/')
    const res = await resolveRepo({ owner, repo, ref: r.ref })
    return { sha: r.sha, latest: res.sha, available: res.sha !== r.sha, pinned: false }
  }

  /** Move to the latest commit of the branch (or tag) the plugin follows; settings and data stay. */
  async update(id: string, lang: Lang = 'en') {
    const r = this.row(id)
    if (this.busy.has(id)) throw new AppError('PLUGIN_BUSY', 'This plugin is being installed or updated: wait a moment', 409)
    this.busy.add(id)
    try {
      const [owner, repo] = r.repo.split('/')
      const res = await resolveRepo({ owner, repo, ref: r.ref })
      if (res.sha === r.sha) return this.status(id, lang)
      const st = await this.stage(res)
      if (st.manifest.id !== id) throw new AppError('PLUGIN_ID_CHANGED', 'The new version has another id ("{0}"): remove this plugin and install it again', 409, [st.manifest.id])
      await this.teardown(id)
      const old = r.sha
      try {
        this.place(st.dir, id, res.sha)
      } catch (e) {
        if (r.enabled) await this.start(id)
        throw e
      }
      const keep = this.values(r)
      const settings: Values = {}
      for (const s of st.manifest.settings) if (keep[s.key] !== undefined) settings[s.key] = keep[s.key]
      const next: Row = { ...r, sha: res.sha, branch: res.branch ?? r.branch, manifest: JSON.stringify(st.manifest), settings: JSON.stringify(settings), error: null, updated_at: now() }
      await this.deps.h.db.updateTable('plugins').set({ sha: next.sha, branch: next.branch, manifest: next.manifest, settings: next.settings, error: null, updated_at: next.updated_at }).where('id', '=', id).execute()
      this.rows.set(id, next)
      if (old !== res.sha) fs.rmSync(path.join(this.dir, id, old), { recursive: true, force: true })
      logger.info({ mod: 'plugins', plugin: id, from: old.slice(0, 7), to: res.sha.slice(0, 7) }, 'plugin updated')
      if (next.enabled) await this.start(id)
      else this.setState(id, 'stopped', null)
      return this.status(id, lang)
    } finally {
      this.busy.delete(id)
    }
  }

  async setEnabled(id: string, on: boolean, lang: Lang = 'en') {
    const r = this.row(id)
    r.enabled = on ? 1 : 0
    await this.deps.h.db.updateTable('plugins').set({ enabled: r.enabled }).where('id', '=', id).execute()
    if (on) await this.start(id)
    else {
      await this.teardown(id)
      this.setState(id, 'stopped', null)
      await this.saveError(id, null)
    }
    return this.status(id, lang)
  }

  /** Save settings (only the keys sent; an empty secret keeps the saved one) and restart the plugin. */
  async setSettings(id: string, input: Record<string, unknown>, lang: Lang = 'en') {
    const r = this.row(id)
    const m = this.manifestOf(r)
    const labels = new Map(localize(m, lang).settings.map((s) => [s.key, s.label]))
    const next = this.values(r)
    for (const d of m.settings) {
      if (!Object.prototype.hasOwnProperty.call(input, d.key)) continue
      const v = input[d.key]
      const bad = () => new AppError('PLUGIN_BAD_SETTING', 'The value of "{0}" is not valid', 400, [labels.get(d.key) ?? d.key])
      if (d.type === 'secret' && (v === '' || v === undefined)) continue
      if (v === null || v === undefined || v === '') {
        delete next[d.key]
        continue
      }
      switch (d.type) {
        case 'number': {
          const n = typeof v === 'number' ? v : Number(String(v).replace(',', '.'))
          if (!Number.isFinite(n)) throw bad()
          next[d.key] = n
          break
        }
        case 'boolean':
          next[d.key] = v === true || v === 'true' || v === 1 || v === '1' || v === 'on'
          break
        case 'select': {
          const ok = (d.options ?? []).map((o) => (typeof o === 'string' ? o : o.value))
          if (!ok.includes(String(v))) throw bad()
          next[d.key] = String(v)
          break
        }
        case 'url': {
          let u: URL
          try {
            u = new URL(String(v))
          } catch {
            throw bad()
          }
          if (u.protocol !== 'https:' && u.protocol !== 'http:') throw bad()
          next[d.key] = String(v)
          break
        }
        case 'account': {
          try {
            next[d.key] = this.deps.accounts.get(String(v)).id
          } catch {
            throw bad()
          }
          break
        }
        default: {
          const s = String(v)
          if (s.length > 20_000) throw bad()
          next[d.key] = s
        }
      }
    }
    r.settings = JSON.stringify(next)
    await this.deps.h.db.updateTable('plugins').set({ settings: r.settings }).where('id', '=', id).execute()
    if (r.enabled) await this.start(id)
    return this.status(id, lang)
  }

  async restart(id: string, lang: Lang = 'en') {
    const r = this.row(id)
    if (r.enabled) await this.start(id)
    return this.status(id, lang)
  }

  /** Remove a plugin: it stops, its settings, data and files are deleted. */
  async remove(id: string): Promise<void> {
    this.row(id)
    await this.teardown(id)
    await this.deps.h.db.deleteFrom('plugin_data').where('plugin_id', '=', id).execute()
    await this.deps.h.db.deleteFrom('plugins').where('id', '=', id).execute()
    this.rows.delete(id)
    this.states.delete(id)
    fs.rmSync(path.join(this.dir, id), { recursive: true, force: true })
    logger.info({ mod: 'plugins', plugin: id }, 'plugin removed')
  }

  icon(id: string): { type: string; buf: Buffer } {
    const r = this.row(id)
    const i = iconOf(path.join(this.dir, id, r.sha), this.manifestOf(r))
    if (!i) throw new AppError('NOT_FOUND', '{0} {1} not found', 404, ['GET', `/v1/plugins/${id}/icon`])
    return { type: i.type, buf: fs.readFileSync(i.file) }
  }

  // ---------------------------------------------------------------- what the page shows

  list(lang: Lang = 'en') {
    return [...this.rows.keys()].sort().map((id) => this.status(id, lang))
  }

  status(id: string, lang: Lang = 'en') {
    const r = this.row(id)
    const m = this.manifestOf(r)
    const l = localize(m, lang)
    const st = this.states.get(id) ?? { state: (r.enabled ? 'starting' : 'stopped') as PluginState, error: r.error }
    const v = this.values(r)
    const run = this.running.get(id)
    const origin = this.deps.origin().replace(/\/+$/, '')
    return {
      id,
      name: l.name,
      description: l.description,
      version: m.version ?? null,
      author: m.author ?? null,
      homepage: m.homepage ?? `https://github.com/${r.repo}`,
      icon: m.icon ? `/v1/plugins/${encodeURIComponent(id)}/icon?v=${r.sha.slice(0, 7)}` : null,
      repo: r.repo,
      repoUrl: `https://github.com/${r.repo}`,
      ref: r.ref,
      branch: r.branch,
      pinned: isSha(r.ref),
      sha: r.sha,
      commitUrl: `https://github.com/${r.repo}/commit/${r.sha}`,
      enabled: !!r.enabled,
      state: st.state,
      error: showErr(st.error, lang),
      settings: l.settings.map((s) => ({
        key: s.key,
        label: s.label,
        type: s.type,
        help: s.help ?? null,
        placeholder: s.placeholder ?? null,
        required: !!s.required,
        options: s.options ? s.options.map((o) => (typeof o === 'string' ? { value: o, label: o } : o)) : null,
        default: s.default ?? null,
        value: s.type === 'secret' ? null : (v[s.key] ?? null),
        set: v[s.key] !== undefined && v[s.key] !== '',
      })),
      tools: run ? [...run.tools.values()].map((t) => ({ name: `${toolPrefix(id)}_${t.name}`, title: t.title || t.name, description: t.description, scope: t.scope === 'read' ? 'read' : 'send' })) : [],
      routes: run ? run.routes.map((x) => ({ method: x.method, path: x.path, auth: x.auth, url: `${origin}/plugins/${id}/${x.path}` })) : [],
      installedAt: new Date(Number(r.installed_at)).toISOString(),
      updatedAt: new Date(Number(r.updated_at)).toISOString(),
    }
  }
}
