// `noctenna radar` and `noctenna check <token>`: the radar and launch-check tools printed as tables for a person, with
// no wallet, model or setup needed. Text from the venues and the chain loses its control characters before it reaches
// the terminal, the same cleaning it gets before it reaches the model.
import { quoteUntrusted } from '../core/server.js'
import type { Untrusted } from '../core/types.js'
import type { launchCheck } from '../modules/intel/index.js'
import type { snapshot } from '../modules/radar/index.js'

type Radar = Awaited<ReturnType<typeof snapshot>>
type Check = Awaited<ReturnType<typeof launchCheck>>
export type Colors = ReturnType<typeof colors>

// 24-bit colour where the terminal declares it (COLORTERM), the nearest of the 256 standard colours elsewhere.
export function colors(on: boolean, truecolor: boolean) {
  const wrap = (code: string) => (s: string) => (on ? `\x1b[${code}m${s}\x1b[0m` : s)
  const rgb = (c: number[]) =>
    wrap(truecolor ? `38;2;${c.join(';')}` : `38;5;${c.reduce((n, x) => n * 6 + Math.round((x / 255) * 5), 0) + 16}`)
  return {
    bold: wrap('1'),
    dim: wrap('2'),
    violet: rgb([150, 110, 255]),
    lilac: rgb([214, 200, 255]),
    amber: rgb([245, 185, 66]),
    rose: rgb([255, 107, 129]),
  }
}

const clean = (v: Untrusted<unknown>, max: number) => quoteUntrusted(v.untrusted).untrusted_text.slice(0, max)
const signed = (x: number) => `${x > 0 ? '+' : ''}${x.toFixed(2)}`
const usd = (x: number) =>
  x >= 1e9
    ? `$${(x / 1e9).toFixed(1)}B`
    : x >= 1e6
      ? `$${(x / 1e6).toFixed(1)}M`
      : x >= 1e3
        ? `$${(x / 1e3).toFixed(1)}k`
        : `$${Math.round(x)}`
