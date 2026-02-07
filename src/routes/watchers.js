// Watcher creation (x402 protected) and cron endpoints

/**
 * CANCELLATION AND REFUND RULES:
 * - Cancellation stops the next billing cycle for recurring watchers
 * - No prorated refunds for any usage
 * - 1-hour grace period: If cancelled within 1 hour of creation AND no webhooks have been fired, 
 *   the watcher is eligible for a full refund
 * - Once webhooks have been triggered, no refund is applicable regardless of timing
 * - Cancelled watchers are excluded from future cron checks
 */

import { Router } from 'express';
import * as store from '../store.js';
import { getExecutor } from '../executors/index.js';
import { 
  PLATFORM_FEE, 
  OPERATOR_SHARE, 
  POLLING_INTERVALS, 
  TTL_OPTIONS, 
  MAX_RETRIES_LIMIT, 
  DEFAULT_POLLING,
  FREE_TIER 
} from '../models.js';
import { checkDueBillings, processBilling, processAllDueBillings } from '../billing.js';

const router = Router();

// Platform wallet (receives 20% fee)
const PLATFORM_WALLET = process.env.PLATFORM_WALLET || process.env.WALLET_ADDRESS;

/**
 * Create a watcher instance (x402 protected)
 * Payment goes to: 80% operator, 20% platform
 * 
 * IDEMPOTENCY: Same request params return the same receipt without duplicate charges.
 * The fulfillmentHash is computed from (typeId, config, webhook, customerId).
 */
