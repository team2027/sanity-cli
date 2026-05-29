import {createTestToken, mockApi, testCommand} from '@sanity/cli-test'
import {cleanAll, pendingMocks} from 'nock'
import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest'

import {ORGANIZATIONS_API_VERSION} from '../../../services/organizations.js'
import {Create} from '../create.js'

describe('#create', () => {
  beforeEach(() => {
    createTestToken('test-token')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    const pending = pendingMocks()
    cleanAll()
    expect(pending, 'pending mocks').toEqual([])
  })

  test('creates an organization with the given name', async () => {
    mockApi({
      apiVersion: ORGANIZATIONS_API_VERSION,
      method: 'post',
      uri: '/organizations',
    }).reply(200, {
      createdByUserId: 'user-1',
      defaultRoleName: null,
      features: [],
      id: 'org-new',
      members: [],
      name: 'My Org',
      slug: 'my-org',
    })

    const {error, stdout} = await testCommand(Create, ['My Org'])

    if (error) throw error
    expect(stdout).toContain('Created organization: My Org (org-new)')
    expect(stdout).toContain('https://sanity.io/manage')
  })

  test('outputs JSON when --json is specified', async () => {
    const response = {
      createdByUserId: 'user-1',
      defaultRoleName: null,
      features: [],
      id: 'org-new',
      members: [],
      name: 'Test Org',
      slug: 'test-org',
    }
    mockApi({
      apiVersion: ORGANIZATIONS_API_VERSION,
      method: 'post',
      uri: '/organizations',
    }).reply(200, response)

    const {error, stdout} = await testCommand(Create, ['Test Org', '--json'])

    if (error) throw error
    expect(JSON.parse(stdout)).toEqual(response)
  })

  test('errors with hint when name is missing', async () => {
    const {error} = await testCommand(Create)

    expect(error).toBeInstanceOf(Error)
    expect(error?.message).toContain('Organization name is required')
    expect(error?.message).toContain('[Hint]')
    expect(error?.oclif?.exit).toBe(1)
  })

  test('errors when name is too long', async () => {
    const longName = 'a'.repeat(101)
    const {error} = await testCommand(Create, [longName])

    expect(error).toBeInstanceOf(Error)
    expect(error?.message).toContain('cannot be longer than 100')
    expect(error?.oclif?.exit).toBe(1)
  })

  test('displays auth error with hint when not logged in', async () => {
    vi.unstubAllEnvs()

    const {error} = await testCommand(Create, ['My Org'])

    expect(error).toBeInstanceOf(Error)
    expect(error?.message).toContain('Not logged in')
    expect(error?.message).toContain('[Hint]')
    expect(error?.oclif?.exit).toBe(1)
  })

  test('displays an error if the API request fails', async () => {
    mockApi({
      apiVersion: ORGANIZATIONS_API_VERSION,
      method: 'post',
      uri: '/organizations',
    }).reply(500, {message: 'Internal Server Error'})

    const {error} = await testCommand(Create, ['My Org'])

    expect(error).toBeInstanceOf(Error)
    expect(error?.message).toContain('Failed to create organization')
    expect(error?.oclif?.exit).toBe(1)
  })
})
