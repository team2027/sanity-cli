import {Flags} from '@oclif/core'
import {SanityCommand} from '@sanity/cli-core'

import {isBackgroundLoginInProgress} from '../../actions/auth/backgroundLogin.js'
import {validateSession} from '../../actions/auth/ensureAuthenticated.js'
import {getProviderName} from '../../actions/auth/getProviderName.js'

export class Status extends SanityCommand<typeof Status> {
  static override description = 'Check authentication status'
  static override examples = [
    {
      command: '<%= config.bin %> <%= command.id %>',
      description: 'Check if you are logged in',
    },
    {
      command: '<%= config.bin %> <%= command.id %> --json',
      description: 'Check auth status in JSON format',
    },
  ]

  static override flags = {
    json: Flags.boolean({
      default: false,
      description: 'Output auth status in JSON format',
    }),
  }

  public async run() {
    const {json} = this.flags
    const user = await validateSession()

    if (user) {
      if (json) {
        this.log(
          JSON.stringify(
            {email: user.email, loggedIn: true, provider: getProviderName(user.provider)},
            null,
            2,
          ),
        )
        return
      }

      this.log(`Logged in as ${user.email} (${getProviderName(user.provider)})`)
      return
    }

    const pending = isBackgroundLoginInProgress()

    if (json) {
      this.log(JSON.stringify({loggedIn: false, pending}, null, 2))
      this.exit(1)
      return
    }

    if (pending) {
      this.error(
        'Login pending — callback server is running, waiting for OAuth redirect. Wait 30-60 seconds and re-check, or run `sanity auth cancel` to stop.',
        {exit: 1},
      )
    }

    this.error(
      'Not logged in. Run `sanity login` or set the SANITY_AUTH_TOKEN environment variable.',
      {exit: 1},
    )
  }
}
