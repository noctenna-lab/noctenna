// User config at ~/.config/noctenna/config.json. NOCTENNA_CONFIG_DIR moves the whole directory (tests use a temp
// dir). NOCTENNA_NETWORK and NOCTENNA_RPC_URL override the network and its RPC for one run without touching the file.
// Mainnet is the default and read-only until the token launch (launch.ts); testnet takes writes for practice. Only the
// terminal switches networks (setNetwork), never a tool.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { NETWORKS } from './chain.js'
import type { Config, Network } from './types.js'

const network = z.enum(['testnet', 'mainnet'])
const file = z.object({
  network: network.default('mainnet'),
  dailyLimitUsd: z.number().nonnegative().default(100),
  slippageBps: z.number().int().min(10).max(2500).default(300),
  rpcUrls: z.object({ testnet: z.url().optional(), mainnet: z.url().optional() }).default({}),
})
type File = z.infer<typeof file>

export const configDir = () => process.env.NOCTENNA_CONFIG_DIR || join(homedir(), '.config', 'noctenna')

function readFile(): File {
  let raw: unknown = {}
  try {
    raw = JSON.parse(readFileSync(join(configDir(), 'config.json'), 'utf8'))
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT')
      throw new Error(`config.json in ${configDir()} is not valid JSON`)
  }
  return file.parse(raw)
}

function writeFile(next: File) {
  mkdirSync(configDir(), { recursive: true, mode: 0o700 })
  writeFileSync(join(configDir(), 'config.json'), JSON.stringify(next, null, 2) + '\n', { mode: 0o600 })
}

export function loadConfig(): Config {
  const f = readFile()
  const net = process.env.NOCTENNA_NETWORK ? network.parse(process.env.NOCTENNA_NETWORK) : f.network
  const rpcUrl = process.env.NOCTENNA_RPC_URL
    ? z.url().parse(process.env.NOCTENNA_RPC_URL)
    : (f.rpcUrls[net] ?? NETWORKS[net].rpcUrl)
  return { network: net, rpcUrl, dailyLimitUsd: f.dailyLimitUsd, slippageBps: f.slippageBps }
}

// Where mainnet market data is read from, whatever the configured network.
export function mainnetRpcUrl(config: Config = loadConfig()): string {
  return config.network === 'mainnet' ? config.rpcUrl : (readFile().rpcUrls.mainnet ?? NETWORKS.mainnet.rpcUrl)
}

// The CLI sets the daily limit and slippage here. Env overrides are never written back.
export function saveConfig(patch: Partial<Pick<Config, 'dailyLimitUsd' | 'slippageBps'>>): Config {
  writeFile(file.parse({ ...readFile(), ...patch }))
  return loadConfig()
}

// Terminal only (`noctenna network <name>`): no MCP tool may call this.
export function setNetwork(n: Network): Config {
  writeFile({ ...readFile(), network: network.parse(n) })
  return loadConfig()
}
