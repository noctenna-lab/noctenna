// Noctenna as a terminal agent: a Goose session on a profile of our own. Goose is the official release, pinned and
// checked by SHA-256, in a bin dir Noctenna owns; its config, data and state live under GOOSE_PATH_ROOT in our
// config dir, so a Goose setup of the user's own is never read or changed.
import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { configDir } from '../core/config.js'
import { INSTRUCTIONS } from '../core/instructions.js'
import { allTools } from '../core/server.js'
import { secretGet } from '../core/wallet.js'

export const GOOSE_VERSION = '1.57.0'
// SHA-256 of the official v1.57.0 release archives, as GitHub reports them for the uploaded assets (8 Nov 2026).
const ASSETS: Record<string, { file: string; sha256: string }> = {
  'darwin-arm64': {
    file: 'goose-aarch64-apple-darwin.tar.gz',
    sha256: '80d43c49b77302777e9d2fe32faf3c40c1028dafbea1e0a39b0378404a8a074b',
  },
  'darwin-x64': {
    file: 'goose-x86_64-apple-darwin.tar.gz',
    sha256: '5ad5594246841c759b34966e09ca421c09151b589183a8f1720e15e8395834ae',
  },
  'linux-arm64': {
    file: 'goose-aarch64-unknown-linux-gnu.tar.gz',
    sha256: 'c32605acfd560aeb2adbf17ec359cc0217e28022a7e647b35a6af5dcfca91749',
  },
  'linux-x64': {
    file: 'goose-x86_64-unknown-linux-gnu.tar.gz',
    sha256: '10eb96cb6a159b6e1d38eeedbef6ab64cd28168aad91948f1fa5c34eefdf98e3',
  },
  'win32-x64': {
    file: 'goose-x86_64-pc-windows-msvc.zip',
    sha256: '1ab2117ceec37f95be4d3ad0cdb921d3e97fd8b0fa244046631ecf4b7619d502',
  },
}

// In the order setup offers them, the ones with a free key first
export const PROVIDERS = {
  google: {
    label: 'Google Gemini',
    note: 'free key, no card',
    keyUrl: 'https://aistudio.google.com/apikey',
    goose: 'google',
    keyEnv: 'GOOGLE_API_KEY',
  },
  openrouter: {
    label: 'OpenRouter',
    note: 'free models, 50 requests a day',
    keyUrl: 'https://openrouter.ai/keys',
    goose: 'openrouter',
    keyEnv: 'OPENROUTER_API_KEY',
  },
  anthropic: {
    label: 'Anthropic (Claude)',
    note: 'paid',
    keyUrl: 'https://platform.claude.com/settings/keys',
    goose: 'anthropic',
    keyEnv: 'ANTHROPIC_API_KEY',
  },
  openai: {
    label: 'OpenAI',
    note: 'paid',
    keyUrl: 'https://platform.openai.com/api-keys',
    goose: 'openai',
    keyEnv: 'OPENAI_API_KEY',
  },
  compatible: {
    label: 'Any OpenAI-compatible URL',
    goose: 'openai',
    keyEnv: 'OPENAI_API_KEY',
    hostKey: 'OPENAI_BASE_URL',
  },
  ollama: { label: 'Ollama on this computer', goose: 'ollama', hostKey: 'OLLAMA_HOST' },
} as const
export type ProviderId = keyof typeof PROVIDERS
export const OLLAMA_URL = 'http://localhost:11434'

/** The provider's refusal of a key, which setup answers by asking for the key again. */
export class KeyRefused extends Error {}

