// Pons launches: recent launches, one token's state, curve quotes, and buys and sells on the curve. A graduated token
// trades through the swap module. Reads default to mainnet data, even in testnet mode (reading risks nothing);
// quotes and trades use the configured network.
import { formatEther, isAddressEqual, parseEther, type Address, type PublicClient } from 'viem'
import { z } from 'zod'
import type { Ctx, Module, Network, Preview, Tool } from '../../core/types.js'
import { prepareSwap, quoteSwap, SWAPS_ON_MAINNET } from '../swap/index.js'
import { usdValue } from '../swap/price.js'
import { addressArg, amountArg, balanceOf, fmt, requireAddress } from '../wallet/tokens.js'
import { curveAbi, ETH, factoryAbi, PHASE, PHASE_NAME, PONS, tokenAbi } from './abi.js'
import { launchOf, quoteCurve } from './trade.js'

const PLACEHOLDER: Address = '0x0000000000000000000000000000000000000001' // reads the snipe tax a stranger would pay

const networkArg = z.enum(['mainnet', 'testnet']).optional().describe('whose Pons data to read; default mainnet')

// Reads: mainnet data from the mainnet client; testnet data only in testnet mode (its client is the configured one).
function readClient(ctx: Ctx, network: Network | undefined): { chain: PublicClient; network: Network } {
  const n = network ?? 'mainnet'
  if (n === ctx.config.network) return { chain: ctx.chain, network: n }
  if (n === 'mainnet') return { chain: ctx.mainnet ?? ctx.chain, network: n }
  throw new Error('testnet Pons data is readable in testnet mode only')
}

const dataLabel = (n: Network) => (n === 'mainnet' ? 'mainnet data' : 'testnet data')

const launchEvent = factoryAbi[0]

const launchesInput = z.object({
  minutes: z.number().int().min(1).max(1440).default(60).describe('how far back to look, in minutes (max 1440)'),
  limit: z.number().int().min(1).max(100).default(20),
  network: networkArg,
})
const launches: Tool<typeof launchesInput> = {
  name: 'pons_launches',
  description: 'Recent Pons launches (newest first): token, curve, deployer, age, phase, name and symbol.',
  kind: 'read',
  input: launchesInput,
  run: async (ctx, { minutes, limit, network }) => {
    const { chain, network: n } = readClient(ctx, network)
    const head = await chain.getBlock()
    const span = BigInt(minutes * 600) // ~0.1 s blocks
    const from = head.number - span > PONS[n].deployBlock ? head.number - span : PONS[n].deployBlock
    const logs = await chain.getLogs({
      address: PONS[n].factory,
      event: launchEvent,
      fromBlock: from,
      toBlock: head.number,
    })
    const picked = logs.reverse().slice(0, limit)
    const reads = await chain.multicall({
      allowFailure: true,
      contracts: picked.flatMap((l) => [
        { address: l.args.token!, abi: tokenAbi, functionName: 'name' } as const,
        { address: l.args.token!, abi: tokenAbi, functionName: 'symbol' } as const,
        { address: PONS[n].factory, abi: factoryAbi, functionName: 'getLaunchedToken', args: [l.args.token!] } as const,
      ]),
    })
    return {
      network: n,
      data: dataLabel(n),
      window: `last ${minutes} min (${logs.length} launches)`,
      launches: picked.map((l, i) => {
        const [name, symbol, lt] = reads
          .slice(i * 3, i * 3 + 3)
          .map((r) => (r.status === 'success' ? r.result : undefined))
        const phase = (lt as { phase?: number } | undefined)?.phase
        return {
          token: l.args.token,
          curve: l.args.curve,
          deployer: l.args.deployer,
          pair: isAddressEqual(l.args.pairToken!, ETH) ? 'ETH' : l.args.pairToken,
          ageSecApprox: Number(head.number - l.blockNumber) / 10,
          phase: phase === undefined ? undefined : PHASE_NAME[phase],
          name: { untrusted: String(name ?? '') },
          symbol: { untrusted: String(symbol ?? '') },
        }
      }),
    }
  },
}

