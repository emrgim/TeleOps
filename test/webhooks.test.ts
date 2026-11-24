import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { describeEvent, EventBus, isWebhookEventAllowed, maskHookHeaders, parseHookHeaders, parseWebhookAllowChats, signPayload, WebhookDispatcher } from '../src/events.js'

const BOT = '7000000001'
const mario = { chat: '393331234', chatType: 'private', senderName: 'Mario Rossi', senderUsername: 'mario', text: 'ciao' }

describe('webhook headers, written the way receivers show them', () => {
  it('a key alone, "Bearer <key>" or the whole header line', () => {
    const want = { Authorization: 'Bearer crsr_95d84a3f816c59bc6a431b8d59a8e688ce' }
    expect(parseHookHeaders('crsr_95d84a3f816c59bc6a431b8d59a8e688ce')).toEqual(want)
    expect(parseHookHeaders('Bearer crsr_95d84a3f816c59bc6a431b8d59a8e688ce')).toEqual(want)
    expect(parseHookHeaders('  Authorization: Bearer crsr_95d84a3f816c59bc6a431b8d59a8e688ce  ')).toEqual(want)
    expect(parseHookHeaders('bearer crsr_95d84a3f816c59bc6a431b8d59a8e688ce')).toEqual(want)
  })
  it('other headers, several lines, an object; empty = none', () => {
    expect(parseHookHeaders('X-Api-Key: abc123\nAuthorization: Basic dXNlcjpwYXNz')).toEqual({ 'X-Api-Key': 'abc123', Authorization: 'Basic dXNlcjpwYXNz' })
    expect(parseHookHeaders({ 'X-Automation-Key': 'k1' })).toEqual({ 'X-Automation-Key': 'k1' })
    expect(parseHookHeaders('{"X-Token":"t"}')).toEqual({ 'X-Token': 't' })
    expect(parseHookHeaders('')).toEqual({})
    expect(parseHookHeaders(undefined)).toEqual({})
  })
  it('refuses what would break the request or the signature', () => {
    expect(() => parseHookHeaders('X-TeleOps-Signature: x')).toThrow()
    expect(() => parseHookHeaders('Content-Type: text/plain')).toThrow()
    expect(() => parseHookHeaders('two words here')).toThrow()
    expect(() => parseHookHeaders({ 'Bad Name': 'x' })).toThrow()
  })
  it('the key is never shown whole', () => {
    expect(maskHookHeaders(JSON.stringify({ Authorization: 'Bearer crsr_95d84a3f816c59bc6a431b8d59a8e688ce' }))).toEqual({ Authorization: 'Bearer crsr_95d…' })
    expect(maskHookHeaders(JSON.stringify({ 'X-Api-Key': 'short' }))).toEqual({ 'X-Api-Key': '…' })
    expect(maskHookHeaders(null)).toEqual({})
  })
  it('context in plain words', () => {
    expect(describeEvent({ type: 'message.received', account: BOT, data: mario })).toBe('Telegram message received by bot 7000000001 from Mario Rossi @mario: ciao')
    expect(describeEvent({ type: 'message.received', account: BOT, data: { ...mario, chat: '-1001', chatType: 'supergroup', chatName: 'Crew' } }, 'Support')).toBe(
      'Telegram message received by Support (bot 7000000001) from Mario Rossi @mario in the group "Crew": ciao',
    )
    expect(describeEvent({ type: 'button.pressed', account: BOT, data: { ...mario, data: 'yes', label: 'Sì' } })).toBe('Button "Sì" pressed by Mario Rossi @mario on a message of bot 7000000001 (data: yes)')
    expect(describeEvent({ type: 'chat.member', account: BOT, data: { chat: '393331234', chatType: 'private', bot: true, status: 'kicked', byName: 'Mario Rossi' } })).toBe('Mario Rossi blocked bot 7000000001')
  })
})

