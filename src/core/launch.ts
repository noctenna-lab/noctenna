// Mainnet writes stay shut until the token launch: every read runs on mainnet now, and testnet takes writes for
// practice. The launch release flips MAINNET_WRITES_OPEN. NOCTENNA_PRELAUNCH_WRITES=1 opens them for fork tests (an
// anvil fork of mainnet). This is a launch switch, not a security boundary: anyone running from source can edit it.
import type { Network } from './types.js'

export const MAINNET_WRITES_OPEN = false

export const LOCKED_MESSAGE =
  'Trading on mainnet opens at the token launch. Everything that reads works now. To practise trading, the user can switch to testnet in the terminal: noctenna network testnet'

export const writesOpen = (network: Network): boolean =>
  network === 'testnet' || MAINNET_WRITES_OPEN || process.env.NOCTENNA_PRELAUNCH_WRITES === '1'
