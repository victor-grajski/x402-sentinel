// x402-sentinel: Recurring billing system

import * as store from './store.js';
import { PLATFORM_FEE, OPERATOR_SHARE } from './models.js';

/**
 * Find all watchers that have billing due (nextBillingAt <= now)
 * Only returns active watchers with recurring billing cycles
 */
export async function checkDueBillings() {
  const now = new Date().toISOString();
  const watchers = await store.getWatchers({ status: 'active' });
  
  return watchers.filter(watcher => {
    // Skip one-time billing cycles
    if (watcher.billingCycle === 'one-time') return false;
    
    // Skip if no billing date set
    if (!watcher.nextBillingAt) return false;
    
    // Check if billing is due
    return watcher.nextBillingAt <= now;
  });
}

/**
 * Process billing for a specific watcher
 * For now, simulates charging and marks as suspended on failure
 * In production, this would integrate with actual x402 payment processing
 */
export async function processBilling(watcherId) {
  const watcher = await store.getWatcher(watcherId);
  if (!watcher) {
    throw new Error(`Watcher ${watcherId} not found`);
  }

  // Skip if not a recurring billing cycle
  if (watcher.billingCycle === 'one-time') {
    return {
      success: false,
      reason: 'Watcher has one-time billing cycle',
    };
  }

  // Skip if no billing date set or not due yet
  if (!watcher.nextBillingAt || watcher.nextBillingAt > new Date().toISOString()) {
    return {
      success: false,
      reason: 'Billing not due yet',
    };
  }

  // Get watcher type for pricing
  const watcherType = await store.getWatcherType(watcher.typeId);
  if (!watcherType) {
    throw new Error(`Watcher type ${watcher.typeId} not found`);
  }

  const billingDate = watcher.nextBillingAt;
  const processedAt = new Date().toISOString();
  
  try {
    // TODO: In production, implement actual x402 charging here
    // For now, simulate successful payment
    const paymentSuccessful = Math.random() > 0.1; // 90% success rate for simulation
    
    if (!paymentSuccessful) {
      // Billing failed - create failure record and suspend watcher
      const billingRecord = {
        id: store.generateId(),
        billingDate,
        processedAt,
        amount: watcherType.price,
        status: 'failed',
        paymentId: null,
        failureReason: 'Simulated payment failure',
      };

      // Update watcher: add billing record and suspend
      const updatedHistory = [...(watcher.billingHistory || []), billingRecord];
      await store.updateWatcher(watcherId, {
        status: 'suspended',
        billingHistory: updatedHistory,
      });

      console.log(`💸 Billing failed for watcher ${watcherId} - marked as suspended`);
      
      return {
        success: false,
        reason: 'Payment failed',
        billingRecord,
        watcherStatus: 'suspended',
      };
    }

    // Billing successful - create payment and billing records
    const payment = await store.createPayment({
      watcherId,
      operatorId: watcher.operatorId,
      customerId: watcher.customerId,
      amount: watcherType.price,
      operatorShare: watcherType.price * OPERATOR_SHARE,
      platformShare: watcherType.price * PLATFORM_FEE,
      network: process.env.NETWORK || 'eip155:8453',
    });

    const billingRecord = {
      id: store.generateId(),
      billingDate,
      processedAt,
      amount: watcherType.price,
      status: 'success',
      paymentId: payment.id,
      failureReason: null,
    };

    // Calculate next billing date
    let nextBillingAt = null;
    if (watcher.billingCycle === 'weekly') {
      const nextWeek = new Date(billingDate);
      nextWeek.setDate(nextWeek.getDate() + 7);
      nextBillingAt = nextWeek.toISOString();
    } else if (watcher.billingCycle === 'monthly') {
      const nextMonth = new Date(billingDate);
      nextMonth.setMonth(nextMonth.getMonth() + 1);
      nextBillingAt = nextMonth.toISOString();
    }

    // Update watcher with new billing info
    const updatedHistory = [...(watcher.billingHistory || []), billingRecord];
    await store.updateWatcher(watcherId, {
      nextBillingAt,
      billingHistory: updatedHistory,
    });

    // Update operator stats
    await store.incrementOperatorStats(watcher.operatorId, 'totalEarned', payment.operatorShare);

    console.log(`✅ Billing successful for watcher ${watcherId} - next billing: ${nextBillingAt}`);

    return {
      success: true,
      billingRecord,
      payment,
      nextBillingAt,
      watcherStatus: 'active',
    };

  } catch (error) {
    // System error during billing
    const billingRecord = {
      id: store.generateId(),
      billingDate,
      processedAt,
      amount: watcherType.price,
      status: 'failed',
      paymentId: null,
      failureReason: `System error: ${error.message}`,
    };

    const updatedHistory = [...(watcher.billingHistory || []), billingRecord];
    await store.updateWatcher(watcherId, {
      status: 'suspended',
      billingHistory: updatedHistory,
    });

    console.error(`❌ Billing system error for watcher ${watcherId}:`, error.message);

    return {
      success: false,
      reason: 'System error',
      billingRecord,
      watcherStatus: 'suspended',
      error: error.message,
    };
  }
}

/**
 * Process all due billings
 * Returns summary of billing results
 */
export async function processAllDueBillings() {
  const dueBillings = await checkDueBillings();
  const results = {
    totalDue: dueBillings.length,
    successful: 0,
    failed: 0,
    suspended: 0,
    details: [],
  };

  for (const watcher of dueBillings) {
    try {
      const result = await processBilling(watcher.id);
      results.details.push({
        watcherId: watcher.id,
        result,
      });

      if (result.success) {
        results.successful++;
      } else {
        results.failed++;
        if (result.watcherStatus === 'suspended') {
          results.suspended++;
        }
      }
    } catch (error) {
      console.error(`Error processing billing for ${watcher.id}:`, error);
      results.failed++;
      results.details.push({
        watcherId: watcher.id,
        result: {
          success: false,
          reason: 'Processing error',
          error: error.message,
        },
      });
    }
  }

  return results;
}