describe('delivery with the receiver key (Cursor / Grok Bot automation format)', () => {
  let server: http.Server
  let url = ''
  let status = 200
  const got: { headers: http.IncomingHttpHeaders; body: string }[] = []
  let disp: WebhookDispatcher
  let bus: EventBus
  let h: Awaited<ReturnType<typeof import('../src/db/index.js').openDb>>

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        got.push({ headers: req.headers, body })
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end('{}')
      })
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    url = `http://127.0.0.1:${(server.address() as { port: number }).port}/automations/webhook/abc`
    const { openDb, migrate } = await import('../src/db/index.js')
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'to-hooks-'))
    h = await openDb(`sqlite://${path.join(dir, 't.db')}`)
    await migrate(h)
    const t = Date.now()
    await h.db
      .insertInto('webhooks')
      .values([
        { id: 'cursor', url, events: 'message.received', account_id: '*', secret: 'tow_s1', active: 1, created_at: t, headers: JSON.stringify(parseHookHeaders('Authorization: Bearer crsr_key1')) },
        { id: 'plain', url, events: 'connection.update', account_id: '*', secret: 'tow_s2', active: 1, created_at: t + 1, headers: null },
      ])
      .execute()
    bus = new EventBus()
    disp = new WebhookDispatcher(h, bus)
    await disp.start()
  })
  afterAll(() => server.close())

  it('sends Authorization: Bearer <key>, the signature and a context line', async () => {
    bus.publish('message.received', BOT, mario)
    await new Promise((r) => setTimeout(r, 300))
    expect(got.length).toBe(1)
    const { headers, body } = got[0]
    expect(headers.authorization).toBe('Bearer crsr_key1')
    expect(headers['content-type']).toBe('application/json')
    expect(headers['x-teleops-bot']).toBe(BOT)
    expect(headers['x-teleops-event']).toBe('message.received')
    expect(headers['x-teleops-signature']).toBe(signPayload('tow_s1', String(headers['x-teleops-timestamp']), body))
    expect(JSON.parse(body)).toMatchObject({ type: 'message.received', bot: BOT, context: 'Telegram message received by bot 7000000001 from Mario Rossi @mario: ciao', data: { text: 'ciao' } })
  })

  it('the bot name goes into the context once known', async () => {
    got.length = 0
    disp.setNames({ botName: (id) => (id === BOT ? 'Support' : null), chatUsername: async () => null })
    bus.publish('message.received', BOT, mario)
    await new Promise((r) => setTimeout(r, 300))
    expect(JSON.parse(got[0].body).context).toBe('Telegram message received by Support (bot 7000000001) from Mario Rossi @mario: ciao')
  })

  it('Test reaches only that webhook, whatever its events, and returns the answer', async () => {
    got.length = 0
    disp.setNames({ botName: () => null, chatUsername: async () => null })
    const r = await disp.deliverTest('cursor', BOT)
    expect(r).toEqual({ ok: true, status: 200, error: null })
    expect(got.length).toBe(1)
    expect(got[0].headers.authorization).toBe('Bearer crsr_key1')
    expect(JSON.parse(got[0].body)).toMatchObject({ type: 'webhook.test', context: 'Test event from TeleOps (bot 7000000001): the webhook works.' })
    got.length = 0
    await disp.deliverTest('plain', BOT)
    expect(got[0].headers.authorization).toBeUndefined()
  })

  it('a wrong key: the error comes back, no retries for a test', async () => {
    status = 401
    const r = await disp.deliverTest('cursor', BOT)
    expect(r).toEqual({ ok: false, status: 401, error: 'HTTP 401' })
    const d = await h.db.selectFrom('webhook_deliveries').selectAll().where('webhook_id', '=', 'cursor').orderBy('updated_at', 'desc').executeTakeFirst()
    expect(d).toMatchObject({ state: 'failed', last_status: 401 })
    status = 200
  })

  it('a database from an older version gets the new column, its webhooks untouched', async () => {
    const { openDb, migrate } = await import('../src/db/index.js')
    const { sql } = await import('kysely')
    const old = await openDb(`sqlite://${path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'to-hooks-old-')), 'o.db')}`)
    await sql`create table webhooks (id varchar(64) not null primary key, url text, events text, account_id varchar(64), secret varchar(255), active integer, created_at bigint)`.execute(old.db)
    await sql`insert into webhooks values ('w1', 'https://example.com/h', '*', '*', 'tow_x', 1, 1)`.execute(old.db)
    await migrate(old)
    const cols = (await old.db.introspection.getTables()).find((t) => t.name === 'webhooks')!.columns.map((c) => c.name)
    expect(cols).toContain('headers')
    expect(await old.db.selectFrom('webhooks').selectAll().execute()).toMatchObject([{ id: 'w1', url: 'https://example.com/h', headers: null }])
  })
})

