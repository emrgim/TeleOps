/**
 * Telegram's MTProto objects (GramJS) turned into the Bot API shapes the rest of TeleOps stores and shows,
 * so a message of a user account looks like a message of a bot: same chat ids (-100… for supergroups and
 * channels, - for basic groups), same fields (text/caption, photo, voice, document…, service events).
 *
 * Files have no Bot API file_id here: `mt:<chat>:<message>` points at the message, downloaded again over MTProto.
 */
import { Api } from 'telegram'
import type { TgBotInfo, TgChat, TgChatFullInfo, TgMessage, TgPhotoSize, TgUser } from '../types.js'

export type Entity = Api.User | Api.Chat | Api.Channel | Api.ChatForbidden | Api.ChannelForbidden | Api.UserEmpty | Api.ChatEmpty

/** The Telegram id of a peer the way the Bot API writes it: users as is, groups with -, channels with -100. */
export function peerKey(p: Api.TypePeer | undefined | null): string | null {
  if (!p) return null
  if (p instanceof Api.PeerUser) return String(p.userId)
  if (p instanceof Api.PeerChat) return '-' + String(p.chatId)
  if (p instanceof Api.PeerChannel) return '-100' + String(p.channelId)
  return null
}

/** Same for an entity (a user, a group, a channel). */
export function entityKey(e: Entity | undefined | null): string | null {
  if (!e) return null
  if (e instanceof Api.User || e instanceof Api.UserEmpty) return String(e.id)
  if (e instanceof Api.Chat || e instanceof Api.ChatForbidden || e instanceof Api.ChatEmpty) return '-' + String(e.id)
  if (e instanceof Api.Channel || e instanceof Api.ChannelForbidden) return '-100' + String(e.id)
  return null
}

/** What a Bot API chat id is made of. */
export function splitKey(key: string): { kind: 'user' | 'chat' | 'channel'; id: string } {
  const k = String(key).trim()
  if (k.startsWith('-100') && k.length > 4) return { kind: 'channel', id: k.slice(4) }
  if (k.startsWith('-')) return { kind: 'chat', id: k.slice(1) }
  return { kind: 'user', id: k }
}

export const fileRef = (chat: string, msgId: number) => `mt:${chat}:${msgId}`

const usernameOf = (e: { username?: string; usernames?: Api.TypeUsername[] }) =>
  e.username ?? (e.usernames ?? []).find((u) => u instanceof Api.Username && u.active)?.username ?? undefined

export function userOf(u: Api.User | Api.UserEmpty): TgUser {
  if (u instanceof Api.UserEmpty) return { id: Number(u.id) }
  return {
    id: Number(u.id),
    is_bot: !!u.bot,
    first_name: u.firstName ?? (u.deleted ? 'Deleted Account' : undefined),
    last_name: u.lastName ?? undefined,
    username: usernameOf(u),
    language_code: u.langCode ?? undefined,
    is_premium: u.premium || undefined,
  }
}

export function chatOf(e: Entity): TgChat {
  if (e instanceof Api.User || e instanceof Api.UserEmpty) {
    const u = userOf(e)
    return { id: u.id, type: 'private', first_name: u.first_name, last_name: u.last_name, username: u.username }
  }
  if (e instanceof Api.Chat || e instanceof Api.ChatForbidden || e instanceof Api.ChatEmpty) {
    return { id: -Number(e.id), type: 'group', title: 'title' in e ? e.title : undefined }
  }
  const c = e as Api.Channel | Api.ChannelForbidden
  const broadcast = c instanceof Api.Channel ? !!c.broadcast && !c.megagroup : !!c.broadcast
  return {
    id: Number('-100' + String(c.id)),
    type: broadcast ? 'channel' : 'supergroup',
    title: c.title,
    username: c instanceof Api.Channel ? usernameOf(c) : undefined,
    is_forum: c instanceof Api.Channel ? !!c.forum || undefined : undefined,
  }
}

/** A chat we only know by its id (no entity at hand): its kind from the id. */
export function bareChat(key: string, post = false): TgChat {
  const s = splitKey(key)
  return { id: Number(key), type: s.kind === 'user' ? 'private' : s.kind === 'chat' ? 'group' : post ? 'channel' : 'supergroup' }
}

/** getMe of a user account, in the shape of the bot's getMe (and its phone, kept for the owner's eyes only). */
export function meOf(u: Api.User): TgBotInfo & { phone?: string } {
  return {
    ...userOf(u),
    is_bot: false,
    active_usernames: (u.usernames ?? []).filter((x) => x instanceof Api.Username && x.active).map((x) => (x as Api.Username).username),
    ...(u.phone ? { phone: '+' + u.phone.replace(/^\+/, '') } : {}),
  }
}

