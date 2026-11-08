// Perps on Arcus (read and trade) and Lighter on Robinhood Chain (read). Market data comes from mainnet in either
// mode, labelled; account reads and every write go to the configured network (Arcus testnet until the launch).
import { ed25519 } from '@noble/curves/ed25519.js'
import { bytesToHex } from '@noble/curves/utils.js'
import { encodeFunctionData, erc20Abi, isAddress, parseAbi, parseSignature, parseUnits, type Address } from 'viem'
import { z } from 'zod'
import type { Ctx, Module, Preview } from '../../core/types.js'
import { secretSet } from '../../core/wallet.js'
import { clean, json, plain, round, tool, u } from './api.js'
import {
  ARCUS,
  apiKeyTypedData,
  arcusMarkets,
  arcusPctYear,
  bigJson,
  boundPrice,
  canonical,
  cancelPayload,
  findMarket,
  goodTilUs,
  keyName,
  liveImf,
  loadKey,
  nowNs,
  placePayload,
  sign,
  signedPost,
  tickAt,
  toUnits,
  type ArcusMarket,
} from './arcus.js'
import { findLighterMarket, LIGHTER, lighterAccounts, lighterMarkets, lighterPctYear } from './lighter.js'
import { reopenCheck } from './reopen.js'

const DAY = 86_400_000
const venue = z.enum(['arcus', 'lighter'])
const marketArg = z
  .union([z.string().min(1).max(40), z.number().int().nonnegative()])
  .describe('market id, name like BTC-USD, or base asset like BTC')
const decimal = z.string().regex(/^\d+(\.\d+)?$/, 'a plain decimal number such as "0.01"')

const dataLabel = (ctx: Ctx) =>
  ctx.config.network === 'testnet'
    ? 'mainnet data (you are on testnet; testnet orders use Arcus testnet prices)'
    : 'mainnet'
const nameOf = (m: ArcusMarket) => plain(m.marketDisplayName) ?? `market #${m.marketId}`
const own = (ctx: Ctx, a?: string): Address => {
  const x = a ?? ctx.address
  if (!x || !isAddress(x))
    throw new Error(
      a ? `"${a}" is not an address` : 'no wallet yet: run `noctenna wallet create` in a terminal, or pass an address',
    )
  return x
}

// The venue terms ride on the first perps write of each server session, so the user reads them before any approval.
let termsShown = false
const terms = () => {
  if (termsShown) return []
  termsShown = true
  return [
    'Arcus and Lighter are not available in the US, Canada, the UK or sanctioned regions. Approve only if you may use them.',
  ]
}

function closedNote(m: ArcusMarket): string[] {
  if (!m.isOutsideRth) return []
  return [
    `${nameOf(m)}: the underlying stock market is closed. Funding is a fixed ${round(arcusPctYear(m.fundingRate))}%/yr until it reopens, initial margin is ${round(liveImf(m) * 100)}% instead of ${round(Number(m.initialMarginFraction) * 100)}%, and trades stay inside a price band of $${m.lowerTradingBound} to $${m.upperTradingBound} around the last settlement $${m.currentSettlementPrice}.`,
  ]
}

const markets = tool({
  name: 'perps_markets',
  description:
    'Every perps market on Arcus or Lighter (Robinhood Chain): mark price, funding (raw and %/yr: Arcus hourly ×24×365, Lighter per 8 h ×3×365), open interest and 24 h volume in USD, max leverage, and for Arcus stock perps whether the underlying is closed (fixed funding, price band).',
  kind: 'read',
  input: z.object({ venue }),
  async run(ctx, { venue }) {
    if (venue === 'arcus') {
      const ms = await arcusMarkets(ctx, 'mainnet')
      return {
        venue,
        data: dataLabel(ctx),
        markets: ms.map((m) => ({
          market: u(m.marketDisplayName),
          marketId: m.marketId,
          status: u(m.status),
          mark: Number(m.markPrice),
          fundingHourly: Number(m.fundingRate),
          fundingPctYr: round(arcusPctYear(m.fundingRate)),
          openInterestUsd: Math.round(Number(m.openInterest) * Number(m.markPrice)),
          volume24hUsd: Math.round(Number(m.volume24hNotional ?? 0)),
          maxLeverageNow: round(1 / liveImf(m), 1),
          ...(m.isOutsideRth
            ? {
                underlyingClosed: true,
                fixedFunding: true,
                settlement: Number(m.currentSettlementPrice),
                band: [Number(m.lowerTradingBound), Number(m.upperTradingBound)],
              }
            : {}),
        })),
      }
    }
    const ms = await lighterMarkets(ctx)
    return {
      venue,
      data: dataLabel(ctx),
      markets: ms.map((m) => ({
        market: u(m.symbol),
        marketId: m.market_id,
        mark: Number(m.mark_price),
        funding8h: m.funding8h,
        fundingPctYr: m.funding8h === null ? null : round(lighterPctYear(m.funding8h)),
        openInterestUsd: Math.round(Number(m.open_interest) * Number(m.mark_price)),
        volume24hUsd: Math.round(Number(m.daily_quote_token_volume)),
        maxLeverage: round(10_000 / m.min_initial_margin_fraction, 1),
      })),
    }
  },
})

