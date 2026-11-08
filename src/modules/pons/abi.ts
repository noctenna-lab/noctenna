// Pons V2 addresses and ABIs. Every topic and selector is computed from these signatures; none is typed by hand.
//
// Evidence:
// - mainnet: factory, launch router and memeHook are Sourcify exact matches; the factory was deployed at block
//   26,841,846 by 0xfdde5a1e3cdf791da71e49f817d70c7ced72cc36. Curve ABIs come from PonsV2BondingCurve.sol. Curves are
//   never constants: each is read from factory.getLaunchedToken(token).curve.
// - testnet: no Pons at the mainnet addresses. 0xdccc78…20e7 emits the same TokenLaunched event and has the
//   mainnet factory's 24,177-byte code except 698 bytes in 35 runs (immutables); deployed at block 143,973,822 by
//   0x3dcc041bdab1313e72a0ca185af6e651ac379530, a different deployer, unverified (checked 8 Nov 2026). Testnet
//   value only, so curve trades are allowed there; its pools cannot be traded (testnet has no Universal Router).
import { getAbiItem, parseAbi, toEventSelector, type Address } from 'viem'
import type { Network } from '../../core/types.js'

export const PONS: Record<Network, { factory: Address; deployBlock: bigint; launchRouter?: Address }> = {
  mainnet: {
    factory: '0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e',
    deployBlock: 26_841_846n,
    launchRouter: '0xe33e9e479df8802cb0866d5d05258bec4cf62948',
  },
  testnet: { factory: '0xdccc78791547926dae1fdc09e54235a9cfbf20e7', deployBlock: 143_973_822n },
}
export const MEME_HOOK: Address = '0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044' // mainnet
export const ETH: Address = '0x0000000000000000000000000000000000000000' // Pons "pairToken = ETH", v4 native currency

// GraduationPhase (ILaunchpadV2.sol): 0 curve trading, 1 swept to the factory (curve closed, no pool yet), 2 pool open.
export const PHASE = { CURVE: 0, SWEPT: 1, POOL: 2 } as const
export const PHASE_NAME = ['curve', 'graduating (curve closed, pool not open yet)', 'pool'] as const

// Never trade a launch younger than this (block time), whatever its snipe terms: second 0 costs ~97%.
export const SNIPE_GUARD_SECONDS = 3n
// A buy that becomes the graduation-crossing buy needs a gas limit of about 334k (fork: 299k used, 334,075 fails);
// an estimate from the state before it only sees the ~100k non-crossing path. Only gas used is charged.
export const CURVE_BUY_GAS_FLOOR = 500_000n

const SOCIALS = 'struct Socials { string twitter; string telegram; string discord; string website; string farcaster; }'

export const factoryAbi = parseAbi([
  'event TokenLaunched(address indexed token, address indexed curve, address indexed deployer, address pairToken, uint256 launchConfigId, uint256 graduationThreshold)',
  'struct LaunchedToken { address token; address curve; address deployer; address creatorFeeRecipient; address pairToken; uint256 graduationThreshold; uint24 poolFee; int24 tickSpacing; uint16 creatorTaxBps; bool buybackEnabled; uint8 phase; uint256 sweptQuote; uint256 sweptTokens; uint256 sweptAt; bool exists; }',
  'function getLaunchedToken(address token) view returns (LaunchedToken)',
  'struct LaunchConfig { uint256 supply; uint256 curveFeeBps; uint256 phantomQuote; uint256 graduationThreshold; uint24 poolFee; int24 tickSpacing; bool enabled; }',
  'function getLaunchConfig(uint256 id) view returns (LaunchConfig)',
])

export const curveAbi = parseAbi([
  'event CurveBuy(address indexed buyer, address indexed recipient, uint256 quoteIn, uint256 tokensOut, uint256 fee, uint256 tax)',
  'event CurveBuyRefunded(address indexed buyer, uint256 refund)',
  'event CurveSell(address indexed seller, address indexed recipient, uint256 tokensIn, uint256 quoteOut, uint256 fee, uint256 tax)',
  'event SnipeTaxExempted(address indexed account)',
  'function getReserves() view returns (uint256 quoteReserve_, uint256 tokenReserve_)',
  'function reservedTokens() view returns (uint256)',
  'function phantomQuote() view returns (uint256)',
  'function feeBps() view returns (uint256)',
  'function creatorTaxBps() view returns (uint256)',
  'function graduated() view returns (bool)',
  'function readyToGraduate() view returns (bool)',
  'function launchedAt() view returns (uint256)',
  'function snipeTaxSeconds() view returns (uint256)',
  'function currentSnipeTaxBps(address recipient) view returns (uint256)',
  'function buy(uint256 quoteIn, uint256 minTokensOut, address recipient) payable returns (uint256 tokensOut)',
  'function sell(uint256 tokensIn, uint256 minQuoteOut, address recipient) returns (uint256 quoteOut)',
  'error CurveGraduated()',
  'error SlippageExceeded(uint256 actual, uint256 minimum)',
  'error InsufficientOutputAmount()',
  'error InsufficientInputAmount()',
  'error ZeroAmount()',
  'error NativeValueMismatch(uint256 supplied, uint256 expected)',
])

export const tokenAbi = parseAbi([
  SOCIALS,
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function totalSupply() view returns (uint256)',
  'function getTokenInfo() view returns (address tokenDeployer, string tokenLogo, string tokenDescription, Socials tokenSocials)',
])

// The launch router's launchAndBuy, decoded from a launch transaction for its launch-time fee wallet.
export const launchRouterAbi = parseAbi([
  SOCIALS,
  'struct TokenParams { string name; string symbol; string logo; string description; Socials socials; address creatorFeeRecipient; uint16 creatorTaxBps; bool buybackEnabled; bytes32 expectedEconomics; bytes32 salt; }',
  'function launchAndBuy(TokenParams params, uint256 launchConfigId, address pairToken, uint256 quoteIn, uint256 minTokensOut, address recipient, address[] snipeTaxExemptions) payable returns (address token, address curve, uint256 tokensOut)',
])

export const TOPIC = {
  TokenLaunched: toEventSelector(getAbiItem({ abi: factoryAbi, name: 'TokenLaunched' })),
  CurveBuy: toEventSelector(getAbiItem({ abi: curveAbi, name: 'CurveBuy' })),
  CurveSell: toEventSelector(getAbiItem({ abi: curveAbi, name: 'CurveSell' })),
  SnipeTaxExempted: toEventSelector(getAbiItem({ abi: curveAbi, name: 'SnipeTaxExempted' })),
} as const
