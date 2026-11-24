/**
 * A Telegram user account (a person, not a bot), linked with its phone number or a QR code and reached over
 * MTProto with GramJS. It is a BotAccount for the rest of TeleOps: same store, events, service and MCP tools;
 * the Bot API calls are answered by UserApi.
 *
 * What changes for a person:
 *  - updates come from the MTProto connection (not getUpdates); messages written from the phone are message.sent
 *  - the chat list and recent messages are read from Telegram when the account connects, and what arrived while
 *    TeleOps was off is filled in (and announced if it is recent)
 *  - broadcast channels are not stored (they are news, not conversations), nor the "Telegram" service chat,
 *    where login codes arrive: those never leave Telegram
 */
import os from 'node:os'
import { Api, TelegramClient } from 'telegram'
import { EditedMessage, type EditedMessageEvent } from 'telegram/events/EditedMessage.js'
import { NewMessage, Raw, type NewMessageEvent } from 'telegram/events/index.js'
import { Logger, LogLevel } from 'telegram/extensions/Logger.js'
import { UpdateConnectionState } from 'telegram/network/index.js'
import { StringSession } from 'telegram/sessions/index.js'
import { VERSION } from '../../config.js'
import { now } from '../../db/index.js'
import { logger } from '../../log.js'
import { AppError } from '../../util.js'
import { BotAccount, tgReason, type AccountKind } from '../account.js'
import { TgApiError, type TgCaller } from '../api.js'
import { fullName } from '../store.js'
import type { TgBotInfo, TgMessage } from '../types.js'
import type { TelegramApp } from './app.js'
import { chatOf, entityKey, maskPhone, peerKey, type Entity } from './convert.js'
import { openSession } from './crypt.js'
import { UserApi, toTgError, type UserHost } from './userapi.js'

/** "Telegram" (login codes, security notices): never stored, never announced. */
export const SERVICE_CHAT = '777000'
const SYNC_DIALOGS = 100
const ANNOUNCE_WINDOW = 24 * 3600

/** GramJS writes to the console: its warnings go to the debug log instead. */
class QuietLogger extends Logger {
  log(level: LogLevel, message: string): void {
    if (level === LogLevel.ERROR || level === LogLevel.WARN) logger.debug({ mod: 'mtproto', level }, String(message).slice(0, 500))
  }
}

/** An MTProto client for this installation's Telegram app; it shows as "TeleOps" in Telegram → Devices. */
export function newClient(session: string, app: TelegramApp): TelegramClient {
  return new TelegramClient(new StringSession(session), app.apiId, app.apiHash, {
    connectionRetries: 5,
    retryDelay: 2000,
    autoReconnect: true,
    floodSleepThreshold: 20,
    deviceModel: 'TeleOps',
    systemVersion: `${os.type()} ${os.release()}`.slice(0, 60),
    appVersion: VERSION,
    langCode: 'en',
    systemLangCode: 'en',
    baseLogger: new QuietLogger(LogLevel.WARN),
  })
}

const isMessage = (m: unknown): m is Api.Message | Api.MessageService => m instanceof Api.Message || m instanceof Api.MessageService

export class UserAccount extends BotAccount implements UserHost {
  private client?: TelegramClient
  private uapi?: UserApi
  private entities = new Map<string, Entity>()
  private mine = new Map<string, number>()
  private watchdog?: ReturnType<typeof setTimeout>
  private dialogsAt = 0
  private seenSaved = 0

  get kind(): AccountKind {
    return 'user'
  }

  get api(): TgCaller | undefined {
    return this.uapi
  }

  /** A person has no token: the session is replaced by logging in again. */
  setToken(): void {}

  status() {
    return { ...super.status(), phone: maskPhone((this.me as (TgBotInfo & { phone?: string }) | null)?.phone), readsAllGroupMessages: null, canJoinGroups: null }
  }

  // ---------------------------------------------------------------- UserHost
  lookup(key: string): Entity | undefined {
    return this.entities.get(key)
  }

  remember(list: unknown[]): void {
    for (const e of list) {
      if (!(e instanceof Api.User || e instanceof Api.Chat || e instanceof Api.Channel || e instanceof Api.ChatForbidden || e instanceof Api.ChannelForbidden)) continue
      const k = entityKey(e)
      if (!k) continue
      // a "min" constructor lacks names and hashes: never let it hide a full one
      if ((e as Api.User | Api.Channel).min && this.entities.has(k)) continue
      this.entities.set(k, e)
    }
  }