router.post('/watchers', async (req, res) => {
  try {
    const { 
      typeId, 
      config, 
      webhook, 
      customerId: rawCustomerId, 
      billingCycle = 'one-time',
      // Polling configuration options
      pollingInterval = DEFAULT_POLLING.pollingInterval,
      ttl = DEFAULT_POLLING.ttl,
      retryPolicy = DEFAULT_POLLING.retryPolicy
    } = req.body;
    const customerId = rawCustomerId || req.headers['x-customer-id'] || 'anonymous';
    
    // Validate polling configuration
    if (!POLLING_INTERVALS.includes(pollingInterval)) {
      return res.status(400).json({ 
        error: 'Invalid pollingInterval',
        allowed: POLLING_INTERVALS 
      });
    }
    
    if (ttl !== null && !TTL_OPTIONS.slice(0, -1).includes(ttl)) { // exclude null from validation
      return res.status(400).json({ 
        error: 'Invalid ttl',
        allowed: TTL_OPTIONS 
      });
    }
    
    if (typeof retryPolicy !== 'object' || 
        typeof retryPolicy.maxRetries !== 'number' || 
        typeof retryPolicy.backoffMs !== 'number' ||
        retryPolicy.maxRetries > MAX_RETRIES_LIMIT ||
        retryPolicy.maxRetries < 0) {
      return res.status(400).json({ 
        error: 'Invalid retryPolicy',
        format: '{ maxRetries: number (0-5), backoffMs: number }',
        maxRetries: MAX_RETRIES_LIMIT
      });
    }
    
    // Generate idempotency hash from request params
    const fulfillmentHash = store.generateFulfillmentHash({ 
      typeId, config, webhook, customerId 
    });
    
    // Check for existing receipt (idempotency)
    const existingReceipt = await store.getReceiptByHash(fulfillmentHash);
    if (existingReceipt) {
      const existingWatcher = await store.getWatcher(existingReceipt.watcherId);
      console.log(`🔄 Idempotent request - returning existing receipt ${existingReceipt.id}`);
      
      return res.status(200).json({
        success: true,
        idempotent: true,
        watcher: existingWatcher ? {
          id: existingWatcher.id,
          typeId: existingWatcher.typeId,
          status: existingWatcher.status,
        } : { id: existingReceipt.watcherId },
        receipt: existingReceipt,
        message: 'Returning existing receipt (idempotent request)',
      });
    }
    
    // Customer management and free tier logic
    let customer = await store.getCustomer(customerId);
    if (!customer) {
      // Create new customer with free tier
      customer = await store.createCustomer({ id: customerId, tier: 'free' });
      console.log(`🆕 Created new customer ${customerId} with free tier`);
    }
    
    // Get watcher type
    const type = await store.getWatcherType(typeId);
    if (!type) {
      return res.status(404).json({ error: 'Watcher type not found' });
    }
    
    // Check free tier restrictions
    if (customer.tier === 'free') {
      // Check watcher limit
      if (customer.freeWatchersUsed >= FREE_TIER.MAX_WATCHERS) {
        return res.status(402).json({
          error: 'Free tier limit exceeded',
          message: FREE_TIER.UPGRADE_PROMPT,
          current: { 
            watchersUsed: customer.freeWatchersUsed, 
            maxWatchers: FREE_TIER.MAX_WATCHERS 
          },
          upgrade: {
            endpoint: `/customers/${customerId}/upgrade`,
            benefits: ['Unlimited watchers', 'Faster polling (5-minute minimum)', 'Priority support']
          }
        });
      }
      
      // Enforce minimum polling interval for free tier
      if (pollingInterval < FREE_TIER.POLLING_INTERVAL_MIN) {
        console.log(`⚠️ Free tier: forcing 30-min polling (requested: ${pollingInterval})`);
        pollingInterval = FREE_TIER.POLLING_INTERVAL_MIN;
      }
    }
    
    // Get operator
    const operator = await store.getOperator(type.operatorId);
    if (!operator) {
      return res.status(500).json({ error: 'Operator not found' });
    }
    
    // Validate webhook
    if (!webhook || !webhook.startsWith('http')) {
      return res.status(400).json({ error: 'Valid webhook URL required' });
    }

    // Validate billing cycle
    if (!['one-time', 'weekly', 'monthly'].includes(billingCycle)) {
      return res.status(400).json({ error: 'billingCycle must be "one-time", "weekly", or "monthly"' });
    }

    // Calculate next billing date for recurring cycles
    let nextBillingAt = null;
    if (billingCycle !== 'one-time') {
      const now = new Date();
      if (billingCycle === 'weekly') {
        nextBillingAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();
      } else if (billingCycle === 'monthly') {
        const nextMonth = new Date(now);
        nextMonth.setMonth(now.getMonth() + 1);
        nextBillingAt = nextMonth.toISOString();
      }
    }
    
    // Validate config against executor if available
    if (type.executorId) {
      const executor = getExecutor(type.executorId);
      if (executor?.validate) {
        const validation = executor.validate(config);
        if (!validation.valid) {
          return res.status(400).json({ 
            error: 'Invalid config',
            details: validation.errors,
          });
        }
      }
    }
    
    // Create watcher
    const watcher = await store.createWatcher({
      typeId,
      operatorId: type.operatorId,
      customerId,
      config,
      webhook,
      billingCycle,
      nextBillingAt,
      pollingInterval,
      ttl,
      retryPolicy,
    });
    
    // Record payment (in real implementation, this comes from x402 middleware)
    const network = process.env.NETWORK || 'eip155:8453';
    const payment = await store.createPayment({
      watcherId: watcher.id,
      operatorId: type.operatorId,
      customerId: watcher.customerId,
      amount: type.price,
      operatorShare: type.price * OPERATOR_SHARE,
      platformShare: type.price * PLATFORM_FEE,
      network,
    });
    
    // Create receipt for audit trail and idempotency
    const receipt = await store.createReceipt({
      watcherId: watcher.id,
      typeId: type.id,
      amount: type.price,
      chain: network,
      rail: 'x402',
      fulfillmentHash,
      customerId: watcher.customerId,
      operatorId: type.operatorId,
      paymentId: payment.id,
    });
    
    // Update stats
    await store.incrementOperatorStats(type.operatorId, 'watchersCreated');
    await store.incrementWatcherTypeStats(typeId, 'instances');
    
    console.log(`✅ Created watcher ${watcher.id} (type: ${type.name}) for ${watcher.customerId}`);
    console.log(`📄 Receipt ${receipt.id} issued (hash: ${fulfillmentHash.slice(0, 8)}...)`);
    
    res.status(201).json({
      success: true,
      idempotent: false,
      watcher: {
        id: watcher.id,
        typeId: watcher.typeId,
        status: watcher.status,
      },
      receipt,
      payment: {
        amount: payment.amount,
        operatorShare: payment.operatorShare,
        platformShare: payment.platformShare,
      },
      message: `Watcher created. Monitoring will begin on next cron cycle.`,
    });
  } catch (error) {
    console.error('Error creating watcher:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Cancel a watcher (DELETE /watchers/:id)
 * Sets watcher status to "cancelled", records timestamp, stops future billing
 */
router.delete('/watchers/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body; // optional cancellation reason
    
    // Get the watcher
    const watcher = await store.getWatcher(id);
    if (!watcher) {
      return res.status(404).json({ error: 'Watcher not found' });
    }
    
    // Check if already cancelled
    if (watcher.status === 'cancelled') {
      return res.status(400).json({ error: 'Watcher is already cancelled' });
    }
    
    // Update watcher status
    const updatedWatcher = await store.updateWatcher(id, {
      status: 'cancelled',
      cancelledAt: new Date().toISOString(),
      cancellationReason: reason || null,
      // Clear next billing to stop recurring charges
      nextBillingAt: null,
    });
    
    console.log(`🚫 Cancelled watcher ${id}${reason ? ` (reason: ${reason})` : ''}`);
    
    res.json({
      success: true,
      watcher: {
        id: updatedWatcher.id,
        status: updatedWatcher.status,
        cancelledAt: updatedWatcher.cancelledAt,
        cancellationReason: updatedWatcher.cancellationReason,
      },
      message: 'Watcher cancelled successfully. Future billing stopped.',
    });
  } catch (error) {
    console.error('Error cancelling watcher:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Check refund eligibility (GET /watchers/:id/refund-status)
 * Returns whether a refund is applicable based on timing and usage
 */
router.get('/watchers/:id/refund-status', async (req, res) => {
  try {
    const { id } = req.params;
    
    // Get the watcher
    const watcher = await store.getWatcher(id);
    if (!watcher) {
      return res.status(404).json({ error: 'Watcher not found' });
    }
    
    // Calculate time since creation
    const createdAt = new Date(watcher.createdAt);
    const now = new Date();
    const hoursSinceCreation = (now - createdAt) / (1000 * 60 * 60);
    
    // Check if any webhooks have been fired
    const hasTriggered = watcher.triggerCount > 0;
    
    // Refund rules:
    // 1. Must be cancelled within 1 hour of creation
    // 2. No webhooks must have been fired
    const isWithinGracePeriod = hoursSinceCreation <= 1;
    const isUnused = !hasTriggered;
    const isEligible = isWithinGracePeriod && isUnused && watcher.status === 'cancelled';
    
    let reason = 'No refund applicable';
    if (watcher.status !== 'cancelled') {
      reason = 'Watcher is not cancelled';
    } else if (!isWithinGracePeriod) {
      reason = 'Cancelled after 1-hour grace period';
    } else if (hasTriggered) {
      reason = 'Webhooks were triggered (usage detected)';
    } else if (isEligible) {
      reason = 'Eligible: cancelled within 1 hour with no usage';
    }
    
    res.json({
      watcherId: watcher.id,
      status: watcher.status,
      refundEligible: isEligible,
      reason,
      details: {
        createdAt: watcher.createdAt,
        cancelledAt: watcher.cancelledAt,
        hoursSinceCreation: Math.round(hoursSinceCreation * 100) / 100,
        triggerCount: watcher.triggerCount,
        isWithinGracePeriod,
        isUnused,
      },
    });
  } catch (error) {
    console.error('Error checking refund status:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Cron endpoint - check all active watchers
 */
router.post('/cron/check', async (req, res) => {
  const results = { checked: 0, triggered: 0, errors: 0, skipped: 0 };
  const startTime = Date.now();
  
  try {
    // Get all watchers except cancelled ones
    const allWatchers = await store.getWatchers();
    const watchers = allWatchers.filter(w => w.status === 'active');
    
    for (const watcher of watchers) {
      try {
        // Get type to find executor
        const type = await store.getWatcherType(watcher.typeId);
        if (!type || !type.executorId) {
          results.skipped++;
          continue;
        }
        
        const executor = getExecutor(type.executorId);
        if (!executor) {
          results.skipped++;
          continue;
        }
        
        results.checked++;
        
        // Run the check
        const result = await executor.check(watcher.config);
        
        // Update watcher
        await store.updateWatcher(watcher.id, {
          lastChecked: new Date().toISOString(),
          lastCheckResult: result.data,
        });
        
        if (result.triggered) {
          // Fire webhook
          try {
            await fetch(watcher.webhook, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                event: 'watcher_triggered',
                watcher: {
                  id: watcher.id,
                  typeId: watcher.typeId,
                },
                data: result.data,
                timestamp: new Date().toISOString(),
                source: 'x402-sentinel',
              }),
            });
            
            // Update trigger stats
            await store.updateWatcher(watcher.id, {
              lastTriggered: new Date().toISOString(),
              triggerCount: watcher.triggerCount + 1,
            });
            await store.incrementOperatorStats(watcher.operatorId, 'totalTriggers');
            await store.incrementWatcherTypeStats(watcher.typeId, 'triggers');
            
            results.triggered++;
            console.log(`🔔 Triggered watcher ${watcher.id}: ${JSON.stringify(result.data).slice(0, 100)}`);
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
    
    res.json({
      success: true,
      ...results,
      durationMs: Date.now() - startTime,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('Cron check error:', error);
    res.status(500).json({ error: 'Cron check failed', ...results });
  }
});

/**
 * Get billing status and history for a watcher
 */
router.get('/watchers/:id/billing', async (req, res) => {
  try {
    const { id } = req.params;
    
    const watcher = await store.getWatcher(id);
    if (!watcher) {
      return res.status(404).json({ error: 'Watcher not found' });
    }

    // Get watcher type for pricing info
    const watcherType = await store.getWatcherType(watcher.typeId);
    if (!watcherType) {
      return res.status(500).json({ error: 'Watcher type not found' });
    }

    // Calculate billing status
    const now = new Date().toISOString();
    let billingStatus = 'current';
    let daysUntilNextBilling = null;

    if (watcher.billingCycle === 'one-time') {
      billingStatus = 'one-time';
    } else if (watcher.status === 'suspended') {
      billingStatus = 'suspended';
    } else if (watcher.nextBillingAt) {
      const nextBilling = new Date(watcher.nextBillingAt);
      const nowDate = new Date(now);
      
      if (nextBilling <= nowDate) {
        billingStatus = 'overdue';
      } else {
        billingStatus = 'active';
        daysUntilNextBilling = Math.ceil((nextBilling - nowDate) / (1000 * 60 * 60 * 24));
      }
    }

    // Get payment history for this watcher
    const payments = await store.getPayments({ watcherId: id });

    res.json({
      success: true,
      watcher: {
        id: watcher.id,
        status: watcher.status,
        billingCycle: watcher.billingCycle,
        nextBillingAt: watcher.nextBillingAt,
        createdAt: watcher.createdAt,
      },
      billing: {
        status: billingStatus,
        price: watcherType.price,
        daysUntilNextBilling,
        totalBillings: watcher.billingHistory?.length || 0,
        totalPaid: payments.reduce((sum, p) => sum + p.amount, 0),
      },
      history: {
        billingRecords: watcher.billingHistory || [],
        payments: payments.map(p => ({
          id: p.id,
          amount: p.amount,
          createdAt: p.createdAt,
          network: p.network,
          txHash: p.txHash,
        })),
      },
    });
  } catch (error) {
    console.error('Error fetching billing info:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Cron endpoint - process due billings
 */
router.post('/cron/billing', async (req, res) => {
  const startTime = Date.now();
  
  try {
    console.log('🔄 Starting billing cycle...');
    
    // Check what billings are due
    const dueBillings = await checkDueBillings();
    console.log(`📋 Found ${dueBillings.length} watchers with due billings`);
    
    if (dueBillings.length === 0) {
      return res.json({
        success: true,
        summary: {
          totalDue: 0,
          successful: 0,
          failed: 0,
          suspended: 0,
        },
        message: 'No billing due',
        durationMs: Date.now() - startTime,
        timestamp: new Date().toISOString(),
      });
    }
    
    // Process all due billings
    const results = await processAllDueBillings();
    
    console.log(`💰 Billing cycle complete: ${results.successful} successful, ${results.failed} failed, ${results.suspended} suspended`);
    
    res.json({
      success: true,
      summary: {
        totalDue: results.totalDue,
        successful: results.successful,
        failed: results.failed,
        suspended: results.suspended,
      },
      details: results.details,
      durationMs: Date.now() - startTime,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('Billing cron error:', error);
    res.status(500).json({ 
      error: 'Billing cron failed',
      message: error.message,
      durationMs: Date.now() - startTime,
    });
  }
});

export default router;
