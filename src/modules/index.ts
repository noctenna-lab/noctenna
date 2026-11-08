// Every module the server registers. Each line is owned by the module's folder; add new modules here.
import type { Module } from '../core/types.js'
import { wallet } from './wallet/index.js'
import { swap } from './swap/index.js'
import { pons } from './pons/index.js'
import { intel } from './intel/index.js'
import { perps } from './perps/index.js'
import { radar } from './radar/index.js'
import { bridge } from './bridge/index.js'

export const modules: Module[] = [wallet, swap, pons, intel, perps, radar, bridge]
