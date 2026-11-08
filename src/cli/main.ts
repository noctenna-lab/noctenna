#!/usr/bin/env node
// The noctenna command. Everything that can raise a limit, switch networks or show a key runs only here, in an
// interactive terminal, and never as an MCP tool.
import { realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createInterface } from 'node:readline/promises'
import { fileURLToPath } from 'node:url'
import type { Hex } from 'viem'
import { NETWORKS } from '../core/chain.js'
import { loadConfig, saveConfig, setNetwork } from '../core/config.js'
import { writesOpen } from '../core/launch.js'
import { startServer } from '../core/server.js'
import { createWallet, exportKey, getAddress, importWallet, secretDelete, secretSet } from '../core/wallet.js'
import {
  gooseRoot,
  launch,
  MODEL_KEY,
  PROVIDERS,
  readProfile,
  saveProfile,
  writeGooseConfig,
  type ProviderId,
} from './goose.js'

const { version } = createRequire(import.meta.url)('../../package.json') as { version: string }
const FAUCET = 'https://faucet.testnet.chain.robinhood.com'
const ARCUS_TESTNET = 'https://testnet.arcus.xyz'

const USAGE = `noctenna ${version}: an AI agent for Robinhood Chain. Information only, not financial advice.

  noctenna                    start the agent in this terminal (runs setup first if needed)
  noctenna setup              choose the model provider and store its API key
  noctenna mcp                serve the same tools over stdio, for Claude Code, Codex, Cursor and other MCP hosts
  noctenna wallet create      make a new wallet on this computer
  noctenna wallet import      import a private key (hidden prompt)
  noctenna wallet address     show the wallet address
  noctenna wallet export      show the private key (interactive terminal only)
  noctenna limit <usd>        set the daily spending limit in USD
  noctenna network <name>     testnet or mainnet`

const welcome = () => {
  const { network } = loadConfig()
  const lock = writesOpen(network) ? '' : ', read-only until the token launch'
  console.log(`Noctenna ${version} on ${NETWORKS[network].label}${lock}. Information only, not financial advice.`)
}

function terminalOnly(what: string) {
  // An agent driving a shell has no TTY; this keeps keys, limits and the network out of its reach.
  if (!(process.stdin.isTTY && process.stdout.isTTY)) throw new Error(`${what} works only in an interactive terminal`)
}

async function ask(q: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    return (await rl.question(q)).trim()
  } finally {
    rl.close()
  }
}

// Reads a line without echoing it, so a key never lands in the terminal's scrollback.
function askHidden(q: string): Promise<string> {
  process.stdout.write(q)
  const stdin = process.stdin
  stdin.setRawMode(true)
  stdin.resume()
  stdin.setEncoding('utf8')
  let s = ''
  return new Promise((resolve, reject) => {
    const done = () => {
      stdin.off('data', on)
      stdin.setRawMode(false)
      stdin.pause()
      process.stdout.write('\n')
    }
    const on = (chunk: string) => {
      for (const c of chunk) {
        if (c === '\r' || c === '\n') return (done(), resolve(s.trim()))
        if (c === '\u0003') return (done(), reject(new Error('cancelled')))
        s = c === '\u007f' || c === '\b' ? s.slice(0, -1) : s + c
      }
    }
    stdin.on('data', on)
  })
}

async function setup() {
  terminalOnly('setup')
  console.log(`Noctenna runs on Robinhood Chain mainnet. Until the token launch it reads only: launch checks, funding,
perps markets, balances and quotes work now, and trading opens at the launch.
To practise trading now: \`noctenna network testnet\`. Test ETH: ${FAUCET}. Perps practice: ${ARCUS_TESTNET}.
`)
  const ids = Object.keys(PROVIDERS) as ProviderId[]
  ids.forEach((id, i) => console.log(`  ${i + 1}. ${PROVIDERS[id].label}`))
  const pick = Number(await ask('Model provider [1-6]: '))
  const provider = ids[pick - 1]
  if (!provider) throw new Error('pick a number from the list')
  const def = PROVIDERS[provider]
  const model = await ask(
    provider === 'ollama' ? 'Model name (as `ollama list` shows it): ' : 'Model name, as the provider spells it: ',
  )
  if (!model) throw new Error('a model name is needed')
  let url: string | undefined
  if (provider === 'compatible')
    url = new URL(await ask('Base URL (for example https://example.com/v1): ')).href.replace(/\/$/, '')
  if (provider === 'ollama')
    url = new URL((await ask('Ollama address [http://localhost:11434]: ')) || 'http://localhost:11434').href.replace(
      /\/$/,
      '',
    )
  if ('keyEnv' in def) {
    const key = await askHidden(provider === 'compatible' ? 'API key (hidden; Enter for none): ' : 'API key (hidden): ')
    if (!key && provider !== 'compatible') throw new Error('an API key is needed for this provider')
    // The old provider's key must never be sent to a new endpoint.
    await secretDelete(MODEL_KEY).catch(() => {})
    if (key) await secretSet(MODEL_KEY, key)
    console.log(key ? `API key stored in the OS keychain (${key.length} characters).` : 'No API key stored.')
  }
  const profile = { provider, model, url }
  saveProfile(profile)
  writeGooseConfig(profile)
  console.log(`Goose profile written to ${gooseRoot()}.`)
  if (!(await getAddress()))
    console.log('Next: `noctenna wallet create` (or `noctenna wallet import`), then `noctenna`.')
  else console.log('Next: `noctenna`.')
}

