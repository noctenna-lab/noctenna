// The MCP server: every module's tools plus `execute` and `status`, over stdio.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createRequire } from 'node:module'
import type { PublicClient } from 'viem'
import { z } from 'zod'
import { modules } from '../modules/index.js'
import { createChain, createHttp, NETWORKS } from './chain.js'
import { loadConfig, mainnetRpcUrl } from './config.js'
import { INSTRUCTIONS } from './instructions.js'
import { LOCKED_MESSAGE, writesOpen } from './launch.js'
import { ExecuteError, execute, spentToday, storePreview } from './previews.js'
import type { Ctx, Network, Preview, Tool } from './types.js'
import { getAddress, localAccount } from './wallet.js'

const { version } = createRequire(import.meta.url)('../../package.json') as { version: string }

// Untrusted text reaches the model as a JSON string under "untrusted_text": quoted, never markup. Control and
// bidi-override characters go (they can hide text), and the length is capped so a description cannot carry an essay.
const MAX_UNTRUSTED = 500
export function quoteUntrusted(v: unknown): { untrusted_text: string } {
  const s = typeof v === 'string' ? v : JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? x.toString() : x))
  // eslint-disable-next-line no-control-regex
  const clean = (s ?? '').replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g, '')
  return { untrusted_text: clean.length > MAX_UNTRUSTED ? `${clean.slice(0, MAX_UNTRUSTED)}…` : clean }
}

const isUntrusted = (v: unknown): v is { untrusted: unknown } =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && Object.keys(v).length === 1 && 'untrusted' in v

// Tool output for the model: Untrusted values quoted, bigints as decimal strings.
export function toModel(v: unknown): unknown {
  if (typeof v === 'bigint') return v.toString()
  if (Array.isArray(v)) return v.map(toModel)
  if (isUntrusted(v)) return quoteUntrusted(v.untrusted)
  if (typeof v === 'object' && v !== null) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, toModel(x)]))
  return v
}

const text = (v: unknown, isError = false) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(toModel(v), null, 2) }],
  isError,
})

const clients = new Map<string, PublicClient>()
const client = (url: string, network: Network) => {
  const k = `${network} ${url}`
  let c = clients.get(k)
  if (!c) clients.set(k, (c = createChain(url, network)))
  return c
}
const http = createHttp()

// Built per call, so a limit or network the user changes in the terminal applies at once.
export async function buildCtx(): Promise<Ctx> {
  const config = loadConfig()
  const address = await getAddress().catch(() => null)
  return {
    config,
    address,
    http,
    chain: client(config.rpcUrl, config.network),
    mainnet: client(mainnetRpcUrl(config), 'mainnet'),
  }
}

const coreTools: Tool[] = [
  {
    name: 'status',
    description:
      'The configured network, the wallet address, the chain head, the daily USD limit and what was spent today (UTC).',
    kind: 'read',
    input: z.object({}),
    run: async (ctx) => ({
      network: ctx.config.network,
      networkLabel: NETWORKS[ctx.config.network].label,
      address: ctx.address,
      chainHead: await ctx.chain.getBlockNumber(),
      dailyLimitUsd: ctx.config.dailyLimitUsd,
      spentTodayUsd: spentToday(),
      slippageBps: ctx.config.slippageBps,
      note:
        ctx.config.network === 'testnet'
          ? 'Testnet: test ETH and tokens have no value. Mainnet opens at the token launch; only the user can switch, in the terminal.'
          : undefined,
    }),
  },
  {
    name: 'execute',
    description:
      "Sends an action a prepare tool made, by its previewId. Call it only after showing the user that preview's whole summary and getting an explicit yes for it. It re-checks the price and state, enforces the daily USD limit, and returns transaction hashes with explorer links.",
    kind: 'read',
    input: z.object({ previewId: z.string().regex(/^[0-9a-f]{24}$/) }),
    run: async (ctx, { previewId }: { previewId: string }) =>
      execute({ chain: ctx.chain, config: ctx.config, account: localAccount }, previewId),
  },
]

export function allTools(): Tool[] {
  const tools = [...modules.flatMap((m) => m.tools), ...coreTools]
  const seen = new Set<string>()
  for (const t of tools) {
    if (seen.has(t.name)) throw new Error(`two tools are named ${t.name}`)
    seen.add(t.name)
  }
  return tools
}

export function createServer(ctx: () => Promise<Ctx> = buildCtx): McpServer {
  const server = new McpServer({ name: 'noctenna', version }, { instructions: INSTRUCTIONS })
  for (const tool of allTools()) {
    server.registerTool(
      tool.name,
      {
        description:
          tool.kind === 'prepare'
            ? `${tool.description} Prepares only: nothing is sent until execute.`
            : tool.description,
        inputSchema: tool.input,
      },
      async (args: unknown) => {
        try {
          const c = await ctx()
          if (tool.kind === 'prepare' && !writesOpen(c.config.network))
            return text({ locked: true, message: LOCKED_MESSAGE })
          const out = await tool.run(c, args as never)
          return text(tool.kind === 'prepare' ? storePreview(out as Preview, c.config.network) : out)
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e)
          return text({ error: { untrusted: msg }, ...(e instanceof ExecuteError ? { done: e.done } : {}) }, true)
        }
      },
    )
  }
  return server
}

export async function startServer(): Promise<void> {
  await createServer().connect(new StdioServerTransport())
}
