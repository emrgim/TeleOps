import sharp from 'sharp'
import { now, type DbHandle } from '../db/index.js'
import type { EventBus } from '../events.js'
import { logger } from '../log.js'
import type { Settings } from '../settings.js'
import { AppError, sleep } from '../util.js'
import { BotApi, TgApiError, type Upload } from './api.js'
import { TgStore, chatTitle, fullName, isGroupType, type Media, type MessageRow } from './store.js'
import {
  ALLOWED_UPDATES,
  type TgBotCommand,
  type TgBotInfo,
  type TgCallbackQuery,
  type TgChatMemberUpdated,
  type TgFile,
  type TgMessage,
  type TgMessageReactionUpdated,
  type TgUpdate,
} from './types.js'

export type AccountRow = {
  id: string
  label: string | null
  username: string | null
  token: string | null
  enabled: number
  is_default: number
  me: string | null
  status: string | null
  update_offset: number | null
  created_at: number
  updated_at: number
}

export type AccountState = 'stopped' | 'not_linked' | 'connecting' | 'open' | 'reconnecting' | 'conflict' | 'unauthorized' | 'error'

export type Ctx = {
  h: DbHandle
  bus: EventBus
  settings: Settings
  /** `/start <param>` in a private chat: true = handled by TeleOps itself (not stored, no event). */
  onStart?: (acc: BotAccount, m: TgMessage, param: string) => Promise<boolean>
}

/** The bot's profile on Telegram (the name is in `accounts`). */
export type ProfileRow = {
  account_id: string
  about: string | null
  description: string | null
  commands: string | null
  photo: string | null
  photo_type: string | null
  photo_id: string | null
  updated_at: number | null
}

const POLL_TIMEOUT = 50
const PROFILE_EVERY = 10 * 60_000
const PHOTO_EVERY = 60 * 60_000
const SEND_METHODS = new Set(['sendMessage', 'sendPhoto', 'sendVideo', 'sendAudio', 'sendVoice', 'sendDocument', 'sendSticker', 'sendAnimation', 'sendVideoNote', 'sendLocation', 'sendVenue', 'sendContact', 'sendPoll', 'sendDice', 'forwardMessage', 'copyMessage', 'sendMediaGroup'])

// ------------------------------------------------------------------ rate limit
class SendLimiter {
  private tokens: number
  private last = Date.now()
  private chains = new Map<string, Promise<unknown>>()
  constructor(private settings: Settings) {
    this.tokens = settings.get().ratePerMin
  }
  private refill() {
    const rate = this.settings.get().ratePerMin
    const t = Date.now()
    this.tokens = Math.min(rate, this.tokens + ((t - this.last) / 60_000) * rate)
    this.last = t
  }
  private async take() {
    for (;;) {
      this.refill()
      if (this.tokens >= 1) {
        this.tokens -= 1
        return
      }
      const rate = this.settings.get().ratePerMin
      await sleep(Math.ceil(((1 - this.tokens) * 60_000) / rate))
    }
  }
  pending(): number {
    return this.chains.size
  }
  run<T>(chat: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(chat) ?? Promise.resolve()
    const p = prev
      .catch(() => undefined)
      .then(async () => {
        await this.take()
        try {
          return await fn()
        } finally {
          await sleep(this.settings.get().perChatGapMs)
        }
      })
    const tail = p.catch(() => undefined)
    this.chains.set(chat, tail)
    void tail.then(() => {
      if (this.chains.get(chat) === tail) this.chains.delete(chat)
    })
    return p
  }
}

/** Telegram answers in English: the reason of a failure, kept short. */
export function tgReason(e: unknown): string {
  if (e instanceof TgApiError) return `${e.code} ${e.description}`
  return String((e as Error)?.message ?? e).slice(0, 300)
}

// ------------------------------------------------------------------ account (one bot)
export class BotAccount {
  state: AccountState = 'stopped'
  since = now()
  lastError?: { code: number | undefined; reason: string; at: number }
  readonly store: TgStore
  readonly limiter: SendLimiter
  me: TgBotInfo | null = null
  private api_?: BotApi
  private stopping = false
  private generation = 0
  private abort?: AbortController
  private offset = 0
  private profileCache: ProfileRow | null = null

