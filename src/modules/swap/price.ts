// USD values for the daily limit. Prices come from mainnet whatever the network: on testnet ETH counts at the mainnet
// ETH price (so the limit behaves as it will on mainnet) and testnet tokens count as $0, since they have no value.
// A mainnet token nobody can price is refused, because the limit could not be checked.
import { isAddressEqual, type Address } from 'viem'
import type { Ctx } from '../../core/types.js'
import { ETH, factoryAbi, PHASE, PONS, curveAbi } from '../pons/abi.js'
import { quoteSell } from '../pons/curve.js'
import { USDG, type TokenRef } from '../wallet/tokens.js'
import { kyberRoute } from './kyber.js'

let cached: { usd: number; at: number } | undefined
const TTL_MS = 60_000

export async function ethUsd(ctx: Ctx): Promise<number> {
  if (cached && Date.now() - cached.at < TTL_MS) return cached.usd
  const r = await kyberRoute(ctx, 'ETH', USDG, 10n ** 17n)
  const usd = r ? Number(BigInt(r.routeSummary.amountOut)) / 1e5 : NaN // 0.1 ETH in, USDG has 6 decimals
  if (!(usd > 0))
    throw new Error('could not read the ETH price (KyberSwap ETH/USDG), so the daily limit cannot be checked')
  cached = { usd, at: Date.now() }
  return usd
}

export async function usdValue(ctx: Ctx, token: TokenRef, amount: bigint): Promise<{ usd: number; note?: string }> {
  if (token === 'ETH')
    return {
      usd: (Number(amount) / 1e18) * (await ethUsd(ctx)),
      note: ctx.config.network === 'testnet' ? 'testnet ETH counted at the mainnet ETH price' : undefined,
    }
  if (ctx.config.network === 'testnet') return { usd: 0, note: 'testnet token, counted as $0 against the daily limit' }
  if (isAddressEqual(token, USDG)) return { usd: Number(amount) / 1e6 }
  const r = await kyberRoute(ctx, token, USDG, amount)
  if (r) return { usd: Number(BigInt(r.routeSummary.amountOut)) / 1e6 }
  const eth = await ponsCurveEth(ctx, token, amount)
  if (eth !== null)
    return { usd: (Number(eth) / 1e18) * (await ethUsd(ctx)), note: 'valued at its Pons curve sell price' }
  throw new Error(
    `no price for ${token} (no KyberSwap route, not on a Pons curve), so the daily limit cannot be checked; refused`,
  )
}

// What selling `amount` on its Pons curve would pay now, or null if it is not an ETH-pair curve token.
async function ponsCurveEth(ctx: Ctx, token: Address, amount: bigint): Promise<bigint | null> {
  const chain = ctx.chain
  const lt = await chain
    .readContract({ address: PONS.mainnet.factory, abi: factoryAbi, functionName: 'getLaunchedToken', args: [token] })
    .catch(() => null)
  if (!lt?.exists || lt.phase !== PHASE.CURVE || !isAddressEqual(lt.pairToken, ETH)) return null
  const c = { address: lt.curve, abi: curveAbi } as const
  const [[quoteReserve, tokenReserve], reservedTokens, feeBps, creatorTaxBps, graduated] = await chain.multicall({
    allowFailure: false,
    contracts: [
      { ...c, functionName: 'getReserves' },
      { ...c, functionName: 'reservedTokens' },
      { ...c, functionName: 'feeBps' },
      { ...c, functionName: 'creatorTaxBps' },
      { ...c, functionName: 'graduated' },
    ],
  })
  try {
    return quoteSell({ quoteReserve, tokenReserve, reservedTokens, feeBps, creatorTaxBps, graduated }, amount).quoteOut
  } catch {
    return null
  }
}
