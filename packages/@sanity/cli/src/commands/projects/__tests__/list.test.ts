import {createTestToken, mockApi, testCommand} from '@sanity/cli-test'
import {cleanAll, pendingMocks} from 'nock'
import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest'

import {PROJECTS_API_VERSION} from '../../../services/projects.js'
import {List} from '../list.js'

describe('#list', () => {
  beforeEach(() => {
    createTestToken('test-token')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    const pending = pendingMocks()
    cleanAll()
    expect(pending, 'pending mocks').toEqual([])
  })

  test('displays projects correctly', async () => {
    mockApi({
      apiVersion: PROJECTS_API_VERSION,
      query: {onlyExplicitMembership: 'true'},
      uri: '/projects',
    }).reply(200, [
      {
        createdAt: '2023-01-01',
        displayName: 'Project One',
        id: 'project1',
        members: ['user1', 'user2'],
      },
      {
        createdAt: '2023-01-02',
        displayName: 'Project Two',
        id: 'project2',
        members: ['user1'],
      },
    ])

    const {stdout} = await testCommand(List)

    expect(stdout).toMatchSnapshot()
  })

  test('sorts by members when --sort members is specified', async () => {
    mockApi({
      apiVersion: PROJECTS_API_VERSION,
      query: {onlyExplicitMembership: 'true'},
      uri: '/projects',
    }).reply(200, [
      {
        createdAt: '2023-01-01',
        displayName: 'Project One',
        id: 'project1',
        members: ['user1', 'user2', 'user3'],
      },
      {
        createdAt: '2023-01-02',
        displayName: 'Project Two',
        id: 'project2',
        members: ['user1'],
      },
      {
        createdAt: '2023-01-03',
        displayName: 'Project Three',
        id: 'project3',
        members: ['user1', 'user2'],
      },
    ])

    const {stdout} = await testCommand(List, ['--sort', 'members'])

    const lines = stdout.split('\n').filter(Boolean)

    // Find the indices of lines containing each project
    const project1Index = lines.findIndex((line) => line.includes('project1'))
    const project2Index = lines.findIndex((line) => line.includes('project2'))
    const project3Index = lines.findIndex((line) => line.includes('project3'))

    // Verify they all exist
    expect(project1Index).toBeGreaterThan(-1)
    expect(project2Index).toBeGreaterThan(-1)
    expect(project3Index).toBeGreaterThan(-1)

    // By default order is desc, so project with most members should come first
    expect(project1Index).toBeLessThan(project3Index)
    expect(project3Index).toBeLessThan(project2Index)
  })

  test('sorts in ascending order when --order asc is specified', async () => {
    mockApi({
      apiVersion: PROJECTS_API_VERSION,
      query: {onlyExplicitMembership: 'true'},
      uri: '/projects',
    }).reply(200, [
      {
        createdAt: '2023-01-01',
        displayName: 'Project One',
        id: 'project1',
        members: ['user1', 'user2'],
      },
      {
        createdAt: '2023-01-02',
        displayName: 'Project Two',
        id: 'project2',
      },
      {
        createdAt: '2023-01-03',
        displayName: 'Project Three',
        id: 'project3',
        members: ['user1', 'user2', 'user3'],
      },
    ])

    const {stdout} = await testCommand(List, ['--order', 'asc'])

    const lines = stdout.split('\n').filter(Boolean)

    const line2023_01_01 = lines.findIndex((line) => line.includes('2023-01-01'))
    const line2023_01_02 = lines.findIndex((line) => line.includes('2023-01-02'))
    const line2023_01_03 = lines.findIndex((line) => line.includes('2023-01-03'))

    expect(line2023_01_01).toBeGreaterThan(0) // First line is header
    expect(line2023_01_02).toBeGreaterThan(0)
    expect(line2023_01_03).toBeGreaterThan(0)

    // Check the order (ascending)
    expect(line2023_01_01).toBeLessThan(line2023_01_02)
    expect(line2023_01_02).toBeLessThan(line2023_01_03)
  })

  test('outputs JSON when --json is specified', async () => {
    const projects = [
      {
        createdAt: '2023-01-01',
        displayName: 'Project One',
        id: 'project1',
        members: ['user1', 'user2'],
      },
      {
        createdAt: '2023-01-02',
        displayName: 'Project Two',
        id: 'project2',
        members: ['user1'],
      },
    ]

    mockApi({
      apiVersion: PROJECTS_API_VERSION,
      query: {onlyExplicitMembership: 'true'},
      uri: '/projects',
    }).reply(200, projects)

    const {stdout} = await testCommand(List, ['--json'])

    const parsed = JSON.parse(stdout)
    // Default sort is created desc
    expect(parsed).toEqual([
      {
        created: '2023-01-02',
        id: 'project2',
        members: 1,
        name: 'Project Two',
        url: 'https://www.sanity.io/manage/project/project2',
      },
      {
        created: '2023-01-01',
        id: 'project1',
        members: 2,
        name: 'Project One',
        url: 'https://www.sanity.io/manage/project/project1',
      },
    ])
  })

  test('applies sort and order to JSON output', async () => {
    mockApi({
      apiVersion: PROJECTS_API_VERSION,
      query: {onlyExplicitMembership: 'true'},
      uri: '/projects',
    }).reply(200, [
      {
        createdAt: '2023-01-01',
        displayName: 'Project One',
        id: 'project1',
        members: ['user1', 'user2', 'user3'],
      },
      {
        createdAt: '2023-01-02',
        displayName: 'Project Two',
        id: 'project2',
        members: ['user1'],
      },
      {
        createdAt: '2023-01-03',
        displayName: 'Project Three',
        id: 'project3',
        members: ['user1', 'user2'],
      },
    ])

    const {stdout} = await testCommand(List, ['--json', '--sort', 'members', '--order', 'asc'])

    const parsed = JSON.parse(stdout)
    expect(parsed).toHaveLength(3)
    expect(parsed[0].members).toBe(1)
    expect(parsed[1].members).toBe(2)
    expect(parsed[2].members).toBe(3)
  })

  test('displays auth error with hint when not logged in', async () => {
    vi.unstubAllEnvs()

    const {error} = await testCommand(List)

    expect(error).toBeInstanceOf(Error)
    expect(error?.message).toContain('Not logged in')
    expect(error?.message).toContain('sanity login')
    expect(error?.message).toContain('[Hint]')
    expect(error?.oclif?.exit).toBe(1)
  })

  test('displays an error if the API request fails', async () => {
    mockApi({
      apiVersion: PROJECTS_API_VERSION,
      query: {onlyExplicitMembership: 'true'},
      uri: '/projects',
    }).reply(500, {message: 'Internal Server Error'})

    const {error} = await testCommand(List)

    expect(error).toBeInstanceOf(Error)
    expect(error?.message).toContain('Failed to list projects')
  })
})
