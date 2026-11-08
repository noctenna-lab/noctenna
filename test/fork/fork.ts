// A local anvil fork of Robinhood Chain mainnet for write-path tests, and an MCP client talking to our server.
// Nothing here touches the live chain's state. The wallet is a fresh random key in the file keystore (never printed),
// funded on the fork only: anvil's dev accounts carry a live 7702 sweeper and KyberSwap refuses to build for them.
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseEther, toHex, type Address } from 'viem'
import { generatePrivateKey } from 'viem/accounts'
import { createChain, USER_AGENT } from '../../src/core/chain.js'
import { saveConfig } from '../../src/core/config.js'
import { buildCtx, createServer } from '../../src/core/server.js'
import type { Ctx } from '../../src/core/types.js'
import { importWallet } from '../../src/core/wallet.js'

export const PORT = Number(process.env.ANVIL_PORT ?? 8701)
export const URL_ = `http://127.0.0.1:${PORT}`
export const TIMEOUT = 600_000

export async function rpc(method: string, params: unknown[] = []) {
  const r = await fetch(URL_, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  const j = (await r.json()) as { result?: unknown; error?: { message: string } }
  if (j.error) throw new Error(j.error.message)
  return j.result
}

export async function startFork(opts: { http?: (c: Ctx) => Ctx['http'] } = {}) {
  const proc = spawn(
    'anvil',
    [
      '--port',
      String(PORT),
      '--fork-url',
      'https://rpc.mainnet.chain.robinhood.com',
      '--chain-id',
      '4663',
      '--fork-header',
      `User-Agent: ${USER_AGENT}`,
      '--retries',
      '10',
      '--fork-retry-backoff',
      '1500',
      '--timeout',
      '60000',
      '--silent',
    ],
    { stdio: 'ignore' },
  )
  const exited = new Promise((r) => proc.once('exit', r))
  const stop = async () => {
    proc.kill('SIGTERM')
    const t = setTimeout(() => proc.kill('SIGKILL'), 3_000)
    await exited
    clearTimeout(t)
  }
  try {
    for (let i = 0; ; i++) {
      try {
        if (Number(await rpc('eth_chainId')) === 4663) break
      } catch {
        if (i > 90) throw new Error('anvil did not start')
      }
      await new Promise((r) => setTimeout(r, 1_000))
    }
    process.env.NOCTENNA_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'noctenna-fork-'))
    process.env.NOCTENNA_KEYSTORE = 'file'
    process.env.NOCTENNA_KEYSTORE_PASSWORD = 'fork-test'
    process.env.NOCTENNA_NETWORK = 'mainnet'
    process.env.NOCTENNA_PRELAUNCH_WRITES = '1' // an anvil fork of mainnet: launch.ts
    process.env.NOCTENNA_RPC_URL = URL_
    saveConfig({ dailyLimitUsd: 10_000 })
    const address: Address = await importWallet(generatePrivateKey())
    await rpc('anvil_setBalance', [address, toHex(parseEther('100'))])
    const ctx = async () => {
      const c = await buildCtx()
      return opts.http ? { ...c, http: opts.http(c) } : c
    }
    const [a, b] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: 'fork-test', version: '0' })
    await Promise.all([createServer(ctx).connect(a), client.connect(b)])
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const r = await client.callTool({ name, arguments: args })
      const body = JSON.parse((r.content as { text: string }[])[0]!.text)
      return { ok: !r.isError, body }
    }
    const must = async (name: string, args?: Record<string, unknown>) => {
      const r = await call(name, args)
      if (!r.ok) throw new Error(`${name}: ${JSON.stringify(r.body)}`)
      return r.body
    }
    return {
      address,
      chain: createChain(URL_, 'mainnet'),
      call,
      must,
      stop: async () => (await client.close(), await stop()),
    }
  } catch (e) {
    await stop()
    throw e
  }
}
