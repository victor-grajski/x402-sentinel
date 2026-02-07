// x402-sentinel: Data store (file-based, swappable for DB later)

import fs from 'fs/promises';
import path from 'path';

import crypto from 'crypto';

const DATA_DIR = process.env.DATA_DIR || './data';

// File paths
const OPERATORS_FILE = path.join(DATA_DIR, 'operators.json');
const WATCHER_TYPES_FILE = path.join(DATA_DIR, 'watcher-types.json');
const WATCHERS_FILE = path.join(DATA_DIR, 'watchers.json');
const PAYMENTS_FILE = path.join(DATA_DIR, 'payments.json');
const RECEIPTS_FILE = path.join(DATA_DIR, 'receipts.json');
const CUSTOMERS_FILE = path.join(DATA_DIR, 'customers.json');
const SLA_VIOLATIONS_FILE = path.join(DATA_DIR, 'sla-violations.json');

// Helpers
async function ensureDataDir() {
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
  } catch (e) { /* ignore */ }
}

async function readJson(file, defaultValue = {}) {
  try {
    const data = await fs.readFile(file, 'utf-8');
    return JSON.parse(data);
  } catch (e) {
    return defaultValue;
  }
}

async function writeJson(file, data) {
  await ensureDataDir();
  await fs.writeFile(file, JSON.stringify(data, null, 2));
}

export function generateId() {
  return Math.random().toString(36).substring(2, 10) + 
         Math.random().toString(36).substring(2, 10);
}

// Operators
export async function getOperators() {
  const data = await readJson(OPERATORS_FILE, { operators: [] });
  return data.operators;
}

export async function getOperator(id) {
  const operators = await getOperators();
  return operators.find(o => o.id === id);
}

export async function getOperatorByWallet(wallet) {
  const operators = await getOperators();
  return operators.find(o => o.wallet.toLowerCase() === wallet.toLowerCase());
}

export async function createOperator(operator) {
  const data = await readJson(OPERATORS_FILE, { operators: [] });
  const newOperator = {
    id: generateId(),
    ...operator,
    status: 'active',
    createdAt: new Date().toISOString(),
    stats: {
      watchersCreated: 0,
      totalTriggers: 0,
      totalEarned: 0,
      uptimePercent: 100,
    },
  };
  data.operators.push(newOperator);
  await writeJson(OPERATORS_FILE, data);
  return newOperator;
}

export async function updateOperator(id, updates) {
  const data = await readJson(OPERATORS_FILE, { operators: [] });
  const index = data.operators.findIndex(o => o.id === id);
  if (index === -1) return null;
  data.operators[index] = { ...data.operators[index], ...updates };
  await writeJson(OPERATORS_FILE, data);
  return data.operators[index];
}

// Watcher Types
export async function getWatcherTypes(filters = {}) {
  const data = await readJson(WATCHER_TYPES_FILE, { types: [] });
  let types = data.types;
  
  if (filters.operatorId) {
    types = types.filter(t => t.operatorId === filters.operatorId);
  }
  if (filters.category) {
    types = types.filter(t => t.category === filters.category);
  }
  if (filters.status) {
    types = types.filter(t => t.status === filters.status);
  }
  
  return types;
}

export async function getWatcherType(id) {
  const types = await getWatcherTypes();
  return types.find(t => t.id === id);
}

export async function createWatcherType(type) {
  const data = await readJson(WATCHER_TYPES_FILE, { types: [] });
  const newType = {
    id: generateId(),
    ...type,
    status: 'active',
    createdAt: new Date().toISOString(),
    stats: {
      instances: 0,
      triggers: 0,
    },
  };
  data.types.push(newType);
  await writeJson(WATCHER_TYPES_FILE, data);
  return newType;
}

export async function updateWatcherType(id, updates) {
  const data = await readJson(WATCHER_TYPES_FILE, { types: [] });
  const index = data.types.findIndex(t => t.id === id);
  if (index === -1) return null;
  data.types[index] = { ...data.types[index], ...updates };
  await writeJson(WATCHER_TYPES_FILE, data);
  return data.types[index];
}

// Watchers (instances)
export async function getWatchers(filters = {}) {
  const data = await readJson(WATCHERS_FILE, { watchers: [] });
  let watchers = data.watchers;
  
  if (filters.operatorId) {
    watchers = watchers.filter(w => w.operatorId === filters.operatorId);
  }
  if (filters.typeId) {
    watchers = watchers.filter(w => w.typeId === filters.typeId);
  }
  if (filters.customerId) {
    watchers = watchers.filter(w => w.customerId === filters.customerId);
  }
  if (filters.status) {
    watchers = watchers.filter(w => w.status === filters.status);
  }
  
  return watchers;
}