  async refreshDialogs(): Promise<void> {
    if (!this.client || Date.now() - this.dialogsAt < 30_000) return
    this.dialogsAt = Date.now()
    const ds = await this.client.getDialogs({ limit: 200 })
    this.remember(ds.map((d) => d.entity))
  }

  sentHere(chat: string, id: number): void {
    const t = Date.now()
    this.mine.set(`${chat}:${id}`, t)
    for (const [k, at] of this.mine) if (t - at > 120_000) this.mine.delete(k)
  }

  // ---------------------------------------------------------------- start / stop
  async start(): Promise<void> {
    await this.stop(false)
    this.stopping = false
    const gen = ++this.generation
    const session = openSession(this.row.session)
    if (!session) {
      this.lastError = { code: 401, reason: 'This computer cannot open the saved session (another installation, or its key file is gone): link the account again', at: now() }
      this.setState('unauthorized', { reason: this.lastError.reason })
      return
    }
    const app = await this.ctx.telegramApp?.()
    if (!app) {
      this.lastError = { code: undefined, reason: 'The Telegram app code (api_id / api_hash) of this installation is missing: add it again in the config page', at: now() }
      this.setState('not_linked', { reason: this.lastError.reason })
      return
    }
    this.setState('connecting')
    const client = newClient(session, app)
    this.client = client
    try {
      await client.connect()
      if (!this.alive(gen)) {
        void client.destroy().catch(() => undefined)
        return
      }
      this.uapi = new UserApi(client, this)
      await this.readMe()
    } catch (e) {
      const err = toTgError('getMe', e)
      if (this.client === client) {
        this.client = undefined
        this.uapi = undefined
      }
      void client.destroy().catch(() => undefined)
      if (!this.alive(gen)) return
      if (this.fatal(err)) return
      this.lastError = { code: err instanceof TgApiError ? err.code : undefined, reason: tgReason(err), at: now() }
      this.setState('reconnecting', { reason: this.lastError.reason })
      setTimeout(() => {
        if (this.alive(gen)) void this.start().catch((x) => logger.error({ account: this.id, err: String(x) }, 'account start failed'))
      }, 30_000).unref()
      return
    }
    client.addEventHandler((ev: NewMessageEvent) => void this.onUpdate(gen, ev.message, ev.originalUpdate, false), new NewMessage({}))
    client.addEventHandler((ev: EditedMessageEvent) => void this.onUpdate(gen, ev.message, ev.originalUpdate, true), new EditedMessage({}))
    client.addEventHandler((u: unknown) => void this.onRaw(gen, u), new Raw({}))
    this.lastError = undefined
    this.setState('open', { username: this.row.username })
    this.onOpen(gen)
    // first connection: only the chat list and the last messages, no events; later ones: what was missed
    void this.sync(gen, !!this.row.update_offset).catch((e) => logger.warn({ account: this.id, err: tgReason(e) }, 'chat sync failed'))
  }

  async stop(publish = true): Promise<void> {
    await super.stop(publish)
    if (this.watchdog) clearTimeout(this.watchdog)
    this.watchdog = undefined
    const c = this.client
    this.client = undefined
    this.uapi = undefined
    if (c) await c.destroy().catch(() => undefined)
  }

  /** Unlinked from TeleOps: close the session on Telegram too, so it leaves Settings → Devices. */
  async logout(): Promise<void> {
    if (!this.client) return
    await this.client.invoke(new Api.auth.LogOut()).catch((e) => logger.debug({ account: this.id, err: tgReason(e) }, 'log out failed'))
  }

  /** The session was closed from Telegram, or the account is gone: nothing works until it is linked again. */
  protected fatal(e: unknown): boolean {
    if (!(e instanceof TgApiError) || e.code !== 401) return false
    this.lastError = { code: 401, reason: 'The session was closed on Telegram (Settings → Devices) or the account is gone: link the account again', at: now() }
    this.setState('unauthorized', { reason: this.lastError.reason })
    const c = this.client
    this.client = undefined
    this.uapi = undefined
    this.generation++
    if (c) void c.destroy().catch(() => undefined)
    return true
  }

  requireApi(): TgCaller {
    const api = this.uapi
    if (!api || !this.row.enabled || ['not_linked', 'unauthorized', 'stopped'].includes(this.state)) {
      throw new AppError('NOT_CONNECTED_ACCOUNT', 'Account "{0}" is not connected (state: {1})', 409, [this.displayName(), this.state])
    }
    return api
  }

