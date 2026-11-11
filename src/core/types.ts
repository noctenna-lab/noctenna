// The contract between the core and every module. Modules never sign or send: they read, or they
// return a Preview that the core's `execute` tool re-simulates and sends.
import type { Address, Hex, PublicClient, TypedDataDefinition } from 'viem'
import type { z } from 'zod'

export interface Ctx {
  /** The configured network's client: every write goes here. */
  chain: PublicClient
  /** Mainnet, for market-data reads that are worth showing even in testnet mode (always set by the server). */
  mainnet?: PublicClient
  /** The local wallet's address, or null before `noctenna wallet create`. */
  address: Address | null
  config: Config
  /** fetch with a browser-like User-Agent, retries on 429/5xx, and a timeout. */
  http: (url: string, init?: RequestInit) => Promise<Response>
}

export type Network = 'testnet' | 'mainnet'

export interface Config {
  /** Mainnet by default. Only the terminal can change it (`noctenna network`), never a tool. */
  network: Network
  /** The configured network's RPC. */
  rpcUrl: string
  dailyLimitUsd: number
  slippageBps: number
}

/** Anything read from chain or a third-party API that a person or contract controls. */
export type Untrusted<T = string> = { untrusted: T }

export interface Tool<S extends z.ZodTypeAny = z.ZodTypeAny> {
  name: string
  description: string
  input: S
  /** read: returns data. prepare: returns a Preview. */
  kind: 'read' | 'prepare'
  // Method syntax on purpose: it lets a Tool<z.ZodObject<...>> sit in a Tool[] (the server parses args with `input`).
  run(ctx: Ctx, args: z.infer<S>): Promise<unknown>
}

export interface Module {
  name: string
  tools: Tool[]
}

/** One step `execute` performs, in order. */
export type Step =
  | { type: 'tx'; to: Address; data: Hex; value: bigint; gasFloor?: bigint; label: string }
  | { type: 'typedData'; typedData: TypedDataDefinition; label: string; then: (signature: Hex) => Promise<unknown> }
  | { type: 'offchain'; label: string; run: () => Promise<unknown> }

export interface Preview {
  /** Plain-language lines shown to the user before they approve. Never put Untrusted text here: use `details`. */
  summary: string[]
  /** Extra facts shown with the summary (token names, routes); may hold Untrusted values, which the server wraps. */
  details?: unknown
  /** USD value counted against the daily limit. */
  usd: number
  steps: Step[]
  /** Re-checks state right before sending (re-quote, balance, allowance); throws to fail closed. */
  recheck?: () => Promise<void>
}
