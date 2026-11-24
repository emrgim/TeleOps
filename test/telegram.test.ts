/**
 * The Telegram layer end to end, against a fake Bot API on localhost (TELEOPS_BOT_API):
 * linking a bot, long polling, storing and announcing messages, sending with buttons, button presses,
 * flood waits, a webhook of another program, a bot blocked by a person, the owner link + login codes,
 * and the MCP tools on top of it.
 */
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

type Call = { token: string; method: string; params: Record<string, unknown> }
const TOKEN = '7000000001:AAEtestTokenForTeleOpsTests_0000000000'
const TOKEN2 = '7000000002:AAEtestTokenForTeleOpsTests_2222222222'
const BAD = '7000000009:BADtestTokenForTeleOpsTests_999999999'
const calls: Call[] = []
const queues = new Map<string, unknown[]>()
const waiters = new Map<string, () => void>()
const webhookFor = new Set<string>([TOKEN2])
let nextMsg = 100
let nextUpdate = 1
let flood = 0
const now = () => Math.floor(Date.now() / 1000)
const mario = { id: 393331234, is_bot: false, first_name: 'Mario', last_name: 'Rossi', username: 'mario', language_code: 'it' }
const marioChat = { id: 393331234, type: 'private', first_name: 'Mario', last_name: 'Rossi', username: 'mario' }
const botUser = (id: number) => ({ id, is_bot: true, first_name: `Test Bot ${id}`, username: `test${id}_bot` })

function push(token: string, u: Record<string, unknown>) {
  const q = queues.get(token) ?? []
  q.push({ update_id: nextUpdate++, ...u })
  queues.set(token, q)
  waiters.get(token)?.()
}
const callsOf = (method: string) => calls.filter((c) => c.method === method)
async function waitFor<T>(fn: () => T | Promise<T>, ms = 6000): Promise<NonNullable<T>> {
  const end = Date.now() + ms
  for (;;) {
    const v = await fn()
    if (v) return v as NonNullable<T>
    if (Date.now() > end) throw new Error('timed out waiting')
    await new Promise((r) => setTimeout(r, 25))
  }
}

const server = http.createServer(async (req, res) => {
  let body = ''
  for await (const c of req) body += c
  const m = (req.url ?? '').match(/^\/bot([^/]+)\/([A-Za-z]+)/)
  const send = (code: number, j: unknown) => {
    res.writeHead(code, { 'content-type': 'application/json' })
    res.end(JSON.stringify(j))
  }
  if (!m) return send(404, { ok: false, error_code: 404, description: 'Not Found' })
  const [, token, method] = m
  const params = String(req.headers['content-type'] ?? '').includes('application/json') && body ? (JSON.parse(body) as Record<string, unknown>) : {}
  calls.push({ token, method, params })
  const ok = (result: unknown) => send(200, { ok: true, result })
  const fail = (code: number, description: string, extra: Record<string, unknown> = {}) => send(code, { ok: false, error_code: code, description, ...extra })
  if (token.includes('BAD')) return fail(401, 'Unauthorized')
  const id = Number(token.split(':')[0])
  const message = (p: Record<string, unknown>) => {
    const chat = Number(p.chat_id)
    return {
      message_id: nextMsg++,
      date: now(),
      chat: chat < 0 ? { id: chat, type: 'supergroup', title: 'Crew' } : { ...marioChat, id: chat },
      from: botUser(id),
      ...(p.text ? { text: p.text } : {}),
      ...(p.reply_markup ? { reply_markup: typeof p.reply_markup === 'string' ? JSON.parse(p.reply_markup) : p.reply_markup } : {}),
    }
  }
  switch (method) {
    case 'getMe':
      return ok({ ...botUser(id), can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false })
    case 'getWebhookInfo':
      return ok({ url: webhookFor.has(token) ? 'https://other.example/hook' : '', has_custom_certificate: false, pending_update_count: 0 })
    case 'deleteWebhook':
      webhookFor.delete(token)
      return ok(true)
    case 'getUpdates': {
      if (webhookFor.has(token)) return fail(409, "Conflict: can't use getUpdates method while webhook is active; use deleteWebhook to delete the webhook first")
      if (!(queues.get(token) ?? []).length) await new Promise<void>((r) => { waiters.set(token, r); setTimeout(r, 300) })
      return ok((queues.get(token) ?? []).splice(0))
    }
    case 'sendMessage':
      if (flood > 0) {
        flood--
        return fail(429, 'Too Many Requests: retry after 1', { parameters: { retry_after: 1 } })
      }
      return ok(message(params))
    case 'editMessageText':
      return ok({ ...message(params), message_id: Number(params.message_id), edit_date: now() })
    case 'getMyShortDescription':
      return ok({ short_description: 'I answer the crew' })
    case 'getMyDescription':
      return ok({ description: 'The bot of the crew' })
    case 'getMyCommands':
      return ok([{ command: 'start', description: 'Start' }])
    case 'getUserProfilePhotos':
      return ok({ total_count: 0, photos: [] })
    case 'getChat':
      if (String(params.chat_id) !== '393331234' && params.chat_id !== '@mario') return fail(400, 'Bad Request: chat not found')
      return ok({ ...marioChat, accent_color_id: 0, max_reaction_count: 11, bio: 'Lighting' })
    case 'answerCallbackQuery':
    case 'setMessageReaction':
    case 'deleteMessage':
    case 'pinChatMessage':
    case 'setMyName':
    case 'setMyShortDescription':
    case 'setMyDescription':
    case 'setMyCommands':
    case 'deleteMyCommands':
    case 'setMySettings':
      return ok(true)
    default:
      return fail(404, 'Not Found')
  }
})