  constructor(
    public row: AccountRow,
    private ctx: Ctx,
  ) {
    this.store = new TgStore(ctx.h, row.id, () => this.row.id)
    this.limiter = new SendLimiter(ctx.settings)
    this.offset = Number(row.update_offset ?? 0) || 0
    try {
      this.me = row.me ? (JSON.parse(row.me) as TgBotInfo) : null
    } catch {
      this.me = null
    }
    void this.loadProfile().catch(() => undefined)
  }

  get id(): string {
    return this.row.id
  }

  get api(): BotApi | undefined {
    if (!this.row.token) return undefined
    if (!this.api_) this.api_ = new BotApi(this.row.token)
    return this.api_
  }

  /** New token for the same bot (after /revoke in @BotFather). */
  setToken(token: string) {
    this.row.token = token
    this.api_ = undefined
  }

  displayName(): string {
    return this.row.label || this.me?.first_name || (this.row.username ? '@' + this.row.username : this.row.id)
  }

  link(): string | null {
    return this.row.username ? `https://t.me/${this.row.username}` : null
  }

  status() {
    return {
      id: this.row.id,
      name: this.displayName(),
      username: this.row.username,
      link: this.link(),
      about: this.profileCache?.about ?? null,
      photo: !!this.profileCache?.photo,
      state: this.state,
      since: new Date(this.since).toISOString(),
      enabled: !!this.row.enabled,
      default: !!this.row.is_default,
      // privacy mode on: in groups the bot gets only commands, replies to it and mentions
      readsAllGroupMessages: this.me ? !!this.me.can_read_all_group_messages : null,
      canJoinGroups: this.me ? this.me.can_join_groups !== false : null,
      lastError: this.lastError ? { ...this.lastError, at: new Date(this.lastError.at).toISOString() } : null,
      queue: { pendingChats: this.limiter.pending() },
    }
  }

  private setState(s: AccountState, extra: Record<string, unknown> = {}) {
    if (this.state === s && !Object.keys(extra).length) return
    this.state = s
    this.since = now()
    void this.ctx.h.db.updateTable('accounts').set({ status: s, updated_at: now() }).where('id', '=', this.row.id).execute().catch(() => undefined)
    this.ctx.bus.publish('connection.update', this.row.id, { state: s, ...extra })
  }

  private alive(gen: number): boolean {
    return gen === this.generation && !this.stopping
  }

  // ---------------------------------------------------------------- start / stop / poll
  /** Read the bot's identity and start reading its updates (long polling). `takeOver` removes a webhook first. */
  async start(o: { takeOver?: boolean } = {}): Promise<void> {
    await this.stop(false)
    this.stopping = false
    const api = this.api
    if (!api) {
      this.setState('not_linked')
      return
    }
    const gen = ++this.generation
    this.abort = new AbortController()
    this.setState('connecting')
    try {
      await this.readMe()
      if (o.takeOver) {
        await api.call('deleteWebhook', { drop_pending_updates: false })
        logger.info({ account: this.id }, 'webhook removed: TeleOps reads the updates of this bot now')
      }
    } catch (e) {
      if (!this.alive(gen)) return
      if (this.fatal(e)) return
      this.lastError = { code: e instanceof TgApiError ? e.code : undefined, reason: tgReason(e), at: now() }
      this.setState('reconnecting', { reason: this.lastError.reason })
      setTimeout(() => {
        if (this.alive(gen)) void this.start(o).catch((err) => logger.error({ account: this.id, err: String(err) }, 'bot start failed'))
      }, 15_000).unref()
      return
    }
    void this.pollLoop(gen)
  }

  /** A failure that stopping and retrying will not fix: invalid token, another reader. */
  private fatal(e: unknown): boolean {
    if (!(e instanceof TgApiError)) return false
    if (e.code === 401 || e.code === 404) {
      this.lastError = { code: e.code, reason: 'The token is not valid any more (revoked or replaced in @BotFather): link the bot again with its new token', at: now() }
      this.setState('unauthorized', { reason: this.lastError.reason })
      return true
    }
    if (e.code === 409) {
      const webhook = /webhook/i.test(e.description)
      this.lastError = {
        code: e.code,
        reason: webhook ? 'This bot sends its updates to a webhook of another program: take it over to read them here' : 'Another program is reading the updates of this bot (one reader per bot): stop it, then restart here',
        at: now(),
      }
      this.setState('conflict', { reason: this.lastError.reason, webhook })
      return true
    }
    return false
  }

