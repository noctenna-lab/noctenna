// Tool-level checks against recorded API answers: what each prepare tool shows, counts and finally sends to Arcus.
import { bytesToHex, hexToBytes } from '@noble/curves/utils.js'
import { ed25519 } from '@noble/curves/ed25519.js'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  decodeFunctionData,
  erc20Abi,
  getAddress,
  parseAbi,
  recoverTypedDataAddress,
  serializeSignature,
  type Hex,
  type TypedDataDefinition,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { beforeAll, expect, it } from 'vitest'
import { secretGet, secretSet } from '../../src/core/wallet.js'
import type { Preview, Step } from '../../src/core/types.js'
import { perps } from '../../src/modules/perps/index.js'
import { keyName } from '../../src/modules/perps/arcus.js'
import { ANVIL0, ANVIL0_ADDRESS, fakeCtx, fixture, opensslVerify, type Call } from './fake.js'

const SK = '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60'
const PK = bytesToHex(ed25519.getPublicKey(hexToBytes(SK)))
const tool = (name: string) => perps.tools.find((t) => t.name === name)!
const markets = fixture('perps', 'arcus_markets.json')

beforeAll(() => {
  process.env.NOCTENNA_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'noctenna-perps-'))
  process.env.NOCTENNA_KEYSTORE = 'file'
  process.env.NOCTENNA_KEYSTORE_PASSWORD = 'test-password'
})

const storeKey = (validUntil = Date.now() + 30 * 86_400_000) =>
  secretSet(
    keyName('testnet'),
    JSON.stringify({ secretKey: SK, publicKey: PK, address: ANVIL0_ADDRESS, accountIndex: 0, validUntil }),
  )

const arcus = (extra: (url: string, c: Call) => unknown = () => undefined) =>
  fakeCtx((url, c) => {
    if (
      url.startsWith('https://api.testnet.arcus.xyz/v1/markets') ||
      url.startsWith('https://api.arcus.xyz/v1/markets')
    )
      return markets
    return extra(url, c)
  })

const TIF: Record<string, number> = { GTT: 0, FOK: 1, IOC: 2, ALO: 3 }
// Rebuilt here from the request body alone, the way Arcus's validator does, not with the module's own builder.
function expectSigned(o: Record<string, any>, ts: string, step: string) {
  const ticks = (v: string, unit: string) => BigInt(Math.round(Number(v) / Number(unit)))
  const payload = `{"ad":"${o.address.toLowerCase()}","ai":${o.accountIndex},"ct":${ts},"g":${BigInt(o.goodTilTime) * 1000n},"m":${o.marketId},"op":${o.tpslType ? 4 : 1},"p":${ticks(o.price, '0.1')},"q":${ticks(o.quantity, step)},"r":${o.reduceOnly ? 1 : 0},"s":${o.orderSide === 'BUY' ? 0 : 1},"t":${TIF[o.timeInForce]},"v":1}`
  expect(opensslVerify(payload, o.signature, PK)).toBe(true)
}

it('refuses to trade without a registered key, and states the venue terms once', async () => {
  const { ctx } = arcus()
  await expect(
    tool('prepare_arcus_order').run(ctx, {
      market: 'BTC',
      side: 'buy',
      size: '0.001',
      type: 'market',
      reduceOnly: false,
    }),
  ).rejects.toThrow(/register one/)
  await storeKey(Date.now() + 60_000)
  await expect(
    tool('prepare_arcus_order').run(ctx, {
      market: 'BTC',
      side: 'buy',
      size: '0.001',
      type: 'market',
      reduceOnly: false,
    }),
  ).rejects.toThrow(/expired/)
})

