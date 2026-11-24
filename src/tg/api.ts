/**
 * Telegram Bot API client: one per bot token. JSON requests, multipart when files are uploaded,
 * file downloads. The token never leaves this file in an error message or a log line.
 *
 * TELEOPS_BOT_API changes the server (a local Bot API server, or a test double).
 */
import { AppError } from '../util.js'

export const API_BASE = (process.env.TELEOPS_BOT_API || 'https://api.telegram.org').replace(/\/+$/, '')

/** An error answered by Telegram (ok: false). */
export class TgApiError extends Error {
  constructor(
    public method: string,
    public code: number,
    public description: string,
    public retryAfter?: number,
    public migrateTo?: number,
  ) {
    super(`${method}: ${code} ${description}`)
  }
}

export type Upload = { field: string; data: Buffer; fileName: string; mimetype?: string }

export type CallOpts = { files?: Upload[]; signal?: AbortSignal; timeoutMs?: number }

/**
 * What an account talks to: the Bot API for a bot, or the same calls answered over MTProto for a
 * Telegram user account (src/tg/user), so the rest of TeleOps works the same for both.
 */
export interface TgCaller {
  call<T>(method: string, params?: Record<string, unknown>, opts?: CallOpts): Promise<T>
  /** Download a file that getFile returned. */
  download(filePath: string, maxBytes: number, signal?: AbortSignal): Promise<Buffer>
  /** Remove secrets from a text before it is shown or logged. */
  scrub(s: string): string
}

/** A bot token: `<bot id>:<secret>`. */
export const TOKEN_RE = /^(\d{3,20}):[A-Za-z0-9_-]{30,64}$/

export function botIdOf(token: string): string {
  const m = String(token ?? '').trim().match(TOKEN_RE)
  if (!m) throw new AppError('INVALID_TOKEN', 'This is not a bot token. Copy it from @BotFather: it looks like 123456789:AAE…', 400)
  return m[1]
}

export class BotApi implements TgCaller {
  readonly id: string

  constructor(
    private token: string,
    private base = API_BASE,
  ) {
    this.id = botIdOf(token)
  }

  /** Remove the token from any text before it is shown or logged. */
  scrub(s: string): string {
    return String(s ?? '').split(this.token).join('<token>')
  }

  async call<T>(method: string, params: Record<string, unknown> = {}, opts: CallOpts = {}): Promise<T> {
    const url = `${this.base}/bot${this.token}/${method}`
    const clean = Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined && v !== null))
    let body: string | FormData
    const headers: Record<string, string> = {}
    if (opts.files?.length) {
      const fd = new FormData()
      for (const [k, v] of Object.entries(clean)) fd.append(k, typeof v === 'object' ? JSON.stringify(v) : String(v))
      for (const f of opts.files) fd.append(f.field, new Blob([new Uint8Array(f.data)], f.mimetype ? { type: f.mimetype } : {}), f.fileName)
      body = fd
    } else {
      body = JSON.stringify(clean)
      headers['content-type'] = 'application/json'
    }
    const timeout = AbortSignal.timeout(opts.timeoutMs ?? 60_000)
    const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout
    let res: Response
    try {
      res = await fetch(url, { method: 'POST', headers, body, signal })
    } catch (e) {
      const err = e as Error & { cause?: { code?: string; message?: string } }
      if (err.name === 'AbortError' || err.name === 'TimeoutError') throw err
      // network trouble: no token in the message (the URL is never part of it)
      throw new Error(this.scrub(`${method}: ${err.cause?.code ?? err.cause?.message ?? err.message}`))
    }
    let j: { ok?: boolean; result?: T; description?: string; error_code?: number; parameters?: { retry_after?: number; migrate_to_chat_id?: number } }
    try {
      j = (await res.json()) as typeof j
    } catch {
      throw new TgApiError(method, res.status, `HTTP ${res.status}`)
    }
    if (!j.ok) throw new TgApiError(method, j.error_code ?? res.status, this.scrub(j.description ?? `HTTP ${res.status}`), j.parameters?.retry_after, j.parameters?.migrate_to_chat_id)
    return j.result as T
  }

  /** Download a file that getFile returned (bots can download up to 20 MB from Telegram's servers). */
  async download(filePath: string, maxBytes: number, signal?: AbortSignal): Promise<Buffer> {
    // a local Bot API server can answer with an absolute path on its own disk
    const url = filePath.startsWith('/') ? `${this.base}/file/bot${this.token}${filePath}` : `${this.base}/file/bot${this.token}/${filePath}`
    let res: Response
    try {
      res = await fetch(url, { signal: signal ?? AbortSignal.timeout(120_000) })
    } catch (e) {
      throw new AppError('MEDIA_DOWNLOAD_FAILED', 'Media download failed: {0}', 502, [this.scrub(String((e as Error & { cause?: { code?: string } }).cause?.code ?? (e as Error).message))])
    }
    if (!res.ok) throw new AppError('MEDIA_DOWNLOAD_FAILED', 'Media download failed: {0}', 502, [`HTTP ${res.status}`])
    const len = Number(res.headers.get('content-length') ?? 0)
    if (len > maxBytes) throw new AppError('MEDIA_TOO_LARGE', 'media larger than the configured cap', 413)
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.length > maxBytes) throw new AppError('MEDIA_TOO_LARGE', 'media larger than the configured cap', 413)
    return buf
  }
}
