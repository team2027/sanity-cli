import {spawn} from 'node:child_process'

import {subdebug} from '@sanity/cli-core'

const debug = subdebug('login:background')

/**
 * Spawn a detached child process that:
 * 1. Binds a callback server (tries ports 4321, 4000, 3003, 1234, 8080, 13333)
 * 2. Constructs the login URL with the bound port
 * 3. Opens the browser via the `open` npm package or system xdg-open
 * 4. Waits for the OAuth callback
 * 5. Writes the token to ~/.config/sanity/config.json
 * 6. Exits
 *
 * The parent process can exit immediately after calling this.
 *
 * @param providerUrl - The OAuth provider URL from the Sanity API
 * @returns The PID of the child process
 */
export function spawnBackgroundLoginChild(providerUrl: string): number {
  const script = buildChildScript(providerUrl)

  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
    detached: true,
    stdio: ['ignore', 'pipe', 'ignore'],
    env: {...process.env},
  })

  child.unref()

  const pid = child.pid
  if (!pid) {
    throw new Error('Failed to spawn background login process')
  }

  debug('Spawned background login child (PID %d)', pid)
  return pid
}

/**
 * Read the port the child bound to from its stdout.
 * The child prints the port as the first line.
 */
export function readChildPort(
  child: ReturnType<typeof spawn>,
): Promise<{port: number; loginUrl: string}> {
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
 * Spawn the background login child and wait for it to report its port.
 */
export async function startBackgroundLogin(
  providerUrl: string,
): Promise<{pid: number; port: number; loginUrl: string}> {
  const script = buildChildScript(providerUrl)

  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
    detached: true,
    stdio: ['ignore', 'pipe', 'ignore'],
    env: {...process.env},
  })

  const {port, loginUrl} = await readChildPort(child)

  // Now that we have the port, detach fully
  child.stdout?.destroy()
  child.unref()

  const pid = child.pid
  if (!pid) {
    throw new Error('Failed to spawn background login process')
  }

  debug('Background login child (PID %d) listening on port %d', pid, port)
  return {pid, port, loginUrl}
}

function buildChildScript(providerUrl: string): string {
  return `
import { createServer } from 'node:http';
import { get } from 'node:https';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir, hostname, platform } from 'node:os';
import { join, dirname } from 'node:path';
import { execSync } from 'node:child_process';

const PROVIDER_URL = ${JSON.stringify(providerUrl)};
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

  // Open browser
  try { execSync('open ' + JSON.stringify(loginUrl) + ' 2>/dev/null || xdg-open ' + JSON.stringify(loginUrl) + ' 2>/dev/null || true'); }
  catch {}
});

server.listen(PORTS[portIndex]);

// Self-destruct after timeout
setTimeout(() => { server.close(); process.exit(1); }, TIMEOUT_MS);
`
}
