/**
 * Linking a Telegram user account, the way Telegram Desktop does it: a QR code scanned from the phone
 * (Settings → Devices → Link Desktop Device), or the phone number and the code Telegram sends, then the
 * two-step verification password if the account has one. Each login lives here (in memory) until it ends.
 *
 * Phone numbers, codes and passwords are never written to the log or the database; the session is stored sealed.
 */
import crypto from 'node:crypto'
import QRCode from 'qrcode'
import { Api, type TelegramClient } from 'telegram'
import { Raw } from 'telegram/events/index.js'
import { computeCheck } from 'telegram/Password.js'
import type { StringSession } from 'telegram/sessions/index.js'
import { tr, type Lang } from '../../i18n.js'
import { logger } from '../../log.js'
import { AppError } from '../../util.js'
import type { TelegramApp } from './app.js'
import { maskPhone } from './convert.js'
import { newClient } from './account.js'

export type LoginMethod = 'qr' | 'phone'
export type LoginState = 'qr' | 'code' | 'password' | 'done' | 'error'

type Login = {
  id: string
  method: LoginMethod
  state: LoginState
  client: TelegramClient
  app: TelegramApp
  qr?: { url: string; image: string; expires: number }
  phone?: string
  phoneCodeHash?: string
  codeVia?: 'app' | 'sms' | 'other'
  hint?: string | null
  error?: AppError
  account?: unknown
  touched: number
  started: number
  timer?: ReturnType<typeof setTimeout>
  busy?: boolean
}

const IDLE_MS = 10 * 60_000
/** A QR code nobody scans is not renewed for ever: after this the page says to start again. */
const QR_MAX_MS = 10 * 60_000
const MAX_LOGINS = 5

const rpc = (e: unknown) => String((e as { errorMessage?: string })?.errorMessage ?? '')

/** What a Telegram refusal during a login means for the person in front of the page. */
function loginError(e: unknown): AppError {
  if (e instanceof AppError) return e
  const m = rpc(e)
  if (/API_ID_INVALID|API_ID_PUBLISHED_FLOOD/.test(m)) return new AppError('BAD_TELEGRAM_APP', 'Telegram does not accept this app code (api_id / api_hash): copy both again from my.telegram.org', 400)
  if (/PHONE_NUMBER_INVALID/.test(m)) return new AppError('PHONE_INVALID', 'This phone number is not valid: write it with the country code, like +971 50 123 4567', 400)
  if (/PHONE_NUMBER_BANNED/.test(m)) return new AppError('PHONE_BANNED', 'Telegram has banned this phone number', 403)
  if (/PHONE_NUMBER_FLOOD|PHONE_PASSWORD_FLOOD|FLOOD_WAIT/.test(m)) return new AppError('LOGIN_FLOOD', 'Telegram asks to wait before trying again ({0})', 429, [m])
  if (/PHONE_CODE_INVALID|PHONE_CODE_EMPTY/.test(m)) return new AppError('CODE_INVALID', 'Wrong code: check it in Telegram and type it again', 400)
  if (/PHONE_CODE_EXPIRED/.test(m)) return new AppError('CODE_EXPIRED', 'The code has expired: start again for a new one', 400)
  if (/PASSWORD_HASH_INVALID/.test(m)) return new AppError('PASSWORD_INVALID', 'Wrong password: it is the two-step verification password of this Telegram account', 400)
  if (/AUTH_TOKEN_EXPIRED|AUTH_TOKEN_INVALID/.test(m)) return new AppError('QR_EXPIRED', 'The QR code has expired: start again', 400)
  if (/SESSION_PASSWORD_NEEDED/.test(m)) return new AppError('PASSWORD_NEEDED', 'This account has a two-step verification password', 400)
  return new AppError('LOGIN_FAILED', 'Telegram refused the login: {0}', 502, [m || String((e as Error)?.message ?? e).slice(0, 200)])
}

/** +971501234567 from whatever was typed (spaces, dashes, 00 instead of +). */
export function normalizePhone(p: string | undefined): string {
  const s = String(p ?? '').trim().replace(/^00/, '+')
  const digits = s.replace(/\D/g, '')
  if (digits.length < 7 || digits.length > 15) throw new AppError('PHONE_INVALID', 'This phone number is not valid: write it with the country code, like +971 50 123 4567', 400)
  return '+' + digits
}

export class UserLogins {
  private list = new Map<string, Login>()