  private async pollLoop(gen: number): Promise<void> {
    let failures = 0
    let opened = false
    while (this.alive(gen)) {
      const api = this.api
      if (!api) return
      try {
        const updates = await api.call<TgUpdate[]>('getUpdates', { offset: this.offset || undefined, timeout: POLL_TIMEOUT, allowed_updates: ALLOWED_UPDATES }, { signal: this.abort?.signal, timeoutMs: (POLL_TIMEOUT + 20) * 1000 })
        if (!this.alive(gen)) return
        failures = 0
        if (this.state !== 'open') {
          this.lastError = undefined
          this.setState('open', { username: this.row.username })
        }
        if (!opened) {
          opened = true
          this.onOpen(gen)
        }
        for (const u of updates) {
          try {
            await this.handle(u)
          } catch (e) {
            logger.error({ account: this.id, update: u.update_id, err: api.scrub(String((e as Error)?.stack ?? e)) }, 'update processing failed')
          }
          this.offset = u.update_id + 1
        }
        if (updates.length) await this.ctx.h.db.updateTable('accounts').set({ update_offset: this.offset }).where('id', '=', this.id).execute()
      } catch (e) {
        if (!this.alive(gen)) return
        if ((e as Error)?.name === 'AbortError') return
        if (this.fatal(e)) return
        if (e instanceof TgApiError && e.code === 429) {
          await this.pause((e.retryAfter ?? 5) * 1000, gen)
          continue
        }
        failures++
        const delay = Math.min(60_000, 1000 * 2 ** Math.min(failures, 6)) + Math.floor(Math.random() * 1000)
        this.lastError = { code: e instanceof TgApiError ? e.code : undefined, reason: tgReason(e), at: now() }
        if (failures >= 2) this.setState('reconnecting', { inMs: delay, reason: this.lastError.reason })
        logger.warn({ account: this.id, reason: this.lastError.reason, inMs: delay }, 'getUpdates failed')
        await this.pause(delay, gen)
      }
    }
  }

