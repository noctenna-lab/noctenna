// Bridging with Relay's public API. v1 bridges OUT only: the core sends `tx` steps on the configured chain and a step
// carries no chain id, so the source-chain transaction of a bridge IN cannot be sent. Quotes work both ways.
import {
  decodeFunctionData,
  erc20Abi,
  formatUnits,
  isAddress,
  parseUnits,
  zeroAddress,
  type Address,
  type Hex,
} from 'viem'
import { z } from 'zod'
import type { Ctx, Module, Preview, Step } from '../../core/types.js'
import { clean, json, plain, round, tool } from '../perps/api.js'

const RELAY = 'https://api.relay.link'
const RH = 4663
// Checked 8 Nov 2026: api.testnets.relay.link lists only Sepolia and Base Sepolia.
export const TESTNET_NOTE =
  'Bridging runs on mainnet only: Relay does not serve Robinhood Chain testnet. Test ETH comes from the faucet at https://faucet.testnet.chain.robinhood.com.'

interface Currency {
  symbol: string
  address: Address
  decimals: number
  supportsBridging?: boolean
}
interface RelayChain {
  id: number
  name: string
  displayName: string
  vmType: string
  disabled?: boolean
  currency: Currency
  erc20Currencies?: Currency[]
  protocol?: { v2?: { depository?: Address } }
}
interface Amount {
  amount: string
  amountFormatted: string
  amountUsd?: string
  minimumAmount?: string
}
interface Quote {
  steps: {
    id: string
    kind: string
    requestId?: string
    items: { data: { from: Address; to: Address; data: Hex; value: string; chainId: number } }[]
  }[]
  fees: Record<string, Amount | undefined>
  details: { currencyIn: Amount; currencyOut: Amount; timeEstimate?: number; totalImpact?: { percent?: string } }
}

let cache: { at: number; chains: RelayChain[] } | undefined
async function chains(ctx: Ctx) {
  if (!cache || Date.now() - cache.at > 600_000)
    cache = { at: Date.now(), chains: (await json<{ chains: RelayChain[] }>(ctx, `${RELAY}/chains`)).chains }
  return cache.chains
}

function findChain(cs: RelayChain[], q: string | number) {
  const s = String(q).trim().toLowerCase()
  const c = cs.find((x) => String(x.id) === s || x.name.toLowerCase() === s || x.displayName.toLowerCase() === s)
  // Only EVM chains: the same local key signs there.
  if (!c || c.vmType !== 'evm' || c.disabled) throw new Error(`Relay has no EVM chain "${q}" open for bridging`)
  return c
}

function currency(c: RelayChain, symbol: string): Currency {
  if (symbol === 'ETH' && c.currency.symbol === 'ETH') return { ...c.currency, address: zeroAddress }
  const t = c.erc20Currencies?.find((x) => x.symbol === symbol && x.supportsBridging !== false)
  if (!t) throw new Error(`Relay does not bridge ${symbol} on chain ${c.id}`)
  return t
}

const label = (c: RelayChain) =>
  c.id === RH ? 'Robinhood Chain' : `chain ${c.id}${plain(c.displayName) ? ` (${c.displayName})` : ''}`
const symbol = z.enum(['ETH', 'USDG', 'USDC'])
const args = {
  chain: z
    .union([z.string().min(1).max(40), z.number().int().positive()])
    .describe('the other chain: id or name, e.g. 8453 or base'),
  send: symbol.describe('what leaves the source chain'),
  receive: symbol.optional().describe('what arrives; default the same asset, or USDG/USDC for dollars'),
  amount: z
    .string()
    .regex(/^\d+(\.\d+)?$/)
    .describe('amount of `send`, e.g. "0.01"'),
  recipient: z.string().optional().describe('default: this wallet'),
}

