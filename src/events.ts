import { EventEmitter } from 'node:events'
import crypto from 'node:crypto'
import { now, upsert, type DbHandle } from './db/index.js'
import { logger } from './log.js'
import { AppError } from './util.js'

export type BusEvent = {
  id: string
  type: string
  account: string
  at: number
  data: unknown
  /** events only shown to admins */
  adminOnly?: boolean
}

export class EventBus extends EventEmitter {
  constructor() {
    super()
    this.setMaxListeners(200)
  }
  publish(type: string, account: string, data: unknown, adminOnly = false): void {
    const ev: BusEvent = { id: crypto.randomUUID(), type, account, at: now(), data, adminOnly }
    this.emit('event', ev)
  }
}

export const WEBHOOK_EVENTS = ['message.received', 'message.sent', 'message.edited', 'message.reaction', 'message.transcribed', 'button.pressed', 'chat.member', 'connection.update', 'profile.update'] as const

const RETRY_DELAYS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 3600_000, 12 * 3600_000]

type Hook = { id: string; url: string; events: string; account_id: string | null; secret: string; active: number; headers?: string | null }

// headers TeleOps sets itself: a webhook cannot replace them
const OWN_HEADERS = new Set(['content-type', 'content-length', 'host', 'connection', 'transfer-encoding', 'x-teleops-event', 'x-teleops-bot', 'x-teleops-delivery', 'x-teleops-timestamp', 'x-teleops-signature'])
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/

/**
 * Extra request headers of a webhook, written the way receivers show them:
 * a key alone (`crsr_…` → `Authorization: Bearer crsr_…`), `Bearer <key>`, or header lines `Name: value`
 * (e.g. the whole `Authorization: Bearer <key>` line Cursor / Grok Bot automations copy). An object works too.
 */
