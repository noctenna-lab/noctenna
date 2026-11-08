// A launch check for any Pons token, from mainnet chain data only: who bought how much how early, who was exempt from
// the snipe tax, what the creator earned, whether and how fast it graduated, and what else its deployer launched.
// Facts with plain labels; no verdicts. Mirrors the per-launch metrics of our launch index: outside buyers exclude the
// launch transaction and the deployer, and a buy belongs to its CurveBuy recipient.
import {
  decodeEventLog,
  decodeFunctionData,
  formatEther,
  getAbiItem,
  getAddress,
  isAddressEqual,
  pad,
  parseAbi,
  toEventSelector,
  type Address,
  type Hex,
  type Log,
  type PublicClient,
} from 'viem'
import { z } from 'zod'
import type { Module, Tool } from '../../core/types.js'
import { curveAbi, factoryAbi, launchRouterAbi, PHASE_NAME, PONS, tokenAbi, TOPIC } from '../pons/abi.js'
import { launchOf } from '../pons/trade.js'
import { addressArg } from '../wallet/tokens.js'

const P = PONS.mainnet
const SPAN = 10_000_000n // eth_getLogs block span with one address (an address list or topic OR-list caps it at 100k)
const sweptEvent = parseAbi(['event LaunchSwept(address indexed token, uint256 quoteOut, uint256 tokenOut)'])[0]
const SWEPT = toEventSelector(getAbiItem({ abi: [sweptEvent], name: 'LaunchSwept' }))

// Every log of `filter` in [from, to]: windows of SPAN, halved whenever the node refuses one (10,000 logs per query).
async function logsAll(
  chain: PublicClient,
  filter: { address: Address; topics?: (Hex | null)[] },
  from: bigint,
  to: bigint,
  newestFirst = false,
  stop?: (l: Log[]) => boolean,
): Promise<Log[]> {
  const out: Log[] = []
  const query = async (a: bigint, b: bigint): Promise<Log[]> => {
    try {
      const raw = (await chain.request({
        method: 'eth_getLogs',
        params: [
          {
            address: filter.address,
            topics: filter.topics,
            fromBlock: `0x${a.toString(16)}`,
            toBlock: `0x${b.toString(16)}`,
          },
        ],
      })) as unknown as (Omit<Log, 'blockNumber'> & { blockNumber: Hex })[]
      return raw.map((l) => ({ ...l, blockNumber: BigInt(l.blockNumber) }) as Log)
    } catch (e) {
      if (b - a < 1_000n) throw e
      const mid = (a + b) / 2n
      return [...(await query(a, mid)), ...(await query(mid + 1n, b))]
    }
  }
  if (newestFirst) {
    for (let b = to; b >= from; b -= SPAN) {
      const a = b - SPAN + 1n > from ? b - SPAN + 1n : from
      out.push(...(await query(a, b)).reverse())
      if (stop?.(out)) break
    }
  } else for (let a = from; a <= to; a += SPAN) out.push(...(await query(a, a + SPAN - 1n < to ? a + SPAN - 1n : to)))
  return out
}

const topicOf = (a: Address) => pad(a.toLowerCase() as Hex)
const topicAddr = (t: Hex) => getAddress(`0x${t.slice(26)}`)
const pct = (part: bigint, whole: bigint) => (whole > 0n ? Number((part * 1_000_000n) / whole) / 10_000 : 0)

interface Buy {
  tx: Hex
  block: bigint
  recipient: Address
  eth: bigint
  tokens: bigint
}

