import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { privateKeyToAccount } from 'viem/accounts'
import { beforeEach, expect, it } from 'vitest'
import {
  createWallet,
  exportKey,
  getAddress,
  importWallet,
  localAccount,
  secretDelete,
  secretGet,
  secretSet,
} from '../../src/core/wallet.js'

// anvil's first dev key, public everywhere; never a real wallet
const ANVIL0 = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'

beforeEach(() => {
  process.env.NOCTENNA_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'noctenna-ks-'))
  process.env.NOCTENNA_KEYSTORE = 'file'
  process.env.NOCTENNA_KEYSTORE_PASSWORD = 'test-password'
})

it('creates one wallet, refuses a second, and keeps the key encrypted at rest', async () => {
  expect(await getAddress()).toBeNull()
  const address = await createWallet()
  expect(await getAddress()).toBe(address)
  await expect(createWallet()).rejects.toThrow(/already exists/)
  await expect(importWallet(ANVIL0)).rejects.toThrow(/already exists/)
  const key = await exportKey()
  expect(privateKeyToAccount(key).address).toBe(address)
  expect((await localAccount()).address).toBe(address)
  const file = readFileSync(join(process.env.NOCTENNA_CONFIG_DIR!, 'keystore.json'), 'utf8')
  expect(file).not.toContain(key.slice(2))
  expect(file.toLowerCase()).not.toContain(address.slice(2).toLowerCase())
})

it('imports a key and fails on a wrong password', async () => {
  expect(await importWallet(ANVIL0)).toBe('0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266')
  process.env.NOCTENNA_KEYSTORE_PASSWORD = 'wrong'
  await expect(getAddress()).rejects.toThrow()
})

it('rejects malformed keys', async () => {
  await expect(importWallet('0x1234')).rejects.toThrow(/32 bytes/)
})

it('generic secrets never reach the wallet key', async () => {
  await createWallet()
  expect(await secretGet('arcus-key')).toBeNull()
  await secretSet('arcus-key', 'abc')
  expect(await secretGet('arcus-key')).toBe('abc')
  await secretDelete('arcus-key')
  expect(await secretGet('arcus-key')).toBeNull()
  expect(await secretGet('wallet-key')).toBeNull()
  await expect(secretGet('../wallet-key')).rejects.toThrow()
})