  private pause(ms: number, gen: number): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(resolve, ms)
      t.unref?.()
      this.abort?.signal.addEventListener('abort', () => {
        clearTimeout(t)
        resolve()
      })
      if (!this.alive(gen)) {
        clearTimeout(t)
        resolve()
      }
    })
  }

  /** Connected: read the profile now and then every 10 minutes (the photo every hour). */
  private onOpen(gen: number) {
    let n = 0
    const refresh = () => {
      if (!this.alive(gen)) return
      void this.refreshProfile(n++ % (PHOTO_EVERY / PROFILE_EVERY) === 0).catch((e) => logger.debug({ account: this.id, err: tgReason(e) }, 'profile refresh failed'))
      setTimeout(refresh, PROFILE_EVERY).unref()
    }
    setTimeout(refresh, 1500).unref()
  }

  async stop(publish = true): Promise<void> {
    this.stopping = true
    this.generation++
    this.abort?.abort()
    this.abort = undefined
    if (publish) this.setState('stopped')
  }

  // ---------------------------------------------------------------- updates
  private async handle(u: TgUpdate): Promise<void> {
    if (u.message) return this.onMessage(u.message)
    if (u.channel_post) return this.onMessage(u.channel_post)
    if (u.edited_message) return this.onEdited(u.edited_message)
    if (u.edited_channel_post) return this.onEdited(u.edited_channel_post)
    if (u.callback_query) return this.onCallback(u.callback_query)
    if (u.my_chat_member) return this.onMember(u.my_chat_member, true)
    if (u.chat_member) return this.onMember(u.chat_member, false)
    if (u.message_reaction) return this.onReaction(u.message_reaction)
  }

  private isMine(m: TgMessage): boolean {
    return !m.sender_chat && String(m.from?.id ?? '') === this.id
  }

  private async onMessage(m: TgMessage): Promise<void> {
    if (m.chat.type === 'private' && typeof m.text === 'string' && /^\/start(@\S+)?\s+\S/.test(m.text) && this.ctx.onStart) {
      const param = m.text.replace(/^\/start(@\S+)?\s+/, '').trim()
      if (await this.ctx.onStart(this, m, param).catch(() => false)) return
    }
    const rows = await this.store.upsertMessages([{ m, fromMe: this.isMine(m) }])
    if (m.migrate_to_chat_id) await this.store.migrateChat(String(m.chat.id), String(m.migrate_to_chat_id))
    for (const r of rows) this.ctx.bus.publish(r.from_me ? 'message.sent' : 'message.received', this.id, await this.summarize(r))
  }

  private async onEdited(m: TgMessage): Promise<void> {
    const rows = await this.store.upsertMessages([{ m, fromMe: this.isMine(m) }])
    for (const r of rows) this.ctx.bus.publish('message.edited', this.id, await this.summarize(r))
  }

  /** A button of a message was pressed: stop the spinner on the phone, keep it as a message of the chat, tell webhooks. */
  private async onCallback(q: TgCallbackQuery): Promise<void> {
    void this.api?.call('answerCallbackQuery', { callback_query_id: q.id }).catch((e) => logger.debug({ account: this.id, err: tgReason(e) }, 'answerCallbackQuery failed'))
    await this.store.upsertUsers([q.from])
    const msg = q.message as (TgMessage & { reply_markup?: { inline_keyboard?: { text: string; callback_data?: string }[][] } }) | undefined
    const label = msg?.reply_markup?.inline_keyboard?.flat().find((b) => b.callback_data === q.data)?.text ?? null
    let row: MessageRow | null = null
    if (msg?.chat) {
      const chat = String(msg.chat.id)
      row = {
        account_id: this.id,
        chat_id: chat,
        id: `btn:${q.id}`,
        seq: msg.message_id,
        from_me: 0,
        sender: String(q.from.id),
        ts: Math.floor(now() / 1000),
        type: 'button',
        text: `[button] ${label ?? q.data ?? ''}${label && q.data && label !== q.data ? ` (${q.data})` : ''}`.trim(),
        edited_at: null,
        reply_to: String(msg.message_id),
        thread_id: null,
        media: null,
        reactions: null,
        raw: JSON.stringify(q).slice(0, 50_000),
      }
      await this.ctx.h.db.insertInto('messages').values(row).execute()
      await this.store.upsertChat(msg.chat, { ts: row.ts })
    }
    this.ctx.bus.publish('button.pressed', this.id, {
      ...(row ? await this.summarize(row) : {}),
      data: q.data ?? null,
      label,
      messageId: msg ? String(msg.message_id) : null,
      inlineMessageId: q.inline_message_id ?? null,
      sender: String(q.from.id),
      senderName: fullName(q.from),
      senderUsername: q.from.username ?? null,
    })
  }

  /** Someone added / removed / blocked the bot (mine), or another member changed (needs admin rights). */
  private async onMember(u: TgChatMemberUpdated, mine: boolean): Promise<void> {
    const status = u.new_chat_member.status
    await this.store.upsertUsers([u.from, u.new_chat_member.user])
    if (mine) await this.store.upsertChat(u.chat, { member: status, ts: u.date })
    else await this.store.upsertChat(u.chat, { touch: false })
    const who = u.new_chat_member.user
    this.ctx.bus.publish('chat.member', this.id, {
      chat: String(u.chat.id),
      chatName: chatTitle(u.chat),
      chatType: u.chat.type,
      bot: mine,
      member: String(who.id),
      memberName: fullName(who),
      memberUsername: who.username ?? null,
      status,
      oldStatus: u.old_chat_member.status,
      by: String(u.from.id),
      byName: fullName(u.from),
      at: new Date(u.date * 1000).toISOString(),
    })
    if (mine) logger.info({ account: this.id, chat: u.chat.id, type: u.chat.type, status, old: u.old_chat_member.status }, 'bot membership changed')
  }

  private async onReaction(r: TgMessageReactionUpdated): Promise<void> {
    const chat = String(r.chat.id)
    const who = r.user ? String(r.user.id) : r.actor_chat ? String(r.actor_chat.id) : 'anonymous'
    if (r.user) await this.store.upsertUsers([r.user])
    const emojis = r.new_reaction.map((x) => (x.type === 'emoji' ? (x as { emoji: string }).emoji : x.type === 'custom_emoji' ? 'custom' : x.type))
    await this.store.setReactions(chat, String(r.message_id), who, emojis)
    this.ctx.bus.publish('message.reaction', this.id, {
      chat,
      chatName: chatTitle(r.chat),
      messageId: String(r.message_id),
      from: who,
      fromName: r.user ? fullName(r.user) : r.actor_chat ? chatTitle(r.actor_chat) : null,
      reactions: emojis,
      removed: !emojis.length,
      at: new Date(r.date * 1000).toISOString(),
    })
  }

  // ---------------------------------------------------------------- calls
  requireApi(): BotApi {
    const api = this.api
    if (!api || !this.row.enabled || ['not_linked', 'unauthorized', 'stopped'].includes(this.state)) {
      throw new AppError('NOT_CONNECTED', 'Bot "{0}" is not connected (state: {1})', 409, [this.displayName(), this.state])
    }
    return api
  }

  /** Any Bot API method, with Telegram's errors turned into readable ones. */
  async call<T>(method: string, params: Record<string, unknown> = {}, files?: Upload[]): Promise<T> {
    const api = this.requireApi()
    try {
      return await api.call<T>(method, params, { files, timeoutMs: files?.length ? 300_000 : 60_000 })
    } catch (e) {
      throw this.asAppError(e)
    }
  }

  asAppError(e: unknown): Error {
    if (!(e instanceof TgApiError)) return e as Error
    // 404 is also Telegram's answer to an unknown method: only the bot's own calls say the token is gone
    if (e.code === 401 || (e.code === 404 && ['getMe', 'getUpdates'].includes(e.method))) void this.fatal(e)
    const d = e.description
    if (/bot was blocked by the user/i.test(d)) return new AppError('BLOCKED', 'This person blocked the bot', 403)
    if (/bot can't initiate conversation|have no rights to send|not enough rights|chat_write_forbidden/i.test(d)) return new AppError('CANNOT_WRITE', 'The bot cannot write in this chat: the person must start the bot first, or the bot lacks the rights in the group ({0})', 403, [d])
    if (/chat not found/i.test(d)) return new AppError('CHAT_NOT_FOUND', 'Telegram does not know this chat, or the bot is not in it', 404)
    if (/message to (edit|delete|react|forward|copy|pin) not found|message not found|message_id_invalid/i.test(d)) return new AppError('MESSAGE_NOT_FOUND', 'Telegram does not find this message any more', 404)
    if (/message can't be (edited|deleted)/i.test(d)) return new AppError('NOT_ALLOWED', 'Telegram does not allow this on this message: {0}', 403, [d])
    if (/message is not modified/i.test(d)) return new AppError('NOT_MODIFIED', 'Nothing changes: the message already looks like that', 400)
    if (/kicked from|not a member/i.test(d)) return new AppError('NOT_A_MEMBER', 'The bot is not a member of this chat any more', 403)
    if (/can't parse entities/i.test(d)) return new AppError('BAD_FORMATTING', 'Formatting error in the text: {0}', 400, [d])
    if (e.code === 429) return new AppError('FLOOD_WAIT', 'Telegram asks to slow down: try again in {0} seconds', 429, [e.retryAfter ?? 5])
    return new AppError('TELEGRAM_ERROR', 'Telegram refused: {0}', e.code >= 500 ? 502 : 400, [`${e.code} ${d}`])
  }

  /**
   * Send something to a chat (one at a time per chat, within the rate limit). Flood waits are waited out,
   * a group that became a supergroup is followed. The sent message is stored and announced as message.sent.
   */
  async send(chatId: string, method: string, params: Record<string, unknown>, o: { files?: Upload[]; store?: boolean } = {}): Promise<TgMessage> {
    let chat = chatId
    return this.limiter.run(chat, async () => {
      for (let attempt = 0; ; attempt++) {
        const api = this.requireApi()
        try {
          const res = await api.call<TgMessage | TgMessage[] | { message_id: number }>(method, { ...params, chat_id: /^-?\d+$/.test(chat) ? Number(chat) : chat }, { files: o.files, timeoutMs: o.files?.length ? 300_000 : 60_000 })
          const list = Array.isArray(res) ? res : [res]
          const raw = list[0] as TgMessage | { message_id: number }
          // copyMessage answers only with the new id
          const first: TgMessage =
            raw && !('chat' in raw)
              ? { message_id: raw.message_id, date: Math.floor(now() / 1000), chat: { id: Number(chat), type: (await this.store.chat(chat))?.type ?? 'private' }, from: { id: Number(this.id), is_bot: true, first_name: this.displayName() }, text: '[copied message]' }
              : (raw as TgMessage)
          if (o.store !== false && SEND_METHODS.has(method)) {
            const msgs = (Array.isArray(res) ? (res as TgMessage[]) : [first]).filter((m) => m && 'chat' in m)
            const rows = await this.store.upsertMessages(msgs.map((m) => ({ m, fromMe: true })))
            for (const r of rows) this.ctx.bus.publish('message.sent', this.id, await this.summarize(r))
          }
          return first
        } catch (e) {
          if (e instanceof TgApiError && e.code === 429 && attempt < 3 && (e.retryAfter ?? 5) <= 120) {
            logger.info({ account: this.id, retryAfter: e.retryAfter }, 'Telegram flood wait')
            await sleep((e.retryAfter ?? 5) * 1000 + 250)
            continue
          }
          if (e instanceof TgApiError && e.migrateTo && attempt < 3) {
            await this.store.migrateChat(chat, String(e.migrateTo))
            chat = String(e.migrateTo)
            continue
          }
          throw this.asAppError(e)
        }
      }
    })
  }

  // ---------------------------------------------------------------- profile (name · about · description · photo · commands)
  async readMe(): Promise<TgBotInfo> {
    const api = this.api
    if (!api) throw new AppError('NOT_LINKED', 'This bot has no token yet', 409)
    const me = await api.call<TgBotInfo>('getMe')
    const before = this.displayName()
    this.me = me
    const set: Record<string, unknown> = { me: JSON.stringify(me), updated_at: now() }
    if (me.username && me.username !== this.row.username) set.username = this.row.username = me.username
    if (me.first_name && me.first_name !== this.row.label) set.label = this.row.label = me.first_name
    await this.ctx.h.db.updateTable('accounts').set(set).where('id', '=', this.id).execute()
    if (before !== this.displayName() && this.profileCache?.updated_at) {
      logger.info({ account: this.id }, `bot name: ${before} → ${this.displayName()}`)
      this.ctx.bus.publish('profile.update', this.id, { name: this.displayName(), username: this.row.username, about: this.profileCache?.about ?? null })
    }
    return me
  }

  async loadProfile(): Promise<ProfileRow | null> {
    this.profileCache = ((await this.ctx.h.db.selectFrom('profiles').selectAll().where('account_id', '=', this.id).executeTakeFirst()) as ProfileRow | undefined) ?? null
    return this.profileCache
  }

  private async saveProfile(p: Partial<Omit<ProfileRow, 'account_id' | 'updated_at'>>): Promise<void> {
    const cur = this.profileCache ?? (await this.loadProfile()) ?? { account_id: this.id, about: null, description: null, commands: null, photo: null, photo_type: null, photo_id: null, updated_at: null }
    const next: ProfileRow = { ...cur, ...p, account_id: this.id, updated_at: now() }
    const changed = next.about !== cur.about || next.description !== cur.description || next.photo_id !== cur.photo_id || next.commands !== cur.commands
    await this.ctx.h.db.deleteFrom('profiles').where('account_id', '=', this.id).execute()
    await this.ctx.h.db.insertInto('profiles').values(next).execute()
    this.profileCache = next
    if (changed && cur.updated_at) this.ctx.bus.publish('profile.update', this.id, { name: this.displayName(), username: this.row.username, about: next.about, photo: !!next.photo })
  }

  /** Read name, descriptions, commands and (optionally) the photo from Telegram. */
  async refreshProfile(withPhoto = true): Promise<ProfileRow | null> {
    const api = this.requireApi()
    await this.readMe()
    const [about, description, commands] = await Promise.all([
      api.call<{ short_description: string }>('getMyShortDescription').catch(() => null),
      api.call<{ description: string }>('getMyDescription').catch(() => null),
      api.call<TgBotCommand[]>('getMyCommands').catch(() => null),
    ])
    const patch: Partial<ProfileRow> = {}
    if (about) patch.about = about.short_description || null
    if (description) patch.description = description.description || null
    if (commands) patch.commands = commands.length ? JSON.stringify(commands) : null
    if (withPhoto) {
      try {
        const r = await api.call<{ total_count: number; photos: { file_id: string; file_unique_id: string; width: number; height: number; file_size?: number }[][] }>('getUserProfilePhotos', { user_id: Number(this.id), limit: 1 })
        const sizes = r.photos[0]
        if (!sizes?.length) Object.assign(patch, { photo: null, photo_type: null, photo_id: null })
        else {
          const big = sizes.reduce((a, b) => (b.width > a.width ? b : a))
          if (big.file_unique_id !== this.profileCache?.photo_id) {
            const f = await api.call<TgFile>('getFile', { file_id: big.file_id })
            if (f.file_path) Object.assign(patch, { photo: (await api.download(f.file_path, 10 * 1024 * 1024)).toString('base64'), photo_type: 'image/jpeg', photo_id: big.file_unique_id })
          }
        }
      } catch (e) {
        logger.debug({ account: this.id, err: tgReason(e) }, 'bot photo not read')
      }
    }
    await this.saveProfile(patch)
    return this.profileCache
  }

  async profile() {
    if (!this.profileCache) await this.loadProfile()
    const p = this.profileCache
    let commands: TgBotCommand[] = []
    try {
      commands = p?.commands ? (JSON.parse(p.commands) as TgBotCommand[]) : []
    } catch {
      commands = []
    }
    return {
      id: this.id,
      name: this.displayName(),
      username: this.row.username,
      link: this.link(),
      about: p?.about ?? null,
      description: p?.description ?? null,
      commands,
      photo: !!p?.photo,
      readsAllGroupMessages: this.me ? !!this.me.can_read_all_group_messages : null,
      canJoinGroups: this.me ? this.me.can_join_groups !== false : null,
      updatedAt: p?.updated_at ? new Date(p.updated_at).toISOString() : null,
    }
  }

  photoData(): { data: Buffer; type: string } | null {
    const p = this.profileCache
    return p?.photo ? { data: Buffer.from(p.photo, 'base64'), type: p.photo_type ?? 'image/jpeg' } : null
  }

  /** Change the bot on Telegram itself, so TeleOps and Telegram always show the same. */
  async editProfile(e: { name?: string; about?: string; description?: string; photo?: Buffer | null; commands?: TgBotCommand[]; readAllGroupMessages?: boolean; canJoinGroups?: boolean }) {
    if (e.name !== undefined) {
      const name = e.name.trim()
      if (name.length < 1 || name.length > 64) throw new AppError('PROFILE_NAME', 'The name must be 1–64 characters', 400)
      await this.call('setMyName', { name })
    }
    if (e.about !== undefined) {
      const about = e.about.trim()
      if (about.length > 120) throw new AppError('PROFILE_ABOUT', 'The short description must be at most 120 characters', 400)
      await this.call('setMyShortDescription', { short_description: about })
      await this.saveProfile({ about: about || null })
    }
    if (e.description !== undefined) {
      const d = e.description.trim()
      if (d.length > 512) throw new AppError('PROFILE_DESCRIPTION', 'The description must be at most 512 characters', 400)
      await this.call('setMyDescription', { description: d })
      await this.saveProfile({ description: d || null })
    }
    if (e.commands !== undefined) {
      const list = e.commands.map((c) => ({ command: String(c.command ?? '').trim().replace(/^\//, '').toLowerCase(), description: String(c.description ?? '').trim() }))
      for (const c of list) {
        if (!/^[a-z0-9_]{1,32}$/.test(c.command)) throw new AppError('BAD_COMMAND', 'A command is 1–32 characters: lowercase letters, digits and _ ({0})', 400, [c.command || '?'])
        if (c.description.length < 1 || c.description.length > 256) throw new AppError('BAD_COMMAND', 'Each command needs a description of 1–256 characters ({0})', 400, [c.command])
      }
      if (list.length > 100) throw new AppError('BAD_COMMAND', 'At most 100 commands', 400)
      if (list.length) await this.call('setMyCommands', { commands: list })
      else await this.call('deleteMyCommands')
      await this.saveProfile({ commands: list.length ? JSON.stringify(list) : null })
    }
    if (e.readAllGroupMessages !== undefined || e.canJoinGroups !== undefined) {
      await this.call('setMySettings', { can_read_all_group_messages: e.readAllGroupMessages, can_join_groups: e.canJoinGroups })
    }
    if (e.photo === null) {
      await this.call('removeMyProfilePhoto')
      await this.saveProfile({ photo: null, photo_type: null, photo_id: null })
    } else if (e.photo) {
      let jpeg: Buffer
      try {
        jpeg = await sharp(e.photo).rotate().resize(1024, 1024, { fit: 'cover' }).jpeg({ quality: 90 }).toBuffer()
      } catch {
        throw new AppError('PROFILE_PHOTO', 'The photo is not an image TeleOps can read', 400)
      }
      await this.call('setMyProfilePhoto', { photo: { type: 'static', photo: 'attach://photo' } }, [{ field: 'photo', data: jpeg, fileName: 'photo.jpg', mimetype: 'image/jpeg' }])
    }
    await this.refreshProfile(e.photo !== undefined).catch((err) => logger.warn({ account: this.id, err: tgReason(err) }, 'profile not read back'))
    logger.info({ account: this.id, name: e.name !== undefined, about: e.about !== undefined, description: e.description !== undefined, commands: e.commands?.length, photo: e.photo === undefined ? undefined : e.photo ? 'set' : 'removed' }, 'bot profile edited')
    return this.profile()
  }

  // ---------------------------------------------------------------- output
  /** Tell webhooks and live listeners about a stored message. */
  async announce(type: 'message.sent' | 'message.received', r: MessageRow): Promise<void> {
    this.ctx.bus.publish(type, this.id, await this.summarize(r))
  }

  async summarize(r: MessageRow) {
    const chat = await this.store.chat(r.chat_id)
    let media: Media | null = null
    try {
      media = r.media ? (JSON.parse(r.media) as Media) : null
    } catch {
      media = null
    }
    let reactions: Record<string, string[]> | null = null
    try {
      reactions = r.reactions ? (JSON.parse(r.reactions) as Record<string, string[]>) : null
    } catch {
      reactions = null
    }
    const audio = media && (media.kind === 'voice' || media.kind === 'audio' || media.kind === 'video_note')
    return {
      id: r.id,
      chat: r.chat_id,
      chatName: chat?.title ?? (await this.store.nameOf(r.chat_id)),
      chatType: chat?.type ?? null,
      fromMe: !!r.from_me,
      sender: r.from_me ? 'me' : r.sender,
      senderName: r.from_me ? this.displayName() : await this.store.nameOf(r.sender),
      senderUsername: r.from_me ? this.row.username : await this.store.usernameOf(r.sender),
      timestamp: new Date(Number(r.ts) * 1000).toISOString(),
      ts: Number(r.ts),
      type: r.type,
      text: r.text,
      hasMedia: !!media,
      ...(media ? { media: { kind: media.kind, mimetype: media.mime ?? null, bytes: media.size ?? null, fileName: media.name ?? null, seconds: media.duration ?? null, width: media.width ?? null, height: media.height ?? null } } : {}),
      replyTo: r.reply_to,
      ...(r.thread_id ? { threadId: r.thread_id } : {}),
      edited: !!r.edited_at,
      ...(reactions ? { reactions } : {}),
      ...(audio ? { seconds: media?.duration ?? null, voiceNote: media?.kind === 'voice' } : {}),
    }
  }

  isGroupChat(type: string | null | undefined) {
    return isGroupType(type)
  }
}