/** +971 50 •••• 123 style: enough to recognise the number, not enough to copy it. */
export function maskPhone(p?: string | null): string | null {
  if (!p) return null
  const d = p.replace(/[^\d]/g, '')
  if (d.length < 6) return '+' + d
  return `+${d.slice(0, Math.min(3, d.length - 5))} ••• ${d.slice(-3)}`
}

const textOf = (t: unknown): string => (typeof t === 'string' ? t : t && typeof t === 'object' && 'text' in t ? String((t as { text: unknown }).text ?? '') : '')

function photoSizes(photo: Api.TypePhoto | undefined, ref: string): TgPhotoSize[] | undefined {
  if (!(photo instanceof Api.Photo)) return undefined
  const out: TgPhotoSize[] = []
  for (const s of photo.sizes) {
    if (s instanceof Api.PhotoSize) out.push({ file_id: ref, file_unique_id: `p${photo.id}${s.type}`, width: s.w, height: s.h, file_size: s.size })
    else if (s instanceof Api.PhotoSizeProgressive) out.push({ file_id: ref, file_unique_id: `p${photo.id}${s.type}`, width: s.w, height: s.h, file_size: Math.max(0, ...s.sizes) })
    else if (s instanceof Api.PhotoCachedSize) out.push({ file_id: ref, file_unique_id: `p${photo.id}${s.type}`, width: s.w, height: s.h, file_size: s.bytes.length })
  }
  return out.length ? out : [{ file_id: ref, file_unique_id: `p${photo.id}`, width: 0, height: 0 }]
}

/** The media of a message as Bot API fields (photo, voice, document…). */
function mediaFields(media: Api.TypeMessageMedia | undefined, ref: string): Partial<TgMessage> {
  if (!media) return {}
  if (media instanceof Api.MessageMediaPhoto) {
    const photo = photoSizes(media.photo, ref)
    return photo ? { photo } : {}
  }
  if (media instanceof Api.MessageMediaDocument) {
    const d = media.document
    if (!(d instanceof Api.Document)) return {}
    const base = { file_id: ref, file_unique_id: `d${d.id}`, file_size: Number(d.size), mime_type: d.mimeType || undefined }
    const attr = <T>(cls: new (...a: never[]) => T): T | undefined => d.attributes.find((a) => a instanceof cls) as T | undefined
    const name = attr(Api.DocumentAttributeFilename)?.fileName
    const audio = attr(Api.DocumentAttributeAudio)
    const video = attr(Api.DocumentAttributeVideo)
    const sticker = attr(Api.DocumentAttributeSticker)
    const image = attr(Api.DocumentAttributeImageSize)
    if (sticker) return { sticker: { ...base, emoji: sticker.alt || undefined, is_animated: d.mimeType === 'application/x-tgsticker', is_video: d.mimeType === 'video/webm', width: image?.w ?? video?.w, height: image?.h ?? video?.h } }
    if (attr(Api.DocumentAttributeAnimated)) {
      const animation = { ...base, file_name: name, width: video?.w, height: video?.h, duration: video ? Math.round(video.duration) : undefined }
      return { animation, document: { ...base, file_name: name } }
    }
    if (audio?.voice || media.voice) return { voice: { ...base, duration: audio?.duration } }
    if (audio) return { audio: { ...base, file_name: name, duration: audio.duration, performer: audio.performer ?? undefined, title: audio.title ?? undefined } }
    if (video?.roundMessage || media.round) return { video_note: { ...base, length: video?.w, duration: video ? Math.round(video.duration) : undefined } }
    if (video) return { video: { ...base, file_name: name, width: video.w, height: video.h, duration: Math.round(video.duration) } }
    return { document: { ...base, file_name: name } }
  }
  if (media instanceof Api.MessageMediaVenue && media.geo instanceof Api.GeoPoint) {
    const location = { latitude: media.geo.lat, longitude: media.geo.long }
    return { venue: { location, title: media.title, address: media.address }, location }
  }
  if (media instanceof Api.MessageMediaGeoLive && media.geo instanceof Api.GeoPoint) return { location: { latitude: media.geo.lat, longitude: media.geo.long, live_period: media.period } }
  if (media instanceof Api.MessageMediaGeo && media.geo instanceof Api.GeoPoint) return { location: { latitude: media.geo.lat, longitude: media.geo.long } }
  if (media instanceof Api.MessageMediaContact) return { contact: { phone_number: media.phoneNumber, first_name: media.firstName, last_name: media.lastName || undefined, user_id: media.userId && String(media.userId) !== '0' ? Number(media.userId) : undefined } }
  if (media instanceof Api.MessageMediaPoll) {
    const p = media.poll
    return { poll: { id: String(p.id), question: textOf(p.question), options: p.answers.map((a, i) => ({ text: textOf(a.text), voter_count: media.results?.results?.[i]?.voters })), is_anonymous: !p.publicVoters, type: p.quiz ? 'quiz' : 'regular' } }
  }
  if (media instanceof Api.MessageMediaDice) return { dice: { emoji: media.emoticon, value: media.value } }
  if (media instanceof Api.MessageMediaStory) return { story: { id: media.id } }
  if (media instanceof Api.MessageMediaGame) return { game: { title: media.game.title } }
  if (media instanceof Api.MessageMediaInvoice) return { invoice: { title: media.title } }
  return {}
}

