// Polyfill crypto for Node 18 (x402/coinbase needs Web Crypto API)
import { webcrypto } from 'crypto';
if (!globalThis.crypto) globalThis.crypto = webcrypto;

import express from 'express';
import { paymentMiddleware, x402ResourceServer } from '@x402/express';
import { ExactEvmScheme } from '@x402/evm/exact/server';
import { HTTPFacilitatorClient } from '@x402/core/server';
import { facilitator as cdpFacilitatorConfig, createCdpAuthHeaders } from '@coinbase/x402';
import { createPublicClient, http, formatEther } from 'viem';
import { base } from 'viem/chains';
import fs from 'fs/promises';
import path from 'path';

const app = express();
app.use(express.json());

// Configuration
const payTo = process.env.WALLET_ADDRESS || '0x1468B3fa064b44bA184aB34FD9CD9eB34E43f197';
const BASE_NETWORK = process.env.NETWORK || 'eip155:8453';
const DATA_DIR = process.env.DATA_DIR || './data';
const WATCHERS_FILE = path.join(DATA_DIR, 'watchers.json');

// Viem client for Base
const baseClient = createPublicClient({
  chain: base,
  transport: http(process.env.BASE_RPC_URL || 'https://mainnet.base.org'),
});

// Create facilitator client with CDP auth
const facilitatorClient = new HTTPFacilitatorClient({
  url: cdpFacilitatorConfig.url,
  createAuthHeaders: process.env.CDP_API_KEY_ID 
    ? createCdpAuthHeaders(process.env.CDP_API_KEY_ID, process.env.CDP_API_KEY_SECRET)
    : undefined
});

// Create resource server and register EVM scheme
const server = new x402ResourceServer(facilitatorClient)
  .register(BASE_NETWORK, new ExactEvmScheme());

// Watcher storage helpers
async function ensureDataDir() {
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
  } catch (e) {
    // ignore if exists
  }
}

async function loadWatchers() {
  try {
    const data = await fs.readFile(WATCHERS_FILE, 'utf-8');
    return JSON.parse(data);
  } catch (e) {
    return { watchers: [] };
  }
}

async function saveWatchers(data) {
  await ensureDataDir();
  await fs.writeFile(WATCHERS_FILE, JSON.stringify(data, null, 2));
}

function generateId() {
  return Math.random().toString(36).substring(2, 15);
}

// Route configurations with x402 payment requirements
const routes = {
  'POST /watchers': {
    accepts: [
      {
        scheme: 'exact',
        price: '$0.01', // 1 cent to create a watcher
        network: BASE_NETWORK,
        payTo,
      },
    ],
    description: 'Create a wallet balance watcher',
    mimeType: 'application/json',
  },
};

// Apply x402 payment middleware
app.use(paymentMiddleware(routes, server));

