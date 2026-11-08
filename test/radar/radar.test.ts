import { expect, it } from 'vitest'
import { snapshot } from '../../src/modules/radar/index.js'
import { fakeCtx, fixture } from '../perps/fake.js'

it('joins both venues by symbol and ranks gaps, closed stock markets and the largest account (mainnet data in testnet mode)', async () => {
  const { ctx, calls } = fakeCtx((url) => {
    if (url === 'https://api.arcus.xyz/v1/markets') return fixture('perps', 'arcus_markets.json')
    if (url === 'https://api.rh.lighter.xyz/api/v1/orderBookDetails') return fixture('perps', 'lighter_details.json')
    if (url === 'https://api.rh.lighter.xyz/api/v1/funding-rates') return fixture('perps', 'lighter_funding.json')
    if (
      url.startsWith('https://api.rh.lighter.xyz/api/v1/pnlLeaderboard?time_window=24h&sort_by=account_value&limit=1')
    )
      return fixture('perps', 'lighter_leaderboard.json')
  }, 'testnet')
  const r = await snapshot(ctx)
  expect(calls.every((c) => !c.url.includes('testnet'))).toBe(true)
  expect(r.table.map((t) => t.symbol.untrusted)).toEqual(['AMD', 'BTC', 'ETH'])
  const gaps = r.widestGaps.map((g) => g.gapPctYr)
  expect(gaps).toEqual([...gaps].sort((a, b) => b - a))
  for (const g of r.widestGaps) expect(g.gapPctYr).toBeCloseTo(Math.abs(g.arcusPctYr - g.lighterPctYr), 1)
  expect(r.closedStockMarkets.byGap).toEqual([
    { symbol: { untrusted: 'AMD' }, fundingPctYr: 4.48, settlement: 447.57, mark: 445.53, gapPct: -0.46 },
  ])
  expect(r.closedStockMarkets.fixedFundingPctYr).toEqual([4.48])
  expect(r.largestLighterAccount).toMatchObject({
    accountValueUsd: 13776120,
    shortPct: 95.1,
    biggestPosition: { untrusted: 'SNDK' },
  })
  expect(r.totals.openInterestUsd.arcus).toBe(r.table.reduce((t, x) => t + (x.arcus?.oiUsd ?? 0), 0))
})
