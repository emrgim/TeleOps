import crypto from 'node:crypto'
import { sql } from 'kysely'
import { now, upsert, type DbHandle } from '../db/index.js'
import type { Settings } from '../settings.js'
import { AppError } from '../util.js'
import type { BotAccount } from './account.js'
import type { AccountManager } from './manager.js'
import { fullName, type Media, type MessageRow } from './store.js'
import type { TgChatFullInfo, TgChatMember, TgFile, TgInviteLink, TgMessage } from './types.js'
import type { Upload } from './api.js'

export type MediaType = 'photo' | 'image' | 'video' | 'audio' | 'voice' | 'document' | 'sticker' | 'animation' | 'video_note'
export type ChatType = 'all' | 'private' | 'groups' | 'channels'
export type Button = { text: string; url?: string; data?: string }
export type ParseMode = 'HTML' | 'MarkdownV2' | 'Markdown'

const SEND: Record<Exclude<MediaType, 'image'>, { method: string; field: string; caption: boolean; maxMb: number }> = {
  photo: { method: 'sendPhoto', field: 'photo', caption: true, maxMb: 10 },
  video: { method: 'sendVideo', field: 'video', caption: true, maxMb: 50 },
  audio: { method: 'sendAudio', field: 'audio', caption: true, maxMb: 50 },
  voice: { method: 'sendVoice', field: 'voice', caption: true, maxMb: 50 },
  document: { method: 'sendDocument', field: 'document', caption: true, maxMb: 50 },
  sticker: { method: 'sendSticker', field: 'sticker', caption: false, maxMb: 50 },
  animation: { method: 'sendAnimation', field: 'animation', caption: true, maxMb: 50 },
  video_note: { method: 'sendVideoNote', field: 'video_note', caption: false, maxMb: 50 },
}

/** Bots download at most 20 MB from Telegram's servers. */
const TG_DOWNLOAD_MAX = 20 * 1024 * 1024
const TEXT_MAX = 4096
const CAPTION_MAX = 1024

function likeOp(h: DbHandle): 'ilike' | 'like' {
  return h.dialect === 'postgres' ? 'ilike' : 'like'
}

function escLike(s: string): string {
  return s.replace(/[\\%_]/g, (m) => '\\' + m)
}

/** chat_id as Telegram wants it: a number, or @username of a public chat. */
export const chatParam = (chat: string): number | string => (/^-?\d+$/.test(chat) ? Number(chat) : chat)

/** Split a long plain text at paragraph, line or word ends (Telegram takes 4096 characters per message). */
export function splitText(text: string, max = TEXT_MAX): string[] {
  const out: string[] = []
  let rest = text
  while (rest.length > max) {
    const cut = Math.max(rest.lastIndexOf('\n\n', max), rest.lastIndexOf('\n', max), rest.lastIndexOf(' ', max))
    const at = cut > max * 0.5 ? cut : max
    out.push(rest.slice(0, at).trimEnd())
    rest = rest.slice(at).replace(/^\s+/, '')
  }
  if (rest.trim()) out.push(rest)
  return out
}