it('prepares a market buy with take-profit and stop-loss, counts its margin, and signs every leg at execute', async () => {
  await storeKey()
  const { ctx, calls } = arcus((url) => {
    if (url.includes('/leverages?')) return { leverages: [{ marketId: 1, leverage: 10 }] }
    if (url.includes('/batchPlaceOrders?'))
      return new Response('{"responses":[{"orderId":"a1b2c3d4e5f67890","status":"ACK"}]}', { status: 202 })
  })
  const p = (await tool('prepare_arcus_order').run(ctx, {
    market: 'btc-usd',
    side: 'buy',
    size: '0.001',
    type: 'market',
    reduceOnly: false,
    takeProfit: '90000',
    stopLoss: '70000',
  })) as Preview
  expect(p.summary[0]).toMatch(/not available in the US, Canada, the UK or sanctioned regions/)
  expect(p.summary.join('\n')).toContain('worst price $78100.9')
  expect(p.summary.join('\n')).toContain(
    'when the mark reaches $70000, a reduce-only market order closes 0.001, worst price $67900',
  )
  // 0.001 × 78100.9 at 10x (the account's leverage beats the market's 40x floor)
  expect(p.usd).toBe(7.82)
  await p.recheck!()
  const out = await (p.steps[0] as Extract<Step, { type: 'offchain' }>).run()
  expect(out).toEqual({ responses: [{ orderId: { untrusted: 'a1b2c3d4e5f67890' }, status: { untrusted: 'ACK' } }] })

  const post = calls.find((c) => c.method === 'POST')!
  expect(post.url).toBe(`https://api.testnet.arcus.xyz/v1/batchPlaceOrders?address=${ANVIL0_ADDRESS}`)
  const ts = post.headers.get('x-timestamp')!
  expect(post.headers.get('x-api-key')).toBe(PK)
  expect(post.body).toContain(`"timestamp":${ts}`) // a bare integer, not a rounded float
  const body = JSON.parse(post.body!.replace(/"timestamp":(\d+)/g, '"timestamp":"$1"'))
  expect(body.grouping).toBe('entryTpsl')
  expect(
    body.orders.map((o: any) => [o.orderSide, o.orderType, o.timeInForce, o.tpslType, o.stopPrice, o.price]),
  ).toEqual([
    ['BUY', 'MARKET', 'IOC', undefined, undefined, '78100.9'],
    ['SELL', 'MARKET', 'IOC', 'TAKE_PROFIT', '90000', '87300'],
    ['SELL', 'MARKET', 'IOC', 'STOP_LOSS', '70000', '67900'],
  ])
  expect(post.headers.get('x-signature')).toBe(body.orders[0].signature)
  for (const o of body.orders) {
    expect(o.timestamp).toBe(ts)
    // goodTilTime must be at least a month out even on IOC orders
    expect(Number(o.goodTilTime)).toBeGreaterThan((Date.now() + 31 * 86_400_000) * 1000)
    expectSigned(o, ts, '0.00000001')
  }
})

it('warns about closed stock markets and counts the whole notional when leverage is unknown', async () => {
  await storeKey()
  const { ctx } = arcus()
  const p = (await tool('prepare_arcus_order').run(ctx, {
    market: 'AMD',
    side: 'sell',
    size: '0.1',
    type: 'limit',
    price: '450',
    reduceOnly: false,
  })) as Preview
  expect(p.summary.join('\n')).not.toMatch(/sanctioned regions/) // already shown this session
  expect(p.summary.join('\n')).toMatch(
    /underlying stock market is closed\. Funding is a fixed 4\.48%\/yr.*initial margin is 15% instead of 10%.*price band of \$425\.2 to \$469\.94/,
  )
  expect(p.usd).toBe(45)
  await expect(
    tool('prepare_arcus_order').run(ctx, {
      market: 'AMD',
      side: 'sell',
      size: '0.1',
      type: 'limit',
      price: '450.005',
      reduceOnly: false,
    }),
  ).rejects.toThrow(/multiple/)
  await expect(
    tool('prepare_arcus_order').run(ctx, {
      market: 'BTC',
      side: 'buy',
      size: '0.001',
      type: 'market',
      reduceOnly: false,
      takeProfit: '70000',
    }),
  ).rejects.toThrow(/above the mark/)
})

