import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// the data folder of this file — set before the config is read
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'to-plugins-'))
process.env.TELEOPS_DATA_DIR = tmp

// ------------------------------------------------------------------ a small GitHub: git refs + tarballs of commits
const pkt = (s: string) => (Buffer.byteLength(s) + 4).toString(16).padStart(4, '0') + s

function tarEntry(name: string, body: Buffer | null, type = '0'): Buffer {
  const h = Buffer.alloc(512)
  h.write(name, 0, 100, 'utf8')
  h.write('0000644\0', 100, 8, 'ascii')
  h.write('0000000\0', 108, 8, 'ascii')
  h.write('0000000\0', 116, 8, 'ascii')
  h.write((body?.length ?? 0).toString(8).padStart(11, '0') + '\0', 124, 12, 'ascii')
  h.write('00000000000\0', 136, 12, 'ascii')
  h.write('        ', 148, 8, 'ascii')
  h.write(type, 156, 1, 'ascii')
  h.write('ustar\0', 257, 6, 'ascii')
  h.write('00', 263, 2, 'ascii')
  let sum = 0
  for (const b of h) sum += b
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii')
  const data = body ?? Buffer.alloc(0)
  return Buffer.concat([h, data, Buffer.alloc((512 - (data.length % 512)) % 512)])
}

/** What GitHub sends for a commit: a pax header with the commit, then <repo>-<sha>/... */
function tarball(repo: string, sha: string, files: Record<string, string>, extra: Buffer[] = []): Buffer {
  const top = `${repo}-${sha}/`
  const parts = [tarEntry('pax_global_header', Buffer.from(`52 comment=${sha}\n`), 'g'), tarEntry(top, null, '5')]
  for (const [p, body] of Object.entries(files)) parts.push(tarEntry(top + p, Buffer.from(body)))
  parts.push(...extra, Buffer.alloc(1024))
  return zlib.gzipSync(Buffer.concat(parts))
}

const SHA1 = '1'.repeat(40)
const SHA2 = '2'.repeat(40)
const SHA3 = '3'.repeat(40)

const manifest = (version: string, more: Record<string, unknown> = {}) =>
  JSON.stringify({
    id: 'demo',
    name: 'Demo',
    description: 'A plugin for the tests',
    version,
    author: 'Tests',
    settings: [
      { key: 'greeting', label: 'Greeting', required: true },
      { key: 'token', label: 'Token', type: 'secret' },
      { key: 'mode', label: 'Mode', type: 'select', options: ['a', 'b'] },
      { key: 'account', label: 'Account', type: 'account' },
    ],
    i18n: { it: { name: 'Prova', settings: { greeting: { label: 'Saluto' } } } },
    ...more,
  })

const CODE_V1 = `
export default {
  async start(ctx) {
    globalThis.__demo = globalThis.__demo ?? { starts: 0, stops: 0 }
    globalThis.__demo.starts++
    await ctx.store.set('greeting', ctx.settings.greeting)
    ctx.tool({ name: 'hello', title: 'Hello', description: 'Say hello', scope: 'read',
      input: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
      run: ({ name }) => ({ text: ctx.settings.greeting + ' ' + name }) })
    ctx.on('message.received', async (ev) => { await ctx.send({ account: ev.account, to: ev.data.chat, text: 'got ' + ev.data.text }) })
    ctx.on('boom', () => { throw new Error('kaboom') })
    ctx.route('GET', 'ping/:x', (req) => ({ pong: req.params.x }), { auth: 'none' })
    ctx.route('POST', '', (req) => ctx.reply(202, { got: req.body }))
    return () => { globalThis.__demo.stops++ }
  },
}
`
const CODE_V2 = CODE_V1.replace("ctx.on('boom'", "ctx.tool({ name: 'bye', description: 'Say bye', run: () => 'bye' })\n    ctx.on('boom'")

