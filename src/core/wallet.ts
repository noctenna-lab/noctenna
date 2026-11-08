// The local wallet. The key lives in the OS keychain (service "noctenna") and leaves it only to sign inside this
// process, or through exportKey(), which the CLI calls in an interactive terminal only. No tool returns a key.
// NOCTENNA_KEYSTORE=file swaps the keychain for an encrypted file in the config dir (tests, headless CI); its
// password comes from NOCTENNA_KEYSTORE_PASSWORD.
import { AsyncEntry } from '@napi-rs/keyring'
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isAddress, isHex, type Address, type Hex } from 'viem'
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts'
import { configDir } from './config.js'

const SERVICE = 'noctenna'
const KEY = 'wallet-key'
const ADDRESS = 'wallet-address'
// Generic secrets get their own prefix, so no secretGet(name) can ever read the wallet key.
const secretName = (name: string) => {
  if (!/^[\w.-]{1,64}$/.test(name)) throw new Error('secret names are 1-64 letters, digits, _ . -')
  return `secret:${name}`
}

interface Store {
  get(name: string): Promise<string | null>
  set(name: string, value: string): Promise<void>
  del(name: string): Promise<void>
}

const keychain: Store = {
  get: (n) => new AsyncEntry(SERVICE, n).getPassword(),
  set: (n, v) => new AsyncEntry(SERVICE, n).setPassword(v),
  del: async (n) => void (await new AsyncEntry(SERVICE, n).deletePassword()),
}

// AES-256-GCM per value, key from scrypt(password, salt). The salt and ciphertexts are the whole file.
type FileData = { salt: string; items: Record<string, { iv: string; tag: string; data: string }> }
function fileStore(): Store {
  const path = () => join(configDir(), 'keystore.json')
  const password = () => {
    const p = process.env.NOCTENNA_KEYSTORE_PASSWORD
    if (!p) throw new Error('NOCTENNA_KEYSTORE=file needs NOCTENNA_KEYSTORE_PASSWORD')
    return p
  }
  const read = (): FileData => {
    try {
      return JSON.parse(readFileSync(path(), 'utf8')) as FileData
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { salt: randomBytes(16).toString('hex'), items: {} }
      throw e
    }
  }
  const write = (d: FileData) => {
    mkdirSync(configDir(), { recursive: true, mode: 0o700 })
    writeFileSync(path(), JSON.stringify(d), { mode: 0o600 })
  }
  const key = (salt: string) => scryptSync(password(), Buffer.from(salt, 'hex'), 32)
  return {
    async get(n) {
      const d = read()
      const it = d.items[n]
      if (!it) return null
      const dec = createDecipheriv('aes-256-gcm', key(d.salt), Buffer.from(it.iv, 'hex'))
      dec.setAuthTag(Buffer.from(it.tag, 'hex'))
      return Buffer.concat([dec.update(Buffer.from(it.data, 'hex')), dec.final()]).toString('utf8')
    },
    async set(n, v) {
      const d = read()
      const iv = randomBytes(12)
      const enc = createCipheriv('aes-256-gcm', key(d.salt), iv)
      const data = Buffer.concat([enc.update(v, 'utf8'), enc.final()])
      d.items[n] = { iv: iv.toString('hex'), tag: enc.getAuthTag().toString('hex'), data: data.toString('hex') }
      write(d)
    },
    async del(n) {
      const d = read()
      delete d.items[n]
      write(d)
    },
  }
}

const store = (): Store => (process.env.NOCTENNA_KEYSTORE === 'file' ? fileStore() : keychain)

async function save(privateKey: Hex): Promise<Address> {
  if (!isHex(privateKey) || privateKey.length !== 66) throw new Error('a private key is 32 bytes of hex, 0x-prefixed')
  const s = store()
  // Refuse to overwrite: a replaced key is a lost wallet.
  if (await s.get(KEY)) throw new Error('a wallet already exists on this computer')
  const { address } = privateKeyToAccount(privateKey)
  await s.set(KEY, privateKey)
  await s.set(ADDRESS, address)
  return address
}

export const createWallet = (): Promise<Address> => save(generatePrivateKey())
export const importWallet = (privateKey: Hex): Promise<Address> => save(privateKey)

export async function getAddress(): Promise<Address | null> {
  const a = await store().get(ADDRESS)
  return a && isAddress(a) ? a : null
}

export async function exportKey(): Promise<Hex> {
  const k = await store().get(KEY)
  if (!k) throw new Error('no wallet on this computer')
  return k as Hex
}

// The signer for execute. Never reachable from a tool.
export async function localAccount(): Promise<PrivateKeyAccount> {
  const account = privateKeyToAccount(await exportKey())
  const stored = await getAddress()
  if (stored !== account.address) throw new Error('the stored wallet address does not match its key')
  return account
}

export const secretGet = async (name: string): Promise<string | null> => store().get(secretName(name))
export const secretSet = async (name: string, value: string): Promise<void> => store().set(secretName(name), value)
export const secretDelete = async (name: string): Promise<void> => store().del(secretName(name))