let mods: {
  accounts: import('../src/tg/manager.js').AccountManager
  svc: import('../src/tg/service.js').TgService
  owner: import('../src/owner.js').OwnerLink
  events: import('../src/events.js').BusEvent[]
  h: import('../src/db/index.js').DbHandle
}
const ev = (type: string, f: (d: Record<string, unknown>) => boolean = () => true) => mods.events.find((e) => e.type === type && f(e.data as Record<string, unknown>))

beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  // read by src/tg/api.ts when it is first imported: only dynamic imports below
  process.env.TELEOPS_BOT_API = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  const { openDb, migrate } = await import('../src/db/index.js')
  const { EventBus } = await import('../src/events.js')
  const { Settings } = await import('../src/settings.js')
  const { AccountManager } = await import('../src/tg/manager.js')
  const { TgService } = await import('../src/tg/service.js')
  const { AdminAuth } = await import('../src/security/auth.js')
  const { OwnerLink } = await import('../src/owner.js')
  const h = await openDb(`sqlite://${path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'to-tg-')), 't.db')}`)
  await migrate(h)
  const settings = new Settings(h)
  await settings.load()
  await settings.update({ ratePerMin: 6000, perChatGapMs: 0 })
  const bus = new EventBus()
  const events: import('../src/events.js').BusEvent[] = []
  bus.on('event', (e: import('../src/events.js').BusEvent) => events.push(e))
  const ctx: ConstructorParameters<typeof AccountManager>[0] = { h, bus, settings }
  const accounts = new AccountManager(ctx)
  const owner = new OwnerLink(h, new AdminAuth(h), accounts)
  ctx.onStart = (acc, m, param) => owner.onStart(acc, m, param)
  mods = { accounts, svc: new TgService(h, accounts, settings), owner, events, h }
})
afterAll(async () => {
  await mods?.accounts.stopAll()
  server.close()
})