export async function getWatcher(id) {
  const watchers = await getWatchers();
  return watchers.find(w => w.id === id);
}

export async function createWatcher(watcher) {
  const data = await readJson(WATCHERS_FILE, { watchers: [] });
  
  // Calculate expiresAt from ttl if provided
  let expiresAt = null;
  if (watcher.ttl && watcher.ttl > 0) {
    const expiryDate = new Date();
    expiryDate.setHours(expiryDate.getHours() + watcher.ttl);
    expiresAt = expiryDate.toISOString();
  }
  
  const newWatcher = {
    id: generateId(),
    ...watcher,
    status: 'active',
    createdAt: new Date().toISOString(),
    expiresAt: expiresAt,
    lastChecked: null,
    lastTriggered: null,
    triggerCount: 0,
    billingCycle: watcher.billingCycle || 'one-time',
    nextBillingAt: watcher.nextBillingAt || null,
    billingHistory: [],
    cancelledAt: null,
    cancellationReason: null,
    // Initialize SLA tracking
    sla: {
      uptimePercent: 100,
      violationCount: 0,
      lastViolation: null,
      downtimePeriods: []
    },
    lastCheckSuccess: null,
    consecutiveFailures: 0,
  };
  data.watchers.push(newWatcher);
  await writeJson(WATCHERS_FILE, data);
  return newWatcher;
}

export async function updateWatcher(id, updates) {
  const data = await readJson(WATCHERS_FILE, { watchers: [] });
  const index = data.watchers.findIndex(w => w.id === id);
  if (index === -1) return null;
  data.watchers[index] = { ...data.watchers[index], ...updates };
  await writeJson(WATCHERS_FILE, data);
  return data.watchers[index];
}

export async function deleteWatcher(id) {
  const data = await readJson(WATCHERS_FILE, { watchers: [] });
  const index = data.watchers.findIndex(w => w.id === id);
  if (index === -1) return false;
  data.watchers.splice(index, 1);
  await writeJson(WATCHERS_FILE, data);
  return true;
}

// Payments
export async function getPayments(filters = {}) {
  const data = await readJson(PAYMENTS_FILE, { payments: [] });
  let payments = data.payments;
  
  if (filters.operatorId) {
    payments = payments.filter(p => p.operatorId === filters.operatorId);
  }
  if (filters.customerId) {
    payments = payments.filter(p => p.customerId === filters.customerId);
  }
  if (filters.watcherId) {
    payments = payments.filter(p => p.watcherId === filters.watcherId);
  }
  if (filters.since) {
    payments = payments.filter(p => p.createdAt >= filters.since);
  }
  if (filters.type) {
    payments = payments.filter(p => p.type === filters.type);
  }
  
  return payments.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

export async function createPayment(payment) {
  const data = await readJson(PAYMENTS_FILE, { payments: [] });
  const newPayment = {
    id: generateId(),
    ...payment,
    createdAt: new Date().toISOString(),
  };
  data.payments.push(newPayment);
  await writeJson(PAYMENTS_FILE, data);
  return newPayment;
}

// Stats helpers
export async function incrementOperatorStats(operatorId, field, amount = 1) {
  const data = await readJson(OPERATORS_FILE, { operators: [] });
  const index = data.operators.findIndex(o => o.id === operatorId);
  if (index === -1) return;
  
  data.operators[index].stats[field] = 
    (data.operators[index].stats[field] || 0) + amount;
  await writeJson(OPERATORS_FILE, data);
}

export async function incrementWatcherTypeStats(typeId, field, amount = 1) {
  const data = await readJson(WATCHER_TYPES_FILE, { types: [] });
  const index = data.types.findIndex(t => t.id === typeId);
  if (index === -1) return;
  
  data.types[index].stats[field] = 
    (data.types[index].stats[field] || 0) + amount;
  await writeJson(WATCHER_TYPES_FILE, data);
}

// Customers
export async function getCustomers(filters = {}) {
  const data = await readJson(CUSTOMERS_FILE, { customers: [] });
  let customers = data.customers;
  
  if (filters.tier) {
    customers = customers.filter(c => c.tier === filters.tier);
  }
  
  return customers;
}

export async function getCustomer(id) {
  const customers = await getCustomers();
  return customers.find(c => c.id === id);
}

export async function createCustomer(customer) {
  const data = await readJson(CUSTOMERS_FILE, { customers: [] });
  const newCustomer = {
    id: customer.id,
    tier: customer.tier || 'free',
    freeWatchersUsed: customer.freeWatchersUsed || 0,
    createdAt: new Date().toISOString(),
    upgradedAt: customer.tier === 'paid' ? new Date().toISOString() : null,
    stats: {
      totalWatchersCreated: 0,
      totalSpent: 0,
    },
  };
  data.customers.push(newCustomer);
  await writeJson(CUSTOMERS_FILE, data);
  return newCustomer;
}

export async function updateCustomer(id, updates) {
  const data = await readJson(CUSTOMERS_FILE, { customers: [] });
  const index = data.customers.findIndex(c => c.id === id);
  if (index === -1) return null;
  data.customers[index] = { ...data.customers[index], ...updates };
  await writeJson(CUSTOMERS_FILE, data);
  return data.customers[index];
}

export async function incrementCustomerStats(customerId, field, amount = 1) {
  const data = await readJson(CUSTOMERS_FILE, { customers: [] });
  const index = data.customers.findIndex(c => c.id === customerId);
  if (index === -1) return;
  
  data.customers[index].stats[field] = 
    (data.customers[index].stats[field] || 0) + amount;
  await writeJson(CUSTOMERS_FILE, data);
}

// Receipts - Idempotent fulfillment records

/**
 * Generate a deterministic hash for idempotency.
 * Same inputs = same hash = same receipt returned (no duplicate charge)
 */
export function generateFulfillmentHash(params) {
  const normalized = JSON.stringify({
    typeId: params.typeId,
    config: params.config,
    webhook: params.webhook,
    customerId: params.customerId,
  }, Object.keys(params).sort());
  
  return crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 32);
}