type Level = { price: string; remaining_base_amount: string }
const book = tool({
  name: 'perps_order_book',
  description:
    'The order book of one perps market on Arcus or Lighter: best bids and asks as [price, size in base units].',
  kind: 'read',
  input: z.object({ venue, market: marketArg, depth: z.number().int().min(1).max(50).default(10) }),
  async run(ctx, { venue, market, depth }) {
    if (venue === 'arcus') {
      const m = findMarket(await arcusMarkets(ctx, 'mainnet'), market)
      const b = await json<{ bids: [string, string][]; asks: [string, string][] }>(
        ctx,
        `${ARCUS.mainnet}/l2OrderBook/${encodeURIComponent(m.marketDisplayName)}?nLevels=${depth}`,
      )
      const side = (l: [string, string][]) => l.map(([p, s]) => [Number(p), Number(s)])
      return {
        venue,
        data: dataLabel(ctx),
        market: u(m.marketDisplayName),
        marketId: m.marketId,
        bids: side(b.bids),
        asks: side(b.asks),
      }
    }
    const m = findLighterMarket(await lighterMarkets(ctx), market)
    const b = await json<{ bids: Level[]; asks: Level[] }>(
      ctx,
      `${LIGHTER.mainnet}/orderBookOrders?market_id=${m.market_id}&limit=${depth}`,
    )
    const side = (l: Level[]) => l.map((o) => [Number(o.price), Number(o.remaining_base_amount)])
    return {
      venue,
      data: dataLabel(ctx),
      market: u(m.symbol),
      marketId: m.market_id,
      bids: side(b.bids),
      asks: side(b.asks),
    }
  },
})

const account = tool({
  name: 'perps_account',
  description:
    'Perps positions for a wallet (default: this wallet) on the configured network: Arcus positions and balances, optionally open orders and recent fills; Lighter positions per sub-account.',
  kind: 'read',
  input: z.object({
    venue,
    address: z.string().optional(),
    orders: z.boolean().default(true),
    fills: z.boolean().default(false),
  }),
  async run(ctx, a) {
    const address = own(ctx, a.address)
    const network = ctx.config.network
    if (a.venue === 'lighter') {
      try {
        const r = await lighterAccounts(ctx, address)
        return {
          venue: 'lighter',
          network,
          accounts: clean(
            r.accounts.map((x) => ({ ...x, positions: x.positions.filter((p) => Number(p.position) !== 0) })),
          ),
        }
      } catch (e) {
        if (/account not found/.test(String(e)))
          return {
            venue: 'lighter',
            network,
            accounts: [],
            note: 'no Lighter account for this address yet (the first deposit creates one)',
          }
        throw e
      }
    }
    const base = `${ARCUS[network]}`
    const q = `address=${address}`
    const [positions, acct, orders, fills] = await Promise.all([
      json(ctx, `${base}/positions?${q}`),
      json(ctx, `${base}/account?${q}`).catch((e) => (/no activity yet/.test(String(e)) ? null : Promise.reject(e))),
      a.orders ? json(ctx, `${base}/openOrders?${q}&limit=50`) : undefined,
      a.fills ? json(ctx, `${base}/fills?${q}&limit=20`) : undefined,
    ])
    return {
      venue: 'arcus',
      network,
      positions: clean(positions),
      account: acct === null ? 'no deposit yet on this Arcus account' : clean(acct),
      openOrders: clean(orders),
      fills: clean(fills),
    }
  },
})

