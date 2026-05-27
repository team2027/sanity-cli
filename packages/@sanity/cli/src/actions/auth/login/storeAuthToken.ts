import {getUserConfig, type Output, setCliUserConfig} from '@sanity/cli-core'
import {isHttpError} from '@sanity/client'

import {logout} from '../../../services/auth.js'
import {isSanityApiToken} from './validateToken.js'

export async function storeAuthToken(
  authToken: string,
  previousToken: string | undefined,
  output: Pick<Output, 'warn'>,
) {
  setCliUserConfig('authToken', authToken)
  getUserConfig().delete('telemetryConsent')

  if (previousToken && previousToken !== authToken) {
    await invalidateAuthToken(previousToken, output)
  }
}

async function invalidateAuthToken(token: string, output: Pick<Output, 'warn'>) {
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