// Free endpoint - health check and service discovery
app.get('/', (req, res) => {
  res.json({ 
    service: 'x402-sentinel',
    version: '1.0.0',
    description: 'Execution services for agents: watchers, alerts, automations',
    operator: 'SparkOC',
    wallet: payTo,
    network: `Base (${BASE_NETWORK})`,
    endpoints: {
      'POST /watchers': {
        price: '$0.01',
        description: 'Create a wallet balance watcher. Body: { address, threshold, direction, webhook }'
      },
      'GET /watchers/:id': {
        price: 'free',
        description: 'Check watcher status'
      },
      'POST /cron/check': {
        price: 'free (internal)',
        description: 'Trigger watcher checks (called by cron)'
      }
    },
    protocol: 'x402',
    docs: 'https://x402.org'
  });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Create a watcher (x402 protected)
app.post('/watchers', async (req, res) => {
  try {
    const { address, threshold, direction = 'below', webhook, name } = req.body;
    
    // Validate
    if (!address || !address.match(/^0x[a-fA-F0-9]{40}$/)) {
      return res.status(400).json({ error: 'Invalid address' });
    }
    if (typeof threshold !== 'number' || threshold < 0) {
      return res.status(400).json({ error: 'Invalid threshold (must be number in ETH)' });
    }
    if (!['above', 'below'].includes(direction)) {
      return res.status(400).json({ error: 'Invalid direction (must be "above" or "below")' });
    }
    if (!webhook || !webhook.startsWith('http')) {
      return res.status(400).json({ error: 'Invalid webhook URL' });
    }

    const watcher = {
      id: generateId(),
      address: address.toLowerCase(),
      threshold,
      direction,
      webhook,
      name: name || `Watcher for ${address.slice(0, 8)}...`,
      status: 'active',
      createdAt: new Date().toISOString(),
      lastChecked: null,
      lastTriggered: null,
      triggerCount: 0,
    };

    const data = await loadWatchers();
    data.watchers.push(watcher);
    await saveWatchers(data);

    console.log(`✅ Created watcher ${watcher.id} for ${address}`);
    
    res.status(201).json({
      success: true,
      watcher: {
        id: watcher.id,
        address: watcher.address,
        threshold: watcher.threshold,
        direction: watcher.direction,
        name: watcher.name,
        status: watcher.status,
      },
      message: `Watching ${address} for balance ${direction} ${threshold} ETH`
    });
  } catch (error) {
    console.error('Error creating watcher:', error);
    res.status(500).json({ error: 'Failed to create watcher' });
  }
});

// Get watcher status (free)
app.get('/watchers/:id', async (req, res) => {
  try {
    const data = await loadWatchers();
    const watcher = data.watchers.find(w => w.id === req.params.id);
    
    if (!watcher) {
      return res.status(404).json({ error: 'Watcher not found' });
    }

    // Get current balance
    let currentBalance = null;
    try {
      const balance = await baseClient.getBalance({ address: watcher.address });
      currentBalance = parseFloat(formatEther(balance));
    } catch (e) {
      console.error('Error fetching balance:', e);
    }

    res.json({
      ...watcher,
      currentBalance,
      conditionMet: currentBalance !== null ? 
        (watcher.direction === 'above' ? currentBalance > watcher.threshold : currentBalance < watcher.threshold) 
        : null,
    });
  } catch (error) {
    console.error('Error getting watcher:', error);
    res.status(500).json({ error: 'Failed to get watcher' });
  }
});

// Delete a watcher (free - owner should have the ID)
app.delete('/watchers/:id', async (req, res) => {
  try {
    const data = await loadWatchers();
    const index = data.watchers.findIndex(w => w.id === req.params.id);
    
    if (index === -1) {
      return res.status(404).json({ error: 'Watcher not found' });
    }

    data.watchers.splice(index, 1);
    await saveWatchers(data);

    res.json({ success: true, message: 'Watcher deleted' });
  } catch (error) {
    console.error('Error deleting watcher:', error);
    res.status(500).json({ error: 'Failed to delete watcher' });
  }
});

// Cron endpoint - check all watchers
app.post('/cron/check', async (req, res) => {
  const results = { checked: 0, triggered: 0, errors: 0 };
  
  try {
    const data = await loadWatchers();
    
    for (const watcher of data.watchers) {
      if (watcher.status !== 'active') continue;
      
      results.checked++;
      
      try {
        const balance = await baseClient.getBalance({ address: watcher.address });
        const balanceEth = parseFloat(formatEther(balance));
        
        watcher.lastChecked = new Date().toISOString();
        watcher.lastBalance = balanceEth;
        
        const conditionMet = watcher.direction === 'above' 
          ? balanceEth > watcher.threshold 
          : balanceEth < watcher.threshold;
        
        if (conditionMet) {
          // Fire webhook
          try {
            await fetch(watcher.webhook, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                event: 'balance_alert',
                watcher: {
                  id: watcher.id,
                  name: watcher.name,
                  address: watcher.address,
                },
                condition: {
                  direction: watcher.direction,
                  threshold: watcher.threshold,
                  currentBalance: balanceEth,
                },
                timestamp: new Date().toISOString(),
                source: 'x402-sentinel',
              }),
            });
            
            watcher.lastTriggered = new Date().toISOString();
            watcher.triggerCount++;
            results.triggered++;
            
            console.log(`🔔 Triggered watcher ${watcher.id}: ${watcher.address} balance ${balanceEth} ETH`);
          } catch (webhookError) {
            console.error(`Webhook failed for ${watcher.id}:`, webhookError.message);
            results.errors++;
          }
        }
      } catch (e) {
        console.error(`Error checking watcher ${watcher.id}:`, e.message);
        results.errors++;
      }
    }
    
    await saveWatchers(data);
    
    res.json({ 
      success: true, 
      ...results,
      timestamp: new Date().toISOString() 
    });
  } catch (error) {
    console.error('Cron check error:', error);
    res.status(500).json({ error: 'Cron check failed', ...results });
  }
});

// List all watchers (for debugging - could be removed in prod)
app.get('/watchers', async (req, res) => {
  try {
    const data = await loadWatchers();
    res.json({
      count: data.watchers.length,
      watchers: data.watchers.map(w => ({
        id: w.id,
        name: w.name,
        address: w.address,
        threshold: w.threshold,
        direction: w.direction,
        status: w.status,
        triggerCount: w.triggerCount,
        lastChecked: w.lastChecked,
      }))
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to list watchers' });
  }
});

const PORT = process.env.PORT || 3402;
app.listen(PORT, () => {
  console.log(`\n👁️  x402-sentinel running on port ${PORT}`);
  console.log(`📡 Service info: http://localhost:${PORT}/`);
  console.log(`💳 Accepting x402 payments to: ${payTo}`);
  console.log(`🔗 Network: Base mainnet (${BASE_NETWORK})\n`);
});