// ---------------- writes ----------------
const registerKey = tool({
  name: 'prepare_arcus_register_key',
  description:
    'Creates an Arcus API key on this computer and registers it for this wallet on the configured network (one EIP-712 signature, no gas). Needed once before any Arcus order; keys expire after 1-180 days.',
  kind: 'prepare',
  input: z.object({
    days: z.number().int().min(1).max(180).default(30),
    accountIndex: z.number().int().min(0).max(9).default(0),
  }),
  async run(ctx, { days, accountIndex }): Promise<Preview> {
    const address = own(ctx)
    const network = ctx.config.network
    const secretKey = ed25519.utils.randomSecretKey()
    const publicKey = bytesToHex(ed25519.getPublicKey(secretKey))
    // Arcus accepts [now+1d, now+180d] at execute time; a one-day key gets ten minutes of slack for the preview wait.
    const validUntil = Date.now() + days * DAY + (days === 1 ? 600_000 : 0)
    const nonce = nowNs().toString()
    const until = new Date(validUntil).toISOString().slice(0, 16).replace('T', ' ')
    return {
      summary: [
        ...terms(),
        `Register a new Arcus ${network} API key for ${address}, sub-account ${accountIndex}, valid until ${until} UTC.`,
        "Your wallet signs one EIP-712 message: no transaction and no gas. Arcus stores only the public half; the private half stays in this computer's keychain and replaces any Arcus key Noctenna kept before.",
      ],
      usd: 0,
      details: {
        venue: 'arcus',
        network,
        apiKey: publicKey,
        accountIndex,
        validUntil: new Date(validUntil).toISOString(),
      },
      steps: [
        {
          type: 'typedData',
          label: 'Sign the Arcus API key registration',
          typedData: apiKeyTypedData(network, publicKey, validUntil, nonce, accountIndex),
          then: async (signature) => {
            const sig = parseSignature(signature)
            const v = sig.v ?? BigInt(sig.yParity + 27)
            const body = {
              address,
              publicKey,
              apiWalletName: 'Noctenna',
              validUntil,
              nonce,
              accountIndex,
              signature: { r: sig.r, s: sig.s, v: `0x${v.toString(16)}` },
            }
            await json(ctx, `${ARCUS[network]}/createApiKey`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(body),
            })
            await secretSet(
              keyName(network),
              JSON.stringify({ secretKey: bytesToHex(secretKey), publicKey, address, accountIndex, validUntil }),
            )
            // A new key takes a moment before Arcus accepts it.
            let live = false
            for (let i = 0; i < 15; i++) {
              const keys = await json<{ apiKeys: { apiKey: string }[] }>(
                ctx,
                `${ARCUS[network]}/apiKeys?address=${address}`,
              ).catch(() => ({ apiKeys: [] }))
              if ((live = keys.apiKeys.some((k) => k.apiKey === publicKey))) break
              await new Promise((r) => setTimeout(r, 1000))
            }
            return { apiKey: publicKey, accountIndex, validUntil: new Date(validUntil).toISOString(), live }
          },
        },
      ],
    }
  },
})

