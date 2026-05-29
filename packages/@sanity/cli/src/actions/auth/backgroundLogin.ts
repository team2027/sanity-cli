import {spawn} from 'node:child_process'
import {randomUUID} from 'node:crypto'
import {mkdirSync, readFileSync, unlinkSync, writeFileSync} from 'node:fs'
import {connect} from 'node:net'
import {homedir} from 'node:os'
import {dirname, join} from 'node:path'
import {fileURLToPath} from 'node:url'

import {subdebug} from '@sanity/cli-core'

const debug = subdebug('login:background')
const CHILD_TIMEOUT_MS = 300_000
const PIDFILE_TTL_MS = CHILD_TIMEOUT_MS + 10_000

export function getBackgroundLoginConfigPath(): string {
  if (process.env.SANITY_CLI_CONFIG_PATH) {
    return process.env.SANITY_CLI_CONFIG_PATH
  }
  const suffix = process.env.SANITY_INTERNAL_ENV === 'staging' ? '-staging' : ''
  return join(homedir(), '.config', `sanity${suffix}`, 'config.json')
}

function getConfigDir(): string {
  return dirname(getBackgroundLoginConfigPath())
}

function getPidFilePath(): string {
  return join(getConfigDir(), '.auth-callback.json')
}

interface PidFileInfo {
  createdAt: number
  loginUrl: string
  nonce: string
  pid: number
  port: number
  providerUrl: string
}

function readPidFile(): PidFileInfo | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(getPidFilePath(), 'utf8'))
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      !('createdAt' in parsed) ||
      !('loginUrl' in parsed) ||
      !('nonce' in parsed) ||
      !('pid' in parsed) ||
      !('port' in parsed) ||
      !('providerUrl' in parsed) ||
      typeof parsed.createdAt !== 'number' ||
      typeof parsed.loginUrl !== 'string' ||
      typeof parsed.nonce !== 'string' ||
      typeof parsed.pid !== 'number' ||
      typeof parsed.port !== 'number' ||
      typeof parsed.providerUrl !== 'string'
    ) {
      return null
    }
    return {
      createdAt: parsed.createdAt,
      loginUrl: parsed.loginUrl,
      nonce: parsed.nonce,
      pid: parsed.pid,
      port: parsed.port,
      providerUrl: parsed.providerUrl,
    }
  } catch {
    return null
  }
}

export function writeBackgroundLoginPidFile(info: PidFileInfo): void {
  const dir = getConfigDir()
  mkdirSync(dir, {recursive: true})
  writeFileSync(getPidFilePath(), JSON.stringify(info))
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function isPidFileFresh(info: PidFileInfo): boolean {
  return Date.now() - info.createdAt < PIDFILE_TTL_MS
}

function isPortOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({host: '127.0.0.1', port})
    const done = (open: boolean) => {
      socket.destroy()
      resolve(open)
    }
    socket.setTimeout(500)
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
    socket.once('timeout', () => done(false))
  })
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
  if (
    existing &&
    existing.providerUrl === providerUrl &&
    isPidFileFresh(existing) &&
    isProcessAlive(existing.pid) &&
    (await isPortOpen(existing.port))
  ) {
    debug('Background login already running (PID %d, port %d)', existing.pid, existing.port)
    return {loginUrl: existing.loginUrl, pid: existing.pid, port: existing.port}
  }

  const childScript = join(dirname(fileURLToPath(import.meta.url)), 'backgroundLoginChild.js')
  const nonce = randomUUID()
  const args = [childScript, providerUrl, nonce]
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

  debug('Background login child (PID %d) listening on port %d', pid, port)
  return {loginUrl, pid, port}
}

export function isBackgroundLoginInProgress(): boolean {
  const info = readPidFile()
  if (!info) return false
  return isPidFileFresh(info) && isProcessAlive(info.pid)
}

export function cancelBackgroundLogin(): {cancelled: boolean; pid?: number} {
  const info = readPidFile()
  if (!info) {
    return {cancelled: false}
  }

  const pidFilePath = getPidFilePath()
  try {
    unlinkSync(pidFilePath)
  } catch {
    // already removed
  }

  if (isProcessAlive(info.pid)) {
    try {
      process.kill(info.pid, 'SIGTERM')
    } catch {
      // already dead
    }
    return {cancelled: true, pid: info.pid}
  }

  return {cancelled: false}
}