async function quote(
  ctx: Ctx,
  out: boolean,
  a: { chain: string | number; send: string; receive?: string; amount: string; recipient?: string },
) {
  if (!ctx.address) throw new Error('no wallet yet: run `noctenna wallet create` in a terminal')
  const recipient = (a.recipient ?? ctx.address) as Address
  if (!isAddress(recipient)) throw new Error(`"${a.recipient}" is not an address`)
  const cs = await chains(ctx)
  const rh = findChain(cs, RH)
  const other = findChain(cs, a.chain)
  if (other.id === RH) throw new Error('pick the other chain, not Robinhood Chain')
  const [origin, dest] = out ? [rh, other] : [other, rh]
  const cin = currency(origin, a.send)
  const dollars = dest.erc20Currencies?.some((x) => x.symbol === 'USDG') ? 'USDG' : 'USDC'
  const cout = currency(dest, a.receive ?? (a.send === 'ETH' ? 'ETH' : dollars))
  const amount = parseUnits(a.amount, cin.decimals)
  // No referrer and no app fee: Noctenna takes nothing from a bridge.
  const body = {
    user: ctx.address,
    recipient,
    originChainId: origin.id,
    destinationChainId: dest.id,
    originCurrency: cin.address,
    destinationCurrency: cout.address,
    amount: amount.toString(),
    tradeType: 'EXACT_INPUT',
    slippageTolerance: String(ctx.config.slippageBps),
  }
  const q = await json<Quote>(ctx, `${RELAY}/quote`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const fee = (k: string) => Number(q.fees[k]?.amountUsd ?? 0)
  return {
    q,
    rh,
    cin,
    amount,
    recipient,
    view: {
      from: label(origin),
      to: label(dest),
      send: `${a.amount} ${a.send}`,
      receive: `${formatUnits(BigInt(q.details.currencyOut.amount), cout.decimals)} ${cout.symbol}`,
      receiveAtLeast: `${formatUnits(BigInt(q.details.currencyOut.minimumAmount ?? q.details.currencyOut.amount), cout.decimals)} ${cout.symbol}`,
      minimumOut: q.details.currencyOut.minimumAmount ?? q.details.currencyOut.amount,
      feesUsd: {
        gas: round(fee('gas'), 4),
        relay: round(fee('relayer'), 4),
        total: round(fee('gas') + fee('relayer'), 4),
      },
      seconds: Number(q.details.timeEstimate ?? NaN) || null,
      priceImpactPct: Number(q.details.totalImpact?.percent ?? 0),
      recipient,
      requestId: q.steps.find((s) => s.requestId)?.requestId,
    },
  }
}

// Every transaction Relay hands back is checked before it can become a step: our chain and wallet, an approval of
// exactly the amount to Relay's depository, and a deposit into that depository. Anything else fails closed.
export function toSteps(
  q: Quote,
  from: Address,
  depository: Address | undefined,
  cin: Currency,
  amount: bigint,
): Step[] {
  if (!depository) throw new Error('Relay lists no depository for Robinhood Chain')
  if (Number(q.fees.app?.amount ?? 0) !== 0)
    throw new Error('Relay quoted an app fee; Noctenna adds none and refuses the quote')
  const native = cin.address === zeroAddress
  const steps: Step[] = []
  for (const s of q.steps) {
    if (s.kind !== 'transaction') throw new Error(`Relay asked for a "${s.kind}" step, which Noctenna v1 does not run`)
    for (const { data: d } of s.items) {
      if (d.chainId !== RH || d.from.toLowerCase() !== from.toLowerCase())
        throw new Error('Relay returned a transaction for another chain or wallet')
      const to = d.to.toLowerCase()
      const value = BigInt(d.value ?? 0)
      if (!native && to === cin.address.toLowerCase()) {
        const call = decodeFunctionData({ abi: erc20Abi, data: d.data })
        if (
          call.functionName !== 'approve' ||
          value !== 0n ||
          call.args[0].toLowerCase() !== depository.toLowerCase() ||
          call.args[1] !== amount
        )
          throw new Error('Relay asked for a token call other than an exact-amount approval to its depository')
        steps.push({
          type: 'tx',
          to: d.to,
          data: d.data,
          value,
          label: `Approve exactly ${formatUnits(amount, cin.decimals)} ${cin.symbol} to Relay`,
        })
      } else if (to === depository.toLowerCase()) {
        if (value !== (native ? amount : 0n)) throw new Error('Relay asked for a deposit of a different amount')
        // The request id rides in the label, so execute's result names the request bridge_status follows.
        const id = s.requestId && /^0x[0-9a-fA-F]{64}$/.test(s.requestId) ? `, request ${s.requestId}` : ''
        steps.push({ type: 'tx', to: d.to, data: d.data, value, label: `Deposit to Relay${id}` })
      } else throw new Error('Relay routed through a contract Noctenna v1 does not accept')
    }
  }
  if (!steps.some((s) => s.label.startsWith('Deposit to Relay'))) throw new Error('Relay returned no deposit')
  return steps
}

const quoteTool = tool({
  name: 'bridge_quote',
  description:
    'Quotes a Relay bridge into or out of Robinhood Chain for ETH or dollars (USDG on Robinhood Chain, USDC or USDG elsewhere): what arrives, the minimum after slippage, fees and time. Read-only.',
  kind: 'read',
  input: z.object({ direction: z.enum(['in', 'out']), ...args }),
  async run(ctx, a) {
    if (ctx.config.network !== 'mainnet') return { note: TESTNET_NOTE }
    const { view } = await quote(ctx, a.direction === 'out', a)
    return {
      ...view,
      ...(a.direction === 'in'
        ? {
            note: "Noctenna v1 bridges out only. To bring funds in, start the bridge from a wallet on the source chain (this wallet's key works on any EVM chain).",
          }
        : {}),
    }
  },
})

const prepareTool = tool({
  name: 'prepare_bridge',
  description:
    'Bridges ETH or USDG out of Robinhood Chain to another chain with Relay (v1 bridges out only). Approvals are for the exact amount; Noctenna adds no fee.',
  kind: 'prepare',
  input: z.object(args),
  async run(ctx, a): Promise<Preview> {
    if (ctx.config.network !== 'mainnet') throw new Error(TESTNET_NOTE)
    const first = await quote(ctx, true, a)
    const { view, rh, cin, amount } = first
    const steps = toSteps(first.q, ctx.address!, rh.protocol?.v2?.depository, cin, amount)
    const usd = Number(first.q.details.currencyIn.amountUsd)
    if (!Number.isFinite(usd))
      throw new Error('Relay gave no USD value for this amount, so the daily limit cannot be checked')
    const approval = steps.find((s) => s.label.startsWith('Approve'))
    return {
      summary: [
        `Bridge ${view.send} from Robinhood Chain to ${view.to} with Relay.`,
        `You receive about ${view.receive}, at least ${view.receiveAtLeast} after the ${ctx.config.slippageBps / 100}% slippage limit, at ${view.recipient}${view.recipient.toLowerCase() === ctx.address!.toLowerCase() ? ' (this wallet)' : ''}.`,
        `Fees about $${view.feesUsd.total} (gas $${view.feesUsd.gas}, Relay $${view.feesUsd.relay}). Noctenna adds no fee.`,
        ...(approval ? [`${approval.label}'s depository ${rh.protocol!.v2!.depository}.`] : []),
        `Relay pays out on the other chain about ${view.seconds ?? '?'} s after the deposit confirms; follow it with bridge_status and the request id from the deposit step.`,
      ],
      usd,
      details: { ...view, quote: clean(first.q.details) },
      steps,
      // A Relay quote is short-lived, so execute re-quotes: it refuses if the new quote pays less than the minimum shown,
      // and otherwise sends the fresh, re-checked transactions (the array execute is about to walk).
      recheck: async () => {
        const fresh = await quote(ctx, true, a)
        if (BigInt(fresh.q.details.currencyOut.amount) < BigInt(view.minimumOut))
          throw new Error('the Relay price moved beyond the slippage limit since the preview')
        steps.splice(
          0,
          steps.length,
          ...toSteps(fresh.q, ctx.address!, fresh.rh.protocol?.v2?.depository, fresh.cin, fresh.amount),
        )
      },
    }
  },
})

const statusTool = tool({
  name: 'bridge_status',
  description:
    'Where a Relay bridge stands, by the requestId from prepare_bridge (waiting, pending, success, refund, failure).',
  kind: 'read',
  input: z.object({ requestId: z.string().regex(/^0x[0-9a-fA-F]{64}$/) }),
  run: async (ctx, { requestId }) => clean(await json(ctx, `${RELAY}/intents/status/v2?requestId=${requestId}`)),
})

export const bridge: Module = { name: 'bridge', tools: [quoteTool, prepareTool, statusTool] }
