// x402-sentinel: Agent Services Marketplace
// "Shopify for agent services" - watchers, alerts, automations

// Polyfill crypto for Node 18 (x402/coinbase needs Web Crypto API)
import { webcrypto } from 'crypto';
if (!globalThis.crypto) globalThis.crypto = webcrypto;

import express from 'express';
import { paymentMiddleware, x402ResourceServer } from '@x402/express';
import { ExactEvmScheme } from '@x402/evm/exact/server';
import { HTTPFacilitatorClient } from '@x402/core/server';
import { facilitator as cdpFacilitatorConfig, createCdpAuthHeaders } from '@coinbase/x402';

import marketplaceRoutes from './src/routes/marketplace.js';
import watcherRoutes from './src/routes/watchers.js';
import testWebhookRoutes from './src/routes/test-webhook.js';
import * as store from './src/store.js';

const app = express();
app.use(express.json());

// Configuration
const PLATFORM_WALLET = process.env.WALLET_ADDRESS || '0x1468B3fa064b44bA184aB34FD9CD9eB34E43f197';
const NETWORK = process.env.NETWORK || 'eip155:8453';
const PORT = process.env.PORT || 3402;

// Create facilitator client with CDP auth
const facilitatorClient = new HTTPFacilitatorClient({
  url: cdpFacilitatorConfig.url,
  createAuthHeaders: process.env.CDP_API_KEY_ID 
    ? createCdpAuthHeaders(process.env.CDP_API_KEY_ID, process.env.CDP_API_KEY_SECRET)
    : undefined
});

// Create resource server and register EVM scheme
const server = new x402ResourceServer(facilitatorClient)
  .register(NETWORK, new ExactEvmScheme());

// Build dynamic x402 routes based on registered watcher types
async function buildPaymentRoutes() {
  const routes = {};
  
  try {
    const types = await store.getWatcherTypes({ status: 'active' });
    
    // Each watcher type gets its own x402 route
    // For now, use a single route with type-based pricing
    routes['POST /api/watchers'] = {
      accepts: types.map(t => ({
        scheme: 'exact',
        price: `$${t.price}`,
        network: NETWORK,
        payTo: PLATFORM_WALLET, // Platform receives, then distributes
        description: `Create ${t.name} watcher`,
      })),
      // Default pricing if no types exist
      ...(types.length === 0 && {
        accepts: [{
          scheme: 'exact',
          price: '$0.01',
          network: NETWORK,
          payTo: PLATFORM_WALLET,
        }],
      }),
    };
  } catch (e) {
    // Fallback pricing
    routes['POST /api/watchers'] = {
      accepts: [{
        scheme: 'exact',
        price: '$0.01',
        network: NETWORK,
        payTo: PLATFORM_WALLET,
      }],
    };
  }
  
  return routes;
}