const eth = (s: string) => `${Number(Number(s).toFixed(4))} ETH`
const pct = (x: number) => `${x.toFixed(2)}%`
const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`
const duration = (sec: number) => {
  const m = Math.round(sec / 60)
  if (sec < 60) return `${sec} s`
  if (m < 60) return `${m} min`
  if (m < 48 * 60) return `${Math.floor(m / 60)} h ${m % 60} min`
  return `${Math.floor(m / 1440)} d ${Math.floor((m % 1440) / 60)} h`
}

export function radarText(r: Radar, c: Colors = colors(false, false)): string {
  const closed = new Set(r.table.filter((t) => t.arcus?.closed).map((t) => t.symbol.untrusted))
  const rate = (x: number, w: number, tint: (s: string) => string) => (x < 0 ? c.rose : tint)(signed(x).padStart(w))
  const rows = r.widestGaps.map(
    (g) =>
      `  ${clean(g.symbol, 9).padEnd(10)}${c.dim((closed.has(g.symbol.untrusted) ? 'closed' : '').padEnd(8))}` +
      `${rate(g.arcusPctYr, 8, c.violet)}${rate(g.lighterPctYr, 10, c.lilac)}` +
      `${(g.gapPctYr >= 15 ? c.amber : c.bold)(g.gapPctYr.toFixed(2).padStart(9))}`,
  )
  const fixed = r.closedStockMarkets.fixedFundingPctYr
  const top = r.largestLighterAccount
  return [
    '',
    `  ${c.bold('Funding radar')}  ${c.dim(`${r.at.slice(11, 16)} UTC · % a year · Robinhood Chain mainnet`)}`,
    '',
    `  ${c.dim('Market'.padEnd(18))}${c.violet('Arcus'.padStart(8))}${c.lilac('Lighter'.padStart(10))}${c.dim('Gap'.padStart(9))}`,
    ...rows,
    '',
    c.dim(`  The widest gaps of ${r.totals.markets} markets. Positive funding: longs pay shorts.`),
    c.dim(
      `  Open interest ${usd(r.totals.openInterestUsd.arcus)} on Arcus, ${usd(r.totals.openInterestUsd.lighter)} on Lighter.`,
    ),
    ...(fixed.length
      ? [
          c.dim(
            `  Closed stock markets on Arcus pay a fixed ${fixed.map(signed).join(', ')}% a year inside a price band.`,
          ),
        ]
      : []),
    ...(top
      ? [
          c.dim(
            `  Largest Lighter account: ${usd(top.accountValueUsd)}, ${top.shortPct}% short, biggest position ` +
              `${clean(top.biggestPosition, 12)} (${usd(top.biggestPositionUsd)}).`,
          ),
        ]
      : []),
    '',
    c.dim('  Information only, not financial advice. Ask the agent about any of it: noctenna'),
    '',
  ].join('\n')
}

export function checkText(r: Check, c: Colors = colors(false, false)): string {
  const line = (label: string, value: string) => `  ${c.dim(label.padEnd(22))}${value}`
  const x = r.snipeTaxExempt
  const d = r.deployerLaunches
  const graduated =
    r.phase === 'pool'
      ? r.graduatedAfterSec !== undefined
        ? `yes, ${duration(r.graduatedAfterSec)} after launch`
        : 'yes'
      : r.phase === 'curve'
        ? 'not yet, still on the curve'
        : 'graduating now'
  return [
    '',
    `  ${c.bold('Launch check')}  ${c.violet(`${clean(r.name, 32)} (${clean(r.symbol, 16)})`)}`,
    c.dim(`  ${r.token}`),
    c.dim(`  Launched ${r.launchedAt.slice(0, 16).replace('T', ' ')} UTC by ${short(r.deployer)}`),
    '',
    line('Dev buy', `${eth(r.devBuy.eth)}, ${pct(r.devBuy.pctOfSupply)} of supply`),
    line('Dev wallet now', `holds ${pct(r.devBuy.recipientHoldsPctNow)} of supply`),
    line(
      'Extra exempt wallets',
      x.besidesDefaults ? `${x.besidesDefaults}, bought ${pct(x.pctOfSupplyTheyBought)} of supply` : 'none',
    ),
    line(
      'First 3 seconds',
      r.first3Seconds.buys
        ? `${count(r.first3Seconds.buys, 'buy')} from ${count(r.first3Seconds.wallets, 'wallet')}, ${pct(r.first3Seconds.pctOfSupplyBought)} of supply`
        : 'no buys',
    ),
    line(
      'First 5 minutes',
      r.first5Minutes.uniqueOutsideBuyers
        ? `${count(r.first5Minutes.uniqueOutsideBuyers, 'outside buyer')}, ${eth(r.first5Minutes.outsideEth)}`
        : 'no outside buyers',
    ),
    line(
      'Curve trades',
      `${count(r.curveTrades.buys, 'buy')}, ${count(r.curveTrades.sells, 'sell')}, ${count(r.curveTrades.uniqueBuyers, 'buyer')}`,
    ),
    line('Creator tax', `${pct(r.creatorTaxBps / 100)}, ${eth(r.creatorFeesOnCurveEth)} earned on the curve`),
    line('Fee wallet', r.creatorFeeRecipientIsDeployer ? 'the deployer' : short(r.creatorFeeRecipient)),
    line('Graduated', graduated),
    line(
      "Deployer's others",
      d.total <= 1
        ? 'none, this is its only launch'
        : `${count(d.total - 1, 'launch', 'launches')}, ${d.graduatedOfShown} graduated${d.total - 1 > d.shown.length ? ` of the newest ${d.shown.length}` : ''}`,
    ),
    '',
    c.dim('  Extra exempt wallets skip the snipe tax at launch, which is how bundles buy in.'),
    c.dim('  Facts from mainnet, no verdicts. Information only, not financial advice.'),
    '',
  ].join('\n')
}
