// KyberSwap aggregator for chain 4663 (slug "robinhood"; checked 8 Nov 2026: routes and builds, no testnet slug).
// The API is a third party: its route is only a proposal. The calldata it builds is decoded and checked here
// (router, tokens, amount, recipient, minimum out, no fee receivers) before it becomes a transaction.
import { decodeFunctionData, getAddress, isAddressEqual, parseAbi, type Address, type Hex } from 'viem'
import type { Ctx } from '../../core/types.js'
import type { TokenRef } from '../wallet/tokens.js'

const API = 'https://aggregator-api.kyberswap.com/robinhood/api/v1'
const CLIENT_ID = 'noctenna'
// MetaAggregationRouterV2, the address Kyber deploys on every chain; it has code on 4663 (13,724 bytes).
export const KYBER_ROUTER: Address = '0x6131B5fae19EA4f9D964eAc0408E4408b66337b5'
export const NATIVE: Address = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE'

const DESC =
  '(address srcToken, address dstToken, address[] srcReceivers, uint256[] srcAmounts, address[] feeReceivers, uint256[] feeAmounts, address dstReceiver, uint256 amount, uint256 minReturnAmount, uint256 flags, bytes permit)'
export const kyberAbi = parseAbi([
  `function swap((address callTarget, address approveTarget, bytes targetData, ${DESC} desc, bytes clientData) execution) payable returns (uint256 returnAmount, uint256 gasUsed)`,
  `function swapSimpleMode(address caller, ${DESC} desc, bytes executorData, bytes clientData) returns (uint256 returnAmount, uint256 gasUsed)`,
])

const kAddr = (t: TokenRef) => (t === 'ETH' ? NATIVE : t)

export interface KyberRoute {
  routeSummary: Record<string, unknown> & {
    amountIn: string
    amountOut: string
    amountInUsd?: string
    amountOutUsd?: string
    gas?: string
    route?: { exchange?: string }[][]
  }
  routerAddress: string
}

async function api<T>(ctx: Ctx, path: string, init?: RequestInit): Promise<T | null> {
  const res = await ctx.http(`${API}${path}`, {
    ...init,
    headers: { 'x-client-id': CLIENT_ID, 'content-type': 'application/json', ...init?.headers },
  })
  const body = (await res.json().catch(() => null)) as { code?: number; data?: T } | null
  return res.ok && body?.code === 0 && body.data ? body.data : null
}

// null: no route (or the API is down); the caller falls back or says so.
export async function kyberRoute(
  ctx: Ctx,
  tokenIn: TokenRef,
  tokenOut: TokenRef,
  amountIn: bigint,
): Promise<KyberRoute | null> {
  const q = new URLSearchParams({ tokenIn: kAddr(tokenIn), tokenOut: kAddr(tokenOut), amountIn: amountIn.toString() })
  const r = await api<KyberRoute>(ctx, `/routes?${q}`).catch(() => null)
  if (!r || BigInt(r.routeSummary.amountOut || '0') <= 0n) return null
  return r
}

export interface KyberBuild {
  to: Address
  data: Hex
  value: bigint
  amountOut: bigint
  minOut: bigint
}

const minOf = (out: bigint, bps: number) => (out * (10_000n - BigInt(bps))) / 10_000n

// Builds the swap for `account` and refuses anything but a plain swap of exactly this input to this account. The
// build re-prices the route, so its minimum is taken from the build's own output, which must itself be within the
// slippage of the route the user was quoted.
export async function kyberBuild(
  ctx: Ctx,
  route: KyberRoute,
  req: { tokenIn: TokenRef; tokenOut: TokenRef; amountIn: bigint; account: Address; slippageBps: number },
): Promise<KyberBuild> {
  const built = await api<{ data: Hex; routerAddress: string; transactionValue: string; amountOut: string }>(
    ctx,
    '/route/build',
    {
      method: 'POST',
      body: JSON.stringify({
        routeSummary: route.routeSummary,
        sender: req.account,
        recipient: req.account,
        slippageTolerance: req.slippageBps,
      }),
    },
  )
  if (!built)
    throw new Error('KyberSwap did not build this route (it may refuse this wallet); try again or a smaller amount')
  const amountOut = BigInt(built.amountOut)
  if (amountOut < minOf(BigInt(route.routeSummary.amountOut), req.slippageBps))
    throw new Error('the price moved past the slippage while building the swap: try again')
  return checkKyberTx(
    { to: getAddress(built.routerAddress), data: built.data, value: BigInt(built.transactionValue || '0'), amountOut },
    { ...req, minOut: minOf(amountOut, req.slippageBps) },
  )
}

export function checkKyberTx(
  tx: { to: Address; data: Hex; value: bigint; amountOut: bigint },
  req: { tokenIn: TokenRef; tokenOut: TokenRef; amountIn: bigint; minOut: bigint; account: Address },
): KyberBuild {
  const bad = (why: string) => new Error(`refused the KyberSwap transaction: ${why}`)
  if (!isAddressEqual(tx.to, KYBER_ROUTER)) throw bad(`router ${tx.to} is not ${KYBER_ROUTER}`)
  let desc
  try {
    const call = decodeFunctionData({ abi: kyberAbi, data: tx.data })
    desc = call.functionName === 'swap' ? call.args[0].desc : call.args[1]
  } catch {
    throw bad('unknown router function')
  }
  if (!isAddressEqual(desc.srcToken, kAddr(req.tokenIn)) || !isAddressEqual(desc.dstToken, kAddr(req.tokenOut)))
    throw bad('tokens differ')
  if (desc.amount !== req.amountIn) throw bad('input amount differs')
  if (!isAddressEqual(desc.dstReceiver, req.account)) throw bad(`output goes to ${desc.dstReceiver}`)
  if (desc.feeReceivers.length || desc.feeAmounts.some((f) => f > 0n)) throw bad('it carries a fee')
  if (desc.minReturnAmount < req.minOut) throw bad(`minimum out ${desc.minReturnAmount} is below ${req.minOut}`)
  if (tx.value !== (req.tokenIn === 'ETH' ? req.amountIn : 0n)) throw bad('ETH value differs')
  return { to: tx.to, data: tx.data, value: tx.value, amountOut: tx.amountOut, minOut: desc.minReturnAmount }
}
