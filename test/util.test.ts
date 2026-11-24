import { describe, expect, it } from 'vitest'
import { signPayload } from '../src/events.js'
import { redirectUriAllowed } from '../src/security/oauth.js'
import { botIdOf } from '../src/tg/api.js'
import { chatTitle, fullName } from '../src/tg/store.js'

describe('telegram helpers', () => {
  it('the bot id is the number before ":" in the token', () => {
    expect(botIdOf('7000000001:AAEtestTokenForTeleOpsTests_0000000000')).toBe('7000000001')
    expect(() => botIdOf('not a token')).toThrow(/bot token/)
    expect(() => botIdOf('123:short')).toThrow()
  })
  it('names of people and chats', () => {
    expect(fullName({ id: 1, is_bot: false, first_name: 'Mario', last_name: 'Rossi' })).toBe('Mario Rossi')
    expect(chatTitle({ id: -100, type: 'supergroup', title: 'Crew' })).toBe('Crew')
    expect(chatTitle({ id: 5, type: 'private', first_name: 'Anna', username: 'anna' })).toBe('Anna')
  })
})

describe('security helpers', () => {
  it('signs webhooks deterministically', () => {
    expect(signPayload('s3cret', '1700000000', '{"a":1}')).toMatch(/^sha256=[0-9a-f]{64}$/)
    expect(signPayload('s3cret', '1700000000', '{"a":1}')).toBe(signPayload('s3cret', '1700000000', '{"a":1}'))
  })
  it('allows only safe OAuth redirect URIs', () => {
    expect(redirectUriAllowed('https://claude.ai/api/mcp/auth_callback')).toBe(true)
    expect(redirectUriAllowed('http://localhost:33418/callback')).toBe(true)
    expect(redirectUriAllowed('cursor://anysphere.cursor-mcp/oauth/callback')).toBe(true)
    expect(redirectUriAllowed('http://evil.example/cb')).toBe(false)
    expect(redirectUriAllowed('javascript:alert(1)')).toBe(false)
    expect(redirectUriAllowed('https://x.example/cb#frag')).toBe(false)
  })
})
