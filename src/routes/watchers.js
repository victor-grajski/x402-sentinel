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
 * Create multiple watcher instances in batch (x402 protected)
 * Accepts array of watcher configs, returns array of results with smart retry logic
 * 
 * Each watcher has its own idempotency - partial failures are supported
 */
router.post('/watchers/batch', async (req, res) => {
  try {
    const { watchers, customerId: rawCustomerId } = req.body;
    const customerId = rawCustomerId || req.headers['x-customer-id'] || 'anonymous';
    
    // Validate input
    if (!Array.isArray(watchers) || watchers.length === 0) {
      return res.status(400).json({ 
        error: 'Invalid input', 
        message: 'Expected "watchers" array with at least one item' 
      });
    }
    
    if (watchers.length > 50) { // Reasonable limit
      return res.status(400).json({ 
        error: 'Batch size too large', 
        message: 'Maximum 50 watchers per batch request' 
      });
    }
    
    // Process each watcher individually
    const results = [];
    const startTime = Date.now();
    let successCount = 0;
    let errorCount = 0;
    
    for (let i = 0; i < watchers.length; i++) {
      const watcherConfig = watchers[i];
      
      try {
        // Merge batch-level customerId with individual config
        const fullConfig = {
          ...watcherConfig,
          customerId: watcherConfig.customerId || customerId
        };
        
        // Create individual watcher (reuse existing logic)
        const watcherResult = await createSingleWatcher(fullConfig);
        
        results.push({
          index: i,
          success: true,
          watcher: watcherResult.watcher,
          receipt: watcherResult.receipt,
          idempotent: watcherResult.idempotent
        });
        
        successCount++;
        
      } catch (error) {
        results.push({
          index: i,
          success: false,
          error: error.message,
          config: watcherConfig
        });
        
        errorCount++;
        console.error(`Batch watcher ${i} failed:`, error.message);
      }
      
      // Add small delay between requests to avoid overwhelming the system
      if (i < watchers.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    }
    
    const summary = {
      total: watchers.length,
      successful: successCount,
      failed: errorCount,
      durationMs: Date.now() - startTime
    };
    
    console.log(`📦 Batch request completed: ${successCount}/${watchers.length} successful`);
    
    // Return 207 Multi-Status if there are partial failures
    const statusCode = errorCount > 0 && successCount > 0 ? 207 : 
                       errorCount > 0 ? 400 : 201;
    
    res.status(statusCode).json({
      success: errorCount === 0,
      summary,
      results,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('Batch creation error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Helper function to create a single watcher (extracted from the main route)
 */
async function createSingleWatcher(config) {
  const { 
    typeId, 
    config: watcherConfig, 
    webhook, 
    customerId,
    billingCycle = 'one-time',
    pollingInterval = DEFAULT_POLLING.pollingInterval,
    ttl = DEFAULT_POLLING.ttl,
    retryPolicy = DEFAULT_POLLING.retryPolicy
  } = config;
  
  // Validate polling configuration
  if (!POLLING_INTERVALS.includes(pollingInterval)) {
    throw new Error(`Invalid pollingInterval. Allowed: ${POLLING_INTERVALS.join(', ')}`);
  }
  
  if (ttl !== null && !TTL_OPTIONS.slice(0, -1).includes(ttl)) {
    throw new Error(`Invalid ttl. Allowed: ${TTL_OPTIONS.join(', ')}`);
  }
  
  if (typeof retryPolicy !== 'object' || 
      typeof retryPolicy.maxRetries !== 'number' || 
      typeof retryPolicy.backoffMs !== 'number' ||
      retryPolicy.maxRetries > MAX_RETRIES_LIMIT ||
      retryPolicy.maxRetries < 0) {
    throw new Error(`Invalid retryPolicy. Format: { maxRetries: number (0-5), backoffMs: number }`);
  }
  
  // Generate idempotency hash
  const fulfillmentHash = store.generateFulfillmentHash({ 
    typeId, config: watcherConfig, webhook, customerId 
  });
  
  // Check for existing receipt (idempotency)
  const existingReceipt = await store.getReceiptByHash(fulfillmentHash);
  if (existingReceipt) {
    const existingWatcher = await store.getWatcher(existingReceipt.watcherId);
    return {
      success: true,
      idempotent: true,
      watcher: existingWatcher ? {
        id: existingWatcher.id,
        typeId: existingWatcher.typeId,
        status: existingWatcher.status,
      } : { id: existingReceipt.watcherId },
      receipt: existingReceipt
    };
  }
  
  // Customer management and free tier logic
  let customer = await store.getCustomer(customerId);
  if (!customer) {
    customer = await store.createCustomer({ id: customerId, tier: 'free' });
  }
  
  // Get watcher type
  const type = await store.getWatcherType(typeId);
  if (!type) {
    throw new Error('Watcher type not found');
  }
  
  // Check free tier restrictions
  if (customer.tier === 'free' && customer.freeWatchersUsed >= FREE_TIER.MAX_WATCHERS) {
    throw new Error(`Free tier limit exceeded: ${customer.freeWatchersUsed}/${FREE_TIER.MAX_WATCHERS} watchers used`);
  }
  
  // Enforce minimum polling interval for free tier
  let adjustedPollingInterval = pollingInterval;
  if (customer.tier === 'free' && pollingInterval < FREE_TIER.POLLING_INTERVAL_MIN) {
    adjustedPollingInterval = FREE_TIER.POLLING_INTERVAL_MIN;
  }
  
  // Get operator
  const operator = await store.getOperator(type.operatorId);
  if (!operator) {
    throw new Error('Operator not found');
  }
  
  // Validate webhook
  if (!webhook || !webhook.startsWith('http')) {
    throw new Error('Valid webhook URL required');
  }

  // Validate billing cycle
  if (!['one-time', 'weekly', 'monthly'].includes(billingCycle)) {
    throw new Error('billingCycle must be "one-time", "weekly", or "monthly"');
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
      const validation = executor.validate(watcherConfig);
      if (!validation.valid) {
        throw new Error(`Invalid config: ${validation.errors.join(', ')}`);
      }
    }
  }
  
  // Create watcher
  const watcher = await store.createWatcher({
    typeId,
    operatorId: type.operatorId,
    customerId,
    config: watcherConfig,
    webhook,
    billingCycle,
    nextBillingAt,
    pollingInterval: adjustedPollingInterval,
    ttl,
    retryPolicy,
  });
  
  // Record payment
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
  
  // Create receipt
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
  
  return {
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
    }
  };
}

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
      pollingInterval = DEFAULT_POLLING.pollingInterval,
      ttl = DEFAULT_POLLING.ttl,
      retryPolicy = DEFAULT_POLLING.retryPolicy
    } = req.body;
    const customerId = rawCustomerId || req.headers['x-customer-id'] || 'anonymous';
    
    // Use the helper function for consistent logic
    const result = await createSingleWatcher({
      typeId,
      config,
      webhook,
      customerId,
      billingCycle,
      pollingInterval,
      ttl,
      retryPolicy
    });
    
    if (result.idempotent) {
      console.log(`🔄 Idempotent request - returning existing receipt ${result.receipt.id}`);
      return res.status(200).json({
        ...result,
        message: 'Returning existing receipt (idempotent request)',
      });
    }
    
    console.log(`✅ Created watcher ${result.watcher.id} for ${customerId}`);
    console.log(`📄 Receipt ${result.receipt.id} issued (hash: ${result.receipt.fulfillmentHash.slice(0, 8)}...)`);
    
    res.status(201).json({
      ...result,
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
 * Cron endpoint - check all active watchers with SLA tracking
 */
router.post('/cron/check', async (req, res) => {
  const results = { checked: 0, triggered: 0, errors: 0, skipped: 0, slaViolations: 0 };
  const startTime = Date.now();
  
  try {
    // Get all watchers except cancelled ones
    const allWatchers = await store.getWatchers();
    const watchers = allWatchers.filter(w => w.status === 'active');
    
    for (const watcher of watchers) {
      let checkSuccessful = false;
      let checkError = null;
      
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
        
        // Run the check with timeout
        const checkStartTime = Date.now();
        const result = await Promise.race([
          executor.check(watcher.config),
          new Promise((_, reject) => 
            setTimeout(() => reject(new Error('Check timeout')), 30000) // 30s timeout
          )
        ]);
        
        checkSuccessful = true;
        const checkDuration = Date.now() - checkStartTime;
        
        // Update watcher with success
        const updateData = {
          lastChecked: new Date().toISOString(),
          lastCheckResult: result.data,
          lastCheckSuccess: true,
          consecutiveFailures: 0, // Reset on success
        };
        
        // Update SLA tracking
        await updateSLATracking(watcher, true, checkDuration);
        
        await store.updateWatcher(watcher.id, updateData);
        
        if (result.triggered) {
          // Fire webhook with retry logic
          let webhookSuccessful = false;
          for (let attempt = 0; attempt < watcher.retryPolicy.maxRetries + 1; attempt++) {
            try {
              const webhookResponse = await fetch(watcher.webhook, {
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
                timeout: 10000, // 10s timeout
              });
              
              if (webhookResponse.ok) {
                webhookSuccessful = true;
                break;
              } else {
                throw new Error(`HTTP ${webhookResponse.status}`);
              }
            } catch (webhookError) {
              if (attempt < watcher.retryPolicy.maxRetries) {
                await new Promise(resolve => 
                  setTimeout(resolve, watcher.retryPolicy.backoffMs * (attempt + 1))
                );
              } else {
                console.error(`Webhook failed for ${watcher.id} after ${attempt + 1} attempts:`, webhookError.message);
              }
            }
          }
          
          if (webhookSuccessful) {
            // Update trigger stats
            await store.updateWatcher(watcher.id, {
              lastTriggered: new Date().toISOString(),
              triggerCount: watcher.triggerCount + 1,
            });
            await store.incrementOperatorStats(watcher.operatorId, 'totalTriggers');
            await store.incrementWatcherTypeStats(watcher.typeId, 'triggers');
            
            results.triggered++;
            console.log(`🔔 Triggered watcher ${watcher.id}: ${JSON.stringify(result.data).slice(0, 100)}`);
          } else {
            results.errors++;
          }
        }
      } catch (e) {
        checkSuccessful = false;
        checkError = e.message;
        console.error(`Error checking watcher ${watcher.id}:`, e.message);
        results.errors++;
        
        // Update watcher with failure
        const consecutiveFailures = (watcher.consecutiveFailures || 0) + 1;
        await store.updateWatcher(watcher.id, {
          lastChecked: new Date().toISOString(),
          lastCheckSuccess: false,
          consecutiveFailures,
          lastCheckResult: { error: checkError }
        });
        
        // Update SLA tracking with failure
        await updateSLATracking(watcher, false);
        
        // Check for SLA violations
        const violation = await checkSLAViolation(watcher, consecutiveFailures);
        if (violation) {
          results.slaViolations++;
          await handleSLAViolation(violation);
        }
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
 * Update SLA tracking for a watcher
 */
async function updateSLATracking(watcher, success, checkDuration = null) {
  try {
    const now = new Date().toISOString();
    
    // Initialize SLA data if not present
    const sla = watcher.sla || {
      uptimePercent: 100,
      violationCount: 0,
      lastViolation: null,
      downtimePeriods: []
    };
    
    if (success) {
      // End any ongoing downtime period
      const ongoingDowntime = sla.downtimePeriods.find(d => !d.endTime);
      if (ongoingDowntime) {
        const startTime = new Date(ongoingDowntime.startTime);
        const endTime = new Date(now);
        ongoingDowntime.endTime = now;
        ongoingDowntime.durationMinutes = (endTime - startTime) / (1000 * 60);
        ongoingDowntime.resolved = true;
      }
    } else {
      // Start or continue downtime period
      const ongoingDowntime = sla.downtimePeriods.find(d => !d.endTime);
      if (!ongoingDowntime) {
        sla.downtimePeriods.push({
          startTime: now,
          endTime: null,
          durationMinutes: null,
          reason: 'Check failed',
          resolved: false
        });
      }
    }
    
    // Calculate uptime percentage over last 24 hours
    const uptimePercent = calculateUptimePercent(sla.downtimePeriods);
    sla.uptimePercent = uptimePercent;
    
    await store.updateWatcher(watcher.id, { sla });
  } catch (error) {
    console.error(`Error updating SLA tracking for watcher ${watcher.id}:`, error);
  }
}

/**
 * Calculate uptime percentage over the last 24 hours
 */
function calculateUptimePercent(downtimePeriods) {
  const now = new Date();
  const windowStart = new Date(now.getTime() - 24 * 60 * 60 * 1000); // 24 hours ago
  
  let totalDowntimeMs = 0;
  
  for (const period of downtimePeriods) {
    const periodStart = new Date(period.startTime);
    const periodEnd = period.endTime ? new Date(period.endTime) : now;
    
    // Only consider periods that overlap with our measurement window
    if (periodEnd > windowStart && periodStart < now) {
      const relevantStart = periodStart > windowStart ? periodStart : windowStart;
      const relevantEnd = periodEnd < now ? periodEnd : now;
      totalDowntimeMs += relevantEnd - relevantStart;
    }
  }
  
  const windowDurationMs = 24 * 60 * 60 * 1000;
  const uptimePercent = ((windowDurationMs - totalDowntimeMs) / windowDurationMs) * 100;
  return Math.max(0, Math.min(100, uptimePercent));
}

/**
 * Check if a watcher has violated its SLA
 */
async function checkSLAViolation(watcher, consecutiveFailures) {
  const { SLA_CONFIG } = await import('../models.js');
  
  // Check consecutive failures violation
  if (consecutiveFailures >= SLA_CONFIG.CONSECUTIVE_FAILURE_LIMIT) {
    return {
      watcherId: watcher.id,
      operatorId: watcher.operatorId,
      customerId: watcher.customerId,
      violationType: 'consecutive_failures',
      threshold: SLA_CONFIG.CONSECUTIVE_FAILURE_LIMIT,
      actualValue: consecutiveFailures,
      startTime: new Date().toISOString(),
      endTime: new Date().toISOString(),
      durationMinutes: 0,
    };
  }
  
  // Check uptime percentage violation
  const sla = watcher.sla || { uptimePercent: 100 };
  if (sla.uptimePercent < SLA_CONFIG.DEFAULT_UPTIME_THRESHOLD) {
    return {
      watcherId: watcher.id,
      operatorId: watcher.operatorId,
      customerId: watcher.customerId,
      violationType: 'uptime',
      threshold: SLA_CONFIG.DEFAULT_UPTIME_THRESHOLD,
      actualValue: sla.uptimePercent,
      startTime: new Date().toISOString(),
      endTime: new Date().toISOString(),
      durationMinutes: 0,
    };
  }
  
  return null;
}

/**
 * Handle SLA violation with automatic refund logic
 */
async function handleSLAViolation(violationData) {
  try {
    const { SLA_CONFIG } = await import('../models.js');
    
    // Create SLA violation record
    const violation = await store.createSLAViolation({
      ...violationData,
      id: store.generateId(),
      autoRefund: true, // Enable automatic refund
      refundAmount: null,
      refundId: null,
      createdAt: new Date().toISOString(),
      acknowledged: false,
      resolution: null,
    });
    
    // Calculate refund amount (percentage of recent payments)
    const recentPayments = await store.getPayments({ 
      watcherId: violationData.watcherId,
      since: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString() // Last 7 days
    });
    
    const refundAmount = recentPayments
      .reduce((sum, p) => sum + p.amount, 0) * SLA_CONFIG.VIOLATION_REFUND_PERCENT;
    
    if (refundAmount > 0) {
      // Create refund/credit record
      const refund = await store.createPayment({
        watcherId: violationData.watcherId,
        operatorId: violationData.operatorId,
        customerId: violationData.customerId,
        amount: -refundAmount, // Negative amount = credit
        operatorShare: -refundAmount * 0.8,
        platformShare: -refundAmount * 0.2,
        network: process.env.NETWORK || 'eip155:8453',
        type: 'sla_violation_refund',
        linkedViolationId: violation.id,
      });
      
      // Update violation with refund info
      await store.updateSLAViolation(violation.id, {
        refundAmount,
        refundId: refund.id,
      });
      
      console.log(`💰 SLA violation refund: $${refundAmount.toFixed(4)} credited to ${violationData.customerId}`);
    }
    
    console.log(`🚨 SLA violation recorded: ${violationData.violationType} for watcher ${violationData.watcherId}`);
    
    // TODO: Send notification to operator about SLA violation
    // TODO: Send credit notification to customer
    
    return violation;
  } catch (error) {
    console.error('Error handling SLA violation:', error);
    return null;
  }
}

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

/**
 * Get SLA status for a watcher
 */
router.get('/watchers/:id/sla', async (req, res) => {
  try {
    const { id } = req.params;
    
    const watcher = await store.getWatcher(id);
    if (!watcher) {
      return res.status(404).json({ error: 'Watcher not found' });
    }
    
    // Get recent SLA violations
    const violations = await store.getSLAViolations({ 
      watcherId: id,
      since: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString() // Last 7 days
    });
    
    const sla = watcher.sla || {
      uptimePercent: 100,
      violationCount: 0,
      lastViolation: null,
      downtimePeriods: []
    };
    
    // Calculate current uptime streak
    const now = new Date();
    const currentDowntime = sla.downtimePeriods.find(d => !d.endTime);
    const uptimeStreakMinutes = currentDowntime ? 
      (now - new Date(currentDowntime.startTime)) / (1000 * 60) : 0;
    
    res.json({
      watcherId: id,
      sla: {
        uptimePercent: sla.uptimePercent,
        violationCount: violations.length,
        lastViolation: violations[0]?.createdAt || null,
        consecutiveFailures: watcher.consecutiveFailures || 0,
        currentStatus: watcher.lastCheckSuccess ? 'healthy' : 'failing',
        uptimeStreakMinutes: Math.max(0, uptimeStreakMinutes),
        downtimePeriods: sla.downtimePeriods.slice(-10), // Last 10 periods
      },
      violations: violations.map(v => ({
        id: v.id,
        type: v.violationType,
        threshold: v.threshold,
        actualValue: v.actualValue,
        duration: v.durationMinutes,
        autoRefund: v.autoRefund,
        refundAmount: v.refundAmount,
        createdAt: v.createdAt,
        acknowledged: v.acknowledged,
      })),
      thresholds: {
        uptimePercent: 99.0,
        consecutiveFailureLimit: 5,
      },
    });
  } catch (error) {
    console.error('Error fetching SLA status:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Get SLA violations for an operator
 */
router.get('/operators/:id/sla-violations', async (req, res) => {
  try {
    const { id } = req.params;
    const { since, limit = 50 } = req.query;
    
    const operator = await store.getOperator(id);
    if (!operator) {
      return res.status(404).json({ error: 'Operator not found' });
    }
    
    const filters = { operatorId: id };
    if (since) {
      filters.since = since;
    }
    
    const violations = await store.getSLAViolations(filters);
    const limitedViolations = violations.slice(0, parseInt(limit));
    
    // Calculate summary stats
    const summary = {
      total: violations.length,
      byType: {},
      totalRefundAmount: 0,
      unacknowledged: 0,
    };
    
    violations.forEach(v => {
      summary.byType[v.violationType] = (summary.byType[v.violationType] || 0) + 1;
      summary.totalRefundAmount += v.refundAmount || 0;
      if (!v.acknowledged) summary.unacknowledged++;
    });
    
    res.json({
      operatorId: id,
      summary,
      violations: limitedViolations.map(v => ({
        id: v.id,
        watcherId: v.watcherId,
        customerId: v.customerId,
        type: v.violationType,
        threshold: v.threshold,
        actualValue: v.actualValue,
        duration: v.durationMinutes,
        autoRefund: v.autoRefund,
        refundAmount: v.refundAmount,
        createdAt: v.createdAt,
        acknowledged: v.acknowledged,
        resolution: v.resolution,
      })),
      pagination: {
        returned: limitedViolations.length,
        total: violations.length,
        hasMore: violations.length > parseInt(limit),
      },
    });
  } catch (error) {
    console.error('Error fetching SLA violations:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Acknowledge SLA violation (for operators)
 */
router.post('/sla-violations/:id/acknowledge', async (req, res) => {
  try {
    const { id } = req.params;
    const { resolution } = req.body;
    
    const violation = await store.getSLAViolation(id);
    if (!violation) {
      return res.status(404).json({ error: 'SLA violation not found' });
    }
    
    const updatedViolation = await store.updateSLAViolation(id, {
      acknowledged: true,
      resolution: resolution || 'Acknowledged by operator',
      acknowledgedAt: new Date().toISOString(),
    });
    
    console.log(`✅ SLA violation ${id} acknowledged by operator`);
    
    res.json({
      success: true,
      violation: {
        id: updatedViolation.id,
        acknowledged: updatedViolation.acknowledged,
        resolution: updatedViolation.resolution,
        acknowledgedAt: updatedViolation.acknowledgedAt,
      },
      message: 'SLA violation acknowledged',
    });
  } catch (error) {
    console.error('Error acknowledging SLA violation:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Upgrade customer to paid tier (x402 protected)
 */
router.post('/customers/:id/upgrade', async (req, res) => {
  try {
    const customerId = req.params.id;
    
    // Get customer
    const customer = await store.getCustomer(customerId);
    if (!customer) {
      return res.status(404).json({ error: 'Customer not found' });
    }
    
    if (customer.tier === 'paid') {
      return res.status(409).json({ 
        error: 'Customer already has paid tier',
        current: { tier: customer.tier, upgradedAt: customer.upgradedAt }
      });
    }
    
    // In real implementation, this would require x402 payment verification
    // For now, we'll simulate the upgrade
    const upgradedCustomer = await store.updateCustomer(customerId, {
      tier: 'paid',
      upgradedAt: new Date().toISOString()
    });
    
    console.log(`⬆️ Customer ${customerId} upgraded to paid tier`);
    
    res.status(200).json({
      success: true,
      customer: {
        id: upgradedCustomer.id,
        tier: upgradedCustomer.tier,
        upgradedAt: upgradedCustomer.upgradedAt
      },
      benefits: [
        'Unlimited watchers',
        'Faster polling (5-minute minimum)',
        'Priority support'
      ],
      message: 'Successfully upgraded to paid tier'
    });
  } catch (error) {
    console.error('Error upgrading customer:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
