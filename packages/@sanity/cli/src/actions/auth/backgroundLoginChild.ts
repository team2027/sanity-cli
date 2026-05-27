/**
 * Standalone entry point for the background login child process.
 * Spawned detached by `startBackgroundLogin` — do not import directly.
 *
 * Usage: node backgroundLoginChild.js <providerUrl> <nonce> [--open]
 *
 * 1. Starts a callback server (reuses authServer.ts logic)
 * 2. Optionally opens the login URL in a browser
 * 3. Reports the port and login URL as JSON on stdout
 * 4. Waits for OAuth callback
 * 5. Writes the token to CLI config
 * 6. Exits
 */
import {existsSync, readFileSync, unlinkSync} from 'node:fs'
import {dirname, join} from 'node:path'

import {getCliToken} from '@sanity/cli-core'
import open from 'open'

import {startServerForTokenCallback} from './authServer.js'
import {getBackgroundLoginConfigPath, writeBackgroundLoginPidFile} from './backgroundLogin.js'
import {storeAuthToken} from './login/storeAuthToken.js'

const TIMEOUT_MS = 150_000

const providerUrl = process.argv[2]
if (!providerUrl) {
  process.stderr.write('Usage: backgroundLoginChild.js <providerUrl> <nonce> [--open]\n')
  process.exit(1)
}
const nonce = process.argv[3]
if (!nonce) {
  process.stderr.write('Usage: backgroundLoginChild.js <providerUrl> <nonce> [--open]\n')
  process.exit(1)
}

const shouldOpen = process.argv.includes('--open')
const pidFilePath = join(dirname(getBackgroundLoginConfigPath()), '.bg-login.json')

function cleanupPidFile(): void {
  if (!existsSync(pidFilePath)) return
  try {
    const parsed: unknown = JSON.parse(readFileSync(pidFilePath, 'utf8'))
    if (
      parsed &&
      typeof parsed === 'object' &&
      'pid' in parsed &&
      'nonce' in parsed &&
      parsed.pid === process.pid &&
      parsed.nonce === nonce
    ) {
      unlinkSync(pidFilePath)
    }
  } catch {
    return
  }
}

process.once('exit', cleanupPidFile)
process.once('SIGTERM', () => {
  cleanupPidFile()
  process.exit(1)
})

const {loginUrl, server, token: tokenPromise} = await startServerForTokenCallback(providerUrl)
const port = (server.address() as {port: number}).port

writeBackgroundLoginPidFile({
  createdAt: Date.now(),
  loginUrl: loginUrl.href,
  nonce,
  pid: process.pid,
  port,
  providerUrl,
})

process.stdout.write(JSON.stringify({loginUrl: loginUrl.href, port}) + '\n')

if (shouldOpen) {
  try {
    await open(loginUrl.href)
  } catch (error) {
    void error
  }
}

const timeout = setTimeout(() => {
  server.close()
  process.exit(1)
}, TIMEOUT_MS)

try {
  const previousToken = await getCliToken()
  const {token} = await tokenPromise
  await storeAuthToken(token, previousToken, {
    warn: (message: Error | string) => {
      return message
    },
  })
  clearTimeout(timeout)
  server.close()
  process.exit(0)
} catch {
  clearTimeout(timeout)
  server.close()
  process.exit(1)
}
