import {SanityCommand} from '@sanity/cli-core'

import {cancelBackgroundLogin} from '../../actions/auth/backgroundLogin.js'

export class Cancel extends SanityCommand<typeof Cancel> {
  static override description = 'Cancel a running background login process'
  static override examples = [
    {
      command: '<%= config.bin %> <%= command.id %>',
      description: 'Cancel background login',
    },
  ]

  public async run() {
    const {cancelled} = cancelBackgroundLogin()
    if (cancelled) {
      this.log('Background login cancelled.')
    } else {
      this.log('No background login in progress.')
    }
  }
}
