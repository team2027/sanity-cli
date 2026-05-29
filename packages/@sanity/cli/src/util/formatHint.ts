import {styleText} from 'node:util'

export function formatHint(...commands: string[]): string {
  const lines = commands.map((cmd) => `  ${cmd}`).join('\n')
  return `\n${styleText('cyan', '[Hint]')}\n${lines}`
}
