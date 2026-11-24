import { now, type DbHandle } from '../db/index.js'
import { logger } from '../log.js'
import { AppError } from '../util.js'
import { BotApi, botIdOf, TgApiError } from './api.js'
import { BotAccount, tgReason, type AccountRow, type Ctx } from './account.js'
import type { TgBotInfo, TgWebhookInfo } from './types.js'

/** Everything stored for one bot (removed with it). */
const DATA_TABLES = ['messages', 'chats', 'contacts', 'outbox', 'profiles', 'transcripts']

/** The bots of this installation. A bot's id is its Telegram id (the number before ":" in its token). */
export class AccountManager {
  readonly accounts = new Map<string, BotAccount>()

  constructor(private ctx: Ctx) {}

  get h(): DbHandle {
    return this.ctx.h
  }

  async loadAll(): Promise<void> {
    const rows = (await this.h.db.selectFrom('accounts').selectAll().orderBy('created_at').execute()) as AccountRow[]
    for (const r of rows) this.accounts.set(r.id, new BotAccount(r, this.ctx))
    for (const acc of this.accounts.values()) {
      if (!acc.row.enabled) {
        acc.state = 'stopped'
        continue
      }
      acc.start().catch((e) => logger.error({ account: acc.id, err: String(e) }, 'bot start failed'))
    }
  }

  list(): BotAccount[] {
    return [...this.accounts.values()]
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