  constructor(
    private deps: {
      app: () => Promise<TelegramApp | null>
      /** The login worked: store the account (sealed session) and connect it. */
      finish: (session: string, user: Api.User) => Promise<{ status(): unknown }>
    },
  ) {}

  private gc() {
    const t = Date.now()
    for (const l of this.list.values()) if (t - l.touched > IDLE_MS) void this.cancel(l.id)
  }

  private get(id: string): Login {
    const l = this.list.get(id)
    if (!l) throw new AppError('LOGIN_NOT_FOUND', 'This login is over (finished, cancelled or left for 10 minutes): start again', 404)
    l.touched = Date.now()
    return l
  }

  /** What the page shows of a login (in the language of the request). */
  view(id: string, lang?: Lang) {
    const l = this.get(id)
    return {
      id: l.id,
      method: l.method,
      state: l.state,
      ...(l.state === 'qr' && l.qr ? { qr: { url: l.qr.url, image: l.qr.image, expiresAt: new Date(l.qr.expires * 1000).toISOString() } } : {}),
      phone: maskPhone(l.phone),
      codeVia: l.codeVia ?? null,
      hint: l.hint ?? null,
      error: l.error ? { code: l.error.code, message: lang ? tr(lang, l.error.template, l.error.params) : l.error.message } : null,
      account: l.account ?? null,
    }
  }

  async start(method: LoginMethod, phone?: string, lang?: Lang) {
    this.gc()
    if (this.list.size >= MAX_LOGINS) throw new AppError('TOO_MANY_LOGINS', 'Too many logins in progress: finish or cancel one first', 429)
    const app = await this.deps.app()
    if (!app) throw new AppError('NO_TELEGRAM_APP', 'Add the Telegram app code first (api_id and api_hash from my.telegram.org)', 409)
    const number = method === 'phone' ? normalizePhone(phone) : undefined
    const l: Login = { id: 'tgl_' + crypto.randomBytes(12).toString('base64url'), method, state: method === 'qr' ? 'qr' : 'code', client: newClient('', app), app, touched: Date.now(), started: Date.now() }
    try {
      await l.client.connect()
      this.list.set(l.id, l)
      if (method === 'phone') {
        const r = await l.client.sendCode({ apiId: app.apiId, apiHash: app.apiHash }, number!)
        l.phone = number
        l.phoneCodeHash = r.phoneCodeHash
        l.codeVia = r.isCodeViaApp ? 'app' : 'sms'
        l.state = 'code'
      } else {
        // the phone scanned the code: Telegram says so with updateLoginToken
        l.client.addEventHandler((u: unknown) => {
          if (u instanceof Api.UpdateLoginToken) void this.qrStep(l)
        }, new Raw({}))
        await this.qrStep(l)
        if (l.state === 'error' && l.error) throw l.error
      }
    } catch (e) {
      await this.cancel(l.id)
      await l.client.destroy().catch(() => undefined)
      throw loginError(e)
    }
    logger.info({ mod: 'auth', login: l.id, method }, 'Telegram account login started')
    return this.view(l.id, lang)
  }

