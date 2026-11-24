/**
 * What a bot has seen, in the database: messages (received and sent), chats, the people who wrote.
 * A bot cannot read any history from Telegram, so this is the only memory of a chat.
 */
import { now, upsertMany, type DbHandle } from '../db/index.js'
import { logger } from '../log.js'
import type { TgChat, TgChatFullInfo, TgMessage, TgPhotoSize, TgUser } from './types.js'

export type MessageRow = {
  account_id: string
  chat_id: string
  id: string
  /** order of messages in the same second: Telegram's message number */
  seq: number
  from_me: number
  sender: string | null
  ts: number
  type: string
  text: string | null
  edited_at: number | null
  reply_to: string | null
  thread_id: string | null
  media: string | null
  reactions: string | null
  raw: string
}

export type ChatRow = {
  account_id: string
  chat_id: string
  type: string
  title: string | null
  username: string | null
  is_group: number
  member: string | null
  last_ts: number | null
  data: string | null
  updated_at: number | null
}

export type ContactRow = {
  account_id: string
  user_id: string
  username: string | null
  name: string | null
  first_name: string | null
  last_name: string | null
  is_bot: number
  lang: string | null
  seen_at: number | null
}

/** The file of a media message, as Telegram described it (enough to download it later with getFile). */
export type Media = {
  kind: string
  fileId: string
  fileUniqueId?: string
  mime?: string | null
  size?: number | null
  name?: string | null
  duration?: number | null
  width?: number | null
  height?: number | null
}

const MEDIA_KINDS = ['photo', 'video', 'animation', 'voice', 'audio', 'video_note', 'document', 'sticker'] as const

export const fullName = (u: { first_name?: string; last_name?: string } | null | undefined): string | null => [u?.first_name, u?.last_name].filter(Boolean).join(' ').trim() || null

export const chatTitle = (c: TgChat): string | null => c.title ?? fullName(c) ?? (c.username ? '@' + c.username : null)

export const isGroupType = (t: string | null | undefined) => t === 'group' || t === 'supergroup'

/** The kind of a message: text, photo, voice… or the service event it is. */
export function messageType(m: TgMessage): string {
  if (m.text !== undefined) return 'text'
  if (m.animation) return 'animation' // before document: an animation also carries `document`
  for (const k of MEDIA_KINDS) if ((m as Record<string, unknown>)[k]) return k
  if (m.venue) return 'venue'
  if (m.location) return 'location'
  if (m.contact) return 'contact'
  if (m.poll) return 'poll'
  if (m.dice) return 'dice'
  if (m.checklist) return 'checklist'
  if (m.story) return 'story'
  if (m.game) return 'game'
  if (m.invoice) return 'invoice'
  if (m.rich_message) return 'rich'
  if (m.widget) return 'widget'
  if (m.new_chat_members) return 'members_added'
  if (m.left_chat_member) return 'member_left'
  if (m.new_chat_title) return 'title_changed'
  if (m.new_chat_photo) return 'photo_changed'
  if (m.delete_chat_photo) return 'photo_removed'
  if (m.group_chat_created) return 'group_created'
  if (m.pinned_message) return 'pinned'
  if (m.migrate_to_chat_id || m.migrate_from_chat_id) return 'migrated'
  if (m.message_auto_delete_timer_changed) return 'auto_delete_changed'
  if (m.forum_topic_created) return 'topic_created'
  if (m.forum_topic_edited) return 'topic_edited'
  if (m.forum_topic_closed) return 'topic_closed'
  if (m.forum_topic_reopened) return 'topic_reopened'
  if (m.write_access_allowed) return 'write_access'
  return 'service'
}

