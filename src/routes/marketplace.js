// Marketplace API routes

import { Router } from 'express';
import * as store from '../store.js';
import { getExecutor, listExecutors } from '../executors/index.js';
import { CATEGORIES, PLATFORM_FEE, OPERATOR_SHARE, FREE_TIER } from '../models.js';

const router = Router();

// ============================================
// DISCOVERY (free)
// ============================================

// Service info
router.get('/', (req, res) => {
  res.json({
    service: 'x402-sentinel marketplace',
    version: '2.0.0',
    description: 'Agent services marketplace - watchers, alerts, automations',
    categories: CATEGORIES,
    builtInExecutors: listExecutors(),
    fees: {
      platform: `${PLATFORM_FEE * 100}%`,
      operator: `${OPERATOR_SHARE * 100}%`,
    },
    freeTier: {
      available: true,
      maxWatchers: FREE_TIER.MAX_WATCHERS,
      pollingIntervalMin: FREE_TIER.POLLING_INTERVAL_MIN,
      description: 'New users start with free tier - 1 watcher, 30-minute polling minimum',
      upgradeInfo: FREE_TIER.UPGRADE_PROMPT
    },
    endpoints: {
      // Discovery
      'GET /marketplace': 'This info',
      'GET /marketplace/operators': 'List all operators',
      'GET /marketplace/types': 'List all watcher types',
      'GET /marketplace/types/:id': 'Get watcher type details',
      
      // Operator management
      'POST /marketplace/operators': 'Register as an operator (free)',
      'POST /marketplace/types': 'Create a watcher type (operators only, free)',
      
      // Customer actions
      'POST /marketplace/watchers': 'Create a watcher instance (x402 payment) - idempotent',
      'GET /marketplace/watchers/:id': 'Get watcher status',
      'DELETE /marketplace/watchers/:id': 'Delete a watcher',
      'POST /customers/:id/upgrade': 'Upgrade customer to paid tier (x402 payment)',
      
      // Receipts (audit trail)
      'GET /marketplace/receipts': 'List receipts (filter by customerId, watcherId)',
      'GET /marketplace/receipts/:id': 'Get receipt by ID',
      'GET /marketplace/receipts/verify/:hash': 'Verify receipt by fulfillment hash',
    },
  });
});

