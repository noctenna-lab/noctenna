// The local wallet's address and balances, and sends of ETH or a token, on the configured network.
import { encodeFunctionData, erc20Abi, isAddressEqual } from 'viem'
import { z } from 'zod'
import { NETWORKS } from '../../core/chain.js'
import type { Module, Preview, Tool } from '../../core/types.js'
import { usdValue } from '../swap/price.js'
import {
  addressArg,
  amountArg,
  balanceOf,
  decimalsOf,
  fmt,
  KNOWN,
  label,
  parseAmount,
  requireAddress,
  symbolOf,
  tokenArg,
  type TokenRef,
} from './tokens.js'

const address: Tool<z.ZodObject<{}>> = {
  name: 'wallet_address',
  description: "The local wallet's address on the configured network.",
  kind: 'read',
  input: z.object({}),
  run: async (ctx) => {
    const a = requireAddress(ctx.address)
    return {
      network: ctx.config.network,
      address: a,
      explorer: `${NETWORKS[ctx.config.network].explorer}/address/${a}`,
    }
  },
}

const balancesInput = z.object({
  tokens: z
    .array(tokenArg)
    .max(20)
    .optional()
    .describe('extra token addresses to read; ETH and the well-known tokens are always read'),
  owner: addressArg.optional().describe('another address to read instead of the local wallet'),
})
const balances: Tool<typeof balancesInput> = {
  name: 'wallet_balances',
  description: 'ETH and token balances of the local wallet (or of any address given) on the configured network.',
  kind: 'read',
  input: balancesInput,
  run: async (ctx, a) => {
    const owner = a.owner ?? requireAddress(ctx.address)
    const net = ctx.config.network
    const list: TokenRef[] = ['ETH', ...(Object.keys(KNOWN[net]) as TokenRef[])]
    for (const t of a.tokens ?? [])
      if (!list.some((x) => x === t || (x !== 'ETH' && t !== 'ETH' && isAddressEqual(x, t)))) list.push(t)
    const rows = await Promise.all(
      list.map(async (token) => {
        try {
          const [raw, decimals] = await Promise.all([balanceOf(ctx.chain, token, owner), decimalsOf(ctx.chain, token)])
          return {
            token,
            symbol: token === 'ETH' || KNOWN[net][token] ? label(token, net) : await symbolOf(ctx.chain, token),
            balance: fmt(raw, decimals),
          }
        } catch (e) {
          return { token, error: (e as Error).message }
        }
      }),
    )
    return { network: net, owner, balances: rows }
  },
}

const sendInput = z.object({ to: addressArg, amount: amountArg, token: tokenArg.default('ETH') })
const send: Tool<typeof sendInput> = {
  name: 'wallet_prepare_send',
  description: 'Prepare a send of ETH or an ERC-20 token from the local wallet to an address.',
  kind: 'prepare',
  input: sendInput,
  run: async (ctx, { to, amount, token }): Promise<Preview> => {
    const from = requireAddress(ctx.address)
    const net = ctx.config.network
    if (isAddressEqual(to, '0x0000000000000000000000000000000000000000'))
      throw new Error('refused: that is the zero address')
    if (token !== 'ETH' && isAddressEqual(to, token))
      throw new Error('refused: that is the token contract itself, which would lose the tokens')
    const decimals = await decimalsOf(ctx.chain, token)
    const value = parseAmount(amount, decimals)
    const balance = await balanceOf(ctx.chain, token, from)
    if (balance < value) throw new Error(`the wallet holds ${fmt(balance, decimals)}, less than ${amount}`)
    const { usd, note } = await usdValue(ctx, token, value)
    const step =
      token === 'ETH'
        ? { type: 'tx' as const, label: 'Send ETH', to, data: '0x' as const, value }
        : {
            type: 'tx' as const,
            label: 'Send token',
            to: token,
            data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [to, value] }),
            value: 0n,
          }
    return {
      summary: [
        `Send ${amount} ${label(token, net)} from ${from} to ${to}.`,
        'Network fee only.',
        `Counts $${usd.toFixed(2)} against the daily limit${note ? ` (${note})` : ''}.`,
      ],
      usd,
      steps: [step],
      details: token === 'ETH' ? undefined : { token, symbol: await symbolOf(ctx.chain, token) },
      recheck: async () => {
        if ((await balanceOf(ctx.chain, token, from)) < value) throw new Error('the wallet no longer holds this amount')
      },
    }
  },
}

export const wallet: Module = { name: 'wallet', tools: [address, balances, send] }
