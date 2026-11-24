/**
 * The session of a Telegram user account opens the whole account: it is stored sealed (AES-256-GCM) with a key
 * that lives in a file of its own next to the data (user-sessions.key, readable only by this user). A copy of the
 * database or a backup alone does not open the accounts: on another computer they must be linked again.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { config } from '../../config.js'

const PREFIX = 'enc1:'
let cached: { file: string; key: Buffer } | null = null

export function keyFile(): string {
  return path.join(config.dataDir, 'user-sessions.key')
}

function key(): Buffer {
  const file = keyFile()
  if (cached?.file === file) return cached.key
  let k: Buffer | null = null
  try {
    k = Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'base64')
  } catch {
    k = null
  }
  if (!k || k.length !== 32) {
    k = crypto.randomBytes(32)
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    // never replace a key that exists (a bad read must not orphan every stored session)
    try {
      fs.writeFileSync(file, k.toString('base64') + '\n', { mode: 0o600, flag: 'wx' })
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
      k = Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'base64')
      if (k.length !== 32) throw new Error(`${file} is not a TeleOps session key`)
    }
  }
  cached = { file, key: k }
  return k
}

export function sealSession(plain: string): string {
  const iv = crypto.randomBytes(12)
  const c = crypto.createCipheriv('aes-256-gcm', key(), iv)
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()])
  return PREFIX + Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64url')
}

/** The session, or null when this computer's key does not open it (another installation, key file lost). */
export function openSession(sealed: string | null | undefined): string | null {
  if (!sealed || !sealed.startsWith(PREFIX)) return null
  try {
    const buf = Buffer.from(sealed.slice(PREFIX.length), 'base64url')
    const d = crypto.createDecipheriv('aes-256-gcm', key(), buf.subarray(0, 12))
    d.setAuthTag(buf.subarray(12, 28))
    return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8')
  } catch {
    return null
  }
}