// List operators
router.get('/operators', async (req, res) => {
  try {
    const operators = await store.getOperators();
    res.json({
      count: operators.length,
      operators: operators.map(o => ({
        id: o.id,
        name: o.name,
        description: o.description,
        website: o.website,
        stats: o.stats,
        createdAt: o.createdAt,
      })),
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// List watcher types
router.get('/types', async (req, res) => {
  try {
    const { category, operatorId } = req.query;
    const types = await store.getWatcherTypes({ 
      category, 
      operatorId,
      status: 'active',
    });
    
    // Enrich with operator names
    const operators = await store.getOperators();
    const operatorMap = Object.fromEntries(operators.map(o => [o.id, o]));
    
    res.json({
      count: types.length,
      types: types.map(t => ({
        id: t.id,
        name: t.name,
        category: t.category,
        description: t.description,
        price: t.price,
        operator: operatorMap[t.operatorId]?.name || 'Unknown',
        operatorId: t.operatorId,
        stats: t.stats,
      })),
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get watcher type details
router.get('/types/:id', async (req, res) => {
  try {
    const type = await store.getWatcherType(req.params.id);
    if (!type) {
      return res.status(404).json({ error: 'Watcher type not found' });
    }
    
    const operator = await store.getOperator(type.operatorId);
    
    res.json({
      ...type,
      operator: operator ? {
        id: operator.id,
        name: operator.name,
        stats: operator.stats,
      } : null,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// OPERATOR MANAGEMENT (free)
// ============================================

// Register as an operator
router.post('/operators', async (req, res) => {
  try {
    const { name, wallet, description, website } = req.body;
    
    // Validate
    if (!name || typeof name !== 'string' || name.length < 2) {
      return res.status(400).json({ error: 'Name is required (min 2 chars)' });
    }
    if (!wallet || !wallet.match(/^0x[a-fA-F0-9]{40}$/)) {
      return res.status(400).json({ error: 'Valid wallet address required' });
    }
    
    // Check if wallet already registered
    const existing = await store.getOperatorByWallet(wallet);
    if (existing) {
      return res.status(409).json({ 
        error: 'Wallet already registered',
        operatorId: existing.id,
      });
    }
    
    const operator = await store.createOperator({
      name,
      wallet: wallet.toLowerCase(),
      description: description || '',
      website: website || null,
    });
    
    res.status(201).json({
      success: true,
      operator: {
        id: operator.id,
        name: operator.name,
        wallet: operator.wallet,
      },
      message: 'Operator registered. You can now create watcher types.',
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Create a watcher type (operator only)
router.post('/types', async (req, res) => {
  try {
    const { operatorId, name, category, description, price, executorId, configSchema } = req.body;
    
    // Validate operator
    const operator = await store.getOperator(operatorId);
    if (!operator) {
      return res.status(404).json({ error: 'Operator not found' });
    }
    
    // Validate fields
    if (!name || name.length < 3) {
      return res.status(400).json({ error: 'Name required (min 3 chars)' });
    }
    if (!CATEGORIES.includes(category)) {
      return res.status(400).json({ error: `Invalid category. Must be one of: ${CATEGORIES.join(', ')}` });
    }
    if (typeof price !== 'number' || price < 0.001) {
      return res.status(400).json({ error: 'Price must be at least $0.001' });
    }
    
    // Validate executor if using built-in
    if (executorId) {
      const executor = getExecutor(executorId);
      if (!executor) {
        return res.status(400).json({ 
          error: `Unknown executor. Available: ${listExecutors().join(', ')}` 
        });
      }
    }
    
    const type = await store.createWatcherType({
      operatorId,
      name,
      category,
      description: description || '',
      price,
      executorId: executorId || null,
      configSchema: configSchema || null,
    });
    
    res.status(201).json({
      success: true,
      type: {
        id: type.id,
        name: type.name,
        price: type.price,
      },
      message: `Watcher type created. Customers pay $${price}, you receive $${(price * OPERATOR_SHARE).toFixed(4)}.`,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// WATCHER INSTANCES
// ============================================

// Get watcher status
router.get('/watchers/:id', async (req, res) => {
  try {
    const watcher = await store.getWatcher(req.params.id);
    if (!watcher) {
      return res.status(404).json({ error: 'Watcher not found' });
    }
    
    const type = await store.getWatcherType(watcher.typeId);
    
    res.json({
      ...watcher,
      typeName: type?.name || 'Unknown',
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Delete watcher
router.delete('/watchers/:id', async (req, res) => {
  try {
    const deleted = await store.deleteWatcher(req.params.id);
    if (!deleted) {
      return res.status(404).json({ error: 'Watcher not found' });
    }
    res.json({ success: true, message: 'Watcher deleted' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// List watchers (for a customer)
router.get('/watchers', async (req, res) => {
  try {
    const { customerId } = req.query;
    const watchers = await store.getWatchers({ customerId });
    
    res.json({
      count: watchers.length,
      watchers: watchers.map(w => ({
        id: w.id,
        typeId: w.typeId,
        status: w.status,
        triggerCount: w.triggerCount,
        lastChecked: w.lastChecked,
        createdAt: w.createdAt,
      })),
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// RECEIPTS (audit trail)
// ============================================

// List receipts
router.get('/receipts', async (req, res) => {
  try {
    const { customerId, watcherId } = req.query;
    const receipts = await store.getReceipts({ customerId, watcherId });
    
    res.json({
      count: receipts.length,
      receipts: receipts.map(r => ({
        id: r.id,
        watcherId: r.watcherId,
        typeId: r.typeId,
        amount: r.amount,
        chain: r.chain,
        rail: r.rail,
        timestamp: r.timestamp,
        fulfillmentHash: r.fulfillmentHash,
      })),
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get single receipt
router.get('/receipts/:id', async (req, res) => {
  try {
    const receipt = await store.getReceipt(req.params.id);
    if (!receipt) {
      return res.status(404).json({ error: 'Receipt not found' });
    }
    
    res.json(receipt);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Verify receipt by fulfillment hash
router.get('/receipts/verify/:hash', async (req, res) => {
  try {
    const receipt = await store.getReceiptByHash(req.params.hash);
    if (!receipt) {
      return res.status(404).json({ 
        verified: false, 
        error: 'No receipt found for this fulfillment hash' 
      });
    }
    
    res.json({
      verified: true,
      receipt,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
