// Prepared writes wait here until `execute` runs them: by random id, for 2 minutes, once.
import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { BaseError, createWalletClient, http as viemHttp, type Hex, type PublicClient } from 'viem'
import type { PrivateKeyAccount } from 'viem/accounts'
import { NETWORKS, txUrl, USER_AGENT } from './chain.js'
import { configDir } from './config.js'
import { LOCKED_MESSAGE, writesOpen } from './launch.js'
import type { Config, Network, Preview } from './types.js'

export const PREVIEW_TTL_MS = 120_000
const RECEIPT_TIMEOUT_MS = 180_000

const previews = new Map<string, { preview: Preview; network: Network; expiresAt: number }>()

// The network line leads every summary, so the user always sees where an action would land.
export function storePreview(preview: Preview, network: Network, now = Date.now()) {
  for (const [id, p] of previews) if (p.expiresAt <= now) previews.delete(id)
  const previewId = randomBytes(12).toString('hex')
  const expiresAt = now + PREVIEW_TTL_MS
  previews.set(previewId, { preview, network, expiresAt })
  const summary = [`Network: ${NETWORKS[network].label}`, ...preview.summary]
  return {
    previewId,
    network,
    summary,
    usd: preview.usd,
    details: preview.details,
    expiresAt: new Date(expiresAt).toISOString(),
  }
}

// Taking a preview deletes it, so a retried or doubled execute can never send twice.
// A preview made on one network never runs on another (the terminal can switch networks in between).
export function takePreview(previewId: string, network: Network, now = Date.now()): Preview {
  const p = previews.get(previewId)
  previews.delete(previewId)
  if (!p) throw new Error('unknown or already used preview id: prepare the action again')
  if (p.expiresAt <= now) throw new Error('this preview expired (2 minutes): prepare the action again')
  if (p.network !== network)
    throw new Error(`this preview was made on ${p.network}, but the network is now ${network}: prepare it again`)
  return p.preview
}

// ---------------- daily limit: USD per UTC day, in the config dir ----------------
const utcDay = (now: number) => new Date(now).toISOString().slice(0, 10)
const spendPath = () => join(configDir(), 'spend.json')

export function spentToday(now = Date.now()): number {
  try {
    const s = JSON.parse(readFileSync(spendPath(), 'utf8')) as { day: string; usd: number }
    return s.day === utcDay(now) && Number.isFinite(s.usd) ? s.usd : 0
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return 0
    // An unreadable ledger must not reset the limit to zero.
    throw new Error('spend.json in the config dir is unreadable; fix or delete it to continue')
  }
}

function addSpend(usd: number, now = Date.now()) {
  mkdirSync(configDir(), { recursive: true, mode: 0o700 })
  writeFileSync(spendPath(), JSON.stringify({ day: utcDay(now), usd: spentToday(now) + usd }), { mode: 0o600 })
}

export function checkLimit(config: Config, usd: number, now = Date.now()) {
  if (!Number.isFinite(usd) || usd < 0)
    throw new Error('this action has no USD value, so the daily limit cannot be checked')
  const spent = spentToday(now)
  if (spent + usd > config.dailyLimitUsd)
    throw new Error(
      `daily limit: $${spent.toFixed(2)} spent today (UTC) + $${usd.toFixed(2)} would pass the $${config.dailyLimitUsd} limit. The user can raise it in the terminal.`,
    )
}

// ---------------- execute ----------------
export interface ExecuteDeps {
  chain: PublicClient
  config: Config
  account: () => Promise<PrivateKeyAccount>
  now?: () => number
}

export interface StepResult {
  label: string
  type: 'tx' | 'typedData' | 'offchain'
  hash?: Hex
  explorer?: string
  gasUsed?: string
  result?: unknown
}

export class ExecuteError extends Error {
  constructor(
    message: string,
    readonly done: StepResult[],
  ) {
    super(message)
  }
}

function reason(e: unknown) {
  return e instanceof BaseError ? e.shortMessage : e instanceof Error ? e.message : String(e)
}

// Known limit: one global lock, so two executes cannot both pass the daily limit. Per-wallet locks if that ever matters.
let lock: Promise<unknown> = Promise.resolve()

export function execute(deps: ExecuteDeps, previewId: string): Promise<{ network: Network; steps: StepResult[] }> {
  const run = lock.then(() => executeNow(deps, previewId))
  lock = run.catch(() => undefined)
  return run
}

async function executeNow({ chain, config, account: getAccount, now = Date.now }: ExecuteDeps, previewId: string) {
  const preview = takePreview(previewId, config.network, now())
  if (!writesOpen(config.network)) throw new Error(LOCKED_MESSAGE)
  const net = NETWORKS[config.network]
  // Sends only where the config points: an RPC answering for another chain stops everything.
  const chainId = await chain.getChainId()
  if (chainId !== net.chain.id)
    throw new Error(`the RPC answers chain ${chainId}, but the config says ${net.label}; nothing was sent`)
  const account = await getAccount()
  await preview.recheck?.()
  checkLimit(config, preview.usd, now())
  const wallet = createWalletClient({
    account,
    chain: net.chain,
    transport: viemHttp(config.rpcUrl, {
      retryCount: 3,
      timeout: 30_000,
      fetchOptions: { headers: { 'user-agent': USER_AGENT } },
    }),
  })
  const done: StepResult[] = []
  let counted = false
  // Counted before the first thing leaves the machine, so a crash after a send cannot skip the limit.
  const count = () => {
    if (!counted) addSpend(preview.usd, now())
    counted = true
  }
  for (const step of preview.steps) {
    try {
      if (step.type === 'tx') {
        const req = { account: account.address, to: step.to, data: step.data, value: step.value }
        await chain.call(req)
        const est = ((await chain.estimateGas(req)) * 13n) / 10n
        const gas = step.gasFloor && step.gasFloor > est ? step.gasFloor : est
        count()
        const hash = await wallet.sendTransaction({ to: step.to, data: step.data, value: step.value, gas })
        const res: StepResult = { label: step.label, type: 'tx', hash, explorer: txUrl(hash, config.network) }
        done.push(res)
        const r = await chain.waitForTransactionReceipt({ hash, timeout: RECEIPT_TIMEOUT_MS }).catch((e) => {
          throw new ExecuteError(
            `${step.label}: sent ${hash} but no receipt yet (${reason(e)}); it may still land, check the explorer`,
            done,
          )
        })
        res.gasUsed = r.gasUsed.toString()
        if (r.status !== 'success')
          throw new ExecuteError(`${step.label}: transaction ${hash} reverted; later steps were not sent`, done)
      } else if (step.type === 'typedData') {
        const signature = await account.signTypedData(step.typedData)
        count()
        done.push({ label: step.label, type: 'typedData', result: await step.then(signature) })
      } else {
        count()
        done.push({ label: step.label, type: 'offchain', result: await step.run() })
      }
    } catch (e) {
      if (e instanceof ExecuteError) throw e
      throw new ExecuteError(
        `${step.label}: ${reason(e)}${done.length ? '; later steps were not sent' : '; nothing was sent'}`,
        done,
      )
    }
  }
  return { network: config.network, steps: done }
}
