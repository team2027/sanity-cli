import {
  type CLITelemetryStore,
  getCliToken,
  getUserConfig,
  isInteractive,
  type Output,
  setCliUserConfig,
  subdebug,
} from '@sanity/cli-core'
import {spinner} from '@sanity/cli-core/ux'
import {isHttpError} from '@sanity/client'
import open from 'open'

import {logout} from '../../../services/auth.js'
import {LoginTrace} from '../../../telemetry/login.telemetry.js'
import {canLaunchBrowser} from '../../../util/canLaunchBrowser.js'
import {startServerForTokenCallback} from '../authServer.js'
import {spawnBackgroundLoginChild} from '../backgroundLogin.js'
import {getProvider} from './getProvider.js'
import {isSanityApiToken, validateToken} from './validateToken.js'

const debug = subdebug('login')

interface LoginOptions {
  output: Output

  telemetry: CLITelemetryStore

  experimental?: boolean
  forceBrowser?: boolean
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
    const {startBackgroundLogin} = await import('../backgroundLogin.js')

    // Child picks its own port, constructs login URL, opens browser
    const {pid, port, loginUrl} = await startBackgroundLogin(provider.url)

    output.log(`\nOpening browser at ${loginUrl}\n`)
    output.log(`Authentication is running in the background (PID ${pid}, port ${port}).`)
    output.log(`The token will be saved automatically when login completes.`)
    output.log(`Run \`sanity projects list\` to verify when ready.\n`)

    trace.complete()
    return
  }

  const {loginUrl, server, token: tokenPromise} = await startServerForTokenCallback(provider.url)

  trace.log({step: 'waitForToken'})

  // Open a browser on the login page (or tell the user to)
  const shouldLaunchBrowser = (options.forceBrowser || canLaunchBrowser()) && options.open !== false

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

async function storeAuthToken(
  authToken: string,
  previousToken: string | undefined,
  output: Output,
) {
  setCliUserConfig('authToken', authToken)
  getUserConfig().delete('telemetryConsent')

  // If we had a session previously, attempt to clear it
  if (previousToken && previousToken !== authToken) {
    await invalidateAuthToken(previousToken, output)
  }
}

async function invalidateAuthToken(token: string, output: Output) {
  try {
    if (await isSanityApiToken(token)) return
  } catch (err) {
    if (isHttpError(err) && err.statusCode === 401) return
  }

  try {
    await logout(token)
  } catch (err) {
    if (!isHttpError(err) || err.statusCode !== 401) {
      output.warn('Failed to invalidate previous session')
    }
  }
}