  asAppError(e: unknown): Error {
    if (e instanceof TgApiError) {
      const d = e.description
      if (e.code === 401) void this.fatal(e)
      else if (/chat not found/i.test(d)) return new AppError('CHAT_NOT_FOUND', 'This account does not know this chat: use the id or @username of a chat it is in or a person it can write to', 404)
      else if (/not a member/i.test(d)) return new AppError('NOT_A_MEMBER', 'This account is not a member of this chat', 403)
      else if (/not enough rights/i.test(d)) return new AppError('CANNOT_WRITE', 'This account cannot do that in this chat ({0})', 403, [d])
    }
    return super.asAppError(e)
  }

  /** The account's own name, @username and phone, as Telegram has them now. */
  async readMe(): Promise<TgBotInfo> {
    const api = this.uapi
    if (!api) throw new AppError('NOT_CONNECTED_ACCOUNT', 'Account "{0}" is not connected (state: {1})', 409, [this.displayName(), this.state])
    const me = await api.call<TgBotInfo & { phone?: string }>('getMe')
    const before = this.displayName()
    this.me = me
    const label = fullName(me) ?? me.username ?? this.row.label
    const set: Record<string, unknown> = { me: JSON.stringify(me), updated_at: now() }
    if ((me.username ?? null) !== this.row.username) set.username = this.row.username = me.username ?? null
    if (label && label !== this.row.label) set.label = this.row.label = label
    await this.ctx.h.db.updateTable('accounts').set(set).where('id', '=', this.id).execute()
    if (before !== this.displayName() && this.profileCache?.updated_at) this.ctx.bus.publish('profile.update', this.id, { name: this.displayName(), username: this.row.username, about: this.profileCache?.about ?? null })
    return me
  }

  // ---------------------------------------------------------------- updates
  private async onUpdate(gen: number, msg: unknown, update: unknown, edited: boolean): Promise<void> {
    if (!this.alive(gen) || !this.uapi || !isMessage(msg)) return
    try {
      const ents = (update as { _entities?: Map<string, unknown> } | undefined)?._entities
      if (ents?.size) this.remember([...ents.values()])
      const m = msg as Api.Message & { _sender?: unknown; _chat?: unknown }
      this.remember([m._sender, m._chat])
      const key = peerKey(msg.peerId)
      if (!key || key === SERVICE_CHAT) return
      if (!this.entities.has(key)) {
        const c = await msg.getChat().catch(() => undefined)
        if (c) this.remember([c])
      }
      const fromKey = peerKey(msg.fromId)
      if (fromKey && !fromKey.startsWith('-') && !this.entities.has(fromKey)) {
        const s = await msg.getSender().catch(() => undefined)
        if (s) this.remember([s])
      }
      const tg = this.uapi.convert(msg)
      if (tg.chat.type === 'channel') return
      if (!edited && this.mine.has(`${tg.chat.id}:${tg.message_id}`)) return
      if (edited) await this.onEdited(tg)
      else await this.onMessage(tg)
      this.seen(tg.date)
    } catch (e) {
      logger.error({ account: this.id, err: String((e as Error)?.stack ?? e).slice(0, 2000) }, 'update processing failed')
    }
  }

  private async onRaw(gen: number, u: unknown): Promise<void> {
    if (!this.alive(gen)) return
    if (u instanceof UpdateConnectionState) {
      if (u.state === UpdateConnectionState.connected) {
        if (this.watchdog) clearTimeout(this.watchdog)
        this.watchdog = undefined
        if (this.state === 'reconnecting') {
          this.lastError = undefined
          this.setState('open', { username: this.row.username })
          void this.sync(gen, true).catch((e) => logger.warn({ account: this.id, err: tgReason(e) }, 'chat sync failed'))
        }
      } else {
        if (this.state === 'open') this.setState('reconnecting', { reason: 'connection to Telegram lost' })
        // GramJS reconnects by itself; if it has not managed in a while, start over
        if (!this.watchdog) {
          const t = setTimeout(() => {
            this.watchdog = undefined
            if (this.alive(gen) && this.state !== 'open') void this.start().catch((x) => logger.error({ account: this.id, err: String(x) }, 'account restart failed'))
          }, 90_000)
          ;(t as { unref?: () => void }).unref?.()
          this.watchdog = t
        }
      }
      return
    }
    try {
      if (u instanceof Api.UpdateDeleteChannelMessages) await this.store.markDeleted('-100' + String(u.channelId), u.messages.map(String))
      else if (u instanceof Api.UpdateDeleteMessages && u.messages.length) {
        // ids of private chats and basic groups are unique in the account: find their chats
        const rows = await this.ctx.h.db.selectFrom('messages').select(['chat_id', 'id']).where('account_id', '=', this.id).where('id', 'in', u.messages.map(String)).where('chat_id', 'not like', '-100%').execute()
        const byChat = new Map<string, string[]>()
        for (const r of rows) byChat.set(r.chat_id as string, [...(byChat.get(r.chat_id as string) ?? []), r.id as string])
        for (const [chat, ids] of byChat) await this.store.markDeleted(chat, ids)
      }
    } catch (e) {
      logger.debug({ account: this.id, err: String(e) }, 'delete update not applied')
    }
  }

