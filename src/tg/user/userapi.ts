/**
 * The Bot API calls TeleOps makes, answered over MTProto for a Telegram user account (GramJS).
 * BotAccount and TgService call `call('sendMessage', …)` the same way for a bot and for a person;
 * here each call becomes the MTProto request that does the same thing, and the answer gets the Bot API shape.
 */
import bigInt from 'big-integer'
import { Api, type TelegramClient } from 'telegram'
import { CustomFile } from 'telegram/client/uploads.js'
import { FloodWaitError } from 'telegram/errors/index.js'
import { generateRandomBigInt } from 'telegram/Helpers.js'
import { AppError } from '../../util.js'
import { TgApiError, type CallOpts, type TgCaller } from '../api.js'
import type { TgChatMember, TgInviteLink, TgMessage } from '../types.js'
import { chatOf, entityKey, fullInfoOf, meOf, peerKey, rightsOf, splitKey, toTgMessage, userOf, type Entity } from './convert.js'

/** What the account gives the API: who it is and the people/chats it has met (names, kinds). */
export interface UserHost {
  readonly id: string
  lookup(key: string): Entity | undefined
  remember(list: unknown[]): void
  /** Read the chat list again (puts every chat in GramJS's cache of access hashes). */
  refreshDialogs(): Promise<void>
  /** A message this account just sent through TeleOps (its update must not be announced twice). */
  sentHere(chat: string, id: number): void
}

const MEDIA_FIELD: Record<string, string> = {
  sendPhoto: 'photo',
  sendVideo: 'video',
  sendAudio: 'audio',
  sendVoice: 'voice',
  sendDocument: 'document',
  sendSticker: 'sticker',
  sendAnimation: 'animation',
  sendVideoNote: 'video_note',
}

const BOTS_ONLY = new Set(['setMyDescription', 'setMyCommands', 'deleteMyCommands', 'setMySettings', 'answerCallbackQuery', 'getUpdates', 'deleteWebhook', 'setWebhook', 'getWebhookInfo'])

type P = Record<string, unknown>

export function botsOnly(): AppError {
  return new AppError('BOTS_ONLY', 'Only bots have this, not a Telegram account', 400)
}

/** A GramJS / Telegram failure in the words the Bot API uses, so BotAccount.asAppError explains it the same way. */
export function toTgError(method: string, e: unknown): Error {
  if (e instanceof AppError || e instanceof TgApiError) return e
  const err = e as { errorMessage?: string; code?: number; message?: string; seconds?: number }
  const m = String(err?.errorMessage ?? '')
  const text = `${m} ${err?.message ?? ''}`
  if (e instanceof FloodWaitError || /^FLOOD_(PREMIUM_)?WAIT/.test(m)) {
    const s = Number(err.seconds ?? m.match(/(\d+)$/)?.[1] ?? 5)
    return new TgApiError(method, 429, `Too Many Requests: retry after ${s}`, s)
  }
  if (/AUTH_KEY_UNREGISTERED|AUTH_KEY_INVALID|SESSION_REVOKED|SESSION_EXPIRED|USER_DEACTIVATED|AUTH_KEY_DUPLICATED/.test(m)) return new TgApiError(method, 401, `Unauthorized: ${m}`)
  if (/Could not find the input entity|Cannot find any entity|PEER_ID_INVALID|CHANNEL_INVALID|CHAT_ID_INVALID|USERNAME_NOT_OCCUPIED|USERNAME_INVALID|USER_ID_INVALID|INPUT_USER_DEACTIVATED/.test(text)) return new TgApiError(method, 400, 'Bad Request: chat not found')
  if (/CHANNEL_PRIVATE|USER_NOT_PARTICIPANT|CHAT_FORBIDDEN/.test(m)) return new TgApiError(method, 403, 'Forbidden: not a member of the chat')
  if (/MESSAGE_ID_INVALID|MESSAGE_IDS_EMPTY/.test(m)) return new TgApiError(method, 400, 'Bad Request: message not found')
  if (/MESSAGE_NOT_MODIFIED/.test(m)) return new TgApiError(method, 400, 'Bad Request: message is not modified')
  if (/MESSAGE_EDIT_TIME_EXPIRED|MESSAGE_AUTHOR_REQUIRED/.test(m)) return new TgApiError(method, 400, `Bad Request: message can't be edited (${m})`)
  if (/MESSAGE_DELETE_FORBIDDEN/.test(m)) return new TgApiError(method, 400, `Bad Request: message can't be deleted (${m})`)
  if (/YOU_BLOCKED_USER/.test(m)) return new AppError('YOU_BLOCKED', 'You blocked this person on Telegram: unblock them first', 403)
  if (/USER_IS_BLOCKED|USER_PRIVACY_RESTRICTED|PRIVACY_PREMIUM_REQUIRED/.test(m)) return new AppError('PRIVACY', 'This person does not accept messages from this account ({0})', 403, [m])
  if (/CHAT_WRITE_FORBIDDEN|CHAT_SEND_\w+_FORBIDDEN|CHAT_RESTRICTED|CHAT_ADMIN_REQUIRED|RIGHT_FORBIDDEN|USER_BANNED_IN_CHANNEL/.test(m)) return new TgApiError(method, 403, `Forbidden: not enough rights (${m})`)
  if (/ENTITY_BOUNDS_INVALID|ENTITIES_TOO_LONG|ENTITY_MENTION_USER_INVALID/.test(m)) return new TgApiError(method, 400, `Bad Request: can't parse entities (${m})`)
  return new TgApiError(method, err?.code && err.code >= 400 && err.code < 600 ? err.code : 400, m || String(err?.message ?? e).slice(0, 300))
}