/** Text of a message, or a short description of what it is (what agents and searches read). */
export function messageText(m: TgMessage): string | null {
  if (m.text) return m.text
  if (m.caption) return m.caption
  const who = (u?: TgUser) => fullName(u) ?? (u?.username ? '@' + u.username : String(u?.id ?? '?'))
  if (m.voice) return '[voice message]'
  if (m.audio) return `[audio]${[m.audio.performer, m.audio.title].filter(Boolean).length ? ' ' + [m.audio.performer, m.audio.title].filter(Boolean).join(' – ') : ''}`
  if (m.document && !m.animation) return `[document] ${m.document.file_name ?? ''}`.trim()
  if (m.animation) return '[GIF]'
  if (m.photo) return '[photo]'
  if (m.video) return '[video]'
  if (m.video_note) return '[video message]'
  if (m.sticker) return `[sticker] ${m.sticker.emoji ?? ''}`.trim()
  if (m.venue) return `[venue] ${[m.venue.title, m.venue.address, `${m.venue.location.latitude},${m.venue.location.longitude}`].filter(Boolean).join(' · ')}`
  if (m.location) return `[${m.location.live_period ? 'live location' : 'location'}] ${m.location.latitude},${m.location.longitude}`
  if (m.contact) return `[contact] ${[m.contact.first_name, m.contact.last_name].filter(Boolean).join(' ')} ${m.contact.phone_number}`.trim()
  if (m.poll) return `[poll] ${m.poll.question}: ${m.poll.options.map((o) => o.text).join(' / ')}`
  if (m.dice) return `[dice] ${m.dice.emoji} ${m.dice.value}`
  if (m.checklist) return `[checklist] ${m.checklist.title ?? ''}: ${(m.checklist.tasks ?? []).map((t) => t.text).join(' / ')}`
  if (m.story) return '[story]'
  if (m.game) return `[game] ${m.game.title ?? ''}`.trim()
  if (m.invoice) return `[invoice] ${m.invoice.title ?? ''}`.trim()
  if (m.rich_message) return '[rich message]'
  if (m.widget) return '[widget]'
  if (m.new_chat_members) return `[joined] ${m.new_chat_members.map(who).join(', ')}`
  if (m.left_chat_member) return `[left] ${who(m.left_chat_member)}`
  if (m.new_chat_title) return `[title] ${m.new_chat_title}`
  if (m.new_chat_photo) return '[new chat photo]'
  if (m.delete_chat_photo) return '[chat photo removed]'
  if (m.group_chat_created) return '[group created]'
  if (m.pinned_message) return `[pinned] ${m.pinned_message.text ?? m.pinned_message.caption ?? `message ${m.pinned_message.message_id}`}`
  if (m.migrate_to_chat_id) return `[group upgraded to supergroup ${m.migrate_to_chat_id}]`
  if (m.migrate_from_chat_id) return `[supergroup created from group ${m.migrate_from_chat_id}]`
  if (m.message_auto_delete_timer_changed) return `[auto-delete] ${m.message_auto_delete_timer_changed.message_auto_delete_time} s`
  if (m.forum_topic_created) return `[topic] ${m.forum_topic_created.name}`
  if (m.forum_topic_edited) return `[topic renamed] ${m.forum_topic_edited.name ?? ''}`.trim()
  if (m.forum_topic_closed) return '[topic closed]'
  if (m.forum_topic_reopened) return '[topic reopened]'
  if (m.write_access_allowed) return '[the bot may write here]'
  return null
}

/** The file of a media message (largest size for photos). */
export function mediaOf(m: TgMessage): Media | null {
  if (m.photo?.length) {
    const p = m.photo.reduce((a: TgPhotoSize, b: TgPhotoSize) => ((b.file_size ?? b.width * b.height) > (a.file_size ?? a.width * a.height) ? b : a))
    return { kind: 'photo', fileId: p.file_id, fileUniqueId: p.file_unique_id, mime: 'image/jpeg', size: p.file_size ?? null, width: p.width, height: p.height, name: null, duration: null }
  }
  for (const k of ['animation', 'video', 'voice', 'audio', 'video_note', 'document', 'sticker'] as const) {
    const f = m[k] as (Record<string, unknown> & { file_id: string }) | undefined
    if (!f) continue
    let mime = (f.mime_type as string | undefined) ?? null
    if (!mime) mime = k === 'voice' ? 'audio/ogg' : k === 'video_note' ? 'video/mp4' : k === 'sticker' ? (f.is_video ? 'video/webm' : f.is_animated ? 'application/x-tgsticker' : 'image/webp') : null
    return {
      kind: k,
      fileId: f.file_id,
      fileUniqueId: f.file_unique_id as string | undefined,
      mime,
      size: (f.file_size as number | undefined) ?? null,
      name: (f.file_name as string | undefined) ?? null,
      duration: (f.duration as number | undefined) ?? null,
      width: (f.width as number | undefined) ?? (f.length as number | undefined) ?? null,
      height: (f.height as number | undefined) ?? (f.length as number | undefined) ?? null,
    }
  }
  return null
}

/** Who wrote a message: the user, or the chat it was posted as (channels, anonymous admins). */
export function senderOf(m: TgMessage): string | null {
  if (m.sender_chat) return String(m.sender_chat.id)
  if (m.from) return String(m.from.id)
  return m.chat.type === 'channel' ? String(m.chat.id) : null
}

export class TgStore {
  constructor(
    private h: DbHandle,
    private accountId: string,
    private botId: () => string,
  ) {}