export async function getReceipts(filters = {}) {
  const data = await readJson(RECEIPTS_FILE, { receipts: [] });
  let receipts = data.receipts;
  
  if (filters.watcherId) {
    receipts = receipts.filter(r => r.watcherId === filters.watcherId);
  }
  if (filters.customerId) {
    receipts = receipts.filter(r => r.customerId === filters.customerId);
  }
  if (filters.fulfillmentHash) {
    receipts = receipts.filter(r => r.fulfillmentHash === filters.fulfillmentHash);
  }
  
  return receipts;
}

export async function getReceipt(id) {
  const receipts = await getReceipts();
  return receipts.find(r => r.id === id);
}

export async function getReceiptByHash(fulfillmentHash) {
  const receipts = await getReceipts({ fulfillmentHash });
  return receipts[0] || null;
}

export async function createReceipt(receipt) {
  const data = await readJson(RECEIPTS_FILE, { receipts: [] });
  const newReceipt = {
    id: 'rcpt_' + generateId(),
    ...receipt,
    timestamp: new Date().toISOString(),
  };
  data.receipts.push(newReceipt);
  await writeJson(RECEIPTS_FILE, data);
  return newReceipt;
}

// SLA Violations

export async function getSLAViolations(filters = {}) {
  const data = await readJson(SLA_VIOLATIONS_FILE, { violations: [] });
  let violations = data.violations;
  
  if (filters.watcherId) {
    violations = violations.filter(v => v.watcherId === filters.watcherId);
  }
  if (filters.operatorId) {
    violations = violations.filter(v => v.operatorId === filters.operatorId);
  }
  if (filters.customerId) {
    violations = violations.filter(v => v.customerId === filters.customerId);
  }
  if (filters.violationType) {
    violations = violations.filter(v => v.violationType === filters.violationType);
  }
  if (filters.since) {
    violations = violations.filter(v => v.createdAt >= filters.since);
  }
  
  return violations.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

export async function getSLAViolation(id) {
  const violations = await getSLAViolations();
  return violations.find(v => v.id === id);
}

export async function createSLAViolation(violation) {
  const data = await readJson(SLA_VIOLATIONS_FILE, { violations: [] });
  const newViolation = {
    id: 'sla_' + generateId(),
    ...violation,
    createdAt: new Date().toISOString(),
  };
  data.violations.push(newViolation);
  await writeJson(SLA_VIOLATIONS_FILE, data);
  return newViolation;
}

export async function updateSLAViolation(id, updates) {
  const data = await readJson(SLA_VIOLATIONS_FILE, { violations: [] });
  const index = data.violations.findIndex(v => v.id === id);
  if (index === -1) return null;
  
  data.violations[index] = { ...data.violations[index], ...updates };
  await writeJson(SLA_VIOLATIONS_FILE, data);
  return data.violations[index];
}