// The models a key can use, read from the provider: setup lists them instead of asking for a name, and a wrong key
// shows up here rather than in the first chat. Embedding, speech, image and realtime models are left out.
export async function listModels(
  provider: ProviderId,
  key: string | null,
  url?: string,
  get: typeof fetch = fetch,
): Promise<string[]> {
  const json = async <T>(href: string, headers: Record<string, string> = {}): Promise<T> => {
    const res = await get(href, { headers, signal: AbortSignal.timeout(15_000) })
    if (res.status === 400 || res.status === 401 || res.status === 403)
      throw new KeyRefused('the provider refused this API key')
    if (!res.ok) throw new Error(`the provider answered ${res.status}`)
    return (await res.json()) as T
  }
  const bearer: Record<string, string> = key ? { authorization: `Bearer ${key}` } : {}
  type Listed = { data: { id: string; supported_parameters?: string[] }[] }
  let ids: string[]
  if (provider === 'google') {
    const q = `pageSize=1000&key=${encodeURIComponent(key ?? '')}`
    const d = await json<{ models?: { name: string; supportedGenerationMethods?: string[] }[] }>(
      `https://generativelanguage.googleapis.com/v1beta/models?${q}`,
    )
    ids = (d.models ?? [])
      .filter((m) => m.supportedGenerationMethods?.includes('generateContent'))
      .map((m) => m.name.replace(/^models\//, ''))
  } else if (provider === 'openrouter') {
    await json('https://openrouter.ai/api/v1/key', bearer)
    const d = await json<Listed>('https://openrouter.ai/api/v1/models')
    ids = d.data.filter((m) => m.id === 'openrouter/free' || m.supported_parameters?.includes('tools')).map((m) => m.id)
  } else if (provider === 'anthropic') {
    const headers = { 'x-api-key': key ?? '', 'anthropic-version': '2023-06-01' }
    ids = (await json<Listed>('https://api.anthropic.com/v1/models?limit=1000', headers)).data.map((m) => m.id)
  } else if (provider === 'ollama') {
    const d = await json<{ models?: { name: string }[] }>(`${url ?? OLLAMA_URL}/api/tags`)
    ids = (d.models ?? []).map((m) => m.name)
  } else {
    const base = provider === 'openai' ? 'https://api.openai.com/v1' : url
    ids = (await json<Listed>(`${base}/models`, bearer)).data.map((m) => m.id)
  }
  return ids.filter((id) => !/embed|tts|audio|image|live|realtime|transcribe|whisper|dall-e|moderation|aqa/i.test(id))
}

// The order setup shows models in: free or cheap ones that call tools well first, newer versions before older
const PREFER: Record<ProviderId, RegExp[]> = {
  google: [/^gemini-[\d.]+-flash$/, /^gemini-[\d.]+-pro$/, /^gemini-[\d.]+-flash-lite$/, /^gemini-/],
  openrouter: [/^openrouter\/free$/, /:free$/, /^anthropic\/claude-sonnet/, /^google\/gemini-[\d.]+-flash$/],
  anthropic: [/^claude-sonnet/, /^claude-opus/, /^claude-haiku/],
  openai: [/^gpt-[\d.]+-mini$/, /^gpt-[\d.]+$/],
  compatible: [/./],
  ollama: [/./],
}
const versionOf = (id: string) => Number(id.match(/\d+(?:\.\d+)?/)?.[0] ?? 0)

export function shortlist(provider: ProviderId, ids: string[], n = 9): string[] {
  const out: string[] = []
  for (const re of PREFER[provider])
    out.push(
      ...ids
        .filter((id) => re.test(id) && !out.includes(id))
        .sort((a, b) => versionOf(b) - versionOf(a) || a.localeCompare(b)),
    )
  return out.slice(0, n)
}
export interface Profile {
  provider: ProviderId
  model: string
  url?: string
}

/** The model key lives in the OS keychain next to the wallet, and reaches Goose only as an env var of its process. */
export const MODEL_KEY = 'model-api-key'
export const gooseRoot = () => resolve(configDir(), 'goose')
export const gooseBin = () => join(configDir(), 'bin', process.platform === 'win32' ? 'goose.exe' : 'goose')
const profilePath = () => join(gooseRoot(), 'noctenna-profile.json')

export function saveProfile(p: Profile) {
  mkdirSync(gooseRoot(), { recursive: true, mode: 0o700 })
  writeFileSync(profilePath(), JSON.stringify(p, null, 2) + '\n', { mode: 0o600 })
}

export function readProfile(): Profile | null {
  try {
    return JSON.parse(readFileSync(profilePath(), 'utf8')) as Profile
  } catch {
    return null
  }
}

const template = (name: string) =>
  readFileSync(fileURLToPath(new URL(`../../profile/${name}`, import.meta.url)), 'utf8')

// Rewritten on every start: new tools get their permission line, and an "always allow" given to execute in a past
// session does not outlive it.
export function writeGooseConfig(p: Profile, toolNames = allTools().map((t) => t.name)) {
  const def = PROVIDERS[p.provider]
  const host = 'hostKey' in def && p.url ? `${def.hostKey}: ${JSON.stringify(p.url)}` : ''
  const config = template('config.yaml')
    .replaceAll('{{provider}}', def.goose)
    .replace('{{model}}', JSON.stringify(p.model))
    .replace('{{host}}', host)
  const allow = toolNames.filter((n) => n !== 'execute').map((n) => `    - noctenna__${n}`)
  const dir = join(gooseRoot(), 'config')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  writeFileSync(join(dir, 'config.yaml'), config, { mode: 0o600 })
  writeFileSync(
    join(dir, 'permission.yaml'),
    template('permission.yaml').replace('{{always_allow}}', allow.join('\n')),
    { mode: 0o600 },
  )
}

// The user's own Goose and provider settings must not leak in: an exported GOOSE_MODE=auto would skip approvals and
// OPENAI_HOST would redirect the model. Context files (.goosehints, AGENTS.md) are off, so no project can add prompts.
export function gooseEnv(p: Profile, key: string | null, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = Object.fromEntries(
    Object.entries(base).filter(
      ([k]) => !/^(GOOSE_|OPENAI_|ANTHROPIC_|GOOGLE_|OPENROUTER_|OLLAMA_)|^CONTEXT_FILE_NAMES$/.test(k),
    ),
  )
  env.GOOSE_PATH_ROOT = gooseRoot()
  env.CONTEXT_FILE_NAMES = '[]'
  const def = PROVIDERS[p.provider]
  if ('keyEnv' in def && key) env[def.keyEnv] = key
  return env
}

export async function installGoose(get: typeof fetch = fetch): Promise<string> {
  const asset = ASSETS[`${process.platform}-${process.arch}`]
  if (!asset)
    throw new Error(
      `there is no official Goose ${GOOSE_VERSION} build for ${process.platform}-${process.arch}; install Goose yourself and place it at ${gooseBin()}`,
    )
  const res = await get(`https://github.com/aaif-goose/goose/releases/download/v${GOOSE_VERSION}/${asset.file}`)
  if (!res.ok) throw new Error(`downloading Goose failed: HTTP ${res.status}`)
  if (res.url && !res.url.startsWith('https://'))
    throw new Error('the Goose download left HTTPS; nothing was installed')
  const bytes = Buffer.from(await res.arrayBuffer())
  const sha = createHash('sha256').update(bytes).digest('hex')
  if (sha !== asset.sha256)
    throw new Error(`the Goose download does not match its pinned SHA-256 (got ${sha}); nothing was installed`)
  const bin = dirname(gooseBin())
  mkdirSync(bin, { recursive: true, mode: 0o700 })
  const tmp = mkdtempSync(join(bin, '.install-'))
  try {
    const archive = join(tmp, asset.file)
    writeFileSync(archive, bytes)
    const out = join(tmp, 'out')
    mkdirSync(out)
    // tar reads .tar.gz on macOS and Linux, and .zip on Windows 10+ (bsdtar).
    execFileSync('tar', ['-xf', archive, '-C', out])
    const exe = process.platform === 'win32' ? 'goose.exe' : 'goose'
    const from = existsSync(join(out, exe)) ? out : join(out, 'goose-package')
    if (!existsSync(join(from, exe))) throw new Error('the Goose archive has no goose binary')
    // Windows builds ship DLLs next to the binary, so the whole folder moves.
    for (const f of readdirSync(from)) renameSync(join(from, f), join(bin, f))
    chmodSync(gooseBin(), 0o755)
    return gooseBin()
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

// --no-profile: only the extension named here loads, so no built-in or plugin can join, whatever Goose ships later.
export function gooseArgs(command: 'session' | 'run', extra: string[] = []) {
  const main = join(dirname(fileURLToPath(import.meta.url)), 'main.js')
  if ((process.execPath + main).includes('"'))
    throw new Error('the path to node or noctenna contains a double quote, which Goose cannot pass on')
  return [
    command,
    '--no-profile',
    '--with-extension',
    `noctenna:"${process.execPath}" "${main}" mcp`,
    '--system',
    INSTRUCTIONS,
    ...extra,
  ]
}

export async function launch(): Promise<number> {
  const p = readProfile()
  if (!p) throw new Error('no model chosen yet: run `noctenna setup` first')
  const key = await secretGet(MODEL_KEY)
  if ('keyEnv' in PROVIDERS[p.provider] && p.provider !== 'compatible' && !key)
    throw new Error('no model API key stored: run `noctenna setup`')
  writeGooseConfig(p)
  if (!existsSync(gooseBin())) {
    console.log(`Installing Goose ${GOOSE_VERSION} (official release, SHA-256 checked) into ${dirname(gooseBin())} ...`)
    await installGoose()
  }
  const work = join(gooseRoot(), 'work')
  mkdirSync(work, { recursive: true })
  const child = spawn(gooseBin(), gooseArgs('session'), {
    cwd: work,
    env: gooseEnv(p, key),
    stdio: 'inherit',
  })
  // Ctrl-C belongs to Goose (it stops the model's turn); this process just waits.
  const ignore = () => {}
  process.on('SIGINT', ignore)
  return new Promise((done) =>
    child.on('exit', (code) => {
      process.off('SIGINT', ignore)
      done(code ?? 1)
    }),
  )
}
