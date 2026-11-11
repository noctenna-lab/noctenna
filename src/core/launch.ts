// Mainnet writes opened at the token launch (0.1.4, 11 Nov 2026); testnet keeps taking writes for practice. Setting
// MAINNET_WRITES_OPEN to false shuts mainnet writes again, and NOCTENNA_PRELAUNCH_WRITES=1 then opens them for fork
// tests (an anvil fork of mainnet). This is a launch switch, not a security boundary: anyone running from source can
// edit it.
import type { Network } from './types.js'

export const MAINNET_WRITES_OPEN = true

export const LOCKED_MESSAGE =
  'Trading on mainnet opens at the token launch. Everything that reads works now. To practise trading, the user can switch to testnet in the terminal: noctenna network testnet'

export const writesOpen = (network: Network): boolean =>
  network === 'testnet' || MAINNET_WRITES_OPEN || process.env.NOCTENNA_PRELAUNCH_WRITES === '1'
