// The real Goose release against a fake OpenAI-compatible model: our server is the only extension, reads run without
// asking, and execute stops for an approval. Opt-in, because it downloads Goose (about 56 MB):
//   npm run build && GOOSE_E2E=1 npx vitest run test/cli/goose.e2e.test.ts
import { execFile } from 'node:child_process'
import { existsSync, mkdtempSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, it } from 'vitest'

const e2e = !!process.env.GOOSE_E2E
let server: Server
let tool = ''
let seenTools: string[] = []

beforeAll(async () => {
  if (!e2e) return
  process.env.NOCTENNA_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'noctenna-goose-'))
  process.env.NOCTENNA_KEYSTORE = 'file'
  process.env.NOCTENNA_KEYSTORE_PASSWORD = 'test-password'
  // First turn calls `tool`, the next one ends; non-streaming answers are enough for Goose's OpenAI client.
  server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      if (req.url!.endsWith('/models')) return res.end(JSON.stringify({ data: [{ id: 'fake', object: 'model' }] }))
      const j = JSON.parse(body)
      seenTools = j.tools.map((t: any) => t.function.name)
      const done = j.messages.at(-1).role === 'tool'
      const args = tool.endsWith('execute') ? { previewId: 'ab'.repeat(12) } : {}
      const message = done
        ? { role: 'assistant', content: 'done' }
        : {
            role: 'assistant',
            content: null,
            tool_calls: [{ id: 'c1', type: 'function', function: { name: tool, arguments: JSON.stringify(args) } }],
          }
      const chunk = (delta: object, finish: string | null) =>
        `data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 1, model: 'fake', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
      if (!j.stream)
        return res.end(
          JSON.stringify({
            id: 'x',
            object: 'chat.completion',
            created: 1,
            model: 'fake',
            choices: [{ index: 0, message, finish_reason: done ? 'stop' : 'tool_calls' }],
          }),
        )
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const delta = done
        ? message
        : { role: 'assistant', tool_calls: message.tool_calls!.map((t, index) => ({ index, ...t })) }
      res.end(chunk(delta, null) + chunk({}, done ? 'stop' : 'tool_calls') + 'data: [DONE]\n\n')
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
}, 120_000)

afterAll(() => server?.close())

async function run(t: string) {
  tool = t
  const g = await import('../../dist/cli/goose.js')
  const p = {
    provider: 'compatible' as const,
    model: 'fake',
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
  }
  g.saveProfile(p)
  g.writeGooseConfig(p)
  if (!existsSync(g.gooseBin())) await g.installGoose()
  // A user's exported GOOSE_MODE=auto must not survive into the session.
  const env = g.gooseEnv(p, 'sk-fake', { ...process.env, GOOSE_MODE: 'auto' })
  // Async on purpose: the fake model answers from this same process.
  return new Promise<{ status: number; stdout: string; stderr: string }>((done) =>
    execFile(
      g.gooseBin(),
      g.gooseArgs('run', ['-t', 'go']),
      { cwd: g.gooseRoot(), env, timeout: 120_000 },
      (e, stdout, stderr) => done({ status: e ? Number(e.code ?? 1) : 0, stdout, stderr }),
    ),
  )
}

it.skipIf(!e2e)(
  'runs read tools without asking and offers only Noctenna tools',
  async () => {
    const r = await run('noctenna__status')
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('Robinhood Chain testnet (46630)')
    expect(seenTools.filter((n) => !n.startsWith('noctenna__'))).toEqual(['load_skill'])
  },
  300_000,
)

it.skipIf(!e2e)(
  'refuses load_skill and stops execute for an approval',
  async () => {
    expect((await run('load_skill')).stdout).toContain('declined to run this tool')
    const r = await run('noctenna__execute')
    expect(r.status).not.toBe(0)
    expect(r.stderr).toContain('Tool approval required')
  },
  300_000,
)
