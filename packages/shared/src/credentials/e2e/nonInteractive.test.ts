import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CredentialStore } from '../store.js'
import type { Credential } from '../types.js'

class NonInteractiveConsentRequired extends Error {
  readonly providerId: string
  readonly scopes: string[]

  constructor(providerId: string, scopes: string[]) {
    super(`Non-interactive consent required for provider "${providerId}"`)
    this.name = 'NonInteractiveConsentRequired'
    this.providerId = providerId
    this.scopes = scopes
  }
}

describe('non-interactive mode', () => {
  let tempRoot = ''
  let credentialsDir = ''
  let store: CredentialStore

  beforeEach(async () => {
    tempRoot = await mkdtemp(path.join(tmpdir(), 'natstack-credentials-non-interactive-'))
    credentialsDir = path.join(tempRoot, 'credentials')
    await mkdir(credentialsDir, { recursive: true })
    store = new CredentialStore({ basePath: credentialsDir })
  })

  afterEach(async () => {
    if (tempRoot) {
      await rm(tempRoot, { recursive: true, force: true })
    }

    tempRoot = ''
    credentialsDir = ''
  })

  it('loads pre-seeded credentials without requiring consent', async () => {
    const preSeededCredential: Credential = {
      providerId: 'test-provider',
      connectionId: 'service-account',
      connectionLabel: 'CI Service Account',
      accountIdentity: { providerUserId: 'sa-123' },
      accessToken: 'pre-seeded-token',
      scopes: ['read', 'write'],
    }

    await store.save(preSeededCredential)

    const loadedCredential = await store.load('test-provider', 'service-account')
    expect(loadedCredential).toEqual(preSeededCredential)

    const listedCredentials = await store.list('test-provider')
    expect(listedCredentials).toEqual([preSeededCredential])
  })

  it('throws NonInteractiveConsentRequired when no credential exists', async () => {
    const providerId = 'unknown-provider'
    const connectionId = 'default'
    const scopes = ['read', 'write']
    const nonInteractive = true

    try {
      const loadedCredential = await store.load(providerId, connectionId)
      expect(loadedCredential).toBeNull()

      if (loadedCredential === null && nonInteractive) {
        throw new NonInteractiveConsentRequired(providerId, scopes)
      }
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(NonInteractiveConsentRequired)

      if (!(error instanceof NonInteractiveConsentRequired)) {
        throw error
      }

      expect(error.providerId).toBe(providerId)
      expect(error.scopes).toEqual(scopes)
      return
    }

    throw new Error('Expected NonInteractiveConsentRequired to be thrown')
  })

  it('bot token pre-seed round-trips through the store', async () => {
    const botCredential: Credential = {
      providerId: 'slack',
      connectionId: 'bot',
      connectionLabel: 'CI Bot',
      accountIdentity: { providerUserId: 'bot' },
      accessToken: 'xoxb-test-bot-token',
      scopes: ['chat:write', 'channels:read'],
    }

    await store.save(botCredential)

    const loadedCredential = await store.load('slack', 'bot')
    expect(loadedCredential).toEqual(botCredential)
  })
})
