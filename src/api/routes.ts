import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { BUILD, VERSION, VERSION_LABEL, config, readBootstrap, writeBootstrap } from '../config.js'
import { copyAll, maskDbUrl, migrate, now, openDb, parseDbUrl, pingDb } from '../db/index.js'
import { WEBHOOK_EVENTS, maskHookHeaders, parseHookHeaders, type BusEvent } from '../events.js'
import { LOG_FILE, logger, onLog, recentLogs } from '../log.js'
import { accountFor, authenticate, requireScope, visibleAccounts, type App } from '../app.js'
import { SESSION_COOKIE, publicOrigin, randomToken, requestIp, type Principal } from '../security/auth.js'
import { DEFAULT_SETTINGS } from '../settings.js'
import { loginPage, messagePage } from '../ui/pages.js'
import { AppError } from '../util.js'
import { handleMcpRequest } from '../mcp/server.js'
import { defaultLang, reqLang, setServerLanguage, tr } from '../i18n.js'
import { currentTheme, desktopTheme } from '../theme.js'
import type { Readable } from 'node:stream'
import { listFolders, makeFolder } from '../backup.js'
import { setTelegramApp, telegramApp } from '../tg/user/app.js'

declare module 'fastify' {
  interface FastifyRequest {
    principal?: Principal
  }
}

const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../public')

const botQ = z.string().optional().describe('Bot id or @username (the default bot when omitted)')
const button = z.object({ text: z.string().min(1).max(64), url: z.string().optional(), data: z.string().max(64).optional() })
const buttons = z.array(z.union([button, z.array(button)])).max(100).optional().describe('Rows of buttons: { text, url } opens a link, { text, data } comes back as the event button.pressed')
const parseMode = z.enum(['HTML', 'MarkdownV2', 'Markdown']).optional().describe('Formatting of the text (omit for plain text)')

