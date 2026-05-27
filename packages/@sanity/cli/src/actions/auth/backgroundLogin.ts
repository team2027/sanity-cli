import {spawn} from 'node:child_process'
import {mkdirSync, readFileSync, writeFileSync} from 'node:fs'
import {homedir} from 'node:os'
import {dirname, join} from 'node:path'

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

function readChildPort(child: ReturnType<typeof spawn>): Promise<{port: number; loginUrl: string}> {
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
          resolve({port: info.port, loginUrl: info.loginUrl})
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
): Promise<{pid: number; port: number; loginUrl: string}> {
  const existing = readPidFile()
  if (existing && isProcessAlive(existing.pid)) {
    if (existing.providerUrl === providerUrl) {
      debug('Background login already running (PID %d, port %d)', existing.pid, existing.port)
      return {pid: existing.pid, port: existing.port, loginUrl: existing.loginUrl}
    }
    debug('Killing stale background login child (PID %d, different provider)', existing.pid)
    try {
      process.kill(existing.pid)
    } catch {}
  }

  const shouldOpen = options.open !== false
  const script = buildChildScript(providerUrl, shouldOpen)

  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
    detached: true,
    stdio: ['ignore', 'pipe', 'ignore'],
    env: {...process.env},
  })

  const {port, loginUrl} = await readChildPort(child)

  child.stdout?.destroy()
  child.unref()

  const pid = child.pid
  if (!pid) {
    throw new Error('Failed to spawn background login process')
  }

  writePidFile({pid, port, loginUrl, providerUrl})

  debug('Background login child (PID %d) listening on port %d', pid, port)
  return {pid, port, loginUrl}
}

function buildChildScript(providerUrl: string, shouldOpen: boolean): string {
  return `
import { createServer } from 'node:http';
import { get } from 'node:https';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir, hostname, platform } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';

const PROVIDER_URL = ${JSON.stringify(providerUrl)};
const SHOULD_OPEN = ${JSON.stringify(shouldOpen)};
const PORTS = [4321, 4000, 3003, 1234, 8080, 13333];
const TIMEOUT_MS = 300_000; // 5 minutes

const configPath = process.env.SANITY_CLI_CONFIG_PATH ||
  join(homedir(), '.config', process.env.SANITY_INTERNAL_ENV === 'staging' ? 'sanity-staging' : 'sanity', 'config.json');

function writeToken(token) {
  mkdirSync(dirname(configPath), { recursive: true });
  let config = {};
  try { config = JSON.parse(readFileSync(configPath, 'utf8')); } catch {}
  config.authToken = token;
  writeFileSync(configPath, JSON.stringify(config, null, 2));
}

function buildLoginUrl(port) {
  const url = new URL(PROVIDER_URL);
  const platformNames = { darwin: 'MacOS', linux: 'Linux', win32: 'Windows' };
  const host = hostname().replace(/\\.(local|lan)$/, '');
  const plat = platformNames[platform()] || platform();
  url.searchParams.set('type', 'token');
  url.searchParams.set('label', host + ' / ' + plat);
  url.searchParams.set('origin', 'http://localhost:' + port + '/callback');
  return url.href;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://localhost');
  if (url.pathname !== '/callback') {
    res.writeHead(404);
    res.end('Not Found');
    return;
  }

  const absoluteTokenUrl = url.searchParams.get('url');
  if (!absoluteTokenUrl) {
    res.writeHead(303, { Location: 'https://www.sanity.io/login/error' });
    res.end();
    server.close();
    process.exit(1);
  }

  try {
    const token = await new Promise((resolve, reject) => {
      get(absoluteTokenUrl, (tokenRes) => {
        let data = '';
        tokenRes.on('data', chunk => data += chunk);
        tokenRes.on('end', () => {
          try { resolve(JSON.parse(data).token); }
          catch (e) { reject(new Error('Invalid token response')); }
        });
      }).on('error', reject);
    });

    writeToken(token);
    res.writeHead(303, { Location: 'https://www.sanity.io/login/success' });
    res.end();
  } catch {
    res.writeHead(303, { Location: 'https://www.sanity.io/login/error?error=UNRESOLVED_SESSION' });
    res.end();
  }

  server.close();
  process.exit(0);
});

// Try ports in sequence, handle EADDRINUSE
let portIndex = 0;
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    portIndex++;
    if (portIndex >= PORTS.length) {
      process.stderr.write('No available port for login callback\\n');
      process.exit(1);
    }
    server.listen(PORTS[portIndex]);
  } else {
    process.stderr.write('Server error: ' + err.message + '\\n');
    process.exit(1);
  }
});

server.on('listening', () => {
  const port = PORTS[portIndex];
  const loginUrl = buildLoginUrl(port);

  // Report port and URL to parent via stdout (JSON line)
  process.stdout.write(JSON.stringify({ port, loginUrl }) + '\\n');

  if (SHOULD_OPEN) {
    const openers = platform() === 'darwin' ? ['open'] : ['xdg-open'];
    for (const cmd of openers) {
      try { execFileSync(cmd, [loginUrl], { stdio: 'ignore' }); break; }
      catch {}
    }
  }
});

server.listen(PORTS[portIndex]);

// Self-destruct after timeout
setTimeout(() => { server.close(); process.exit(1); }, TIMEOUT_MS);
`
}
