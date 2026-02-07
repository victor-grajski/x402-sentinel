// Test webhook endpoint for testing webhook URLs before subscribing

import { Router } from 'express';

const router = Router();

/**
 * POST /test-webhook
 * 
 * Free endpoint for testing webhook URLs before creating paid watchers.
 * Sends a test payload to the provided webhook URL and returns response metrics.
 */
router.post('/test-webhook', async (req, res) => {
  try {
    const { webhookUrl } = req.body;
    
    // Validate webhook URL
    if (!webhookUrl || typeof webhookUrl !== 'string') {
      return res.status(400).json({
        success: false,
        error: 'webhookUrl is required and must be a string'
      });
    }
    
    // Basic URL validation
    try {
      const url = new URL(webhookUrl);
      if (!['http:', 'https:'].includes(url.protocol)) {
        return res.status(400).json({
          success: false,
          error: 'webhookUrl must use http:// or https:// protocol'
        });
      }
    } catch (urlError) {
      return res.status(400).json({
        success: false,
        error: 'Invalid webhookUrl format'
      });
    }
    
    // Create test payload
    const testPayload = {
      type: "test",
      message: "This is a test webhook from x402-sentinel",
      timestamp: new Date().toISOString(),
      sample_alert: {
        watcherId: "test-123",
        type: "wallet-balance",
        triggered: true,
        value: "1.5",
        threshold: "1.0"
      }
    };
    
    // Record start time
    const startTime = Date.now();
    
    try {
      // Send test webhook
      const response = await fetch(webhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'x402-sentinel/2.0 (test-webhook)'
        },
        body: JSON.stringify(testPayload),
        // 10 second timeout
        signal: AbortSignal.timeout(10000)
      });
      
      const responseTime = Date.now() - startTime;
      
      // Get response details
      let responseBody = null;
      const contentType = response.headers.get('content-type');
      
      try {
        if (contentType && contentType.includes('application/json')) {
          responseBody = await response.json();
        } else {
          responseBody = await response.text();
        }
      } catch (bodyError) {
        responseBody = null;
      }
      
      res.json({
        success: true,
        webhook: {
          url: webhookUrl,
          responseTime: responseTime,
          status: response.status,
          statusText: response.statusText,
          headers: Object.fromEntries(response.headers.entries()),
          body: responseBody
        },
        testPayload,
        message: `Test webhook sent successfully in ${responseTime}ms`
      });
      
      console.log(`🧪 Test webhook sent to ${webhookUrl} - Status: ${response.status}, Response time: ${responseTime}ms`);
      
    } catch (fetchError) {
      const responseTime = Date.now() - startTime;
      
      let errorMessage = fetchError.message;
      let errorType = 'unknown';
      
      if (fetchError.name === 'TimeoutError') {
        errorType = 'timeout';
        errorMessage = 'Request timed out after 10 seconds';
      } else if (fetchError.name === 'TypeError' && fetchError.message.includes('fetch')) {
        errorType = 'network';
        errorMessage = 'Network error - could not connect to webhook URL';
      } else if (fetchError.code === 'ENOTFOUND') {
        errorType = 'dns';
        errorMessage = 'DNS lookup failed - hostname not found';
      } else if (fetchError.code === 'ECONNREFUSED') {
        errorType = 'connection';
        errorMessage = 'Connection refused - server is not accepting connections';
      }
      
      res.status(400).json({
        success: false,
        error: errorMessage,
        errorType,
        responseTime,
        webhook: {
          url: webhookUrl
        },
        testPayload,
        message: `Test webhook failed: ${errorMessage}`
      });
      
      console.log(`❌ Test webhook failed for ${webhookUrl} - Error: ${errorMessage}, Response time: ${responseTime}ms`);
    }
    
  } catch (error) {
    console.error('Test webhook endpoint error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: error.message
    });
  }
});

export default router;