  /** Remember how far the account has read (to tell, after a restart, what is new). */
  private seen(ts: number) {
    if (ts <= Number(this.row.update_offset ?? 0)) return
    this.row.update_offset = ts
    if (Date.now() - this.seenSaved < 30_000) return
    this.seenSaved = Date.now()
    void this.ctx.h.db.updateTable('accounts').set({ update_offset: ts }).where('id', '=', this.id).execute().catch(() => undefined)
  }

  private async store1(list: (Api.Message | Api.MessageService)[], announce: (m: TgMessage) => boolean): Promise<number> {
    const api = this.uapi
    if (!api) return 0
    let n = 0
    for (const msg of list) {
      const key = peerKey(msg.peerId)
      if (!key || key === SERVICE_CHAT) continue
      const tg = api.convert(msg)
      if (tg.chat.type === 'channel') continue
      const rows = await this.store.upsertMessages([{ m: tg, fromMe: this.isMine(tg) }])
      n += rows.length
      if (announce(tg)) for (const r of rows) this.ctx.bus.publish(r.from_me ? 'message.sent' : 'message.received', this.id, await this.summarize(r))
    }
    return n
  }

  /** The chat list from Telegram; for every chat, the messages newer than the last one stored. */
  private async sync(gen: number, announce: boolean): Promise<void> {
    const c = this.client
    if (!c || !this.uapi) return
    const since = Number(this.row.update_offset ?? 0)
    const dialogs = await c.getDialogs({ limit: SYNC_DIALOGS })
    this.dialogsAt = Date.now()
    let newest = since
    for (const d of dialogs) {
      if (!this.alive(gen)) return
      const e = d.entity as Entity | undefined
      if (!e) continue
      this.remember([e])
      const key = entityKey(e)
      if (!key || key === SERVICE_CHAT) continue
      const chat = chatOf(e)
      if (chat.type === 'channel') continue
      const top = d.message
      await this.store.upsertChat(chat, { ts: top?.date })
      if (!isMessage(top)) continue
      newest = Math.max(newest, top.date)
      const last = await this.ctx.h.db.selectFrom('messages').select('seq').where('account_id', '=', this.id).where('chat_id', '=', key).orderBy('seq', 'desc').limit(1).executeTakeFirst()
      const lastId = Number(last?.seq ?? 0)
      if (top.id <= lastId) continue
      const list = lastId ? (await c.getMessages(e, { minId: lastId, limit: 100 })).filter(isMessage).reverse() : [top]
      const cutoff = Math.max(since - 60, now() / 1000 - ANNOUNCE_WINDOW)
      await this.store1(list, (m) => announce && !!lastId && m.date >= cutoff)
    }
    if (newest > Number(this.row.update_offset ?? 0)) {
      this.row.update_offset = newest
      await this.ctx.h.db.updateTable('accounts').set({ update_offset: newest }).where('id', '=', this.id).execute()
    }
    logger.info({ account: this.id, chats: dialogs.length }, 'chats read from Telegram')
  }

  // ---------------------------------------------------------------- history and search on Telegram
  /** Messages of a chat read from Telegram into the store (a person, unlike a bot, can read the history). */
  async history(chat: string, o: { limit: number; before?: number; after?: number }): Promise<number> {
    const c = this.client
    const api = this.uapi
    if (!c || !api || this.state !== 'open') return 0
    const peer = await api.peer(chat)
    const limit = Math.min(Math.max(o.limit, 1), 200)
    const params = o.after ? { limit, offsetDate: o.after, reverse: true } : o.before ? { limit, offsetDate: o.before } : { limit }
    const list = (await c.getMessages(peer, params)).filter(isMessage)
    return this.store1(list, () => false)
  }

  /** Telegram's own search (one chat, or every chat of the account) into the store. */
  async searchRemote(query: string, chat: string | null, limit: number): Promise<number> {
    const c = this.client
    const api = this.uapi
    if (!c || !api || this.state !== 'open') return 0
    const peer = chat ? await api.peer(chat) : undefined
    const list = (await c.getMessages(peer, { search: query, limit: Math.min(limit, 100) })).filter(isMessage)
    return this.store1(list, () => false)
  }
}
