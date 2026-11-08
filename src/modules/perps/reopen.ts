// Reopen watch. While a US market is shut, Arcus keeps each stock perp inside a price band around the last settlement, so
// the weekend looks calm; the reopen has no band. This checks how far a position's liquidation price sits from the band
// and from the Friday close, and how many past weekends opened at least that far against it.
import { isAddress, type Address } from 'viem'
import { z } from 'zod'
import type { Ctx } from '../../core/types.js'
import { round, tool, u } from './api.js'
import { arcusMarkets, findMarket, type ArcusMarket } from './arcus.js'
import { GAP_META, GAPS } from './gaps.js'
import { lighterAccounts, lighterMarkets } from './lighter.js'

const STOCKS = new Set(['EQUITIES', 'INDICES', 'COMMODITIES'])
export type Side = 'long' | 'short'
export interface Band {
  settle: number
  mark: number
  lower: number | null
  upper: number | null
  nextLower: number | null
  nextUpper: number | null
  mmf: number
}

const num = (x: unknown) => (x === null || x === undefined || x === '' ? null : Number(x))
export const bandOf = (m: ArcusMarket): Band => ({
  settle: Number(m.currentSettlementPrice ?? m.markPrice),
  mark: Number(m.markPrice),
  lower: num(m.lowerTradingBound),
  upper: num(m.upperTradingBound),
  nextLower: num(m.nextLowerTradingBound),
  nextUpper: num(m.nextUpperTradingBound),
  mmf: Number(m.maintenanceMarginFraction ?? 0),
})

/** Weekends (of `n`) whose open moved against `side` by at least `pct` versus the Friday close. The table is on a
 *  0.5% grid, so `pct` rounds down: the count errs toward more weekends, never fewer. */
export function weekendsPast(symbol: string, side: Side, pct: number) {
  const g = (GAPS[symbol] ?? GAPS.US)! // the builder always writes US
  const i = GAP_META.steps.findLastIndex((s) => s <= pct)
  return {
    weekends: g.n,
    opened: i < 0 ? g.n : (side === 'long' ? g.down : g.up)[i],
    set: symbol in GAPS ? symbol : 'US',
  }
}

/** Liquidation is the position's own price when known, else the isolated-margin estimate: an adverse move of
 *  1/leverage minus the maintenance margin. */
export function reopenRisk(b: Band, side: Side, symbol: string, liq: { price?: number; leverage?: number }) {
  const lm = liq.leverage ? 1 / liq.leverage - b.mmf : null
  const price = liq.price ?? (lm === null ? null : b.mark * (side === 'long' ? 1 - lm : 1 + lm))
  const sinceFridayPct = round((b.mark / b.settle - 1) * 100)
  const band = {
    band: b.lower && b.upper ? [b.lower, b.upper] : null,
    widened: b.nextLower && b.nextUpper ? [b.nextLower, b.nextUpper] : null,
  }
  if (price === null || price <= 0)
    return {
      sinceFridayPct,
      ...band,
      liquidationPrice: null,
      verdict: 'No liquidation price: a gap alone cannot liquidate this position.',
    }
  const toLiqPct = round((side === 'long' ? 1 - price / b.mark : price / b.mark - 1) * 100)
  const gapPct = round((side === 'long' ? 1 - price / b.settle : price / b.settle - 1) * 100)
  const edge = side === 'long' ? b.lower : b.upper,
    next = side === 'long' ? b.nextLower : b.nextUpper
  const reach = (p: number | null) => p !== null && (side === 'long' ? price >= p : price <= p)
  const past = weekendsPast(symbol, side, gapPct)
  const verdict =
    toLiqPct <= 0
      ? 'At or past the liquidation price already.'
      : reach(edge)
        ? 'The weekend band itself reaches the liquidation price.'
        : reach(next)
          ? 'Only a widened band reaches it over the weekend; a reopen gap can reach it at once.'
          : 'The band keeps it out of reach over the weekend. Only a reopen gap can reach it.'
  return {
    sinceFridayPct,
    ...band,
    liquidationPrice: round(price, 4),
    moveToLiquidationPct: toLiqPct,
    gapFromFridayToLiquidationPct: gapPct,
    history: {
      weekends: past.weekends,
      openedThatFarAgainst: past.opened,
      set: past.set === 'US' ? 'all US shares' : past.set,
      from: GAP_META.from,
      to: GAP_META.to,
    },
    verdict,
  }
}

