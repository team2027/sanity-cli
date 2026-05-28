import {
  type CLITelemetryStore,
  getCliToken,
  getUserConfig,
  isInteractive,
  type Output,
  subdebug,
} from '@sanity/cli-core'
import {spinner} from '@sanity/cli-core/ux'
import open from 'open'

import {LoginTrace} from '../../../telemetry/login.telemetry.js'
import {canLaunchBrowser} from '../../../util/canLaunchBrowser.js'
import {startServerForTokenCallback} from '../authServer.js'
import {getBackgroundLoginConfigPath, startBackgroundLogin} from '../backgroundLogin.js'
import {getProvider} from './getProvider.js'
import {storeAuthToken} from './storeAuthToken.js'
import {validateToken} from './validateToken.js'

const debug = subdebug('login')

interface LoginOptions {
  output: Output

  telemetry: CLITelemetryStore

  experimental?: boolean
  open?: boolean
  provider?: string
  sso?: string
  ssoProvider?: string
  token?: string
}

/**
 * Trigger the authentication flow for the CLI.
 *
 * NOTE: Without a token option, this uses terminal prompts and will not work for
 * non-interactive/programmatic uses.
 *
 * @param options - Options for the login operation
 * @returns Promise that resolves when the login operation is complete
 * @throws Will throw if login fails or is cancelled
 * @internal
 */
export async function login(options: LoginOptions) {
  const {output, telemetry} = options
  const previousToken = await getCliToken()

  const trace = telemetry.trace(LoginTrace)
  trace.start()

  if (typeof options.token === 'string') {
    try {
      const authToken = await validateToken(options.token)
      await storeAuthToken(authToken, previousToken, output)
      trace.complete()
    } catch (err: unknown) {
      trace.error(err as Error)
      throw err
    }
    return
  }

  const provider = await getProvider({
    experimental: options.experimental,
    orgSlug: options.sso,
    specifiedProvider: options.provider,
    ssoProvider: options.ssoProvider,
  })

  trace.log({provider: provider?.name, step: 'selectProvider'})

  if (provider === undefined) {
    throw new Error('No authentication providers found')
  }

  // In non-interactive mode (CI, containers, AI agents), self-background the
  // callback server so the CLI returns immediately. The browser-agent or user
  // completes OAuth in the background; the token is written to config when the
  // callback fires. The caller can retry `sanity init` until auth succeeds.
  if (!isInteractive()) {
    // Pre-populate telemetryDisclosed so the next CLI command's prerun hook
    // doesn't do a read-modify-write that clobbers the token the child writes.
    const userConfig = getUserConfig()
    if (!userConfig.get('telemetryDisclosed')) {
      userConfig.set('telemetryDisclosed', Date.now())
    }

    const shouldOpen = options.open !== false
    const {loginUrl, pid, port} = await startBackgroundLogin(provider.url, {open: shouldOpen})

    if (shouldOpen) {
      output.log(`\nOpening browser at ${loginUrl}\n`)
    } else {
      output.log(`\nPlease open a browser at ${loginUrl}\n`)
    }
    debug('Background login child PID %d listening on port %d', pid, port)
    output.log(`Authentication is running in the background.`)
    output.log(
      `Please complete login in the browser. Token saves to ${getBackgroundLoginConfigPath()} when done.`,
    )
    output.log('')
    output.log(`Wait for login to complete (~30-60 seconds), then check: sanity auth status`)
    output.log(`To switch providers or cancel: sanity auth cancel`)
    output.log(`Do not run other sanity commands until \`sanity auth status\` confirms login.\n`)

    trace.complete()
    return
  }

  const {loginUrl, server, token: tokenPromise} = await startServerForTokenCallback(provider.url)

  trace.log({step: 'waitForToken'})

  // Open a browser on the login page (or tell the user to)
  const shouldLaunchBrowser = canLaunchBrowser() && options.open !== false

  if (shouldLaunchBrowser) {
    open(loginUrl.href)
    output.log(`\nOpening browser at ${loginUrl.href}\n`)
  } else {
    output.log(`\nPlease open a browser at ${loginUrl.href}\n`)
  }

  const spin = spinner('Waiting for browser login to complete... Press Ctrl + C to cancel').start()

  // Wait for a success/error on the HTTP callback server
  let authToken: string
  try {
    authToken = (await tokenPromise).token
    spin.stop()
  } catch (err: unknown) {
    spin.stop()
    trace.error(err as Error)
    debug('Error retrieving token: %O', err)
    throw err
  } finally {
    await new Promise<void>((resolve) => {
      server.close(() => resolve())
    })
  }

  await storeAuthToken(authToken, previousToken, output)

  trace.complete()
}
