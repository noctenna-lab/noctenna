import { expect, it } from 'vitest'
import {
  CurveRevert,
  getAmountIn,
  getAmountOut,
  quoteBuy,
  quoteSell,
  type CurveState,
} from '../../src/modules/pons/curve.js'
import { minAmountOut } from '../../src/modules/pons/trade.js'

const E18 = 10n ** 18n
// A fresh ETH curve: 1.05 ETH phantom quote, 1e9 tokens, 200M reserved for the pool, 1% fee, 2% creator tax.
const fresh: CurveState = {
  quoteReserve: (105n * E18) / 100n,
  tokenReserve: 1_000_000_000n * E18,
  reservedTokens: 200_000_000n * E18,
  feeBps: 100n,
  creatorTaxBps: 200n,
  graduated: false,
}

it('a buy pays fee and tax off the top and prices the rest on x*y=k', () => {
  const q = quoteBuy(fresh, E18 / 100n, 0n)
  expect(q.fee).toBe(E18 / 10_000n)
  expect(q.tax).toBe((2n * E18) / 10_000n)
  expect(q.tokensOut).toBe(getAmountOut(E18 / 100n - q.fee - q.tax, fresh.quoteReserve, fresh.tokenReserve))
  expect(q.clamped).toBe(false)
})

it('a buy past the threshold is clamped to the sellable tokens and spends only what that costs', () => {
  const q = quoteBuy(fresh, 100n * E18, 0n)
  expect(q.clamped).toBe(true)
  expect(q.graduates).toBe(true)
  expect(q.tokensOut).toBe(fresh.tokenReserve - fresh.reservedTokens)
  expect(q.spent).toBeLessThan(100n * E18)
  expect(q.refund).toBe(100n * E18 - q.spent)
})

it('the snipe tax is capped so at least 1% of the input still buys', () => {
  const q = quoteBuy(fresh, E18, 9_900n)
  expect(q.snipeBps).toBe(10_000n - 100n - 200n - 100n)
})

it('a sell pays the net of fee and tax; getAmountIn inverts getAmountOut', () => {
  const s = quoteSell(fresh, 1_000_000n * E18)
  expect(s.quoteOut).toBe(s.gross - s.fee - s.tax)
  const out = getAmountOut(E18, fresh.quoteReserve, fresh.tokenReserve)
  expect(getAmountIn(out, fresh.quoteReserve, fresh.tokenReserve)).toBeLessThanOrEqual(E18 + 1n)
  expect(() => quoteSell({ ...fresh, graduated: true }, 1n)).toThrow(CurveRevert)
  expect(() => quoteBuy(fresh, 0n, 0n)).toThrow(CurveRevert)
})

it('minimum out floors', () => {
  expect(minAmountOut(10_001n, 300)).toBe(9_700n)
  expect(minAmountOut(1n, 10)).toBe(0n)
})
