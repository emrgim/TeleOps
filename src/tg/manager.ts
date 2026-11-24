import { now, type DbHandle } from '../db/index.js'
import { logger } from '../log.js'
import { AppError } from '../util.js'
import { BotApi, botIdOf, TgApiError } from './api.js'
import { BotAccount, tgReason, type AccountRow, type Ctx } from './account.js'
import { fullName } from './store.js'
import type { TgBotInfo, TgWebhookInfo } from './types.js'
import { meOf } from './user/convert.js'
import { sealSession } from './user/crypt.js'
import { UserAccount } from './user/account.js'
import type { Api } from 'telegram'

/** Everything stored for one bot (removed with it). */
const DATA_TABLES = ['messages', 'chats', 'contacts', 'outbox', 'profiles', 'transcripts']

/**
 * The Telegram accounts of this installation: bots (id = the number before ":" in the token) and user
 * accounts (id = the person's Telegram id), both answering the same calls (see TgCaller).
 */
export class AccountManager {
  readonly accounts = new Map<string, BotAccount>()

  constructor(private ctx: Ctx) {}

  get h(): DbHandle {
    return this.ctx.h
  }

  async loadAll(): Promise<void> {
    const rows = (await this.h.db.selectFrom('accounts').selectAll().orderBy('created_at').execute()) as AccountRow[]
    for (const r of rows) this.accounts.set(r.id, this.make(r))
    for (const acc of this.accounts.values()) {
      if (!acc.row.enabled) {
        acc.state = 'stopped'
        continue
      }
      acc.start().catch((e) => logger.error({ account: acc.id, err: String(e) }, 'bot start failed'))
    }
  }

  private make(r: AccountRow): BotAccount {
    return r.kind === 'user' ? new UserAccount(r, this.ctx) : new BotAccount(r, this.ctx)
  }

  list(): BotAccount[] {
    return [...this.accounts.values()]
  }

  /** The bot that writes to the owner (login codes): the default one if it is a bot, else the first connected bot. */
  defaultBot(): BotAccount | undefined {
    const bots = this.list().filter((a) => a.kind === 'bot')
    return bots.find((a) => a.row.is_default && a.state === 'open') ?? bots.find((a) => a.state === 'open') ?? bots.find((a) => a.row.is_default) ?? bots[0]
  }

  /**
   * A Telegram account logged in (QR or phone): store its session sealed and connect it. The same account
   * again replaces the session (a new login after the old one was closed).
   */
  async addUser(session: string, user: Api.User): Promise<{ account: BotAccount; created: boolean }> {
    const me = meOf(user)
    const id = String(me.id)
    const sealed = sealSession(session)
    const existing = this.accounts.get(id)
    if (existing && existing.kind !== 'user') throw new AppError('ACCOUNT_EXISTS', 'This Telegram id is already linked as a bot', 409)
    if (existing) {
      existing.row.session = sealed
      existing.row.enabled = 1
      existing.me = me
      await this.h.db.updateTable('accounts').set({ session: sealed, enabled: 1, me: JSON.stringify(me), updated_at: now() }).where('id', '=', id).execute()
      await existing.start()
      logger.info({ account: id }, 'Telegram account session replaced')
      return { account: existing, created: false }
    }
    const row: AccountRow = {
      id,
      kind: 'user',
      label: fullName(me) ?? me.username ?? null,
      username: me.username ?? null,
      token: null,
      session: sealed,
      enabled: 1,
      is_default: this.accounts.size === 0 ? 1 : 0,
      me: JSON.stringify(me),
      status: 'connecting',
      update_offset: 0,
      created_at: now(),
      updated_at: now(),
    }
    await this.h.db.insertInto('accounts').values(row).execute()
    const acc = this.make(row)
    this.accounts.set(id, acc)
    this.ctx.bus.publish('connection.update', id, { state: 'connecting', created: true, username: me.username ?? null, kind: 'user' })
    logger.info({ account: id }, 'Telegram account linked')
    await acc.start()
    return { account: acc, created: true }
  }

