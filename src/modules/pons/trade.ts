// Buys and sells on a Pons curve: quote with the exact curve math, prove it with eth_call at the same block, and
// build the transactions. Everything goes to the token's own curve (read from the factory, never a constant) or the
// token itself (an exact approval), and every trade pays out to the local wallet.
import {
  decodeFunctionResult,
  encodeFunctionData,
  erc20Abi,
  isAddressEqual,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem'
import type { Network } from '../../core/types.js'
import { CURVE_BUY_GAS_FLOOR, curveAbi, ETH, factoryAbi, PHASE, PONS, SNIPE_GUARD_SECONDS } from './abi.js'
import { CurveRevert, quoteBuy, quoteSell, type CurveState } from './curve.js'

const BPS = 10_000n
export const minAmountOut = (out: bigint, slippageBps: number) => (out * (BPS - BigInt(slippageBps))) / BPS

export async function launchOf(chain: PublicClient, network: Network, token: Address, blockNumber?: bigint) {
  const lt = await chain.readContract({
    address: PONS[network].factory,
    abi: factoryAbi,
    functionName: 'getLaunchedToken',
    args: [token],
    blockNumber,
  })
  if (!lt.exists || !isAddressEqual(lt.token, token)) throw new Error(`${token} is not a Pons launch on ${network}`)
  return lt
}

export interface CurveTx {
  to: Address
  data: Hex
  value: bigint
  gasFloor?: bigint
  label: string
}

export interface CurveQuote {
  curve: Address
  side: 'buy' | 'sell'
  amountIn: bigint // what the wallet sends: wei for buys (after any clamp), token units for sells
  amountOut: bigint
  minAmountOut: bigint
  fee: bigint // ETH: curve fee
  tax: bigint // ETH: creator tax
  refund: bigint // wei of the asked amount a buy at the graduation threshold does not spend (never sent)
  graduates: boolean // this buy takes the curve to its threshold
  priceImpactBps: number
  approval?: CurveTx
  trade: CurveTx
  block: bigint
}

const impactBps = (ideal: bigint, actual: bigint) =>
  ideal <= 0n || actual >= ideal ? 0 : Number(((ideal - actual) * BPS) / ideal)

// Throws a plain reason when the trade cannot or should not happen: not ETH-paired, snipe window, graduating, too small.
export async function quoteCurve(
  chain: PublicClient,
  network: Network,
  p: { token: Address; side: 'buy' | 'sell'; amountIn: bigint; slippageBps: number; account: Address },
): Promise<CurveQuote> {
  const block = await chain.getBlock()
  const blockNumber = block.number
  const lt = await launchOf(chain, network, p.token, blockNumber)
  if (!isAddressEqual(lt.pairToken, ETH))
    throw new Error('this launch is paired with a token other than ETH; Noctenna trades ETH-paired curves only')
  if (lt.phase !== PHASE.CURVE) throw new Error('the curve is closed: this token graduated')
  const curve = lt.curve
  const c = { address: curve, abi: curveAbi } as const
  const [
    [rq, rt],
    reserved,
    feeBps,
    taxBps,
    graduated,
    ready,
    launchedAt,
    snipeSeconds,
    snipe,
    tokenBalance,
    allowance,
  ] = await chain.multicall({
    allowFailure: false,
    blockNumber,
    contracts: [
      { ...c, functionName: 'getReserves' },
      { ...c, functionName: 'reservedTokens' },
      { ...c, functionName: 'feeBps' },
      { ...c, functionName: 'creatorTaxBps' },
      { ...c, functionName: 'graduated' },
      { ...c, functionName: 'readyToGraduate' },
      { ...c, functionName: 'launchedAt' },
      { ...c, functionName: 'snipeTaxSeconds' },
      { ...c, functionName: 'currentSnipeTaxBps', args: [p.account] },
      { address: p.token, abi: erc20Abi, functionName: 'balanceOf', args: [p.account] },
      { address: p.token, abi: erc20Abi, functionName: 'allowance', args: [p.account, curve] },
    ],
  })
  // The tax only falls with time, and the quote block is never later than the block a trade lands in.
  const guard = snipeSeconds > SNIPE_GUARD_SECONDS ? snipeSeconds : SNIPE_GUARD_SECONDS
  if (snipe > 0n || block.timestamp < launchedAt + guard)
    throw new Error(
      `refused: the launch is still in its snipe window (snipe tax now ${Number(snipe) / 100}%); try again in a few seconds`,
    )
  if (graduated || ready) throw new Error('the curve is graduating: wait for its pool to open')
  const state: CurveState = {
    quoteReserve: rq,
    tokenReserve: rt,
    reservedTokens: reserved,
    feeBps,
    creatorTaxBps: taxBps,
    graduated,
  }
  const attempt = <T>(f: () => T): T | null => {
    try {
      return f()
    } catch (e) {
      if (e instanceof CurveRevert) return null
      throw e
    }
  }
  const simulate = async (to: Address, data: Hex, value: bigint) => {
    try {
      return (await chain.call({ account: p.account, to, data, value, blockNumber })).data ?? '0x'
    } catch (e) {
      throw new Error(`the curve refused this trade in simulation: ${(e as Error).message.split('\n')[0]}`)
    }
  }

  if (p.side === 'buy') {
    const ethBalance = await chain.getBalance({ address: p.account, blockNumber })
    if (ethBalance < p.amountIn) throw new Error('the wallet holds less ETH than this amount')
    const asked = attempt(() => quoteBuy(state, p.amountIn, 0n))
    // A buy past the graduation threshold is clamped, and the curve then checks minTokensOut as a price bound against
    // the whole quoteIn, which is looser by quoteIn / spent. So send only the clamped spend: the bound is then the
    // quoted price itself, and the rest of the amount never leaves the wallet.
    const q = asked?.clamped ? attempt(() => quoteBuy(state, asked.spent, 0n)) : asked
    const min = q ? minAmountOut(q.tokensOut, p.slippageBps) : 0n
    if (!q || min === 0n) throw new Error('the amount is too small to buy anything')
    const data = encodeFunctionData({ abi: curveAbi, functionName: 'buy', args: [q.spent, min, p.account] })
    const simulated = decodeFunctionResult({
      abi: curveAbi,
      functionName: 'buy',
      data: await simulate(curve, data, q.spent),
    })
    if (simulated !== q.tokensOut)
      throw new Error(`curve math ${q.tokensOut} differs from the simulation ${simulated}; refused`)
    const net = q.spent - q.fee - q.tax - q.snipeTax
    return {
      curve,
      side: 'buy',
      amountIn: q.spent,
      amountOut: q.tokensOut,
      minAmountOut: min,
      fee: q.fee + q.snipeTax,
      tax: q.tax,
      refund: p.amountIn - q.spent,
      graduates: q.graduates,
      priceImpactBps: impactBps((net * rt) / rq, q.tokensOut),
      trade: { to: curve, data, value: q.spent, gasFloor: CURVE_BUY_GAS_FLOOR, label: 'Buy on the Pons curve' },
      block: blockNumber,
    }
  }

  if (tokenBalance < p.amountIn) throw new Error('the wallet holds fewer tokens than this amount')
  const q = attempt(() => quoteSell(state, p.amountIn))
  const min = q ? minAmountOut(q.quoteOut, p.slippageBps) : 0n
  if (!q || min === 0n) throw new Error('the amount is too small to sell for anything')
  const data = encodeFunctionData({ abi: curveAbi, functionName: 'sell', args: [p.amountIn, min, p.account] })
  const approval: CurveTx | undefined =
    allowance < p.amountIn
      ? {
          to: p.token,
          data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [curve, p.amountIn] }),
          value: 0n,
          label: 'Approve the curve for exactly this amount',
        }
      : undefined
  // sell() pulls the tokens before it prices, so it can only be simulated once the allowance exists; until then the
  // quote is the curve math (proven exact on the fork), and execute simulates the sell right before sending it.
  if (!approval) {
    const simulated = decodeFunctionResult({
      abi: curveAbi,
      functionName: 'sell',
      data: await simulate(curve, data, 0n),
    })
    if (simulated !== q.quoteOut)
      throw new Error(`curve math ${q.quoteOut} differs from the simulation ${simulated}; refused`)
  }
  return {
    curve,
    side: 'sell',
    amountIn: p.amountIn,
    amountOut: q.quoteOut,
    minAmountOut: min,
    fee: q.fee,
    tax: q.tax,
    refund: 0n,
    graduates: false,
    priceImpactBps: impactBps((p.amountIn * rq) / rt, q.gross),
    approval,
    trade: { to: curve, data, value: 0n, label: 'Sell on the Pons curve' },
    block: blockNumber,
  }
}
