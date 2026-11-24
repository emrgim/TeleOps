/**
 * The Telegram app of this installation (api_id / api_hash from my.telegram.org → API development tools):
 * every user account logs in through it. Set in the config page, or with TELEOPS_API_ID / TELEOPS_API_HASH.
 */
import { getSetting, setSetting, type DbHandle } from '../../db/index.js'
import { AppError } from '../../util.js'

export type TelegramApp = { apiId: number; apiHash: string }

const KEY = 'telegram_app'
const HASH_RE = /^[0-9a-f]{32}$/i

function valid(apiId: unknown, apiHash: unknown): TelegramApp | null {
  const id = Number(apiId)
  const hash = String(apiHash ?? '').trim()
  if (!Number.isInteger(id) || id <= 0 || id > 2 ** 31 || !HASH_RE.test(hash)) return null
  return { apiId: id, apiHash: hash.toLowerCase() }
}

export async function telegramApp(h: DbHandle): Promise<(TelegramApp & { source: 'env' | 'settings' }) | null> {
  const env = valid(process.env.TELEOPS_API_ID, process.env.TELEOPS_API_HASH)
  if (env) return { ...env, source: 'env' }
  const raw = await getSetting(h, KEY)
  if (!raw) return null
  try {
    const j = JSON.parse(raw) as Partial<TelegramApp>
    const v = valid(j.apiId, j.apiHash)
    return v ? { ...v, source: 'settings' } : null
  } catch {
    return null
  }
}

export async function setTelegramApp(h: DbHandle, apiId: unknown, apiHash: unknown): Promise<TelegramApp> {
  const v = valid(apiId, apiHash)
  if (!v) throw new AppError('BAD_TELEGRAM_APP', 'api_id is a number and api_hash 32 letters and digits: copy both from my.telegram.org → API development tools', 400)
  await setSetting(h, KEY, JSON.stringify(v))
  return v
}

export async function clearTelegramApp(h: DbHandle): Promise<void> {
  await setSetting(h, KEY, '')
}
