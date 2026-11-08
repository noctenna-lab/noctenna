// Write paths of perps and bridge on local anvil forks (port 8702), through the MCP server and execute. Nothing
// reaches a live chain: the Arcus testnet deposit runs on a fork of testnet, the Relay bridge-out on a fork of mainnet.
//   FORK=1 npx vitest run test/perps/fork.test.ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { erc20Abi, parseEther, toHex, type Address } from 'viem'
import { generatePrivateKey } from 'viem/accounts'
import { expect, it } from 'vitest'
import { createChain, NETWORKS, USER_AGENT } from '../../src/core/chain.js'
import { saveConfig } from '../../src/core/config.js'
import { buildCtx, createServer } from '../../src/core/server.js'
import type { Network } from '../../src/core/types.js'
import { importWallet } from '../../src/core/wallet.js'

const PORT = 8702
const URL_ = `http://127.0.0.1:${PORT}`
const rpc = async (method: string, params: unknown[] = []) => {
  const j = (await (
    await fetch(URL_, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    })
  ).json()) as { result?: unknown; error?: { message: string } }
  if (j.error) throw new Error(j.error.message)
  return j.result
}

async function fork(
  network: Network,
  run: (t: { address: Address; must: (name: string, args?: object) => Promise<any> }) => Promise<void>,
) {
  const id = NETWORKS[network].chain.id
  const proc = spawn(
    'anvil',
    [
      '--port',
      String(PORT),
      '--fork-url',
      NETWORKS[network].rpcUrl,
      '--chain-id',
      String(id),
      '--fork-header',
      `User-Agent: ${USER_AGENT}`,
      '--retries',
      '10',
      '--timeout',
      '60000',
      '--silent',
    ],
    { stdio: 'ignore' },
  )
  const exited = new Promise((r) => proc.once('exit', r))
  try {
    for (let i = 0; ; i++) {
      if (
        await rpc('eth_chainId').then(
          (c) => Number(c) === id,
          () => false,
        )
      )
        break
      if (i > 90) throw new Error('anvil did not start')
      await new Promise((r) => setTimeout(r, 1000))
    }
    process.env.NOCTENNA_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'noctenna-fork-'))
    process.env.NOCTENNA_KEYSTORE = 'file'
    process.env.NOCTENNA_KEYSTORE_PASSWORD = 'fork-test'
    process.env.NOCTENNA_NETWORK = network
    process.env.NOCTENNA_PRELAUNCH_WRITES = '1' // an anvil fork: launch.ts
    process.env.NOCTENNA_RPC_URL = URL_
    saveConfig({ dailyLimitUsd: 1000 })
    // A fresh key funded on the fork only (anvil's dev accounts carry a live 7702 sweeper on this chain).
    const address = await importWallet(generatePrivateKey())
    await rpc('anvil_setBalance', [address, toHex(parseEther('1'))])
    const [a, b] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: 'fork', version: '0' })
    await Promise.all([createServer(buildCtx).connect(a), client.connect(b)])
    const must = async (name: string, args: object = {}) => {
      const r = await client.callTool({ name, arguments: args as Record<string, unknown> })
      const body = JSON.parse((r.content as { text: string }[])[0]!.text)
      if (r.isError) throw new Error(`${name}: ${JSON.stringify(body)}`)
      return body
    }
    await run({ address, must })
    await client.close()
  } finally {
    proc.kill('SIGTERM')
    await exited
  }
}

it.skipIf(!process.env.FORK)(
  'funds Arcus testnet collateral: mint, exact approval, deposit into the proxy',
  async () => {
    await fork('testnet', async ({ address, must }) => {
      const p = await must('prepare_arcus_testnet_deposit', { amount: '250' })
      expect(p.summary[0]).toBe('Network: Robinhood Chain testnet (46630)')
      const r = await must('execute', { previewId: p.previewId })
      expect(r.steps.map((s: { label: string }) => s.label)).toEqual([
        'Mint 250 test USDG',
        'Approve exactly 250 test USDG to the Arcus deposit proxy',
        'Deposit into Arcus testnet',
      ])
      const chain = createChain(URL_, 'testnet')
      const usdg = '0x293b337712d4312776a3a2d292f44410e7873bad'
      // The proxy pulled all of it, and no allowance is left over.
      expect(
        await chain.readContract({ address: usdg, abi: erc20Abi, functionName: 'balanceOf', args: [address] }),
      ).toBe(0n)
      expect(
        await chain.readContract({
          address: usdg,
          abi: erc20Abi,
          functionName: 'allowance',
          args: [address, '0xb872366eef371d4afb7c6d4d2abd53c17292a34d'],
        }),
      ).toBe(0n)
    })
  },
  600_000,
)

it.skipIf(!process.env.FORK)(
  'bridges ETH out with a live Relay quote, sent only to the fork',
  async () => {
    await fork('mainnet', async ({ must }) => {
      const p = await must('prepare_bridge', { chain: 'base', send: 'ETH', amount: '0.01' })
      expect(p.summary.join('\n')).toMatch(/Bridge 0\.01 ETH from Robinhood Chain to chain 8453/)
      const depository = '0x4cd00e387622c35bddb9b4c962c136462338bc31'
      const chain = createChain(URL_, 'mainnet')
      const before = await chain.getBalance({ address: depository })
      const r = await must('execute', { previewId: p.previewId })
      expect(r.steps[0].label).toMatch(/^Deposit to Relay, request 0x/)
      expect((await chain.getBalance({ address: depository })) - before).toBe(parseEther('0.01'))
    })
  },
  600_000,
)
