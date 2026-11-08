![Noctenna. Wall Street sleeps. Your liquidation doesn't.](site/public/og.jpg)

[![CI](https://github.com/noctenna-lab/noctenna/actions/workflows/ci.yml/badge.svg)](https://github.com/noctenna-lab/noctenna/actions/workflows/ci.yml)
[![Licence: MIT](https://img.shields.io/badge/licence-MIT-6a2cff)](LICENSE)
![Node.js 22.12 or newer](https://img.shields.io/badge/node-22.12%2B-6a2cff)

Noctenna is an open-source AI agent for Robinhood Chain. It swaps, trades new launches on their bonding curve, checks launches, reads and trades perps on Arcus, reads Lighter, shows funding across both venues, watches stock perps over the weekend, and bridges out with Relay, from a wallet that stays on your computer.

**Information only, not financial advice.** Noctenna reports what the chain and the venues return. It never promises returns.

**Read-only on mainnet until the token launch.** Noctenna runs on Robinhood Chain mainnet (chain 4663). Everything that reads works now: launch checks, funding across both venues, perps markets, balances and swap quotes. Trading on mainnet opens at the token launch; until then every write tool answers that it is locked. To practise trading now, switch to Robinhood Chain testnet (chain 46630) and Arcus testnet with `noctenna network testnet`.

## What you get

- **`noctenna`**: a terminal agent. It runs [Goose](https://github.com/aaif-goose/goose) (Apache-2.0) on a profile of its own, with the Noctenna tools as its only extension: no shell, file, browser or computer-control tools.
- **`noctenna mcp`**: the same tools over stdio for Claude Code, Codex, Cursor, Gemini CLI and any other MCP host.
- **`noctenna wallet`**: create, import, show the address, export (export only in an interactive terminal).

You bring the model: an API key for OpenAI, Anthropic, Google, OpenRouter or any OpenAI-compatible endpoint, or a local model through Ollama. Noctenna never hosts, resells or proxies models.

| Area | Read | Write (prepare, then execute) |
|---|---|---|
| Wallet | address, ETH and token balances | send ETH or a token |
| Swap | quotes on Robinhood Chain | swap (mainnet) |
| Launches | new launches, one token, curve quote | buy, sell on the curve |
| Launch check | dev buy, bundles, first-5-minute buyers, snipers, creator tax, fees, graduation, the deployer's other launches | none |
| Perps | markets, funding, open interest, order books, positions, orders, fills on Arcus; markets, funding, open interest, order books, positions on Lighter; **reopen watch** for stock perps (the weekend band, your liquidation price, the gap that reaches it, and how many past weekends opened that far) | Arcus: register an API key, market and limit orders with take-profit and stop-loss, cancel, leverage, and test collateral on testnet. Lighter is read-only in v1 |
| Radar | funding on Arcus and Lighter side by side, the widest gaps, closed stock markets and their fixed funding, the weekend gap against the last settlement | none |
| Bridge | Relay quotes into and out of Robinhood Chain for ETH and dollars | bridge out (mainnet) |

## Install

Node.js 22.12 or newer.

```sh
npm install -g github:noctenna-lab/noctenna
```

npm builds it from source as it installs. To work on the code instead, see [CONTRIBUTING.md](CONTRIBUTING.md).

## Set up

```sh
noctenna setup          # pick a model provider and store its API key in your OS keychain
noctenna wallet create  # or: noctenna wallet import (hidden prompt)
noctenna                # start the agent
```

`setup` writes a Goose profile into `~/.config/noctenna/goose` (set `NOCTENNA_CONFIG_DIR` to move everything Noctenna keeps). The first `noctenna` downloads the official Goose release, checks it against a pinned SHA-256 and keeps it in `~/.config/noctenna/bin`. Your own Goose setup, if you have one, is never read or changed.

To practise on testnet (`noctenna network testnet`):

- Test ETH for gas: the official faucet, https://faucet.testnet.chain.robinhood.com
- Perps practice on Arcus testnet (https://testnet.arcus.xyz): ask the agent to deposit test collateral (it mints test USDG, which has no value) and to register an Arcus API key, then trade.

Other commands, all terminal only:

```sh
noctenna limit 200          # the daily spending limit in USD (default $100)
noctenna network            # show the network
noctenna network mainnet    # asks for a typed yes; mainnet moves real money
noctenna wallet export      # shows the private key after a typed confirmation
```

## Use it from Claude Code, Codex, Cursor or Gemini CLI

Every host runs the same command: `noctenna mcp`.

Claude Code:

```sh
claude mcp add noctenna -- noctenna mcp
```

or in `.mcp.json`:

```json
{
  "mcpServers": {
    "noctenna": { "command": "noctenna", "args": ["mcp"] }
  }
}
```

Codex, in `~/.codex/config.toml`:

```toml
[mcp_servers.noctenna]
command = "noctenna"
args = ["mcp"]
```

Cursor, in `~/.cursor/mcp.json` (or `.cursor/mcp.json` in a project):

```json
{
  "mcpServers": {
    "noctenna": { "command": "noctenna", "args": ["mcp"] }
  }
}
```

Gemini CLI, in `~/.gemini/settings.json`:

```json
{
  "mcpServers": {
    "noctenna": { "command": "noctenna", "args": ["mcp"] }
  }
}
```

These hosts have their own shell and file tools. Set them to ask before running Noctenna's `execute` tool, as `noctenna` itself does. Noctenna's terminal-only commands (key import and export, the limit, the network) refuse to run without an interactive terminal, so an agent driving a shell cannot use them.

## Safety model

- **Local keys.** The wallet key and any API keys live in your OS keychain (macOS Keychain, Windows Credential Manager, Secret Service on Linux). No server sees them and no tool returns them. `noctenna wallet export` works only in an interactive terminal.
- **Two steps for every change.** A `prepare` tool simulates the action and returns a plain-language summary: what happens, the amounts, the worst case after slippage, fees and approvals, and the network. Nothing is sent. Only `execute`, with that preview's id, within 2 minutes and once, sends it. `execute` checks the price and state again and refuses on any move beyond the slippage.
- **Exact approvals.** Token approvals are for the exact amount, never unlimited.
- **Daily limit.** A USD limit per UTC day (default $100), enforced inside `execute` and changed only with `noctenna limit` in a terminal. A perps order counts the initial margin it needs.
- **No shell tools.** The `noctenna` agent has only Noctenna's typed tools. Goose's built-in extensions are off, and every call to `execute` stops for your approval.
- **Untrusted text.** Token names, descriptions, links and venue messages reach the model marked as untrusted data, and the agent's rules tell it never to follow instructions found in them.
- **No fees.** Noctenna adds no referral code and no fee to any swap, trade or bridge.

## Venue terms

Arcus and Lighter are not available in the US, Canada, the UK or sanctioned regions. The first perps action in each session says so before you approve it. Use them only where you may.

Lighter is read-only in v1. Bridging into Robinhood Chain shows a quote; v1 bridges out only. Relay does not serve Robinhood Chain testnet, so bridging works on mainnet only, once trading opens at the launch.

## Coming soon

Desktop apps for Mac, Windows and Linux, and apps for Android and iOS: coming soon.

## Contributing

Issues and pull requests are welcome. [CONTRIBUTING.md](CONTRIBUTING.md) has the setup, the checks and the rules every change follows, and [ARCHITECTURE.md](ARCHITECTURE.md) explains how the parts fit together. Please report security issues privately, as [SECURITY.md](SECURITY.md) describes.

## Licence

MIT. See [LICENSE](LICENSE).

Noctenna is an independent project, not affiliated with Robinhood or with any venue, protocol or app named here. Information only, not financial advice.