it('registers an API key: the wallet signs typed data, the private half lands in the keychain only after Arcus accepts', async () => {
  const { ctx, calls } = fakeCtx((url, c) => {
    if (url.endsWith('/createApiKey'))
      return new Response(JSON.stringify({ apiKey: JSON.parse(c.body!).publicKey }), { status: 202 })
    if (url.includes('/apiKeys?'))
      return { apiKeys: [{ apiKey: JSON.parse(calls.find((x) => x.url.endsWith('/createApiKey'))!.body!).publicKey }] }
  })
  const before = await secretGet(keyName('testnet'))
  const p = (await tool('prepare_arcus_register_key').run(ctx, { days: 30, accountIndex: 0 })) as Preview
  const step = p.steps[0] as Extract<Step, { type: 'typedData' }>
  expect(step.type).toBe('typedData')
  expect(await secretGet(keyName('testnet'))).toBe(before) // nothing stored at prepare
  const signature = await privateKeyToAccount(ANVIL0).signTypedData(step.typedData as TypedDataDefinition)
  const out = (await step.then(signature)) as { apiKey: string; live: boolean }
  expect(out.live).toBe(true)
  const body = JSON.parse(calls.find((x) => x.url.endsWith('/createApiKey'))!.body!)
  expect(body.validUntil).toBeGreaterThan(Date.now() + 29 * 86_400_000)
  const sig = serializeSignature({ r: body.signature.r, s: body.signature.s, v: BigInt(body.signature.v) }) as Hex
  expect(await recoverTypedDataAddress({ ...(step.typedData as TypedDataDefinition), signature: sig })).toBe(
    ANVIL0_ADDRESS,
  )
  const stored = JSON.parse((await secretGet(keyName('testnet')))!)
  expect(stored.publicKey).toBe(body.publicKey)
  expect(bytesToHex(ed25519.getPublicKey(hexToBytes(stored.secretKey)))).toBe(body.publicKey)
  expect(JSON.stringify(out)).not.toContain(stored.secretKey)
})

it('keeps a live key rather than replacing it under previews that sign with it', async () => {
  await storeKey()
  const { ctx } = arcus((url) => (url.includes('/apiKeys?') ? { apiKeys: [{ apiKey: PK }] } : undefined))
  await expect(tool('prepare_arcus_register_key').run(ctx, { days: 30, accountIndex: 0 })).rejects.toThrow(
    /already has a live Arcus testnet key/,
  )
  // a key Arcus no longer lists may be replaced
  const gone = arcus((url) => (url.includes('/apiKeys?') ? { apiKeys: [] } : undefined))
  expect((await tool('prepare_arcus_register_key').run(gone.ctx, { days: 30, accountIndex: 0 })).steps).toHaveLength(1)
})

it('sets leverage with a scheme-2 signature over timestamp + action + sorted body', async () => {
  await storeKey()
  const { ctx, calls } = arcus((url) => (url.includes('/setLeverage?') ? { requestId: 'x', status: 'OK' } : undefined))
  await expect(tool('prepare_arcus_leverage').run(ctx, { market: 'BTC', leverage: 41 })).rejects.toThrow(/at most 40x/)
  const p = (await tool('prepare_arcus_leverage').run(ctx, { market: 'BTC', leverage: 5, isolated: true })) as Preview
  expect(p.usd).toBe(0)
  await (p.steps[0] as Extract<Step, { type: 'offchain' }>).run()
  const post = calls.find((c) => c.method === 'POST')!
  expect(post.body).toBe(`{"accountIndex":0,"address":"${ANVIL0_ADDRESS}","isolated":true,"leverage":5,"marketId":1}`)
  expect(
    opensslVerify(`${post.headers.get('x-timestamp')}setLeverage${post.body}`, post.headers.get('x-signature')!, PK),
  ).toBe(true)
})

