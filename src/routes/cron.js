// Cron endpoints for watcher checking with configurable polling

import { Router } from 'express';
import * as store from '../store.js';
import { getExecutor } from '../executors/index.js';

const router = Router();

/**
 * Enhanced cron endpoint - check all active watchers with configurable polling
 */
router.post('/cron/check', async (req, res) => {
  const results = { 
    checked: 0, 
    triggered: 0, 
    errors: 0, 
    skipped: 0,
    expired: 0,
    retried: 0 
  };
  const startTime = Date.now();
  const now = new Date();
  
  try {
    const watchers = await store.getWatchers({ status: 'active' });
    
    for (const watcher of watchers) {
      try {
        // Skip expired watchers
        if (watcher.expiresAt && new Date(watcher.expiresAt) <= now) {
          await store.updateWatcher(watcher.id, { 
            status: 'expired',
            expiresAt: watcher.expiresAt 
          });
          results.expired++;
          continue;
        }
        
        // Check if enough time has passed based on pollingInterval
        const pollingIntervalMs = (watcher.pollingInterval || 5) * 60 * 1000;
        if (watcher.lastChecked) {
          const lastCheckedTime = new Date(watcher.lastChecked);
          const timeSinceLastCheck = now.getTime() - lastCheckedTime.getTime();
          
          if (timeSinceLastCheck < pollingIntervalMs) {
            results.skipped++;
            continue;
          }
        }
        
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
          lastChecked: now.toISOString(),
          lastCheckResult: result.data,
        });
        
        if (result.triggered) {
          // Fire webhook with retry logic
          const webhookSuccess = await deliverWebhookWithRetry(
            watcher, 
            result.data, 
            watcher.retryPolicy || { maxRetries: 3, backoffMs: 1000 }
          );
          
          if (webhookSuccess.success) {
            // Update trigger stats
            await store.updateWatcher(watcher.id, {
              lastTriggered: now.toISOString(),
              triggerCount: watcher.triggerCount + 1,
            });
            await store.incrementOperatorStats(watcher.operatorId, 'totalTriggers');
            await store.incrementWatcherTypeStats(watcher.typeId, 'triggers');
            
            results.triggered++;
            if (webhookSuccess.retryCount > 0) {
              results.retried++;
            }
            console.log(`🔔 Triggered watcher ${watcher.id}: ${JSON.stringify(result.data).slice(0, 100)}`);
          } else {
            console.error(`Webhook ultimately failed for ${watcher.id} after ${webhookSuccess.retryCount} retries`);
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
      timestamp: now.toISOString(),
    });
  } catch (error) {
    console.error('Cron check error:', error);
    res.status(500).json({ error: 'Cron check failed', ...results });
  }
});

/**
 * Deliver webhook with exponential backoff retry logic
 */
async function deliverWebhookWithRetry(watcher, data, retryPolicy) {
  const { maxRetries, backoffMs } = retryPolicy;
  let lastError = null;
  
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(watcher.webhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event: 'watcher_triggered',
          watcher: {
            id: watcher.id,
            typeId: watcher.typeId,
          },
          data: data,
          timestamp: new Date().toISOString(),
          source: 'x402-sentinel',
          delivery: {
            attempt: attempt + 1,
            maxAttempts: maxRetries + 1,
          },
        }),
        signal: AbortSignal.timeout(10000) // 10 second timeout
      });
      
      if (response.ok) {
        return { 
          success: true, 
          retryCount: attempt,
          finalStatus: response.status 
        };
      }
      
      lastError = new Error(`HTTP ${response.status}: ${response.statusText}`);
    } catch (error) {
      lastError = error;
    }
    
    // If not the last attempt, wait with exponential backoff
    if (attempt < maxRetries) {
      const delay = backoffMs * Math.pow(2, attempt);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  
  return { 
    success: false, 
    retryCount: maxRetries,
    error: lastError.message 
  };
}

export default router;