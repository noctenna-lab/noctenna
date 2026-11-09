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
import type { Network } from '../core/types.js'
import { createWallet, exportKey, getAddress, importWallet, secretDelete, secretSet } from '../core/wallet.js'
import {
  KeyRefused,
  launch,
  listModels,
  MODEL_KEY,
  OLLAMA_URL,
  PROVIDERS,
  readProfile,
  saveProfile,
  shortlist,
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

const lockNote = (network: Network) => (writesOpen(network) ? '' : ', read-only until the token launch')

const welcome = () => {
  const { network } = loadConfig()
  console.log(
    `Noctenna ${version} on ${NETWORKS[network].label}${lockNote(network)}. Information only, not financial advice.`,
  )
}

// The name in block letters (FIGlet's ANSI Shadow), shown when the agent starts in a terminal wide enough for it
const WORDMARK = [
  '███╗   ██╗ ██████╗  ██████╗████████╗███████╗███╗   ██╗███╗   ██╗ █████╗ ',
  '████╗  ██║██╔═══██╗██╔════╝╚══██╔══╝██╔════╝████╗  ██║████╗  ██║██╔══██╗',
  '██╔██╗ ██║██║   ██║██║        ██║   █████╗  ██╔██╗ ██║██╔██╗ ██║███████║',
  '██║╚██╗██║██║   ██║██║        ██║   ██╔══╝  ██║╚██╗██║██║╚██╗██║██╔══██║',
  '██║ ╚████║╚██████╔╝╚██████╗   ██║   ███████╗██║ ╚████║██║ ╚████║██║  ██║',
  '╚═╝  ╚═══╝ ╚═════╝  ╚═════╝   ╚═╝   ╚══════╝╚═╝  ╚═══╝╚═╝  ╚═══╝╚═╝  ╚═╝',
]

// The letters run from the brand violet #6a2bff to lilac #c4b0ff and their box-drawing edges stay deep violet, like a
// shadow. Colour is 24-bit where the terminal declares it (COLORTERM), the nearest of the 256 standard colours
// elsewhere and off under NO_COLOR. A terminal narrower than the name gets the one-line welcome instead.
export function banner(network: Network, columns = process.stdout.columns ?? 0, env = process.env): string | undefined {
  if (columns < WORDMARK[0]!.length + 2) return undefined
  const on = !env.NO_COLOR
  const truecolor = /truecolor|24bit/i.test(env.COLORTERM ?? '')
  const sgr = (code: string) => (on ? `\x1b[${code}m` : '')
  const fg = (rgb: number[]) =>
    sgr(truecolor ? `38;2;${rgb.join(';')}` : `38;5;${rgb.reduce((n, c) => n * 6 + Math.round((c / 255) * 5), 0) + 16}`)
  const art = WORDMARK.map((row) => {
    const chars = [...row].map((ch, i) => {
      const t = i / (row.length - 1)
      if (ch === ' ') return ch
      return (ch === '█' ? fg([Math.round(106 + 90 * t), Math.round(43 + 133 * t), 255]) : fg([59, 31, 143])) + ch
    })
    return `  ${chars.join('')}${sgr('0')}`
  })
  const status = `${NETWORKS[network].label}${lockNote(network)}. Information only, not financial advice.`
  return [
    '',
    ...art,
    '',
    `  ${sgr('1')}The open-source AI agent for Robinhood Chain.${sgr('0')}`,
    `  ${sgr('2')}${status}${sgr('0')}`,
    '',
  ].join('\n')
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

// Reads a line without echoing it, so a key never lands in the terminal's scrollback. Echo goes off before the prompt
// appears: typing (or pasting) the moment it shows can no longer reach the terminal while echo is still on.
function askHidden(q: string): Promise<string> {
  const stdin = process.stdin
  stdin.setRawMode(true)
  process.stdout.write(q)
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

// Pick a provider (Enter takes the free Gemini key), paste its key, and pick a model from the ones the key can use:
// the key is checked before anything is saved, and nobody has to know how a provider spells its model names.
async function setup() {
  terminalOnly('setup')
  console.log("Noctenna thinks with an AI model you choose. Its key stays in this computer's keychain.\n")
  // Ollama is offered only when it runs on this computer, so it can never be picked without a model to answer
  const ollama = await listModels('ollama', null).catch(() => [])
  const ids = (Object.keys(PROVIDERS) as ProviderId[]).filter((id) => id !== 'ollama' || ollama.length)
  ids.forEach((id, i) => {
    const d: { label: string; note?: string; keyUrl?: string } = PROVIDERS[id]
    console.log(`  ${i + 1}. ${d.label.padEnd(26)}${d.note ? `${d.note}: ${d.keyUrl}` : ''}`)
  })
  const provider = ids[Number((await ask(`Provider [1-${ids.length}, Enter for 1]: `)) || 1) - 1]
  if (!provider) throw new Error('pick a number from the list')
  const def = PROVIDERS[provider]
  let url = provider === 'ollama' ? OLLAMA_URL : undefined
  if (provider === 'compatible')
    url = new URL(await ask('Base URL (for example https://example.com/v1): ')).href.replace(/\/$/, '')
  let key: string | null = null
  let models: string[] | null = null
  for (let tries = 1; models === null; tries++) {
    if ('keyEnv' in def) {
      const hint = provider === 'compatible' ? 'API key (hidden; Enter for none): ' : `${def.label} API key (hidden): `
      key = (await askHidden(hint)) || null
      if (!key && provider !== 'compatible') throw new Error('an API key is needed for this provider')
    }
    try {
      models = shortlist(provider, await listModels(provider, key, url))
    } catch (e) {
      if (!(e instanceof KeyRefused)) {
        // An unreachable provider is no reason to stop: the model name can still be typed
        console.log(`Could not list the models: ${e instanceof Error ? e.message : String(e)}.`)
        models = []
      } else if (tries === 3 || !('keyEnv' in def)) throw e
      else console.log('The provider refused that key. Paste it again.')
    }
  }
  let model: string
  if (models.length) {
    console.log(key ? 'The key works. Models it can use:' : 'Models available:')
    models.forEach((m, i) => console.log(`  ${i + 1}. ${m}${i ? '' : '   (recommended)'}`))
    const a = await ask(`Model [1-${models.length}, Enter for 1, or type another name]: `)
    model = !a ? models[0]! : /^\d+$/.test(a) ? (models[Number(a) - 1] ?? '') : a
  } else model = await ask('Model name, as the provider spells it: ')
  if (!model) throw new Error('a model name is needed')
  if ('keyEnv' in def) {
    // The old provider's key must never be sent to a new endpoint.
    await secretDelete(MODEL_KEY).catch(() => {})
    if (key) await secretSet(MODEL_KEY, key)
    console.log(key ? `API key stored in the OS keychain (${key.length} characters).` : 'No API key stored.')
  }
  const profile = { provider, model, url }
  saveProfile(profile)
  writeGooseConfig(profile)
  console.log(`Model: ${model} on ${def.label}.`)
  if (!(await getAddress()))
    console.log('Next: `noctenna wallet create` (or `noctenna wallet import`), then `noctenna`.')
  else console.log('Next: `noctenna`.')
  console.log(
    `Mainnet reads only until the token launch. To practise trading now: \`noctenna network testnet\` (test ETH: ${FAUCET}, perps: ${ARCUS_TESTNET}).`,
  )
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
  if (cmd === undefined) {
    terminalOnly('the agent')
    const art = banner(loadConfig().network)
    if (art) console.log(art)
    else welcome()
    if (!readProfile()) await setup()
    process.exitCode = await launch()
    return
  }
  welcome()
  if (cmd === 'setup') await setup()
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