const order = tool({
  name: 'prepare_arcus_order',
  description:
    'Places a market or limit order on an Arcus perps market for this wallet (configured network), with optional take-profit and stop-loss legs. Needs a registered key (prepare_arcus_register_key). Market orders carry a worst price from the slippage setting.',
  kind: 'prepare',
  input: z.object({
    market: marketArg,
    side: z.enum(['buy', 'sell']),
    size: decimal.describe('size in the base asset, a multiple of the market step size'),
    type: z.enum(['market', 'limit']).default('market'),
    price: decimal.optional().describe('limit price in USD; required for a limit order'),
    reduceOnly: z.boolean().default(false),
    takeProfit: decimal.optional().describe('trigger price that closes the position at a profit'),
    stopLoss: decimal.optional().describe('trigger price that closes the position at a loss'),
  }),
  async run(ctx, a): Promise<Preview> {
    const key = await loadKey(ctx)
    const network = ctx.config.network
    const m = findMarket(await arcusMarkets(ctx, network), a.market)
    const name = nameOf(m)
    if (m.status !== 'ONLINE') throw new Error(`${name} is not open for trading on Arcus ${network}`)
    const buy = a.side === 'buy'
    const market = a.type === 'market'
    // Arcus rejects a market order whose bound is more than 10% from mark.
    const bps = Math.min(ctx.config.slippageBps, 900)
    if (!market && !a.price) throw new Error('a limit order needs a price')
    const price = market ? boundPrice(m, m.markPrice, bps, buy) : a.price!
    const q = toUnits(a.size, m.stepSize)
    // The signed integer always divides by the top-level tick; a coarser price band only limits which prices pass.
    const p = toUnits(price, m.tickSize)
    toUnits(price, tickAt(m, Number(price)))
    const notional = Number(a.size) * Number(price)
    if (!a.reduceOnly && notional < Number(m.minOrderNotional ?? 5))
      throw new Error(
        `Arcus orders need at least $${m.minOrderNotional ?? 5} notional; this one is $${round(notional)}`,
      )
    if (m.maxOrderSize && Number(a.size) > Number(m.maxOrderSize))
      throw new Error(`the largest order on ${name} is ${m.maxOrderSize}`)

    const mark = Number(m.markPrice)
    const legs: { kind: 'TAKE_PROFIT' | 'STOP_LOSS'; stop: string; price: string }[] = []
    for (const [kind, stop] of [
      ['TAKE_PROFIT', a.takeProfit],
      ['STOP_LOSS', a.stopLoss],
    ] as const) {
      if (!stop) continue
      const wantAbove = (kind === 'TAKE_PROFIT') === buy
      if (Number(stop) > mark !== wantAbove)
        throw new Error(
          `for a ${a.side}, the ${kind === 'TAKE_PROFIT' ? 'take-profit' : 'stop-loss'} must be ${wantAbove ? 'above' : 'below'} the mark $${mark}`,
        )
      toUnits(stop, tickAt(m, Number(stop)))
      // A closing leg sells after a buy, so its worst price sits below the trigger, and the other way round.
      legs.push({ kind, stop, price: boundPrice(m, stop, bps, !buy) })
    }

    const leverage = await json<{ leverages: { marketId: number; leverage: number }[] }>(
      ctx,
      `${ARCUS[network]}/leverages?address=${key.address}&accountIndex=${key.accountIndex}&market=${m.marketId}`,
    )
      .then((r) => r.leverages.find((x) => x.marketId === m.marketId)?.leverage)
      .catch(() => undefined)
    // Unknown leverage counts the whole notional against the daily limit rather than too little.
    const imf = Math.max(liveImf(m), leverage ? 1 / leverage : 1)
    const margin = a.reduceOnly ? 0 : Math.ceil(notional * imf * 100) / 100
    const fee = (notional * (m.effectiveTakerFeePpm ?? 450)) / 1e6

    const run = async () => {
      const ts = nowNs()
      const g = goodTilUs()
      const common = {
        address: key.address,
        accountIndex: key.accountIndex,
        marketId: m.marketId,
        quantity: a.size,
        goodTilTime: g.toString(),
        timestamp: ts,
      }
      const fields = { ad: key.address, ai: key.accountIndex, ct: ts, g: g * 1000n, m: m.marketId, q }
      const entry = {
        ...common,
        orderSide: buy ? 'BUY' : 'SELL',
        orderType: market ? 'MARKET' : 'LIMIT',
        price,
        timeInForce: market ? 'IOC' : 'GTT',
        reduceOnly: a.reduceOnly,
      }
      const entrySig = sign(
        placePayload({ ...fields, op: 1, p, r: a.reduceOnly ? 1 : 0, s: buy ? 0 : 1, t: market ? 2 : 0 }),
        key.secretKey,
      )
      if (!legs.length) return clean(JSON.parse(await signedPost(ctx, key, 'placeOrder', bigJson(entry), ts, entrySig)))
      const children = legs.map((l) => ({
        ...common,
        orderSide: buy ? 'SELL' : 'BUY',
        orderType: 'MARKET',
        price: l.price,
        timeInForce: 'IOC',
        tpslType: l.kind,
        stopPrice: l.stop,
        reduceOnly: true,
        signature: sign(
          placePayload({ ...fields, op: 4, p: toUnits(l.price, m.tickSize), r: 1, s: buy ? 1 : 0, t: 2 }),
          key.secretKey,
        ),
      }))
      const body = bigJson({ grouping: 'entryTpsl', orders: [{ ...entry, signature: entrySig }, ...children] })
      return clean(JSON.parse(await signedPost(ctx, key, 'batchPlaceOrders', body, ts, entrySig)))
    }

    return {
      summary: [
        ...terms(),
        `Arcus ${network}: ${a.side.toUpperCase()} ${a.size} ${name} ${market ? `at market, worst price $${price} (${bps / 100}% from mark $${m.markPrice})` : `limit at $${price}, resting until filled or cancelled`}${a.reduceOnly ? ', reduce-only' : ''}.`,
        `Notional up to $${round(notional)}. Initial margin about $${margin}${leverage ? ` at ${round(1 / imf, 1)}x` : ' (leverage unknown, counted at 1x)'}; fee up to $${round(fee, 4)}.`,
        ...legs.map(
          (l) =>
            `${l.kind === 'TAKE_PROFIT' ? 'Take profit' : 'Stop loss'}: when the mark reaches $${l.stop}, a reduce-only market order closes ${a.size}, worst price $${l.price}.`,
        ),
        ...closedNote(m),
        'Arcus matches the order off-chain: it fills, rests or is rejected there; check perps_account afterwards.',
      ],
      usd: margin,
      details: {
        venue: 'arcus',
        network,
        market: u(m.marketDisplayName),
        marketId: m.marketId,
        side: a.side,
        size: a.size,
        price,
        notionalUsd: round(notional),
        marginUsd: margin,
        legs,
      },
      steps: [{ type: 'offchain', label: `Place the ${name} order on Arcus`, run }],
      recheck: async () => {
        await loadKey(ctx)
        const now = findMarket(await arcusMarkets(ctx, network), m.marketId)
        if (now.status !== 'ONLINE') throw new Error(`${name} stopped trading`)
        if (Boolean(now.isOutsideRth) !== Boolean(m.isOutsideRth))
          throw new Error(`${name}'s trading session changed, and with it margin and funding: prepare the order again`)
      },
    }
  },
})

