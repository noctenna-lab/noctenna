// A fake ctx for module tests: http answers from recorded fixtures, nothing touches the network or a chain.
import { createPublicKey, verify } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { PublicClient } from 'viem'
import type { Ctx, Network } from '../../src/core/types.js'

export const ANVIL0 = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' // anvil's public dev key
export const ANVIL0_ADDRESS = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'

export const fixture = (dir: string, name: string) =>
  JSON.parse(readFileSync(join(import.meta.dirname, '..', dir, 'fixtures', name), 'utf8'))

export type Call = { url: string; method: string; headers: Headers; body?: string }

export function fakeCtx(route: (url: string, call: Call) => unknown, network: Network = 'testnet', slippageBps = 300) {
  const calls: Call[] = []
  const http = async (url: string, init: RequestInit = {}) => {
    const call = {
      url,
      method: init.method ?? 'GET',
      headers: new Headers(init.headers),
      body: init.body as string | undefined,
    }
    calls.push(call)
    const r = await route(url, call)
    if (r instanceof Response) return r
    if (r === undefined) return new Response('{"error":"not found"}', { status: 404 })
    return new Response(JSON.stringify(r), { status: 200 })
  }
  const ctx: Ctx = {
    config: { network, rpcUrl: 'http://127.0.0.1:1', dailyLimitUsd: 200, slippageBps },
    address: ANVIL0_ADDRESS,
    http,
    chain: {} as PublicClient,
  }
  return { ctx, calls }
}

/** Verifies with OpenSSL (node:crypto), a second Ed25519 implementation next to noble's. */
export const opensslVerify = (msg: string, sigHex: string, pkHex: string) =>
  verify(
    null,
    Buffer.from(msg),
    createPublicKey({
      key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(pkHex, 'hex')]),
      format: 'der',
      type: 'spki',
    }),
    Buffer.from(sigHex, 'hex'),
  )
