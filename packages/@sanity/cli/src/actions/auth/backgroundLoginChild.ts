/**
 * Standalone entry point for the background login child process.
 * Spawned detached by `startBackgroundLogin` — do not import directly.
 *
 * Usage: node backgroundLoginChild.js <providerUrl> [--open]
 *
 * 1. Starts a callback server (reuses authServer.ts logic)
 * 2. Optionally opens the login URL in a browser
 * 3. Reports {port, loginUrl} as JSON on stdout
 * 4. Waits for OAuth callback
 * 5. Writes the token to CLI config
 * 6. Exits
 */
import {setCliUserConfig} from '@sanity/cli-core'
import open from 'open'

import {startServerForTokenCallback} from './authServer.js'

const TIMEOUT_MS = 150_000

const providerUrl = process.argv[2]
if (!providerUrl) {
  process.stderr.write('Usage: backgroundLoginChild.js <providerUrl> [--open]\n')
  process.exit(1)
}

const shouldOpen = process.argv.includes('--open')

const {loginUrl, server, token: tokenPromise} = await startServerForTokenCallback(providerUrl)
const port = (server.address() as {port: number}).port

process.stdout.write(JSON.stringify({port, loginUrl: loginUrl.href}) + '\n')

if (shouldOpen) {
  open(loginUrl.href).catch(() => {})
}

const timeout = setTimeout(() => {
  server.close()
  process.exit(1)
}, TIMEOUT_MS)

try {
  const {token} = await tokenPromise
  setCliUserConfig('authToken', token)
  clearTimeout(timeout)
  server.close()
  process.exit(0)
} catch {
  clearTimeout(timeout)
  server.close()
  process.exit(1)
}
