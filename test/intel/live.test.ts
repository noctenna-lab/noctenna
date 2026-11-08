// Read-only checks against live mainnet data. Run with LIVE=1 (they read the public RPC; nothing is sent).
import { decodeEventLog, type Hex } from 'viem'
import { expect, it } from 'vitest'
import { createChain, createHttp, NETWORKS } from '../../src/core/chain.js'
import type { Ctx } from '../../src/core/types.js'
import { intel } from '../../src/modules/intel/index.js'
import { factoryAbi, TOPIC } from '../../src/modules/pons/abi.js'
import { pons } from '../../src/modules/pons/index.js'

const live = process.env.LIVE === '1'
const mainnet = createChain(NETWORKS.mainnet.rpcUrl, 'mainnet')
// testnet mode: market reads still come from mainnet
const ctx: Ctx = {
  config: { network: 'testnet', rpcUrl: NETWORKS.testnet.rpcUrl, dailyLimitUsd: 200, slippageBps: 300 },
  address: null,
  http: createHttp(),
  chain: createChain(NETWORKS.testnet.rpcUrl, 'testnet'),
  mainnet,
}
const tool = (
  m: { tools: { name: string; input: { parse(x: unknown): unknown }; run(c: Ctx, a: never): Promise<unknown> }[] },
  name: string,
) => {
  const t = m.tools.find((x) => x.name === name)!
  return (args: unknown) => t.run(ctx, t.input.parse(args) as never) as Promise<Record<string, any>>
}

// A known launch (Cats Tank): 0.039 ETH dev buy, 2% creator tax, fee wallet = deployer.
const REF_TX: Hex = '0xd78ac0b2bddf8eeb1c3dd2f4ca0375954e920fbf84c5fd994321ddd2b7fdc6ed'

it.skipIf(!live)(
  'intel_check_launch reads a known launch exactly',
  async () => {
    const receipt = await mainnet.getTransactionReceipt({ hash: REF_TX })
    const log = receipt.logs.find((l) => l.topics[0] === TOPIC.TokenLaunched)!
    const { args } = decodeEventLog({
      abi: factoryAbi,
      eventName: 'TokenLaunched',
      data: log.data,
      topics: log.topics as [Hex, ...Hex[]],
    })
    const r = await tool(intel, 'intel_check_launch')({ token: args.token })
    console.log(JSON.stringify(r, (_, v) => (typeof v === 'bigint' ? v.toString() : v)).slice(0, 1500))
    expect(r.data).toBe('mainnet data')
    expect(r.launchTx).toBe(REF_TX)
    expect(r.devBuy.eth).toBe('0.039')
    expect(r.creatorTaxBps).toBe(200)
    expect(r.deployer.toLowerCase()).toBe('0xb03ae0c6e05a7a563e86a10c128b2399ab069fc9')
    expect(r.creatorFeeRecipientIsDeployer).toBe(true)
    expect(r.symbol).toEqual({ untrusted: 'CTANK' })
    expect(r.deployerLaunches.total).toBeGreaterThanOrEqual(1)
  },
  300_000,
)

it.skipIf(!live)(
  'pons_launches and pons_token read mainnet data in testnet mode',
  async () => {
    const l = await tool(pons, 'pons_launches')({ minutes: 240, limit: 5 })
    expect(l.data).toBe('mainnet data')
    expect(l.launches.length).toBeGreaterThan(0)
    const first = l.launches[0]
    const t = await tool(pons, 'pons_token')({ token: first.token })
    console.log(JSON.stringify(t).slice(0, 800))
    expect(t.network).toBe('mainnet')
    expect(t.name).toHaveProperty('untrusted')
    const check = await tool(intel, 'intel_check_launch')({ token: first.token })
    console.log(JSON.stringify(check).slice(0, 1500))
    expect(check.first5Minutes.uniqueOutsideBuyers).toBeGreaterThanOrEqual(0)
  },
  300_000,
)

// A testnet launch whose pool opened (found 8 Nov 2026 on the testnet factory).
const TESTNET_POOLED = '0x3621E19C1FC574b4d6B63b8848DEa5Cd473B3188'

it.skipIf(!live)(
  'testnet Pons: reads label testnet data, and a graduated token says swaps open on mainnet',
  async () => {
    const t = await tool(pons, 'pons_token')({ token: TESTNET_POOLED, network: 'testnet' })
    expect(t).toMatchObject({ network: 'testnet', data: 'testnet data', phase: 'pool' })
    await expect(tool(pons, 'pons_quote')({ token: TESTNET_POOLED, side: 'buy', amount: '0.001' })).rejects.toThrow(
      /Swaps open on mainnet/,
    )
    await expect(tool(pons, 'pons_token')({ token: TESTNET_POOLED })).rejects.toThrow(/not a Pons launch on mainnet/)
  },
  300_000,
)