const input = z.object({ token: addressArg })
const checkLaunch: Tool<typeof input> = {
  name: 'intel_check_launch',
  description:
    "Launch check for a Pons token (mainnet data): dev buy, snipe-tax-exempt wallets besides the defaults (a bundle signal), outside buyers in the first 5 minutes, share bought in the first 3 seconds, top-10 buyer share, creator tax and fees so far, graduation and how fast, and the deployer's other launches. Facts only.",
  kind: 'read',
  input,
  run: async (ctx, { token }) => {
    const chain = ctx.mainnet ?? ctx.chain
    const lt = await launchOf(chain, 'mainnet', token)
    const head = await chain.getBlock()
    const found = await logsAll(
      chain,
      { address: P.factory, topics: [TOPIC.TokenLaunched, topicOf(token)] },
      P.deployBlock,
      head.number,
      true,
      (l) => l.length > 0,
    )
    const launch = found[0]
    if (!launch) throw new Error('the launch event was not found')
    const launchBlock = launch.blockNumber!
    const launchTx = launch.transactionHash!
    const curve = lt.curve
    const [receipt, tx, header, supply, name, symbol] = await Promise.all([
      chain.getTransactionReceipt({ hash: launchTx }),
      chain.getTransaction({ hash: launchTx }),
      chain.getBlock({ blockNumber: launchBlock }),
      chain.readContract({ address: token, abi: tokenAbi, functionName: 'totalSupply' }),
      chain.readContract({ address: token, abi: tokenAbi, functionName: 'name' }).catch(() => ''),
      chain.readContract({ address: token, abi: tokenAbi, functionName: 'symbol' }).catch(() => ''),
    ])
    const launchTs = Number(header.timestamp)

    // The launch transaction: the dev buy and the snipe-tax exemptions it set.
    const exempt = new Set<Address>()
    let devEth = 0n
    let devTokens = 0n
    let devRecipient: Address | undefined
    for (const l of receipt.logs) {
      if (!isAddressEqual(l.address, curve)) continue
      if (l.topics[0] === TOPIC.SnipeTaxExempted && l.topics[1]) exempt.add(topicAddr(l.topics[1]))
      if (l.topics[0] === TOPIC.CurveBuy) {
        const { args } = decodeEventLog({
          abi: curveAbi,
          eventName: 'CurveBuy',
          data: l.data,
          topics: l.topics as [Hex, ...Hex[]],
        })
        devEth += args.quoteIn
        devTokens += args.tokensOut
        devRecipient ??= args.recipient
      }
    }
    // The factory exempts the creator, the launch-time fee wallet and the dev buy's recipient by default.
    let feeAtLaunch = lt.creatorFeeRecipient
    if (P.launchRouter && tx.to && isAddressEqual(tx.to, P.launchRouter)) {
      try {
        feeAtLaunch = decodeFunctionData({ abi: launchRouterAbi, data: tx.input }).args[0].creatorFeeRecipient
      } catch {
        // not a launchAndBuy call: keep the current fee wallet
      }
    }
    const defaults = [lt.deployer, feeAtLaunch, ...(devRecipient ? [devRecipient] : [])]
    const extra = [...exempt].filter((a) => !defaults.some((d) => isAddressEqual(d, a)))

    // Every curve trade since launch (a graduated curve stops trading, so reading to the head is complete).
    const curveLogs = await logsAll(chain, { address: curve }, launchBlock, head.number)
    const buys: Buy[] = []
    let creatorFees = 0n
    let sells = 0
    for (const l of curveLogs) {
      if (l.topics[0] !== TOPIC.CurveBuy && l.topics[0] !== TOPIC.CurveSell) continue
      const ev = decodeEventLog({ abi: curveAbi, data: l.data, topics: l.topics as [Hex, ...Hex[]] })
      if (ev.eventName === 'CurveBuy') {
        creatorFees += ev.args.tax
        buys.push({
          tx: l.transactionHash!,
          block: l.blockNumber!,
          recipient: ev.args.recipient,
          eth: ev.args.quoteIn,
          tokens: ev.args.tokensOut,
        })
      } else if (ev.eventName === 'CurveSell') {
        creatorFees += ev.args.tax
        sells++
      }
    }

    // Block -> time: exact headers for the first ~10 s (the 3-second window), interpolation after (blocks are very
    // regular, ~0.1 s; measured error ~1 s over 5,000 blocks).
    const early = [...new Set(buys.filter((b) => b.block - launchBlock <= 100n).map((b) => b.block))]
    const anchorBlock = launchBlock + 3_000n < head.number ? launchBlock + 3_000n : head.number
    const [anchor, ...earlyHeaders] = await Promise.all([
      chain.getBlock({ blockNumber: anchorBlock }),
      ...early.map((b) => chain.getBlock({ blockNumber: b })),
    ])
    const exact = new Map(earlyHeaders.map((h) => [h.number, Number(h.timestamp)]))
    const anchors: [bigint, number][] = [
      [launchBlock, launchTs],
      [anchorBlock, Number(anchor.timestamp)],
      [head.number, Number(head.timestamp)],
    ]
    const tsOf = (b: bigint) => {
      const e = exact.get(b)
      if (e !== undefined) return e
      const i = b <= anchorBlock ? 0 : 1
      const [b0, t0] = anchors[i]!
      const [b1, t1] = anchors[i + 1]!
      return b1 === b0 ? t0 : t0 + ((t1 - t0) * Number(b - b0)) / Number(b1 - b0)
    }

    const outside = buys.filter((b) => b.tx !== launchTx && !isAddressEqual(b.recipient, lt.deployer))
    const first5 = outside.filter((b) => tsOf(b.block) - launchTs <= 300)
    const first3 = buys.filter((b) => b.tx !== launchTx && tsOf(b.block) - launchTs <= 3)
    const byBuyer = new Map<Address, bigint>()
    for (const b of buys) byBuyer.set(b.recipient, (byBuyer.get(b.recipient) ?? 0n) + b.tokens)
    const top = [...byBuyer.entries()].sort((a, b) => (b[1] > a[1] ? 1 : b[1] < a[1] ? -1 : 0)).slice(0, 10)
    const extraBought = buys
      .filter((b) => extra.some((x) => isAddressEqual(x, b.recipient)))
      .reduce((s, b) => s + b.tokens, 0n)

    // Graduation: the factory's LaunchSwept for this token (sweptAt can read 0 once the pool is open).
    const swept =
      lt.phase === 0
        ? []
        : await logsAll(chain, { address: P.factory, topics: [SWEPT, topicOf(token)] }, launchBlock, head.number)
    const sweptTs = swept[0]
      ? Number((await chain.getBlock({ blockNumber: swept[0].blockNumber! })).timestamp)
      : lt.sweptAt > 0n
        ? Number(lt.sweptAt)
        : undefined

    // The deployer's launches, newest first; outcomes for the newest 50.
    const theirs = await logsAll(
      chain,
      { address: P.factory, topics: [TOPIC.TokenLaunched, null, null, topicOf(lt.deployer)] },
      P.deployBlock,
      head.number,
      true,
    )
    const others = theirs.filter((l) => !isAddressEqual(topicAddr(l.topics[1]!), token))
    const shown = others.slice(0, 50)
    const states = await chain.multicall({
      allowFailure: true,
      contracts: shown.map((l) => ({
        address: P.factory,
        abi: factoryAbi,
        functionName: 'getLaunchedToken' as const,
        args: [topicAddr(l.topics[1]!)] as const,
      })),
    })
    const earlier = others.filter((l) => l.blockNumber! < launchBlock).length

    return {
      network: 'mainnet',
      data: 'mainnet data',
      token,
      name: { untrusted: name },
      symbol: { untrusted: symbol },
      deployer: lt.deployer,
      launchedAt: new Date(launchTs * 1000).toISOString(),
      launchTx,
      devBuy: { eth: formatEther(devEth), pctOfSupply: pct(devTokens, supply), recipient: devRecipient ?? null },
      snipeTaxExempt: {
        total: exempt.size,
        besidesDefaults: extra.length,
        wallets: extra,
        pctOfSupplyTheyBought: pct(extraBought, supply),
        note: 'defaults: the deployer, the launch-time fee wallet and the dev buy recipient. Extra exempt wallets are how bundles buy at launch without the snipe tax.',
      },
      first5Minutes: {
        outsideBuys: first5.length,
        uniqueOutsideBuyers: new Set(first5.map((b) => b.recipient)).size,
        outsideEth: formatEther(first5.reduce((s, b) => s + b.eth, 0n)),
        note: 'outside = not the launch transaction and not the deployer',
      },
      first3Seconds: {
        buys: first3.length,
        wallets: new Set(first3.map((b) => b.recipient)).size,
        pctOfSupplyBought: pct(
          first3.reduce((s, b) => s + b.tokens, 0n),
          supply,
        ),
        note: 'buys after the launch transaction',
      },
      top10Buyers: {
        pctOfSupplyBought: pct(
          top.reduce((s, [, v]) => s + v, 0n),
          supply,
        ),
        note: 'gross curve buys by recipient; later sells and transfers not subtracted',
      },
      curveTrades: { buys: buys.length, sells, uniqueBuyers: byBuyer.size },
      creatorTaxBps: lt.creatorTaxBps,
      creatorFeeRecipient: lt.creatorFeeRecipient,
      creatorFeeRecipientIsDeployer: isAddressEqual(lt.creatorFeeRecipient, lt.deployer),
      creatorFeesOnCurveEth: formatEther(creatorFees),
      phase: PHASE_NAME[lt.phase],
      graduated: lt.phase !== 0,
      graduatedAfterSec: sweptTs !== undefined ? sweptTs - launchTs : undefined,
      deployerLaunches: {
        total: theirs.length,
        before: earlier,
        after: others.length - earlier,
        graduatedOfShown: states.filter((s) => s.status === 'success' && s.result.phase !== 0).length,
        shown: shown.map((l, i) => {
          const s = states[i]
          return {
            token: topicAddr(l.topics[1]!),
            block: l.blockNumber,
            phase: s?.status === 'success' ? PHASE_NAME[s.result.phase] : undefined,
          }
        }),
      },
    }
  },
}

export const intel: Module = { name: 'intel', tools: [checkLaunch] }
