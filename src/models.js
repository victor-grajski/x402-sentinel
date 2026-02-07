// x402-sentinel: Core data models for the marketplace

/**
 * Operator - An agent or entity that provides watcher services
 */
export const OperatorSchema = {
  id: 'string',           // unique ID
  name: 'string',         // display name
  wallet: 'string',       // payment address (80% goes here)
  description: 'string',  // what they offer
  website: 'string?',     // optional URL
  status: 'string',       // active, suspended, pending
  createdAt: 'string',    // ISO timestamp
  stats: {
    watchersCreated: 'number',
    totalTriggers: 'number', 
    totalEarned: 'number',   // in USD
    uptimePercent: 'number', // 0-100
  },
};

/**
 * WatcherType - A template for a kind of watcher an operator offers
 */
export const WatcherTypeSchema = {
  id: 'string',           // unique ID
  operatorId: 'string',   // who created this type
  name: 'string',         // e.g., "Wallet Balance Alert"
  category: 'string',     // wallet, price, contract, social, custom
  description: 'string',  // what it does
  price: 'number',        // cost in USD to create an instance
  configSchema: 'object', // JSON schema for required config
  status: 'string',       // active, deprecated
  createdAt: 'string',
  stats: {
    instances: 'number',   // how many active watchers
    triggers: 'number',    // total triggers across all instances
  },
};

/**
 * Watcher - An instance of a watcher type, created by a paying customer
 */
export const WatcherSchema = {
  id: 'string',
  typeId: 'string',       // which watcher type
  operatorId: 'string',   // who runs it
  customerId: 'string',   // who paid for it (wallet or agent ID)
  config: 'object',       // type-specific configuration
  webhook: 'string',      // where to send alerts
  status: 'string',       // active, paused, expired, suspended, cancelled
  createdAt: 'string',
  expiresAt: 'string?',   // optional expiry
  lastChecked: 'string?',
  lastTriggered: 'string?',
  triggerCount: 'number',
  billingCycle: 'string', // "one-time" | "weekly" | "monthly"
  nextBillingAt: 'string?', // timestamp for next billing (null for one-time)
  billingHistory: 'array', // array of billing records
  cancelledAt: 'string?', // timestamp when cancelled
  cancellationReason: 'string?', // optional reason for cancellation
  // Configurable polling options
  pollingInterval: 'number', // minutes between checks (5, 15, 30, 60)
  ttl: 'number?',         // hours until expiry (24, 72, 168, null)
  retryPolicy: 'object',  // { maxRetries: number, backoffMs: number }
  tier: 'string?',        // "free" | "paid" - indicates tier when created
  // SLA tracking
  sla: 'object',          // { uptimePercent: number, violationCount: number, lastViolation: string?, downtimePeriods: array }
  lastCheckSuccess: 'boolean?', // true if last check succeeded, false if failed
  consecutiveFailures: 'number', // count of consecutive failures (reset on success)
};

/**
 * Payment - Record of a transaction
 */
export const PaymentSchema = {
  id: 'string',
  watcherId: 'string',
  operatorId: 'string',
  customerId: 'string',
  amount: 'number',       // total paid in USD
  operatorShare: 'number', // 80%
  platformShare: 'number', // 20%
  txHash: 'string?',      // blockchain tx if applicable
  network: 'string',
  createdAt: 'string',
};

// Default categories
export const CATEGORIES = [
  'wallet',    // balance, transfers
  'price',     // token prices, DEX rates
  'contract',  // smart contract events
  'social',    // mentions, follows
  'defi',      // yields, liquidations
  'custom',    // catch-all
];

// Revenue split
export const PLATFORM_FEE = 0.20; // 20%
export const OPERATOR_SHARE = 0.80; // 80%

// Free tier constants
export const FREE_TIER = {
  MAX_WATCHERS: 1,           // free tier can create max 1 watcher
  POLLING_INTERVAL_MIN: 30,  // minimum 30-minute polling interval for free tier
  UPGRADE_PROMPT: 'Free tier limited to 1 watcher. Upgrade to paid tier for unlimited watchers and faster polling.',
};

