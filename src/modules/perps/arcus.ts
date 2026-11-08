// Arcus REST: market reads, the order-signing payloads from https://docs.arcus.xyz/api-reference/authentication,
// and the local Ed25519 API key. Orders are signed with that key at execute time, because the signed timestamp must
// be within 30 s of Arcus's clock.
import { ed25519 } from '@noble/curves/ed25519.js'
import { bytesToHex, hexToBytes } from '@noble/curves/utils.js'
import { formatUnits, parseUnits, type Address } from 'viem'
import { secretGet } from '../../core/wallet.js'
import type { Ctx, Network } from '../../core/types.js'
import { json } from './api.js'

export const ARCUS: Record<Network, string> = {
  mainnet: 'https://api.arcus.xyz/v1',
  testnet: 'https://api.testnet.arcus.xyz/v1',
}
// The EIP-712 domain chain id for createApiKey is the rootchain: Robinhood Chain mainnet or testnet.
export const ARCUS_CHAIN_ID: Record<Network, number> = { mainnet: 4663, testnet: 46630 }

export interface ArcusMarket {
  marketId: number
  marketDisplayName: string
  baseAsset: string
  status: string
  category?: string
  tickSize: string
  stepSize: string
  tickTiers?: { upToPrice?: string; tick: string }[]
  minOrderNotional?: string
  maxOrderSize?: string
  oraclePrice: string
  markPrice: string
  fundingRate: string
  openInterest: string
  volume24hNotional?: string
  initialMarginFraction: string
  offHoursInitialMarginFraction?: string
  isOutsideRth?: boolean
  currentSettlementPrice?: string | null
  upperTradingBound?: string | null
  lowerTradingBound?: string | null
  nextUpperTradingBound?: string | null
  nextLowerTradingBound?: string | null
  maintenanceMarginFraction?: string
  effectiveTakerFeePpm?: number
}

export const arcusMarkets = async (ctx: Ctx, network: Network) =>
  (await json<{ markets: ArcusMarket[] }>(ctx, `${ARCUS[network]}/markets`)).markets

export function findMarket<M extends { marketId: number; marketDisplayName: string; baseAsset: string }>(
  markets: M[],
  q: string | number,
): M {
  const s = String(q).trim().toUpperCase()
  const m = markets.find(
    (x) => String(x.marketId) === s || x.marketDisplayName.toUpperCase() === s || x.baseAsset.toUpperCase() === s,
  )
  if (!m) throw new Error(`no Arcus market "${q}"; list them with perps_markets`)
  return m
}

/** Funding is hourly on Arcus. */
export const arcusPctYear = (hourly: string | number) => Number(hourly) * 24 * 365 * 100

/** Initial margin fraction in force now: stock perps outside regular hours need more. */
export const liveImf = (m: ArcusMarket) =>
  Number(m.isOutsideRth && m.offHoursInitialMarginFraction ? m.offHoursInitialMarginFraction : m.initialMarginFraction)

// ---------------- exact decimal ↔ engine integers ----------------
const DECIMAL = /^\d+(\.\d+)?$/
const places = (x: string) => x.split('.')[1]?.length ?? 0

/** value ÷ unit, exactly; Arcus rejects anything off the grid. */
export function toUnits(value: string, unit: string): bigint {
  if (!DECIMAL.test(value) || !DECIMAL.test(unit)) throw new Error(`"${value}" is not a plain decimal number`)
  const d = Math.max(places(value), places(unit))
  const v = parseUnits(value, d)
  const t = parseUnits(unit, d)
  if (t === 0n || v % t !== 0n) throw new Error(`${value} is not a multiple of ${unit}`)
  return v / t
}

/** The tick that applies at a price: coarser bands only accept multiples of their own tick. */
export function tickAt(m: ArcusMarket, price: number): string {
  return m.tickTiers?.find((t) => t.upToPrice === undefined || price < Number(t.upToPrice))?.tick ?? m.tickSize
}

/** ref × (1 ± bps), snapped to the tick away from the trader (up for a buy, down for a sell): the worst price accepted. */
export function boundPrice(m: ArcusMarket, ref: string, bps: number, up: boolean): string {
  const tick = tickAt(m, Number(ref))
  const d = Math.max(places(ref), places(tick)) + 4
  const r = parseUnits(ref, d)
  const t = parseUnits(tick, d)
  const raw = (r * BigInt(10_000 + (up ? bps : -bps))) / 10_000n
  const ticks = up ? (raw + t - 1n) / t : raw / t
  return formatUnits(ticks * t, d)
}

