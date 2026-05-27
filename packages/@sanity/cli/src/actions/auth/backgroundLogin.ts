import {spawn} from 'node:child_process'
import {mkdirSync, readFileSync, writeFileSync} from 'node:fs'
import {homedir} from 'node:os'
import {dirname, join} from 'node:path'
import {fileURLToPath} from 'node:url'

import {subdebug} from '@sanity/cli-core'

const debug = subdebug('login:background')

function getConfigDir(): string {
  if (process.env.SANITY_CLI_CONFIG_PATH) {
    return dirname(process.env.SANITY_CLI_CONFIG_PATH)
  }
  const suffix = process.env.SANITY_INTERNAL_ENV === 'staging' ? '-staging' : ''
  return join(homedir(), '.config', `sanity${suffix}`)
}

interface PidFileInfo {
  loginUrl: string
  pid: number
  port: number
  providerUrl: string
}

function readPidFile(): PidFileInfo | null {
  try {
    return JSON.parse(readFileSync(join(getConfigDir(), '.bg-login.json'), 'utf8'))
  } catch {
    return null
  }
}

function writePidFile(info: PidFileInfo): void {
  const dir = getConfigDir()
  mkdirSync(dir, {recursive: true})
  writeFileSync(join(dir, '.bg-login.json'), JSON.stringify(info))
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function readChildPort(child: ReturnType<typeof spawn>): Promise<{loginUrl: string; port: number}> {
  return new Promise((resolve, reject) => {
    let buf = ''
    const timeout = setTimeout(() => reject(new Error('Child did not report port in time')), 5000)

    child.stdout?.on('data', (chunk: Buffer) => {
      buf += chunk.toString()
      const lines = buf.split('\n')
      if (lines.length >= 2) {
        clearTimeout(timeout)
        try {
          const info = JSON.parse(lines[0])
          resolve({loginUrl: info.loginUrl, port: info.port})
        } catch {
          reject(new Error(`Invalid child output: ${lines[0]}`))
        }
      }
    })

    child.on('error', (err) => {
      clearTimeout(timeout)
      reject(err)
    })

    child.on('exit', (code) => {
      if (code !== 0) {
        clearTimeout(timeout)
        reject(new Error(`Background login child exited with code ${code}`))
      }
    })
  })
}

/**
 * Spawn a detached child that handles the OAuth callback flow.
 * Returns immediately with the child's PID, port, and login URL.
 *
 * If a background login child is already running, returns its info
 * instead of spawning a new one (pidfile guard).
 */
export async function startBackgroundLogin(
  providerUrl: string,
  options: {open?: boolean} = {},
): Promise<{loginUrl: string; pid: number; port: number}> {
  const existing = readPidFile()
  if (existing && isProcessAlive(existing.pid)) {
    if (existing.providerUrl === providerUrl) {
      debug('Background login already running (PID %d, port %d)', existing.pid, existing.port)
      return {loginUrl: existing.loginUrl, pid: existing.pid, port: existing.port}
    }
    debug('Killing stale background login child (PID %d, different provider)', existing.pid)
    try {
      process.kill(existing.pid)
    } catch {
      // Process already exited
    }
  }

  const childScript = join(dirname(fileURLToPath(import.meta.url)), 'backgroundLoginChild.js')
  const args = [childScript, providerUrl]
  if (options.open !== false) {
    args.push('--open')
  }

  const child = spawn(process.execPath, args, {
    detached: true,
    env: {...process.env},
    stdio: ['ignore', 'pipe', 'ignore'],
  })

  const {loginUrl, port} = await readChildPort(child)

  child.stdout?.destroy()
  child.unref()

  const pid = child.pid
  if (!pid) {
    throw new Error('Failed to spawn background login process')
  }

  writePidFile({loginUrl, pid, port, providerUrl})

  debug('Background login child (PID %d) listening on port %d', pid, port)
  return {loginUrl, pid, port}
}
