import { readFileSync } from 'node:fs'
import { encodeFunctionData, type Address } from 'viem'
import { describe, expect, it } from 'vitest'
import { createHttp } from '../../src/core/chain.js'
import type { Ctx } from '../../src/core/types.js'
import { swap, SWAPS_ON_MAINNET } from '../../src/modules/swap/index.js'
import { checkKyberTx, KYBER_ROUTER, kyberAbi, NATIVE } from '../../src/modules/swap/kyber.js'
import {
  ACTION,
  COMMAND,
  exactInputSingleParams,
  PERMIT2,
  POOL_MANAGER,
  STATE_VIEW,
  UNIVERSAL_ROUTER,
  V4_QUOTER,
} from '../../src/modules/swap/uniswap.js'

describe('constants come from the verified Universal Router 2.1.2 sources and the Uniswap deployments list', () => {
  const src = (f: string) => readFileSync(new URL(`./verified/${f}`, import.meta.url), 'utf8')
  const constant = (text: string, name: string) =>
    Number(text.match(new RegExp(`constant ${name} = (0x[0-9a-fA-F]+);`))![1])
  it('command and action bytes', () => {
    for (const [name, v] of Object.entries(COMMAND)) expect(v).toBe(constant(src('Commands.sol'), name))
    for (const [name, v] of Object.entries(ACTION)) expect(v).toBe(constant(src('Actions.sol'), name))
  })
  it('ExactInputSingleParams field list', () => {
    const body = src('IV4Router.sol').match(/struct ExactInputSingleParams \{([^}]*)\}/)![1]!
    const fields = [...body.matchAll(/(\w+) (\w+);/g)].map((m) => m[2])
    const ours = (exactInputSingleParams[0] as unknown as { components: { name: string }[] }).components.map(
      (c) => c.name,
    )
    expect(ours).toEqual(fields)
  })
  it('addresses', () => {
    const recs: { contract: string; address: string; chainId: number; status: string }[] = JSON.parse(
      src('uniswap-deployments-4663.json'),
    ).records
    const addr = (c: string) =>
      recs.find((r) => r.contract === c && r.chainId === 4663 && r.status === 'active')?.address.toLowerCase()
    expect(addr('UniversalRouter#v2.1.2')).toBe(UNIVERSAL_ROUTER.toLowerCase())
    expect(addr('V4Quoter')).toBe(V4_QUOTER.toLowerCase())
    expect(addr('Permit2')).toBe(PERMIT2.toLowerCase())
    expect(addr('PoolManager')).toBe(POOL_MANAGER.toLowerCase())
    expect(addr('StateView')).toBe(STATE_VIEW.toLowerCase())
  })
})

describe('the KyberSwap transaction is checked before it is signed', () => {
  const me: Address = '0x1111111111111111111111111111111111111234'
  const USDG: Address = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168'
  const req = { tokenIn: 'ETH' as const, tokenOut: USDG, amountIn: 10n ** 16n, minOut: 21_000_000n, account: me }
  const desc = (o: Partial<Record<string, unknown>> = {}) => ({
    srcToken: NATIVE,
    dstToken: USDG,
    srcReceivers: [],
    srcAmounts: [],
    feeReceivers: [],
    feeAmounts: [],
    dstReceiver: me,
    amount: 10n ** 16n,
    minReturnAmount: 21_664_423n,
    flags: 512n,
    permit: '0x' as const,
    ...o,
  })
  const data = (o?: Partial<Record<string, unknown>>) =>
    encodeFunctionData({
      abi: kyberAbi,
      functionName: 'swap',
      args: [
        {
          callTarget: me,
          approveTarget: '0x0000000000000000000000000000000000000000',
          targetData: '0x',
          desc: desc(o) as never,
          clientData: '0x',
        },
      ],
    })
  const tx = (o?: Partial<Record<string, unknown>>, t: Partial<{ to: Address; value: bigint }> = {}) => ({
    to: KYBER_ROUTER,
    data: data(o),
    value: 10n ** 16n,
    amountOut: 22_334_457n,
    ...t,
  })

  it('accepts a plain swap of this input to this wallet', () => {
    expect(checkKyberTx(tx(), req).minOut).toBe(21_664_423n)
  })
  it.each([
    ['another router', tx(undefined, { to: '0x2222222222222222222222222222222222222222' }), /router/],
    ['another recipient', tx({ dstReceiver: '0x3333333333333333333333333333333333333333' }), /output goes to/],
    ['a fee', tx({ feeReceivers: ['0x3333333333333333333333333333333333333333'], feeAmounts: [1n] }), /fee/],
    ['a lower minimum', tx({ minReturnAmount: 1n }), /minimum/],
    ['another amount', tx({ amount: 1n }), /amount/],
    ['another token', tx({ dstToken: '0x3333333333333333333333333333333333333333' }), /tokens/],
    ['extra ETH', tx(undefined, { value: 10n ** 18n }), /ETH value/],
  ])('refuses %s', (_, t, re) => {
    expect(() => checkKyberTx(t, req)).toThrow(re)
  })
})

it('on testnet, swaps say they open on mainnet at launch', async () => {
  const ctx = {
    config: { network: 'testnet', rpcUrl: 'http://127.0.0.1:1', dailyLimitUsd: 200, slippageBps: 300 },
    address: null,
    http: createHttp(),
  } as unknown as Ctx
  for (const t of swap.tools)
    await expect(
      t.run(
        ctx,
        t.input.parse({ tokenIn: 'ETH', tokenOut: '0x33e4191705c386532ba27cBF171Db86919200B94', amountIn: '0.001' }),
      ),
    ).rejects.toThrow(SWAPS_ON_MAINNET)
})
