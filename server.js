/**
 * Grant Ships - Modular Grant Rounds
 * 
 * Create grant "ships" with budget, criteria, and duration.
 * Accept applications, distribute based on ship rules.
 */

const express = require('express');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const { ethers } = require('ethers');

const app = express();
app.use(cors());
app.use(express.json());

// Config
const BASE_RPC = process.env.BASE_RPC || 'https://mainnet.base.org';
const TREASURY_ADDRESS = process.env.TREASURY_ADDRESS || '0xccD7200024A8B5708d381168ec2dB0DC587af83F';
const TREASURY_PRIVATE_KEY = process.env.TREASURY_PRIVATE_KEY?.trim();
const FEE_PERCENT = 5n;

let provider = null;
let wallet = null;

function getProvider() {
  if (!provider) provider = new ethers.JsonRpcProvider(BASE_RPC);
  return provider;
}

function getWallet() {
  if (!wallet && TREASURY_PRIVATE_KEY) {
    wallet = new ethers.Wallet(TREASURY_PRIVATE_KEY, getProvider());
  }
  return wallet;
}

function formatETH(wei) {
  return parseFloat(ethers.formatEther(wei.toString())).toFixed(6) + ' ETH';
}

// Data Storage
const ships = new Map();          // Grant ships/rounds
const applications = new Map();   // Grant applications
const allocations = new Map();    // Approved allocations
const distributions = new Map();  // Payout history

// ============================================================================
// SHIPS (Grant Rounds)
// ============================================================================


// ============================================================================
// WHITELIST MIDDLEWARE
// ============================================================================

let _whitelistCache = null;
let _whitelistCacheTime = 0;
const WHITELIST_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

async function fetchWhitelist() {
  const now = Date.now();
  if (_whitelistCache && (now - _whitelistCacheTime) < WHITELIST_CACHE_TTL) {
    return _whitelistCache;
  }
  try {
    const res = await fetch('https://www.owockibot.xyz/api/whitelist');
    const data = await res.json();
    _whitelistCache = new Set(data.map(e => (e.address || e).toLowerCase()));
    _whitelistCacheTime = now;
    return _whitelistCache;
  } catch (err) {
    console.error('Whitelist fetch failed:', err.message);
    if (_whitelistCache) return _whitelistCache;
    return new Set();
  }
}

function requireWhitelist(addressField = 'address') {
  return async (req, res, next) => {
    const addr = req.body?.[addressField] || req.body?.creator || req.body?.participant || req.body?.sender || req.body?.from || req.body?.address;
    if (!addr) {
      return res.status(400).json({ error: 'Address required' });
    }
    const whitelist = await fetchWhitelist();
    if (!whitelist.has(addr.toLowerCase())) {
      return res.status(403).json({ error: 'Invite-only. Tag @owockibot on X to request access.' });
    }
    next();
  };
}


app.post('/ships', requireWhitelist(), (req, res) => {
  const { name, description, criteria, durationDays, captain } = req.body;

  if (!name || !captain) {
    return res.status(400).json({ 
      error: 'name and captain required',
      example: { 
        name: 'DeFi Builders Round', 
        captain: '0x...', 
        criteria: ['open source', 'active development'], 
        durationDays: 30 
      }
    });
  }

  if (!ethers.isAddress(captain)) {
    return res.status(400).json({ error: 'Invalid captain address' });
  }

  const now = Date.now();
  const ship = {
    id: uuidv4(),
    name,
    description: description || '',
    captain: captain.toLowerCase(),
    criteria: criteria || [],
    budget: '0',
    allocated: '0',
    distributed: '0',
    startDate: now,
    endDate: now + (durationDays || 30) * 24 * 60 * 60 * 1000,
    status: 'open', // open, closed, distributing, completed
    createdAt: now
  };

  ships.set(ship.id, ship);
  console.log(`[SHIP] ${name} created by ${captain.slice(0, 10)}...`);
  
  res.status(201).json(ship);
});