export type Lookup = (key: string) => Entity | undefined

/** A service message (someone joined, the title changed…) as the Bot API fields that describe it. */
function actionFields(a: Api.TypeMessageAction, m: Api.MessageService, lookup: Lookup, from?: TgUser): Partial<TgMessage> & { text?: string } {
  const user = (id: unknown): TgUser => {
    const e = lookup(String(id))
    return e instanceof Api.User ? userOf(e) : { id: Number(String(id)) }
  }
  if (a instanceof Api.MessageActionChatCreate || a instanceof Api.MessageActionChannelCreate) return { group_chat_created: true, new_chat_title: a.title }
  if (a instanceof Api.MessageActionChatEditTitle) return { new_chat_title: a.title }
  if (a instanceof Api.MessageActionChatEditPhoto) return { new_chat_photo: [] }
  if (a instanceof Api.MessageActionChatDeletePhoto) return { delete_chat_photo: true }
  if (a instanceof Api.MessageActionChatAddUser) return { new_chat_members: a.users.map(user) }
  if (a instanceof Api.MessageActionChatJoinedByLink || a instanceof Api.MessageActionChatJoinedByRequest) return from ? { new_chat_members: [from] } : {}
  if (a instanceof Api.MessageActionChatDeleteUser) return { left_chat_member: user(a.userId) }
  if (a instanceof Api.MessageActionPinMessage) {
    const r = m.replyTo instanceof Api.MessageReplyHeader ? m.replyTo.replyToMsgId : undefined
    return r ? { pinned_message: { message_id: r } } : {}
  }
  if (a instanceof Api.MessageActionChatMigrateTo) return { migrate_to_chat_id: Number('-100' + String(a.channelId)) }
  if (a instanceof Api.MessageActionChannelMigrateFrom) return { migrate_from_chat_id: -Number(a.chatId) }
  if (a instanceof Api.MessageActionSetMessagesTTL) return { message_auto_delete_timer_changed: { message_auto_delete_time: a.period } }
  if (a instanceof Api.MessageActionTopicCreate) return { forum_topic_created: { name: a.title, icon_color: a.iconColor } }
  if (a instanceof Api.MessageActionTopicEdit) {
    if (a.closed === true) return { forum_topic_closed: {} }
    if (a.closed === false) return { forum_topic_reopened: {} }
    return { forum_topic_edited: { name: a.title ?? undefined } }
  }
  if (a instanceof Api.MessageActionPhoneCall) {
    const mins = a.duration ? ` ${Math.max(1, Math.round(a.duration / 60))} min` : ''
    const missed = a.reason instanceof Api.PhoneCallDiscardReasonMissed ? ' missed' : a.reason instanceof Api.PhoneCallDiscardReasonBusy ? ' busy' : ''
    return { text: `[${a.video ? 'video call' : 'call'}${missed}${mins}]` }
  }
  return {}
}

/**
 * A message as the Bot API would show it. `chat` and `sender` are the entities when known (from the update or
 * the cache); without them the chat kind comes from its id and the sender is just an id.
 */
