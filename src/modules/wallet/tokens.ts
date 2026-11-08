// Token helpers shared by wallet, swap and pons: parsing a token argument, decimals, and a label that is safe to put
// in a summary (only symbols we wrote ourselves; any other token is shown by address, its symbol as Untrusted).
import { erc20Abi, formatUnits, getAddress, isAddress, parseUnits, type Address, type PublicClient } from 'viem'
import { z } from 'zod'
import type { Network, Untrusted } from '../../core/types.js'

export type TokenRef = 'ETH' | Address

// Checked 8 Nov 2026: USDG on mainnet; on testnet WETH and the faucet's stock tokens (the most-held token of each symbol).
export const KNOWN: Record<Network, Record<string, string>> = {
  mainnet: { '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168': 'USDG' },
  testnet: {
    '0x33e4191705c386532ba27cBF171Db86919200B94': 'WETH',
    '0xC9f9c86933092BbbfFF3CCb4b105A4A94bf3Bd4E': 'TSLA',
    '0x5884aD2f920c162CFBbACc88C9C51AA75eC09E02': 'AMZN',
    '0x1FBE1a0e43594b3455993B5dE5Fd0A7A266298d0': 'PLTR',
    '0x3b8262A63d25f0477c4DDE23F83cfe22Cb768C93': 'NFLX',
    '0x71178BAc73cBeb415514eB542a8995b82669778d': 'AMD',
  },
}
export const USDG: Address = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168'

export const tokenArg = z
  .string()
  .refine((s) => s.toUpperCase() === 'ETH' || isAddress(s, { strict: false }), 'ETH or a token address')
  .transform((s): TokenRef => (s.toUpperCase() === 'ETH' ? 'ETH' : getAddress(s)))
  .describe('"ETH" or the token contract address')
export const amountArg = z
  .string()
  .regex(/^\d+(\.\d+)?$/, 'a positive decimal number, e.g. "0.01"')
  .describe('amount in whole units, e.g. "0.01"')
export const addressArg = z
  .string()
  .refine((s) => isAddress(s, { strict: false }), 'an address')
  .transform((s) => getAddress(s))

export const label = (t: TokenRef, network: Network) => (t === 'ETH' ? 'ETH' : (KNOWN[network][t] ?? `token ${t}`))

export async function decimalsOf(chain: PublicClient, t: TokenRef): Promise<number> {
  if (t === 'ETH') return 18
  const d = await chain.readContract({ address: t, abi: erc20Abi, functionName: 'decimals' }).catch(() => {
    throw new Error(`${t} is not an ERC-20 token on this network (no decimals())`)
  })
  return Number(d)
}

export async function symbolOf(chain: PublicClient, t: TokenRef): Promise<Untrusted | 'ETH'> {
  if (t === 'ETH') return 'ETH'
  return { untrusted: await chain.readContract({ address: t, abi: erc20Abi, functionName: 'symbol' }).catch(() => '') }
}

export const parseAmount = (s: string, decimals: number) => {
  const v = parseUnits(s, decimals)
  if (v <= 0n) throw new Error('the amount must be above 0')
  return v
}
export const fmt = (v: bigint, decimals: number) => formatUnits(v, decimals)

export async function balanceOf(chain: PublicClient, t: TokenRef, owner: Address): Promise<bigint> {
  return t === 'ETH'
    ? chain.getBalance({ address: owner })
    : chain.readContract({ address: t, abi: erc20Abi, functionName: 'balanceOf', args: [owner] })
}

export function requireAddress(a: Address | null): Address {
  if (!a)
    throw new Error('no wallet yet: the user runs `noctenna wallet create` or `noctenna wallet import` in the terminal')
  return a
}
