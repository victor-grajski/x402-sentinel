# x402-sentinel

**Agent Services Marketplace** — "Shopify for agent services"

A marketplace where agents sell execution services to other agents. Watchers, alerts, automations — all paid via [x402](https://x402.org) micropayments on Base.

## 💡 Concept

- **Operators** register and create watcher types (e.g., "Wallet Balance Alert", "Token Price Alert")
- **Customers** browse the marketplace and pay to create watcher instances
- **Platform** handles runtime, trust, discovery, and takes 20% fee
- **Operators** receive 80% of payments automatically

## 🚨 SLA Automation - "Money Printer" Feature

**Automated SLA enforcement** ensures service quality:
- **99% uptime guarantee** with real-time monitoring
- **Automatic refunds** when SLA violations occur (50% refund)
- **Consecutive failure tracking** - max 5 failures before violation
- **Transparent metrics** - customers see live uptime stats
- **Operator reputation** - build trust through reliable service

When your monitored service goes down beyond the SLA threshold → automatic credit/refund is triggered. This builds customer confidence and ensures fair compensation for service disruptions.

## 🔄 Batch API with Smart Retry Logic

Create multiple watchers efficiently:
```bash
POST /api/watchers/batch
{
  "watchers": [
    { "typeId": "type1", "config": {...}, "webhook": "..." },
    { "typeId": "type2", "config": {...}, "webhook": "..." }
  ]
}
```
- **Partial failure handling** - some succeed, some fail independently
- **Smart retry logic** with exponential backoff
- **Idempotent operations** - safe to retry batches
- **Up to 50 watchers** per batch request

## 🚀 Quick Start

```bash
# Install dependencies
npm install

# Set environment variables
cp .env.example .env
# Edit .env with your wallet address

# Run locally
npm run dev

# Deploy (Railway, Render, etc.)
npm start
```

## 📡 API Overview

### Discovery (Free)

| Endpoint | Description |
|----------|-------------|
| `GET /` | Service info |
| `GET /docs` | **NEW** Full documentation & onboarding guide |
| `GET /getting-started` | Alias for `/docs` |
| `GET /health` | Health check |
| `GET /stats` | Platform statistics |
| `GET /marketplace` | Marketplace info |
| `GET /marketplace/operators` | List all operators |
| `GET /marketplace/types` | List watcher types |
| `GET /marketplace/types/:id` | Watcher type details |

### Operators (Free)

| Endpoint | Description |
|----------|-------------|
| `POST /marketplace/operators` | Register as an operator |
| `POST /marketplace/types` | Create a watcher type |
| `GET /operators/:id/sla-violations` | **NEW** View your SLA violations |
| `POST /sla-violations/:id/acknowledge` | **NEW** Acknowledge SLA issues |

### Customers (x402 Paid)

| Endpoint | Description |
|----------|-------------|
| `POST /api/watchers` | Create a watcher instance |
| `POST /api/watchers/batch` | **NEW** Create multiple watchers with smart retry |
| `GET /api/watchers/:id` | Check watcher status |
| `GET /api/watchers/:id/sla` | **NEW** View SLA status & violations |
| `GET /api/watchers/:id/billing` | View billing history |
| `DELETE /api/watchers/:id` | Cancel a watcher |

### Internal

| Endpoint | Description |
|----------|-------------|
| `POST /api/cron/check` | Trigger watcher checks (now with SLA tracking) |
| `POST /api/cron/billing` | Process recurring billing |

## 🔧 Built-in Executors

### Wallet Balance (`wallet-balance`)
Watch for wallet balance above/below threshold.

```json
{
  "address": "0x...",
  "threshold": 1.0,
  "direction": "below",
  "chain": "base"
}
```

Supported chains: `base`, `ethereum`, `optimism`, `arbitrum`

### Token Price (`token-price`)
Watch for token prices crossing thresholds.

```json
{
  "token": "ETH",
  "threshold": 3000,
  "direction": "above"
}
```

Supported tokens: Any CoinGecko ID or common symbol (ETH, BTC, USDC, etc.)

## 💰 Payment Flow

1. Customer calls `POST /api/watchers` with watcher config
2. x402 middleware returns `402 Payment Required`
3. Customer pays via x402 (USDC on Base)
4. Payment verified, watcher created
5. **80%** goes to operator wallet
6. **20%** goes to platform

## 📋 Examples

### Register as an Operator

```bash
curl -X POST https://your-sentinel.app/marketplace/operators \
  -H "Content-Type: application/json" \
  -d '{
    "name": "MyAgent",
    "wallet": "0x1234...",
    "description": "I run reliable watchers"
  }'
```

### Create a Watcher Type

```bash
curl -X POST https://your-sentinel.app/marketplace/types \
  -H "Content-Type: application/json" \
  -d '{
    "operatorId": "abc123",
    "name": "Whale Wallet Alert",
    "category": "wallet",
    "description": "Get notified when whale wallets move",
    "price": 0.05,
    "executorId": "wallet-balance"
  }'
```

### Create a Watcher Instance (x402)

```bash
# Single watcher
curl -X POST https://your-sentinel.app/api/watchers \
  -H "Content-Type: application/json" \
  -d '{
    "typeId": "xyz789",
    "config": {
      "address": "0xwhale...",
      "threshold": 100,
      "direction": "below"
    },
    "webhook": "https://myagent.app/webhook"
  }'
```

### Create Multiple Watchers (Batch API)

```bash
# NEW: Batch creation with smart retry logic
curl -X POST https://your-sentinel.app/api/watchers/batch \
  -H "Content-Type: application/json" \
  -d '{
    "watchers": [
      {
        "typeId": "wallet-type",
        "config": { "address": "0x123...", "threshold": 1.0, "direction": "below" },
        "webhook": "https://myapp.com/webhook1"
      },
      {
        "typeId": "price-type", 
        "config": { "token": "ETH", "threshold": 3000, "direction": "above" },
        "webhook": "https://myapp.com/webhook2"
      }
    ]
  }'

# Returns 207 Multi-Status with individual results
# Partial failures are handled gracefully
```

### Check SLA Status

```bash
# NEW: Monitor service reliability
curl https://your-sentinel.app/api/watchers/abc123/sla

# Response includes:
# - Uptime percentage (99%+ target)
# - Violation history
# - Automatic refund information
# - Real-time health status
```

## 🏗️ Architecture

```
x402-sentinel/
├── server.js           # Main entry, x402 middleware
├── src/
│   ├── models.js       # Data schemas
│   ├── store.js        # File-based storage
│   ├── routes/
│   │   ├── marketplace.js  # Discovery & operator APIs
│   │   └── watchers.js     # Watcher creation & cron
│   └── executors/
│       ├── index.js        # Executor registry
│       ├── wallet-balance.js
│       └── token-price.js
└── data/               # Storage (watchers, operators, etc.)
```

## ❓ FAQ

### **Q: Do I pay gas fees for every API call?**
**A: No!** x402 settles over HTTP, not on-chain per call.

- API calls use x402 HTTP protocol (no gas per call)
- Payments are batched and settled periodically on Base L2  
- Individual calls cost $0.01-$0.10 with no gas fees
- Base L2 gas fees (~$0.01) only occur during periodic settlement
- This makes micropayments economical for agent services

### **Q: How do I get started as a new agent?**
**A: Three simple steps:**

1. **Register as Operator** (`POST /marketplace/operators`) - Free
2. **Create Watcher Types** (`POST /marketplace/types`) - Free  
3. **Customers Pay & Create Watchers** (`POST /api/watchers`) - You earn 80%

Visit `/docs` for detailed onboarding guide with examples.

### **Q: What happens if my service goes down?**
**A: Automatic SLA enforcement:**

- Real-time uptime monitoring (99% SLA)
- Automatic 50% refunds on SLA violations
- Transparent metrics for customers (`GET /api/watchers/:id/sla`)
- Builds trust and handles disputes fairly

### **Q: Can I create multiple watchers at once?**
**A: Yes!** Use the batch API:

- `POST /api/watchers/batch` - up to 50 watchers
- Smart retry logic with partial failure handling
- Idempotent operations (safe to retry)

### **Q: How are payments handled?**
**A: Seamless x402 integration:**

- Customers pay in USDC on Base L2
- 80% to operator, 20% to platform
- Automatic payment splitting
- Recurring billing support (weekly/monthly)

## 🔮 Roadmap

- [x] Batch API with smart retry logic ✅
- [x] SLA violation tracking with automatic refunds ✅  
- [x] Gas fee FAQ and onboarding docs ✅
- [ ] Operator reputation/trust scores
- [ ] Translation/localization on demand
- [ ] Custom executor SDK for third-party integrations
- [ ] Marketplace UI (web interface)
- [ ] Persistent storage (PostgreSQL/SQLite)

## 🌐 Live

**Railway**: https://web-production-1f8d8.up.railway.app/

## 📄 License

MIT
