// Lighter on Robinhood Chain, read-only. Orders there are signed with Lighter's own scheme (Poseidon2/Schnorr), whose
// only official JavaScript signer is a Go-compiled WASM blob without a pinned npm release, and registering a key needs
// an EIP-191 wallet signature that the core's step types do not carry. See ARCHITECTURE.md.
import type { Address } from 'viem'
import type { Ctx, Network } from '../../core/types.js'
import { json } from './api.js'

export const LIGHTER: Record<Network, string> = {
  mainnet: 'https://api.rh.lighter.xyz/api/v1',
  testnet: 'https://api.rh-testnet.lighter.xyz/api/v1',
}

export interface LighterMarket {
  symbol: string
  market_id: number
  market_type: string
  status: string
  mark_price: string
  open_interest: number | string
  daily_quote_token_volume: number | string
  min_initial_margin_fraction: number
  price_decimals: number
  size_decimals: number
}

/** Funding on Lighter is quoted per 8 hours. */
export const lighterPctYear = (per8h: string | number) => Number(per8h) * 3 * 365 * 100

// Market data is mainnet's in either mode: the testnet book is thin and says little.
export async function lighterMarkets(ctx: Ctx) {
  const [d, f] = await Promise.all([
    json<{ order_book_details: LighterMarket[] }>(ctx, `${LIGHTER.mainnet}/orderBookDetails`),
    json<{ funding_rates: { exchange: string; symbol: string; rate: number | string }[] }>(
      ctx,
      `${LIGHTER.mainnet}/funding-rates`,
    ),
  ])
  const funding = new Map(
    f.funding_rates.filter((r) => r.exchange === 'lighter').map((r) => [r.symbol, Number(r.rate)]),
  )
  return d.order_book_details
    .filter((m) => m.market_type === 'perp' && m.status === 'active')
    .map((m) => ({ ...m, funding8h: funding.get(m.symbol) ?? null }))
}

export function findLighterMarket<M extends { symbol: string; market_id: number }>(
  markets: M[],
  q: string | number,
): M {
  const s = String(q).trim().toUpperCase()
  const m = markets.find(
    (x) => String(x.market_id) === s || x.symbol.toUpperCase() === s || `${x.symbol.toUpperCase()}-USD` === s,
  )
  if (!m) throw new Error(`no Lighter market "${q}"; list them with perps_markets`)
  return m
}

export interface LighterPosition {
  market_id: number
  symbol: string
  sign: number
  position: string
  avg_entry_price: string
  position_value: string
  liquidation_price: string
}

export const lighterAccounts = (ctx: Ctx, address: Address) =>
  json<{
    accounts: {
      account_index: number
      collateral: string
      total_asset_value: string
      available_balance: string
      positions: LighterPosition[]
    }[]
  }>(ctx, `${LIGHTER[ctx.config.network]}/account?by=l1_address&value=${address}`)