export const reopenCheck = tool({
  name: 'perps_reopen_check',
  description:
    'Reopen watch for stock, index and commodity perps. While the US market is shut, Arcus holds each one inside a price band, so the weekend looks calm; the reopen has no band. For every stock-perp position this wallet holds on Lighter (or one position you describe with market, side and leverage or liquidationPrice, e.g. from perps_account on Arcus or a trade being planned) it returns the move since the Friday close, the Arcus band and its widened band, the liquidation price, the move and the Friday-to-open gap that reach it, how many past weekends opened at least that far against the position, and a one-line verdict. Read only; never trades. Information, not advice.',
  kind: 'read',
  input: z.object({
    address: z.string().optional(),
    market: z
      .string()
      .min(1)
      .max(40)
      .optional()
      .describe('base asset like NVDA or SPY; set it to check one described position instead of the wallet'),
    side: z.enum(['long', 'short']).optional(),
    leverage: z.number().min(1).max(100).optional(),
    liquidationPrice: z.number().positive().optional(),
  }),
  async run(ctx: Ctx, a) {
    const ms = (await arcusMarkets(ctx, 'mainnet')).filter((m) => STOCKS.has(m.category ?? ''))
    const shut = ms.filter((m) => m.isOutsideRth).length
    const head = {
      data: 'mainnet',
      usMarketShut: shut > 0,
      gapHistory: `${GAP_META.weekends} weekends, ${GAP_META.from} to ${GAP_META.to}`,
    }
    if (a.market) {
      if (!a.side || (!a.leverage && !a.liquidationPrice))
        throw new Error('to check a position, pass side and leverage, or side and liquidationPrice')
      const m = findMarket(ms, a.market)
      return {
        ...head,
        positions: [
          {
            source: 'described',
            market: u(m.baseAsset),
            side: a.side,
            ...reopenRisk(bandOf(m), a.side, m.baseAsset, { price: a.liquidationPrice, leverage: a.leverage }),
          },
        ],
      }
    }
    const x = a.address ?? ctx.address
    if (!x || !isAddress(x))
      throw new Error(
        a.address
          ? `"${a.address}" is not an address`
          : 'no wallet yet: pass an address, or describe a position with market, side and leverage',
      )
    const [acc, lm] = await Promise.all([
      lighterAccounts(ctx, x as Address).catch((e) =>
        /account not found/.test(String(e)) ? { accounts: [] } : Promise.reject(e),
      ),
      lighterMarkets(ctx),
    ])
    const positions = []
    for (const s of acc.accounts)
      for (const p of s.positions) {
        const m = ms.find((m) => m.baseAsset === p.symbol)
        const lmk = lm.find((l) => l.symbol === p.symbol)
        if (!Number(p.position) || !m || !lmk) continue
        const side: Side = p.sign < 0 ? 'short' : 'long'
        positions.push({
          source: 'lighter',
          account: s.account_index,
          market: u(p.symbol),
          side,
          sizeUsd: Math.round(Number(p.position_value)),
          ...reopenRisk({ ...bandOf(m), mark: Number(lmk.mark_price) }, side, m.baseAsset, {
            price: Number(p.liquidation_price),
          }),
        })
      }
    return {
      ...head,
      positions,
      note: positions.length
        ? 'Arcus positions are not read here: get them from perps_account and pass one at a time with market, side and liquidationPrice.'
        : 'No stock-perp position on Lighter for this address. Describe one with market, side and leverage, or pass an Arcus position from perps_account.',
    }
  },
})
