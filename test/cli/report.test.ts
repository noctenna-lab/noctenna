import { expect, it } from 'vitest'
import { checkText, colors, radarText } from '../../src/cli/report.js'
import { snapshot } from '../../src/modules/radar/index.js'
import { fakeCtx, fixture } from '../perps/fake.js'

it('prints the radar as a table of the widest gaps, coloured only when asked', async () => {
  const { ctx } = fakeCtx((url) => {
    if (url === 'https://api.arcus.xyz/v1/markets') return fixture('perps', 'arcus_markets.json')
    if (url === 'https://api.rh.lighter.xyz/api/v1/orderBookDetails') return fixture('perps', 'lighter_details.json')
    if (url === 'https://api.rh.lighter.xyz/api/v1/funding-rates') return fixture('perps', 'lighter_funding.json')
    if (url.startsWith('https://api.rh.lighter.xyz/api/v1/pnlLeaderboard'))
      return fixture('perps', 'lighter_leaderboard.json')
  })
  const r = await snapshot(ctx)
  const plain = radarText(r)
  const top = r.widestGaps[0]!
  expect(plain).toMatch(new RegExp(`\\n  ${top.symbol.untrusted} +.*${top.gapPctYr.toFixed(2)}\\n`))
  expect(plain).toContain('Positive funding: longs pay shorts.')
  expect(plain).toContain('Largest Lighter account: $13.8M, 95.1% short, biggest position SNDK')
  expect(plain).not.toContain('\x1b')
  expect(radarText(r, colors(true, true))).toContain('\x1b[38;2;')
})

it('prints a launch check with control characters stripped from the token name', () => {
  const r = {
    token: '0x3e6a2fF34bF06B7DAC037d55E1452c8518f42CFc',
    name: { untrusted: 'Evil\x1b[2J Token‮' },
    symbol: { untrusted: 'EVIL' },
    deployer: '0x53db8494121B346fe5C7Ba6F122deeC098262680',
    launchedAt: '2026-11-11T11:02:03.000Z',
    devBuy: { eth: '0.0355', pctOfSupply: 2.0099, recipient: null, recipientHoldsPctNow: 0 },
    snipeTaxExempt: { besidesDefaults: 2, pctOfSupplyTheyBought: 14.2 },
    first5Minutes: { uniqueOutsideBuyers: 1, outsideEth: '0.0088' },
    first3Seconds: { buys: 0, wallets: 0, pctOfSupplyBought: 0 },
    curveTrades: { buys: 1, sells: 0, uniqueBuyers: 1 },
    creatorTaxBps: 193,
    creatorFeeRecipient: '0x53db8494121B346fe5C7Ba6F122deeC098262680',
    creatorFeeRecipientIsDeployer: true,
    creatorFeesOnCurveEth: '0.270123016976514674',
    phase: 'pool',
    graduatedAfterSec: 19140,
    deployerLaunches: { total: 3, graduatedOfShown: 1, shown: [{}, {}] },
  } as unknown as Parameters<typeof checkText>[0]
  const out = checkText(r)
  expect(out).toContain('Launch check  Evil[2J Token (EVIL)')
  expect(out).not.toMatch(/[\x1b‮]/)
  expect(out).toContain('Extra exempt wallets  2, bought 14.20% of supply')
  expect(out).toContain('First 3 seconds       no buys')
  expect(out).toContain('First 5 minutes       1 outside buyer, 0.0088 ETH')
  expect(out).toContain('Curve trades          1 buy, 0 sells, 1 buyer')
  expect(out).toContain('Creator tax           1.93%, 0.2701 ETH earned on the curve')
  expect(out).toContain('Graduated             yes, 5 h 19 min after launch')
  expect(out).toContain("Deployer's others     2 launches, 1 graduated")
})
