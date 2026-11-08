// Write paths end to end on an anvil fork: MCP prepare -> preview -> execute -> receipt. Run only with FORK=1:
//   FORK=1 npx vitest run test/fork   (anvil on ANVIL_PORT, default 8701)
import {
  encodeFunctionData,
  erc20Abi,
  formatEther,
  isAddressEqual,
  keccak256,
  parseAbi,
  parseEther,
  toHex,
  type Address,
  type Hex,
} from 'viem'
import { describe, expect, it } from 'vitest'
import { saveConfig } from '../../src/core/config.js'
import { ETH, factoryAbi, launchRouterAbi, PONS, TOPIC } from '../../src/modules/pons/abi.js'
import { KYBER_ROUTER } from '../../src/modules/swap/kyber.js'
import { PERMIT2, UNIVERSAL_ROUTER } from '../../src/modules/swap/uniswap.js'
import { USDG } from '../../src/modules/wallet/tokens.js'
import { rpc, startFork, TIMEOUT } from './fork.js'

const fork = process.env.FORK === '1'
const launched = factoryAbi[0]
const curveReady = parseAbi(['function readyToGraduate() view returns (bool)'])
const harnessAbi = parseAbi([
  'function launchFee() view returns (uint256)',
  'function previewLaunchEconomics(uint256 launchConfigId, address pairToken) view returns (bytes32)',
])

// A fresh launch on the fork from anvil's first dev account (harness only, not the code under test).
async function launch(f: Awaited<ReturnType<typeof startFork>>) {
  const dev: Address = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'
  await rpc('anvil_setCode', [dev, '0x']) // the live chain has a 7702 sweeper delegated on every anvil dev account
  await rpc('anvil_setBalance', [dev, toHex(parseEther('100'))])
  const [fee, economics] = await Promise.all([
    f.chain.readContract({ address: PONS.mainnet.factory, abi: harnessAbi, functionName: 'launchFee' }),
    f.chain.readContract({
      address: PONS.mainnet.factory,
      abi: harnessAbi,
      functionName: 'previewLaunchEconomics',
      args: [0n, ETH],
    }),
  ])
  const devBuy = parseEther('0.01')
  const params = {
    name: 'Fork Test',
    symbol: 'FTEST',
    logo: '',
    description: '',
    socials: { twitter: '', telegram: '', discord: '', website: '', farcaster: '' },
    creatorFeeRecipient: dev,
    creatorTaxBps: 200,
    buybackEnabled: false,
    expectedEconomics: economics,
    salt: keccak256(toHex(`fork-${Date.now()}-${Math.random()}`)),
  }
  const data = encodeFunctionData({
    abi: launchRouterAbi,
    functionName: 'launchAndBuy',
    args: [params, 0n, ETH, devBuy, 0n, dev, []],
  })
  const hash = (await rpc('eth_sendTransaction', [
    { from: dev, to: PONS.mainnet.launchRouter, data, value: toHex(fee + devBuy), gas: toHex(8_000_000n) },
  ])) as Hex
  const r = await f.chain.waitForTransactionReceipt({ hash })
  expect(r.status).toBe('success')
  const log = r.logs.find(
    (l) => isAddressEqual(l.address, PONS.mainnet.factory) && l.topics[0] === TOPIC.TokenLaunched,
  )!
  return `0x${log.topics[1]!.slice(26)}` as Address
}

