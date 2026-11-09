import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { beforeEach, expect, it, vi } from 'vitest'
import { allTools } from '../../src/core/server.js'
import { gooseBin, gooseEnv, gooseRoot, installGoose, writeGooseConfig } from '../../src/cli/goose.js'
import { banner, main } from '../../src/cli/main.js'

beforeEach(() => {
  process.env.NOCTENNA_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'noctenna-cli-'))
  process.env.NOCTENNA_KEYSTORE = 'file'
  process.env.NOCTENNA_KEYSTORE_PASSWORD = 'test-password'
})

it('writes a Goose profile where only execute asks, load_skill is refused and every built-in is off', () => {
  writeGooseConfig({ provider: 'compatible', model: 'my "model"', url: 'https://llm.example/v1' })
  const config = readFileSync(join(gooseRoot(), 'config', 'config.yaml'), 'utf8')
  expect(config).toContain('active_provider: openai')
  expect(config).toContain('model: "my \\"model\\""')
  expect(config).toContain('OPENAI_BASE_URL: "https://llm.example/v1"')
  expect(config).toMatch(/^GOOSE_MODE: approve$/m)
  for (const ext of ['developer', 'computercontroller', 'memory', 'extensionmanager'])
    expect(config).toMatch(new RegExp(`^  ${ext}: \\{ enabled: false,`, 'm'))
  const perm = readFileSync(join(gooseRoot(), 'config', 'permission.yaml'), 'utf8')
  const [allow, rest] = perm.split('  ask_before:')
  expect(allow).not.toContain('noctenna__execute')
  expect(rest).toMatch(/- noctenna__execute\n/)
  expect(rest).toMatch(/never_allow:\n {4}- load_skill/)
  for (const t of allTools()) if (t.name !== 'execute') expect(allow).toContain(`    - noctenna__${t.name}\n`)
})

it("keeps the user's own Goose and provider settings out of the session", () => {
  const env = gooseEnv({ provider: 'anthropic', model: 'm' }, 'sk-test', {
    PATH: '/bin',
    GOOSE_MODE: 'auto',
    OPENAI_HOST: 'https://evil.example',
    CONTEXT_FILE_NAMES: '["AGENTS.md"]',
    NOCTENNA_CONFIG_DIR: 'x',
  })
  expect(env).toEqual({
    PATH: '/bin',
    NOCTENNA_CONFIG_DIR: 'x',
    GOOSE_PATH_ROOT: gooseRoot(),
    CONTEXT_FILE_NAMES: '[]',
    ANTHROPIC_API_KEY: 'sk-test',
  })
  expect(isAbsolute(env.GOOSE_PATH_ROOT!)).toBe(true)
})

it('installs nothing when the Goose download does not match its pinned SHA-256', async () => {
  const fake = (async () => new Response('not goose')) as unknown as typeof fetch
  await expect(installGoose(fake)).rejects.toThrow(/does not match its pinned SHA-256/)
  expect(existsSync(gooseBin())).toBe(false)
})

it('opens the agent with the name in block letters, or the plain line when the terminal is too narrow', () => {
  expect(banner('testnet', 60, {})).toBeUndefined()
  const plain = banner('testnet', 100, { NO_COLOR: '1' })!
  expect(plain).not.toContain('\x1b')
  expect(plain).toContain('╚═╝  ╚═══╝ ╚═════╝')
  expect(plain).toContain('The open-source AI agent for Robinhood Chain.')
  expect(plain).toContain('Robinhood Chain testnet (46630). Information only, not financial advice.')
  expect(banner('testnet', 100, { COLORTERM: 'truecolor' })).toContain('\x1b[38;2;106;43;255m█')
  expect(banner('testnet', 100, {})).toMatch(/\x1b\[38;5;\d+m█/)
})

it('refuses keys, limits and the network outside an interactive terminal', async () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {})
  expect(process.stdin.isTTY && process.stdout.isTTY).toBeFalsy()
  await expect(main(['wallet', 'export'])).rejects.toThrow(/interactive terminal/)
  await expect(main(['wallet', 'import'])).rejects.toThrow(/interactive terminal/)
  await expect(main(['limit', '100000'])).rejects.toThrow(/interactive terminal/)
  await expect(main(['network', 'mainnet'])).rejects.toThrow(/interactive terminal/)
  await expect(main(['setup'])).rejects.toThrow(/interactive terminal/)
  await main(['wallet', 'address'])
  expect(log.mock.calls.map((c) => c[0])).toContain('No wallet yet: run `noctenna wallet create`.')
  expect(log.mock.calls[0]![0]).toMatch(
    /^Noctenna .* on Robinhood Chain mainnet \(4663\), read-only until the token launch\. Information only, not financial advice\.$/,
  )
  log.mockRestore()
})