describe('WEBHOOK_ALLOW_CHATS allowlist', () => {
  const group = { chat: '-1001234567890', chatName: 'Crew', text: 'ciao' }

  it('unset = no filter; empty or whitespace = forward nothing', () => {
    expect(parseWebhookAllowChats(undefined)).toBeNull()
    expect(isWebhookEventAllowed({ data: mario }, null)).toBe(true)
    const empty = parseWebhookAllowChats('')
    expect(empty).toEqual(new Set())
    expect(isWebhookEventAllowed({ data: mario }, empty)).toBe(false)
    expect(isWebhookEventAllowed({ data: mario }, parseWebhookAllowChats('   ,  '))).toBe(false)
  })

  it('matches a chat id or an @username, and no other chat', () => {
    const byId = parseWebhookAllowChats('393331234, -1001234567890')
    expect(isWebhookEventAllowed({ data: mario }, byId)).toBe(true)
    expect(isWebhookEventAllowed({ data: group }, byId)).toBe(true)
    expect(isWebhookEventAllowed({ data: { chat: '555', text: 'x' } }, byId)).toBe(false)
    expect(isWebhookEventAllowed({ data: { text: 'no chat' } }, byId)).toBe(false)
    const byName = parseWebhookAllowChats('@Mario')
    expect(isWebhookEventAllowed({ data: mario }, byName, 'mario')).toBe(true)
    expect(isWebhookEventAllowed({ data: group }, byName, 'crew_chat')).toBe(false)
  })
})

describe('delivery skipped when the allowlist is empty, still sent for an allowed chat', () => {
  let server: http.Server
  let url = ''
  const got: string[] = []
  let h: Awaited<ReturnType<typeof import('../src/db/index.js').openDb>>

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        got.push(body)
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end('{}')
      })
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    url = `http://127.0.0.1:${(server.address() as { port: number }).port}/hook`
    const { openDb, migrate } = await import('../src/db/index.js')
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'to-allow-'))
    h = await openDb(`sqlite://${path.join(dir, 't.db')}`)
    await migrate(h)
    await h.db.insertInto('webhooks').values({ id: 'w1', url, events: 'message.received', account_id: '*', secret: 'tow_s', active: 1, created_at: Date.now(), headers: null }).execute()
  })
  afterAll(() => server.close())

  it('empty allowlist: no POST, even if the webhook is active', async () => {
    got.length = 0
    const bus = new EventBus()
    const disp = new WebhookDispatcher(h, bus, parseWebhookAllowChats(''))
    await disp.start()
    bus.publish('message.received', BOT, mario)
    await new Promise((r) => setTimeout(r, 300))
    expect(got.length).toBe(0)
    expect(await h.db.selectFrom('webhook_deliveries').selectAll().execute()).toEqual([])
  })

  it('allowlist with that chat (id or @username): the event is POSTed', async () => {
    got.length = 0
    const bus = new EventBus()
    const disp = new WebhookDispatcher(h, bus, parseWebhookAllowChats('393331234'))
    await disp.start()
    bus.publish('message.received', BOT, mario)
    await new Promise((r) => setTimeout(r, 300))
    expect(got.length).toBe(1)
    expect(JSON.parse(got[0])).toMatchObject({ type: 'message.received', data: { text: 'ciao' } })
    got.length = 0
    const bus2 = new EventBus()
    const disp2 = new WebhookDispatcher(h, bus2, parseWebhookAllowChats('@mario'))
    disp2.setNames({ botName: () => null, chatUsername: async (_b, chat) => (chat === '393331234' ? 'Mario' : null) })
    await disp2.start()
    bus2.publish('message.received', BOT, mario)
    await new Promise((r) => setTimeout(r, 300))
    expect(got.length).toBe(1)
  })

  it('Test still reaches the webhook when the allowlist is empty', async () => {
    got.length = 0
    const bus = new EventBus()
    const disp = new WebhookDispatcher(h, bus, parseWebhookAllowChats(''))
    await disp.start()
    const r = await disp.deliverTest('w1', BOT)
    expect(r).toEqual({ ok: true, status: 200, error: null })
    expect(got.length).toBe(1)
    expect(JSON.parse(got[0]).type).toBe('webhook.test')
  })
})