it('cancels by order id with an op-2 payload', async () => {
  await storeKey()
  const { ctx, calls } = arcus((url) =>
    url.includes('/cancelOrder?') ? new Response('{"status":"CANCEL_ACKNOWLEDGED"}', { status: 202 }) : undefined,
  )
  await expect(tool('prepare_arcus_cancel').run(ctx, { market: 'BTC' })).rejects.toThrow(/exactly one/)
  const p = (await tool('prepare_arcus_cancel').run(ctx, { market: 'BTC', orderId: 'a1b2c3d4e5f67890' })) as Preview
  await (p.steps[0] as Extract<Step, { type: 'offchain' }>).run()
  const post = calls.find((c) => c.method === 'POST')!
  const ts = post.headers.get('x-timestamp')!
  expect(post.body).toBe(
    `{"address":"${ANVIL0_ADDRESS}","accountIndex":0,"marketId":1,"kind":"orderId","orderId":"a1b2c3d4e5f67890","timestamp":${ts}}`,
  )
  expect(
    opensslVerify(
      `{"ad":"${ANVIL0_ADDRESS.toLowerCase()}","ai":0,"ct":${ts},"id":"a1b2c3d4e5f67890","m":1,"op":2,"v":1}`,
      post.headers.get('x-signature')!,
      PK,
    ),
  ).toBe(true)
})

it('reads markets on both venues with funding annualised and names kept as untrusted data', async () => {
  const { ctx } = fakeCtx((url) => {
    if (url === 'https://api.arcus.xyz/v1/markets') return markets
    if (url.endsWith('/orderBookDetails')) return fixture('perps', 'lighter_details.json')
    if (url.endsWith('/funding-rates')) return fixture('perps', 'lighter_funding.json')
  })
  const a = (await tool('perps_markets').run(ctx, { venue: 'arcus' })) as any
  expect(a.data).toMatch(/^mainnet data/)
  const btc = a.markets.find((m: any) => m.marketId === 1)
  expect(btc.market).toEqual({ untrusted: 'BTC-USD' })
  expect(btc.fundingPctYr).toBe(10.95) // 0.0000125/h × 24 × 365
  expect(a.markets.find((m: any) => m.marketId === 9)).toMatchObject({
    underlyingClosed: true,
    fixedFunding: true,
    maxLeverageNow: 6.7,
  })
  const l = (await tool('perps_markets').run(ctx, { venue: 'lighter' })) as any
  const eth = l.markets.find((m: any) => m.market.untrusted === 'ETH')
  expect(eth.fundingPctYr).toBeCloseTo(eth.funding8h * 3 * 365 * 100, 1)
})

it('mints and deposits Arcus test collateral on testnet only, with an exact approval', async () => {
  const { ctx } = fakeCtx(() => undefined, 'mainnet')
  await expect(tool('prepare_arcus_testnet_deposit').run(ctx, { amount: '1000', accountIndex: 0 })).rejects.toThrow(
    /only on testnet/,
  )
  const t = fakeCtx(() => undefined, 'testnet').ctx
  const p = (await tool('prepare_arcus_testnet_deposit').run(t, { amount: '1000', accountIndex: 0 })) as Preview
  expect(p.usd).toBe(0)
  const calls = p.steps.map((s) =>
    s.type === 'tx'
      ? decodeFunctionData({
          abi: [
            ...erc20Abi,
            ...parseAbi(['function mint(address,uint256)', 'function initiateDeposit(address,uint16,address,uint256)']),
          ],
          data: s.data,
        })
      : null,
  )
  expect(calls.map((c) => [c!.functionName, ...(c!.args as unknown[])])).toEqual([
    ['mint', ANVIL0_ADDRESS, 1_000_000_000n],
    ['approve', getAddress('0xb872366eef371d4afb7c6d4d2abd53c17292a34d'), 1_000_000_000n],
    ['initiateDeposit', ANVIL0_ADDRESS, 0, getAddress('0x293b337712d4312776a3a2d292f44410e7873bad'), 1_000_000_000n],
  ])
})
