// Swaps any token pair on mainnet: KyberSwap first, then a graduated Pons token's own Uniswap v4 pool directly.
// Testnet has neither (no Kyber, no Universal Router), so swaps say plainly that they open on mainnet at launch.
import { encodeFunctionData, erc20Abi, isAddressEqual, type Address } from 'viem'
import { z } from 'zod'
import type { Ctx, Module, Preview, Step, Tool } from '../../core/types.js'
import { ETH, factoryAbi, PHASE, PONS } from '../pons/abi.js'
import {
  amountArg,
  balanceOf,
  decimalsOf,
  fmt,
  label,
  parseAmount,
  requireAddress,
  symbolOf,
  tokenArg,
  type TokenRef,
} from '../wallet/tokens.js'
import { KYBER_ROUTER, kyberBuild, kyberRoute, type KyberRoute } from './kyber.js'
import { usdValue } from './price.js'
import { quotePonsPool } from './uniswap.js'

export const SWAPS_ON_MAINNET =
  'Swaps open on mainnet at the token launch. Testnet has no swap router (no Universal Router, and KyberSwap does not serve it), so there is nothing to route here yet.'

export interface SwapRequest {
  tokenIn: TokenRef
  tokenOut: TokenRef
  amountIn: bigint
  slippageBps: number
}

type Route =
  | { venue: 'kyberswap'; amountOut: bigint; route: KyberRoute }
  | {
      venue: 'uniswap-v4'
      amountOut: bigint
      pool: { token: Address; poolFee: number; tickSpacing: number; side: 'buy' | 'sell' }
    }

const minOf = (out: bigint, bps: number) => (out * (10_000n - BigInt(bps))) / 10_000n

// The Pons pool fallback: only ETH <-> a graduated Pons token whose pool is open.
// Known limit: no generic v4 pool discovery. A PoolManager Initialize-log scan would cover pairs KyberSwap misses.
async function ponsPool(ctx: Ctx, r: SwapRequest) {
  const token = r.tokenIn === 'ETH' ? r.tokenOut : r.tokenOut === 'ETH' ? r.tokenIn : null
  if (!token || token === 'ETH') return null
  const lt = await ctx.chain
    .readContract({ address: PONS.mainnet.factory, abi: factoryAbi, functionName: 'getLaunchedToken', args: [token] })
    .catch(() => null)
  if (!lt?.exists || lt.phase !== PHASE.POOL || !isAddressEqual(lt.pairToken, ETH)) return null
  return {
    token,
    poolFee: lt.poolFee,
    tickSpacing: lt.tickSpacing,
    side: r.tokenIn === 'ETH' ? ('buy' as const) : ('sell' as const),
  }
}

async function findRoute(ctx: Ctx, r: SwapRequest, account: Address): Promise<Route> {
  if (ctx.config.network !== 'mainnet') throw new Error(SWAPS_ON_MAINNET)
  if (r.tokenIn === r.tokenOut) throw new Error('tokenIn and tokenOut are the same')
  const k = await kyberRoute(ctx, r.tokenIn, r.tokenOut, r.amountIn)
  if (k) return { venue: 'kyberswap', amountOut: BigInt(k.routeSummary.amountOut), route: k }
  const pool = await ponsPool(ctx, r)
  if (pool) {
    const q = await quotePonsPool(ctx.chain, { ...pool, amountIn: r.amountIn, slippageBps: r.slippageBps, account })
    return { venue: 'uniswap-v4', amountOut: q.amountOut, pool }
  }
  throw new Error('no route for this pair: KyberSwap has none and it is not a graduated Pons token paired with ETH')
}

const PLACEHOLDER: Address = '0x0000000000000000000000000000000000000001' // quotes without a wallet simulate from here

export async function quoteSwap(ctx: Ctx, r: SwapRequest) {
  const route = await findRoute(ctx, r, ctx.address ?? PLACEHOLDER)
  const [dIn, dOut] = await Promise.all([decimalsOf(ctx.chain, r.tokenIn), decimalsOf(ctx.chain, r.tokenOut)])
  const k = route.venue === 'kyberswap' ? route.route.routeSummary : undefined
  return {
    network: ctx.config.network,
    venue: route.venue,
    tokenIn: { token: r.tokenIn, symbol: await symbolOf(ctx.chain, r.tokenIn) },
    tokenOut: { token: r.tokenOut, symbol: await symbolOf(ctx.chain, r.tokenOut) },
    amountIn: fmt(r.amountIn, dIn),
    amountOut: fmt(route.amountOut, dOut),
    minAmountOut: fmt(minOf(route.amountOut, r.slippageBps), dOut),
    slippageBps: r.slippageBps,
    usdIn: k?.amountInUsd ? Number(k.amountInUsd) : undefined,
    usdOut: k?.amountOutUsd ? Number(k.amountOutUsd) : undefined,
    exchanges: k?.route
      ? { untrusted: [...new Set(k.route.flat().map((h) => h.exchange ?? ''))].join(', ') }
      : undefined,
  }
}

