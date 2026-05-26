import {text} from 'node:stream/consumers'

import {Command, Flags} from '@oclif/core'
import {type FlagInput} from '@oclif/core/interfaces'
import {isInteractive, SanityCommand} from '@sanity/cli-core'

import {login} from '../actions/auth/login/login.js'

export class LoginCommand extends SanityCommand<typeof LoginCommand> {
  static override description = `Log in to your Sanity account

Opens a browser for authentication. If a browser session is already
authenticated, this completes in seconds.`
  static override examples: Array<Command.Example> = [
    {
      command: '<%= config.bin %> <%= command.id %>',
      description: 'Log in via browser (opens automatically)',
    },
    {
      command: '<%= config.bin %> <%= command.id %> --provider github',
      description: 'Log in with a specific provider',
    },
    {
      command: '<%= config.bin %> <%= command.id %> --provider github --no-open',
      description: 'Print login URL without opening browser',
    },
    {
      command: '<%= config.bin %> <%= command.id %> --sso my-organization',
      description: 'Log in using Single Sign-On with the "my-organization" slug',
    },
    {
      command:
        '<%= config.bin %> <%= command.id %> --sso my-organization --sso-provider "Okta SSO"',
      description: 'Log in using a specific SSO provider within an organization',
    },
    {
      command: '<%= config.bin %> <%= command.id %> --with-token < token.txt',
      description: 'Log in using a token from standard input',
    },
    {
      command: 'SANITY_AUTH_TOKEN=<token> <%= config.bin %> init --yes',
      description: 'Skip login entirely by setting a token as an environment variable',
    },
  ]
  static override flags = {
    background: Flags.boolean({
      default: false,
      description:
        'Open browser, auto-pick provider, wait up to 120s for login (recommended for automated use)',
      exclusive: ['with-token', 'sso'],
      hidden: true,
    }),
    experimental: Flags.boolean({
      default: false,
      hidden: true,
    }),
    open: Flags.boolean({
      allowNo: true,
      default: true,
      description: 'Open a browser window to log in (`--no-open` only prints URL)',
      hidden: true,
    }),
    provider: Flags.string({
      description: 'Log in using the given provider',
      exclusive: ['sso', 'with-token'],
      helpValue: '<providerId>',
    }),
    sso: Flags.string({
      description: 'Log in using Single Sign-On, using the given organization slug',
      exclusive: ['provider', 'with-token'],
      helpValue: '<slug>',
    }),
    'sso-provider': Flags.string({
      dependsOn: ['sso'],
      description: 'Select a specific SSO provider by name (use with --sso)',
      helpValue: '<name>',
    }),
    'with-token': Flags.boolean({
      description: 'Read token from standard input',
      exclusive: ['provider', 'sso'],
    }),
  } satisfies FlagInput

  public async run(): Promise<void> {
    const {flags} = await this.parse(LoginCommand)
    const {background, 'sso-provider': ssoProvider, 'with-token': withToken, ...loginFlags} = flags

    try {
      const token = withToken ? await readTokenFromStdin() : undefined

      await login({
        ...loginFlags,
        forceBrowser: background,
        open: background ? true : loginFlags.open,
        output: this.output,
        ssoProvider,
        telemetry: this.telemetry,
        token,
      })

      if (!isInteractive()) {
        // Non-interactive mode spawns a background child — don't claim success yet
      } else {
        this.log('Login successful')
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.error(`Login failed: ${message}`, {exit: 1})
    }
  }
}

async function readTokenFromStdin(): Promise<string> {
  if (process.stdin.isTTY) {
    throw new Error(
      'Token is required on standard input. Run `sanity login --with-token < token.txt`.',
    )
  }

  return text(process.stdin)
}