describe('a bot linked with its token', () => {
  it('refuses a token Telegram does not accept', async () => {
    await expect(mods.accounts.create({ token: BAD })).rejects.toMatchObject({ code: 'INVALID_TOKEN' })
    await expect(mods.accounts.create({ token: 'hello' })).rejects.toMatchObject({ code: 'INVALID_TOKEN' })
  })

  it('links, reads its updates and stores what people write', async () => {
    const r = await mods.accounts.create({ token: TOKEN })
    expect(r.created).toBe(true)
    const acc = r.account
    expect(acc.id).toBe('7000000001')
    expect(acc.status()).toMatchObject({ username: 'test7000000001_bot', link: 'https://t.me/test7000000001_bot', default: true, readsAllGroupMessages: false })
    await waitFor(() => acc.state === 'open')
    push(TOKEN, { message: { message_id: 1, date: now(), chat: marioChat, from: mario, text: 'ciao, ci sei?' } })
    const got = await waitFor(() => ev('message.received'))
    expect(got.data).toMatchObject({ chat: '393331234', chatType: 'private', fromMe: false, senderName: 'Mario Rossi', senderUsername: 'mario', text: 'ciao, ci sei?', type: 'text' })
    const chats = JSON.stringify(await mods.svc.listChats(acc, {}))
    expect(chats).toContain('393331234')
    expect(chats).toContain('ciao, ci sei?')
    const msgs = JSON.stringify(await mods.svc.getMessages(acc, '@mario', {}))
    expect(msgs).toContain('ciao, ci sei?')
    expect(JSON.stringify(await mods.svc.findContacts(acc, 'mario'))).toContain('393331234')
    expect(await mods.svc.stats(acc)).toMatchObject({ messages: 1, chats: 1, people: 1 })
    // the update offset is kept: a restart does not read the same updates again
    const row = await mods.h.db.selectFrom('accounts').select('update_offset').where('id', '=', acc.id).executeTakeFirst()
    expect(Number(row?.update_offset)).toBeGreaterThan(1)
  })

  it('sends text with buttons; a press comes back as button.pressed', async () => {
    const acc = mods.accounts.get()
    await mods.svc.sendText(acc, { to: '@mario', text: 'Vieni stasera?', buttons: [[{ text: 'Sì', data: 'yes' }, { text: 'No', data: 'no' }], { text: 'Sito', url: 'https://example.com' }] })
    const call = callsOf('sendMessage').at(-1)!
    expect(call.params).toMatchObject({ chat_id: 393331234, text: 'Vieni stasera?' })
    const kb = (typeof call.params.reply_markup === 'string' ? JSON.parse(call.params.reply_markup) : call.params.reply_markup) as { inline_keyboard: { text: string; callback_data?: string; url?: string }[][] }
    expect(kb.inline_keyboard).toEqual([[{ text: 'Sì', callback_data: 'yes' }, { text: 'No', callback_data: 'no' }], [{ text: 'Sito', url: 'https://example.com' }]])
    const sent = await waitFor(() => ev('message.sent', (d) => d.text === 'Vieni stasera?'))
    expect(sent.data).toMatchObject({ fromMe: true, chat: '393331234' })
    const messageId = Number((sent.data as { id: string }).id)
    push(TOKEN, {
      callback_query: {
        id: 'cb1',
        from: mario,
        chat_instance: 'ci1',
        data: 'yes',
        message: { message_id: messageId, date: now(), chat: marioChat, from: botUser(7000000001), text: 'Vieni stasera?', reply_markup: kb },
      },
    })
    const press = await waitFor(() => ev('button.pressed'))
    expect(press.data).toMatchObject({ data: 'yes', label: 'Sì', messageId: String(messageId), senderName: 'Mario Rossi', senderUsername: 'mario' })
    await waitFor(() => callsOf('answerCallbackQuery').find((c) => c.params.callback_query_id === 'cb1'))
    expect(JSON.stringify(await mods.svc.getMessages(acc, '393331234', {}))).toContain('[button] Sì (yes)')
    // the bot itself (sender of its own messages) is not one of the people
    expect(await mods.svc.stats(acc)).toMatchObject({ people: 1 })
    expect(JSON.stringify(await mods.svc.findContacts(acc, 'test7000000001_bot'))).not.toContain('7000000001')
  })

  it('refuses buttons Telegram would refuse, before calling it', async () => {
    const acc = mods.accounts.get()
    const before = calls.length
    await expect(mods.svc.sendText(acc, { to: '393331234', text: 'x', buttons: [{ text: 'A', data: 'x'.repeat(65) }] })).rejects.toThrow(/64 bytes/)
    await expect(mods.svc.sendText(acc, { to: '393331234', text: 'x', buttons: [{ text: 'A', url: 'javascript:alert(1)' }] })).rejects.toThrow(/tg:\/\//)
    expect(calls.length).toBe(before)
  })

  it('waits out a flood limit (429 retry_after) and sends', async () => {
    const acc = mods.accounts.get()
    flood = 1
    const n = callsOf('sendMessage').length
    const t = Date.now()
    await mods.svc.sendText(acc, { to: '393331234', text: 'dopo la pausa' })
    expect(callsOf('sendMessage').length).toBe(n + 2)
    expect(Date.now() - t).toBeGreaterThanOrEqual(1000)
  }, 15_000)

  it('knows when a person blocks the bot', async () => {
    push(TOKEN, { my_chat_member: { chat: marioChat, from: mario, date: now(), old_chat_member: { user: botUser(7000000001), status: 'member' }, new_chat_member: { user: botUser(7000000001), status: 'kicked', until_date: 0 } } })
    const e = await waitFor(() => ev('chat.member'))
    expect(e.data).toMatchObject({ chat: '393331234', bot: true, status: 'kicked', oldStatus: 'member', byName: 'Mario Rossi' })
    expect(JSON.stringify(await mods.svc.listChats(mods.accounts.get(), {}))).toContain('kicked')
  })
})

describe('a bot that sends its updates to another program (webhook)', () => {
  it('is taken over only when asked', async () => {
    await expect(mods.accounts.create({ token: TOKEN2 })).rejects.toMatchObject({ code: 'WEBHOOK_SET' })
    expect(mods.accounts.list().map((a) => a.id)).toEqual(['7000000001'])
    const r = await mods.accounts.create({ token: TOKEN2, takeOver: true })
    expect(callsOf('deleteWebhook').some((c) => c.token === TOKEN2)).toBe(true)
    await waitFor(() => r.account.state === 'open')
    expect(r.account.status().default).toBe(false)
    await mods.accounts.remove(r.account.id)
    expect(mods.accounts.list().map((a) => a.id)).toEqual(['7000000001'])
  })
})

describe('the owner links their Telegram: login codes go there', () => {
  it('/start with the one-time token links the person who pressed Start', async () => {
    const link = await mods.owner.startLink()
    expect(link.url).toMatch(/^https:\/\/t\.me\/test7000000001_bot\?start=own[A-Za-z0-9_-]{20,40}$/)
    const param = new URL(link.url).searchParams.get('start')!
    const received = mods.events.filter((e) => e.type === 'message.received').length
    push(TOKEN, { message: { message_id: 2, date: now(), chat: marioChat, from: mario, text: `/start ${param}` } })
    const o = await waitFor(() => mods.owner.get())
    expect(o).toMatchObject({ id: '393331234', name: 'Mario Rossi', username: 'mario', bot: '7000000001' })
    const confirm = await waitFor(() => callsOf('sendMessage').find((c) => String(c.params.text).startsWith('✅')))
    expect(confirm.params.chat_id).toBe(393331234)
    // handled by TeleOps itself: not stored, no event
    expect(mods.events.filter((e) => e.type === 'message.received').length).toBe(received)
    // the same link a second time does nothing but say it expired
    push(TOKEN, { message: { message_id: 3, date: now(), chat: marioChat, from: mario, text: `/start ${param}` } })
    await waitFor(() => callsOf('sendMessage').length && String(callsOf('sendMessage').at(-1)!.params.text).includes('expired'))
  })

  it('sends the login code from the bot, as copyable HTML', async () => {
    expect(await mods.owner.sendCode('123456', 'en')).toBe('@mario')
    const c = callsOf('sendMessage').at(-1)!
    expect(c.params).toMatchObject({ chat_id: 393331234, parse_mode: 'HTML', protect_content: true })
    expect(String(c.params.text)).toContain('<code>123456</code>')
  })
})

describe('MCP tools on the same bot', () => {
  it('lists the Telegram tools and sends through telegram_send_text', async () => {
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
    const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js')
    const { buildMcpServer } = await import('../src/mcp/server.js')
    const app = { accounts: mods.accounts, svc: mods.svc }
    const p = { kind: 'apikey', id: 'k', label: 'test', scopes: new Set(['read', 'send']), accounts: '*' }
    const server = buildMcpServer(app as never, p as never, 'https://teleops.test', 'en')
    const [a, b] = InMemoryTransport.createLinkedPair()
    await server.connect(a)
    const client = new Client({ name: 'test', version: '1' })
    await client.connect(b)
    const { tools } = await client.listTools()
    const names = tools.map((t) => t.name)
    expect(names).toEqual(expect.arrayContaining(['telegram_bots', 'telegram_send_text', 'telegram_get_messages', 'telegram_transcribe_voice', 'teleops_feedback']))
    expect(names.filter((n) => /whatsapp/.test(n))).toEqual([])
    const bots = await client.callTool({ name: 'telegram_bots', arguments: {} })
    expect(JSON.stringify(bots.content)).toContain('test7000000001_bot')
    const r = await client.callTool({ name: 'telegram_send_text', arguments: { to: '@mario', text: 'dal MCP' } })
    expect(r.isError).toBeFalsy()
    expect(callsOf('sendMessage').at(-1)!.params).toMatchObject({ chat_id: 393331234, text: 'dal MCP' })
    const bad = await client.callTool({ name: 'telegram_send_text', arguments: { to: '@nobody_here', text: 'x' } })
    expect(bad.isError).toBe(true)
    await client.close()
  })
})