// A swap Preview. pons reuses it for graduated tokens.
export async function prepareSwap(ctx: Ctx, r: SwapRequest): Promise<Preview> {
  const account = requireAddress(ctx.address)
  const net = ctx.config.network
  if (net !== 'mainnet') throw new Error(SWAPS_ON_MAINNET)
  if ((await balanceOf(ctx.chain, r.tokenIn, account)) < r.amountIn)
    throw new Error('the wallet holds less than this amount')
  const route = await findRoute(ctx, r, account)
  const [dIn, dOut] = await Promise.all([decimalsOf(ctx.chain, r.tokenIn), decimalsOf(ctx.chain, r.tokenOut)])
  const min = minOf(route.amountOut, r.slippageBps)
  if (min === 0n) throw new Error('the amount is too small to swap')
  const steps: Step[] = []
  const summary = [`Swap ${fmt(r.amountIn, dIn)} ${label(r.tokenIn, net)} for ${label(r.tokenOut, net)}.`]
  let recheck: () => Promise<void>
  if (route.venue === 'kyberswap') {
    const tx = await kyberBuild(ctx, route.route, { ...r, account })
    if (r.tokenIn !== 'ETH') {
      const allowance = await ctx.chain.readContract({
        address: r.tokenIn,
        abi: erc20Abi,
        functionName: 'allowance',
        args: [account, KYBER_ROUTER],
      })
      if (allowance < r.amountIn) {
        steps.push({
          type: 'tx',
          label: 'Approve the KyberSwap router for exactly this amount',
          to: r.tokenIn,
          data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [KYBER_ROUTER, r.amountIn] }),
          value: 0n,
        })
        summary.push(
          `Approval: the KyberSwap router ${KYBER_ROUTER} for exactly ${fmt(r.amountIn, dIn)}, used up by the swap.`,
        )
      }
    }
    steps.push({ type: 'tx', label: 'Swap through KyberSwap', to: tx.to, data: tx.data, value: tx.value })
    summary.push(
      `Expected ${fmt(tx.amountOut, dOut)}; at least ${fmt(tx.minOut, dOut)} or the swap reverts (slippage ${r.slippageBps / 100}%).`,
      'Route: KyberSwap aggregator. Network fee only; Noctenna adds no fee.',
    )
    recheck = async () => {
      const fresh = await kyberRoute(ctx, r.tokenIn, r.tokenOut, r.amountIn)
      if (!fresh || BigInt(fresh.routeSummary.amountOut) < tx.minOut)
        throw new Error('the price moved past the slippage since the preview: prepare it again')
    }
  } else {
    const q = await quotePonsPool(ctx.chain, {
      ...route.pool,
      amountIn: r.amountIn,
      slippageBps: r.slippageBps,
      account,
    })
    for (const s of q.steps) steps.push({ type: 'tx', ...s })
    if (q.steps.length > 1)
      summary.push(
        `Approvals: Permit2, then the Universal Router through Permit2, each for exactly ${fmt(r.amountIn, dIn)}.`,
      )
    summary.push(
      `Expected ${fmt(q.amountOut, dOut)}; at least ${fmt(q.minOut, dOut)} or the swap reverts (slippage ${r.slippageBps / 100}%).`,
      `Route: the token's Uniswap v4 pool. Its hook takes ${q.hookFeeBps / 100}% plus the creator tax of ${q.creatorTaxBps / 100}%, already in the amounts above. Noctenna adds no fee.`,
    )
    recheck = async () => {
      const fresh = await quotePonsPool(ctx.chain, {
        ...route.pool,
        amountIn: r.amountIn,
        slippageBps: r.slippageBps,
        account,
      })
      if (fresh.amountOut < q.minOut)
        throw new Error('the price moved past the slippage since the preview: prepare it again')
    }
  }
  // A token nobody prices (a graduated Pons token KyberSwap does not route) counts at the ETH it pays out.
  const { usd, note } = await usdValue(ctx, r.tokenIn, r.amountIn).catch(async (e: unknown) => {
    if (r.tokenOut !== 'ETH') throw e
    const v = await usdValue(ctx, 'ETH', route.amountOut)
    return { usd: v.usd, note: [v.note, 'valued at the ETH it pays out'].filter(Boolean).join('; ') }
  })
  summary.push(`Counts $${usd.toFixed(2)} against the daily limit${note ? ` (${note})` : ''}.`)
  return {
    summary,
    usd,
    steps,
    details: {
      venue: route.venue,
      tokenIn: { token: r.tokenIn, symbol: await symbolOf(ctx.chain, r.tokenIn) },
      tokenOut: { token: r.tokenOut, symbol: await symbolOf(ctx.chain, r.tokenOut) },
    },
    recheck: async () => {
      if ((await balanceOf(ctx.chain, r.tokenIn, account)) < r.amountIn)
        throw new Error('the wallet no longer holds this amount')
      await recheck()
    },
  }
}

const input = z.object({
  tokenIn: tokenArg,
  tokenOut: tokenArg,
  amountIn: amountArg,
  slippageBps: z
    .number()
    .int()
    .min(10)
    .max(2500)
    .optional()
    .describe('max slippage in basis points; default from the config (300 = 3%)'),
})

async function request(ctx: Ctx, a: z.infer<typeof input>): Promise<SwapRequest> {
  if (ctx.config.network !== 'mainnet') throw new Error(SWAPS_ON_MAINNET)
  return {
    tokenIn: a.tokenIn,
    tokenOut: a.tokenOut,
    amountIn: parseAmount(a.amountIn, await decimalsOf(ctx.chain, a.tokenIn)),
    slippageBps: a.slippageBps ?? ctx.config.slippageBps,
  }
}

const tools: Tool<typeof input>[] = [
  {
    name: 'swap_quote',
    description:
      'Quote a swap of any token pair on Robinhood Chain: expected and minimum output and the route. Read only.',
    kind: 'read',
    input,
    run: async (ctx, a) => quoteSwap(ctx, await request(ctx, a)),
  },
  {
    name: 'swap_prepare',
    description:
      "Prepare a swap from the local wallet (KyberSwap, or a graduated Pons token's Uniswap v4 pool), with exact-amount approvals.",
    kind: 'prepare',
    input,
    run: async (ctx, a) => prepareSwap(ctx, await request(ctx, a)),
  },
]

export const swap: Module = { name: 'swap', tools }
