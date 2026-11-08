// Reopen watch: where a liquidation price sits against the weekend band, and the gap history it is read against.
import { expect, it } from 'vitest'
import { reopenCheck, reopenRisk, weekendsPast } from '../../src/modules/perps/reopen.js'
import { GAPS } from '../../src/modules/perps/gaps.js'
import { fakeCtx, fixture } from './fake.js'

const band = { settle: 100, mark: 99, lower: 97.5, upper: 102.5, nextLower: 95, nextUpper: 105, mmf: 0.0333 }

it('places the liquidation price against the band, the widened band and the reopen', () => {
  const far = reopenRisk(band, 'long', 'NVDA', { leverage: 10 }) // 99 × (1 − (0.1 − 0.0333))
  expect(far.liquidationPrice).toBeCloseTo(92.397, 2)
  expect(far.gapFromFridayToLiquidationPct).toBe(7.6)
  expect(far.verdict).toMatch(/Only a reopen gap/)
  expect(far.history).toMatchObject({ weekends: GAPS.NVDA!.n, set: 'NVDA' })
  expect(reopenRisk(band, 'long', 'NVDA', { leverage: 20 }).verdict).toMatch(/widened band/)
  expect(reopenRisk(band, 'short', 'NVDA', { price: 102 }).verdict).toMatch(/band itself/)
  expect(reopenRisk(band, 'long', 'NVDA', { leverage: 30 }).verdict).toMatch(/At or past/)
  expect(reopenRisk(band, 'long', 'NVDA', { price: 0 }).liquidationPrice).toBeNull()
})

it('reads gap history on the 0.5% grid, rounding toward more weekends, and falls back to all US shares', () => {
  const us = GAPS.US!
  expect(weekendsPast('NOPE', 'long', 5.2)).toEqual({ weekends: us.n, opened: us.down[9], set: 'US' }) // 5.0% step
  expect(weekendsPast('NVDA', 'short', 0.3).opened).toBe(GAPS.NVDA!.n) // under the first step: every weekend counts
})

it("checks this wallet's Lighter stock perps against Arcus's band and Friday close", async () => {
  const { ctx } = fakeCtx((url) => {
    if (url === 'https://api.arcus.xyz/v1/markets') return fixture('perps', 'arcus_markets.json')
    if (url.endsWith('/orderBookDetails')) return fixture('perps', 'lighter_details.json')
    if (url.endsWith('/funding-rates')) return fixture('perps', 'lighter_funding.json')
    if (url.includes('/account?by=l1_address'))
      return {
        accounts: [
          {
            account_index: 7,
            positions: [
              {
                market_id: 1,
                symbol: 'AMD',
                sign: 1,
                position: '10',
                avg_entry_price: '440',
                position_value: '4455',
                liquidation_price: '410',
              },
              {
                market_id: 0,
                symbol: 'ETH',
                sign: -1,
                position: '1',
                avg_entry_price: '3000',
                position_value: '3000',
                liquidation_price: '3500',
              },
            ],
          },
        ],
      }
  })
  const r = (await reopenCheck.run(ctx, {})) as any
  expect(r.usMarketShut).toBe(true)
  expect(r.positions).toHaveLength(1) // ETH is not a stock perp
  expect(r.positions[0]).toMatchObject({
    source: 'lighter',
    account: 7,
    market: { untrusted: 'AMD' },
    side: 'long',
    liquidationPrice: 410,
    band: [425.2, 469.94],
  })
  expect(r.positions[0].verdict).toMatch(/widened band/) // 410 sits between the band's 425.2 and the widened band's 402.82
})
