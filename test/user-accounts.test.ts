import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import bigInt from 'big-integer'
import { Api } from 'telegram'
import { afterAll, describe, expect, it } from 'vitest'

// the data folder of this file (session key, database) — set before the config is read
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'to-user-'))
process.env.TELEOPS_DATA_DIR = tmp
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))

describe('Telegram accounts: the session is sealed with a key of this computer', () => {
  it('opens again with the same key; never stored in clear; altered = refused', async () => {
    const { keyFile, openSession, sealSession } = await import('../src/tg/user/crypt.js')
    const session = '1BAAOMTQ5LjE1NC4xNjcuOTEAUFAKEsession'
    const sealed = sealSession(session)
    expect(sealed.startsWith('enc1:')).toBe(true)
    expect(sealed).not.toContain('session')
    expect(openSession(sealed)).toBe(session)
    expect(sealSession(session)).not.toBe(sealed)
    expect(path.dirname(keyFile())).toBe(tmp)
    if (process.platform !== 'win32') expect(fs.statSync(keyFile()).mode & 0o777).toBe(0o600)
    const last = sealed.at(-1) === 'A' ? 'B' : 'A'
    expect(openSession(sealed.slice(0, -1) + last)).toBeNull()
    expect(openSession(session)).toBeNull()
    expect(openSession(null)).toBeNull()
  })
})

describe('phone numbers', () => {
  it('typed any way, kept with +; shown masked', async () => {
    const { normalizePhone } = await import('../src/tg/user/login.js')
    const { maskPhone } = await import('../src/tg/user/convert.js')
    expect(normalizePhone('+971 50 123 4567')).toBe('+971501234567')
    expect(normalizePhone('00971-50-123-4567')).toBe('+971501234567')
    expect(() => normalizePhone('12345')).toThrow(/country code/)
    expect(() => normalizePhone(undefined)).toThrow(/country code/)
    expect(maskPhone('+971501234567')).toBe('+971 ••• 567')
    expect(maskPhone('971501234567')).toBe('+971 ••• 567')
    expect(maskPhone(null)).toBeNull()
  })
})

describe('chat ids are the ones of the Bot API', () => {
  it('people as they are, groups with -, supergroups and channels with -100', async () => {
    const { fileRef, peerKey, splitKey } = await import('../src/tg/user/convert.js')
    expect(peerKey(new Api.PeerUser({ userId: bigInt(8163356356) }))).toBe('8163356356')
    expect(peerKey(new Api.PeerChat({ chatId: bigInt(4567) }))).toBe('-4567')
    expect(peerKey(new Api.PeerChannel({ channelId: bigInt(1234567890) }))).toBe('-1001234567890')
    expect(peerKey(null)).toBeNull()
    expect(splitKey('-1001234567890')).toEqual({ kind: 'channel', id: '1234567890' })
    expect(splitKey('-4567')).toEqual({ kind: 'chat', id: '4567' })
    expect(splitKey('8163356356')).toEqual({ kind: 'user', id: '8163356356' })
    expect(fileRef('-4567', 12)).toBe('mt:-4567:12')
  })
})

describe('the Telegram app code (my.telegram.org)', () => {
  it('stored once; the environment wins; a wrong one is refused', async () => {
    const { migrate, openDb } = await import('../src/db/index.js')
    const { setTelegramApp, telegramApp } = await import('../src/tg/user/app.js')
    const { sealSession } = await import('../src/tg/user/crypt.js')
    const h = await openDb(`sqlite://${path.join(tmp, 'app.db')}`)
    await migrate(h)
    try {
      // an account row says what it is; a person's session is kept sealed
      await h.db.insertInto('accounts').values({ id: '8163356356', label: 'Emi', kind: 'user', session: sealSession('s'), enabled: 1, is_default: 0, created_at: 1, updated_at: 1 }).execute()
      const row = await h.db.selectFrom('accounts').select(['kind', 'session', 'token']).where('id', '=', '8163356356').executeTakeFirstOrThrow()
      expect(row.kind).toBe('user')
      expect(String(row.session)).toMatch(/^enc1:/)
      expect(row.token ?? null).toBeNull()
      expect(await telegramApp(h)).toBeNull()
      await expect(setTelegramApp(h, 'abc', 'x')).rejects.toMatchObject({ code: 'BAD_TELEGRAM_APP' })
      await expect(setTelegramApp(h, '1234567', 'not-hex-not-hex-not-hex-not-hex!')).rejects.toMatchObject({ code: 'BAD_TELEGRAM_APP' })
      await setTelegramApp(h, '1234567', ' ABCDEF0123456789abcdef0123456789 ')
      expect(await telegramApp(h)).toEqual({ apiId: 1234567, apiHash: 'abcdef0123456789abcdef0123456789', source: 'settings' })
      process.env.TELEOPS_API_ID = '42'
      process.env.TELEOPS_API_HASH = '0123456789abcdef0123456789abcdef'
      expect(await telegramApp(h)).toEqual({ apiId: 42, apiHash: '0123456789abcdef0123456789abcdef', source: 'env' })
    } finally {
      delete process.env.TELEOPS_API_ID
      delete process.env.TELEOPS_API_HASH
      await h.close()
    }
  })

  it('no login without it; an unknown login says to start again', async () => {
    const { UserLogins } = await import('../src/tg/user/login.js')
    const logins = new UserLogins({
      app: async () => null,
      finish: async () => {
        throw new Error('not reached')
      },
    })
    await expect(logins.start('qr')).rejects.toMatchObject({ code: 'NO_TELEGRAM_APP', status: 409 })
    await expect(logins.start('phone', '+971501234567')).rejects.toMatchObject({ code: 'NO_TELEGRAM_APP' })
    expect(() => logins.view('tgl_nope')).toThrow(/start again/)
  })
})