// Initialize with payment middleware
async function initializeApp() {
  const routes = await buildPaymentRoutes();
  
  // Try to apply x402 payment middleware (fails gracefully without credentials)
  const X402_ENABLED = process.env.CDP_API_KEY_ID && process.env.CDP_API_KEY_SECRET;
  
  if (X402_ENABLED) {
    try {
      app.use('/api', paymentMiddleware(routes, server));
      console.log('✅ x402 payments enabled');
    } catch (e) {
      console.warn('⚠️  x402 middleware failed to initialize:', e.message);
      console.warn('   Running without payment protection (dev mode)');
    }
  } else {
    console.warn('⚠️  x402 disabled (no CDP credentials). Running in dev mode.');
  }
  
  // Mount routes
  app.use('/marketplace', marketplaceRoutes);
  app.use('/api', watcherRoutes);
  app.use('/', testWebhookRoutes);  // Free endpoint, no payment required
  
  // ============================================
  // PUBLIC ENDPOINTS
  // ============================================
  
  // Root - service discovery
  app.get('/', (req, res) => {
    res.json({
      service: 'x402-sentinel',
      tagline: 'Agent Services Marketplace',
      version: '2.0.0',
      description: 'A marketplace where agents sell execution services to other agents. Watchers, alerts, automations - all paid via x402 micropayments.',
      operator: 'SparkOC',
      wallet: PLATFORM_WALLET,
      network: `Base (${NETWORK})`,
      fees: {
        platform: '20%',
        operators: '80%',
      },
      endpoints: {
        // Discovery
        'GET /': 'This info',
        'GET /health': 'Health check',
        'GET /marketplace': 'Marketplace info and endpoints',
        'GET /marketplace/operators': 'List operators',
        'GET /marketplace/types': 'List watcher types',
        
        // Operator actions (free)
        'POST /marketplace/operators': 'Register as an operator',
        'POST /marketplace/types': 'Create a watcher type',
        
        // Testing (free)
        'POST /test-webhook': 'Test webhook URL before subscribing (free)',
        
        // Customer actions (x402 paid)
        'POST /api/watchers': 'Create a watcher instance ($0.01+) - idempotent with receipts',
        'GET /marketplace/watchers/:id': 'Check watcher status',
        
        // Receipts (audit trail)
        'GET /marketplace/receipts': 'List receipts (filter by customerId, watcherId)',
        'GET /marketplace/receipts/:id': 'Get receipt by ID',
        'GET /marketplace/receipts/verify/:hash': 'Verify receipt by fulfillment hash',
        
        // Internal
        'POST /api/cron/check': 'Trigger watcher checks (internal)',
      },
      protocol: 'x402',
      docs: 'https://x402.org',
      source: 'https://github.com/victor-grajski/x402-intel',
    });
  });
  
  // Health check
  app.get('/health', (req, res) => {
    res.json({ 
      status: 'ok', 
      version: '2.0.0',
      timestamp: new Date().toISOString(),
    });
  });
  
  // Stats endpoint
  app.get('/stats', async (req, res) => {
    try {
      const operators = await store.getOperators();
      const types = await store.getWatcherTypes();
      const watchers = await store.getWatchers();
      const payments = await store.getPayments();
      
      const totalRevenue = payments.reduce((sum, p) => sum + p.amount, 0);
      
      res.json({
        operators: operators.length,
        watcherTypes: types.length,
        activeWatchers: watchers.filter(w => w.status === 'active').length,
        totalWatchers: watchers.length,
        totalPayments: payments.length,
        totalRevenue: `$${totalRevenue.toFixed(4)}`,
        platformRevenue: `$${(totalRevenue * 0.2).toFixed(4)}`,
      });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });
  
  // Start server
  app.listen(PORT, () => {
    console.log(`
╔═══════════════════════════════════════════════════════════════╗
║                      x402-sentinel v2.0                       ║
║               Agent Services Marketplace                       ║
╠═══════════════════════════════════════════════════════════════╣
║  🌐 Service:     http://localhost:${PORT}/                       ║
║  📊 Marketplace: http://localhost:${PORT}/marketplace            ║
║  💳 Payments:    x402 on Base (${NETWORK})           ║
║  👛 Wallet:      ${PLATFORM_WALLET.slice(0, 10)}...${PLATFORM_WALLET.slice(-8)}                ║
║  💰 Fee split:   20% platform / 80% operator                  ║
╚═══════════════════════════════════════════════════════════════╝
    `);
  });
}

// Auto-seed marketplace if empty
async function autoSeed() {
  const operators = await store.getOperators();
  if (operators.length > 0) return;
  
  console.log('🌱 Auto-seeding marketplace...');
  
  // Register SparkOC as first operator
  const operator = await store.createOperator({
    name: 'SparkOC',
    wallet: PLATFORM_WALLET,
    description: 'Platform operator. Built-in watchers for wallet balances and token prices.',
    website: 'https://github.com/victor-grajski/x402-intel',
  });
  
  // Create wallet balance watcher type
  await store.createWatcherType({
    operatorId: operator.id,
    name: 'Wallet Balance Alert',
    category: 'wallet',
    description: 'Get notified when a wallet balance goes above or below a threshold. Supports Base, Ethereum, Optimism, and Arbitrum.',
    price: 0.01,
    executorId: 'wallet-balance',
  });
  
  // Create token price watcher type
  await store.createWatcherType({
    operatorId: operator.id,
    name: 'Token Price Alert',
    category: 'price',
    description: 'Get notified when a token price crosses a threshold. Uses CoinGecko for price data.',
    price: 0.01,
    executorId: 'token-price',
  });
  
  console.log('✅ Marketplace seeded with SparkOC operator and 2 watcher types');
}

// Boot
initializeApp()
  .then(() => autoSeed())
  .catch(err => {
    console.error('Failed to start:', err);
    process.exit(1);
  });