export function registerRoutes(fastify: FastifyInstance, app: App): void {
  const f = fastify.withTypeProvider<ZodTypeProvider>()

  const guard = (scope: 'read' | 'send' | 'admin') => async (req: FastifyRequest, reply: FastifyReply) => {
    const p = await authenticate(app, req)
    if (!p) {
      reply.header('www-authenticate', app.oauth.wwwAuthenticate(req, '/v1'))
      throw new AppError('UNAUTHORIZED', 'Missing or invalid credentials (Bearer API key, OAuth token or admin session)', 401)
    }
    requireScope(p, scope)
    req.principal = p
  }
  const P = (req: FastifyRequest) => req.principal as Principal
  /** Any signed-in caller (owner, key, OAuth). */
  const signedIn = async (req: FastifyRequest, reply: FastifyReply) => {
    const p = await authenticate(app, req)
    if (!p) {
      reply.header('www-authenticate', app.oauth.wwwAuthenticate(req, '/v1'))
      throw new AppError('UNAUTHORIZED', 'Missing or invalid credentials (Bearer API key, OAuth token or admin session)', 401)
    }
    req.principal = p
  }
  const secure = (req: FastifyRequest) => publicOrigin(req, app.settings.get().publicUrl).startsWith('https://')

  // ------------------------------------------------------------------ public
  f.get('/healthz', { schema: { hide: true } }, async () => ({ ok: true, version: VERSION, build: BUILD, connected: app.accounts.list().filter((a) => a.state === 'open').length }))

  const sendFile = (name: string, type: string, maxAge = 86400) => async (_req: FastifyRequest, reply: FastifyReply) => {
    const p = path.join(PUBLIC_DIR, name)
    if (!fs.existsSync(p)) return reply.code(404).send()
    return reply.type(type).header('cache-control', `public, max-age=${maxAge}`).send(fs.readFileSync(p))
  }
  f.get('/favicon.svg', { schema: { hide: true } }, sendFile('favicon.svg', 'image/svg+xml'))
  f.get('/favicon.ico', { schema: { hide: true } }, sendFile('favicon.ico', 'image/x-icon'))
  f.get('/favicon-32.png', { schema: { hide: true } }, sendFile('favicon-32.png', 'image/png'))
  f.get('/favicon-192.png', { schema: { hide: true } }, sendFile('favicon-192.png', 'image/png'))
  f.get('/logo.svg', { schema: { hide: true } }, sendFile('favicon.svg', 'image/svg+xml'))
  f.get('/logo-512.png', { schema: { hide: true } }, sendFile('logo-512.png', 'image/png'))
  // same image under a name that becomes the icon name of a desktop web app launcher
  f.get('/teleops.png', { schema: { hide: true } }, sendFile('logo-512.png', 'image/png'))
  f.get('/icon-maskable-192.png', { schema: { hide: true } }, sendFile('icon-maskable-192.png', 'image/png'))
  f.get('/icon-maskable-512.png', { schema: { hide: true } }, sendFile('icon-maskable-512.png', 'image/png'))
  f.get('/apple-touch-icon.png', { schema: { hide: true } }, sendFile('apple-touch-icon.png', 'image/png'))
  // web app (PWA): installable from Chrome / Edge / Chromium
  f.get('/manifest.webmanifest', { schema: { hide: true } }, async (req, reply) => {
    const th = currentTheme(app.settings.get().appearance)
    const color = (k: string, d: string) => th.css.match(new RegExp(`--to-${k}:\\s*(#[0-9a-fA-F]{3,8})`))?.[1] ?? d
    const it = reqLang(req) === 'it'
    return reply
      .type('application/manifest+json; charset=utf-8')
      .header('cache-control', 'no-cache')
      .send({
        id: '/',
        name: 'TeleOps',
        short_name: 'TeleOps',
        description: it ? 'I tuoi bot Telegram: MCP e API REST' : 'Your Telegram bots: MCP and REST API',
        lang: it ? 'it' : 'en',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        // let the app header double as the window title bar on desktop installs
        display_override: ['window-controls-overlay'],
        background_color: color('background', '#121212'),
        theme_color: color('bar', color('background', '#121212')),
        categories: ['business', 'productivity', 'utilities'],
        icons: [
          { src: '/favicon.svg?v=1', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
          { src: '/favicon-192.png?v=1', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: '/logo-512.png?v=1', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: '/icon-maskable-192.png?v=1', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
          { src: '/icon-maskable-512.png?v=1', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
        shortcuts: [
          { name: 'Bot', url: '/#bots' },
          { name: 'MCP', url: '/#connect/mcp' },
          { name: it ? 'Impostazioni' : 'Settings', url: '/#settings/general' },
        ],
      })
  })
  f.get('/static/app.js', { schema: { hide: true } }, sendFile('app.js', 'application/javascript; charset=utf-8', 60))
  f.get('/static/i18n.js', { schema: { hide: true } }, sendFile('i18n.js', 'application/javascript; charset=utf-8', 60))
  f.get('/static/app.css', { schema: { hide: true } }, sendFile('app.css', 'text/css; charset=utf-8', 60))
  f.get('/static/base.css', { schema: { hide: true } }, sendFile('base.css', 'text/css; charset=utf-8', 300))
  f.get('/static/theme.js', { schema: { hide: true } }, sendFile('theme.js', 'application/javascript; charset=utf-8', 300))
  const LOGOS: Record<string, string> = { 'cursor.svg': 'image/svg+xml', 'claude.svg': 'image/svg+xml', 'chatgpt.svg': 'image/svg+xml', 'grok.svg': 'image/svg+xml', 'gemini.svg': 'image/svg+xml', 'mcp.svg': 'image/svg+xml', 'hermes.png': 'image/png', 'grokbot.png': 'image/png', 'plugin.svg': 'image/svg+xml' }
  f.get('/static/logos/:name', { schema: { hide: true, params: z.object({ name: z.string() }) } }, async (req, reply) => {
    const type = LOGOS[req.params.name]
    if (!type) return reply.code(404).send()
    return reply.type(type).header('cache-control', 'public, max-age=86400').send(fs.readFileSync(path.join(PUBLIC_DIR, 'logos', req.params.name)))
  })
  f.get('/static/fonts/:name', { schema: { hide: true } }, async (req, reply) => {
    const name = (req.params as { name: string }).name
    if (!/^[a-z0-9-]+\.woff2$/.test(name)) return reply.code(404).send()
    const p = path.join(PUBLIC_DIR, 'fonts', name)
    if (!fs.existsSync(p)) return reply.code(404).send()
    return reply.type('font/woff2').header('cache-control', 'public, max-age=31536000, immutable').send(fs.readFileSync(p))
  })
  // Light / Dark / System theme (public: the login page needs it too)
  f.get('/theme.css', { schema: { hide: true } }, async (req, reply) => {
    const th = currentTheme(app.settings.get().appearance)
    const etag = `"${th.hash}"`
    reply.header('etag', etag).header('cache-control', 'no-cache')
    if (req.headers['if-none-match'] === etag) return reply.code(304).send()
    return reply.type('text/css; charset=utf-8').send(th.css)
  })
  f.get('/theme.json', { schema: { hide: true } }, async (_req, reply) => {
    const th = currentTheme(app.settings.get().appearance)
    return reply.header('cache-control', 'no-store').send({ name: th.name, mode: th.mode, hash: th.hash })
  })

  f.get('/', { schema: { hide: true } }, async (req, reply) => {
    const ok = await app.admin.checkSession(req.cookies?.[SESSION_COOKIE])
    reply.type('text/html; charset=utf-8').header('cache-control', 'no-store')
    if (!ok) return reply.send(loginPage(reqLang(req), { otpEnabled: app.settings.get().otpEnabled && !!(await app.owner.get()), passwordSet: await app.admin.passwordSet() }))
    return reply.send(fs.readFileSync(path.join(PUBLIC_DIR, 'app.html')))
  })

  // MCP on /mcp and on / (grok.com custom connectors use the bare origin)
  for (const p of ['/mcp', '/mcp/']) {
    f.post(p, { schema: { hide: true } }, (req, reply) => handleMcpRequest(app, req, reply, '/mcp'))
    f.get(p, { schema: { hide: true } }, (req, reply) => handleMcpRequest(app, req, reply, '/mcp'))
    f.delete(p, { schema: { hide: true } }, (req, reply) => handleMcpRequest(app, req, reply, '/mcp'))
  }
  f.post('/', { schema: { hide: true } }, (req, reply) => handleMcpRequest(app, req, reply, '/'))
  f.options('/mcp', { schema: { hide: true } }, async (_req, reply) =>
    reply.header('access-control-allow-origin', '*').header('access-control-allow-headers', 'authorization, content-type, mcp-protocol-version, mcp-session-id').header('access-control-allow-methods', 'POST, GET, DELETE, OPTIONS').header('access-control-expose-headers', 'WWW-Authenticate, Mcp-Session-Id').code(204).send(),
  )

  // ------------------------------------------------------------------ admin login
  f.get('/login', { schema: { hide: true, querystring: z.object({ t: z.string().optional() }) } }, async (req, reply) => {
    reply.type('text/html; charset=utf-8').header('cache-control', 'no-store')
    const valid = !!req.query.t && (await app.admin.consumeLoginToken('link', req.query.t, requestIp(req)))
    if (!valid) {
      const lang = reqLang(req)
      return reply.code(403).send(messagePage(lang, tr(lang, 'Invalid link'), tr(lang, 'Login link expired or already used. Ask for a new one.')))
    }
    const tok = await app.admin.createSession(`magic link · ${String(req.headers['user-agent'] ?? '').slice(0, 120)}`)
    app.admin.setCookie(reply, tok, secure(req))
    return reply.redirect('/', 303)
  })

  f.get('/auth/me', { schema: { hide: true } }, async (req) => {
    const s = await app.admin.session(req.cookies?.[SESSION_COOKIE])
    return { loggedIn: !!s, role: s ? 'owner' : null, otpEnabled: app.settings.get().otpEnabled, passwordSet: await app.admin.passwordSet() }
  })

  const otpHits: number[] = []
  f.post('/auth/otp/request', { schema: { hide: true } }, async (req) => {
    if (!app.settings.get().otpEnabled) throw new AppError('DISABLED', 'Telegram login codes are disabled', 403)
    const t = now()
    while (otpHits.length && t - otpHits[0] > 10 * 60_000) otpHits.shift()
    if (otpHits.length >= 4) throw new AppError('TOO_MANY_REQUESTS', 'Too many codes requested, wait a few minutes', 429)
    otpHits.push(t)
    const code = await app.admin.createLoginToken('otp', 5 * 60_000)
    const sentTo = await app.owner.sendCode(code, reqLang(req))
    logger.info({ mod: 'auth' }, 'login code sent on Telegram')
    return { ok: true, sentTo }
  })

  f.post('/auth/otp/verify', { schema: { hide: true, body: z.object({ code: z.string() }) } }, async (req, reply) => {
    if (!(await app.admin.consumeLoginToken('otp', req.body.code.replace(/\D/g, ''), requestIp(req)))) throw new AppError('INVALID_CODE', 'Wrong or expired code', 401)
    const tok = await app.admin.createSession(`telegram code · ${String(req.headers['user-agent'] ?? '').slice(0, 120)}`)
    app.admin.setCookie(reply, tok, secure(req))
    return { ok: true }
  })

  f.post('/auth/password', { schema: { hide: true, body: z.object({ password: z.string() }) } }, async (req, reply) => {
    if (!(await app.admin.checkPassword(req.body.password, requestIp(req)))) throw new AppError('INVALID_PASSWORD', 'Wrong password', 401)
    const tok = await app.admin.createSession(`password · ${String(req.headers['user-agent'] ?? '').slice(0, 120)}`)
    app.admin.setCookie(reply, tok, secure(req))
    return { ok: true }
  })

  f.post('/auth/logout', { schema: { hide: true } }, async (req, reply) => {
    await app.admin.deleteSession(req.cookies?.[SESSION_COOKIE])
    reply.clearCookie(SESSION_COOKIE, { path: '/' })
    return { ok: true }
  })

  // ------------------------------------------------------------------ media links
  f.get('/media/:token', { schema: { hide: true, params: z.object({ token: z.string() }) } }, async (req, reply) => {
    const d = app.svc.verifyMediaToken(req.params.token)
    const acc = app.accounts.get(d.a)
    const m = await app.svc.downloadMedia(acc, d.c || undefined, d.i)
    return reply
      .type(m.mimetype)
      .header('content-disposition', `inline; filename="${m.fileName.replace(/["\\\r\n]/g, '_')}"`)
      .header('cache-control', 'private, max-age=600')
      .send(m.buf)
  })

  // ------------------------------------------------------------------ bots
  const tags = (t: string) => ({ tags: [t], security: [{ bearer: [] }] })
  const idParam = z.object({ id: z.string() })

  f.get('/v1/bots', { preHandler: guard('read'), schema: { ...tags('Bots'), summary: 'List the Telegram bots and accounts' } }, async (req) => visibleAccounts(app, P(req)).map((a) => a.status()))

  f.post(
    '/v1/bots',
    {
      preHandler: guard('admin'),
      schema: {
        ...tags('Bots'),
        summary: 'Link a bot with its token from @BotFather (the same bot again: its token is replaced). takeOver removes a webhook set by another program',
        body: z.object({ token: z.string().min(20).max(120), takeOver: z.boolean().optional() }),
      },
    },
    async (req, reply) => {
      const r = await app.accounts.create({ token: req.body.token, takeOver: req.body.takeOver })
      return reply.code(r.created ? 201 : 200).send({ ...r.account.status(), created: r.created })
    },
  )

  f.get('/v1/bots/:id', { preHandler: guard('read'), schema: { ...tags('Bots'), summary: 'Bot status', params: idParam } }, async (req) => accountFor(app, P(req), req.params.id).status())

  // ---- profile of the bot (name = TeleOps name, descriptions, commands, photo) — edits change Telegram itself
  const imageFrom = async (b: { url?: string; base64?: string }): Promise<Buffer> => {
    if (b.base64) return Buffer.from(b.base64.replace(/^data:[^;]+;base64,/, ''), 'base64')
    if (b.url) return (await app.svc.fetchMedia(b.url)).buf
    throw new AppError('PROFILE_PHOTO', 'Send the photo as url or base64', 400)
  }
  f.get('/v1/bots/:id/profile', { preHandler: guard('read'), schema: { ...tags('Bots'), summary: 'Profile of the bot: name, short description, description, commands, photo, privacy mode', params: idParam } }, async (req) =>
    accountFor(app, P(req), req.params.id).profile(),
  )
  f.post('/v1/bots/:id/profile/refresh', { preHandler: guard('read'), schema: { ...tags('Bots'), summary: 'Read the profile from Telegram again now', params: idParam } }, async (req) => {
    const a = accountFor(app, P(req), req.params.id)
    await a.refreshProfile(true)
    return a.profile()
  })
  f.patch(
    '/v1/bots/:id/profile',
    {
      preHandler: guard('send'),
      schema: {
        ...tags('Bots'),
        summary: 'Change the bot on Telegram: name, short description, description, commands, privacy mode',
        params: idParam,
        body: z.object({
          name: z.string().max(64).optional(),
          about: z.string().max(120).optional(),
          description: z.string().max(512).optional(),
          commands: z.array(z.object({ command: z.string().min(1).max(33), description: z.string().min(1).max(256) })).max(100).optional(),
          readAllGroupMessages: z.boolean().optional(),
          canJoinGroups: z.boolean().optional(),
        }),
      },
    },
    async (req) => accountFor(app, P(req), req.params.id).editProfile(req.body),
  )
  f.get('/v1/bots/:id/profile/photo', { preHandler: guard('read'), schema: { ...tags('Bots'), summary: 'Profile photo (image)', params: idParam } }, async (req, reply) => {
    const p = accountFor(app, P(req), req.params.id).photoData()
    if (!p) throw new AppError('NO_PHOTO', 'This bot has no profile photo', 404)
    return reply.header('content-type', p.type).header('cache-control', 'private, max-age=60').send(p.data)
  })
  f.put(
    '/v1/bots/:id/profile/photo',
    { preHandler: guard('send'), schema: { ...tags('Bots'), summary: 'Set the profile photo of the bot (image url or base64)', params: idParam, body: z.object({ url: z.string().optional(), base64: z.string().optional() }) }, bodyLimit: 20 * 1024 * 1024 },
    async (req) => accountFor(app, P(req), req.params.id).editProfile({ photo: await imageFrom(req.body) }),
  )
  f.delete('/v1/bots/:id/profile/photo', { preHandler: guard('send'), schema: { ...tags('Bots'), summary: 'Remove the profile photo of the bot', params: idParam } }, async (req) =>
    accountFor(app, P(req), req.params.id).editProfile({ photo: null }),
  )

  f.get('/v1/bots/:id/stats', { preHandler: guard('read'), schema: { ...tags('Bots'), summary: 'Stored data counts', params: idParam } }, async (req) => app.svc.stats(accountFor(app, P(req), req.params.id)))

  f.patch(
    '/v1/bots/:id',
    {
      preHandler: guard('admin'),
      schema: { ...tags('Bots'), summary: 'Rename (on Telegram), switch on / off, make default', params: idParam, body: z.object({ name: z.string().max(64).optional(), enabled: z.boolean().optional(), isDefault: z.boolean().optional() }) },
    },
    async (req) => (await app.accounts.update(req.params.id, req.body)).status(),
  )

  f.delete(
    '/v1/bots/:id',
    { preHandler: guard('admin'), schema: { ...tags('Bots'), summary: 'Unlink the bot (it stays on Telegram) and its stored chats unless purge=false', params: idParam, querystring: z.object({ purge: z.enum(['true', 'false']).optional() }) } },
    async (req) => {
      await app.accounts.remove(req.params.id, req.query.purge !== 'false')
      return { ok: true }
    },
  )

  f.post(
    '/v1/bots/:id/restart',
    { preHandler: guard('admin'), schema: { ...tags('Bots'), summary: 'Reconnect (takeOver: remove a webhook of another program first)', params: idParam, body: z.object({ takeOver: z.boolean().optional() }).default({}) } },
    async (req) => {
      const a = app.accounts.get(req.params.id)
      await a.start({ takeOver: req.body?.takeOver })
      for (let i = 0; i < 20 && a.state === 'connecting'; i++) await new Promise((r) => setTimeout(r, 250))
      return a.status()
    },
  )

  // ------------------------------------------------------------------ Telegram user accounts (QR or phone login)
  // they appear in /v1/bots with kind "user" and work with every call there and in the MCP tools
  const appOut = async () => {
    const a = await telegramApp(app.h)
    return { configured: !!a, apiId: a?.apiId ?? null, fromEnv: a?.source === 'env', apiHashSet: !!a }
  }
  f.get('/v1/users/app', { preHandler: guard('admin'), schema: { ...tags('Accounts'), summary: 'The Telegram app code of this installation (api_id; the api_hash is never shown)' } }, async () => appOut())
  f.put(
    '/v1/users/app',
    {
      preHandler: guard('admin'),
      schema: {
        ...tags('Accounts'),
        summary: 'Set the Telegram app code (my.telegram.org → API development tools): every Telegram account logs in through it',
        body: z.object({ apiId: z.union([z.number(), z.string()]), apiHash: z.string().max(64).optional() }),
      },
    },
    async (req) => {
      const cur = await telegramApp(app.h)
      if (cur?.source === 'env') throw new AppError('APP_FROM_ENV', 'The app code comes from TELEOPS_API_ID / TELEOPS_API_HASH: change it there', 409)
      // an empty api_hash keeps the saved one (the page never shows it)
      await setTelegramApp(app.h, req.body.apiId, req.body.apiHash?.trim() || cur?.apiHash)
      return appOut()
    },
  )
  f.post(
    '/v1/users/login',
    {
      preHandler: guard('admin'),
      schema: {
        ...tags('Accounts'),
        summary: 'Link a Telegram account: method qr (scan with the phone: Settings → Devices → Link Desktop Device) or phone (then the code, and the password if the account has one)',
        body: z.object({ method: z.enum(['qr', 'phone']), phone: z.string().max(32).optional() }),
      },
    },
    async (req, reply) => reply.code(201).send(await app.logins.start(req.body.method, req.body.phone, reqLang(req))),
  )
  const loginParam = z.object({ id: z.string().max(64) })
  f.get('/v1/users/login/:id', { preHandler: guard('admin'), schema: { ...tags('Accounts'), summary: 'Where a login is: qr (a new code every 30 s), code, password, done, error', params: loginParam } }, async (req) =>
    app.logins.view(req.params.id, reqLang(req)),
  )
  f.post(
    '/v1/users/login/:id/code',
    { preHandler: guard('admin'), schema: { ...tags('Accounts'), summary: 'The code Telegram sent (in the Telegram app, or by SMS)', params: loginParam, body: z.object({ code: z.string().min(1).max(16) }) } },
    async (req) => app.logins.code(req.params.id, req.body.code, reqLang(req)),
  )
  f.post(
    '/v1/users/login/:id/password',
    { preHandler: guard('admin'), schema: { ...tags('Accounts'), summary: 'The two-step verification password of the account', params: loginParam, body: z.object({ password: z.string().min(1).max(256) }) } },
    async (req) => app.logins.password(req.params.id, req.body.password, reqLang(req)),
  )
  f.delete('/v1/users/login/:id', { preHandler: guard('admin'), schema: { ...tags('Accounts'), summary: 'Stop a login', params: loginParam } }, async (req) => {
    await app.logins.cancel(req.params.id)
    return { ok: true }
  })

  // ------------------------------------------------------------------ plugins (Connectors → Plugins): public GitHub repositories
  const pluginParam = z.object({ id: z.string().max(64) })
  const repoBody = z.object({ url: z.string().min(3).max(500).describe('The GitHub repository: https://github.com/owner/repo (…/tree/<branch or tag> to follow one)') })
  f.get('/v1/plugins', { preHandler: guard('admin'), schema: { ...tags('Plugins'), summary: 'Installed plugins' } }, async (req) => app.plugins.list(reqLang(req)))
  f.post(
    '/v1/plugins/preview',
    { preHandler: guard('admin'), schema: { ...tags('Plugins'), summary: 'Read a plugin from its GitHub repository without installing it', body: repoBody } },
    async (req) => app.plugins.preview(req.body.url, reqLang(req)),
  )
  f.post(
    '/v1/plugins',
    { preHandler: guard('admin'), schema: { ...tags('Plugins'), summary: 'Install a plugin from a public GitHub repository (pinned to its latest commit)', body: repoBody } },
    async (req, reply) => reply.code(201).send(await app.plugins.install(req.body.url, reqLang(req))),
  )
  f.get('/v1/plugins/:id', { preHandler: guard('admin'), schema: { ...tags('Plugins'), summary: 'One plugin: state, settings, MCP tools, web addresses', params: pluginParam } }, async (req) =>
    app.plugins.status(req.params.id, reqLang(req)),
  )
  f.patch(
    '/v1/plugins/:id',
    {
      preHandler: guard('admin'),
      schema: {
        ...tags('Plugins'),
        summary: 'Turn a plugin on or off, or save its settings (an empty secret keeps the saved one)',
        params: pluginParam,
        body: z.object({ enabled: z.boolean().optional(), settings: z.record(z.string(), z.unknown()).optional() }),
      },
    },
    async (req) => {
      const lang = reqLang(req)
      if (req.body.settings) await app.plugins.setSettings(req.params.id, req.body.settings, lang)
      if (req.body.enabled !== undefined) await app.plugins.setEnabled(req.params.id, req.body.enabled, lang)
      return app.plugins.status(req.params.id, lang)
    },
  )
  f.get('/v1/plugins/:id/update', { preHandler: guard('admin'), schema: { ...tags('Plugins'), summary: 'Is there a newer commit on the branch the plugin follows?', params: pluginParam } }, async (req) =>
    app.plugins.check(req.params.id),
  )
  f.post('/v1/plugins/:id/update', { preHandler: guard('admin'), schema: { ...tags('Plugins'), summary: 'Update the plugin to the latest commit (settings and data stay)', params: pluginParam } }, async (req) =>
    app.plugins.update(req.params.id, reqLang(req)),
  )
  f.post('/v1/plugins/:id/restart', { preHandler: guard('admin'), schema: { ...tags('Plugins'), summary: 'Restart the plugin', params: pluginParam } }, async (req) =>
    app.plugins.restart(req.params.id, reqLang(req)),
  )
  f.delete('/v1/plugins/:id', { preHandler: guard('admin'), schema: { ...tags('Plugins'), summary: 'Remove the plugin with its settings and data', params: pluginParam } }, async (req) => {
    await app.plugins.remove(req.params.id)
    return { ok: true }
  })
  f.get('/v1/plugins/:id/icon', { preHandler: guard('admin'), schema: { hide: true, params: pluginParam } }, async (req, reply) => {
    const i = app.plugins.icon(req.params.id)
    // an icon from a repository never runs as a page of TeleOps
    return reply
      .type(i.type)
      .header('cache-control', 'private, max-age=86400')
      .header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox")
      .header('x-content-type-options', 'nosniff')
      .send(i.buf)
  })

  // web addresses added by plugins: /plugins/<id>/<path> (a plugin can check signatures: it gets rawBody too)
  fastify.register(async (sub) => {
    sub.removeAllContentTypeParsers()
    sub.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'buffer' }, (req, body, done) => {
      ;(req as FastifyRequest & { rawBody?: Buffer }).rawBody = body as Buffer
      done(null, Object.fromEntries(new URLSearchParams((body as Buffer).toString('utf8'))))
    })
    sub.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body, done) => {
      ;(req as FastifyRequest & { rawBody?: Buffer }).rawBody = body as Buffer
      if (!(body as Buffer).length) return done(null, undefined)
      try {
        done(null, JSON.parse((body as Buffer).toString('utf8')))
      } catch {
        const e = new Error('Body is not valid JSON') as Error & { statusCode: number }
        e.statusCode = 400
        done(e, undefined)
      }
    })
    sub.addContentTypeParser('*', { parseAs: 'buffer' }, (req, body, done) => {
      ;(req as FastifyRequest & { rawBody?: Buffer }).rawBody = body as Buffer
      done(null, body)
    })
    const handler = async (req: FastifyRequest, reply: FastifyReply) => {
        const params = req.params as Record<string, string>
        const id = params.id
        const subPath = params['*'] ?? ''
        const method = req.method === 'HEAD' ? 'GET' : req.method
        const { def, params: rp } = app.plugins.route(id, method, subPath)
        if (def.auth !== 'none') {
          const p = await authenticate(app, req)
          if (!p) {
            reply.header('www-authenticate', app.oauth.wwwAuthenticate(req, '/v1'))
            throw new AppError('UNAUTHORIZED', 'Missing or invalid credentials (Bearer API key, OAuth token or admin session)', 401)
          }
          requireScope(p, def.auth)
        }
        const out = await app.plugins.runRoute(id, def, {
          method: req.method,
          path: subPath,
          params: rp,
          query: (req.query ?? {}) as Record<string, unknown>,
          headers: req.headers as Record<string, unknown>,
          body: req.body,
          rawBody: (req as FastifyRequest & { rawBody?: Buffer }).rawBody ?? null,
        })
        reply.code(out.status)
        for (const [k, v] of Object.entries(out.headers)) reply.header(k, v)
        if (out.body === undefined) return reply.send()
        if (Buffer.isBuffer(out.body) || out.body instanceof Uint8Array) {
          if (!reply.hasHeader('content-type')) reply.type('application/octet-stream')
          return reply.send(Buffer.from(out.body as Uint8Array))
        }
        if (typeof out.body === 'string') {
          if (!reply.hasHeader('content-type')) reply.type('text/plain; charset=utf-8')
          return reply.send(out.body)
        }
        return reply.send(out.body)
    }
    for (const url of ['/plugins/:id', '/plugins/:id/*']) sub.route({ method: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'], url, schema: { hide: true }, handler })
  })

  // ------------------------------------------------------------------ chats & messages
  f.get(
    '/v1/chats',
    {
      preHandler: guard('read'),
      schema: {
        ...tags('Chats'),
        summary: 'Chats of the bot (most recent first)',
        querystring: z.object({ bot: botQ, limit: z.coerce.number().int().min(1).max(200).optional(), offset: z.coerce.number().int().min(0).optional(), q: z.string().optional(), type: z.enum(['all', 'private', 'groups', 'channels']).optional() }),
      },
    },
    async (req) => app.svc.listChats(accountFor(app, P(req), req.query.bot), { limit: req.query.limit, offset: req.query.offset, query: req.query.q, type: req.query.type }),
  )

  f.get(
    '/v1/chats/:chat',
    { preHandler: guard('read'), schema: { ...tags('Chats'), summary: 'A chat as Telegram describes it now (members, administrators, the bot\'s rights)', params: z.object({ chat: z.string() }), querystring: z.object({ bot: botQ }) } },
    async (req) => app.svc.getChat(accountFor(app, P(req), req.query.bot), req.params.chat),
  )

  f.get(
    '/v1/chats/:chat/messages',
    {
      preHandler: guard('read'),
      schema: {
        ...tags('Messages'),
        summary: 'Messages of a chat (chronological)',
        params: z.object({ chat: z.string() }),
        querystring: z.object({ bot: botQ, limit: z.coerce.number().int().min(1).max(500).optional(), before: z.string().optional(), after: z.string().optional() }),
      },
    },
    async (req) => app.svc.getMessages(accountFor(app, P(req), req.query.bot), req.params.chat, req.query),
  )

  f.post(
    '/v1/chats/:chat/invite-link',
    {
      preHandler: guard('send'),
      schema: {
        ...tags('Chats'),
        summary: 'New invite link to a group or channel (the bot must be an administrator allowed to invite)',
        params: z.object({ chat: z.string() }),
        body: z.object({ name: z.string().max(32).optional(), expireHours: z.number().min(0.1).max(8760).optional(), memberLimit: z.number().int().min(1).max(99999).optional(), joinRequest: z.boolean().optional(), bot: botQ }).default({}),
      },
    },
    async (req) => app.svc.inviteLink(accountFor(app, P(req), req.body?.bot), { chat: req.params.chat, ...req.body }),
  )

  f.get(
    '/v1/messages/search',
    {
      preHandler: guard('read'),
      schema: { ...tags('Messages'), summary: 'Search messages', querystring: z.object({ q: z.string().min(1), chat: z.string().optional(), since: z.string().optional(), limit: z.coerce.number().int().min(1).max(200).optional(), bot: botQ }) },
    },
    async (req) => app.svc.searchMessages(accountFor(app, P(req), req.query.bot), req.query.q, req.query),
  )

  f.post(
    '/v1/messages/text',
    {
      preHandler: guard('send'),
      schema: {
        ...tags('Send'),
        summary: 'Send a text message (plain text over 4096 characters is split)',
        body: z.object({
          to: z.string(),
          text: z.string().min(1),
          parseMode,
          replyTo: z.string().optional(),
          buttons,
          silent: z.boolean().optional(),
          linkPreview: z.boolean().optional(),
          threadId: z.string().optional(),
          idempotencyKey: z.string().optional(),
          bot: botQ,
        }),
      },
    },
    async (req) => app.svc.sendText(accountFor(app, P(req), req.body.bot), req.body),
  )

  f.post(
    '/v1/messages/media',
    {
      preHandler: guard('send'),
      schema: {
        ...tags('Send'),
        summary: 'Send media (url, base64 or file_id)',
        body: z.object({
          to: z.string(),
          type: z.enum(['photo', 'image', 'video', 'audio', 'voice', 'document', 'sticker', 'animation', 'video_note']),
          url: z.string().optional(),
          base64: z.string().optional(),
          fileId: z.string().optional(),
          mimetype: z.string().optional(),
          fileName: z.string().optional(),
          caption: z.string().max(1024).optional(),
          parseMode,
          replyTo: z.string().optional(),
          buttons,
          silent: z.boolean().optional(),
          threadId: z.string().optional(),
          idempotencyKey: z.string().optional(),
          bot: botQ,
        }),
      },
      bodyLimit: 100 * 1024 * 1024,
    },
    async (req) => app.svc.sendMedia(accountFor(app, P(req), req.body.bot), req.body),
  )

  f.post(
    '/v1/messages/location',
    {
      preHandler: guard('send'),
      schema: { ...tags('Send'), summary: 'Send a location (with name and address: a place)', body: z.object({ to: z.string(), latitude: z.number(), longitude: z.number(), name: z.string().optional(), address: z.string().optional(), silent: z.boolean().optional(), bot: botQ }) },
    },
    async (req) => app.svc.sendLocation(accountFor(app, P(req), req.body.bot), req.body),
  )

  f.post(
    '/v1/messages/react',
    { preHandler: guard('send'), schema: { ...tags('Send'), summary: 'React to a message (empty emoji removes)', body: z.object({ chat: z.string(), messageId: z.string(), emoji: z.string(), big: z.boolean().optional(), bot: botQ }) } },
    async (req) => app.svc.react(accountFor(app, P(req), req.body.bot), req.body),
  )

  f.post(
    '/v1/messages/edit',
    { preHandler: guard('send'), schema: { ...tags('Send'), summary: 'Edit a message of the bot (text, or caption of a media message)', body: z.object({ chat: z.string(), messageId: z.string(), text: z.string().min(1), parseMode, buttons, bot: botQ }) } },
    async (req) => app.svc.editMessage(accountFor(app, P(req), req.body.bot), req.body),
  )

  f.post(
    '/v1/messages/delete',
    { preHandler: guard('send'), schema: { ...tags('Send'), summary: 'Delete a message for everyone', body: z.object({ chat: z.string(), messageId: z.string(), bot: botQ }) } },
    async (req) => app.svc.deleteMessage(accountFor(app, P(req), req.body.bot), req.body),
  )

  f.post(
    '/v1/messages/forward',
    {
      preHandler: guard('send'),
      schema: { ...tags('Send'), summary: 'Forward (or copy) a message to another chat', body: z.object({ from: z.string(), messageId: z.string(), to: z.string(), copy: z.boolean().optional(), silent: z.boolean().optional(), bot: botQ }) },
    },
    async (req) => app.svc.forwardMessage(accountFor(app, P(req), req.body.bot), req.body),
  )

  f.post(
    '/v1/messages/pin',
    { preHandler: guard('send'), schema: { ...tags('Send'), summary: 'Pin or unpin a message', body: z.object({ chat: z.string(), messageId: z.string().optional(), unpin: z.boolean().optional(), silent: z.boolean().optional(), bot: botQ }) } },
    async (req) => app.svc.pinMessage(accountFor(app, P(req), req.body.bot), req.body),
  )

  f.get(
    '/v1/messages/:id/media',
    { preHandler: guard('read'), schema: { ...tags('Messages'), summary: 'Download the media of a message (binary, up to 20 MB)', params: idParam, querystring: z.object({ chat: z.string().optional(), bot: botQ }) } },
    async (req, reply) => {
      const m = await app.svc.downloadMedia(accountFor(app, P(req), req.query.bot), req.query.chat, req.params.id)
      return reply.type(m.mimetype).header('content-disposition', `attachment; filename="${m.fileName.replace(/["\\\r\n]/g, '_')}"`).send(m.buf)
    },
  )

  f.post(
    '/v1/messages/:id/transcribe',
    {
      preHandler: guard('read'),
      schema: {
        ...tags('Messages'),
        summary: 'What was said in a voice or audio message (transcript, kept once made)',
        params: idParam,
        body: z.object({ chat: z.string().optional(), force: z.boolean().optional(), bot: botQ }).default({}),
      },
    },
    async (req) => {
      const t = await app.voice.transcribe(accountFor(app, P(req), req.body.bot), req.body.chat, req.params.id, { force: req.body.force })
      return { messageId: t.id, chat: t.chat, transcript: t.text, language: t.language, seconds: t.seconds, engine: t.engine, cached: t.cached }
    },
  )

  f.get(
    '/v1/contacts',
    { preHandler: guard('read'), schema: { ...tags('Contacts'), summary: 'Find people and chats by name, @username or id', querystring: z.object({ q: z.string().min(1), limit: z.coerce.number().int().min(1).max(100).optional(), bot: botQ }) } },
    async (req) => app.svc.findContacts(accountFor(app, P(req), req.query.bot), req.query.q, req.query.limit ?? 20),
  )

  // ------------------------------------------------------------------ events (SSE)
  f.get(
    '/v1/events',
    { preHandler: guard('read'), schema: { ...tags('Events'), summary: 'Server-Sent Events stream', querystring: z.object({ bot: z.string().optional(), types: z.string().optional() }) } },
    async (req, reply) => {
      const p = P(req)
      const types = req.query.types ? new Set(req.query.types.split(',')) : null
      const allowed = new Set(visibleAccounts(app, p).map((a) => a.id))
      const only = req.query.bot ? app.accounts.get(req.query.bot).id : null
      reply.hijack()
      reply.raw.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' })
      reply.raw.write(`: connected ${new Date().toISOString()}\n\n`)
      const onEv = (ev: BusEvent) => {
        if (ev.adminOnly && !p.scopes.has('admin')) return
        if (!allowed.has(ev.account) && !(p.accounts === '*')) return
        if (only && ev.account !== only) return
        if (types && !types.has(ev.type)) return
        reply.raw.write(`event: ${ev.type}\nid: ${ev.id}\ndata: ${JSON.stringify({ bot: ev.account, at: ev.at, data: ev.data })}\n\n`)
      }
      app.bus.on('event', onEv)
      const hb = setInterval(() => reply.raw.write(`: ping\n\n`), 25_000)
      req.raw.on('close', () => {
        clearInterval(hb)
        app.bus.off('event', onEv)
      })
    },
  )

  // ------------------------------------------------------------------ admin
  // ---- service log (Settings → Log)
  const LEVELS: Record<string, number> = { all: 0, debug: 20, info: 30, warn: 40, error: 50 }
  f.get(
    '/v1/admin/logs',
    { preHandler: guard('admin'), schema: { ...tags('Admin'), summary: 'Recent service log', querystring: z.object({ level: z.enum(['all', 'debug', 'info', 'warn', 'error']).optional(), q: z.string().max(200).optional(), limit: z.coerce.number().int().min(1).max(3000).optional() }) } },
    async (req) => ({ entries: recentLogs({ minLevel: LEVELS[req.query.level ?? 'all'], q: req.query.q, limit: req.query.limit ?? 500 }) }),
  )
  f.get('/v1/admin/logs/stream', { preHandler: guard('admin'), schema: { ...tags('Admin'), summary: 'Live service log (Server-Sent Events)' } }, async (req, reply) => {
    reply.hijack()
    reply.raw.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' })
    reply.raw.write(`: connected ${new Date().toISOString()}\n\n`)
    const off = onLog((e) => reply.raw.write(`data: ${JSON.stringify(e)}\n\n`))
    const hb = setInterval(() => reply.raw.write(`: ping\n\n`), 25_000)
    req.raw.on('close', () => {
      clearInterval(hb)
      off()
    })
  })
  f.get('/v1/admin/logs/download', { preHandler: guard('admin'), schema: { ...tags('Admin'), summary: 'Download the service log file (JSON lines)' } }, async (_req, reply) => {
    const body = fs.existsSync(LOG_FILE) ? fs.readFileSync(LOG_FILE) : Buffer.from('')
    return reply
      .type('application/x-ndjson; charset=utf-8')
      .header('content-disposition', `attachment; filename="teleops-${new Date().toISOString().slice(0, 10)}.log"`)
      .header('cache-control', 'no-store')
      .send(body)
  })

  f.get('/v1/admin/overview', { preHandler: guard('admin'), schema: { ...tags('Admin'), summary: 'Server overview' } }, async (req) => {
    const accounts = []
    for (const a of app.accounts.list()) accounts.push({ ...a.status(), stats: await app.svc.stats(a).catch(() => null) })
    return {
      version: VERSION,
      build: BUILD,
      versionLabel: VERSION_LABEL,
      publicUrl: publicOrigin(req, app.settings.get().publicUrl),
      database: { dialect: app.h.dialect, url: maskDbUrl(app.h.url), envOverride: !!config.dbUrlEnv },
      accounts,
      settings: app.settings.get(),
      language: { server: defaultLang(), setting: app.settings.get().language },
      theme: { appearance: app.settings.get().appearance, mode: currentTheme(app.settings.get().appearance).mode, desktop: desktopTheme()?.name ?? null },
      uptimeSec: Math.round(process.uptime()),
      installation: app.reports.code,
      license: { enabled: app.license.enabled },
    }
  })

  // ---- who am I
  f.get('/v1/me', { preHandler: signedIn, schema: { ...tags('Admin'), summary: 'The signed-in caller' } }, async (req) => {
    const p = P(req)
    return { role: p.scopes.has('admin') ? 'owner' : p.kind, id: p.id, name: p.label }
  })

  // ---- the owner's Telegram account (login codes go there)
  const ownerOut = async () => {
    const o = await app.owner.get()
    return { linked: !!o, telegram: o ? { id: o.id, name: o.name, username: o.username, bot: o.bot, at: new Date(o.at).toISOString() } : null, otpEnabled: app.settings.get().otpEnabled }
  }
  f.get('/v1/admin/owner', { preHandler: guard('admin'), schema: { ...tags('Admin'), summary: 'The owner\'s Telegram account, where login codes go' } }, async () => ownerOut())
  f.post(
    '/v1/admin/owner/link',
    { preHandler: guard('admin'), schema: { ...tags('Admin'), summary: 'A t.me link (15 minutes, once) that links the owner\'s Telegram account when Start is pressed', body: z.object({ bot: z.string().optional(), minutes: z.number().int().min(1).max(1440).optional().describe('How long the link works (default 15)') }).default({}) } },
    async (req) => app.owner.startLink(req.body?.bot, req.body?.minutes),
  )
  f.delete('/v1/admin/owner', { preHandler: guard('admin'), schema: { ...tags('Admin'), summary: 'Unlink the owner\'s Telegram account (no more login codes)' } }, async () => {
    await app.owner.clear()
    return ownerOut()
  })

  // ---- license (Polar) — off while TeleOps is free
  f.get('/v1/admin/license', { preHandler: guard('admin'), schema: { ...tags('Admin'), summary: 'License state (off while TeleOps is free)' } }, async () => app.license.status())
  f.post('/v1/admin/license', { preHandler: guard('admin'), schema: { ...tags('Admin'), summary: 'Activate a license key bought on Polar', body: z.object({ key: z.string().max(200) }) } }, async (req) =>
    app.license.activate(req.body.key),
  )
  f.delete('/v1/admin/license', { preHandler: guard('admin'), schema: { ...tags('Admin'), summary: 'Remove the license from this installation' } }, async () => app.license.deactivate())

  // ---- voice messages → text
  f.get('/v1/admin/voice', { preHandler: guard('admin'), schema: { ...tags('Admin'), summary: 'Voice messages: transcription engine and its state' } }, async () => app.voice.publicConfig())
  f.put(
    '/v1/admin/voice',
    {
      preHandler: guard('admin'),
      schema: {
        ...tags('Admin'),
        summary: 'Voice messages: choose the transcription engine (off, faster-whisper on the server, command, online service) and which voice messages to transcribe (auto: all as they arrive, or only on request)',
        body: z.object({
          engine: z.enum(['off', 'local', 'command', 'api']).optional(),
          model: z.string().max(80).optional(),
          command: z.string().max(1000).optional(),
          provider: z.enum(['xai', 'openai', 'groq', 'custom']).optional(),
          apiUrl: z.string().max(300).optional(),
          apiKey: z.string().max(500).optional(),
          apiModel: z.string().max(120).optional(),
          language: z.string().max(8).optional(),
          auto: z.boolean().optional(),
        }),
      },
    },
    async (req) => {
      await app.voice.update(req.body)
      return app.voice.publicConfig()
    },
  )
  f.post(
    '/v1/admin/voice/install',
    {
      preHandler: guard('admin'),
      schema: {
        ...tags('Admin'),
        summary: 'Voice messages: install faster-whisper in TeleOps\' own folder (Linux, macOS, Windows; no Python needed), then use it with the given model. Runs in the background: follow local.install in GET /v1/admin/voice',
        body: z.object({ model: z.string().max(80).optional() }).default({}),
      },
    },
    async (req) => {
      app.voice.installLocal(req.body?.model)
      return app.voice.publicConfig()
    },
  )
  // ---- backup (Settings → Backup)
  const sendBackupFile = (reply: import('fastify').FastifyReply, file: string, cleanup?: () => void) => {
    const st = fs.createReadStream(file)
    if (cleanup) st.on('close', cleanup)
    return reply
      .type('application/octet-stream')
      .header('content-disposition', `attachment; filename="${path.basename(file)}"`)
      .header('content-length', String(fs.statSync(file).size))
      .header('cache-control', 'no-store')
      .send(st)
  }
  const backupPassword = (v: unknown) => {
    try {
      return decodeURIComponent(String(v ?? ''))
    } catch {
      return String(v ?? '')
    }
  }
  f.get('/v1/admin/backup', { preHandler: guard('admin'), schema: { ...tags('Admin'), summary: 'Backup: settings, last / next automatic backup, backups in the folder' } }, async () => app.backup.publicConfig())
  f.put(
    '/v1/admin/backup',
    {
      preHandler: guard('admin'),
      schema: {
        ...tags('Admin'),
        summary: 'Backup: how often (off, hour, day, week), folder of the server, how many to keep, optional password',
        body: z.object({
          every: z.enum(['off', 'hour', 'day', 'week']).optional(),
          folder: z.string().max(1000).optional(),
          keep: z.number().int().min(1).max(1000).optional(),
          password: z.string().max(200).optional(),
          removePassword: z.boolean().optional(),
        }),
      },
    },
    async (req) => {
      await app.backup.update(req.body)
      return app.backup.publicConfig()
    },
  )
  f.post('/v1/admin/backup/now', { preHandler: guard('admin'), schema: { ...tags('Admin'), summary: 'Backup: make one now in the folder' } }, async () => {
    const r = await app.backup.backupNow('manual')
    return { file: path.basename(r.file), size: r.size, ...app.backup.publicConfig() }
  })
  f.get('/v1/admin/backup/download', { preHandler: guard('admin'), schema: { ...tags('Admin'), summary: 'Backup: download a fresh backup file (.teleops)' } }, async (_req, reply) => {
    const r = await app.backup.forDownload()
    return sendBackupFile(reply, r.file, r.cleanup)
  })
  f.get(
    '/v1/admin/backup/files/:name',
    { preHandler: guard('admin'), schema: { ...tags('Admin'), summary: 'Backup: download a backup of the folder', params: z.object({ name: z.string().max(200) }) } },
    async (req, reply) => sendBackupFile(reply, app.backup.fileInFolder(req.params.name)),
  )
  f.post(
    '/v1/admin/backup/files/:name/restore',
    {
      preHandler: guard('admin'),
      schema: {
        ...tags('Admin'),
        summary: 'Backup: restore a backup of the folder (a copy of the current data is saved first; TeleOps restarts)',
        params: z.object({ name: z.string().max(200) }),
        body: z.object({ password: z.string().max(200).optional() }).default({}),
      },
    },
    async (req) => app.backup.restore(app.backup.fileInFolder(req.params.name), req.body?.password ?? ''),
  )
  f.get(
    '/v1/admin/backup/folders',
    { preHandler: guard('admin'), schema: { ...tags('Admin'), summary: 'Backup: folders of the server, to choose where backups go', querystring: z.object({ path: z.string().max(1000).optional() }) } },
    async (req) => listFolders(req.query.path),
  )
  f.post(
    '/v1/admin/backup/folders',
    { preHandler: guard('admin'), schema: { ...tags('Admin'), summary: 'Backup: new folder', body: z.object({ parent: z.string().max(1000), name: z.string().max(200) }) } },
    async (req) => listFolders(makeFolder(req.body.parent, req.body.name)),
  )
  // the backup file itself is the body (application/octet-stream), the password in x-backup-password (URI-encoded)
  f.register(async (sub) => {
    sub.addContentTypeParser('application/octet-stream', (_req, payload, done) => done(null, payload))
    sub.post(
      '/v1/admin/backup/restore',
      { preHandler: guard('admin'), schema: { ...tags('Admin'), summary: 'Backup: restore from an uploaded file (body = the .teleops file; a copy of the current data is saved first; TeleOps restarts)' } },
      async (req) => app.backup.restoreUpload(req.body as Readable, backupPassword(req.headers['x-backup-password'])),
    )
  })
  f.post('/v1/admin/voice/test', { preHandler: guard('admin'), schema: { ...tags('Admin'), summary: 'Voice messages: try the engine on the latest voice message' } }, async () => app.voice.test())

  f.get('/v1/admin/settings', { preHandler: guard('admin'), schema: { ...tags('Admin'), summary: 'Get settings' } }, async () => app.settings.get())
  f.put(
    '/v1/admin/settings',
    {
      preHandler: guard('admin'),
      schema: {
        ...tags('Admin'),
        summary: 'Update settings',
        body: z.object({
          ratePerMin: z.number().optional(),
          perChatGapMs: z.number().optional(),
          sendAllowlist: z.string().optional(),
          otpEnabled: z.boolean().optional(),
          oauthAccessTtl: z.number().optional(),
          oauthRefreshDays: z.number().optional(),
          publicUrl: z.string().optional(),
          maxMediaMb: z.number().optional(),
          language: z.enum(['auto', 'en', 'it']).optional(),
          appearance: z.enum(['light', 'dark', 'system']).optional(),
          crashReports: z.enum(['ask', 'auto', 'off']).optional(),
          autoUpdate: z.boolean().optional(),
        }),
      },
    },
    async (req) => {
      const s = await app.settings.update(req.body)
      setServerLanguage(s.language)
      // switched to "send automatically": send what is pending now, so the page shows it as sent
      if (req.body.crashReports === 'auto') await Promise.race([app.reports.autoSend().catch(() => undefined), new Promise((r) => setTimeout(r, 20_000))])
      return s
    },
  )

  // ---- feedback, crash & malfunction reports (GitHub issues)
  f.get('/v1/admin/feedback', { preHandler: guard('admin'), schema: { ...tags('Admin'), summary: 'Feedback: installation code, pending crash/malfunction reports, sent reports' } }, async () => app.reports.status())
  f.post(
    '/v1/admin/feedback',
    {
      preHandler: guard('admin'),
      schema: {
        ...tags('Admin'),
        summary: 'Send feedback (opens a public GitHub issue signed with this installation code)',
        body: z.object({ kind: z.enum(['bug', 'idea', 'other']), title: z.string().max(300), message: z.string().max(10000), diagnostics: z.boolean().optional() }),
      },
    },
    async (req) => app.reports.sendFeedback(req.body, 'web'),
  )
  f.post('/v1/admin/reports/:id/send', { preHandler: guard('admin'), schema: { ...tags('Admin'), summary: 'Send a pending crash/malfunction report', params: z.object({ id: z.string() }) } }, async (req) =>
    app.reports.sendReport(req.params.id, 'manual'),
  )
  f.delete('/v1/admin/reports/:id', { preHandler: guard('admin'), schema: { ...tags('Admin'), summary: 'Discard a pending report', params: z.object({ id: z.string() }) } }, async (req) => {
    if (!app.reports.discard(req.params.id)) throw new AppError('REPORT_NOT_FOUND', 'Report not found', 404)
    return { ok: true }
  })

  // ---- updates from the GitHub repository
  f.get('/v1/admin/update', { preHandler: guard('admin'), schema: { ...tags('Admin'), summary: 'Version, latest release on GitHub, auto-update state' } }, async () => app.updater.status())
  f.post('/v1/admin/update/check', { preHandler: guard('admin'), schema: { ...tags('Admin'), summary: 'Check GitHub for a new release now' } }, async () => {
    try {
      await app.updater.check()
    } catch {
      throw new AppError('REPORT_UNREACHABLE', 'GitHub cannot be reached right now, try again later', 503)
    }
    return app.updater.status()
  })
  f.post('/v1/admin/update/apply', { preHandler: guard('admin'), schema: { ...tags('Admin'), summary: 'Install the latest release now (the service restarts by itself)' } }, async () => {
    const p = app.updater.apply('manual')
    p.catch(() => undefined)
    // quick refusals (no git, up to date, local changes) come back right away; the install itself runs on
    await Promise.race([p, new Promise((r) => setTimeout(r, 3000))])
    return app.updater.status()
  })

  // ---- database location
  f.get('/v1/admin/database', { preHandler: guard('admin'), schema: { ...tags('Admin'), summary: 'Current database' } }, async () => {
    const b = readBootstrap()
    return {
      dialect: app.h.dialect,
      url: maskDbUrl(app.h.url),
      envOverride: !!config.dbUrlEnv,
      defaultSqlite: `sqlite://${config.defaultSqlite}`,
      previous: (b.previous ?? []).map((p) => ({ url: maskDbUrl(p.dbUrl), at: new Date(p.at).toISOString() })),
    }
  })

  f.post('/v1/admin/database/test', { preHandler: guard('admin'), schema: { ...tags('Admin'), summary: 'Test a database URL', body: z.object({ url: z.string().min(3) }) } }, async (req) => {
    const t0 = Date.now()
    const { dialect } = parseDbUrl(req.body.url)
    const h = await openDb(req.body.url)
    try {
      await pingDb(h)
      let accounts: number | null = null
      try {
        const r = await h.db.selectFrom('accounts').select((eb) => eb.fn.countAll().as('n')).executeTakeFirst()
        accounts = Number(r?.n ?? 0)
      } catch {
        accounts = null
      }
      return { ok: true, dialect, latencyMs: Date.now() - t0, existingBots: accounts }
    } catch (e) {
      throw new AppError('DB_UNREACHABLE', 'Connection failed: {0}', 400, [String((e as Error).message ?? e)])
    } finally {
      await h.close().catch(() => undefined)
    }
  })

  f.post(
    '/v1/admin/database/switch',
    {
      preHandler: guard('admin'),
      schema: { ...tags('Admin'), summary: 'Move to another database (optionally copying all data) and restart', body: z.object({ url: z.string().min(3), copyData: z.boolean().default(true) }) },
    },
    async (req) => {
      if (config.dbUrlEnv) throw new AppError('ENV_OVERRIDE', 'TELEOPS_DB_URL is set in the service environment; remove it to manage the database from here', 409)
      const target = await openDb(req.body.url)
      let counts: Record<string, number> | null = null
      try {
        await pingDb(target)
        await migrate(target)
        if (req.body.copyData) {
          await app.accounts.stopAll()
          counts = await copyAll(app.h, target, (t, n) => logger.info({ table: t, n }, 'copying'))
        }
      } catch (e) {
        await target.close().catch(() => undefined)
        if (req.body.copyData) for (const a of app.accounts.list()) if (a.row.enabled) void a.start().catch(() => undefined)
        throw new AppError('DB_SWITCH_FAILED', 'Switch aborted, still on the current database: {0}', 400, [String((e as Error).message ?? e)])
      }
      await target.close()
      const b = readBootstrap()
      writeBootstrap({ dbUrl: req.body.url, previous: [...(b.previous ?? []), { dbUrl: b.dbUrl, at: now() }].slice(-5) })
      app.restart('database switched')
      return { ok: true, copied: counts, restarting: true }
    },
  )

  // ---- api keys
  f.get('/v1/admin/api-keys', { preHandler: guard('admin'), schema: { ...tags('Admin'), summary: 'List API keys' } }, async () => app.apiKeys.list())
  f.post(
    '/v1/admin/api-keys',
    {
      preHandler: guard('admin'),
      schema: { ...tags('Admin'), summary: 'Create API key (shown once)', body: z.object({ name: z.string().min(1), scopes: z.array(z.enum(['read', 'send', 'admin'])).min(1), bots: z.union([z.literal('*'), z.array(z.string())]).default('*').describe('Bots the key may use (ids), or *') }) },
    },
    async (req, reply) => reply.code(201).send(await app.apiKeys.create(req.body.name, req.body.scopes, req.body.bots)),
  )
  f.delete('/v1/admin/api-keys/:id', { preHandler: guard('admin'), schema: { ...tags('Admin'), summary: 'Revoke API key', params: z.object({ id: z.string() }) } }, async (req) => {
    await app.apiKeys.revoke(req.params.id)
    return { ok: true }
  })

  // ---- webhooks
  const HOOK_HEADERS = z.union([z.string().max(8000), z.record(z.string(), z.string())])
  f.get('/v1/admin/webhooks', { preHandler: guard('admin'), schema: { ...tags('Webhooks'), summary: 'List webhooks' } }, async () => {
    const hooks = await app.h.db.selectFrom('webhooks').selectAll().orderBy('created_at').execute()
    return hooks.map((h) => ({ ...h, bot: h.account_id, secret: h.secret.slice(0, 6) + '…', headers: maskHookHeaders(h.headers as string | null) }))
  })
  f.post(
    '/v1/admin/webhooks',
    {
      preHandler: guard('admin'),
      schema: {
        ...tags('Webhooks'),
        summary: `Create webhook. Events: * or ${WEBHOOK_EVENTS.join(', ')}. Signature: X-TeleOps-Signature = sha256=HMAC(secret, X-TeleOps-Timestamp + "." + body). headers: the receiver's key or header lines (e.g. an Authorization header), sent with every delivery.`,
        body: z.object({ url: z.url(), events: z.string().default('*'), bot: z.string().default('*'), headers: HOOK_HEADERS.optional() }),
      },
    },
    async (req, reply) => {
      const id = crypto.randomUUID()
      const secret = randomToken('tow_', 24)
      const headers = parseHookHeaders(req.body.headers)
      await app.h.db
        .insertInto('webhooks')
        .values({ id, url: req.body.url, events: req.body.events, account_id: req.body.bot === '*' ? '*' : app.accounts.get(req.body.bot).id, secret, active: 1, created_at: now(), headers: Object.keys(headers).length ? JSON.stringify(headers) : null })
        .execute()
      await app.webhooks.reload()
      return reply.code(201).send({ id, url: req.body.url, events: req.body.events, bot: req.body.bot, secret, headers: maskHookHeaders(JSON.stringify(headers)) })
    },
  )
  f.patch(
    '/v1/admin/webhooks/:id',
    {
      preHandler: guard('admin'),
      schema: {
        ...tags('Webhooks'),
        summary: 'Update webhook (headers: "" removes the extra headers)',
        params: z.object({ id: z.string() }),
        body: z.object({ active: z.boolean().optional(), events: z.string().optional(), url: z.url().optional(), headers: HOOK_HEADERS.optional() }),
      },
    },
    async (req) => {
      const set: Record<string, unknown> = {}
      if (req.body.active !== undefined) set.active = req.body.active ? 1 : 0
      if (req.body.events) set.events = req.body.events
      if (req.body.url) set.url = req.body.url
      if (req.body.headers !== undefined) {
        const headers = parseHookHeaders(req.body.headers)
        set.headers = Object.keys(headers).length ? JSON.stringify(headers) : null
      }
      if (Object.keys(set).length) await app.h.db.updateTable('webhooks').set(set).where('id', '=', req.params.id).execute()
      await app.webhooks.reload()
      return { ok: true }
    },
  )
  f.delete('/v1/admin/webhooks/:id', { preHandler: guard('admin'), schema: { ...tags('Webhooks'), summary: 'Delete webhook', params: z.object({ id: z.string() }) } }, async (req) => {
    await app.h.db.deleteFrom('webhooks').where('id', '=', req.params.id).execute()
    await app.webhooks.reload()
    return { ok: true }
  })
  f.get('/v1/admin/webhooks/deliveries', { preHandler: guard('admin'), schema: { ...tags('Webhooks'), summary: 'Recent deliveries' } }, async () =>
    app.h.db.selectFrom('webhook_deliveries').selectAll().orderBy('created_at', 'desc').limit(100).execute(),
  )
  f.post('/v1/admin/webhooks/:id/test', { preHandler: guard('admin'), schema: { ...tags('Webhooks'), summary: 'Send a test event to this webhook only', params: z.object({ id: z.string() }) } }, async (req) => {
    // to this webhook only, whatever its events; the answer of the receiver comes back
    return app.webhooks.deliverTest(req.params.id, app.accounts.list()[0]?.id ?? 'test')
  })

  // ---- OAuth grants & admin sessions
  f.get('/v1/admin/oauth', { preHandler: guard('admin'), schema: { ...tags('Admin'), summary: 'Connected OAuth apps' } }, async () => ({
    grants: await app.oauth.listGrants(),
    clients: await app.h.db.selectFrom('oauth_clients').select(['client_id', 'name', 'redirect_uris', 'auth_method', 'created_at']).orderBy('created_at', 'desc').limit(100).execute(),
  }))
  f.delete('/v1/admin/oauth/grants/:family', { preHandler: guard('admin'), schema: { ...tags('Admin'), summary: 'Revoke an OAuth grant', params: z.object({ family: z.string() }) } }, async (req) => {
    await app.oauth.revokeFamily(req.params.family)
    return { ok: true }
  })
  f.get('/v1/admin/sessions', { preHandler: guard('admin'), schema: { ...tags('Admin'), summary: 'Admin browser sessions' } }, async () => app.admin.listSessions())
  f.delete('/v1/admin/sessions/:id', { preHandler: guard('admin'), schema: { ...tags('Admin'), summary: 'Revoke admin session', params: z.object({ id: z.string() }) } }, async (req) => {
    await app.admin.revokeSession(req.params.id)
    return { ok: true }
  })
  f.post('/v1/admin/login-link', { preHandler: guard('admin'), schema: { ...tags('Admin'), summary: 'Create a one-time login link (30 min)' } }, async (req) => {
    const t = await app.admin.createLoginToken('link', 30 * 60_000)
    return { url: `${publicOrigin(req, app.settings.get().publicUrl)}/login?t=${t}`, expiresInMin: 30 }
  })
  f.put('/v1/admin/password', { preHandler: guard('admin'), schema: { ...tags('Admin'), summary: 'Set admin password', body: z.object({ password: z.string().min(10) }) } }, async (req) => {
    await app.admin.setPassword(req.body.password)
    return { ok: true }
  })
  f.delete('/v1/admin/password', { preHandler: guard('admin'), schema: { ...tags('Admin'), summary: 'Disable password login' } }, async () => {
    await app.admin.clearPassword()
    return { ok: true }
  })
  f.post('/v1/admin/restart', { preHandler: guard('admin'), schema: { ...tags('Admin'), summary: 'Restart the service' } }, async () => {
    app.restart('admin request')
    return { ok: true, restarting: true }
  })
  f.get('/v1/admin/defaults', { preHandler: guard('admin'), schema: { hide: true } }, async () => DEFAULT_SETTINGS)
}
