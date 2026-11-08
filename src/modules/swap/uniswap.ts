// Uniswap v4 direct: the fallback route for a graduated Pons token's own ETH pool (currency0 = native ETH, currency1 =
// the token, hooks = the Pons memeHook), through Universal Router 2.1.2 on mainnet.
//
// Evidence: addresses from the official Uniswap deployments list for 4663 (test/swap/verified/), with code and wiring
// checked on a fork. Command and action bytes come from the verified UR 2.1.2 sources in test/swap/verified/, and a
// unit test checks every value below against them. Testnet has the PoolManager but no Universal Router.
import {
  encodeAbiParameters,
  encodeFunctionData,
  erc20Abi,
  isAddressEqual,
  keccak256,
  parseAbi,
  parseAbiParameters,
  toHex,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem'
import { ETH, MEME_HOOK } from '../pons/abi.js'

export const POOL_MANAGER: Address = '0x8366a39CC670B4001A1121B8F6A443A643e40951'
export const UNIVERSAL_ROUTER: Address = '0x204FAca1764B154221e35c0d20aBb3c525710498'
export const V4_QUOTER: Address = '0x8Dc178eFB8111BB0973Dd9d722ebeFF267c98F94'
export const PERMIT2: Address = '0x000000000022D473030F116dDEE9F6B43aC78BA3'
export const STATE_VIEW: Address = '0xf3334192d15450cdd385c8b70e03f9a6bd9e673b'

// Universal Router 2.1.2, contracts/libraries/Commands.sol; v4-periphery src/libraries/Actions.sol
export const COMMAND = { V4_SWAP: 0x10 } as const
export const ACTION = { SWAP_EXACT_IN_SINGLE: 0x06, SETTLE_ALL: 0x0c, TAKE_ALL: 0x0f } as const
export const DEADLINE_SECONDS = 1_200n
export const PERMIT2_EXPIRY_SECONDS = 1_800 // the exact amount is consumed by the swap anyway

const POOL_KEY = '(address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks)'
export const poolKeyParams = parseAbiParameters(
  'address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks',
)
export const quoterAbi = parseAbi([
  `function quoteExactInputSingle((${POOL_KEY} poolKey, bool zeroForOne, uint128 exactAmount, bytes hookData) params) returns (uint256 amountOut, uint256 gasEstimate)`,
])
export const routerAbi = parseAbi(['function execute(bytes commands, bytes[] inputs, uint256 deadline) payable'])
export const v4SwapInputParams = parseAbiParameters('bytes actions, bytes[] params')
// IV4Router.ExactInputSingleParams in 2.1.2 has minHopPriceX36.
export const exactInputSingleParams = parseAbiParameters(
  `(${POOL_KEY} poolKey, bool zeroForOne, uint128 amountIn, uint128 amountOutMinimum, uint256 minHopPriceX36, bytes hookData)`,
)
export const currencyAmountParams = parseAbiParameters('address currency, uint256 amount') // SETTLE_ALL (max) and TAKE_ALL (min)
export const permit2Abi = parseAbi([
  'function approve(address token, address spender, uint160 amount, uint48 expiration)',
  'function allowance(address owner, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)',
])
export const hookAbi = parseAbi([
  'function launches(bytes32 poolId) view returns (bool registered, bool memecoinIsCurrency0, address memecoin, address quoteToken, address creator, address buybackCreatorRecipient, address protocolFeeRecipient, uint16 creatorTaxBps, uint16 protocolFeeShareBps, uint16 buybackBurnBps, uint16 hookFeeBps, uint16 maxInternalPriceImpactBps, bool buybackEnabled)',
])

export type PoolKey = { currency0: Address; currency1: Address; fee: number; tickSpacing: number; hooks: Address }
export const poolKeyOf = (token: Address, fee: number, tickSpacing: number): PoolKey => ({
  currency0: ETH,
  currency1: token,
  fee,
  tickSpacing,
  hooks: MEME_HOOK,
})
export const poolIdOf = (k: PoolKey): Hex =>
  keccak256(encodeAbiParameters(poolKeyParams, [k.currency0, k.currency1, k.fee, k.tickSpacing, k.hooks]))

// execute(V4_SWAP, [SWAP_EXACT_IN_SINGLE, SETTLE_ALL(in, amountIn), TAKE_ALL(out, minOut)]). TAKE_ALL pays msgSender,
// so the router has no recipient to get wrong. No SWEEP: Pons graduation mints a full-range position, so an exact-in
// swap never stops at the price limit and always settles the whole input.
export function encodePoolSwap(
  key: PoolKey,
  zeroForOne: boolean,
  amountIn: bigint,
  minOut: bigint,
  deadline: bigint,
): Hex {
  const [currencyIn, currencyOut] = zeroForOne ? [key.currency0, key.currency1] : [key.currency1, key.currency0]
  const actions = toHex(new Uint8Array([ACTION.SWAP_EXACT_IN_SINGLE, ACTION.SETTLE_ALL, ACTION.TAKE_ALL]))
  const params = [
    encodeAbiParameters(exactInputSingleParams, [
      { poolKey: key, zeroForOne, amountIn, amountOutMinimum: minOut, minHopPriceX36: 0n, hookData: '0x' },
    ]),
    encodeAbiParameters(currencyAmountParams, [currencyIn, amountIn]),
    encodeAbiParameters(currencyAmountParams, [currencyOut, minOut]),
  ]
  const input = encodeAbiParameters(v4SwapInputParams, [actions, params])
  return encodeFunctionData({
    abi: routerAbi,
    functionName: 'execute',
    args: [toHex(new Uint8Array([COMMAND.V4_SWAP])), [input], deadline],
  })
}

export interface PoolQuote {
  amountOut: bigint
  minOut: bigint
  hookFeeBps: number
  creatorTaxBps: number
  steps: { label: string; to: Address; data: Hex; value: bigint }[]
}

// A buy (ETH in) or sell (token in) on a graduated Pons token's pool, for `account`, with exact approvals:
// token -> Permit2, then Permit2 -> Universal Router, both for this amount only.
export async function quotePonsPool(
  chain: PublicClient,
  p: {
    token: Address
    poolFee: number
    tickSpacing: number
    side: 'buy' | 'sell'
    amountIn: bigint
    slippageBps: number
    account: Address
  },
): Promise<PoolQuote> {
  const key = poolKeyOf(p.token, p.poolFee, p.tickSpacing)
  const poolId = poolIdOf(key)
  const block = await chain.getBlock()
  const [info, erc20Allowance, [p2Amount, p2Expiration]] = await chain.multicall({
    allowFailure: false,
    blockNumber: block.number,
    contracts: [
      { address: MEME_HOOK, abi: hookAbi, functionName: 'launches', args: [poolId] },
      { address: p.token, abi: erc20Abi, functionName: 'allowance', args: [p.account, PERMIT2] },
      { address: PERMIT2, abi: permit2Abi, functionName: 'allowance', args: [p.account, p.token, UNIVERSAL_ROUTER] },
    ],
  })
  const [registered, memecoinIsCurrency0, memecoin, quoteToken, , , , creatorTaxBps, , , hookFeeBps] = info
  if (!registered || memecoinIsCurrency0 || !isAddressEqual(memecoin, p.token) || !isAddressEqual(quoteToken, ETH))
    throw new Error('this token has no ETH pool on Uniswap v4 that Noctenna can route')
  const zeroForOne = p.side === 'buy'
  const r = await chain.simulateContract({
    address: V4_QUOTER,
    abi: quoterAbi,
    functionName: 'quoteExactInputSingle',
    args: [{ poolKey: key, zeroForOne, exactAmount: p.amountIn, hookData: '0x' }],
    account: p.account,
    blockNumber: block.number,
  })
  const amountOut = r.result[0]
  const minOut = (amountOut * (10_000n - BigInt(p.slippageBps))) / 10_000n
  if (minOut === 0n) throw new Error('the amount is too small to quote')
  const steps: PoolQuote['steps'] = []
  if (!zeroForOne) {
    if (erc20Allowance < p.amountIn)
      steps.push({
        label: 'Approve Permit2 for exactly this amount',
        to: p.token,
        data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [PERMIT2, p.amountIn] }),
        value: 0n,
      })
    if (p2Amount < p.amountIn || BigInt(p2Expiration) < block.timestamp + 60n) {
      const expiration = Number(block.timestamp) + PERMIT2_EXPIRY_SECONDS
      steps.push({
        label: 'Allow the Universal Router this amount through Permit2',
        to: PERMIT2,
        data: encodeFunctionData({
          abi: permit2Abi,
          functionName: 'approve',
          args: [p.token, UNIVERSAL_ROUTER, p.amountIn, expiration],
        }),
        value: 0n,
      })
    }
  }
  const data = encodePoolSwap(key, zeroForOne, p.amountIn, minOut, block.timestamp + DEADLINE_SECONDS)
  steps.push({
    label: zeroForOne ? 'Buy in the Uniswap v4 pool' : 'Sell in the Uniswap v4 pool',
    to: UNIVERSAL_ROUTER,
    data,
    value: zeroForOne ? p.amountIn : 0n,
  })
  return { amountOut, minOut, hookFeeBps, creatorTaxBps, steps }
}
