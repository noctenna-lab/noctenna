# Architecture

Noctenna is one TypeScript package (Node 22+, ESM). It holds an MCP server with typed tools, a command-line app that runs Goose on a profile of its own, and the website in `site/`. Tools are grouped into modules, and the core owns everything that touches keys, sending and limits.

## How a change is made

A model never signs anything. It reads with read tools, and to change anything it goes through two steps:

1. **prepare.** A `prepare_*` tool builds the transaction steps, simulates them and stores a preview. It returns a random preview id, a plain-language summary (what happens, the amounts, the worst case after slippage, fees, approvals and the network) and the USD value. Nothing is sent.
2. **execute.** After the user approves that exact preview, `execute` takes it, which deletes it so a retried call cannot send twice. It checks the price and state again and counts the USD against the daily limit. Then, for each step, it runs `eth_call`, estimates gas (×1.3, never under the step's floor), sends, waits for the receipt and stops on a revert.

## Core (`src/core/`)

- **Networks.** `mainnet` (chain 4663, the default) or `testnet` (46630). Only the terminal switches the network (`setNetwork` in `config.ts`). No tool can, and `NOCTENNA_NETWORK` overrides it for one run. Every summary starts with its network and every execute result names it. A preview made on one network refuses to run after a switch, and execute refuses when the RPC answers a different chain id. Reads that use mainnet data in testnet mode are labelled `"data": "mainnet data"`.
- **Launch switch.** Mainnet writes opened at the token launch (0.1.4, 11 Nov 2026): `MAINNET_WRITES_OPEN` in `launch.ts` is `true`. Set to `false`, every prepare tool on mainnet answers `{ locked: true, message }` without running, execute refuses mainnet writes as a second check, and the fork tests open them with `NOCTENNA_PRELAUNCH_WRITES=1`. Testnet always takes writes for practice.
- **Config.** `network`, `dailyLimitUsd`, `slippageBps` and optional `rpcUrls.{testnet,mainnet}`, kept in the config directory (`NOCTENNA_CONFIG_DIR` moves it). `NOCTENNA_RPC_URL` overrides the active network's RPC.
- **Chain client.** JSON-RPC with multicall batching and backoff. HTTP retries a 429 for every method, but a 5xx or a network error only for GET and HEAD, so a POST is never sent twice.
- **Wallet.** The key lives in the OS keychain (`@napi-rs/keyring`, service `noctenna`). A file keystore (AES-256-GCM, scrypt) is used only with `NOCTENNA_KEYSTORE=file` and `NOCTENNA_KEYSTORE_PASSWORD`. Creating or importing refuses to replace an existing wallet. Other secrets are stored under a `secret:` prefix, so a secret lookup can never read the key.
- **Daily limit.** USD per UTC day, kept per network in `spend-mainnet.json` and `spend-testnet.json` and counted before the first send, so testnet practice never spends the allowance for real funds. An unreadable ledger blocks writes instead of resetting to zero.
- **Untrusted text.** Values from the chain and third-party APIs, error messages included, reach the model as `{"untrusted_text": "..."}`, with control and bidi characters stripped and a 500-character cap. The agent's rules in `instructions.ts` tell it never to follow instructions found inside.

## Modules (`src/modules/`)

Each module exports a `Module` (`src/core/types.ts`): a name and its tools, each with a zod input schema and a kind, `read` or `prepare`.

- **wallet.** Address, balances, and `prepare_send`, which refuses the zero address and the token's own contract.
- **swap** (mainnet). Routes through KyberSwap. Its built calldata is decoded and refused unless it goes to the known router with exactly this input, this wallet as the receiver, no fee receivers and a minimum within the slippage. A graduated launch token can also swap through its own Uniswap v4 pool and the Universal Router. Approvals are exact, and the pool route uses Permit2. Testnet has no router, so swaps there answer that they open on mainnet.
- **pons** (launches). New launches, one token, curve quotes, `prepare_buy` and `prepare_sell` (`"all"` sells the whole balance). Trades are refused while the snipe tax applies, always for the first 3 seconds after launch, and while a token graduates. Curves are ETH-paired only, and after graduation a trade routes through swap. Testnet takes curve trades against a same-code factory deployment.
- **intel.** A launch check for any token from the launchpad: the dev buy, snipe-tax-exempt wallets other than the deployer, its launch-time fee wallet and the dev-buy recipient, outside buyers in the first 5 minutes, the share bought in the first 3 seconds, the top-10 buyers' share, the creator tax and fees on the curve, the graduation time, and the deployer's other launches (the newest 50, with their phase).
- **perps.** Markets on Arcus and Lighter, with funding raw and annualised (Arcus hourly ×24×365, Lighter per 8 h ×3×365), open interest and 24 h volume in USD, the maximum leverage, and closed stock markets with their fixed funding, settlement and band. Order books. Accounts: Arcus positions, balances, open orders and fills, and Lighter positions per sub-account. Arcus answers 403 to mainnet account reads until the address is on its access list.
  - Arcus writes: register an API key (an Ed25519 key made locally and stored only after Arcus accepts it), market and limit orders with reduce-only, take-profit and stop-loss, cancel, leverage, and a testnet collateral deposit. Market orders carry a worst price from the slippage, capped at 9%. Orders are signed at execute time, because the signed time must be within 30 s of Arcus's clock.
  - Lighter is read-only.
- **Reopen watch** (`perps_reopen_check` in `perps/reopen.ts`, read-only). It takes each stock-perp position the wallet holds on Lighter, or one described by market, side and leverage or liquidation price (the way Arcus positions are passed in). For each it reports the move since Friday, the band and the widened band, the liquidation price, the move and the Friday-to-open gap that reach it, and how many past weekends opened that far against the position. With only the leverage given, liquidation is estimated as an adverse move of 1/leverage minus the maintenance margin.
- **radar.** Funding on both venues side by side, the widest gaps, closed stock markets and their fixed funding, the weekend gap against the last settlement, and the largest Lighter account. It reads mainnet in either mode, since testnet funding says nothing about the market.
- **bridge.** Relay quotes in and out, `prepare_bridge` and `bridge_status`. Bridging goes out only, because a step carries no chain id and a bridge-in starts on another chain. Relay's transactions are checked before they become steps (chain 4663, this wallet, an exact approval to Relay's depository, no app fee, no referrer), and execute re-quotes and refuses a worse minimum.