// Polling configuration options
export const POLLING_INTERVALS = [5, 15, 30, 60]; // minutes
export const TTL_OPTIONS = [24, 72, 168, null]; // hours (null = no expiry)
export const MAX_RETRIES_LIMIT = 5;

// Default polling configuration
export const DEFAULT_POLLING = {
  pollingInterval: 5,
  ttl: null,
  retryPolicy: { maxRetries: 3, backoffMs: 1000 }
};

/**
 * Customer - User accounts with tier management
 */
export const CustomerSchema = {
  id: 'string',              // unique customer ID (typically wallet address or agent ID)
  tier: 'string',            // "free" | "paid"
  freeWatchersUsed: 'number', // count of free watchers created (max 1 for free tier)
  createdAt: 'string',       // ISO timestamp
  upgradedAt: 'string?',     // when upgraded to paid (null for free tier)
  stats: {
    totalWatchersCreated: 'number',
    totalSpent: 'number',    // in USD
  },
};

/**
 * Receipt - Idempotent record of a fulfilled paid API call
 * Used for audit trail and preventing duplicate charges
 */
export const ReceiptSchema = {
  id: 'string',              // unique receipt ID
  watcherId: 'string',       // the watcher that was created
  typeId: 'string',          // plan_id - which watcher type was purchased
  amount: 'number',          // amount paid in USD
  chain: 'string',           // blockchain network (e.g., eip155:8453)
  rail: 'string',            // payment rail (e.g., x402)
  timestamp: 'string',       // ISO timestamp of fulfillment
  fulfillmentHash: 'string', // hash of request params for idempotency
  customerId: 'string',      // who paid
  operatorId: 'string',      // who received
  paymentId: 'string',       // linked payment record
};

/**
 * BillingRecord - Individual billing event in a watcher's history
 */
export const BillingRecordSchema = {
  id: 'string',              // unique billing record ID
  billingDate: 'string',     // when this billing was due
  processedAt: 'string',     // when billing was actually processed
  amount: 'number',          // amount charged
  status: 'string',          // 'success', 'failed', 'suspended'
  paymentId: 'string?',      // linked payment record (if successful)
  failureReason: 'string?',  // error message if failed
};

/**
 * SLA Violation - Record of SLA breach with automatic refund/credit logic
 */
export const SLAViolationSchema = {
  id: 'string',              // unique violation ID
  watcherId: 'string',       // affected watcher
  operatorId: 'string',      // responsible operator
  customerId: 'string',      // affected customer
  violationType: 'string',   // 'uptime', 'response_time', 'consecutive_failures'
  threshold: 'number',       // SLA threshold that was breached
  actualValue: 'number',     // actual measured value
  startTime: 'string',       // when violation period started
  endTime: 'string',         // when violation period ended
  durationMinutes: 'number', // total violation duration
  autoRefund: 'boolean',     // whether automatic refund was triggered
  refundAmount: 'number?',   // amount refunded (if applicable)
  refundId: 'string?',       // linked refund record
  createdAt: 'string',       // when violation was detected
  acknowledged: 'boolean',   // whether operator acknowledged the issue
  resolution: 'string?',     // operator's explanation/fix
};

/**
 * Downtime Period - Track periods when a watcher was failing
 */
export const DowntimePeriodSchema = {
  startTime: 'string',       // when downtime started
  endTime: 'string?',        // when downtime ended (null if ongoing)
  durationMinutes: 'number?', // calculated duration
  reason: 'string?',         // failure reason
  resolved: 'boolean',       // whether issue was resolved
};

// SLA Configuration
export const SLA_CONFIG = {
  DEFAULT_UPTIME_THRESHOLD: 99.0,    // 99% uptime SLA
  CONSECUTIVE_FAILURE_LIMIT: 5,       // Max consecutive failures before violation
  VIOLATION_REFUND_PERCENT: 0.5,     // 50% refund on SLA violation
  MEASUREMENT_WINDOW_HOURS: 24,      // Calculate SLA over 24-hour windows
  GRACE_PERIOD_MINUTES: 15,          // Grace period before marking as violation
};