  // ---------------------------------------------------------------- messages
  toRow(m: TgMessage, fromMe: boolean): MessageRow {
    const media = mediaOf(m)
    return {
      account_id: this.accountId,
      chat_id: String(m.chat.id),
      id: String(m.message_id),
      seq: m.message_id,
      from_me: fromMe ? 1 : 0,
      sender: fromMe ? this.botId() : senderOf(m),
      ts: m.date || Math.floor(now() / 1000),
      type: messageType(m),
      text: messageText(m),
      edited_at: m.edit_date ?? null,
      reply_to: m.reply_to_message ? String(m.reply_to_message.message_id) : null,
      thread_id: m.message_thread_id ? String(m.message_thread_id) : null,
      media: media ? JSON.stringify(media) : null,
      reactions: null,
      raw: JSON.stringify(m).slice(0, 200_000),
    }
  }

  /** Store messages (new or edited) with their chat and the people in them. */
  async upsertMessages(list: { m: TgMessage; fromMe: boolean }[]): Promise<MessageRow[]> {
    const rows: MessageRow[] = []
    for (const { m, fromMe } of list) {
      try {
        rows.push(this.toRow(m, fromMe))
      } catch (e) {
        logger.debug({ err: String(e) }, 'message row failed')
        continue
      }
      await this.upsertChat(m.chat, { ts: m.date })
      const people = [m.from, m.reply_to_message?.from, m.left_chat_member, ...(m.new_chat_members ?? []), m.forward_origin?.sender_user, m.via_bot].filter((u): u is TgUser => !!u && !!u.id)
      if (people.length) await this.upsertUsers(people)
      if (m.sender_chat && m.sender_chat.id !== m.chat.id) await this.upsertChat(m.sender_chat, { touch: false })
    }
    if (!rows.length) return rows
    // keep reactions already recorded on a message that gets edited
    await upsertMany(this.h, 'messages', rows, ['account_id', 'chat_id', 'id'], ['seq', 'from_me', 'sender', 'ts', 'type', 'text', 'edited_at', 'reply_to', 'thread_id', 'media', 'raw'])
    return rows
  }

  async loadRow(chat: string, id: string): Promise<MessageRow | undefined> {
    return (await this.h.db.selectFrom('messages').selectAll().where('account_id', '=', this.accountId).where('chat_id', '=', chat).where('id', '=', id).executeTakeFirst()) as MessageRow | undefined
  }

  /** A message by its id alone (message ids repeat across chats: the newest wins). */
  async loadById(id: string): Promise<MessageRow | undefined> {
    return (await this.h.db.selectFrom('messages').selectAll().where('account_id', '=', this.accountId).where('id', '=', id).orderBy('ts', 'desc').executeTakeFirst()) as MessageRow | undefined
  }

  async markDeleted(chat: string, ids: string[]): Promise<void> {
    if (!ids.length) return
    await this.h.db.updateTable('messages').set({ type: 'deleted', text: '[deleted]' }).where('account_id', '=', this.accountId).where('chat_id', '=', chat).where('id', 'in', ids).execute()
  }

  /** Reactions of one person on a message (an empty list takes them away). */
  async setReactions(chat: string, id: string, who: string, emojis: string[]): Promise<Record<string, string[]> | null> {
    const row = await this.loadRow(chat, id)
    if (!row) return null
    let map: Record<string, string[]> = {}
    try {
      map = row.reactions ? (JSON.parse(row.reactions) as Record<string, string[]>) : {}
    } catch {
      map = {}
    }
    if (emojis.length) map[who] = emojis
    else delete map[who]
    await this.h.db.updateTable('messages').set({ reactions: Object.keys(map).length ? JSON.stringify(map) : null }).where('account_id', '=', this.accountId).where('chat_id', '=', chat).where('id', '=', id).execute()
    return map
  }

  /** A group became a supergroup: its messages and chat move to the new id. */
  async migrateChat(from: string, to: string): Promise<void> {
    if (from === to) return
    const db = this.h.db
    await db.transaction().execute(async (tx) => {
      const ids = new Set((await tx.selectFrom('messages').select('id').where('account_id', '=', this.accountId).where('chat_id', '=', to).execute()).map((r) => r.id as string))
      const old = (await tx.selectFrom('messages').select('id').where('account_id', '=', this.accountId).where('chat_id', '=', from).execute()).map((r) => r.id as string)
      const dup = old.filter((i) => ids.has(i))
      for (let i = 0; i < dup.length; i += 500) await tx.deleteFrom('messages').where('account_id', '=', this.accountId).where('chat_id', '=', from).where('id', 'in', dup.slice(i, i + 500)).execute()
      await tx.updateTable('messages').set({ chat_id: to }).where('account_id', '=', this.accountId).where('chat_id', '=', from).execute()
      await tx.updateTable('transcripts').set({ chat_id: to }).where('account_id', '=', this.accountId).where('chat_id', '=', from).execute()
      const newer = await tx.selectFrom('chats').select('chat_id').where('account_id', '=', this.accountId).where('chat_id', '=', to).executeTakeFirst()
      if (newer) await tx.updateTable('chats').set({ member: 'left' }).where('account_id', '=', this.accountId).where('chat_id', '=', from).execute()
      else await tx.updateTable('chats').set({ chat_id: to, type: 'supergroup' }).where('account_id', '=', this.accountId).where('chat_id', '=', from).execute()
    })
    logger.info({ account: this.accountId, from, to }, 'group upgraded to supergroup: chat moved')
  }