app.get('/ships', (req, res) => {
  const { status } = req.query;
  let results = Array.from(ships.values());
  
  // Update statuses based on time
  const now = Date.now();
  results = results.map(s => {
    if (s.status === 'open' && now > s.endDate) {
      s.status = 'closed';
      ships.set(s.id, s);
    }
    return s;
  });
  
  if (status) results = results.filter(s => s.status === status);
  results.sort((a, b) => b.createdAt - a.createdAt);
  
  res.json(results);
});

app.get('/ships/:id', (req, res) => {
  const ship = ships.get(req.params.id);
  if (!ship) return res.status(404).json({ error: 'Ship not found' });
  
  const shipApps = Array.from(applications.values())
    .filter(a => a.shipId === ship.id)
    .sort((a, b) => b.createdAt - a.createdAt);
  
  const shipAllocations = Array.from(allocations.values())
    .filter(a => a.shipId === ship.id);
  
  res.json({ ...ship, applications: shipApps, allocations: shipAllocations });
});

// Fund a ship
app.post('/ships/:id/fund', requireWhitelist(), async (req, res) => {
  const { txHash } = req.body;
  const ship = ships.get(req.params.id);
  
  if (!ship) return res.status(404).json({ error: 'Ship not found' });
  if (!txHash) return res.status(400).json({ error: 'txHash required' });

  try {
    const tx = await getProvider().getTransaction(txHash);
    const receipt = await getProvider().getTransactionReceipt(txHash);
    
    if (!tx || !receipt || receipt.status !== 1) {
      return res.status(400).json({ error: 'Transaction not found or failed' });
    }
    
    if (tx.to?.toLowerCase() !== TREASURY_ADDRESS.toLowerCase()) {
      return res.status(400).json({ error: 'Not sent to treasury' });
    }

    ship.budget = (BigInt(ship.budget) + tx.value).toString();
    ships.set(ship.id, ship);
    
    console.log(`[SHIP FUNDED] ${ship.name}: +${formatETH(tx.value)} (total: ${formatETH(ship.budget)})`);
    res.json({ ship, funded: formatETH(tx.value) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// APPLICATIONS
// ============================================================================

app.post('/ships/:id/apply', requireWhitelist(), (req, res) => {
  const { applicant, projectName, description, links } = req.body;
  // Support both camelCase and snake_case for requestAmount
  const requestAmount = req.body.requestAmount || req.body.requested_amount || req.body.requestedAmount;
  const ship = ships.get(req.params.id);
  
  if (!ship) return res.status(404).json({ error: 'Ship not found' });
  if (ship.status !== 'open') {
    return res.status(400).json({ error: 'Ship is not accepting applications' });
  }

  if (!applicant || !projectName) {
    return res.status(400).json({ 
      error: 'applicant and projectName required',
      example: { applicant: '0x...', projectName: 'My Project', requestAmount: '0.5', links: ['github.com/...'] }
    });
  }

  if (!ethers.isAddress(applicant)) {
    return res.status(400).json({ error: 'Invalid applicant address' });
  }

  let requestWei = 0n;
  try {
    if (requestAmount) {
      requestWei = ethers.parseEther(requestAmount.toString());
    }
  } catch (e) {
    return res.status(400).json({ error: 'Invalid requestAmount' });
  }

  const application = {
    id: uuidv4(),
    shipId: ship.id,
    shipName: ship.name,
    applicant: applicant.toLowerCase(),
    projectName,
    description: description || '',
    requestAmount: requestWei.toString(),
    requestFormatted: formatETH(requestWei),
    links: links || [],
    status: 'pending', // pending, approved, rejected
    allocation: '0',
    createdAt: Date.now()
  };

  applications.set(application.id, application);
  console.log(`[APPLICATION] ${projectName} applied to ${ship.name}`);
  
  res.status(201).json(application);
});

app.get('/applications', (req, res) => {
  const { shipId, status } = req.query;
  let results = Array.from(applications.values());
  
  if (shipId) results = results.filter(a => a.shipId === shipId);
  if (status) results = results.filter(a => a.status === status);
  results.sort((a, b) => b.createdAt - a.createdAt);
  
  res.json(results);
});

// ============================================================================
// ALLOCATIONS (Captain decisions)
// ============================================================================

app.post('/applications/:id/allocate', requireWhitelist(), (req, res) => {
  const { captain, amount, approved } = req.body;
  const application = applications.get(req.params.id);
  
  if (!application) return res.status(404).json({ error: 'Application not found' });
  
  const ship = ships.get(application.shipId);
  if (!ship) return res.status(404).json({ error: 'Ship not found' });
  
  if (captain?.toLowerCase() !== ship.captain) {
    return res.status(403).json({ error: 'Only captain can allocate' });
  }

  if (approved === false) {
    application.status = 'rejected';
    applications.set(application.id, application);
    console.log(`[REJECTED] ${application.projectName}`);
    return res.json({ application, message: 'Application rejected' });
  }

  let allocWei = 0n;
  try {
    allocWei = ethers.parseEther((amount || '0').toString());
  } catch (e) {
    return res.status(400).json({ error: 'Invalid amount' });
  }

  const remaining = BigInt(ship.budget) - BigInt(ship.allocated);
  if (allocWei > remaining) {
    return res.status(400).json({ 
      error: 'Insufficient budget', 
      remaining: formatETH(remaining),
      requested: formatETH(allocWei)
    });
  }

  const allocation = {
    id: uuidv4(),
    shipId: ship.id,
    applicationId: application.id,
    projectName: application.projectName,
    applicant: application.applicant,
    amount: allocWei.toString(),
    amountFormatted: formatETH(allocWei),
    distributed: false,
    createdAt: Date.now()
  };

  allocations.set(allocation.id, allocation);
  
  application.status = 'approved';
  application.allocation = allocWei.toString();
  applications.set(application.id, application);
  
  ship.allocated = (BigInt(ship.allocated) + allocWei).toString();
  ships.set(ship.id, ship);
  
  console.log(`[ALLOCATED] ${formatETH(allocWei)} to ${application.projectName}`);
  
  res.status(201).json({ allocation, application, shipBudgetRemaining: formatETH(remaining - allocWei) });
});

// ============================================================================
// DISTRIBUTION
// ============================================================================

app.post('/ships/:id/distribute', requireWhitelist(), async (req, res) => {
  const ship = ships.get(req.params.id);
  if (!ship) return res.status(404).json({ error: 'Ship not found' });
  
  if (!getWallet()) {
    return res.status(500).json({ error: 'Wallet not configured' });
  }

  const pendingAllocations = Array.from(allocations.values())
    .filter(a => a.shipId === ship.id && !a.distributed && BigInt(a.amount) > 0n);

  if (pendingAllocations.length === 0) {
    return res.status(400).json({ error: 'No pending allocations to distribute' });
  }

  const totalToDistribute = pendingAllocations.reduce((sum, a) => sum + BigInt(a.amount), 0n);
  const fee = (totalToDistribute * FEE_PERCENT) / 100n;
  const netTotal = totalToDistribute - fee;

  const payouts = [];

  for (const alloc of pendingAllocations) {
    const netAmount = (BigInt(alloc.amount) * 95n) / 100n; // 5% fee per allocation
    
    try {
      const tx = await getWallet().sendTransaction({ to: alloc.applicant, value: netAmount });
      
      alloc.distributed = true;
      alloc.distributedAt = Date.now();
      alloc.txHash = tx.hash;
      allocations.set(alloc.id, alloc);
      
      payouts.push({
        allocationId: alloc.id,
        projectName: alloc.projectName,
        applicant: alloc.applicant,
        gross: formatETH(alloc.amount),
        net: formatETH(netAmount),
        txHash: tx.hash
      });
      
      console.log(`[PAYOUT] ${formatETH(netAmount)} to ${alloc.projectName}`);
    } catch (err) {
      console.error(`[PAYOUT FAILED] ${alloc.projectName}: ${err.message}`);
    }
  }

  ship.distributed = (BigInt(ship.distributed) + netTotal).toString();
  if (BigInt(ship.distributed) >= BigInt(ship.allocated)) {
    ship.status = 'completed';
  } else {
    ship.status = 'distributing';
  }
  ships.set(ship.id, ship);

  const distribution = {
    id: uuidv4(),
    shipId: ship.id,
    shipName: ship.name,
    totalGross: formatETH(totalToDistribute),
    totalFee: formatETH(fee),
    totalNet: formatETH(netTotal),
    payouts,
    createdAt: Date.now()
  };

  distributions.set(distribution.id, distribution);

  res.json({
    success: true,
    distribution,
    ship: {
      id: ship.id,
      name: ship.name,
      budget: formatETH(ship.budget),
      allocated: formatETH(ship.allocated),
      distributed: formatETH(ship.distributed),
      status: ship.status
    }
  });
});

app.get('/distributions', (req, res) => {
  const { shipId } = req.query;
  let results = Array.from(distributions.values());
  if (shipId) results = results.filter(d => d.shipId === shipId);
  results.sort((a, b) => b.createdAt - a.createdAt);
  res.json(results);
});

// ============================================================================
// UTILITY
// ============================================================================

app.get('/stats', (req, res) => {
  const totalBudget = Array.from(ships.values())
    .reduce((sum, s) => sum + BigInt(s.budget), 0n);
  const totalDistributed = Array.from(ships.values())
    .reduce((sum, s) => sum + BigInt(s.distributed), 0n);

  res.json({
    ships: ships.size,
    activeShips: Array.from(ships.values()).filter(s => s.status === 'open').length,
    applications: applications.size,
    approvedApplications: Array.from(applications.values()).filter(a => a.status === 'approved').length,
    totalBudget: formatETH(totalBudget),
    totalDistributed: formatETH(totalDistributed)
  });
});

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    platform: 'Grant Ships',
    network: 'Base',
    treasury: TREASURY_ADDRESS,
    payoutsEnabled: !!TREASURY_PRIVATE_KEY
  });
});

// ============================================================================
// FRONTEND
// ============================================================================

app.get('/', (req, res) => {
  res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Grant Ships | Modular Grant Rounds</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0d1117; color: #e6edf3; min-height: 100vh; }
    .container { max-width: 900px; margin: 0 auto; padding: 2rem; }
    .hero { text-align: center; padding: 4rem 2rem; background: linear-gradient(180deg, rgba(240,136,62,0.15) 0%, transparent 100%); border-radius: 16px; margin-bottom: 3rem; }
    .hero h1 { font-size: 2.5rem; margin-bottom: 1rem; background: linear-gradient(90deg, #f0883e, #f778ba); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
    .hero p { color: #8b949e; max-width: 600px; margin: 0 auto 2rem; }
    .badge { display: inline-block; background: #238636; color: white; padding: 0.25rem 0.75rem; border-radius: 20px; font-size: 0.8rem; margin-bottom: 1rem; }
    .features { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 1.5rem; margin: 2rem 0; }
    .feature { background: #161b22; border: 1px solid #30363d; border-radius: 12px; padding: 1.5rem; text-align: center; }
    .feature h3 { color: #f0883e; margin-bottom: 0.5rem; }
    .feature p { color: #8b949e; font-size: 0.9rem; }
    .api-section { background: #161b22; border: 1px solid #30363d; border-radius: 12px; padding: 1.5rem; margin-top: 2rem; }
    .endpoint { display: flex; gap: 1rem; padding: 0.5rem 0; border-bottom: 1px solid #30363d; font-family: monospace; font-size: 0.85rem; }
    .endpoint:last-child { border-bottom: none; }
    .method { width: 50px; }
    .method.get { color: #58a6ff; }
    .method.post { color: #3fb950; }
    footer { text-align: center; padding: 2rem; color: #8b949e; border-top: 1px solid #30363d; margin-top: 3rem; }
    footer a { color: #58a6ff; text-decoration: none; }
  </style>
</head>
<body>
  <div class="container">
    <div class="hero">
      <div class="badge">🟢 LIVE ON BASE</div>
      <h1>🚢 Grant Ships</h1>
      <p>Launch modular grant rounds. Configure budget, criteria, duration. Accept applications. Distribute to approved projects.</p>
    </div>

    <div class="features">
      <div class="feature">
        <h3>⚓ Launch a Ship</h3>
        <p>Create a grant round with your own rules</p>
      </div>
      <div class="feature">
        <h3>📝 Accept Applications</h3>
        <p>Projects apply with proposals and links</p>
      </div>
      <div class="feature">
        <h3>🎯 Allocate Funds</h3>
        <p>Captain decides who gets funded</p>
      </div>
      <div class="feature">
        <h3>💰 Distribute</h3>
        <p>Funds flow to approved projects</p>
      </div>
    </div>

    <div class="api-section">
      <h2 style="margin-bottom: 1rem;">🔌 API</h2>
      <div class="endpoint"><span class="method post">POST</span><span>/ships</span><span style="margin-left:auto;color:#8b949e">Create ship</span></div>
      <div class="endpoint"><span class="method get">GET</span><span>/ships</span><span style="margin-left:auto;color:#8b949e">List ships</span></div>
      <div class="endpoint"><span class="method post">POST</span><span>/ships/:id/fund</span><span style="margin-left:auto;color:#8b949e">Fund ship</span></div>
      <div class="endpoint"><span class="method post">POST</span><span>/ships/:id/apply</span><span style="margin-left:auto;color:#8b949e">Apply for grant</span></div>
      <div class="endpoint"><span class="method post">POST</span><span>/applications/:id/allocate</span><span style="margin-left:auto;color:#8b949e">Captain allocates</span></div>
      <div class="endpoint"><span class="method post">POST</span><span>/ships/:id/distribute</span><span style="margin-left:auto;color:#8b949e">Payout grants</span></div>
    </div>
  </div>
  <footer>
    <p>Built by <a href="https://x.com/owockibot">@owockibot</a> | 5% platform fee | Treasury: ${TREASURY_ADDRESS.slice(0, 6)}...${TREASURY_ADDRESS.slice(-4)}</p>
  </footer>
</body>
</html>
  `);
});

// ============================================================================
// AGENT DOCS
// ============================================================================

app.get('/agent', (req, res) => {
  res.json({
    name: 'Grant Ships',
    description: 'Modular grant rounds. Create grant "ships" with budget, criteria, and duration. Accept applications, captain allocates funds, distribute to approved projects.',
    network: 'Base',
    treasury_fee: '5%',
    endpoints: [
      { method: 'POST', path: '/ships', description: 'Create a grant ship (round)', body: { name: 'string (required)', captain: 'string (required)', description: 'string', criteria: 'array of strings', durationDays: 'number (default 30)' } },
      { method: 'GET', path: '/ships', description: 'List all ships', query: { status: 'open/closed/distributing/completed' } },
      { method: 'GET', path: '/ships/:id', description: 'Get ship with applications and allocations' },
      { method: 'POST', path: '/ships/:id/fund', description: 'Fund a ship budget (send ETH to treasury first)', body: { txHash: 'string (required)' } },
      { method: 'POST', path: '/ships/:id/apply', description: 'Apply for grant from ship', body: { applicant: 'string (required)', projectName: 'string (required)', description: 'string', requestAmount: 'string (ETH)', links: 'array' } },
      { method: 'GET', path: '/applications', description: 'List applications', query: { shipId: 'filter by ship', status: 'pending/approved/rejected' } },
      { method: 'POST', path: '/applications/:id/allocate', description: 'Captain allocates funds to application', body: { captain: 'string (required)', amount: 'string (ETH)', approved: 'boolean (false to reject)' } },
      { method: 'POST', path: '/ships/:id/distribute', description: 'Distribute allocated funds to approved projects' },
      { method: 'GET', path: '/distributions', description: 'List all distributions', query: { shipId: 'filter by ship' } },
      { method: 'GET', path: '/stats', description: 'Platform statistics' },
      { method: 'GET', path: '/health', description: 'Health check' }
    ],
    example_flow: [
      '1. POST /ships - Create grant round with captain and criteria',
      '2. Send ETH to treasury, POST /ships/:id/fund - Fund the ship',
      '3. POST /ships/:id/apply - Projects apply for grants',
      '4. POST /applications/:id/allocate - Captain approves and allocates',
      '5. POST /ships/:id/distribute - Funds flow to approved projects'
    ],
    x402_enabled: false
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Grant Ships running on :${PORT}`));
module.exports = app;
