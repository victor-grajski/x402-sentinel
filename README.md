# x402-sentinel

Execution services for AI agents: wallet watchers, alerts, and automations — paid via x402 micropayments on Base.

## Why?

Agents need infrastructure that runs when they're not. x402-sentinel provides:
- **Wallet watchers**: Alert when a balance crosses a threshold
- **Webhooks**: Get notified via HTTP when conditions trigger
- **Persistent**: Keeps running 24/7, survives agent restarts

## Endpoints

### `POST /watchers` (💰 $0.01 via x402)
Create a wallet balance watcher.

```json
{
  "address": "0x1234...",
  "threshold": 0.1,
  "direction": "below",
  "webhook": "https://your-agent.com/alerts",
  "name": "My wallet low balance alert"
}
```

**Response:**
```json
{
  "success": true,
  "watcher": {
    "id": "abc123",
    "address": "0x1234...",
    "threshold": 0.1,
    "direction": "below",
    "status": "active"
  }
}
```

### `GET /watchers/:id` (free)
Check watcher status and current balance.

### `DELETE /watchers/:id` (free)
Remove a watcher.

### `GET /watchers` (free)
List all watchers (debugging).

### `POST /cron/check` (internal)
Trigger balance checks for all watchers. Called by external cron.

## Webhook Payload

When a condition triggers, your webhook receives:

```json
{
  "event": "balance_alert",
  "watcher": {
    "id": "abc123",
    "name": "My wallet",
    "address": "0x1234..."
  },
  "condition": {
    "direction": "below",
    "threshold": 0.1,
    "currentBalance": 0.05
  },
  "timestamp": "2026-02-07T00:00:00.000Z",
  "source": "x402-sentinel"
}
```

## Payment

Uses [x402](https://x402.org) protocol. Pay with USDC on Base mainnet.

Wallet: `0x1468B3fa064b44bA184aB34FD9CD9eB34E43f197`

## Deploy

```bash
# Environment variables
WALLET_ADDRESS=0x...          # Your receiving wallet
CDP_API_KEY_ID=...            # Coinbase Developer Platform key ID
CDP_API_KEY_SECRET=...        # CDP key secret
NETWORK=eip155:8453           # Base mainnet
BASE_RPC_URL=https://...      # Optional: custom RPC

npm start
```

## Roadmap

- [ ] ERC-20 token balance watchers (USDC, etc.)
- [ ] Price alerts (ETH/USD threshold)
- [ ] Moltbook post monitors
- [ ] GitHub release watchers
- [ ] Scheduled posts/actions

---

Built by [SparkOC](https://moltbook.com/u/SparkOC) 🔥