const tokenInput = z.object({ token: addressArg, network: networkArg })
const token: Tool<typeof tokenInput> = {
  name: 'pons_token',
  description:
    "One Pons token's state: phase, curve reserves, price, graduation progress, creator tax, snipe tax now, metadata.",
  kind: 'read',
  input: tokenInput,
  run: async (ctx, { token, network }) => {
    const { chain, network: n } = readClient(ctx, network)
    const lt = await launchOf(chain, n, token)
    const [name, symbol, supply, info] = await chain.multicall({
      allowFailure: true,
      contracts: [
        { address: token, abi: tokenAbi, functionName: 'name' },
        { address: token, abi: tokenAbi, functionName: 'symbol' },
        { address: token, abi: tokenAbi, functionName: 'totalSupply' },
        { address: token, abi: tokenAbi, functionName: 'getTokenInfo' },
      ],
    })
    const meta =
      info.status === 'success'
        ? { logo: info.result[1], description: info.result[2], socials: info.result[3] }
        : undefined
    const base = {
      network: n,
      data: dataLabel(n),
      token,
      name: { untrusted: name.status === 'success' ? name.result : '' },
      symbol: { untrusted: symbol.status === 'success' ? symbol.result : '' },
      metadata: meta && { untrusted: meta },
      phase: PHASE_NAME[lt.phase],
      curve: lt.curve,
      deployer: lt.deployer,
      creatorFeeRecipient: lt.creatorFeeRecipient,
      pair: isAddressEqual(lt.pairToken, ETH) ? 'ETH' : lt.pairToken,
      creatorTaxBps: lt.creatorTaxBps,
      graduatedAt: lt.sweptAt > 0n ? new Date(Number(lt.sweptAt) * 1000).toISOString() : undefined,
    }
    if (lt.phase !== PHASE.CURVE)
      return {
        ...base,
        trade:
          lt.phase === PHASE.POOL
            ? 'graduated: trades in its Uniswap v4 pool (swap tools)'
            : 'graduating: no trades until its pool opens',
      }
    const c = { address: lt.curve, abi: curveAbi } as const
    const block = await chain.getBlock()
    const [[rq, rt], phantom, feeBps, launchedAt, snipeSeconds, snipe] = await chain.multicall({
      allowFailure: false,
      blockNumber: block.number,
      contracts: [
        { ...c, functionName: 'getReserves' },
        { ...c, functionName: 'phantomQuote' },
        { ...c, functionName: 'feeBps' },
        { ...c, functionName: 'launchedAt' },
        { ...c, functionName: 'snipeTaxSeconds' },
        { ...c, functionName: 'currentSnipeTaxBps', args: [ctx.address ?? PLACEHOLDER] },
      ],
    })
    const priceEth = rt > 0n ? Number(rq) / Number(rt) : undefined
    return {
      ...base,
      launchedAt: new Date(Number(launchedAt) * 1000).toISOString(),
      ageSec: Number(block.timestamp - launchedAt),
      reserves: { eth: formatEther(rq), tokens: formatEther(rt), realEth: formatEther(rq - phantom) },
      priceEthPerToken: priceEth,
      fdvEth:
        priceEth !== undefined && supply.status === 'success' ? (priceEth * Number(supply.result)) / 1e18 : undefined,
      graduationProgressPct: Number(((rq - phantom) * 10_000n) / lt.graduationThreshold) / 100,
      graduationThresholdEth: formatEther(lt.graduationThreshold),
      curveFeeBps: Number(feeBps),
      snipeTax: {
        nowBps: Number(snipe),
        forWallet: ctx.address ?? 'a wallet without exemption',
        windowSec: Number(snipeSeconds),
      },
    }
  },
}

const tradeInput = z.object({
  token: addressArg,
  side: z.enum(['buy', 'sell']),
  amount: z.union([amountArg, z.literal('all')]).describe('buy: ETH to spend; sell: tokens to sell, or "all"'),
  slippageBps: z
    .number()
    .int()
    .min(10)
    .max(2500)
    .optional()
    .describe('max slippage in basis points; default from the config'),
})
const prepareInput = tradeInput.omit({ side: true })
type TradeArgs = z.infer<typeof tradeInput>

// Pons tokens and ETH both have 18 decimals.
async function resolve(ctx: Ctx, a: TradeArgs, account: Address) {
  const net = ctx.config.network
  const lt = await launchOf(ctx.chain, net, a.token)
  if (a.amount === 'all' && a.side === 'buy') throw new Error('"all" works for sells only')
  const amountIn = a.amount === 'all' ? await balanceOf(ctx.chain, a.token, account) : parseEther(a.amount)
  if (amountIn <= 0n)
    throw new Error(
      a.side === 'sell' && a.amount === 'all' ? 'the wallet holds none of this token' : 'the amount must be above 0',
    )
  const slippageBps = a.slippageBps ?? ctx.config.slippageBps
  // Graduated: the token's pool, through the swap module (mainnet only: testnet has no router).
  const pooled = lt.phase === PHASE.POOL
  if (pooled && net !== 'mainnet')
    throw new Error(`this token graduated, so it trades in its pool. ${SWAPS_ON_MAINNET}`)
  if (lt.phase === PHASE.SWEPT) throw new Error('the curve is graduating: no trades until its pool opens')
  const swapReq = {
    tokenIn: a.side === 'buy' ? ('ETH' as const) : a.token,
    tokenOut: a.side === 'buy' ? a.token : ('ETH' as const),
    amountIn,
    slippageBps,
  }
  return { pooled, amountIn, slippageBps, swapReq }
}