// ---------------- signing ----------------
export type Side = 0 | 1 // buy, sell
export type Tif = 0 | 1 | 2 | 3 // GTT, FOK, IOC, ALO
export interface PlaceFields {
  ad: Address
  ai: number
  c?: string
  ct: bigint
  g: bigint
  m: number
  op: 1 | 4 // 4 = an untriggered TP/SL leg, so its signature cannot be replayed as a plain order
  p: bigint
  q: bigint
  r: 0 | 1
  s: Side
  t: Tif
}

// Keys in Arcus's fixed alphabetical order, no whitespace; only the address is lowercased. Built by hand because
// ct is a nanosecond time beyond Number's exact range.
export const placePayload = (o: PlaceFields) =>
  `{"ad":"${o.ad.toLowerCase()}","ai":${o.ai},${o.c ? `"c":"${o.c}",` : ''}"ct":${o.ct},"g":${o.g},"m":${o.m},"op":${o.op},"p":${o.p},"q":${o.q},"r":${o.r},"s":${o.s},"t":${o.t},"v":1}`

export const cancelPayload = (o: { ad: Address; ai: number; c?: string; ct: bigint; id?: string; m: number }) =>
  `{"ad":"${o.ad.toLowerCase()}","ai":${o.ai},${o.c ? `"c":"${o.c}",` : ''}"ct":${o.ct},${o.id ? `"id":"${o.id}",` : ''}"m":${o.m},"op":2,"v":1}`

/** Scheme 2 (setLeverage and friends): timestamp + action + body with sorted keys. */
export const canonical = (body: Record<string, unknown>) =>
  JSON.stringify(Object.fromEntries(Object.entries(body).sort(([a], [b]) => (a < b ? -1 : 1))))

export const sign = (message: string, secretKeyHex: string) =>
  bytesToHex(ed25519.sign(new TextEncoder().encode(message), hexToBytes(secretKeyHex)))

/** JSON with bigints written as bare integers, which Arcus needs for nanosecond timestamps. */
export const bigJson = (v: unknown) =>
  JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? `__big__${x}` : x)).replace(/"__big__(\d+)"/g, '$1')

export const nowNs = () => BigInt(Date.now()) * 1_000_000n
/** goodTilTime must be at least a month ahead on every order, even IOC, where it only guards against replay. */
export const goodTilUs = () => BigInt(Date.now() + 40 * 86_400_000) * 1000n

/** createApiKey's EIP-712 message, in the nonce + accountIndex form Arcus recommends for replay protection. */
export const apiKeyTypedData = (
  network: Network,
  publicKey: string,
  validUntil: number,
  nonce: string,
  accountIndex: number,
) =>
  ({
    domain: { name: 'Arcus API Key', version: '1', chainId: ARCUS_CHAIN_ID[network] },
    types: {
      CreateApiKey: [
        { name: 'apiWalletName', type: 'string' },
        { name: 'apiWalletPublicKey', type: 'string' },
        { name: 'validUntil', type: 'uint256' },
        { name: 'nonce', type: 'string' },
        { name: 'accountIndex', type: 'uint8' },
      ],
    },
    primaryType: 'CreateApiKey',
    message: {
      apiWalletName: 'Noctenna',
      apiWalletPublicKey: publicKey,
      validUntil: BigInt(validUntil),
      nonce,
      accountIndex,
    },
  }) as const

// ---------------- the stored key ----------------
export interface ArcusKey {
  secretKey: string
  publicKey: string
  address: Address
  accountIndex: number
  validUntil: number
}

// Testnet and mainnet keys are separate registrations, so they are stored apart.
export const keyName = (n: Network) => (n === 'mainnet' ? 'arcus-ed25519' : 'arcus-ed25519-testnet')

export async function loadKey(ctx: Ctx): Promise<ArcusKey> {
  if (!ctx.address) throw new Error('no wallet yet: run `noctenna wallet create` in a terminal')
  const raw = await secretGet(keyName(ctx.config.network))
  const k = raw ? (JSON.parse(raw) as ArcusKey) : null
  if (!k || k.address.toLowerCase() !== ctx.address.toLowerCase())
    throw new Error(
      `no Arcus ${ctx.config.network} API key for this wallet: register one with prepare_arcus_register_key`,
    )
  // Five minutes of slack: a preview may wait two before it runs.
  if (k.validUntil < Date.now() + 5 * 60_000)
    throw new Error('the Arcus API key has expired: register a new one with prepare_arcus_register_key')
  return k
}

/** A signed Arcus POST. Never retried by ctx.http on 5xx, so an order cannot be placed twice. */
export async function signedPost(ctx: Ctx, key: ArcusKey, path: string, body: string, ts: bigint, signature: string) {
  const res = await ctx.http(`${ARCUS[ctx.config.network]}/${path}?address=${key.address}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': key.publicKey,
      'x-timestamp': ts.toString(),
      'x-signature': signature,
    },
    body,
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`Arcus refused ${path} (HTTP ${res.status}): ${text.slice(0, 300)}`)
  return text
}
