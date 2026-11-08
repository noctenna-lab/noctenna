import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { loadConfig, mainnetRpcUrl, saveConfig, setNetwork } from '../../src/core/config.js'

beforeEach(() => {
  process.env.NOCTENNA_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'noctenna-cfg-'))
  delete process.env.NOCTENNA_NETWORK
  delete process.env.NOCTENNA_RPC_URL
})
afterEach(() => {
  delete process.env.NOCTENNA_NETWORK
  delete process.env.NOCTENNA_RPC_URL
})

it('defaults to mainnet, $100 a day, 3% slippage', () => {
  expect(loadConfig()).toEqual({
    network: 'mainnet',
    rpcUrl: 'https://rpc.mainnet.chain.robinhood.com',
    dailyLimitUsd: 100,
    slippageBps: 300,
  })
  expect(mainnetRpcUrl()).toBe('https://rpc.mainnet.chain.robinhood.com')
})

it('the terminal switches the network and sets limits; env overrides are never written back', () => {
  setNetwork('testnet')
  expect(loadConfig().rpcUrl).toBe('https://rpc.testnet.chain.robinhood.com')
  saveConfig({ dailyLimitUsd: 50 })
  process.env.NOCTENNA_NETWORK = 'testnet'
  process.env.NOCTENNA_RPC_URL = 'http://127.0.0.1:8701'
  expect(loadConfig()).toMatchObject({ network: 'testnet', rpcUrl: 'http://127.0.0.1:8701', dailyLimitUsd: 50 })
  const file = JSON.parse(readFileSync(join(process.env.NOCTENNA_CONFIG_DIR!, 'config.json'), 'utf8'))
  expect(file).toMatchObject({ network: 'testnet', dailyLimitUsd: 50 })
  expect(JSON.stringify(file)).not.toContain('8701')
})

it('rejects bad values', () => {
  expect(() => saveConfig({ slippageBps: 9_000 })).toThrow()
  expect(() => setNetwork('devnet' as never)).toThrow()
  process.env.NOCTENNA_NETWORK = 'devnet'
  expect(() => loadConfig()).toThrow()
})
