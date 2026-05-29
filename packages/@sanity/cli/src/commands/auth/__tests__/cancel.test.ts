import {testCommand} from '@sanity/cli-test'
import {afterEach, describe, expect, test, vi} from 'vitest'

import {Cancel} from '../cancel.js'

const mockCancelBackgroundLogin = vi.hoisted(() => vi.fn())

vi.mock('../../../actions/auth/backgroundLogin.js', () => ({
  cancelBackgroundLogin: mockCancelBackgroundLogin,
}))

describe('#auth cancel', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  test('cancels a running background login', async () => {
    mockCancelBackgroundLogin.mockReturnValue({cancelled: true, pid: 1234})

    const {error, stdout} = await testCommand(Cancel)

    if (error) throw error
    expect(stdout).toContain('Background login cancelled.')
    expect(mockCancelBackgroundLogin).toHaveBeenCalledOnce()
  })

  test('reports when no background login is in progress', async () => {
    mockCancelBackgroundLogin.mockReturnValue({cancelled: false})

    const {error, stdout} = await testCommand(Cancel)

    if (error) throw error
    expect(stdout).toContain('No background login in progress.')
    expect(mockCancelBackgroundLogin).toHaveBeenCalledOnce()
  })
})
