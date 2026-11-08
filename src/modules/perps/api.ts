// Shared by perps, radar and bridge: JSON over ctx.http, and third-party JSON turned into data the model can read
// but never mistake for instructions.
import type { z } from 'zod'
import type { Ctx, Tool, Untrusted } from '../../core/types.js'

/** Gives `run` its argument types from `input`. */
export const tool = <S extends z.ZodTypeAny>(t: Tool<S>) => t

export async function json<T>(ctx: Ctx, url: string, init?: RequestInit): Promise<T> {
  const res = await ctx.http(url, init)
  const body = await res.text()
  // The server quotes thrown messages as untrusted, so the venue's own error text can ride along.
  if (!res.ok) throw new Error(`${new URL(url).host} answered HTTP ${res.status}: ${body.slice(0, 300)}`)
  return JSON.parse(body) as T
}

export const u = (s: unknown): Untrusted => ({ untrusted: String(s) })

// Numbers stay numbers; every other string becomes Untrusted. Long digit strings (ids, nanosecond times) stay
// strings, because Number() would round them.
export function clean(v: unknown): unknown {
  if (typeof v === 'string') return /^-?\d{1,15}(\.\d+)?$/.test(v) ? Number(v) : u(v)
  if (Array.isArray(v)) return v.map(clean)
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clean(x)]))
  return v
}

/** A label from an API is shown in a summary only if it is plainly a ticker or chain name; otherwise the caller falls back. */
export const plain = (s: unknown): string | null =>
  typeof s === 'string' && /^[A-Za-z0-9 .-]{1,32}$/.test(s) ? s : null

export const round = (x: number, d = 2) => Math.round(x * 10 ** d) / 10 ** d
