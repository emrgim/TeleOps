/**
 * The parts of the Telegram Bot API objects TeleOps reads (https://core.telegram.org/bots/api).
 * Everything else a message carries is kept as it came, in the stored raw JSON.
 */

export type TgUser = {
  id: number
  is_bot?: boolean
  first_name?: string
  last_name?: string
  username?: string
  language_code?: string
  is_premium?: boolean
}

/** getMe: the bot itself (Bot API 10.5 returns BotFullInfo). */
export type TgBotInfo = TgUser & {
  active_usernames?: string[]
  can_join_groups?: boolean
  can_read_all_group_messages?: boolean
  supports_inline_queries?: boolean
  can_connect_to_business?: boolean
  has_main_web_app?: boolean
  can_manage_bots?: boolean
}

export type TgChat = {
  id: number
  type: 'private' | 'group' | 'supergroup' | 'channel' | string
  title?: string
  username?: string
  first_name?: string
  last_name?: string
  is_forum?: boolean
  is_direct_messages?: boolean
}

export type TgChatFullInfo = TgChat & {
  description?: string
  bio?: string
  invite_link?: string
  active_usernames?: string[]
  photo?: { small_file_id: string; big_file_id: string }
  linked_chat_id?: number
  slow_mode_delay?: number
  message_auto_delete_time?: number
  has_protected_content?: boolean
  join_by_request?: boolean
  pinned_message?: TgMessage
  permissions?: Record<string, boolean>
}

export type TgPhotoSize = { file_id: string; file_unique_id: string; width: number; height: number; file_size?: number }

type TgFileBase = { file_id: string; file_unique_id: string; file_size?: number; mime_type?: string; file_name?: string }

export type TgMessage = {
  message_id: number
  message_thread_id?: number
  from?: TgUser
  sender_chat?: TgChat
  date: number
  edit_date?: number
  chat: TgChat
  forward_origin?: { type: string; date?: number; sender_user?: TgUser; sender_user_name?: string; sender_chat?: TgChat; chat?: TgChat; author_signature?: string }
  reply_to_message?: TgMessage
  media_group_id?: string
  author_signature?: string
  via_bot?: TgUser
  text?: string
  caption?: string
  photo?: TgPhotoSize[]
  video?: TgFileBase & { width?: number; height?: number; duration?: number }
  video_note?: TgFileBase & { length?: number; duration?: number }
  animation?: TgFileBase & { width?: number; height?: number; duration?: number }
  audio?: TgFileBase & { duration?: number; performer?: string; title?: string }
  voice?: TgFileBase & { duration?: number }
  document?: TgFileBase
  sticker?: TgFileBase & { emoji?: string; set_name?: string; is_animated?: boolean; is_video?: boolean; width?: number; height?: number }
  location?: { latitude: number; longitude: number; live_period?: number }
  venue?: { location: { latitude: number; longitude: number }; title: string; address: string }
  contact?: { phone_number: string; first_name: string; last_name?: string; user_id?: number }
  poll?: { id: string; question: string; options: { text: string; voter_count?: number }[]; is_anonymous?: boolean; type?: string }
  dice?: { emoji: string; value: number }
  checklist?: { title?: string; tasks?: { id: number; text: string }[] }
  story?: { chat?: TgChat; id?: number }
  game?: { title?: string }
  invoice?: { title?: string }
  live_photo?: unknown
  rich_message?: unknown
  widget?: unknown
  new_chat_members?: TgUser[]
  left_chat_member?: TgUser
  new_chat_title?: string
  new_chat_photo?: TgPhotoSize[]
  delete_chat_photo?: boolean
  group_chat_created?: boolean
  migrate_to_chat_id?: number
  migrate_from_chat_id?: number
  pinned_message?: { message_id: number; chat?: TgChat; text?: string; caption?: string; date?: number }
  message_auto_delete_timer_changed?: { message_auto_delete_time: number }
  // topics: in groups with topics, and in private chats with a bot that has topics on (Bot API 9.3+)
  forum_topic_created?: { name: string; icon_color?: number; icon_custom_emoji_id?: string; is_name_implicit?: boolean }
  forum_topic_edited?: { name?: string; icon_custom_emoji_id?: string }
  forum_topic_closed?: Record<string, never>
  forum_topic_reopened?: Record<string, never>
  write_access_allowed?: { from_request?: boolean; web_app_name?: string; from_attachment_menu?: boolean }
  is_topic_message?: boolean
  users_shared?: unknown
  chat_shared?: unknown
}

export type TgCallbackQuery = {
  id: string
  from: TgUser
  message?: TgMessage | { chat: TgChat; message_id: number; date: 0 }
  inline_message_id?: string
  chat_instance?: string
  data?: string
}

export type TgChatMember = { status: 'creator' | 'administrator' | 'member' | 'restricted' | 'left' | 'kicked' | string; user: TgUser; [k: string]: unknown }

export type TgChatMemberUpdated = {
  chat: TgChat
  from: TgUser
  date: number
  old_chat_member: TgChatMember
  new_chat_member: TgChatMember
  invite_link?: { invite_link: string; name?: string }
}

export type TgReactionType = { type: 'emoji'; emoji: string } | { type: 'custom_emoji'; custom_emoji_id: string } | { type: 'paid' } | { type: string; [k: string]: unknown }

export type TgMessageReactionUpdated = {
  chat: TgChat
  message_id: number
  user?: TgUser
  actor_chat?: TgChat
  date: number
  old_reaction: TgReactionType[]
  new_reaction: TgReactionType[]
}

export type TgChatJoinRequest = { chat: TgChat; from: TgUser; user_chat_id: number; date: number; bio?: string; invite_link?: { invite_link: string; name?: string } }

export type TgUpdate = {
  update_id: number
  message?: TgMessage
  edited_message?: TgMessage
  channel_post?: TgMessage
  edited_channel_post?: TgMessage
  callback_query?: TgCallbackQuery
  my_chat_member?: TgChatMemberUpdated
  chat_member?: TgChatMemberUpdated
  message_reaction?: TgMessageReactionUpdated
  chat_join_request?: TgChatJoinRequest
  [k: string]: unknown
}

export type TgFile = { file_id: string; file_unique_id: string; file_size?: number; file_path?: string }

export type TgBotCommand = { command: string; description: string }

export type TgWebhookInfo = { url: string; pending_update_count: number; last_error_message?: string; last_error_date?: number }

export type TgInviteLink = { invite_link: string; name?: string; creator?: TgUser; creates_join_request?: boolean; is_primary?: boolean; is_revoked?: boolean; expire_date?: number; member_limit?: number }

/** The update types TeleOps asks for (chat_member and message_reaction arrive only where the bot is an administrator). */
export const ALLOWED_UPDATES = ['message', 'edited_message', 'channel_post', 'edited_channel_post', 'callback_query', 'my_chat_member', 'chat_member', 'message_reaction'] as const