  /** A bot by id, @username or name; the default bot when omitted. */
  get(idOrName?: string | null): BotAccount {
    if (!idOrName) {
      const list = this.list()
      const def = list.find((a) => a.row.is_default) ?? list.find((a) => a.state === 'open') ?? list[0]
      if (!def) throw new AppError('NO_ACCOUNT', 'No Telegram bot is linked yet. Add one in the config page.', 404)
      return def
    }
    const k = String(idOrName).trim()
    const direct = this.accounts.get(k) ?? this.accounts.get(k.split(':')[0])
    if (direct) return direct
    const u = k.replace(/^@/, '').replace(/^https?:\/\/t\.me\//i, '').toLowerCase()
    for (const a of this.accounts.values()) {
      if (a.row.username && a.row.username.toLowerCase() === u) return a
      if ((a.me?.active_usernames ?? []).some((x) => x.toLowerCase() === u)) return a
    }
    for (const a of this.accounts.values()) if (a.displayName().toLowerCase() === k.toLowerCase()) return a
    throw new AppError('ACCOUNT_NOT_FOUND', 'Telegram bot "{0}" not found', 404, [k])
  }

  /**
   * Link a bot with its token from @BotFather. The same bot again (a new token after /revoke) replaces
   * the token. A bot that sends its updates to a webhook of another program is taken over only when asked.
   */
  async create(input: { token: string; takeOver?: boolean }): Promise<{ account: BotAccount; created: boolean }> {
    const token = String(input.token ?? '').trim()
    const id = botIdOf(token)
    const api = new BotApi(token)
    let me: TgBotInfo
    let hook: TgWebhookInfo
    try {
      me = await api.call<TgBotInfo>('getMe')
      hook = await api.call<TgWebhookInfo>('getWebhookInfo')
    } catch (e) {
      if (e instanceof TgApiError && (e.code === 401 || e.code === 404)) throw new AppError('INVALID_TOKEN', 'Telegram does not accept this token: copy it again from @BotFather (or /revoke there for a new one)', 400)
      throw new AppError('TELEGRAM_UNREACHABLE', 'Telegram cannot be reached: {0}', 502, [tgReason(e)])
    }
    if (hook.url && !input.takeOver) {
      let host = hook.url
      try {
        host = new URL(hook.url).host
      } catch {
        /* keep it */
      }
      throw new AppError('WEBHOOK_SET', 'This bot sends its updates to a webhook ({0}). TeleOps reads them itself: confirm to take the bot over (the webhook is removed, that program stops receiving).', 409, [host])
    }
    const existing = this.accounts.get(id)
    if (existing) {
      existing.setToken(token)
      await this.h.db.updateTable('accounts').set({ token, enabled: 1, updated_at: now() }).where('id', '=', id).execute()
      existing.row.enabled = 1
      await existing.start({ takeOver: !!hook.url })
      logger.info({ account: id }, 'bot token replaced')
      return { account: existing, created: false }
    }
    const row: AccountRow = {
      id,
      label: me.first_name ?? null,
      username: me.username ?? null,
      token,
      enabled: 1,
      is_default: this.accounts.size === 0 ? 1 : 0,
      me: JSON.stringify(me),
      status: 'connecting',
      update_offset: 0,
      created_at: now(),
      updated_at: now(),
    }
    await this.h.db.insertInto('accounts').values(row).execute()
    const acc = new BotAccount(row, this.ctx)
    this.accounts.set(id, acc)
    this.ctx.bus.publish('connection.update', id, { state: 'connecting', created: true, username: me.username })
    logger.info({ account: id, username: me.username }, 'bot linked')
    await acc.start({ takeOver: !!hook.url })
    return { account: acc, created: true }
  }

  async update(id: string, patch: { name?: string; enabled?: boolean; isDefault?: boolean }): Promise<BotAccount> {
    const acc = this.get(id)
    const set: Record<string, unknown> = { updated_at: now() }
    // one name: the bot's name on Telegram
    if (patch.name !== undefined && patch.name.trim() && patch.name.trim() !== acc.displayName()) await acc.editProfile({ name: patch.name })
    if (patch.enabled !== undefined) set.enabled = patch.enabled ? 1 : 0
    if (patch.isDefault) {
      await this.h.db.updateTable('accounts').set({ is_default: 0 }).execute()
      set.is_default = 1
      for (const a of this.accounts.values()) a.row.is_default = 0
    }
    await this.h.db.updateTable('accounts').set(set).where('id', '=', acc.id).execute()
    Object.assign(acc.row, set)
    if (patch.enabled === false) await acc.stop()
    if (patch.enabled === true && acc.state !== 'open') await acc.start()
    return acc
  }

  /** Unlink a bot (the bot itself stays on Telegram); its stored chats go too unless purge is false. */
  async remove(id: string, purge = true): Promise<void> {
    const acc = this.get(id)
    // a person's session is closed on Telegram too (it leaves Settings → Devices)
    if (acc instanceof UserAccount) await acc.logout()
    await acc.stop(false)
    if (purge) for (const t of DATA_TABLES) await this.h.db.deleteFrom(t).where('account_id', '=', acc.id).execute()
    await this.h.db.deleteFrom('accounts').where('id', '=', acc.id).execute()
    this.accounts.delete(acc.id)
    if (acc.row.is_default) {
      const next = this.list()[0]
      if (next) await this.update(next.id, { isDefault: true })
    }
    this.ctx.bus.publish('connection.update', acc.id, { state: 'deleted' })
  }

  async stopAll(): Promise<void> {
    await Promise.all(this.list().map((a) => a.stop(false).catch(() => undefined)))
  }
}
