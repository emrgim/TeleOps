/**
 * The owner's own Telegram account: login codes for the config page go there, sent by a bot.
 *
 * It is linked once from the config page (Settings → General): TeleOps shows a t.me link that opens
 * one of the bots with `/start <one-time token>`; when the owner presses Start, the bot that gets the
 * token records who pressed it. A bot cannot write first to anyone, so this is also what lets it write.
 */
import { getSetting, now, setSetting, type DbHandle } from './db/index.js'
import { defaultLang, tr } from './i18n.js'
import { logger } from './log.js'
import type { AdminAuth } from './security/auth.js'
import type { BotAccount } from './tg/account.js'
import type { AccountManager } from './tg/manager.js'
import { fullName } from './tg/store.js'
import type { TgMessage } from './tg/types.js'
import { AppError } from './util.js'

export type OwnerInfo = { id: string; name: string | null; username: string | null; bot: string; at: number }

const KEY = 'owner_telegram'
const LINK_MINUTES = 15

export class OwnerLink {
  constructor(
    private h: DbHandle,
    private admin: AdminAuth,
    private accounts: AccountManager,
  ) {}

  async get(): Promise<OwnerInfo | null> {
    try {
      const v = await getSetting(this.h, KEY)
      return v ? (JSON.parse(v) as OwnerInfo) : null
    } catch {
      return null
    }
  }

  async clear(): Promise<void> {
    await this.h.db.deleteFrom('settings').where('k', '=', KEY).execute()
  }

  /** The t.me link that links the owner's Telegram (valid 15 minutes, once). */
  async startLink(botId?: string): Promise<{ url: string; bot: string; username: string; expiresInMin: number }> {
    const acc = botId ? this.accounts.get(botId) : this.accounts.list().find((a) => a.row.is_default && a.state === 'open') ?? this.accounts.list().find((a) => a.state === 'open')
    if (!acc) throw new AppError('NO_CONNECTED_BOT', 'Link a bot first: the code comes from one of your bots', 409)
    if (acc.state !== 'open') throw new AppError('NOT_CONNECTED', 'Bot "{0}" is not connected (state: {1})', 409, [acc.displayName(), acc.state])
    if (!acc.row.username) throw new AppError('NO_USERNAME', 'This bot has no username on Telegram', 409)
    const token = await this.admin.createLoginToken('owner', LINK_MINUTES * 60_000)
    return { url: `https://t.me/${acc.row.username}?start=${token}`, bot: acc.id, username: acc.row.username, expiresInMin: LINK_MINUTES }
  }

  /** `/start <param>` reached a bot: an owner token links this person; anything else is left to the bot's chat. */
  async onStart(acc: BotAccount, m: TgMessage, param: string): Promise<boolean> {
    if (!/^own[A-Za-z0-9_-]{20,40}$/.test(param) || !m.from) return false
    const ok = await this.admin.consumeLoginToken('owner', param, `telegram:${m.from.id}`).catch(() => false)
    const lang = defaultLang()
    if (!ok) {
      await acc.send(String(m.chat.id), 'sendMessage', { text: tr(lang, '@owner_link_expired') }, { store: false }).catch(() => undefined)
      return true
    }
    const info: OwnerInfo = { id: String(m.from.id), name: fullName(m.from), username: m.from.username ?? null, bot: acc.id, at: now() }
    await setSetting(this.h, KEY, JSON.stringify(info))
    await acc.store.upsertUsers([m.from])
    logger.info({ mod: 'auth', bot: acc.id }, 'owner Telegram account linked: login codes go there')
    await acc.send(String(m.chat.id), 'sendMessage', { text: tr(lang, '@owner_linked', [acc.displayName()]) }, { store: false }).catch((e) => logger.warn({ err: String(e) }, 'owner link: confirmation not sent'))
    return true
  }

  /** Send a login code to the owner, from the bot they linked with (or another connected one). */
  async sendCode(code: string, lang = defaultLang()): Promise<string> {
    const owner = await this.get()
    if (!owner) throw new AppError('NO_OWNER', 'Link your Telegram account first (Settings → General), or use a login link', 409)
    const open = this.accounts.list().filter((a) => a.state === 'open' || a.state === 'conflict' || a.state === 'reconnecting')
    const list = [...open.filter((a) => a.id === owner.bot), ...open.filter((a) => a.id !== owner.bot)]
    if (!list.length) throw new AppError('NO_CONNECTED_BOT', 'No connected bot to send the code with. Use a login link.', 409)
    let last: unknown
    for (const acc of list) {
      try {
        await acc.send(owner.id, 'sendMessage', { text: tr(lang, '@otp', [code]), parse_mode: 'HTML', protect_content: true }, { store: false })
        return owner.username ? '@' + owner.username : owner.name ?? owner.id
      } catch (e) {
        last = e
      }
    }
    throw last instanceof AppError ? last : new AppError('CODE_NOT_SENT', 'The code could not be sent on Telegram: {0}', 502, [String((last as Error)?.message ?? last)])
  }
}