const replyIdOf = (p: P): number | undefined => {
  const r = p.reply_parameters as { message_id?: number } | undefined
  const id = Number(r?.message_id ?? p.reply_to_message_id ?? 0)
  return id > 0 ? id : undefined
}

const parseModeOf = (v: unknown): string | false => (v === 'HTML' ? 'html' : v === 'Markdown' || v === 'MarkdownV2' ? 'md' : false)

export class UserApi implements TgCaller {
  constructor(
    readonly client: TelegramClient,
    private host: UserHost,
  ) {}

  scrub(s: string): string {
    return String(s ?? '')
  }

  async call<T>(method: string, params: P = {}, opts: CallOpts = {}): Promise<T> {
    if (BOTS_ONLY.has(method)) throw botsOnly()
    try {
      return (await this.dispatch(method, params, opts)) as T
    } catch (e) {
      throw toTgError(method, e)
    }
  }

  // ---------------------------------------------------------------- peers
  /** The input peer of a Bot API chat_id: a number (-100… channels, - groups), @username, or this account. */
  async peer(chat: unknown): Promise<Api.TypeInputPeer> {
    const s = String(chat ?? '').trim()
    if (!s) throw new TgApiError('peer', 400, 'Bad Request: chat not found')
    if (s === this.host.id || s === 'me') return new Api.InputPeerSelf()
    if (/^-?\d+$/.test(s)) {
      const k = splitKey(s)
      const peer =
        k.kind === 'user' ? new Api.PeerUser({ userId: bigInt(k.id) }) : k.kind === 'chat' ? new Api.PeerChat({ chatId: bigInt(k.id) }) : new Api.PeerChannel({ channelId: bigInt(k.id) })
      try {
        return await this.client.getInputEntity(peer)
      } catch {
        // not in the cache of access hashes yet: the chat list puts it there
        await this.host.refreshDialogs()
        return this.client.getInputEntity(peer)
      }
    }
    const username = s.replace(/^@/, '').replace(/^(?:https?:\/\/)?(?:t\.me|telegram\.me)\//i, '').replace(/\/+$/, '')
    const r = await this.client.invoke(new Api.contacts.ResolveUsername({ username }))
    this.host.remember([...r.users, ...r.chats])
    const key = peerKey(r.peer)
    const e = key ? this.host.lookup(key) : undefined
    if (!e) throw new TgApiError('peer', 400, 'Bad Request: chat not found')
    return this.client.getInputEntity(e)
  }

  private async inputUser(peer: Api.TypeInputPeer): Promise<Api.TypeInputUser> {
    if (peer instanceof Api.InputPeerSelf) return new Api.InputUserSelf()
    if (peer instanceof Api.InputPeerUser) return new Api.InputUser({ userId: peer.userId, accessHash: peer.accessHash })
    throw new TgApiError('user', 400, 'Bad Request: not a person')
  }

  private inputChannel(peer: Api.TypeInputPeer): Api.InputChannel {
    if (peer instanceof Api.InputPeerChannel) return new Api.InputChannel({ channelId: peer.channelId, accessHash: peer.accessHash })
    throw new TgApiError('channel', 400, 'Bad Request: not a supergroup or channel')
  }

  // ---------------------------------------------------------------- messages
  /** A message as the Bot API shows it, with the names this account knows. */
  convert(m: Api.Message | Api.MessageService): TgMessage {
    const key = peerKey(m.peerId) ?? ''
    const fromKey = peerKey(m.fromId)
    return toTgMessage(m, { me: this.host.id, chat: this.host.lookup(key), sender: fromKey ? this.host.lookup(fromKey) : undefined, lookup: (k) => this.host.lookup(k) })
  }

  private sent(m: Api.Message | Api.MessageService): TgMessage {
    const t = this.convert(m)
    this.host.sentHere(String(t.chat.id), t.message_id)
    return t
  }

  /** The message an MTProto answer carries (sendMedia, forwardMessages…). */
  private fromUpdates(r: Api.TypeUpdates): TgMessage {
    if (r instanceof Api.Updates || r instanceof Api.UpdatesCombined) {
      this.host.remember([...r.users, ...r.chats])
      for (const u of r.updates) {
        if ((u instanceof Api.UpdateNewMessage || u instanceof Api.UpdateNewChannelMessage) && (u.message instanceof Api.Message || u.message instanceof Api.MessageService)) return this.sent(u.message)
      }
    }
    if (r instanceof Api.UpdateShort && (r.update instanceof Api.UpdateNewMessage || r.update instanceof Api.UpdateNewChannelMessage) && r.update.message instanceof Api.Message) return this.sent(r.update.message)
    throw new TgApiError('send', 502, 'Telegram did not return the sent message')
  }

  /** The message behind a `mt:<chat>:<id>` reference. */
  async messageByRef(ref: string): Promise<Api.Message> {
    const m = String(ref).match(/^mt:(-?\d+):(\d+)$/)
    if (!m) throw new TgApiError('getFile', 400, 'Bad Request: this file reference is not from a Telegram account (a bot file_id does not work here)')
    const peer = await this.peer(m[1])
    const [msg] = await this.client.getMessages(peer, { ids: [Number(m[2])] })
    if (!(msg instanceof Api.Message)) throw new TgApiError('getFile', 400, 'Bad Request: message not found')
    return msg
  }

  // ---------------------------------------------------------------- dispatch
  private async dispatch(method: string, p: P, opts: CallOpts): Promise<unknown> {
    const c = this.client
    switch (method) {
      case 'getMe': {
        const me = (await c.getMe()) as Api.User
        this.host.remember([me])
        return meOf(me)
      }
      case 'sendMessage': {
        if (p.reply_markup) throw new AppError('BOTS_ONLY_BUTTONS', 'Buttons under a message are for bots only: a Telegram account cannot send them', 400)
        const peer = await this.peer(p.chat_id)
        const linkOff = (p.link_preview_options as { is_disabled?: boolean } | undefined)?.is_disabled
        const msg = await c.sendMessage(peer, {
          message: String(p.text ?? ''),
          parseMode: parseModeOf(p.parse_mode),
          replyTo: replyIdOf(p) ?? (p.message_thread_id ? Number(p.message_thread_id) : undefined),
          silent: !!p.disable_notification,
          linkPreview: !linkOff,
        })
        return this.sent(msg)
      }
      case 'sendPhoto':
      case 'sendVideo':
      case 'sendAudio':
      case 'sendVoice':
      case 'sendDocument':
      case 'sendSticker':
      case 'sendAnimation':
      case 'sendVideoNote': {
        if (p.reply_markup) throw new AppError('BOTS_ONLY_BUTTONS', 'Buttons under a message are for bots only: a Telegram account cannot send them', 400)
        const field = MEDIA_FIELD[method]
        const peer = await this.peer(p.chat_id)
        const up = opts.files?.find((f) => f.field === field)
        let file: CustomFile | Api.TypeMessageMedia
        if (up) file = new CustomFile(up.fileName, up.data.length, '', up.data)
        else if (typeof p[field] === 'string') {
          const media = (await this.messageByRef(String(p[field]))).media
          if (!media) throw new TgApiError(method, 400, 'Bad Request: that message has no media')
          file = media
        } else throw new TgApiError(method, 400, 'Bad Request: no file')
        const attributes: Api.TypeDocumentAttribute[] = []
        if (method === 'sendAnimation') attributes.push(new Api.DocumentAttributeAnimated())
        if (method === 'sendSticker') attributes.push(new Api.DocumentAttributeSticker({ alt: '', stickerset: new Api.InputStickerSetEmpty() }), new Api.DocumentAttributeImageSize({ w: 512, h: 512 }))
        const msg = await c.sendFile(peer, {
          file,
          caption: p.caption ? String(p.caption) : undefined,
          parseMode: p.caption ? parseModeOf(p.parse_mode) : false,
          replyTo: replyIdOf(p) ?? (p.message_thread_id ? Number(p.message_thread_id) : undefined),
          silent: !!p.disable_notification,
          forceDocument: method === 'sendDocument' || method === 'sendSticker',
          voiceNote: method === 'sendVoice',
          videoNote: method === 'sendVideoNote',
          supportsStreaming: method === 'sendVideo',
          ...(attributes.length ? { attributes } : {}),
          workers: 2,
        })
        return this.sent(msg)
      }
      case 'sendLocation':
      case 'sendVenue': {
        const peer = await this.peer(p.chat_id)
        const geoPoint = new Api.InputGeoPoint({ lat: Number(p.latitude), long: Number(p.longitude) })
        const media =
          method === 'sendVenue'
            ? new Api.InputMediaVenue({ geoPoint, title: String(p.title ?? ''), address: String(p.address ?? ''), provider: '', venueId: '', venueType: '' })
            : new Api.InputMediaGeoPoint({ geoPoint })
        const reply = replyIdOf(p)
        const r = await c.invoke(
          new Api.messages.SendMedia({ peer, media, message: '', randomId: generateRandomBigInt(), silent: !!p.disable_notification, ...(reply ? { replyTo: new Api.InputReplyToMessage({ replyToMsgId: reply }) } : {}) }),
        )
        return this.fromUpdates(r)
      }
      case 'forwardMessage':
      case 'copyMessage': {
        const fromPeer = await this.peer(p.from_chat_id)
        const toPeer = await this.peer(p.chat_id)
        const r = await c.invoke(
          new Api.messages.ForwardMessages({ fromPeer, toPeer, id: [Number(p.message_id)], randomId: [generateRandomBigInt()], silent: !!p.disable_notification, dropAuthor: method === 'copyMessage' }),
        )
        return this.fromUpdates(r)
      }
      case 'setMessageReaction': {
        const peer = await this.peer(p.chat_id)
        const list = ((p.reaction as { type: string; emoji?: string }[] | undefined) ?? []).filter((r) => r.type === 'emoji' && r.emoji)
        await c.invoke(new Api.messages.SendReaction({ peer, msgId: Number(p.message_id), reaction: list.map((r) => new Api.ReactionEmoji({ emoticon: String(r.emoji) })), big: !!p.is_big }))
        return true
      }
      case 'editMessageText':
      case 'editMessageCaption': {
        if (p.reply_markup) throw new AppError('BOTS_ONLY_BUTTONS', 'Buttons under a message are for bots only: a Telegram account cannot send them', 400)
        const peer = await this.peer(p.chat_id)
        const msg = await c.editMessage(peer, { message: Number(p.message_id), text: String(method === 'editMessageText' ? p.text ?? '' : p.caption ?? ''), parseMode: parseModeOf(p.parse_mode) })
        return this.convert(msg)
      }
      case 'deleteMessage':
      case 'deleteMessages': {
        const peer = await this.peer(p.chat_id)
        const ids = (Array.isArray(p.message_ids) ? p.message_ids : [p.message_id]).map(Number)
        await c.deleteMessages(peer, ids, { revoke: true })
        return true
      }
      case 'pinChatMessage': {
        const peer = await this.peer(p.chat_id)
        await c.pinMessage(peer, Number(p.message_id), { notify: !p.disable_notification })
        return true
      }
      case 'unpinChatMessage': {
        const peer = await this.peer(p.chat_id)
        let id = Number(p.message_id ?? 0)
        if (!id) id = (await this.full(peer)).pinned ?? 0
        if (id) await c.unpinMessage(peer, id)
        return true
      }
      case 'unpinAllChatMessages': {
        await c.unpinMessage(await this.peer(p.chat_id))
        return true
      }
      case 'createChatInviteLink': {
        const peer = await this.peer(p.chat_id)
        const r = await c.invoke(
          new Api.messages.ExportChatInvite({
            peer,
            title: p.name ? String(p.name) : undefined,
            expireDate: p.expire_date ? Number(p.expire_date) : undefined,
            usageLimit: p.member_limit ? Number(p.member_limit) : undefined,
            requestNeeded: p.creates_join_request ? true : undefined,
          }),
        )
        if (!(r instanceof Api.ChatInviteExported)) throw new TgApiError(method, 502, 'Telegram did not return a link')
        return { invite_link: r.link, name: r.title ?? undefined, expire_date: r.expireDate ?? undefined, member_limit: r.usageLimit ?? undefined, creates_join_request: !!r.requestNeeded } satisfies TgInviteLink
      }
      case 'getChat': {
        const peer = await this.peer(p.chat_id)
        const f = await this.full(peer)
        return fullInfoOf(f.entity, f.full)
      }
      case 'getChatMemberCount': {
        const peer = await this.peer(p.chat_id)
        if (peer instanceof Api.InputPeerUser || peer instanceof Api.InputPeerSelf) return 2
        return (await this.full(peer)).count ?? 0
      }
      case 'getChatAdministrators':
        return this.admins(await this.peer(p.chat_id))
      case 'getChatMember':
        return this.member(await this.peer(p.chat_id), String(p.user_id ?? this.host.id))
      case 'getFile':
        return { file_id: String(p.file_id), file_unique_id: String(p.file_id), file_path: String(p.file_id) }
      case 'getUserProfilePhotos': {
        if (String(p.user_id) !== this.host.id) throw new TgApiError(method, 400, 'Bad Request: only the photos of this account')
        const r = await c.invoke(new Api.photos.GetUserPhotos({ userId: new Api.InputUserSelf(), offset: 0, maxId: bigInt(0), limit: 1 }))
        const photos = r.photos.filter((x): x is Api.Photo => x instanceof Api.Photo)
        return {
          total_count: r instanceof Api.photos.PhotosSlice ? r.count : photos.length,
          photos: photos.map((ph) => {
            const big = ph.sizes.filter((s): s is Api.PhotoSize | Api.PhotoSizeProgressive => s instanceof Api.PhotoSize || s instanceof Api.PhotoSizeProgressive).pop()
            return [{ file_id: 'mtme:photo', file_unique_id: `p${ph.id}`, width: big?.w ?? 640, height: big?.h ?? 640 }]
          }),
        }
      }
      case 'setMyName': {
        const [first, ...rest] = String(p.name ?? '').trim().split(/\s+/)
        await c.invoke(new Api.account.UpdateProfile({ firstName: first, lastName: rest.join(' ') }))
        return true
      }
      case 'setMyShortDescription':
        await c.invoke(new Api.account.UpdateProfile({ about: String(p.short_description ?? '') }))
        return true
      case 'getMyShortDescription': {
        const r = await c.invoke(new Api.users.GetFullUser({ id: new Api.InputUserSelf() }))
        this.host.remember(r.users)
        return { short_description: r.fullUser.about ?? '' }
      }
      case 'getMyDescription':
        return { description: '' }
      case 'getMyCommands':
        return []
      case 'setMyProfilePhoto': {
        const up = opts.files?.find((f) => f.field === 'photo')
        if (!up) throw new TgApiError(method, 400, 'Bad Request: no photo')
        const file = await c.uploadFile({ file: new CustomFile(up.fileName, up.data.length, '', up.data), workers: 1 })
        await c.invoke(new Api.photos.UploadProfilePhoto({ file }))
        return true
      }
      case 'removeMyProfilePhoto': {
        const r = await c.invoke(new Api.photos.GetUserPhotos({ userId: new Api.InputUserSelf(), offset: 0, maxId: bigInt(0), limit: 1 }))
        const ph = r.photos.find((x): x is Api.Photo => x instanceof Api.Photo)
        if (ph) await c.invoke(new Api.photos.DeletePhotos({ id: [new Api.InputPhoto({ id: ph.id, accessHash: ph.accessHash, fileReference: ph.fileReference })] }))
        return true
      }
      default:
        throw new TgApiError(method, 400, `Bad Request: ${method} is not available for a Telegram account`)
    }
  }

  // ---------------------------------------------------------------- chats
  /** The full description of a chat, with what getChat / members / pinned need. */
  private async full(peer: Api.TypeInputPeer): Promise<{ entity: Entity; full?: Api.UserFull | Api.ChatFull | Api.ChannelFull; count?: number; pinned?: number }> {
    const c = this.client
    if (peer instanceof Api.InputPeerUser || peer instanceof Api.InputPeerSelf) {
      const r = await c.invoke(new Api.users.GetFullUser({ id: await this.inputUser(peer) }))
      this.host.remember(r.users)
      const id = peer instanceof Api.InputPeerSelf ? this.host.id : String(peer.userId)
      const u = r.users.find((x) => String(x.id) === id) as Api.User | undefined
      if (!u) throw new TgApiError('getChat', 400, 'Bad Request: chat not found')
      return { entity: u, full: r.fullUser, pinned: r.fullUser.pinnedMsgId }
    }
    if (peer instanceof Api.InputPeerChat) {
      const r = await c.invoke(new Api.messages.GetFullChat({ chatId: peer.chatId }))
      this.host.remember([...r.users, ...r.chats])
      const e = r.chats.find((x) => String(x.id) === String(peer.chatId)) as Entity | undefined
      if (!e) throw new TgApiError('getChat', 400, 'Bad Request: chat not found')
      const fc = r.fullChat
      const count = fc instanceof Api.ChatFull && fc.participants instanceof Api.ChatParticipants ? fc.participants.participants.length : e instanceof Api.Chat ? e.participantsCount : undefined
      return { entity: e, full: fc, count, pinned: fc.pinnedMsgId }
    }
    const r = await c.invoke(new Api.channels.GetFullChannel({ channel: this.inputChannel(peer) }))
    this.host.remember([...r.users, ...r.chats])
    const id = peer instanceof Api.InputPeerChannel ? String(peer.channelId) : ''
    const e = r.chats.find((x) => String(x.id) === id) as Entity | undefined
    if (!e) throw new TgApiError('getChat', 400, 'Bad Request: chat not found')
    const fc = r.fullChat
    return { entity: e, full: fc, count: fc instanceof Api.ChannelFull ? fc.participantsCount : undefined, pinned: fc.pinnedMsgId }
  }

  private async admins(peer: Api.TypeInputPeer): Promise<TgChatMember[]> {
    const c = this.client
    if (peer instanceof Api.InputPeerChannel) {
      const r = await c.invoke(new Api.channels.GetParticipants({ channel: this.inputChannel(peer), filter: new Api.ChannelParticipantsAdmins(), offset: 0, limit: 200, hash: bigInt(0) }))
      if (!(r instanceof Api.channels.ChannelParticipants)) return []
      this.host.remember([...r.users, ...r.chats])
      const user = (id: unknown) => {
        const u = r.users.find((x) => String(x.id) === String(id))
        return u ? userOf(u as Api.User) : { id: Number(String(id)) }
      }
      const out: TgChatMember[] = []
      for (const pt of r.participants) {
        if (pt instanceof Api.ChannelParticipantCreator) out.push({ status: 'creator', user: user(pt.userId), custom_title: pt.rank ?? undefined, ...rightsOf(pt.adminRights) })
        else if (pt instanceof Api.ChannelParticipantAdmin) out.push({ status: 'administrator', user: user(pt.userId), custom_title: pt.rank ?? undefined, ...rightsOf(pt.adminRights) })
      }
      return out
    }
    if (peer instanceof Api.InputPeerChat) {
      const r = await c.invoke(new Api.messages.GetFullChat({ chatId: peer.chatId }))
      this.host.remember([...r.users, ...r.chats])
      const fc = r.fullChat
      if (!(fc instanceof Api.ChatFull) || !(fc.participants instanceof Api.ChatParticipants)) return []
      const user = (id: unknown) => {
        const u = r.users.find((x) => String(x.id) === String(id))
        return u ? userOf(u as Api.User) : { id: Number(String(id)) }
      }
      return fc.participants.participants
        .filter((pt) => pt instanceof Api.ChatParticipantCreator || pt instanceof Api.ChatParticipantAdmin)
        .map((pt) => ({ status: pt instanceof Api.ChatParticipantCreator ? 'creator' : 'administrator', user: user(pt.userId) }))
    }
    throw new TgApiError('getChatAdministrators', 400, 'Bad Request: there are no administrators in the private chat')
  }

  private async member(peer: Api.TypeInputPeer, userId: string): Promise<TgChatMember> {
    const c = this.client
    const self = userId === this.host.id
    const meEntity = this.host.lookup(this.host.id)
    const userBase = self && meEntity instanceof Api.User ? userOf(meEntity) : { id: Number(userId) }
    if (peer instanceof Api.InputPeerChannel) {
      const participant = self ? new Api.InputPeerSelf() : await this.peer(userId)
      const r = await c.invoke(new Api.channels.GetParticipant({ channel: this.inputChannel(peer), participant }))
      this.host.remember([...r.users, ...r.chats])
      const pt = r.participant
      if (pt instanceof Api.ChannelParticipantCreator) return { status: 'creator', user: userBase, ...rightsOf(pt.adminRights) }
      if (pt instanceof Api.ChannelParticipantAdmin) return { status: 'administrator', user: userBase, ...rightsOf(pt.adminRights) }
      if (pt instanceof Api.ChannelParticipantBanned) return { status: pt.left ? 'left' : pt.bannedRights.viewMessages ? 'kicked' : 'restricted', user: userBase }
      if (pt instanceof Api.ChannelParticipantLeft) return { status: 'left', user: userBase }
      return { status: 'member', user: userBase }
    }
    if (peer instanceof Api.InputPeerChat) {
      const r = await c.invoke(new Api.messages.GetFullChat({ chatId: peer.chatId }))
      const fc = r.fullChat
      const list = fc instanceof Api.ChatFull && fc.participants instanceof Api.ChatParticipants ? fc.participants.participants : []
      const pt = list.find((x) => String(x.userId) === userId)
      if (!pt) return { status: 'left', user: userBase }
      return { status: pt instanceof Api.ChatParticipantCreator ? 'creator' : pt instanceof Api.ChatParticipantAdmin ? 'administrator' : 'member', user: userBase }
    }
    return { status: 'member', user: userBase }
  }

  // ---------------------------------------------------------------- files
  async download(filePath: string, maxBytes: number): Promise<Buffer> {
    let buf: Buffer | string | undefined
    try {
      if (filePath === 'mtme:photo') {
        buf = await this.client.downloadProfilePhoto('me', { isBig: true })
      } else {
        const msg = await this.messageByRef(filePath)
        const doc = msg.media instanceof Api.MessageMediaDocument && msg.media.document instanceof Api.Document ? msg.media.document : undefined
        if (doc && Number(doc.size) > maxBytes) throw new AppError('MEDIA_TOO_LARGE', 'media larger than the configured cap', 413)
        buf = await this.client.downloadMedia(msg, {})
      }
    } catch (e) {
      if (e instanceof AppError) throw e
      throw new AppError('MEDIA_DOWNLOAD_FAILED', 'Media download failed: {0}', 502, [String((toTgError('download', e) as Error).message).slice(0, 200)])
    }
    if (!buf || typeof buf === 'string' || !buf.length) throw new AppError('MEDIA_DOWNLOAD_FAILED', 'Media download failed: {0}', 502, ['empty'])
    if (buf.length > maxBytes) throw new AppError('MEDIA_TOO_LARGE', 'media larger than the configured cap', 413)
    return buf
  }
}

export { chatOf, entityKey }