const cancel = tool({
  name: 'prepare_arcus_cancel',
  description: 'Cancels one open Arcus order of this wallet by its orderId (from perps_account) or clientId.',
  kind: 'prepare',
  input: z.object({
    market: marketArg,
    orderId: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,64}$/)
      .optional(),
    clientId: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,36}$/)
      .optional(),
  }),
  async run(ctx, a): Promise<Preview> {
    if (!a.orderId === !a.clientId) throw new Error('give exactly one of orderId or clientId')
    const key = await loadKey(ctx)
    const m = findMarket(await arcusMarkets(ctx, ctx.config.network), a.market)
    const target = a.orderId ? { kind: 'orderId', orderId: a.orderId } : { kind: 'clientId', clientId: a.clientId }
    const run = async () => {
      const ts = nowNs()
      const sig = sign(
        cancelPayload({
          ad: key.address,
          ai: key.accountIndex,
          ct: ts,
          m: m.marketId,
          ...(a.orderId ? { id: a.orderId } : { c: a.clientId }),
        }),
        key.secretKey,
      )
      const body = {
        address: key.address,
        accountIndex: key.accountIndex,
        marketId: m.marketId,
        ...target,
        timestamp: ts,
      }
      return clean(JSON.parse(await signedPost(ctx, key, 'cancelOrder', bigJson(body), ts, sig)))
    }
    return {
      summary: [
        ...terms(),
        `Arcus ${ctx.config.network}: cancel order ${a.orderId ?? `with client id ${a.clientId}`} on ${nameOf(m)}. If it filled first, nothing changes.`,
      ],
      usd: 0,
      details: {
        venue: 'arcus',
        network: ctx.config.network,
        market: u(m.marketDisplayName),
        marketId: m.marketId,
        ...target,
      },
      steps: [{ type: 'offchain', label: 'Cancel the Arcus order', run }],
      recheck: async () => void (await loadKey(ctx)),
    }
  },
})

