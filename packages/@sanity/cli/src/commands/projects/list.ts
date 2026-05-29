import {styleText} from 'node:util'

import {Flags} from '@oclif/core'
import {SanityCommand, subdebug} from '@sanity/cli-core'
import {isHttpError} from '@sanity/client'
import size from 'lodash-es/size.js'
import sortBy from 'lodash-es/sortBy.js'

import {isBackgroundLoginInProgress} from '../../actions/auth/backgroundLogin.js'
import {listProjects} from '../../services/projects.js'
import {formatHint} from '../../util/formatHint.js'

const sortFields = ['id', 'members', 'name', 'url', 'created']

const projectsDebug = subdebug('projects')

export class List extends SanityCommand<typeof List> {
  static override description = 'List your projects'
  static override examples = [
    {
      command: '<%= config.bin %> <%= command.id %>',
      description: 'List projects',
    },
    {
      command: '<%= config.bin %> <%= command.id %> --json',
      description: 'List projects in JSON format',
    },
    {
      command: '<%= config.bin %> <%= command.id %> --sort=members --order=asc',
      description: 'List projects sorted by member count, ascending',
    },
  ]

  static override flags = {
    json: Flags.boolean({
      default: false,
      description: 'Output projects in JSON format',
    }),
    order: Flags.string({
      default: 'desc',
      description: 'Sort direction',
      options: ['asc', 'desc'],
    }),
    sort: Flags.string({
      default: 'created',
      description: 'Sort field',
      options: sortFields,
    }),
  }

  static override hiddenAliases: string[] = ['project:list']

  public async run() {
    const {json, order, sort} = this.flags

    try {
      const projects = await listProjects()

      if (json) {
        const mapped = projects.map(({createdAt, displayName, id, members = []}) => ({
          created: createdAt,
          id,
          members: members.length,
          name: displayName,
          url: `https://www.sanity.io/manage/project/${id}`,
        }))
        const sorted = sortBy(mapped, [sort])
        const ordered = order === 'asc' ? sorted : sorted.toReversed()
        this.log(JSON.stringify(ordered, null, 2))
        return
      }

      const ordered = sortBy(
        projects.map(({createdAt, displayName, id, members = []}) => {
          const manage = `https://www.sanity.io/manage/project/${id}`
          return [id, members.length, displayName, manage, createdAt].map(String)
        }),
        [sortFields.indexOf(sort)],
      )

      const rows = order === 'asc' ? ordered : ordered.toReversed()

      // Initialize maxWidths with the width of each header
      const maxWidths = sortFields.map((str) => size(str))

      // Calculate maximum width for each column
      for (const row of rows) {
        for (const [i, element] of row.entries()) {
          maxWidths[i] = Math.max(size(element), maxWidths[i])
        }
      }

      const printRow = (row: string[]) =>
        row.map((col, i) => `${col}`.padEnd(maxWidths[i])).join('   ')

      this.log(styleText('cyan', printRow(sortFields)))
      for (const row of rows) this.log(printRow(row))
    } catch (error) {
      projectsDebug('Error listing projects', error)
      const isAuthError =
        (error instanceof Error && error.message.includes('must login first')) ||
        (isHttpError(error) && (error.statusCode === 401 || error.statusCode === 403))
      if (isAuthError) {
        if (isBackgroundLoginInProgress()) {
          this.error(
            'Login pending — callback server is running, waiting for OAuth redirect. Wait 30-60 seconds and re-check, or run `sanity auth cancel` to stop.',
            {exit: 1},
          )
        }
        this.error(
          `Not logged in. Run \`sanity login\` or set the SANITY_AUTH_TOKEN environment variable.${formatHint('sanity login --provider google')}`,
          {exit: 1},
        )
      }
      this.error('Failed to list projects', {exit: 1})
    }
  }
}