const quote: Tool<typeof tradeInput> = {
  name: 'pons_quote',
  description:
    'Quote a buy or sell of a Pons token on the configured network: on its curve, or in its pool once graduated. Read only.',
  kind: 'read',
  input: tradeInput,
  run: async (ctx, a) => {
    const account = ctx.address ?? PLACEHOLDER
    const r = await resolve(ctx, a, account)
    if (r.pooled) return { pool: true, ...(await quoteSwap(ctx, r.swapReq)) }
    const q = await quoteCurve(ctx.chain, ctx.config.network, {
      token: a.token,
      side: a.side,
      amountIn: r.amountIn,
      slippageBps: r.slippageBps,
      account,
    })
    return {
      network: ctx.config.network,
      venue: 'curve',
      side: a.side,
      amountIn: formatEther(q.amountIn),
      amountOut: formatEther(q.amountOut),
      minAmountOut: formatEther(q.minAmountOut),
      unitsIn: a.side === 'buy' ? 'ETH' : 'tokens',
      curveFeeEth: formatEther(q.fee),
      creatorTaxEth: formatEther(q.tax),
      notSpentEth: q.refund > 0n ? formatEther(q.refund) : undefined,
      graduatesTheCurve: q.graduates || undefined,
      priceImpactBps: q.priceImpactBps,
    }
  },
}

function tradeTool(side: 'buy' | 'sell'): Tool<typeof prepareInput> {
  return {
    name: `pons_prepare_${side}`,
    description:
      side === 'buy'
        ? 'Prepare a buy of a Pons token with ETH from the local wallet: on its curve, or in its pool once graduated.'
        : 'Prepare a sell of a Pons token for ETH from the local wallet ("all" sells the whole balance): on its curve, or in its pool once graduated.',
    kind: 'prepare',
    input: prepareInput,
    run: async (ctx, a): Promise<Preview> => {
      const account = requireAddress(ctx.address)
      const r = await resolve(ctx, { ...a, side }, account)
      if (r.pooled) return prepareSwap(ctx, r.swapReq)
      const net = ctx.config.network
      const q = await quoteCurve(ctx.chain, net, {
        token: a.token,
        side,
        amountIn: r.amountIn,
        slippageBps: r.slippageBps,
        account,
      })
      const { usd, note } = side === 'buy' ? await usdValue(ctx, 'ETH', q.amountIn) : await curveUsd(ctx, q.amountOut)
      const what =
        side === 'buy'
          ? `Buy token ${a.token} with ${formatEther(q.amountIn)} ETH on its Pons curve.`
          : `Sell ${fmt(q.amountIn, 18)} of token ${a.token} on its Pons curve.`
      const summary = [
        what,
        side === 'buy'
          ? `Expected ${formatEther(q.amountOut)} tokens; at least ${formatEther(q.minAmountOut)} or it reverts (slippage ${r.slippageBps / 100}%).`
          : `Expected ${formatEther(q.amountOut)} ETH; at least ${formatEther(q.minAmountOut)} ETH or it reverts (slippage ${r.slippageBps / 100}%).`,
        `Fees, already in the amounts: curve fee ${formatEther(q.fee)} ETH, creator tax ${formatEther(q.tax)} ETH. Noctenna adds no fee.`,
      ]
      if (q.refund > 0n)
        summary.push(
          `This buy reaches the graduation threshold: only ${formatEther(q.amountIn)} of the ${a.amount} ETH asked is spent; the rest never leaves the wallet.`,
        )
      if (q.approval)
        summary.push(`Approval: the curve ${q.curve} for exactly this amount of the token, used up by the sale.`)
      if (q.priceImpactBps >= 500) summary.push(`Price impact: ${(q.priceImpactBps / 100).toFixed(1)}%.`)
      summary.push(`Counts $${usd.toFixed(2)} against the daily limit${note ? ` (${note})` : ''}.`)
      const steps = [...(q.approval ? [q.approval] : []), q.trade].map((s) => ({ type: 'tx' as const, ...s }))
      return {
        summary,
        usd,
        steps,
        details: { token: a.token, curve: q.curve, quotedAtBlock: q.block },
        // Re-quote and refuse when the venue changed or the fresh output fell below the signed minimum.
        recheck: async () => {
          const fresh = await quoteCurve(ctx.chain, net, {
            token: a.token,
            side,
            amountIn: q.amountIn,
            slippageBps: r.slippageBps,
            account,
          })
          if (!isAddressEqual(fresh.curve, q.curve))
            throw new Error('the token changed venue since the preview: prepare it again')
          if (fresh.amountOut < q.minAmountOut)
            throw new Error('the price moved past the slippage since the preview: prepare it again')
        },
      }
    },
  }
}

// A sale's USD value is what it pays out (the token itself may have no other price).
async function curveUsd(ctx: Ctx, ethOut: bigint) {
  const v = await usdValue(ctx, 'ETH', ethOut)
  return { usd: v.usd, note: [v.note, 'valued at the ETH it pays out'].filter(Boolean).join('; ') }
}

export const pons: Module = { name: 'pons', tools: [launches, token, quote, tradeTool('buy'), tradeTool('sell')] }
