import {Args, Flags} from '@oclif/core'
import {SanityCommand, subdebug} from '@sanity/cli-core'
import {isHttpError} from '@sanity/client'

import {validateOrganizationName} from '../../actions/organizations/validateOrganizationName.js'
import {createOrganization} from '../../services/organizations.js'
import {formatHint} from '../../util/formatHint.js'

const organizationsDebug = subdebug('organizations')

export class Create extends SanityCommand<typeof Create> {
  static override args = {
    name: Args.string({description: 'Organization name'}),
  }
  static override description = 'Create a new organization'
  static override examples = [
    {
      command: '<%= config.bin %> <%= command.id %> "My Org"',
      description: 'Create a new organization named "My Org"',
    },
    {
      command: '<%= config.bin %> <%= command.id %> "My Org" --json',
      description: 'Create a new organization and output JSON',
    },
  ]

  static override flags = {
    json: Flags.boolean({
      default: false,
      description: 'Output the created organization in JSON format',
    }),
  }

  static override hiddenAliases: string[] = ['organization:create']

  public async run() {
    const {json} = this.flags
    const name = this.args.name

    if (!name) {
      this.error(
        `Organization name is required.${formatHint('sanity organizations create "My Org"')}`,
        {exit: 1},
      )
    }

    const validation = validateOrganizationName(name)
    if (validation !== true) {
      this.error(validation, {exit: 1})
    }

    let organization
    try {
      organization = await createOrganization(name)
    } catch (error) {
      organizationsDebug('Error creating organization', error)
      const isAuthError =
        (error instanceof Error && error.message.includes('must login first')) ||
        (isHttpError(error) && (error.statusCode === 401 || error.statusCode === 403))
      if (isAuthError) {
        this.error(
          `Not logged in. Run \`sanity login\` or set the SANITY_AUTH_TOKEN environment variable.${formatHint('sanity login --provider google')}`,
          {exit: 1},
        )
      }
      this.error('Failed to create organization', {exit: 1})
    }

    if (json) {
      this.log(JSON.stringify(organization, null, 2))
      return
    }

    this.log(`Created organization: ${organization.name} (${organization.id})`)
    this.log(`Manage at: https://sanity.io/manage/personal/organization/${organization.id}`)
  }
}
