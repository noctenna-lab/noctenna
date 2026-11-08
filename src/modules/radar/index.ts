// Funding radar: every perps market on Arcus and Lighter side by side. Read-only, and always mainnet data, because
// that is where the funding that matters is paid.
import { z } from 'zod'
import type { Ctx, Module } from '../../core/types.js'
import { json, round, tool, u } from '../perps/api.js'
import { arcusMarkets, arcusPctYear } from '../perps/arcus.js'
import { LIGHTER, lighterMarkets, lighterPctYear } from '../perps/lighter.js'

type Arcus = {
  fundingPctYr: number
  oiUsd: number
  volume24hUsd: number
  closed: boolean
  mark: number
  settlement: number | null
  gapPct: number | null
}
type Lighter = { fundingPctYr: number | null; oiUsd: number; volume24hUsd: number }

export async function snapshot(ctx: Ctx) {
  const [am, lm, top] = await Promise.all([
    arcusMarkets(ctx, 'mainnet'),
    lighterMarkets(ctx),
    json<{ entries: Record<string, unknown>[] }>(
      ctx,
      `${LIGHTER.mainnet}/pnlLeaderboard?time_window=24h&sort_by=account_value&limit=1`,
    ).catch(() => ({ entries: [] })),
  ])
  // Joined on the base symbol, as both venues name their markets.
  const rows = new Map<string, { arcus?: Arcus; lighter?: Lighter }>()
  const row = (s: string) => rows.get(s) ?? rows.set(s, {}).get(s)!
  for (const m of am) {
    if (m.status !== 'ONLINE') continue
    const mark = Number(m.markPrice)
    const settle = Number(m.currentSettlementPrice ?? 0) || null
    row(m.baseAsset).arcus = {
      fundingPctYr: round(arcusPctYear(m.fundingRate)),
      oiUsd: Math.round(Number(m.openInterest) * mark),
      volume24hUsd: Math.round(Number(m.volume24hNotional ?? 0)),
      closed: Boolean(m.isOutsideRth),
      mark,
      settlement: settle,
      gapPct: settle ? round((mark / settle - 1) * 100, 2) : null,
    }
  }
  for (const m of lm) {
    row(m.symbol).lighter = {
      fundingPctYr: m.funding8h === null ? null : round(lighterPctYear(m.funding8h)),
      oiUsd: Math.round(Number(m.open_interest) * Number(m.mark_price)),
      volume24hUsd: Math.round(Number(m.daily_quote_token_volume)),
    }
  }
  const all = [...rows].sort(([a], [b]) => (a < b ? -1 : 1))
  const sum = (f: (r: { arcus?: Arcus; lighter?: Lighter }) => number | undefined) =>
    all.reduce((t, [, r]) => t + (f(r) ?? 0), 0)

  const gaps = all
    .filter(([, r]) => r.arcus && r.lighter?.fundingPctYr != null)
    .map(([s, r]) => ({
      symbol: s,
      arcusPctYr: r.arcus!.fundingPctYr,
      lighterPctYr: r.lighter!.fundingPctYr!,
      gapPctYr: round(Math.abs(r.arcus!.fundingPctYr - r.lighter!.fundingPctYr!)),
    }))
    .sort((a, b) => b.gapPctYr - a.gapPctYr)
  const closed = all.filter(([, r]) => r.arcus?.closed).map(([s, r]) => ({ symbol: s, ...r.arcus! }))
  const e = top.entries[0]

  return {
    at: new Date().toISOString(),
    data: 'mainnet data from Arcus and Lighter on Robinhood Chain, whatever network Noctenna is set to',
    totals: {
      markets: all.length,
      openInterestUsd: { arcus: sum((r) => r.arcus?.oiUsd), lighter: sum((r) => r.lighter?.oiUsd) },
      volume24hUsd: { arcus: sum((r) => r.arcus?.volume24hUsd), lighter: sum((r) => r.lighter?.volume24hUsd) },
    },
    widestGaps: gaps.slice(0, 10).map((g) => ({ ...g, symbol: u(g.symbol) })),
    closedStockMarkets: {
      note: 'Arcus stock perps whose underlying market is closed pay a fixed funding rate (SOFR + 0.5%) and trade inside a price band around the last settlement.',
      fixedFundingPctYr: [...new Set(closed.map((c) => c.fundingPctYr))].sort((a, b) => a - b),
      // The weekend gap: how far the perp has moved from the last settlement while the stock could not trade.
      byGap: closed
        .filter((c) => c.gapPct !== null)
        .sort((a, b) => Math.abs(b.gapPct!) - Math.abs(a.gapPct!))
        .map((c) => ({
          symbol: u(c.symbol),
          fundingPctYr: c.fundingPctYr,
          settlement: c.settlement,
          mark: c.mark,
          gapPct: c.gapPct,
        })),
    },
    largestLighterAccount: e
      ? {
          address: u(e.l1_address),
          accountValueUsd: Math.round(Number(e.account_value)),
          shortPct: Number(e.short_percentage),
          biggestPosition: u(e.biggest_position_asset),
          biggestPositionUsd: Math.round(Number(e.biggest_position_value)),
          pnl24hUsd: Math.round(Number(e.pnl)),
        }
      : null,
    table: all.map(([s, { arcus: a, lighter }]) => ({
      symbol: u(s),
      arcus: a && { fundingPctYr: a.fundingPctYr, oiUsd: a.oiUsd, volume24hUsd: a.volume24hUsd, closed: a.closed },
      lighter,
    })),
  }
}

const radarTool = tool({
  name: 'radar',
  description:
    'Funding radar across Arcus and Lighter (mainnet data, read-only): one table of every perps market with funding %/yr on each venue, open interest and 24 h volume; the widest Arcus-vs-Lighter funding gaps; Arcus stock markets that are closed, their fixed funding and the gap of mark vs last settlement; and the largest Lighter account by value.',
  kind: 'read',
  input: z.object({}),
  run: (ctx) => snapshot(ctx),
})

export const radar: Module = { name: 'radar', tools: [radarTool] }
