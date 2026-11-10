import { ed25519 } from '@noble/curves/ed25519.js'
import { bytesToHex, hexToBytes } from '@noble/curves/utils.js'
import { recoverTypedDataAddress } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { expect, it } from 'vitest'
import {
  apiKeyTypedData,
  bigJson,
  boundPrice,
  canonical,
  cancelPayload,
  placePayload,
  sign,
  snapDown,
  tickAt,
  toUnits,
  type ArcusMarket,
} from '../../src/modules/perps/arcus.js'
import { ANVIL0, ANVIL0_ADDRESS, fixture, opensslVerify } from './fake.js'

// RFC 8032 §7.1, test 1
const RFC_SK = '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60'
const RFC_PK = 'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a'

it('signs Ed25519 exactly as RFC 8032 and OpenSSL do', () => {
  expect(bytesToHex(ed25519.getPublicKey(hexToBytes(RFC_SK)))).toBe(RFC_PK)
  expect(sign('', RFC_SK)).toBe(
    'e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b',
  )
  const msg =
    '{"ad":"0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266","ai":0,"ct":1,"g":2,"m":1,"op":1,"p":3,"q":4,"r":0,"s":0,"t":0,"v":1}'
  expect(opensslVerify(msg, sign(msg, RFC_SK), RFC_PK)).toBe(true)
})

it('builds the documented order payloads byte for byte', () => {
  // The REST guide's f-string, with its own example values (BTC-USD, a resting GTT buy).
  const ts = 1713825891591000000n
  const g = 4102444800000000n * 1000n
  const doc = `{"ad":"${ANVIL0_ADDRESS.toLowerCase()}","ai":0,"ct":${ts},"g":${g},"m":1,"op":1,"p":600000,"q":100000,"r":0,"s":0,"t":0,"v":1}`
  expect(
    placePayload({
      ad: ANVIL0_ADDRESS,
      ai: 0,
      ct: ts,
      g,
      m: 1,
      op: 1,
      p: toUnits('60000.0', '0.1'),
      q: toUnits('0.001', '0.00000001'),
      r: 0,
      s: 0,
      t: 0,
    }),
  ).toBe(doc)
  expect(
    placePayload({
      ad: ANVIL0_ADDRESS,
      ai: 2,
      c: 'entry-001',
      ct: 5n,
      g: 6n,
      m: 9,
      op: 4,
      p: 7n,
      q: 8n,
      r: 1,
      s: 1,
      t: 2,
    }),
  ).toBe(
    `{"ad":"${ANVIL0_ADDRESS.toLowerCase()}","ai":2,"c":"entry-001","ct":5,"g":6,"m":9,"op":4,"p":7,"q":8,"r":1,"s":1,"t":2,"v":1}`,
  )
  expect(cancelPayload({ ad: ANVIL0_ADDRESS, ai: 0, ct: 5n, id: 'a1b2c3d4e5f67890', m: 1 })).toBe(
    `{"ad":"${ANVIL0_ADDRESS.toLowerCase()}","ai":0,"ct":5,"id":"a1b2c3d4e5f67890","m":1,"op":2,"v":1}`,
  )
  expect(cancelPayload({ ad: ANVIL0_ADDRESS, ai: 0, c: 'mine', ct: 5n, m: 1 })).toBe(
    `{"ad":"${ANVIL0_ADDRESS.toLowerCase()}","ai":0,"c":"mine","ct":5,"m":1,"op":2,"v":1}`,
  )
  // Scheme 2 sorts keys like Python's json.dumps(sort_keys=True, separators=(",", ":")).
  expect(canonical({ marketId: 1, address: '0xAb', leverage: 5, accountIndex: 0 })).toBe(
    '{"accountIndex":0,"address":"0xAb","leverage":5,"marketId":1}',
  )
  expect(bigJson({ timestamp: 1794113156741480441n, price: '1' })).toBe('{"timestamp":1794113156741480441,"price":"1"}')
})

it('converts decimals to ticks exactly and snaps worst prices away from the trader', () => {
  expect(toUnits('0.001', '0.00000001')).toBe(100000n)
  expect(() => toUnits('0.0000000001', '0.00000001')).toThrow(/multiple/)
  expect(() => toUnits('1e3', '1')).toThrow(/decimal/)
  expect(snapDown('2.3929827709978464', '0.0000001')).toBe('2.3929827')
  expect(snapDown('5', '0.01')).toBe('5')
  expect(snapDown('0.004', '0.01')).toBe('0')
  const btc = (fixture('perps', 'arcus_markets.json').markets as ArcusMarket[]).find((m) => m.marketId === 1)!
  expect(boundPrice(btc, '75826.1', 300, true)).toBe('78100.9') // 78100.883 up to the tick
  expect(boundPrice(btc, '75826.1', 300, false)).toBe('73551.3') // 73551.317 down to the tick
  expect(tickAt(btc, 600000)).toBe('0.2')
  expect(boundPrice(btc, '600000', 100, true)).toBe('606000')
})

it('signs createApiKey typed data the way Foundry does', async () => {
  const td = apiKeyTypedData('testnet', RFC_PK, 1794200000000, '1794113156741480441', 0)
  // `cast wallet sign --data` over the same EIP-712 JSON (domain without verifyingContract, chain 46630).
  const castSig =
    '0x8668873f7846a70c3b995498aaf374de5513232e7e05ef3beabcbff48c2d08910d13be9cbe3c510e137c2c7de4673b5e097619cdd57c3b65cee1ebccac6edee51c'
  expect(await privateKeyToAccount(ANVIL0).signTypedData(td)).toBe(castSig)
  expect(await recoverTypedDataAddress({ ...td, signature: castSig })).toBe(ANVIL0_ADDRESS)
  expect(apiKeyTypedData('mainnet', RFC_PK, 1, '1', 0).domain.chainId).toBe(4663)
})