type Repo = { head: string; branches: Record<string, string>; tags?: Record<string, string>; commits: Record<string, Buffer> }
const repos: Record<string, Repo> = {
  'acme/demo-plugin': {
    head: 'main',
    branches: { main: SHA1 },
    tags: { 'v1.0': SHA1 },
    commits: {
      [SHA1]: tarball('demo-plugin', SHA1, { 'teleops-plugin.json': manifest('1.0.0'), 'index.mjs': CODE_V1, 'README.md': '# Demo' }),
      [SHA2]: tarball('demo-plugin', SHA2, { 'teleops-plugin.json': manifest('2.0.0'), 'index.mjs': CODE_V2 }),
    },
  },
  'acme/not-a-plugin': { head: 'main', branches: { main: SHA1 }, commits: { [SHA1]: tarball('not-a-plugin', SHA1, { 'README.md': 'hi' }) } },
  'acme/reserved': {
    head: 'main',
    branches: { main: SHA1 },
    commits: { [SHA1]: tarball('reserved', SHA1, { 'teleops-plugin.json': manifest('1.0.0', { id: 'telegram' }), 'index.mjs': CODE_V1 }) },
  },
  'acme/escape': {
    head: 'main',
    branches: { main: SHA3 },
    commits: { [SHA3]: tarball('escape', SHA3, { 'teleops-plugin.json': manifest('1.0.0') }, [tarEntry('escape-x/../../evil.txt', Buffer.from('no'))]) },
  },
}

function advertise(r: Repo): Buffer {
  const head = r.branches[r.head]
  let s = pkt('# service=git-upload-pack\n') + '0000'
  s += pkt(`${head} HEAD\0multi_ack thin-pack side-band symref=HEAD:refs/heads/${r.head} agent=git/github-test\n`)
  for (const [b, sha] of Object.entries(r.branches)) s += pkt(`${sha} refs/heads/${b}\n`)
  for (const [t, sha] of Object.entries(r.tags ?? {})) s += pkt(`${'9'.repeat(40)} refs/tags/${t}\n`) + pkt(`${sha} refs/tags/${t}^{}\n`)
  return Buffer.from(s + '0000')
}