### The gap table

`src/modules/perps/gaps.ts` and `site/src/gaps.js` hold the same table: per market, how many weekends opened at least N% away from the Friday close, on a 0.5% grid rounded down, so the counts err high. Both are built from Weekend Oracle's public [`weekends.csv`](https://nobones1.github.io/weekend-oracle/) and Arcus's `/v1/markets`:

```sh
python3 scripts/gaps.py weekends.csv arcus_markets.json site/src/gaps.js src/modules/perps/gaps.ts
```

The current table covers 32 weekends, 28 March to 31 October 2026. Of 1,744 US share-weekends, 30.4% opened at least 2% away and 6.1% at least 5%.

## Command line (`src/cli/`, `profile/`)

`noctenna` runs setup when it is needed, then a Goose session. The other commands are `setup`, `mcp`, `wallet create|import|address|export`, `limit <usd>` and `network [testnet|mainnet]`. Import, export, the limit, the network and setup refuse to run without an interactive terminal, and mainnet or a raised limit needs a typed yes.

Goose is the official v1.57.0 release, checked against pinned SHA-256 sums and installed into Noctenna's own directory. It runs with a root of its own, so a user's Goose setup is never read or changed, and the Noctenna server is its only extension. Every tool runs without asking except `execute`, which always asks, and `load_skill` is refused. The user's `GOOSE_*` and provider variables are cleared first, since an exported `GOOSE_MODE=auto` would skip every approval. To move to a newer Goose, change `GOOSE_VERSION` and the SHA-256 sums in `src/cli/goose.ts`, then run the Goose test.

## Not built yet

Wallet activity history, Uniswap v4 routing beyond launch pools, USDG-paired launch curves, Lighter writes and bridging in.

## Chain reference

- **Robinhood Chain.** Mainnet chain id 4663, public RPC `https://rpc.mainnet.chain.robinhood.com`, which is shared and answers bursts with 429. Testnet chain id 46630. A block about every 0.1 s, a base fee around 0.02 gwei, and first-come-first-served ordering, so priority tips do nothing.
- **Logs.** `eth_getLogs` returns at most 10,000 logs per query, and a range without an address filter is capped at 30,000 blocks.
- **Launchpad.** Factory `0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e` (deployed at block 26,841,846), hook `0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044`, StateView `0xf3334192d15450cdd385c8b70e03f9a6bd9e673b`. `CurveBuy.fee` includes the snipe tax (about 97% in second 0, 7.2% in second 1, 1.2% in second 2, then 1%), and `CurveBuy.tax` is the creator tax alone. A buy that crosses graduation uses about 334k gas, so the gas floor is 500k.
- **Uniswap.** PoolManager `0x8366a39CC670B4001A1121B8F6A443A643e40951`, Universal Router 2.1.2 `0x204FAca1764B154221e35c0d20aBb3c525710498`, V4 Quoter `0x8Dc178eFB8111BB0973Dd9d722ebeFF267c98F94`, Permit2 `0x000000000022D473030F116dDEE9F6B43aC78BA3`.
- **Arcus.** REST `https://api.arcus.xyz/v1` (testnet `https://api.testnet.arcus.xyz/v1`), docs at `https://docs.arcus.xyz`. API keys are Ed25519, registered with an EIP-712 signature from the owning wallet (domain chain id 4663, or 46630 on testnet), and they expire. Funding is hourly. Outside regular trading hours (04:00 to 20:00 ET) and at weekends, stock perps pay a fixed rate and trade inside a band around the last settlement, which widens in steps when the price presses against it.
- **Lighter.** REST `https://api.rh.lighter.xyz/api/v1` (testnet `https://api.rh-testnet.lighter.xyz/api/v1`), funding quoted per 8 h, docs at `https://apidocs.lighter.xyz`.
- **Relay.** `https://api.relay.link`. Its testnet API lists only Sepolia and Base Sepolia.
- **KyberSwap** serves chain 4663 under the slug `robinhood`.
- **Explorers.** Mainnet `https://robinhoodchain.blockscout.com`, testnet `https://explorer.testnet.chain.robinhood.com`. Testnet faucet `https://faucet.testnet.chain.robinhood.com`.