export function parseHookHeaders(input: string | Record<string, string> | null | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  const add = (n: string, v: string) => {
    const name = n.trim()
    const value = v.trim()
    if (!HEADER_NAME.test(name)) throw new AppError('BAD_HEADER', 'Not a valid header name: {0}', 400, [name.slice(0, 40)])
    if (OWN_HEADERS.has(name.toLowerCase())) throw new AppError('BAD_HEADER', 'TeleOps sets the header {0} itself', 400, [name])
    if (!value || value.length > 4096 || /[\r\n\0]/.test(value)) throw new AppError('BAD_HEADER', 'The value of the header {0} is empty or not valid', 400, [name])
    for (const k of Object.keys(out)) if (k.toLowerCase() === name.toLowerCase()) delete out[k]
    out[name] = value
  }
  if (input == null) return out
  let src: string | Record<string, string> = input
  if (typeof src === 'string' && src.trim().startsWith('{')) {
    try {
      src = JSON.parse(src) as Record<string, string>
    } catch {
      throw new AppError('BAD_HEADER', 'Paste the key, or the header as "Name: value" (one per line)', 400)
    }
  }
  if (typeof src === 'object') {
    for (const [k, v] of Object.entries(src)) add(k, String(v))
    if (Object.keys(out).length > 10) throw new AppError('BAD_HEADER', 'At most 10 extra headers', 400)
    return out
  }
  for (const raw of src.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    const h = line.match(/^([A-Za-z0-9!#$%&'*+.^_`|~-]+)\s*:\s*(.+)$/)
    const scheme = line.match(/^(bearer|basic|token)\s+(\S+)$/i)
    if (scheme) add('Authorization', `${scheme[1][0].toUpperCase()}${scheme[1].slice(1).toLowerCase()} ${scheme[2]}`)
    else if (h) add(h[1], h[2])
    else if (/^\S+$/.test(line)) add('Authorization', `Bearer ${line}`)
    else throw new AppError('BAD_HEADER', 'Paste the key, or the header as "Name: value" (one per line)', 400)
  }
  if (Object.keys(out).length > 10) throw new AppError('BAD_HEADER', 'At most 10 extra headers', 400)
  return out
}

/** Header values are secrets: shown as `Bearer crsr_95d8…`. */
export function maskHookHeaders(stored: string | null | undefined): Record<string, string> {
  let h: Record<string, string> = {}
  try {
    h = stored ? (JSON.parse(stored) as Record<string, string>) : {}
  } catch {
    /* nothing */
  }
  const mask = (v: string) => {
    const m = v.match(/^(\S+)\s+(\S.*)$/)
    const [pre, tok] = m ? [`${m[1]} `, m[2]] : ['', v]
    return pre + (tok.length > 12 ? `${tok.slice(0, 8)}…` : '…')
  }
  return Object.fromEntries(Object.entries(h).map(([k, v]) => [k, mask(String(v))]))
}

/** One line in plain words: agents (Cursor / Grok Bot automations read `context`) see at once what happened. */
export function describeEvent(ev: Pick<BusEvent, 'type' | 'account' | 'data'>, botName?: string | null, kind?: string | null): string {
  type D = {
    chat?: string
    chatName?: string | null
    chatType?: string | null
    senderName?: string | null
    senderUsername?: string | null
    text?: string | null
    type?: string
    hasMedia?: boolean
    state?: string
    fromMe?: boolean
    seconds?: number | null
    voiceNote?: boolean
    transcript?: string | null
    reason?: string
    data?: string | null
    label?: string | null
    reactions?: string[]
    fromName?: string | null
    removed?: boolean
    bot?: boolean
    status?: string
    oldStatus?: string
    memberName?: string | null
    byName?: string | null
    name?: string | null
  }
  const d = (ev.data ?? {}) as D
  // a Telegram account is a person, not a bot
  const noun = kind === 'user' ? 'Telegram account' : 'bot'
  const on = botName ? `${botName} (${noun} ${ev.account})` : `${noun} ${ev.account}`
  const who = [d.senderName, d.senderUsername ? '@' + d.senderUsername : null].filter(Boolean).join(' ') || 'unknown'
  const where = d.chatType && d.chatType !== 'private' ? ` in the ${d.chatType === 'channel' ? 'channel' : 'group'} "${d.chatName ?? d.chat}"` : ''
  const cut = (t: string, n: number) => (t.length > n ? `${t.slice(0, n)}…` : t)
  if ((ev.type === 'message.received' || ev.type === 'message.sent') && (d.type === 'voice' || d.type === 'audio')) {
    const what = `${d.type === 'voice' ? 'Voice' : 'Audio'} message${d.seconds ? ` (${d.seconds} s)` : ''}`
    const next = ' — the text follows in message.transcribed when transcription is on, or call telegram_transcribe_voice'
    return ev.type === 'message.received' ? `${what} received by ${on} from ${who}${where}${next}` : `${what} sent by ${on}${where}${next}`
  }
  if (ev.type === 'message.received' || ev.type === 'message.sent' || ev.type === 'message.edited') {
    const body = d.text ? `: ${cut(d.text, 1500)}` : d.hasMedia ? ` (${d.type ?? 'media'} without text)` : ''
    if (ev.type === 'message.sent') return `Telegram message sent by ${on} to ${d.chatName ?? d.chat}${body}`
    return `Telegram message ${ev.type === 'message.edited' ? 'edited' : 'received'} by ${on} from ${who}${where}${body}`
  }
  if (ev.type === 'message.transcribed') {
    const len = d.seconds ? ` (${d.seconds} s)` : ''
    const said = d.transcript ? `: ${cut(d.transcript, 3000)}` : ' (no words)'
    return d.fromMe ? `Voice message${len} sent by ${on}${where}, transcribed${said}` : `Voice message${len} received by ${on} from ${who}${where}, transcribed${said}`
  }
  if (ev.type === 'button.pressed') return `Button "${d.label ?? d.data ?? '?'}" pressed by ${who} on a message of ${on}${where}${d.data && d.data !== d.label ? ` (data: ${d.data})` : ''}`
  if (ev.type === 'message.reaction') return d.removed ? `Reaction taken back by ${d.fromName ?? 'someone'} on a message of ${on} in "${d.chatName ?? d.chat}"` : `Reaction ${(d.reactions ?? []).join(' ')} by ${d.fromName ?? 'someone'} on a message of ${on} in "${d.chatName ?? d.chat}"`
  if (ev.type === 'chat.member') {
    const chat = `"${d.chatName ?? d.chat}"`
    if (d.bot) {
      if (d.chatType === 'private') return d.status === 'kicked' ? `${d.byName ?? 'Someone'} blocked ${on}` : `${d.byName ?? 'Someone'} unblocked ${on}`
      if (d.status === 'left' || d.status === 'kicked') return `${on} was removed from ${chat} by ${d.byName ?? 'someone'}`
      return `${on} is now ${d.status} of ${chat} (was ${d.oldStatus}), changed by ${d.byName ?? 'someone'}`
    }
    return `${d.memberName ?? 'A member'} is now ${d.status} in ${chat} (was ${d.oldStatus})`
  }
  if (ev.type === 'webhook.test') return `Test event from TeleOps (${on}): the webhook works.`
  if (ev.type === 'connection.update') return `Telegram ${on}: connection ${d.state ?? 'changed'}${d.reason ? ` — ${d.reason}` : ''}`
  if (ev.type === 'profile.update') return `Telegram ${on}: profile changed${d.name ? ` (name ${d.name})` : ''}`
  return `TeleOps event ${ev.type} on ${on}`
}

export function signPayload(secret: string, ts: string, body: string): string {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex')
}

/**
 * WEBHOOK_ALLOW_CHATS — if unset, every matching webhook event is forwarded (default).
 * If set, even to an empty string, only events whose chat is in the list are forwarded.
 * An empty list forwards nothing; messages are still stored in the database.
 * Entries are comma or whitespace separated chat ids (`123456789`, `-1001234567890`) or @usernames.
 */
export function parseWebhookAllowChats(raw: string | undefined): Set<string> | null {
  if (raw === undefined) return null
  const allow = new Set<string>()
  for (const part of raw.split(/[,\s]+/)) {
    const t = part.trim().toLowerCase()
    if (t) allow.add(t.startsWith('@') ? t : t.replace(/^\+/, ''))
  }
  return allow
}

export function webhookEventChat(data: unknown): string | null {
  if (!data || typeof data !== 'object') return null
  const chat = (data as { chat?: unknown }).chat
  return typeof chat === 'string' && chat ? chat : null
}

/** null allowlist = no filter (forward all). Empty set = forward nothing. */
export function isWebhookEventAllowed(ev: Pick<BusEvent, 'data'>, allow: Set<string> | null, chatUsername?: string | null): boolean {
  if (allow === null) return true
  if (allow.size === 0) return false
  const chat = webhookEventChat(ev.data)
  if (!chat) return false
  if (allow.has(chat.toLowerCase())) return true
  return !!chatUsername && allow.has('@' + chatUsername.toLowerCase())
}

function describeAllowlist(allow: Set<string> | null): string {
  if (allow === null) return 'webhook allowlist off (all events forwarded)'
  if (allow.size === 0) return 'webhook allowlist empty: no events forwarded'
  return `webhook allowlist on (${allow.size} chats)`
}

/** Delivers bus events to registered webhooks (HMAC-SHA256 signed, retried with backoff). */
export class WebhookDispatcher {
  private hooks: Hook[] = []

  constructor(
    private h: DbHandle,
    private bus: EventBus,
    private allowChats: Set<string> | null = parseWebhookAllowChats(process.env.WEBHOOK_ALLOW_CHATS),
    private names: { botName(id: string): string | null; botKind?(id: string): string | null; chatUsername(bot: string, chat: string): Promise<string | null> } = { botName: () => null, chatUsername: async () => null },
  ) {}

  async start(): Promise<void> {
    await this.reload()
    logger.info(describeAllowlist(this.allowChats))
    this.bus.on('event', (ev: BusEvent) => void this.route(ev))
  }

  private async route(ev: BusEvent): Promise<void> {
    if (ev.adminOnly) return
    const chat = webhookEventChat(ev.data)
    const username = this.allowChats?.size && chat ? await this.names.chatUsername(ev.account, chat).catch(() => null) : null
    if (!isWebhookEventAllowed(ev, this.allowChats, username)) {
      logger.debug({ type: ev.type, chat }, 'webhook skipped (allowlist)')
      return
    }
    for (const hk of this.hooks) {
      if (!hk.active) continue
      if (hk.account_id && hk.account_id !== '*' && hk.account_id !== ev.account) continue
      const evs = (hk.events || '*').split(',').map((s) => s.trim())
      if (!evs.includes('*') && !evs.includes(ev.type)) continue
      void this.deliver(hk, ev, 0, crypto.randomUUID())
    }
  }

  /** Bot names for the `context` line, chat usernames for the allowlist (set at start). */
  setNames(names: { botName(id: string): string | null; botKind?(id: string): string | null; chatUsername(bot: string, chat: string): Promise<string | null> }) {
    this.names = names
  }

  /** Send a test event to this webhook only (whatever its events), once, and say how it went. */
  async deliverTest(id: string, account: string): Promise<{ ok: boolean; status: number; error: string | null }> {
    await this.reload()
    const hk = this.hooks.find((h) => h.id === id)
    if (!hk) throw new AppError('NOT_FOUND', 'webhook not found', 404)
    const ev: BusEvent = { id: crypto.randomUUID(), type: 'webhook.test', account: hk.account_id && hk.account_id !== '*' ? hk.account_id : account, at: now(), data: { test: true } }
    return this.deliver(hk, ev, 0, crypto.randomUUID(), false)
  }

  async reload(): Promise<void> {
    this.hooks = (await this.h.db.selectFrom('webhooks').selectAll().execute()) as Hook[]
  }

  private async deliver(hk: Hook, ev: BusEvent, attempt: number, deliveryId: string, retry = true): Promise<{ ok: boolean; status: number; error: string | null }> {
    const body = JSON.stringify({ id: ev.id, type: ev.type, bot: ev.account, at: new Date(ev.at).toISOString(), context: describeEvent(ev, this.names.botName(ev.account), this.names.botKind?.(ev.account)), data: ev.data })
    const ts = String(Math.floor(Date.now() / 1000))
    let status = 0
    let error: string | null = null
    let extra: Record<string, string> = {}
    try {
      extra = hk.headers ? (JSON.parse(hk.headers) as Record<string, string>) : {}
    } catch {
      /* stored by us: always JSON */
    }
    try {
      const res = await fetch(hk.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'user-agent': 'teleops-webhook/1',
          ...extra,
          'x-teleops-event': ev.type,
          'x-teleops-bot': ev.account,
          'x-teleops-delivery': deliveryId,
          'x-teleops-timestamp': ts,
          'x-teleops-signature': signPayload(hk.secret, ts, body),
        },
        body,
        signal: AbortSignal.timeout(10_000),
      })
      status = res.status
      if (!res.ok) error = `HTTP ${res.status}`
    } catch (e) {
      error = String((e as Error).message ?? e).slice(0, 300)
    }
    const ok = !error
    const willRetry = retry && !ok && attempt < RETRY_DELAYS.length
    try {
      await upsert(
        this.h,
        'webhook_deliveries',
        {
          id: deliveryId,
          webhook_id: hk.id,
          event: ev.type,
          state: ok ? 'delivered' : willRetry ? 'retrying' : 'failed',
          attempts: attempt + 1,
          last_status: status,
          last_error: error,
          created_at: ev.at,
          updated_at: now(),
        },
        ['id'],
      )
    } catch (e) {
      logger.warn({ err: String(e) }, 'webhook log failed')
    }
    if (willRetry) {
      const t = setTimeout(() => void this.deliver(hk, ev, attempt + 1, deliveryId), RETRY_DELAYS[attempt])
      t.unref()
    }
    return { ok, status, error }
  }

  async prune(): Promise<void> {
    const cutoff = now() - 7 * 86400_000
    await this.h.db.deleteFrom('webhook_deliveries').where('created_at', '<', cutoff).execute()
  }
}