/** Inline buttons under a message: rows of { text, url } (opens a link) or { text, data } (comes back as button.pressed). */
export function keyboard(buttons: (Button | Button[])[] | undefined): Record<string, unknown> | undefined {
  if (!buttons?.length) return undefined
  const rows = buttons.map((r) => (Array.isArray(r) ? r : [r])).filter((r) => r.length)
  const inline_keyboard = rows.map((r) =>
    r.map((b) => {
      const text = String(b.text ?? '').trim()
      if (!text) throw new AppError('BAD_BUTTON', 'Every button needs a text', 400)
      if (b.url) {
        if (!/^(https?|tg):\/\//i.test(b.url)) throw new AppError('BAD_BUTTON', 'A button link must start with http://, https:// or tg://: {0}', 400, [b.url.slice(0, 80)])
        return { text, url: b.url }
      }
      const data = String(b.data ?? text)
      if (Buffer.byteLength(data) > 64) throw new AppError('BAD_BUTTON', 'The data of a button is at most 64 bytes: {0}', 400, [data.slice(0, 40)])
      return { text, callback_data: data }
    }),
  )
  if (inline_keyboard.flat().length > 100) throw new AppError('BAD_BUTTON', 'At most 100 buttons', 400)
  return { inline_keyboard }
}

export class TgService {
  /** voice transcripts (set at start): attached to voice messages, searched with the text */
  voice?: {
    attach(accountId: string, msgs: { id: string; chat: string; type: string; transcript?: string | null }[]): Promise<void>
    search(accountId: string, op: 'like' | 'ilike', pattern: string, limit: number): Promise<{ chat_id: string; msg_id: string }[]>
  }

  constructor(
    public h: DbHandle,
    public accounts: AccountManager,
    public settings: Settings,
  ) {}

  // ------------------------------------------------------------ recipients
  /** A chat: its id, @username, a t.me link, or the exact name of a chat or a person who wrote to the bot. */
  async resolveChat(acc: BotAccount, input: string): Promise<string> {
    const s = String(input ?? '').trim()
    if (!s) throw new AppError('INVALID_CHAT', 'chat/recipient is required', 400)
    if (/^-?\d{3,20}$/.test(s)) return s
    const link = s.match(/^(?:https?:\/\/)?(?:t\.me|telegram\.me)\/([A-Za-z0-9_]{4,32})\/?$/i)
    if (s.startsWith('@') || link) {
      const u = (link ? link[1] : s.slice(1)).toLowerCase()
      const c = await this.h.db.selectFrom('chats').select('chat_id').where('account_id', '=', acc.id).where(sql`lower(username)`, '=', u).executeTakeFirst()
      if (c) return c.chat_id as string
      const p = await this.h.db.selectFrom('contacts').select('user_id').where('account_id', '=', acc.id).where(sql`lower(username)`, '=', u).executeTakeFirst()
      if (p) return p.user_id as string
      try {
        const ch = await acc.call<TgChatFullInfo>('getChat', { chat_id: '@' + u })
        await acc.store.upsertChat(ch, { full: true, touch: false })
        return String(ch.id)
      } catch {
        throw new AppError('CHAT_NOT_FOUND', 'No public chat @{0} on Telegram, and nobody with this username wrote to the bot', 404, [u])
      }
    }
    const matches = await this.findContacts(acc, s, 6)
    const exact = matches.filter((m) => (m.name ?? '').toLowerCase() === s.toLowerCase())
    const pick = exact.length === 1 ? exact[0] : matches.length === 1 ? matches[0] : null
    if (pick) return pick.id
    if (!matches.length) throw new AppError('CHAT_NOT_FOUND', 'No chat or person named "{0}". Use the chat id or @username.', 404, [s])
    throw new AppError('AMBIGUOUS_CHAT', '"{0}" matches several chats: {1}. Use the chat id or @username.', 409, [s, matches.map((m) => `${m.name ?? '?'} (${m.username ? '@' + m.username : m.id})`).join('; ')])
  }

  private async checkAllowlist(acc: BotAccount, chat: string): Promise<void> {
    const al = this.settings.get().sendAllowlist.trim()
    if (!al || al === '*') return
    const entries = al.split(/[,\s]+/).filter(Boolean).map((e) => e.toLowerCase())
    const username = (await acc.store.usernameOf(chat))?.toLowerCase()
    const ok = entries.some((e) => e === chat || (username && e.replace(/^@/, '') === username))
    if (!ok) throw new AppError('NOT_ALLOWED', 'Sending to {0} is blocked by the send allowlist (config page → Settings).', 403, [chat])
  }

  private async prepareRecipient(acc: BotAccount, to: string): Promise<string> {
    const chat = await this.resolveChat(acc, to)
    await this.checkAllowlist(acc, chat)
    return chat
  }

  // ------------------------------------------------------------ idempotency
  private async withIdempotency<T extends { id: string }>(acc: BotAccount, key: string | undefined, chat: string, fn: () => Promise<T>): Promise<T & { duplicate?: boolean }> {
    if (!key) return fn()
    const k = key.slice(0, 180)
    const ex = await this.h.db.selectFrom('outbox').selectAll().where('account_id', '=', acc.id).where('idem_key', '=', k).executeTakeFirst()
    if (ex?.state === 'sent') return { id: ex.msg_id, chat: ex.chat_id, duplicate: true } as unknown as T & { duplicate: boolean }
    if (ex?.state === 'pending' && now() - ex.updated_at < 120_000) throw new AppError('IN_FLIGHT', 'A send with this idempotency key is still in progress', 409)
    await upsert(this.h, 'outbox', { account_id: acc.id, idem_key: k, chat_id: chat, state: 'pending', msg_id: null, error: null, created_at: ex?.created_at ?? now(), updated_at: now() }, ['account_id', 'idem_key'])
    try {
      const r = await fn()
      await this.h.db.updateTable('outbox').set({ state: 'sent', msg_id: r.id, updated_at: now() }).where('account_id', '=', acc.id).where('idem_key', '=', k).execute()
      return r
    } catch (e) {
      await this.h.db.updateTable('outbox').set({ state: 'failed', error: String((e as Error).message).slice(0, 500), updated_at: now() }).where('account_id', '=', acc.id).where('idem_key', '=', k).execute()
      throw e
    }
  }

  // ------------------------------------------------------------ reads
  async listChats(acc: BotAccount, o: { limit?: number; offset?: number; query?: string; type?: ChatType }) {
    let q = this.h.db.selectFrom('chats').selectAll().where('account_id', '=', acc.id)
    if (o.type === 'private') q = q.where('type', '=', 'private')
    if (o.type === 'groups') q = q.where('type', 'in', ['group', 'supergroup'])
    if (o.type === 'channels') q = q.where('type', '=', 'channel')
    if (o.query) {
      const pat = `%${escLike(o.query.replace(/^@/, ''))}%`
      q = q.where((eb) => eb.or([eb('title', likeOp(this.h), pat), eb('username', likeOp(this.h), pat)]))
    }
    const rows = await q
      .orderBy(sql`coalesce(last_ts, 0)`, 'desc')
      .limit(Math.min(o.limit ?? 30, 200))
      .offset(o.offset ?? 0)
      .execute()
    const out = []
    for (const r of rows) {
      const last = (await this.h.db
        .selectFrom('messages')
        .select(['id', 'from_me', 'text', 'type'])
        .where('account_id', '=', acc.id)
        .where('chat_id', '=', r.chat_id)
        .orderBy('ts', 'desc')
        .orderBy('seq', 'desc')
        .limit(1)
        .executeTakeFirst()) as { id: string; from_me: number; text: string | null; type: string } | undefined
      out.push({
        chat: r.chat_id as string,
        name: (r.title as string | null) ?? (await acc.store.nameOf(r.chat_id)),
        type: r.type as string,
        username: (r.username as string | null) ?? null,
        link: r.username ? `https://t.me/${r.username}` : null,
        // the bot's place in the chat: member, administrator, left, kicked (in a private chat: the person blocked the bot)
        botStatus: (r.member as string | null) ?? null,
        lastMessageAt: r.last_ts ? new Date(Number(r.last_ts) * 1000).toISOString() : null,
        lastMessage: last ? { id: last.id, fromMe: !!last.from_me, text: last.text, type: last.type } : null,
      })
    }
    return out
  }

  async getMessages(acc: BotAccount, chatInput: string, o: { limit?: number; before?: string | number; after?: string | number }) {
    const chat = await this.resolveChat(acc, chatInput)
    let q = this.h.db.selectFrom('messages').selectAll().where('account_id', '=', acc.id).where('chat_id', '=', chat)
    const toTs = (v: string | number) => (typeof v === 'number' ? (v > 1e12 ? Math.floor(v / 1000) : v) : Math.floor(Date.parse(v) / 1000))
    if (o.before !== undefined && o.before !== '') q = q.where('ts', '<', toTs(o.before))
    if (o.after !== undefined && o.after !== '') q = q.where('ts', '>', toTs(o.after))
    const rows = (await q.orderBy('ts', 'desc').orderBy('seq', 'desc').limit(Math.min(o.limit ?? 30, 500)).execute()) as MessageRow[]
    const msgs = []
    for (const r of rows.reverse()) msgs.push(await acc.summarize(r))
    await this.voice?.attach(acc.id, msgs)
    return { chat, chatName: await acc.store.nameOf(chat), messages: msgs }
  }

  async searchMessages(acc: BotAccount, query: string, o: { chat?: string; limit?: number; since?: string }) {
    const limit = Math.min(o.limit ?? 30, 200)
    const pattern = `%${escLike(query)}%`
    const chat = o.chat ? await this.resolveChat(acc, o.chat) : null
    const since = o.since ? Math.floor(Date.parse(o.since) / 1000) : null
    let q = this.h.db.selectFrom('messages').selectAll().where('account_id', '=', acc.id).where('text', likeOp(this.h), pattern)
    if (chat) q = q.where('chat_id', '=', chat)
    if (since) q = q.where('ts', '>=', since)
    const rows = (await q.orderBy('ts', 'desc').limit(limit).execute()) as MessageRow[]
    // what was said in voice messages is searchable too
    for (const hit of (await this.voice?.search(acc.id, likeOp(this.h), pattern, limit)) ?? []) {
      if (chat && hit.chat_id !== chat) continue
      if (rows.some((r) => r.id === hit.msg_id && r.chat_id === hit.chat_id)) continue
      const r = await acc.store.loadRow(hit.chat_id, hit.msg_id)
      if (r && (!since || r.ts >= since)) rows.push(r)
    }
    rows.sort((a, b) => b.ts - a.ts)
    const out = []
    for (const r of rows.slice(0, limit)) out.push(await acc.summarize(r))
    await this.voice?.attach(acc.id, out)
    return out
  }

  /** People who wrote to the bot and chats it is in, by name, @username or id. */
  async findContacts(acc: BotAccount, query: string, limit = 20) {
    const s = query.trim().replace(/^@/, '')
    const op = likeOp(this.h)
    const pat = `%${escLike(s)}%`
    const people = await this.h.db
      .selectFrom('contacts')
      .selectAll()
      .where('account_id', '=', acc.id)
      .where('user_id', '!=', acc.id)
      .where((eb) => eb.or([eb('name', op, pat), eb('username', op, pat), eb('user_id', '=', s)]))
      .orderBy(sql`coalesce(seen_at, 0)`, 'desc')
      .limit(limit)
      .execute()
    const chats = await this.h.db
      .selectFrom('chats')
      .select(['chat_id', 'title', 'username', 'type', 'member'])
      .where('account_id', '=', acc.id)
      .where('type', '!=', 'private')
      .where((eb) => eb.or([eb('title', op, pat), eb('username', op, pat), eb('chat_id', '=', s)]))
      .limit(limit)
      .execute()
    const out: { id: string; name: string | null; username: string | null; type: string; link: string | null; botStatus?: string | null; lastSeen?: string | null }[] = []
    for (const p of people) {
      out.push({
        id: p.user_id as string,
        name: (p.name as string | null) ?? null,
        username: (p.username as string | null) ?? null,
        type: p.is_bot ? 'bot' : 'person',
        link: p.username ? `https://t.me/${p.username}` : null,
        lastSeen: p.seen_at ? new Date(Number(p.seen_at)).toISOString() : null,
      })
    }
    for (const c of chats) {
      out.push({ id: c.chat_id as string, name: (c.title as string | null) ?? null, username: (c.username as string | null) ?? null, type: c.type as string, link: c.username ? `https://t.me/${c.username}` : null, botStatus: (c.member as string | null) ?? null })
    }
    return out.slice(0, limit)
  }

  /** A chat as Telegram describes it now: title, description, members, administrators, what the bot may do there. */
  async getChat(acc: BotAccount, input: string) {
    const chat = await this.resolveChat(acc, input)
    const info = await acc.call<TgChatFullInfo>('getChat', { chat_id: chatParam(chat) })
    await acc.store.upsertChat(info, { full: true, touch: false })
    const base = {
      chat: String(info.id),
      type: info.type,
      name: info.title ?? fullName(info),
      username: info.username ?? null,
      link: info.username ? `https://t.me/${info.username}` : info.invite_link ?? null,
    }
    if (info.type === 'private') {
      const p = await acc.store.user(String(info.id))
      return { ...base, bio: info.bio ?? null, language: p?.lang ?? null, isBot: !!p?.is_bot, botBlocked: (await acc.store.chat(String(info.id)))?.member === 'kicked' }
    }
    const [admins, count, me] = await Promise.all([
      acc.call<TgChatMember[]>('getChatAdministrators', { chat_id: info.id }).catch(() => null),
      acc.call<number>('getChatMemberCount', { chat_id: info.id }).catch(() => null),
      acc.call<TgChatMember>('getChatMember', { chat_id: info.id, user_id: Number(acc.id) }).catch(() => null),
    ])
    if (admins) await acc.store.upsertUsers(admins.map((a) => a.user))
    if (me) await acc.store.setMember(String(info.id), me.status)
    const rights = me ? Object.fromEntries(Object.entries(me).filter(([k, v]) => k.startsWith('can_') && typeof v === 'boolean')) : null
    return {
      ...base,
      description: info.description ?? null,
      members: count,
      forum: !!info.is_forum,
      slowModeSeconds: info.slow_mode_delay ?? null,
      autoDeleteSeconds: info.message_auto_delete_time ?? null,
      protectedContent: !!info.has_protected_content,
      joinByRequest: !!info.join_by_request,
      linkedChat: info.linked_chat_id ? String(info.linked_chat_id) : null,
      pinnedMessage: info.pinned_message ? { id: String(info.pinned_message.message_id), text: info.pinned_message.text ?? info.pinned_message.caption ?? null } : null,
      administrators: (admins ?? []).map((a) => ({ id: String(a.user.id), name: fullName(a.user), username: a.user.username ?? null, isBot: !!a.user.is_bot, status: a.status, title: (a as { custom_title?: string }).custom_title ?? null })),
      bot: me ? { status: me.status, rights } : null,
    }
  }

  // ------------------------------------------------------------ writes
  private replyParams(replyTo?: string) {
    if (!replyTo) return undefined
    if (!/^\d+$/.test(replyTo)) throw new AppError('INVALID_INPUT', 'reply_to is the id of a message in the same chat (a number)', 400)
    return { message_id: Number(replyTo), allow_sending_without_reply: true }
  }

  async sendText(acc: BotAccount, i: { to: string; text: string; parseMode?: ParseMode; replyTo?: string; buttons?: (Button | Button[])[]; silent?: boolean; linkPreview?: boolean; threadId?: string; idempotencyKey?: string }) {
    if (!i.text?.trim()) throw new AppError('EMPTY_TEXT', 'text is required', 400)
    if (i.parseMode && i.text.length > TEXT_MAX) throw new AppError('TEXT_TOO_LONG', 'A formatted message is at most {0} characters (plain text is split by itself)', 400, [TEXT_MAX])
    const chat = await this.prepareRecipient(acc, i.to)
    const parts = i.parseMode ? [i.text] : splitText(i.text)
    const markup = keyboard(i.buttons)
    return this.withIdempotency(acc, i.idempotencyKey, chat, async () => {
      const sent: TgMessage[] = []
      for (const [n, part] of parts.entries()) {
        sent.push(
          await acc.send(chat, 'sendMessage', {
            text: part,
            parse_mode: i.parseMode,
            reply_parameters: n === 0 ? this.replyParams(i.replyTo) : undefined,
            reply_markup: n === parts.length - 1 ? markup : undefined,
            disable_notification: i.silent || undefined,
            link_preview_options: i.linkPreview === false ? { is_disabled: true } : undefined,
            message_thread_id: i.threadId ? Number(i.threadId) : undefined,
          }),
        )
      }
      return { id: String(sent[0].message_id), ...(sent.length > 1 ? { ids: sent.map((m) => String(m.message_id)) } : {}), chat: String(sent[0].chat.id), timestamp: new Date(sent[0].date * 1000).toISOString(), status: 'sent' }
    })
  }

  async fetchMedia(url: string): Promise<{ buf: Buffer; mimetype?: string; fileName?: string }> {
    let u: URL
    try {
      u = new URL(url)
    } catch {
      throw new AppError('INVALID_URL', 'media url is not a valid URL', 400)
    }
    if (!['http:', 'https:'].includes(u.protocol)) throw new AppError('INVALID_URL', 'Only http(s) media URLs are allowed', 400)
    const max = this.settings.get().maxMediaMb * 1024 * 1024
    const res = await fetch(u, { signal: AbortSignal.timeout(60_000), redirect: 'follow' })
    if (!res.ok) throw new AppError('MEDIA_FETCH_FAILED', 'Fetching media failed: HTTP {0}', 502, [res.status])
    const len = Number(res.headers.get('content-length') ?? 0)
    if (len > max) throw new AppError('MEDIA_TOO_LARGE', 'Media larger than {0} MB', 413, [this.settings.get().maxMediaMb])
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.length > max) throw new AppError('MEDIA_TOO_LARGE', 'Media larger than {0} MB', 413, [this.settings.get().maxMediaMb])
    const fileName = decodeURIComponent(u.pathname.split('/').pop() || '') || undefined
    return { buf, mimetype: res.headers.get('content-type')?.split(';')[0] ?? undefined, fileName }
  }

  /** The file of a media message: from base64 (or a data: URL) or downloaded from a URL, within the size limit. */
  private async loadMedia(i: { url?: string; base64?: string; mimetype?: string; fileName?: string }): Promise<{ buf: Buffer; mimetype?: string; fileName?: string }> {
    let buf: Buffer
    let mimetype = i.mimetype
    let fileName = i.fileName
    if (i.base64) {
      const b64 = i.base64.replace(/^data:([^;]+);base64,/, (_m, mt) => {
        mimetype = mimetype ?? mt
        return ''
      })
      buf = Buffer.from(b64, 'base64')
      if (buf.length > this.settings.get().maxMediaMb * 1024 * 1024) throw new AppError('MEDIA_TOO_LARGE', 'media too large', 413)
    } else if (i.url) {
      const f = await this.fetchMedia(i.url)
      buf = f.buf
      mimetype = mimetype ?? f.mimetype
      fileName = fileName ?? f.fileName
    } else throw new AppError('NO_MEDIA', 'Provide url, base64 or file_id', 400)
    if (!buf.length) throw new AppError('NO_MEDIA', 'media is empty', 400)
    return { buf, mimetype, fileName }
  }

  async sendMedia(
    acc: BotAccount,
    i: { to: string; type: MediaType; url?: string; base64?: string; fileId?: string; mimetype?: string; fileName?: string; caption?: string; parseMode?: ParseMode; replyTo?: string; buttons?: (Button | Button[])[]; silent?: boolean; threadId?: string; idempotencyKey?: string },
  ) {
    const kind = SEND[i.type === 'image' ? 'photo' : i.type]
    if (!kind) throw new AppError('INVALID_INPUT', 'Unknown media type {0}', 400, [i.type])
    if (i.caption && !kind.caption) throw new AppError('INVALID_INPUT', 'A {0} has no caption', 400, [i.type])
    if (i.caption && i.caption.length > CAPTION_MAX) throw new AppError('CAPTION_TOO_LONG', 'A caption is at most {0} characters', 400, [CAPTION_MAX])
    const chat = await this.prepareRecipient(acc, i.to)
    const params: Record<string, unknown> = {
      caption: i.caption || undefined,
      parse_mode: i.caption ? i.parseMode : undefined,
      reply_parameters: this.replyParams(i.replyTo),
      reply_markup: keyboard(i.buttons),
      disable_notification: i.silent || undefined,
      message_thread_id: i.threadId ? Number(i.threadId) : undefined,
    }
    let files: Upload[] | undefined
    let bytes: number | null = null
    if (i.fileId) params[kind.field] = i.fileId
    else {
      const f = await this.loadMedia(i)
      if (f.buf.length > kind.maxMb * 1024 * 1024) throw new AppError('MEDIA_TOO_LARGE', 'Telegram takes a {0} of at most {1} MB from a bot', 413, [i.type, kind.maxMb])
      const ext = (f.mimetype?.split('/')[1] ?? 'bin').replace(/[^a-z0-9]/gi, '').slice(0, 8) || 'bin'
      files = [{ field: kind.field, data: f.buf, fileName: f.fileName ?? `${kind.field}.${ext}`, mimetype: f.mimetype }]
      bytes = f.buf.length
    }
    return this.withIdempotency(acc, i.idempotencyKey, chat, async () => {
      const m = await acc.send(chat, kind.method, params, { files })
      return { id: String(m.message_id), chat: String(m.chat.id), timestamp: new Date(m.date * 1000).toISOString(), status: 'sent', ...(bytes !== null ? { bytes } : {}) }
    })
  }

  async sendLocation(acc: BotAccount, i: { to: string; latitude: number; longitude: number; name?: string; address?: string; silent?: boolean }) {
    const chat = await this.prepareRecipient(acc, i.to)
    const venue = !!(i.name && i.address)
    const m = await acc.send(chat, venue ? 'sendVenue' : 'sendLocation', { latitude: i.latitude, longitude: i.longitude, ...(venue ? { title: i.name, address: i.address } : {}), disable_notification: i.silent || undefined })
    return { id: String(m.message_id), chat: String(m.chat.id), status: 'sent' }
  }

  private async messageOf(acc: BotAccount, chatInput: string, messageId: string): Promise<{ chat: string; row: MessageRow | undefined }> {
    const chat = await this.resolveChat(acc, chatInput)
    if (!/^\d+$/.test(String(messageId))) throw new AppError('INVALID_INPUT', 'message_id is the number of a Telegram message', 400)
    return { chat, row: await acc.store.loadRow(chat, String(messageId)) }
  }

  async react(acc: BotAccount, i: { chat: string; messageId: string; emoji: string; big?: boolean }) {
    const { chat } = await this.messageOf(acc, i.chat, i.messageId)
    await this.checkAllowlist(acc, chat)
    const emoji = (i.emoji ?? '').trim()
    await acc.call('setMessageReaction', { chat_id: chatParam(chat), message_id: Number(i.messageId), reaction: emoji ? [{ type: 'emoji', emoji }] : [], is_big: i.big || undefined })
    await acc.store.setReactions(chat, String(i.messageId), acc.id, emoji ? [emoji] : [])
    return { ok: true, chat, messageId: String(i.messageId), emoji: emoji || null }
  }

  async editMessage(acc: BotAccount, i: { chat: string; messageId: string; text: string; parseMode?: ParseMode; buttons?: (Button | Button[])[] }) {
    const { chat, row } = await this.messageOf(acc, i.chat, i.messageId)
    if (row && !row.from_me) throw new AppError('NOT_OWN_MESSAGE', 'A bot can edit only the messages it sent', 403)
    const caption = !!row?.media
    if (!i.text?.trim()) throw new AppError('EMPTY_TEXT', 'text is required', 400)
    if (i.text.length > (caption ? CAPTION_MAX : TEXT_MAX)) throw new AppError('TEXT_TOO_LONG', 'At most {0} characters', 400, [caption ? CAPTION_MAX : TEXT_MAX])
    const res = await acc.call<TgMessage | true>(caption ? 'editMessageCaption' : 'editMessageText', {
      chat_id: chatParam(chat),
      message_id: Number(i.messageId),
      ...(caption ? { caption: i.text } : { text: i.text }),
      parse_mode: i.parseMode,
      reply_markup: keyboard(i.buttons),
    })
    if (res && typeof res === 'object') await acc.store.upsertMessages([{ m: res, fromMe: true }])
    return { ok: true, chat, messageId: String(i.messageId) }
  }

  async deleteMessage(acc: BotAccount, i: { chat: string; messageId: string }) {
    const { chat } = await this.messageOf(acc, i.chat, i.messageId)
    await acc.call('deleteMessage', { chat_id: chatParam(chat), message_id: Number(i.messageId) })
    await acc.store.markDeleted(chat, [String(i.messageId)])
    return { ok: true, chat, messageId: String(i.messageId) }
  }

  /** Forward a message (shows where it comes from) or copy it (looks like the bot's own). */
  async forwardMessage(acc: BotAccount, i: { from: string; messageId: string; to: string; copy?: boolean; silent?: boolean }) {
    const { chat: from, row } = await this.messageOf(acc, i.from, i.messageId)
    const to = await this.prepareRecipient(acc, i.to)
    const params = { from_chat_id: chatParam(from), message_id: Number(i.messageId), disable_notification: i.silent || undefined }
    if (!i.copy) {
      const m = await acc.send(to, 'forwardMessage', params)
      return { id: String(m.message_id), chat: String(m.chat.id), status: 'sent', forwarded: true }
    }
    const m = await acc.send(to, 'copyMessage', params, { store: false })
    // copyMessage answers only with the new id: store the copy with the content of the original
    const copy: MessageRow = {
      ...(row ?? { type: 'text', text: '[copied message]', media: null, raw: '{}', reply_to: null, thread_id: null, edited_at: null, reactions: null }),
      account_id: acc.id,
      chat_id: to,
      id: String(m.message_id),
      seq: m.message_id,
      from_me: 1,
      sender: acc.id,
      ts: Math.floor(now() / 1000),
      reactions: null,
      edited_at: null,
      reply_to: null,
    } as MessageRow
    await upsert(this.h, 'messages', copy as unknown as Record<string, unknown>, ['account_id', 'chat_id', 'id'])
    await acc.announce('message.sent', copy)
    return { id: String(m.message_id), chat: to, status: 'sent', copied: true }
  }

  async pinMessage(acc: BotAccount, i: { chat: string; messageId?: string; unpin?: boolean; silent?: boolean }) {
    const chat = await this.resolveChat(acc, i.chat)
    if (i.unpin) await acc.call('unpinChatMessage', { chat_id: chatParam(chat), message_id: i.messageId ? Number(i.messageId) : undefined })
    else {
      if (!i.messageId) throw new AppError('INVALID_INPUT', 'Which message? message_id is required to pin', 400)
      await acc.call('pinChatMessage', { chat_id: chatParam(chat), message_id: Number(i.messageId), disable_notification: i.silent || undefined })
    }
    return { ok: true, chat, messageId: i.messageId ?? null, pinned: !i.unpin }
  }

  /** A new invite link to a group or channel where the bot is an administrator with the right to invite. */
  async inviteLink(acc: BotAccount, i: { chat: string; name?: string; expireHours?: number; memberLimit?: number; joinRequest?: boolean }) {
    const chat = await this.resolveChat(acc, i.chat)
    if (i.joinRequest && i.memberLimit) throw new AppError('INVALID_INPUT', 'A link that asks to join cannot also have a member limit', 400)
    const l = await acc.call<TgInviteLink>('createChatInviteLink', {
      chat_id: chatParam(chat),
      name: i.name?.slice(0, 32) || undefined,
      expire_date: i.expireHours ? Math.floor(Date.now() / 1000) + Math.round(i.expireHours * 3600) : undefined,
      member_limit: i.memberLimit || undefined,
      creates_join_request: i.joinRequest || undefined,
    })
    return { chat, link: l.invite_link, name: l.name ?? null, expires: l.expire_date ? new Date(l.expire_date * 1000).toISOString() : null, memberLimit: l.member_limit ?? null, joinRequest: !!l.creates_join_request }
  }

  // ------------------------------------------------------------ media
  async downloadMedia(acc: BotAccount, chatInput: string | undefined, messageId: string): Promise<{ buf: Buffer; mimetype: string; fileName: string; row: MessageRow }> {
    const chat = chatInput ? await this.resolveChat(acc, chatInput) : undefined
    const row = chat ? await acc.store.loadRow(chat, messageId) : await acc.store.loadById(messageId)
    if (!row) throw new AppError('MESSAGE_NOT_FOUND', 'Message {0} not found', 404, [messageId])
    let media: Media | null = null
    try {
      media = row.media ? (JSON.parse(row.media) as Media) : null
    } catch {
      media = null
    }
    if (!media?.fileId) throw new AppError('NO_MEDIA', 'This message has no media', 400)
    const max = Math.min(this.settings.get().maxMediaMb * 1024 * 1024, TG_DOWNLOAD_MAX)
    if (Number(media.size ?? 0) > max) throw new AppError('MEDIA_TOO_LARGE', 'Telegram lets a bot download files up to 20 MB; this one is {0} MB', 413, [Math.round(Number(media.size) / 1048576)])
    const f = await acc.call<TgFile>('getFile', { file_id: media.fileId })
    if (!f.file_path) throw new AppError('MEDIA_DOWNLOAD_FAILED', 'Media download failed: {0}', 502, ['no file path'])
    const buf = await acc.requireApi().download(f.file_path, max)
    const fromPath = f.file_path.split('.').pop()?.toLowerCase()
    const mimetype = media.mime?.split(';')[0] ?? (fromPath === 'jpg' || fromPath === 'jpeg' ? 'image/jpeg' : fromPath === 'oga' || fromPath === 'ogg' ? 'audio/ogg' : fromPath === 'mp4' ? 'video/mp4' : 'application/octet-stream')
    const ext = media.kind === 'voice' ? 'ogg' : media.kind === 'photo' ? 'jpg' : fromPath && fromPath.length <= 5 ? fromPath : mimetype.split('/')[1]?.replace(/[^a-z0-9]/gi, '') || 'bin'
    return { buf, mimetype, fileName: media.name ?? `${media.kind}-${row.id}.${ext}`, row }
  }

  signMediaToken(account: string, chat: string, id: string, ttlSec = 3600): string {
    const payload = Buffer.from(JSON.stringify({ a: account, c: chat, i: id, e: Math.floor(Date.now() / 1000) + ttlSec })).toString('base64url')
    const sig = crypto.createHmac('sha256', this.settings.secret).update(payload).digest('base64url').slice(0, 32)
    return `${payload}.${sig}`
  }

  verifyMediaToken(token: string): { a: string; c: string; i: string } {
    const [payload, sig] = String(token).split('.')
    if (!payload || !sig) throw new AppError('INVALID_TOKEN', 'invalid media link', 403)
    const exp = crypto.createHmac('sha256', this.settings.secret).update(payload).digest('base64url').slice(0, 32)
    if (sig.length !== exp.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(exp))) throw new AppError('INVALID_TOKEN', 'invalid media link', 403)
    const d = JSON.parse(Buffer.from(payload, 'base64url').toString())
    if (d.e < Date.now() / 1000) throw new AppError('EXPIRED', 'media link expired', 410)
    return d
  }

  async stats(acc: BotAccount) {
    const db = this.h.db
    const n = (r: { n?: unknown } | undefined) => Number(r?.n ?? 0)
    const count = (t: string) => db.selectFrom(t).select((eb) => eb.fn.countAll().as('n')).where('account_id', '=', acc.id)
    return {
      messages: n(await count('messages').executeTakeFirst()),
      chats: n(await count('chats').executeTakeFirst()),
      // the bot itself is in contacts too (sender of its own messages): not one of the people
      people: n(await count('contacts').where('user_id', '!=', acc.id).executeTakeFirst()),
      groups: n(await count('chats').where('type', 'in', ['group', 'supergroup']).executeTakeFirst()),
      channels: n(await count('chats').where('type', '=', 'channel').executeTakeFirst()),
    }
  }
}