async function wallet(sub?: string) {
  if (sub === 'create') {
    const a = await createWallet()
    console.log(
      `Wallet created: ${a}\nIts key is in this computer's keychain. Back it up with \`noctenna wallet export\`.`,
    )
    if (loadConfig().network === 'testnet') console.log(`Test ETH: ${FAUCET}`)
  } else if (sub === 'import') {
    terminalOnly('wallet import')
    const key = (await askHidden('Private key, 0x-prefixed (hidden): ')) as Hex
    console.log(`Wallet imported: ${await importWallet(key)}`)
  } else if (sub === 'address') {
    console.log((await getAddress()) ?? 'No wallet yet: run `noctenna wallet create`.')
  } else if (sub === 'export') {
    terminalOnly('wallet export')
    console.log('Anyone who sees this key controls the wallet and everything in it.')
    if ((await ask('Type "show" to print it here: ')) !== 'show') return console.log('Not shown.')
    console.log(await exportKey())
  } else throw new Error('usage: noctenna wallet create | import | address | export')
}

async function limit(arg?: string) {
  terminalOnly('limit')
  const usd = Number(arg)
  if (arg === undefined || !Number.isFinite(usd) || usd < 0)
    throw new Error('usage: noctenna limit <usd>, for example `noctenna limit 200`')
  const now = loadConfig().dailyLimitUsd
  if (usd > now && (await ask(`Raise the daily limit from $${now} to $${usd}? Type "yes": `)) !== 'yes')
    return console.log('Limit unchanged.')
  console.log(`Daily limit: $${saveConfig({ dailyLimitUsd: usd }).dailyLimitUsd} (UTC days).`)
}

async function network(arg?: string) {
  if (arg === undefined) return console.log(`Network: ${NETWORKS[loadConfig().network].label}`)
  terminalOnly('network')
  if (arg !== 'testnet' && arg !== 'mainnet') throw new Error('usage: noctenna network testnet | mainnet')
  if (arg === 'mainnet') {
    console.log(`Mainnet moves real money: once trading opens at the token launch, swaps, Pons trades, perps orders and
bridges spend real funds, and Noctenna cannot undo a sent transaction. Until then mainnet is read-only.`)
    if ((await ask('Type "yes" to switch to mainnet: ')) !== 'yes') return console.log('Still on testnet.')
  }
  const c = setNetwork(arg)
  console.log(`Network: ${NETWORKS[c.network].label}`)
  if (process.env.NOCTENNA_NETWORK && process.env.NOCTENNA_NETWORK !== arg)
    console.log(`Note: NOCTENNA_NETWORK=${process.env.NOCTENNA_NETWORK} in this shell overrides it.`)
}

export async function main([cmd, ...rest]: string[]) {
  // stdout is the MCP channel: nothing else may be printed there.
  if (cmd === 'mcp') return startServer()
  if (cmd === '--version' || cmd === '-v') return console.log(version)
  if (cmd === 'help' || cmd === '--help' || cmd === '-h') return console.log(USAGE)
  welcome()
  if (cmd === undefined) {
    terminalOnly('the agent')
    if (!readProfile()) await setup()
    process.exitCode = await launch()
  } else if (cmd === 'setup') await setup()
  else if (cmd === 'wallet') await wallet(rest[0])
  else if (cmd === 'limit') await limit(rest[0])
  else if (cmd === 'network') await network(rest[0])
  else throw new Error(`unknown command "${cmd}"\n\n${USAGE}`)
}

// Run only as the command itself (npm's bin is a symlink, hence realpath), so tests can import main.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url))
  main(process.argv.slice(2)).catch((e) => {
    console.error(`noctenna: ${e instanceof Error ? e.message : String(e)}`)
    process.exitCode = 1
  })
