// Seed script: Register initial operator and watcher types

import * as store from '../src/store.js';

const SPARK_WALLET = '0x1468B3fa064b44bA184aB34FD9CD9eB34E43f197';

async function seed() {
  console.log('🌱 Seeding marketplace...\n');
  
  // Check if already seeded
  const existingOperators = await store.getOperators();
  if (existingOperators.length > 0) {
    console.log('Already seeded. Operators:', existingOperators.map(o => o.name).join(', '));
    return;
  }
  
  // Register SparkOC as operator
  const operator = await store.createOperator({
    name: 'SparkOC',
    wallet: SPARK_WALLET,
    description: 'Platform operator. Built-in watchers for wallet balances and token prices.',
    website: 'https://github.com/victor-grajski/x402-intel',
  });
  console.log(`✅ Registered operator: ${operator.name} (${operator.id})`);
  
  // Create wallet balance watcher type
  const walletType = await store.createWatcherType({
    operatorId: operator.id,
    name: 'Wallet Balance Alert',
    category: 'wallet',
    description: 'Get notified when a wallet balance goes above or below a threshold. Supports Base, Ethereum, Optimism, and Arbitrum.',
    price: 0.01,
    executorId: 'wallet-balance',
    configSchema: {
      type: 'object',
      required: ['address', 'threshold', 'direction'],
      properties: {
        address: { type: 'string', description: 'Wallet address (0x...)' },
        threshold: { type: 'number', description: 'Balance threshold in ETH' },
        direction: { type: 'string', enum: ['above', 'below'] },
        chain: { type: 'string', enum: ['base', 'ethereum', 'optimism', 'arbitrum'], default: 'base' },
      },
    },
  });
  console.log(`✅ Created watcher type: ${walletType.name} ($${walletType.price})`);
  
  // Create token price watcher type
  const priceType = await store.createWatcherType({
    operatorId: operator.id,
    name: 'Token Price Alert',
    category: 'price',
    description: 'Get notified when a token price crosses a threshold. Uses CoinGecko for price data.',
    price: 0.01,
    executorId: 'token-price',
    configSchema: {
      type: 'object',
      required: ['token', 'threshold', 'direction'],
      properties: {
        token: { type: 'string', description: 'Token symbol (ETH, BTC, etc.) or CoinGecko ID' },
        threshold: { type: 'number', description: 'Price threshold in USD' },
        direction: { type: 'string', enum: ['above', 'below'] },
      },
    },
  });
  console.log(`✅ Created watcher type: ${priceType.name} ($${priceType.price})`);
  
  console.log('\n🎉 Marketplace seeded successfully!');
  console.log(`   - 1 operator`);
  console.log(`   - 2 watcher types`);
}

seed().catch(console.error);