  // ---------------------------------------------------------------- chats
  async chat(chatId: string): Promise<ChatRow | undefined> {
    return (await this.h.db.selectFrom('chats').selectAll().where('account_id', '=', this.accountId).where('chat_id', '=', chatId).executeTakeFirst()) as ChatRow | undefined
  }

  /** Remember a chat; `ts` moves its last activity forward, `member` records the bot's membership. */
  async upsertChat(c: TgChat | TgChatFullInfo, o: { ts?: number; member?: string; full?: boolean; touch?: boolean } = {}): Promise<void> {
    const id = String(c.id)
    const ex = await this.chat(id)
    const row: ChatRow = {
      account_id: this.accountId,
      chat_id: id,
      type: c.type ?? ex?.type ?? 'private',
      title: chatTitle(c) ?? ex?.title ?? null,
      username: c.username ?? (o.full ? null : ex?.username ?? null),
      is_group: isGroupType(c.type ?? ex?.type) ? 1 : 0,
      member: o.member ?? ex?.member ?? null,
      last_ts: o.touch === false ? ex?.last_ts ?? null : Math.max(Number(ex?.last_ts ?? 0), Number(o.ts ?? 0)) || ex?.last_ts || null,
      data: o.full ? JSON.stringify(c).slice(0, 50_000) : ex?.data ?? null,
      updated_at: now(),
    }
    await upsertMany(this.h, 'chats', [row as unknown as Record<string, unknown>], ['account_id', 'chat_id'])
    if (c.type === 'private') await this.upsertUsers([{ id: c.id, first_name: c.first_name, last_name: c.last_name, username: c.username }], false)
  }

  async setMember(chatId: string, member: string): Promise<void> {
    await this.h.db.updateTable('chats').set({ member, updated_at: now() }).where('account_id', '=', this.accountId).where('chat_id', '=', chatId).execute()
  }

  // ---------------------------------------------------------------- people
  async upsertUsers(users: TgUser[], seen = true): Promise<void> {
    const byId = new Map<number, TgUser>()
    for (const u of users) if (u?.id) byId.set(u.id, { ...(byId.get(u.id) ?? {}), ...u })
    const rows: Record<string, unknown>[] = []
    for (const u of byId.values()) {
      const ex = (await this.h.db.selectFrom('contacts').selectAll().where('account_id', '=', this.accountId).where('user_id', '=', String(u.id)).executeTakeFirst()) as ContactRow | undefined
      const first = u.first_name ?? ex?.first_name ?? null
      const last = u.first_name !== undefined ? u.last_name ?? null : ex?.last_name ?? null
      rows.push({
        account_id: this.accountId,
        user_id: String(u.id),
        username: u.username ?? (u.first_name !== undefined ? null : ex?.username ?? null),
        name: fullName({ first_name: first ?? undefined, last_name: last ?? undefined }) ?? ex?.name ?? null,
        first_name: first,
        last_name: last,
        is_bot: u.is_bot ? 1 : ex?.is_bot ?? 0,
        lang: u.language_code ?? ex?.lang ?? null,
        seen_at: seen ? now() : ex?.seen_at ?? null,
      })
    }
    if (rows.length) await upsertMany(this.h, 'contacts', rows, ['account_id', 'user_id'])
  }

  async user(userId: string): Promise<ContactRow | undefined> {
    return (await this.h.db.selectFrom('contacts').selectAll().where('account_id', '=', this.accountId).where('user_id', '=', userId).executeTakeFirst()) as ContactRow | undefined
  }

  /** Name of a chat or a person, as Telegram shows it. */
  async nameOf(id: string | null | undefined): Promise<string | null> {
    if (!id) return null
    if (id === this.botId()) return null
    const u = await this.user(id)
    if (u?.name) return u.name
    const c = await this.chat(id)
    return c?.title ?? (u?.username ? '@' + u.username : null)
  }

  async usernameOf(id: string | null | undefined): Promise<string | null> {
    if (!id) return null
    const u = await this.user(id)
    if (u?.username) return u.username
    return (await this.chat(id))?.username ?? null
  }
}