describe.skipIf(!fork)('fork: writes', () => {
  it(
    'wallet send: preview, one execute, explorer link, the daily limit',
    async () => {
      const f = await startFork()
      try {
        const to: Address = '0x00000000000000000000000000000000000c0ffe'
        const p = await f.must('wallet_prepare_send', { to, amount: '0.5' })
        expect(p.summary[0]).toBe('Network: Robinhood Chain mainnet (4663)')
        expect(p.previewId).toMatch(/^[0-9a-f]{24}$/)
        const r = await f.must('execute', { previewId: p.previewId })
        expect(r.network).toBe('mainnet')
        expect(r.steps[0].explorer).toBe(`https://robinhoodchain.blockscout.com/tx/${r.steps[0].hash}`)
        expect(await f.chain.getBalance({ address: to })).toBe(parseEther('0.5'))
        expect((await f.call('execute', { previewId: p.previewId })).ok).toBe(false) // one use
        saveConfig({ dailyLimitUsd: 1 })
        const big = await f.must('wallet_prepare_send', { to, amount: '1' })
        const refused = await f.call('execute', { previewId: big.previewId })
        expect(refused.ok).toBe(false)
        expect(refused.body.error.untrusted_text).toMatch(/daily limit/)
        expect(await f.chain.getBalance({ address: to })).toBe(parseEther('0.5'))
        const status = await f.must('status')
        expect(status.address).toBe(f.address)
        expect(status.spentTodayUsd).toBeGreaterThan(0)
      } finally {
        await f.stop()
      }
    },
    TIMEOUT,
  )

  it(
    'Pons curve: buy, then sell all with an exact approval that is used up',
    async () => {
      const f = await startFork()
      try {
        const head = await f.chain.getBlockNumber()
        const logs = await f.chain.getLogs({
          address: PONS.mainnet.factory,
          event: launched,
          fromBlock: head - 200_000n,
          toBlock: head - 600n,
        })
        let token: Address | undefined
        let curve: Address | undefined
        for (const l of logs.reverse()) {
          if (!isAddressEqual(l.args.pairToken!, ETH)) continue
          const lt = await f.chain.readContract({
            address: PONS.mainnet.factory,
            abi: factoryAbi,
            functionName: 'getLaunchedToken',
            args: [l.args.token!],
          })
          if (
            lt.phase !== 0 ||
            (await f.chain.readContract({ address: lt.curve, abi: curveReady, functionName: 'readyToGraduate' }))
          )
            continue
          token = l.args.token!
          curve = lt.curve
          break
        }
        expect(token).toBeDefined()
        const q = await f.must('pons_quote', { token, side: 'buy', amount: '0.01' })
        const buy = await f.must('pons_prepare_buy', { token, amount: '0.01' })
        console.log(buy.summary.join(' | '))
        await f.must('execute', { previewId: buy.previewId })
        const bal = await f.chain.readContract({
          address: token!,
          abi: erc20Abi,
          functionName: 'balanceOf',
          args: [f.address],
        })
        expect(formatEther(bal)).toBe(q.amountOut) // nothing else trades on a fork
        const sell = await f.must('pons_prepare_sell', { token, amount: 'all' })
        expect(sell.summary.some((s: string) => s.startsWith('Approval: the curve'))).toBe(true)
        const r = await f.must('execute', { previewId: sell.previewId })
        expect(r.steps.map((s: { label: string }) => s.label)).toEqual([
          'Approve the curve for exactly this amount',
          'Sell on the Pons curve',
        ])
        expect(
          await f.chain.readContract({ address: token!, abi: erc20Abi, functionName: 'balanceOf', args: [f.address] }),
        ).toBe(0n)
        expect(
          await f.chain.readContract({
            address: token!,
            abi: erc20Abi,
            functionName: 'allowance',
            args: [f.address, curve!],
          }),
        ).toBe(0n)
      } finally {
        await f.stop()
      }
    },
    TIMEOUT,
  )

  it(
    'fresh launch: the snipe window is refused, then a buy across the threshold spends only what it needs and graduates',
    async () => {
      const f = await startFork()
      try {
        const token = await launch(f)
        const early = await f.call('pons_prepare_buy', { token, amount: '0.01' })
        expect(early.body.error?.untrusted_text).toMatch(/snipe window/)
        await rpc('evm_increaseTime', [4])
        await rpc('evm_mine')
        const before = await f.chain.getBalance({ address: f.address })
        const p = await f.must('pons_prepare_buy', { token, amount: '10' })
        console.log(p.summary.join(' | '))
        expect(p.summary.some((s: string) => s.includes('reaches the graduation threshold'))).toBe(true)
        const r = await f.must('execute', { previewId: p.previewId })
        expect(BigInt(r.steps[0].gasUsed)).toBeGreaterThan(200_000n) // the graduation ran inside this buy, under the gas floor
        expect(before - (await f.chain.getBalance({ address: f.address }))).toBeLessThan(parseEther('10'))
        const lt = await f.chain.readContract({
          address: PONS.mainnet.factory,
          abi: factoryAbi,
          functionName: 'getLaunchedToken',
          args: [token],
        })
        expect(lt.phase).toBe(1)
        expect((await f.call('pons_prepare_sell', { token, amount: 'all' })).body.error.untrusted_text).toMatch(
          /graduating/,
        )
      } finally {
        await f.stop()
      }
    },
    TIMEOUT,
  )

  it(
    'KyberSwap: ETH to USDG and all of it back, the approval exact and used up',
    async () => {
      const f = await startFork()
      try {
        const there = await f.must('swap_prepare', { tokenIn: 'ETH', tokenOut: USDG, amountIn: '0.01' })
        console.log(there.summary.join(' | '))
        await f.must('execute', { previewId: there.previewId })
        const usdg = await f.chain.readContract({
          address: USDG,
          abi: erc20Abi,
          functionName: 'balanceOf',
          args: [f.address],
        })
        expect(usdg).toBeGreaterThan(0n)
        const back = await f.must('swap_prepare', {
          tokenIn: USDG,
          tokenOut: 'ETH',
          amountIn: (Number(usdg) / 1e6).toFixed(6),
        })
        const r = await f.must('execute', { previewId: back.previewId })
        expect(r.steps).toHaveLength(2)
        expect(
          await f.chain.readContract({ address: USDG, abi: erc20Abi, functionName: 'balanceOf', args: [f.address] }),
        ).toBe(0n)
        expect(
          await f.chain.readContract({
            address: USDG,
            abi: erc20Abi,
            functionName: 'allowance',
            args: [f.address, KYBER_ROUTER],
          }),
        ).toBe(0n)
      } finally {
        await f.stop()
      }
    },
    TIMEOUT,
  )

  it(
    'graduated Pons token: Uniswap v4 fallback when KyberSwap has no route, buy and sell all through Permit2',
    async () => {
      let token: Address | undefined
      // KyberSwap answers nothing for this token, so the route falls back to the token's own pool.
      const f = await startFork({
        http: (c) => (url, init) =>
          token && url.includes('kyberswap') && url.toLowerCase().includes(token.toLowerCase())
            ? Promise.reject(new Error('blocked in test'))
            : c.http(url, init),
      })
      try {
        const regs = await f.chain.getLogs({
          address: '0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044',
          event: parseAbi([
            'event PoolRegistered(bytes32 indexed poolId, address memecoin, address quoteToken, address creator)',
          ])[0],
          fromBlock: (await f.chain.getBlockNumber()) - 3_000_000n,
        })
        token = regs.reverse().find((l) => isAddressEqual(l.args.quoteToken!, ETH))?.args.memecoin
        expect(token).toBeDefined()
        const buy = await f.must('pons_prepare_buy', { token, amount: '0.01' })
        console.log(buy.summary.join(' | '))
        expect(buy.details.venue).toBe('uniswap-v4')
        await f.must('execute', { previewId: buy.previewId })
        const bal = await f.chain.readContract({
          address: token!,
          abi: erc20Abi,
          functionName: 'balanceOf',
          args: [f.address],
        })
        expect(bal).toBeGreaterThan(0n)
        const sell = await f.must('pons_prepare_sell', { token, amount: 'all' })
        const r = await f.must('execute', { previewId: sell.previewId })
        expect(r.steps).toHaveLength(3)
        expect(
          await f.chain.readContract({ address: token!, abi: erc20Abi, functionName: 'balanceOf', args: [f.address] }),
        ).toBe(0n)
        expect(
          await f.chain.readContract({
            address: token!,
            abi: erc20Abi,
            functionName: 'allowance',
            args: [f.address, PERMIT2],
          }),
        ).toBe(0n)
        const [p2] = await f.chain.readContract({
          address: PERMIT2,
          abi: parseAbi(['function allowance(address, address, address) view returns (uint160, uint48, uint48)']),
          functionName: 'allowance',
          args: [f.address, token!, UNIVERSAL_ROUTER],
        })
        expect(p2).toBe(0n)
      } finally {
        await f.stop()
      }
    },
    TIMEOUT,
  )
})