let server: http.Server
let base = ''
const downloads: string[] = []

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://x')
    let m = u.pathname.match(/^\/([^/]+)\/([^/]+)\.git\/info\/refs$/)
    if (m && u.searchParams.get('service') === 'git-upload-pack') {
      const r = repos[`${m[1]}/${m[2]}`]
      if (!r) {
        res.writeHead(401).end()
        return
      }
      res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-advertisement' }).end(advertise(r))
      return
    }
    m = u.pathname.match(/^\/codeload\/([^/]+)\/([^/]+)\/tar\.gz\/([0-9a-f]{40})$/)
    const body = m ? repos[`${m[1]}/${m[2]}`]?.commits[m[3]] : undefined
    if (m && body) {
      downloads.push(`${m[2]}@${m[3].slice(0, 1)}`)
      res.writeHead(200, { 'content-type': 'application/x-gzip' }).end(body)
      return
    }
    res.writeHead(404).end()
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  process.env.TELEOPS_GITHUB_URL = base
  process.env.TELEOPS_CODELOAD_URL = `${base}/codeload`
})
afterAll(() => {
  server?.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

const waitFor = async (ok: () => boolean, ms = 3000) => {
  const t = Date.now()
  while (!ok()) {
    if (Date.now() - t > ms) throw new Error('timed out waiting')
    await new Promise((r) => setTimeout(r, 20))
  }
}

describe('GitHub addresses people paste', () => {
  it('repository, branch, tag, commit; anything else is refused', async () => {
    const { parseRepo } = await import('../src/plugins/github.js')
    expect(parseRepo('https://github.com/emrgim/teleops-plugin-template')).toEqual({ owner: 'emrgim', repo: 'teleops-plugin-template', ref: null })
    expect(parseRepo(' https://github.com/a/b.git ')).toEqual({ owner: 'a', repo: 'b', ref: null })
    expect(parseRepo('github.com/a/b')).toEqual({ owner: 'a', repo: 'b', ref: null })
    expect(parseRepo('a/b')).toEqual({ owner: 'a', repo: 'b', ref: null })
    expect(parseRepo('git@github.com:a/b.git')).toEqual({ owner: 'a', repo: 'b', ref: null })
    expect(parseRepo('https://github.com/a/b/tree/dev')).toEqual({ owner: 'a', repo: 'b', ref: 'dev' })
    expect(parseRepo('https://github.com/a/b/tree/feature/x')).toEqual({ owner: 'a', repo: 'b', ref: 'feature/x' })
    expect(parseRepo(`https://github.com/a/b/commit/${SHA1}`)).toEqual({ owner: 'a', repo: 'b', ref: SHA1 })
    expect(parseRepo('https://github.com/a/b/releases/tag/v1.0')).toEqual({ owner: 'a', repo: 'b', ref: 'v1.0' })
    expect(parseRepo('https://github.com/a/b/blob/main/README.md')).toEqual({ owner: 'a', repo: 'b', ref: null })
    for (const bad of ['https://gitlab.com/a/b', 'hello', 'https://github.com/a', 'https://github.com/a/..', 'https://github.com/a/b/tree/x..y', ''])
      expect(() => parseRepo(bad), bad).toThrow(/GitHub repository/)
  })

  it('reads the refs a git server advertises', async () => {
    const { parseAdvertisement } = await import('../src/plugins/github.js')
    const { refs, head } = parseAdvertisement(advertise(repos['acme/demo-plugin']))
    expect(head).toBe('refs/heads/main')
    expect(refs.get('HEAD')).toBe(SHA1)
    expect(refs.get('refs/heads/main')).toBe(SHA1)
    expect(refs.get('refs/tags/v1.0^{}')).toBe(SHA1)
  })

  it('a branch, a tag and a commit resolve to commits; an unknown repository is a clear error', async () => {
    const { resolveRepo } = await import('../src/plugins/github.js')
    expect(await resolveRepo({ owner: 'acme', repo: 'demo-plugin', ref: null })).toMatchObject({ sha: SHA1, branch: 'main' })
    expect(await resolveRepo({ owner: 'acme', repo: 'demo-plugin', ref: 'v1.0' })).toMatchObject({ sha: SHA1, branch: null })
    expect(await resolveRepo({ owner: 'acme', repo: 'demo-plugin', ref: SHA2 })).toMatchObject({ sha: SHA2, branch: null })
    await expect(resolveRepo({ owner: 'acme', repo: 'demo-plugin', ref: 'nope' })).rejects.toMatchObject({ code: 'PLUGIN_REF_NOT_FOUND' })
    await expect(resolveRepo({ owner: 'acme', repo: 'missing', ref: null })).rejects.toMatchObject({ code: 'PLUGIN_REPO_NOT_FOUND' })
  })
})

describe('unpacking a repository', () => {
  it('drops the top folder, skips links, never writes outside', async () => {
    const { untar } = await import('../src/plugins/github.js')
    const dest = path.join(tmp, 'untar-ok')
    const tar = zlib.gunzipSync(tarball('r', SHA1, { 'a.txt': 'A', 'sub/b.txt': 'B' }, [tarEntry(`r-${SHA1}/link`, null, '2')]))
    expect(untar(tar, dest)).toEqual({ files: 2, bytes: 2 })
    expect(fs.readFileSync(path.join(dest, 'sub/b.txt'), 'utf8')).toBe('B')
    expect(fs.existsSync(path.join(dest, 'link'))).toBe(false)
    const evil = zlib.gunzipSync(tarball('r', SHA1, {}, [tarEntry(`r-${SHA1}/../../evil.txt`, Buffer.from('x'))]))
    expect(() => untar(evil, path.join(tmp, 'untar-evil'))).toThrow(/cannot be opened/)
    expect(fs.existsSync(path.join(tmp, 'evil.txt'))).toBe(false)
    expect(() => untar(tar, path.join(tmp, 'untar-small'), { files: 1, bytes: 1e6 })).toThrow(/too big/)
  })
})

describe('plugins: install, run, update, remove', () => {
  type PM = InstanceType<typeof import('../src/plugins/manager.js').PluginManager>
  let pm: PM
  let deps: ConstructorParameters<typeof import('../src/plugins/manager.js').PluginManager>[0]
  let h: Awaited<ReturnType<typeof import('../src/db/index.js').openDb>>
  const sent: { to: string; text: string }[] = []
  const acc = {
    id: '7000000001',
    kind: 'bot',
    displayName: () => 'Demo Bot',
    status: () => ({ id: '7000000001', kind: 'bot', name: 'Demo Bot', username: 'demo_bot', state: 'open', default: true }),
  }

  beforeAll(async () => {
    const { migrate, openDb } = await import('../src/db/index.js')
    const { EventBus } = await import('../src/events.js')
    const { PluginManager } = await import('../src/plugins/manager.js')
    h = await openDb(`sqlite://${path.join(tmp, 'plugins.db')}`)
    await migrate(h)
    deps = {
      h,
      bus: new EventBus(),
      accounts: {
        list: () => [acc],
        get: (id?: string | null) => {
          if (id && id !== acc.id) throw new Error('no such account')
          return acc
        },
      } as never,
      svc: {
        sendText: async (_a: unknown, i: { to: string; text: string }) => {
          sent.push(i)
          return { id: '1', chat: i.to, status: 'sent' }
        },
        getMessages: async () => ({ messages: [] }),
        listChats: async () => [],
        searchMessages: async () => [],
      } as never,
      origin: () => 'https://teleops.example.com',
      language: () => 'en',
    }
    pm = new PluginManager(deps)
    await pm.loadAll()
  })
  afterAll(async () => {
    await pm?.stopAll()
    await h?.close()
  })

  it('shows what a repository holds before installing it', async () => {
    const p = await pm.preview('https://github.com/acme/demo-plugin')
    expect(p).toMatchObject({ id: 'demo', name: 'Demo', version: '1.0.0', repo: 'acme/demo-plugin', sha: SHA1, branch: 'main', files: 3, installed: false, conflict: null })
    expect(p.settings.map((s) => s.key)).toEqual(['greeting', 'token', 'mode', 'account'])
    expect((await pm.preview('acme/demo-plugin', 'it')).name).toBe('Prova')
    await expect(pm.preview('acme/not-a-plugin')).rejects.toMatchObject({ code: 'PLUGIN_NO_MANIFEST' })
    await expect(pm.preview('acme/reserved')).rejects.toMatchObject({ code: 'PLUGIN_BAD_MANIFEST' })
    await expect(pm.preview('acme/escape')).rejects.toMatchObject({ code: 'PLUGIN_BAD_ARCHIVE' })
    await expect(pm.preview('acme/missing')).rejects.toMatchObject({ code: 'PLUGIN_REPO_NOT_FOUND' })
    expect(pm.list()).toEqual([])
  })

  it('installs, waits for its settings, then runs: tools, events, web addresses, data', async () => {
    let st = await pm.install('https://github.com/acme/demo-plugin')
    expect(st).toMatchObject({ id: 'demo', state: 'settings', enabled: true, sha: SHA1, tools: [] })
    expect(pm.tools()).toEqual([])
    await expect(pm.install('acme/demo-plugin')).rejects.toMatchObject({ code: 'PLUGIN_INSTALLED' })
    await expect(pm.setSettings('demo', { mode: 'z' })).rejects.toMatchObject({ code: 'PLUGIN_BAD_SETTING' })
    await expect(pm.setSettings('demo', { account: '999' })).rejects.toMatchObject({ code: 'PLUGIN_BAD_SETTING' })

    st = await pm.setSettings('demo', { greeting: 'Ciao', token: 's3cret', mode: 'b', account: '7000000001' })
    expect(st.state).toBe('running')
    expect(st.settings.find((s) => s.key === 'token')).toMatchObject({ value: null, set: true })
    expect(st.settings.find((s) => s.key === 'mode')).toMatchObject({ value: 'b' })
    // an empty secret keeps the saved one
    st = await pm.setSettings('demo', { token: '' })
    expect(st.settings.find((s) => s.key === 'token')?.set).toBe(true)

    const tools = pm.tools()
    expect(tools.map((t) => [t.name, t.scope])).toEqual([['demo_hello', 'read']])
    expect(Object.keys(tools[0].shape)).toEqual(['name'])
    expect(await tools[0].run({ name: 'Emil' }, { accounts: '*' })).toEqual({ text: 'Ciao Emil' })
    expect(st.tools.map((t) => t.name)).toEqual(['demo_hello'])
    expect(st.routes.map((r) => r.url)).toEqual(['https://teleops.example.com/plugins/demo/ping/:x', 'https://teleops.example.com/plugins/demo/'])

    deps.bus.publish('message.received', '7000000001', { chat: '42', chatType: 'private', text: 'hi', id: '5' })
    await waitFor(() => sent.length === 1)
    expect(sent[0]).toMatchObject({ to: '42', text: 'got hi' })

    const r = pm.route('demo', 'GET', 'ping/7')
    expect(r.def.auth).toBe('none')
    const req = { method: 'GET', path: 'ping/7', params: r.params, query: {}, headers: {}, body: undefined, rawBody: null }
    expect(await pm.runRoute('demo', r.def, req)).toEqual({ status: 200, headers: {}, body: { pong: '7' } })
    const post = pm.route('demo', 'POST', '')
    expect(post.def.auth).toBe('admin')
    expect(await pm.runRoute('demo', post.def, { ...req, method: 'POST', path: '', params: {}, body: { a: 1 } })).toEqual({ status: 202, headers: {}, body: { got: { a: 1 } } })
    expect(() => pm.route('demo', 'GET', 'nope')).toThrow(/not found/)

    const rows = await h.db.selectFrom('plugin_data').selectAll().where('plugin_id', '=', 'demo').execute()
    expect(rows.map((x) => [x.k, x.v])).toEqual([['greeting', '"Ciao"']])
  })

  it('a plugin that keeps failing is stopped; turned on again it runs', async () => {
    for (let i = 0; i < 20; i++) deps.bus.publish('boom', '7000000001', {})
    await waitFor(() => pm.status('demo').state === 'error')
    expect(pm.status('demo').error).toMatch(/failed too often.*kaboom/)
    expect(pm.tools()).toEqual([])
    expect(() => pm.route('demo', 'GET', 'ping/1')).toThrow(/not found/)
    expect(pm.status('demo', 'it').error).toMatch(/troppe volte/)
    expect((await pm.setEnabled('demo', true)).state).toBe('running')
  })

  it('an error thrown by plugin code stops that plugin, not TeleOps', async () => {
    const e = new Error('crash')
    e.stack = `Error: crash\n    at file://${path.join(pm.dir, 'demo', SHA1, 'index.mjs')}:3:9`
    expect(pm.contain(new Error('not a plugin'))).toBe(false)
    expect(pm.contain(e)).toBe(true)
    await waitFor(() => pm.status('demo').state === 'error')
    expect(pm.status('demo').error).toMatch(/stopped with an error: crash/)
    expect((await pm.restart('demo')).state).toBe('running')
  })

  it('turned off: no tools, the setting is kept after a restart of TeleOps', async () => {
    expect((await pm.setEnabled('demo', false)).state).toBe('stopped')
    expect(pm.tools()).toEqual([])
    const { PluginManager } = await import('../src/plugins/manager.js')
    const again = new PluginManager(deps)
    await again.loadAll()
    expect(again.status('demo')).toMatchObject({ state: 'stopped', enabled: false })
    expect((await pm.setEnabled('demo', true)).state).toBe('running')
  })

  it('updates to the latest commit of its branch, keeping settings and data', async () => {
    expect(await pm.check('demo')).toMatchObject({ available: false, latest: SHA1, pinned: false })
    repos['acme/demo-plugin'].branches.main = SHA2
    expect(await pm.check('demo')).toMatchObject({ available: true, latest: SHA2 })
    const stops = (globalThis as { __demo?: { stops: number } }).__demo?.stops ?? 0
    const st = await pm.update('demo')
    expect(st).toMatchObject({ sha: SHA2, version: '2.0.0', state: 'running' })
    expect(st.settings.find((s) => s.key === 'greeting')?.value).toBe('Ciao')
    expect(pm.tools().map((t) => t.name).sort()).toEqual(['demo_bye', 'demo_hello'])
    expect(fs.existsSync(path.join(pm.dir, 'demo', SHA1))).toBe(false)
    expect((globalThis as { __demo?: { stops: number } }).__demo?.stops).toBeGreaterThan(stops)
  })

  it('after a restore on another computer the same commit is downloaded again', async () => {
    await pm.stopAll()
    fs.rmSync(path.join(pm.dir, 'demo', SHA2), { recursive: true, force: true })
    const n = downloads.length
    const { PluginManager } = await import('../src/plugins/manager.js')
    pm = new PluginManager(deps)
    await pm.loadAll()
    expect(pm.status('demo')).toMatchObject({ state: 'running', sha: SHA2 })
    expect(downloads.slice(n)).toEqual(['demo-plugin@2'])
  })

  it('removed: settings, data and files go away', async () => {
    await pm.remove('demo')
    expect(pm.list()).toEqual([])
    expect(pm.tools()).toEqual([])
    expect(fs.existsSync(path.join(pm.dir, 'demo'))).toBe(false)
    expect(await h.db.selectFrom('plugin_data').selectAll().where('plugin_id', '=', 'demo').execute()).toEqual([])
    expect(() => pm.status('demo')).toThrow(/No plugin/)
  })
})
