# Contributing to Noctenna

Thanks for helping. Noctenna signs transactions for a real wallet, so every change follows a short set of rules. Please read them before you open a pull request.

## Setup

Node.js 22.12 or newer.

```sh
git clone https://github.com/noctenna-lab/noctenna.git
cd noctenna
npm install     # also builds dist/
npm link        # optional: puts your build of `noctenna` on your PATH
```

## Checks

CI runs these on every push and pull request. Run them before you push:

```sh
npm run typecheck
npm run format:check   # npm run format fixes it
npm test               # unit tests, no network
```

The slower checks run behind a flag. Run the ones that cover the code you changed:

| Command | What it covers |
|---|---|
| `FORK=1 npx vitest run test/fork` | every write path through the MCP server, on an anvil fork of mainnet |
| `FORK=1 npx vitest run test/perps/fork.test.ts` | the Arcus testnet deposit and a Relay bridge-out, each on a fork |
| `LIVE=1 npx vitest run test/intel` | read-only checks against live mainnet and testnet data |
| `npm run build && GOOSE_E2E=1 npx vitest run test/cli/goose.e2e.test.ts` | the real Goose release against a fake model: only Noctenna's tools load, and `execute` stops for approval |

The fork tests start `anvil` from [Foundry](https://getfoundry.sh) on ports 8701 and 8702. The Goose test downloads the pinned Goose release on its first run.

## Rules

1. **Non-custodial.** Keys stay in the OS keychain on the user's machine. No server sees a key and no tool returns one.
2. **Two steps for every state change.** A `prepare_*` tool simulates the action and returns a plain-language summary with a preview id that expires after 2 minutes. Only `execute`, with that id, sends anything, and only after checking the price and state again. Token approvals are for the exact amount. The daily USD limit is enforced inside `execute`.
3. **Untrusted text stays data.** Anything read from the chain or a third-party API (names, symbols, descriptions, links, handles, error strings) reaches the model wrapped as untrusted text and never in any other form.
4. **No fees.** No referral codes and no partner fees on any swap, trade or bridge.
5. **Tests never move mainnet value.** Write paths are tested on an anvil fork or on Arcus testnet. Nothing in this repository sends a mainnet transaction on its own.
6. **No secrets in output.** A key, token or `.env` value never goes to stdout, a log or an error message.
7. **Exact dependencies.** Pin exact versions, and prefer viem and the official MCP SDK to a new package.
8. **Information only.** User-facing text never promises returns.

## Layout

```
src/core/      MCP server, config, chain client, keychain wallet, previews and execute, daily limit, launch lock
src/modules/   one folder per module, each exporting a Module (src/core/types.ts)
src/cli/       the noctenna command and the Goose profile writer
profile/       the Goose profile that ships with the package
scripts/       data builders
site/          the website (see site/README.md)
test/          unit tests, plus the fork, live and Goose tests behind the flags above
```

[ARCHITECTURE.md](ARCHITECTURE.md) explains how each part works. Keep it current when behaviour changes.

## Pull requests

Keep each pull request to one change, with tests for new behaviour. A commit message says why the change is needed, since the diff already shows what changed.

## Security

Please do not open a public issue for a vulnerability. [SECURITY.md](SECURITY.md) explains how to report one privately.