  /** Ask Telegram for the QR token again: a new code (they last 30 s), or the account if it was scanned. */
  private async qrStep(l: Login): Promise<void> {
    if (l.busy || l.state === 'done' || !this.list.has(l.id)) return
    // the page is gone (nobody asks for the code any more): stop asking Telegram for new ones
    if (Date.now() - l.touched > IDLE_MS) return void this.cancel(l.id)
    if (Date.now() - l.started > QR_MAX_MS) return this.fail(l, new AppError('QR_EXPIRED', 'The QR code has expired: start again', 400))
    l.busy = true
    try {
      let r = await l.client.invoke(new Api.auth.ExportLoginToken({ apiId: l.app.apiId, apiHash: l.app.apiHash, exceptIds: [] }))
      if (r instanceof Api.auth.LoginTokenMigrateTo) {
        // the account lives on another data center: continue there
        await (l.client as unknown as { _switchDC(dc: number): Promise<void> })._switchDC(r.dcId)
        r = await l.client.invoke(new Api.auth.ImportLoginToken({ token: r.token }))
      }
      if (r instanceof Api.auth.LoginTokenSuccess && r.authorization instanceof Api.auth.Authorization) {
        await this.done(l, r.authorization.user)
        return
      }
      if (r instanceof Api.auth.LoginToken) {
        const url = 'tg://login?token=' + Buffer.from(r.token).toString('base64url')
        const svg = await QRCode.toString(url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' })
        l.qr = { url, image: 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64'), expires: r.expires }
        l.state = 'qr'
        if (l.timer) clearTimeout(l.timer)
        const t = setTimeout(() => void this.qrStep(l), Math.max(5_000, r.expires * 1000 - Date.now() - 3_000))
        ;(t as { unref?: () => void }).unref?.()
        l.timer = t
      }
    } catch (e) {
      if (rpc(e) === 'SESSION_PASSWORD_NEEDED') await this.needPassword(l)
      else this.fail(l, e)
    } finally {
      l.busy = false
    }
  }

  private async needPassword(l: Login) {
    if (l.timer) clearTimeout(l.timer)
    const pw = await l.client.invoke(new Api.account.GetPassword())
    l.hint = pw.hint ?? null
    l.state = 'password'
  }

  private fail(l: Login, e: unknown) {
    if (l.timer) clearTimeout(l.timer)
    const a = loginError(e)
    l.state = 'error'
    l.error = a
    logger.warn({ mod: 'auth', login: l.id, code: a.code }, 'Telegram account login failed')
    void l.client.destroy().catch(() => undefined)
  }

  private async done(l: Login, user: Api.TypeUser) {
    if (l.timer) clearTimeout(l.timer)
    if (!(user instanceof Api.User)) throw new AppError('LOGIN_FAILED', 'Telegram refused the login: {0}', 502, ['no user'])
    const session = (l.client.session as StringSession).save()
    // the account opens its own connection with this session
    await l.client.destroy().catch(() => undefined)
    const acc = await this.deps.finish(session, user)
    l.state = 'done'
    l.account = acc.status()
    logger.info({ mod: 'auth', login: l.id, account: String(user.id) }, 'Telegram account linked')
  }

  async code(id: string, code: string, lang?: Lang) {
    const l = this.get(id)
    if (l.state !== 'code') throw new AppError('LOGIN_STATE', 'This login is not waiting for a code', 409)
    const digits = String(code ?? '').replace(/\D/g, '')
    if (!digits) throw new AppError('CODE_INVALID', 'Wrong code: check it in Telegram and type it again', 400)
    try {
      const r = await l.client.invoke(new Api.auth.SignIn({ phoneNumber: l.phone!, phoneCodeHash: l.phoneCodeHash!, phoneCode: digits }))
      if (r instanceof Api.auth.AuthorizationSignUpRequired) {
        this.fail(l, new AppError('NO_TELEGRAM_ACCOUNT', 'This number has no Telegram account: create it in the Telegram app first', 400))
        return this.view(id, lang)
      }
      await this.done(l, r.user)
    } catch (e) {
      const m = rpc(e)
      if (m === 'SESSION_PASSWORD_NEEDED') await this.needPassword(l)
      else if (/PHONE_CODE_INVALID|PHONE_CODE_EMPTY/.test(m)) throw loginError(e)
      else this.fail(l, e)
    }
    return this.view(id, lang)
  }

  async password(id: string, password: string, lang?: Lang) {
    const l = this.get(id)
    if (l.state !== 'password') throw new AppError('LOGIN_STATE', 'This login is not waiting for a password', 409)
    if (!password) throw new AppError('PASSWORD_INVALID', 'Wrong password: it is the two-step verification password of this Telegram account', 400)
    try {
      const srp = await l.client.invoke(new Api.account.GetPassword())
      const check = await computeCheck(srp, password)
      const r = await l.client.invoke(new Api.auth.CheckPassword({ password: check }))
      if (!(r instanceof Api.auth.Authorization)) throw new AppError('LOGIN_FAILED', 'Telegram refused the login: {0}', 502, ['sign up required'])
      await this.done(l, r.user)
    } catch (e) {
      if (/PASSWORD_HASH_INVALID/.test(rpc(e))) throw loginError(e)
      this.fail(l, e)
    }
    return this.view(id, lang)
  }

  async cancel(id: string): Promise<void> {
    const l = this.list.get(id)
    if (!l) return
    this.list.delete(id)
    if (l.timer) clearTimeout(l.timer)
    if (l.state !== 'done') await l.client.destroy().catch(() => undefined)
  }

  async stopAll(): Promise<void> {
    for (const id of [...this.list.keys()]) await this.cancel(id)
  }
}