const leverage = tool({
  name: 'prepare_arcus_leverage',
  description:
    "Sets this wallet's leverage (and optionally cross or isolated margin) for one Arcus market on the configured network.",
  kind: 'prepare',
  input: z.object({
    market: marketArg,
    leverage: z.number().int().min(1).max(100),
    isolated: z.boolean().optional().describe('true: isolated margin, false: cross; omit to keep'),
  }),
  async run(ctx, a): Promise<Preview> {
    const key = await loadKey(ctx)
    const m = findMarket(await arcusMarkets(ctx, ctx.config.network), a.market)
    const max = Math.floor(1 / Number(m.initialMarginFraction) + 1e-9)
    if (a.leverage > max) throw new Error(`${nameOf(m)} allows at most ${max}x`)
    const run = async () => {
      const ts = nowNs()
      const body = canonical({
        accountIndex: key.accountIndex,
        address: key.address,
        leverage: a.leverage,
        marketId: m.marketId,
        ...(a.isolated === undefined ? {} : { isolated: a.isolated }),
      })
      return clean(
        JSON.parse(await signedPost(ctx, key, 'setLeverage', body, ts, sign(`${ts}setLeverage${body}`, key.secretKey))),
      )
    }
    const mode = a.isolated === undefined ? '' : a.isolated ? ', isolated margin' : ', cross margin'
    return {
      summary: [
        ...terms(),
        `Arcus ${ctx.config.network}: set ${nameOf(m)} leverage to ${a.leverage}x${mode} for sub-account ${key.accountIndex}.`,
        'Lowering leverage with an open position fails if your margin would not cover it. Outside stock-market hours the higher off-hours margin still applies.',
      ],
      usd: 0,
      details: {
        venue: 'arcus',
        network: ctx.config.network,
        market: u(m.marketDisplayName),
        marketId: m.marketId,
        leverage: a.leverage,
        isolated: a.isolated,
      },
      steps: [{ type: 'offchain', label: 'Set Arcus leverage', run }],
      recheck: async () => void (await loadKey(ctx)),
    }
  },
})

// Arcus testnet collateral: its USDG has an open mint, and the deposit proxy credits the Arcus account it is told.
// From https://docs.arcus.xyz/guides/fund-testnet-account (checked on chain 46630, 8 Nov 2026); Arcus moves these on
// a testnet reset, and a deposit to a retired proxy never credits.
const TESTNET_USDG: Address = '0x293b337712d4312776a3a2d292f44410e7873bad'
const TESTNET_DEPOSIT_PROXY: Address = '0xb872366eef371d4afb7c6d4d2abd53c17292a34d'
const proxyAbi = parseAbi([
  'function mint(address to, uint256 amount)',
  'function initiateDeposit(address owner, uint16 accountIndex, address token, uint256 amount)',
])

const testnetDeposit = tool({
  name: 'prepare_arcus_testnet_deposit',
  description:
    'Testnet only: mints test USDG (no value) and deposits it as Arcus testnet collateral for this wallet, so Arcus testnet orders can be practised. Needs a little test ETH for gas.',
  kind: 'prepare',
  input: z.object({
    amount: decimal.default('1000').describe('test USDG, at most 100000'),
    accountIndex: z.number().int().min(0).max(9).default(0),
  }),
  async run(ctx, a): Promise<Preview> {
    if (ctx.config.network !== 'testnet')
      throw new Error('Arcus test collateral exists only on testnet; on mainnet, deposit through the Arcus app')
    const owner = own(ctx)
    const amount = parseUnits(a.amount, 6)
    if (amount === 0n || amount > parseUnits('100000', 6)) throw new Error('pick between 0 and 100000 test USDG')
    return {
      summary: [
        ...terms(),
        `Mint ${a.amount} test USDG (testnet only, no value) to ${owner}, approve exactly ${a.amount} to Arcus's testnet deposit proxy ${TESTNET_DEPOSIT_PROXY}, and deposit it into Arcus testnet sub-account ${a.accountIndex}.`,
        'Three testnet transactions; gas is test ETH. Arcus credits the deposit within about a minute; check perps_account.',
      ],
      usd: 0,
      details: { venue: 'arcus', network: 'testnet', token: TESTNET_USDG, proxy: TESTNET_DEPOSIT_PROXY },
      steps: [
        {
          type: 'tx',
          to: TESTNET_USDG,
          value: 0n,
          data: encodeFunctionData({ abi: proxyAbi, functionName: 'mint', args: [owner, amount] }),
          label: `Mint ${a.amount} test USDG`,
        },
        {
          type: 'tx',
          to: TESTNET_USDG,
          value: 0n,
          data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [TESTNET_DEPOSIT_PROXY, amount] }),
          label: `Approve exactly ${a.amount} test USDG to the Arcus deposit proxy`,
        },
        {
          type: 'tx',
          to: TESTNET_DEPOSIT_PROXY,
          value: 0n,
          data: encodeFunctionData({
            abi: proxyAbi,
            functionName: 'initiateDeposit',
            args: [owner, a.accountIndex, TESTNET_USDG, amount],
          }),
          label: 'Deposit into Arcus testnet',
        },
      ],
    }
  },
})

export const perps: Module = {
  name: 'perps',
  tools: [markets, book, account, reopenCheck, registerKey, order, cancel, leverage, testnetDeposit],
}
