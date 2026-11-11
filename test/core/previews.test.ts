import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PublicClient } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { beforeEach, expect, it } from 'vitest'
import { checkLimit, execute, PREVIEW_TTL_MS, spentToday, storePreview, takePreview } from '../../src/core/previews.js'
import type { Config, Preview } from '../../src/core/types.js'

const config: Config = { network: 'testnet', rpcUrl: 'http://127.0.0.1:1', dailyLimitUsd: 100, slippageBps: 300 }
const account = async () => privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80')
const chain = (id = 46630) => ({ getChainId: async () => id }) as unknown as PublicClient
const offchain = (usd: number, out: unknown[] = []): Preview => ({
  summary: ['x'],
  usd,
  steps: [{ type: 'offchain', label: 'post', run: async () => (out.push(1), 'ok') }],
})

beforeEach(() => {
  process.env.NOCTENNA_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'noctenna-pv-'))
})

it('a preview leads with its network, runs once, and expires after 2 minutes', () => {
  const p = storePreview(offchain(1), 'testnet', 0)
  expect(p.summary[0]).toBe('Network: Robinhood Chain testnet (46630)')
  expect(p.expiresAt).toBe(new Date(PREVIEW_TTL_MS).toISOString())
  expect(takePreview(p.previewId, 'testnet', 1).usd).toBe(1)
  expect(() => takePreview(p.previewId, 'testnet', 1)).toThrow(/already used/)
  const old = storePreview(offchain(1), 'testnet', 0)
  expect(() => takePreview(old.previewId, 'testnet', PREVIEW_TTL_MS)).toThrow(/expired/)
  const net = storePreview(offchain(1), 'testnet', 0)
  expect(() => takePreview(net.previewId, 'mainnet', 1)).toThrow(/made on testnet/)
})

it('the daily limit counts per UTC day and fails closed on a broken ledger', async () => {
  const day1 = Date.parse('2026-11-08T23:59:00Z')
  const ran: unknown[] = []
  await execute(
    { chain: chain(), config, account, now: () => day1 },
    storePreview(offchain(60, ran), 'testnet', day1).previewId,
  )
  expect(spentToday('testnet', day1)).toBe(60)
  expect(spentToday('mainnet', day1)).toBe(0) // testnet practice leaves the real-funds allowance alone
  await expect(
    execute(
      { chain: chain(), config, account, now: () => day1 },
      storePreview(offchain(41, ran), 'testnet', day1).previewId,
    ),
  ).rejects.toThrow(/daily limit/)
  expect(ran).toHaveLength(1)
  const day2 = day1 + 120_000
  expect(spentToday('testnet', day2)).toBe(0)
  expect(() => checkLimit(config, 100, day2)).not.toThrow()
  expect(() => checkLimit(config, Number.NaN, day2)).toThrow(/no USD value/)
  writeFileSync(join(process.env.NOCTENNA_CONFIG_DIR!, 'spend-testnet.json'), '{oops')
  expect(() => checkLimit(config, 1, day2)).toThrow(/unreadable/)
})

it('execute refuses an RPC on another chain, runs recheck first, and signs typed data with the local key', async () => {
  await expect(
    execute({ chain: chain(4663), config, account }, storePreview(offchain(1), 'testnet').previewId),
  ).rejects.toThrow(/answers chain 4663/)
  const moved: Preview = {
    ...offchain(1),
    recheck: async () => {
      throw new Error('price moved')
    },
  }
  await expect(execute({ chain: chain(), config, account }, storePreview(moved, 'testnet').previewId)).rejects.toThrow(
    /price moved/,
  )
  expect(spentToday('testnet')).toBe(0)
  let sig = ''
  const typed: Preview = {
    summary: [],
    usd: 0,
    steps: [
      {
        type: 'typedData',
        label: 'register key',
        typedData: {
          domain: { name: 'x', chainId: 46630 },
          types: { M: [{ name: 'a', type: 'uint256' }] },
          primaryType: 'M',
          message: { a: 1n },
        },
        then: async (s) => ((sig = s), 'registered'),
      },
    ],
  }
  const r = await execute({ chain: chain(), config, account }, storePreview(typed, 'testnet').previewId)
  expect(r).toMatchObject({
    network: 'testnet',
    steps: [{ label: 'register key', type: 'typedData', result: 'registered' }],
  })
  expect(sig).toMatch(/^0x[0-9a-f]{130}$/)
})
