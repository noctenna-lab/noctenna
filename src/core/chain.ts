// The chain clients and the HTTP helper every module gets through Ctx.
import { createPublicClient, http as viemHttp, type Chain, type Hex, type PublicClient } from 'viem'
import { robinhood, robinhoodTestnet } from 'viem/chains'
import type { Network } from './types.js'

// Cloudflare in front of the public RPC and several APIs answers 403 to non-browser user agents.
export const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36'

// Explorers (checked 8 Nov 2026): mainnet is Robinhood Chain's Blockscout (explorer.chain.robinhood.com has a DNS
// record but failed the TLS handshake); testnet is Blockscout on explorer.testnet.chain.robinhood.com.
export const NETWORKS: Record<Network, { chain: Chain; rpcUrl: string; explorer: string; label: string }> = {
  mainnet: {
    chain: robinhood,
    rpcUrl: 'https://rpc.mainnet.chain.robinhood.com',
    explorer: 'https://robinhoodchain.blockscout.com',
    label: 'Robinhood Chain mainnet (4663)',
  },
  testnet: {
    chain: robinhoodTestnet,
    rpcUrl: 'https://rpc.testnet.chain.robinhood.com',
    explorer: 'https://explorer.testnet.chain.robinhood.com',
    label: 'Robinhood Chain testnet (46630)',
  },
}

export const txUrl = (hash: Hex, network: Network) => `${NETWORKS[network].explorer}/tx/${hash}`

// The public RPC is shared and answers bursts with 429: JSON-RPC batching plus multicall batching keep the request
// count down, and viem retries 429/5xx with exponential backoff (it also honours Retry-After).
export function createChain(rpcUrl: string, network: Network): PublicClient {
  return createPublicClient({
    chain: NETWORKS[network].chain,
    transport: viemHttp(rpcUrl, {
      batch: { batchSize: 10, wait: 10 },
      retryCount: 6,
      retryDelay: 500,
      timeout: 30_000,
      fetchOptions: { headers: { 'user-agent': USER_AGENT } },
    }),
    batch: { multicall: { wait: 10 } },
  }) as PublicClient
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// fetch with the browser-like User-Agent, a timeout, and retries. A 429 is retried for every method (the request was
// refused, not run); 5xx and network errors only for GET/HEAD, because a retried POST could place an order twice.
export function createHttp({ retries = 3, timeoutMs = 20_000, baseDelayMs = 500 } = {}) {
  return async function http(url: string, init: RequestInit = {}): Promise<Response> {
    const method = (init.method ?? 'GET').toUpperCase()
    const idempotent = method === 'GET' || method === 'HEAD'
    const headers = new Headers(init.headers)
    if (!headers.has('user-agent')) headers.set('user-agent', USER_AGENT)
    for (let attempt = 0; ; attempt++) {
      let res: Response
      try {
        res = await fetch(url, { ...init, headers, signal: init.signal ?? AbortSignal.timeout(timeoutMs) })
      } catch (e) {
        if (!idempotent || attempt >= retries) throw e
        await sleep(baseDelayMs * 2 ** attempt)
        continue
      }
      const retry = res.status === 429 || (idempotent && res.status >= 500)
      if (!retry || attempt >= retries) return res
      const after = Number(res.headers.get('retry-after'))
      await res.body?.cancel()
      await sleep(Number.isFinite(after) && after > 0 ? Math.min(after * 1000, 10_000) : baseDelayMs * 2 ** attempt)
    }
  }
}
