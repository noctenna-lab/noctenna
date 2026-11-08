# Security

Noctenna holds the key to a real wallet, so security reports come first.

## Reporting a vulnerability

Please report it privately, never in a public issue. Open the repository's **Security** tab and choose **Report a vulnerability**, which only the maintainers can read.

Say what you found, how to reproduce it and what an attacker could do with it. We reply as soon as we can, keep you updated while we fix it, and credit you in the release notes unless you would rather stay anonymous.

## What counts

Anything that could:

- send a transaction, an approval or a signature the user did not approve as a preview,
- reveal the wallet key or a stored API key,
- get around the daily limit, the launch lock or the preview's expiry,
- make the agent act on instructions from on-chain or third-party text, or
- let another MCP host or a shell run a terminal-only command (key import or export, the limit, the network).

## How the wallet is protected

- The key lives in the OS keychain on the user's computer. No server sees it and no tool returns it.
- Every change is prepared and simulated first. Only `execute`, with the preview the user approved, sends it, within 2 minutes and once.
- `execute` checks the price and state again and refuses on any move beyond the slippage. Approvals are for the exact amount.
- A daily USD limit is enforced inside `execute`, and only the terminal can change it.
- Token names, descriptions, links and API messages reach the model marked as untrusted data.

[ARCHITECTURE.md](ARCHITECTURE.md) describes each of these in detail.
