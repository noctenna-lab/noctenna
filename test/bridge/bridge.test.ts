import { encodeFunctionData, erc20Abi, type Address } from 'viem'
import { expect, it } from 'vitest'
import type { Preview } from '../../src/core/types.js'
import { bridge, TESTNET_NOTE, toSteps } from '../../src/modules/bridge/index.js'
import { ANVIL0_ADDRESS, fakeCtx, fixture } from '../perps/fake.js'

const tool = (n: string) => bridge.tools.find((t) => t.name === n)!
const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168' as Address
const DEPOSITORY = '0x4cd00e387622c35bddb9b4c962c136462338bc31' as Address
const usdg = { symbol: 'USDG', address: USDG, decimals: 6 }
const quote = () => fixture('bridge', 'relay_quote_usdg_base.json')

it('on testnet says bridging runs on mainnet only, and never calls Relay', async () => {
  const { ctx, calls } = fakeCtx(() => undefined, 'testnet')
  expect(await tool('bridge_quote').run(ctx, { direction: 'out', chain: 'base', send: 'ETH', amount: '0.01' })).toEqual(
    { note: TESTNET_NOTE },
  )
  await expect(tool('prepare_bridge').run(ctx, { chain: 'base', send: 'ETH', amount: '0.01' })).rejects.toThrow(
    /mainnet only/,
  )
  expect(calls).toEqual([])
})

it('turns a recorded Relay quote into an exact approval and a deposit, with no fee of ours', async () => {
  let requested: any
  const { ctx } = fakeCtx(
    (url, c) => {
      if (url === 'https://api.relay.link/chains') return fixture('bridge', 'relay_chains.json')
      if (url === 'https://api.relay.link/quote') return ((requested = JSON.parse(c.body!)), quote())
    },
    'mainnet',
    50,
  )
  const p = (await tool('prepare_bridge').run(ctx, { chain: 'base', send: 'USDG', amount: '5' })) as Preview
  expect(requested).toMatchObject({
    originChainId: 4663,
    destinationChainId: 8453,
    originCurrency: USDG,
    amount: '5000000',
    tradeType: 'EXACT_INPUT',
    slippageTolerance: '50',
  })
  expect(requested).not.toHaveProperty('referrer')
  expect(requested).not.toHaveProperty('appFees')
  expect(p.steps.map((s) => s.label)).toEqual([
    'Approve exactly 5 USDG to Relay',
    expect.stringMatching(/^Deposit to Relay, request 0x[0-9a-f]{64}$/),
  ])
  expect(p.summary.join('\n')).toContain('at least 4.951235 USDC after the 0.5% slippage limit')
  expect(p.usd).toBeCloseTo(5, 1)
  await p.recheck!()
  expect(p.steps).toHaveLength(2)
})

it('fails closed on anything but an exact approval to the depository and a deposit on chain 4663', () => {
  const ok = () => toSteps(quote(), ANVIL0_ADDRESS, DEPOSITORY, usdg, 5_000_000n)
  expect(ok()).toHaveLength(2)
  const tamper = (f: (q: any) => void) => {
    const q = quote()
    f(q)
    return () => toSteps(q, ANVIL0_ADDRESS, DEPOSITORY, usdg, 5_000_000n)
  }
  const approve = (spender: Address, amount: bigint) =>
    encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [spender, amount] })
  expect(tamper((q) => (q.steps[0].items[0].data.data = approve(DEPOSITORY, 2n ** 256n - 1n)))).toThrow(
    /exact-amount approval/,
  )
  expect(tamper((q) => (q.steps[0].items[0].data.data = approve(ANVIL0_ADDRESS, 5_000_000n)))).toThrow(
    /exact-amount approval/,
  )
  expect(tamper((q) => (q.steps[1].items[0].data.to = ANVIL0_ADDRESS))).toThrow(/does not accept/)
  expect(tamper((q) => (q.steps[1].items[0].data.chainId = 8453))).toThrow(/another chain/)
  expect(tamper((q) => (q.steps[1].kind = 'signature'))).toThrow(/does not run/)
  expect(tamper((q) => (q.fees.app = { amount: '1000' }))).toThrow(/app fee/)
  expect(tamper((q) => q.steps.pop())).toThrow(/no deposit/)
})
