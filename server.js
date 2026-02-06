import express from 'express';
import { paymentMiddleware, x402ResourceServer } from '@x402/express';
import { ExactEvmScheme } from '@x402/evm/exact/server';
import { HTTPFacilitatorClient } from '@x402/core/server';

const app = express();
app.use(express.json());

// Our Base wallet address
const payTo = '0x1468B3fa064b44bA184aB34FD9CD9eB34E43f197';

// Base Sepolia testnet for development (CAIP-2 format)
// Switch to eip155:8453 for mainnet with CDP facilitator
const BASE_NETWORK = 'eip155:84532'; // Base Sepolia testnet

// Moltbook API for fetching intel
const MOLTBOOK_API = 'https://www.moltbook.com/api/v1';

// Create facilitator client (using Coinbase's hosted facilitator)
// For testnet: https://www.x402.org/facilitator
// For mainnet: https://x402.coinbase.com/facilitator (requires CDP API key)
const facilitatorClient = new HTTPFacilitatorClient({
  url: 'https://www.x402.org/facilitator' // Start with testnet facilitator
});

// Create resource server and register EVM scheme
const server = new x402ResourceServer(facilitatorClient)
  .register(BASE_NETWORK, new ExactEvmScheme());

// Route configurations with x402 payment requirements
const routes = {
  'GET /intel/trending': {
    accepts: [
      {
        scheme: 'exact',
        price: '$0.001', // 0.1 cents per request
        network: BASE_NETWORK,
        payTo,
      },
    ],
    description: 'Trending posts and agents on Moltbook',
    mimeType: 'application/json',
  },
  'GET /intel/agents': {
    accepts: [
      {
        scheme: 'exact',
        price: '$0.001',
        network: BASE_NETWORK,
        payTo,
      },
    ],
    description: 'Active agents and what they\'re building',
    mimeType: 'application/json',
  },
  'GET /intel/summary': {
    accepts: [
      {
        scheme: 'exact',
        price: '$0.005', // Curated summary costs more
        network: BASE_NETWORK,
        payTo,
      },
    ],
    description: 'Curated daily summary of agent economy activity',
    mimeType: 'application/json',
  },
};

// Apply x402 payment middleware
app.use(paymentMiddleware(routes, server));

// Free endpoint - health check and service discovery
app.get('/', (req, res) => {
  res.json({ 
    service: 'SparkOC Intel API',
    version: '1.0.0',
    description: 'Curated agent economy intelligence via x402 micropayments',
    curator: 'SparkOC',
    wallet: payTo,
    network: 'Base (eip155:8453)',
    endpoints: {
      '/intel/trending': {
        price: '$0.001',
        description: 'Trending posts and agents'
      },
      '/intel/agents': {
        price: '$0.001', 
        description: 'Active agents directory'
      },
      '/intel/summary': {
        price: '$0.005',
        description: 'Curated daily summary with insights'
      }
    },
    protocol: 'x402',
    docs: 'https://x402.org'
  });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Fetch trending from Moltbook
async function fetchTrending() {
  try {
    const [postsRes, agentsRes] = await Promise.all([
      fetch(`${MOLTBOOK_API}/posts?sort=hot&limit=10`),
      fetch(`${MOLTBOOK_API}/agents?sort=karma&limit=10`)
    ]);
    
    const posts = await postsRes.json();
    const agents = await agentsRes.json();
    
    return {
      timestamp: new Date().toISOString(),
      trending_posts: posts.posts?.map(p => ({
        id: p.id,
        title: p.title,
        author: p.author?.name,
        upvotes: p.upvotes,
        comments: p.comment_count,
        submolt: p.submolt?.name
      })) || [],
      top_agents: agents.agents?.map(a => ({
        name: a.name,
        karma: a.karma,
        description: a.description?.substring(0, 100)
      })) || []
    };
  } catch (error) {
    console.error('Error fetching trending:', error);
    return { error: 'Failed to fetch trending data', timestamp: new Date().toISOString() };
  }
}

// Fetch active agents
async function fetchActiveAgents() {
  try {
    const res = await fetch(`${MOLTBOOK_API}/agents?sort=active&limit=20`);
    const data = await res.json();
    
    return {
      timestamp: new Date().toISOString(),
      active_agents: data.agents?.map(a => ({
        name: a.name,
        karma: a.karma,
        description: a.description,
        last_active: a.last_active,
        follower_count: a.follower_count
      })) || []
    };
  } catch (error) {
    console.error('Error fetching agents:', error);
    return { error: 'Failed to fetch agents', timestamp: new Date().toISOString() };
  }
}

// Generate curated summary (this is where my edge is)
async function generateSummary() {
  try {
    const [trending, agents] = await Promise.all([
      fetchTrending(),
      fetchActiveAgents()
    ]);
    
    return {
      timestamp: new Date().toISOString(),
      summary: {
        hot_topics: extractTopics(trending.trending_posts),
        rising_agents: agents.active_agents?.slice(0, 5),
        trending_submolts: extractSubmolts(trending.trending_posts),
        signal: generateSignal(trending, agents)
      },
      raw: {
        trending_posts: trending.trending_posts?.slice(0, 5),
        top_agents: trending.top_agents?.slice(0, 5)
      },
      meta: {
        source: 'moltbook.com',
        curator: 'SparkOC',
        freshness: 'real-time'
      }
    };
  } catch (error) {
    console.error('Error generating summary:', error);
    return { error: 'Failed to generate summary', timestamp: new Date().toISOString() };
  }
}

// Helper functions for curation
function extractTopics(posts) {
  if (!posts) return [];
  const topics = {};
  posts.forEach(p => {
    if (p.submolt) {
      topics[p.submolt] = (topics[p.submolt] || 0) + 1;
    }
  });
  return Object.entries(topics)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([topic, count]) => ({ topic, activity: count }));
}

function extractSubmolts(posts) {
  if (!posts) return [];
  const submolts = [...new Set(posts.map(p => p.submolt).filter(Boolean))];
  return submolts.slice(0, 5);
}

function generateSignal(trending, agents) {
  const postCount = trending.trending_posts?.length || 0;
  const avgUpvotes = trending.trending_posts?.reduce((sum, p) => sum + (p.upvotes || 0), 0) / (postCount || 1);
  
  return {
    activity_level: postCount > 8 ? 'high' : postCount > 4 ? 'medium' : 'low',
    avg_engagement: Math.round(avgUpvotes * 10) / 10,
    recommendation: avgUpvotes > 5 ? 'Active discussion period - good time to engage' : 'Quieter period - good for deep work'
  };
}

// Paid endpoints (protected by x402 middleware)
app.get('/intel/trending', async (req, res) => {
  const data = await fetchTrending();
  res.json(data);
});

app.get('/intel/agents', async (req, res) => {
  const data = await fetchActiveAgents();
  res.json(data);
});

app.get('/intel/summary', async (req, res) => {
  const data = await generateSummary();
  res.json(data);
});

const PORT = process.env.PORT || 3402;
app.listen(PORT, () => {
  console.log(`\n✨ SparkOC Intel API running on port ${PORT}`);
  console.log(`📡 Service info: http://localhost:${PORT}/`);
  console.log(`💳 Accepting x402 payments to: ${payTo}`);
  console.log(`🔗 Network: Base mainnet (${BASE_NETWORK})\n`);
});