export function toTgMessage(m: Api.Message | Api.MessageService, o: { me: string; chat?: Entity; sender?: Entity; lookup?: Lookup }): TgMessage {
  const lookup = o.lookup ?? (() => undefined)
  const chatKey = peerKey(m.peerId) ?? entityKey(o.chat) ?? '0'
  const chat = o.chat ? chatOf(o.chat) : bareChat(chatKey, m instanceof Api.Message && !!m.post)
  // who wrote it: a user, or a chat (channel posts, anonymous admins, "send as" a channel)
  let from: TgUser | undefined
  let senderChat: TgChat | undefined
  let fromKey = peerKey(m.fromId)
  if (!fromKey) {
    if (m.out) fromKey = o.me
    else if (chat.type === 'private') fromKey = chatKey
  }
  if (fromKey && !fromKey.startsWith('-')) {
    const e = o.sender && entityKey(o.sender) === fromKey ? o.sender : lookup(fromKey)
    from = e instanceof Api.User || e instanceof Api.UserEmpty ? userOf(e) : { id: Number(fromKey) }
  } else if (fromKey) {
    const e = o.sender && entityKey(o.sender) === fromKey ? o.sender : fromKey === chatKey ? o.chat : lookup(fromKey)
    senderChat = e ? chatOf(e) : bareChat(fromKey, true)
  } else if (chat.type === 'channel') senderChat = chat
  const base: TgMessage = { message_id: m.id, date: m.date, chat, ...(from ? { from } : {}), ...(senderChat ? { sender_chat: senderChat } : {}) }
  const reply = m.replyTo instanceof Api.MessageReplyHeader ? m.replyTo : undefined
  if (reply?.forumTopic) {
    base.message_thread_id = reply.replyToTopId ?? reply.replyToMsgId
    base.is_topic_message = true
  }
  if (m instanceof Api.MessageService) {
    const { text, ...rest } = actionFields(m.action, m, lookup, from)
    // a topic is its first message: the thread is the message itself
    if (rest.forum_topic_created) {
      base.message_thread_id = m.id
      base.is_topic_message = true
    }
    return { ...base, ...rest, ...(text ? { text } : {}) }
  }
  if (reply?.replyToMsgId && !(reply.forumTopic && !reply.replyToTopId)) base.reply_to_message = { message_id: reply.replyToMsgId, date: 0, chat }
  if (m.editDate && !m.editHide) base.edit_date = m.editDate
  if (m.groupedId) base.media_group_id = String(m.groupedId)
  if (m.postAuthor) base.author_signature = m.postAuthor
  if (m.viaBotId) {
    const e = lookup(String(m.viaBotId))
    base.via_bot = e instanceof Api.User ? userOf(e) : { id: Number(m.viaBotId), is_bot: true }
  }
  if (m.fwdFrom) {
    const f = m.fwdFrom
    const k = peerKey(f.fromId)
    const e = k ? lookup(k) : undefined
    base.forward_origin =
      k && !k.startsWith('-')
        ? { type: 'user', date: f.date, sender_user: e instanceof Api.User ? userOf(e) : { id: Number(k) } }
        : k
          ? { type: 'channel', date: f.date, chat: e ? chatOf(e) : bareChat(k, true), author_signature: f.postAuthor ?? undefined }
          : { type: 'hidden_user', date: f.date, sender_user_name: f.fromName ?? undefined }
  }
  const media = m.media && !(m.media instanceof Api.MessageMediaWebPage) && !(m.media instanceof Api.MessageMediaEmpty) && !(m.media instanceof Api.MessageMediaUnsupported) ? m.media : undefined
  const fields = mediaFields(media, fileRef(String(chat.id), m.id))
  if (Object.keys(fields).length) return { ...base, ...fields, ...(m.message ? { caption: m.message } : {}) }
  return { ...base, text: m.message ?? '' }
}

/** getChat of a user account: what users.getFullUser / messages.getFullChat / channels.getFullChannel say. */
export function fullInfoOf(e: Entity, full: Api.UserFull | Api.ChatFull | Api.ChannelFull | undefined): TgChatFullInfo {
  const chat: TgChatFullInfo = { ...chatOf(e) }
  if (!full) return chat
  if (full instanceof Api.UserFull) {
    if (full.about) chat.bio = full.about
    return chat
  }
  if (full.about) chat.description = full.about
  if (full.exportedInvite instanceof Api.ChatInviteExported) chat.invite_link = full.exportedInvite.link
  if (full.pinnedMsgId) chat.pinned_message = { message_id: full.pinnedMsgId, date: 0, chat: { id: chat.id, type: chat.type } } as TgMessage
  if (full.ttlPeriod) chat.message_auto_delete_time = full.ttlPeriod
  if (full instanceof Api.ChannelFull) {
    if (full.linkedChatId) chat.linked_chat_id = Number('-100' + String(full.linkedChatId))
    if (full.slowmodeSeconds) chat.slow_mode_delay = full.slowmodeSeconds
  }
  if (e instanceof Api.Channel) {
    if (e.noforwards) chat.has_protected_content = true
    if (e.joinRequest) chat.join_by_request = true
  }
  return chat
}

/** A participant's rights in the Bot API words (can_…). */
export function rightsOf(r: Api.ChatAdminRights | undefined): Record<string, boolean> {
  if (!r) return {}
  return {
    can_change_info: !!r.changeInfo,
    can_post_messages: !!r.postMessages,
    can_edit_messages: !!r.editMessages,
    can_delete_messages: !!r.deleteMessages,
    can_restrict_members: !!r.banUsers,
    can_invite_users: !!r.inviteUsers,
    can_pin_messages: !!r.pinMessages,
    can_promote_members: !!r.addAdmins,
    can_manage_video_chats: !!r.manageCall,
    can_manage_chat: !!r.other,
    can_manage_topics: !!r.manageTopics,
    is_anonymous: !!r.anonymous,
  }
}
