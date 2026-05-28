import {testCommand} from '@sanity/cli-test'
import {afterEach, describe, expect, test, vi} from 'vitest'

import {Status} from '../status.js'

const mockValidateSession = vi.hoisted(() => vi.fn())

vi.mock('../../../actions/auth/ensureAuthenticated.js', () => ({
  validateSession: mockValidateSession,
}))

describe('#auth status', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  test('shows logged-in user info when authenticated', async () => {
    mockValidateSession.mockResolvedValue({
      email: 'test@example.com',
      id: 'user-123',
      name: 'Test User',
      provider: 'google',
    })

    const {error, stdout} = await testCommand(Status)

    if (error) throw error
    expect(stdout).toContain('Logged in as test@example.com (Google)')
    expect(mockValidateSession).toHaveBeenCalledOnce()
  })

  test('shows not-logged-in error with exit 1 when not authenticated', async () => {
    mockValidateSession.mockResolvedValue(null)

    const {error} = await testCommand(Status)

    expect(error).toBeInstanceOf(Error)
    expect(error?.message).toContain('Not logged in')
    expect(error?.message).toContain('sanity login')
    expect(error?.message).toContain('SANITY_AUTH_TOKEN')
    expect(error?.oclif?.exit).toBe(1)
    expect(mockValidateSession).toHaveBeenCalledOnce()
  })

  test('outputs JSON with user info when logged in and --json flag is used', async () => {
    mockValidateSession.mockResolvedValue({
      email: 'dev@example.com',
      id: 'user-456',
      name: 'Dev User',
      provider: 'github',
    })

    const {error, stdout} = await testCommand(Status, ['--json'])

    if (error) throw error
    const parsed = JSON.parse(stdout)
    expect(parsed).toEqual({
      email: 'dev@example.com',
      loggedIn: true,
      provider: 'GitHub',
    })
    expect(mockValidateSession).toHaveBeenCalledOnce()
  })

  test('outputs JSON with loggedIn false when not authenticated and --json flag is used', async () => {
    mockValidateSession.mockResolvedValue(null)

    const {error, stdout} = await testCommand(Status, ['--json'])

    expect(error).toBeInstanceOf(Error)
    expect(error?.oclif?.exit).toBe(1)
    const parsed = JSON.parse(stdout)
    expect(parsed).toEqual({loggedIn: false, pending: false})
    expect(mockValidateSession).toHaveBeenCalledOnce()
  })

  test('shows correct provider name for SAML provider', async () => {
    mockValidateSession.mockResolvedValue({
      email: 'sso@example.com',
      id: 'user-789',
      name: 'SSO User',
      provider: 'saml-okta',
    })

    const {error, stdout} = await testCommand(Status)

    if (error) throw error
    expect(stdout).toContain('Logged in as sso@example.com (SAML)')
    expect(mockValidateSession).toHaveBeenCalledOnce()
  })
})
