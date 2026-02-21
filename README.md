# trade-router-mcp

A [Model Context Protocol](https://modelcontextprotocol.io) server for [TradeRouter.ai](https://traderouter.ai) — Solana swap & limit order engine.

## Requirements

- Node.js >= 20.18.0
- A Solana wallet private key (base58)

## Installation

```bash
npx @re-bruce-wayne/trade-router-mcp
```

## Claude Desktop Setup

Add the following to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "traderouter": {
      "command": "npx",
      "args": ["-y", "@re-bruce-wayne/trade-router-mcp"],
      "env": {
        "TRADEROUTER_PRIVATE_KEY": "your_base58_private_key"
      }
    }
  }
}
```

| OS      | Config path                                                    |
|---------|----------------------------------------------------------------|
| macOS   | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Windows | `%APPDATA%\Claude\claude_desktop_config.json`                  |
| Linux   | `~/.config/Claude/claude_desktop_config.json`                  |

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `TRADEROUTER_PRIVATE_KEY` | ✅ | Solana wallet private key in base58 format |
| `SOLANA_RPC_URL` | ❌ | RPC endpoint. Defaults to `https://api.mainnet-beta.solana.com` |
| `TRADEROUTER_SERVER_PUBKEY` | ❌ | Server public key for signature verification |
| `TRADEROUTER_SERVER_PUBKEY_NEXT` | ❌ | Next server public key for key rotation |
| `TRADEROUTER_REQUIRE_SERVER_SIGNATURE` | ❌ | Verify server signatures on fills. Defaults to `true` |
| `TRADEROUTER_REQUIRE_ORDER_CREATED_SIGNATURE` | ❌ | Verify server signatures on order creation. Defaults to `true` |

## Available Tools

| Tool | Description |
|---|---|
| `get_wallet_address` | Get the configured wallet address |
| `build_swap` | Build an unsigned swap transaction |
| `submit_signed_swap` | Submit a manually signed transaction |
| `auto_swap` | Build and auto-sign a swap in one step |
| `get_holdings` | Get token holdings for a wallet |
| `place_limit_order` | Place a limit buy or sell order |
| `place_trailing_order` | Place a trailing buy or sell order |
| `list_orders` | List all active orders for a wallet |
| `check_order` | Check the status of an order |
| `cancel_order` | Cancel an active order |
| `extend_order` | Extend an order's expiry |
| `connect_websocket` | Connect and register WebSocket for a wallet |
| `connection_status` | Get current WebSocket connection status |
| `get_fill_log` | Get log of filled orders |
