// Exact integer port of PonsV2BondingCurve.buy/sell pricing (PonsV2BondingCurve.sol:438-566)
// and PonsV2BondingCurveMath.getAmountOut/getAmountIn (PonsV2BondingCurveMath.sol:25-87), proven equal to
// the wei against eth_call and real transactions on 6 live curves (72 checks) and in the FORK=1 tests.
// All math is bigint; every division floors like Solidity unless marked ceil.
const BPS = 10_000n

export class CurveRevert extends Error {}

// PonsV2BondingCurveMath.getAmountOut with feeBps = 0 (the curve always passes 0).
export function getAmountOut(amountIn: bigint, reserveIn: bigint, reserveOut: bigint): bigint {
  if (amountIn === 0n) throw new CurveRevert('InsufficientInputAmount')
  if (reserveIn === 0n || reserveOut === 0n) throw new CurveRevert('InsufficientLiquidity')
  const inWithFee = amountIn * BPS
  const out = (inWithFee * reserveOut) / (reserveIn * BPS + inWithFee)
  if (out === 0n) throw new CurveRevert('InsufficientOutputAmount')
  return out
}

// PonsV2BondingCurveMath.getAmountIn with feeBps = 0.
export function getAmountIn(amountOut: bigint, reserveIn: bigint, reserveOut: bigint): bigint {
  if (amountOut === 0n) throw new CurveRevert('InsufficientOutputAmount')
  if (reserveIn === 0n || reserveOut <= amountOut) throw new CurveRevert('InsufficientLiquidity')
  return (amountOut * reserveIn * BPS) / ((reserveOut - amountOut) * BPS) + 1n
}

export interface CurveState {
  quoteReserve: bigint // getReserves()[0]: phantom + trackedQuote - quoteFeeBalance - creatorTaxBalance
  tokenReserve: bigint // getReserves()[1] == trackedTokens
  reservedTokens: bigint
  feeBps: bigint
  creatorTaxBps: bigint
  graduated: boolean
}

// buy(quoteIn, minTokensOut, recipient) for a native-ETH curve; snipe = currentSnipeTaxBps(recipient) at execution.
export function quoteBuy(s: CurveState, quoteIn: bigint, snipe: bigint) {
  if (s.graduated) throw new CurveRevert('CurveGraduated')
  if (quoteIn === 0n) throw new CurveRevert('ZeroAmount')
  if (snipe !== 0n) {
    const max = BPS - s.feeBps - s.creatorTaxBps - 100n
    if (snipe > max) snipe = max
  }
  let spent = quoteIn
  let fee = (spent * s.feeBps) / BPS
  let tax = (spent * s.creatorTaxBps) / BPS
  let snipeTax = (spent * snipe) / BPS
  let tokensOut = getAmountOut(spent - fee - tax - snipeTax, s.quoteReserve, s.tokenReserve)
  const sellable = s.tokenReserve > s.reservedTokens ? s.tokenReserve - s.reservedTokens : 0n
  if (sellable === 0n) throw new CurveRevert('CurveGraduated')
  let clamped = false
  if (tokensOut > sellable) {
    clamped = true
    tokensOut = sellable
    const net = getAmountIn(sellable, s.quoteReserve, s.tokenReserve)
    const den = BPS - s.feeBps - s.creatorTaxBps - snipe
    const grossed = (net * BPS + den - 1n) / den // Math.mulDiv(..., Rounding.Ceil)
    spent = grossed < quoteIn ? grossed : quoteIn
    fee = (spent * s.feeBps) / BPS
    tax = (spent * s.creatorTaxBps) / BPS
    snipeTax = (spent * snipe) / BPS
  }
  // CurveBuy(buyer, recipient, quoteIn = spent, tokensOut, fee = fee + snipeTax, tax); refund goes to msg.sender.
  return {
    tokensOut,
    spent,
    refund: quoteIn - spent,
    fee,
    tax,
    snipeTax,
    snipeBps: snipe,
    clamped,
    graduates: tokensOut === sellable,
  }
}

// sell(tokensIn, minQuoteOut, recipient); readyToGraduate = sellableTokens() == 0 && !graduated.
export function quoteSell(s: CurveState, tokensIn: bigint) {
  const sellable = s.tokenReserve > s.reservedTokens ? s.tokenReserve - s.reservedTokens : 0n
  if (s.graduated || sellable === 0n) throw new CurveRevert('CurveGraduated')
  if (tokensIn === 0n) throw new CurveRevert('ZeroAmount')
  const gross = getAmountOut(tokensIn, s.tokenReserve, s.quoteReserve)
  const fee = (gross * s.feeBps) / BPS
  const tax = (gross * s.creatorTaxBps) / BPS
  return { quoteOut: gross - fee - tax, gross, fee, tax }
}
