import express from 'express';
import { 
  Keypair, 
  PublicKey, 
  SystemProgram, 
  Transaction, 
  TransactionMessage, 
  VersionedTransaction 
} from '@solana/web3.js';
import { v4 as uuidv4 } from 'uuid';

const app = express();
app.use(express.json());

interface Transfer {
  id: string;
  tokenMint: string;
  amountRaw: string;
  amountTokens: string;
  tokenDecimals: number;
  tokenSymbol: string;
  sourceOwner: string;
  recipientWallet: string;
  hops: number;
  arrivalSeconds: number;
  externalId: string;
  status: string;
  phase: string;
  progress: {
    hopsCompleted: number;
    hopsTotal: number;
  };
  
  // Signatures recorded
  keeperFundingSignature?: string;
  routeInitSignatures?: string[];
  orchestratorInitSignature?: string;
  sessionInitSignatures?: string[];
  
  // Test controls
  testScenario?: 'standard' | 'double_funding' | 'expiry' | 'compliance_fail';
  prepareAttempts: number;
}

const transfersDb = new Map<string, Transfer>();
const externalIdDb = new Set<string>();

// Mock server keypair representing MultiHopper protocol authority
const serverKeypair = Keypair.generate();

// Helper to create and serialize mock Solana transactions
function createMockTx(
  type: 'versioned' | 'legacy',
  sourceOwnerPubkey: PublicKey,
  recentBlockhash: string,
  purpose: 'funding' | 'route' | 'orch' | 'session'
): string {
  if (type === 'versioned') {
    // Versioned transaction (v0)
    // We add sourceOwner and serverKeypair as required signers for pre-signed transactions
    const signers = purpose === 'funding' 
      ? [sourceOwnerPubkey]
      : [serverKeypair.publicKey, sourceOwnerPubkey];

    const instructions = [
      SystemProgram.transfer({
        fromPubkey: sourceOwnerPubkey,
        toPubkey: Keypair.generate().publicKey,
        lamports: 1000,
      })
    ];

    if (purpose === 'route' || purpose === 'session') {
      instructions.push(
        SystemProgram.transfer({
          fromPubkey: serverKeypair.publicKey,
          toPubkey: Keypair.generate().publicKey,
          lamports: 1000,
        })
      );
    }

    const message = new TransactionMessage({
      payerKey: sourceOwnerPubkey,
      recentBlockhash: recentBlockhash,
      instructions
    }).compileToV0Message();

    const tx = new VersionedTransaction(message);

    // If it's routeInit or sessionInit, the server pre-signs it!
    if (purpose === 'route' || purpose === 'session') {
      tx.sign([serverKeypair]);
    }

    return Buffer.from(tx.serialize()).toString('base64');
  } else {
    // Legacy Transaction (for orchestratorInitTx)
    const tx = new Transaction();
    tx.recentBlockhash = recentBlockhash;
    tx.feePayer = sourceOwnerPubkey;
    tx.add(SystemProgram.transfer({
      fromPubkey: sourceOwnerPubkey,
      toPubkey: Keypair.generate().publicKey,
      lamports: 1000,
    }));

    return tx.serialize({ requireAllSignatures: false }).toString('base64');
  }
}

// 1. Estimate fees
app.post('/api/v1/transfers/estimate', (req, res) => {
  const apiKey = req.headers['x-api-key'] || req.headers['authorization'];
  if (!apiKey) {
    return res.status(401).json({ error: { code: 'MH_001', message: 'Invalid or missing API key' } });
  }

  const { tokenMint, amountRaw, hops } = req.body;
  if (!tokenMint || !amountRaw) {
    return res.status(400).json({ error: { code: 'MH_010', message: 'Missing tokenMint or amountRaw' } });
  }

  if (hops && (hops < 3 || hops > 10)) {
    return res.status(400).json({ error: { code: 'MH_013', message: 'Hops out of range — must be 3–10' } });
  }

  return res.json({
    tier: 'standard',
    percentFeeBps: 50,
    totalFlatFeeLamports: 42000,
    usdEquivalent: 15.50
  });
});

// 2. Create transfer
app.post('/api/v1/transfers', (req, res) => {
  const apiKey = req.headers['x-api-key'] || req.headers['authorization'];
  if (!apiKey) {
    return res.status(401).json({ error: { code: 'MH_001', message: 'Invalid or missing API key' } });
  }

  const idempotencyKey = req.headers['idempotency-key'];
  if (!idempotencyKey) {
    return res.status(400).json({ error: { code: 'MH_070', message: 'Idempotency-Key header missing or invalid' } });
  }

  const {
    tokenMint,
    amountRaw,
    amountTokens,
    sourceOwner,
    recipientWallet,
    hops,
    arrivalSeconds,
    externalId,
    testScenario
  } = req.body;

  if (!tokenMint || !amountRaw || !sourceOwner || !recipientWallet || !hops || !arrivalSeconds) {
    return res.status(400).json({ error: { code: 'MH_011', message: 'Missing required transfer fields' } });
  }

  if (hops < 3 || hops > 10) {
    return res.status(400).json({ error: { code: 'MH_013', message: 'Hops out of range — must be 3–10' } });
  }

  if (arrivalSeconds < hops * 30) {
    return res.status(400).json({ error: { code: 'MH_014', message: 'arrivalSeconds below minimum for hop count' } });
  }

  if (externalId && externalIdDb.has(externalId)) {
    return res.status(409).json({ error: { code: 'MH_033', message: 'Transfer already exists (duplicate externalId)' } });
  }

  if (externalId) {
    externalIdDb.add(externalId);
  }

  const transferId = uuidv4();
  const transfer: Transfer = {
    id: transferId,
    tokenMint,
    amountRaw,
    amountTokens: amountTokens || '1.0',
    tokenDecimals: req.body.tokenDecimals || 9,
    tokenSymbol: req.body.tokenSymbol || 'SOL',
    sourceOwner,
    recipientWallet,
    hops,
    arrivalSeconds,
    externalId: externalId || transferId,
    status: 'awaiting_signature',
    phase: 'quoted',
    progress: { hopsCompleted: 0, hopsTotal: hops },
    testScenario,
    prepareAttempts: 0
  };

  transfersDb.set(transferId, transfer);
  return res.json(transfer);
});

// 3. Prepare transfer
app.post('/api/v1/transfers/:id/prepare', (req, res) => {
  const apiKey = req.headers['x-api-key'] || req.headers['authorization'];
  if (!apiKey) {
    return res.status(401).json({ error: { code: 'MH_001', message: 'Invalid or missing API key' } });
  }

  const transfer = transfersDb.get(req.params.id);
  if (!transfer) {
    return res.status(404).json({ error: { code: 'MH_030', message: 'Transfer not found' } });
  }

  transfer.prepareAttempts++;

  // Mock blockhash variables
  const recentBlockhash = '5eykt4UsjGc25QK9Q3JH735y3jJH735y3jJH735y3jJH';
  const lastValidBlockHeight = 291182440;

  const ownerPubkey = new PublicKey(transfer.sourceOwner);

  // Resume state structure
  const resume: Record<string, any> = {};

  let routeInitTxs: any[] | null = [{ base64: createMockTx('versioned', ownerPubkey, recentBlockhash, 'route') }];
  let orchestratorInitTx: string | null = createMockTx('legacy', ownerPubkey, recentBlockhash, 'orch');
  let sessionInitTxs: string[] | null = [createMockTx('versioned', ownerPubkey, recentBlockhash, 'session')];
  let keeperFundingTx: string | null = createMockTx('versioned', ownerPubkey, recentBlockhash, 'funding');

  // Handle test scenarios
  if (transfer.testScenario === 'double_funding') {
    // Scenario: Keeper was already funded, but client requests prepare again because it crashed
    // before calling confirm-broadcast.
    // If the server doesn't keep track or check the balance correctly (the design risk we are testing),
    // it will return the keeperFundingTx again!
    // In our mock, if prepareAttempts > 1, we still return the keeperFundingTx to test if the client double-funds.
    if (transfer.keeperFundingSignature) {
      // If the client calls confirm-broadcast, the mock server registers the signature.
      // But if the server checks on-chain or receives confirm-broadcast, it should be null.
      // We simulate the buggy server behavior: it keeps emitting keeperFundingTx until confirm-broadcast is received.
      keeperFundingTx = createMockTx('versioned', ownerPubkey, recentBlockhash, 'funding');
    }
  }

  if (transfer.testScenario === 'expiry') {
    // First attempt gets everything.
    // On second attempt (simulating resumption after some txs landed on-chain), we return null for already landed txs.
    if (transfer.prepareAttempts > 1) {
      keeperFundingTx = null; // already confirmed
      routeInitTxs = null; // already confirmed
      orchestratorInitTx = null; // already confirmed
      resume.routeAlreadyDeployed = true;
    }
  }

  // If already confirmed through normal flow
  if (transfer.keeperFundingSignature) {
    keeperFundingTx = null;
  }
  if (transfer.routeInitSignatures && transfer.routeInitSignatures.length > 0) {
    routeInitTxs = null;
  }
  if (transfer.orchestratorInitSignature) {
    orchestratorInitTx = null;
  }
  if (transfer.sessionInitSignatures && transfer.sessionInitSignatures.length > 0) {
    sessionInitTxs = null;
    resume.nothingToDo = true;
  }

  return res.json({
    transfer,
    preparedTxs: {
      routeInitTxs,
      orchestratorInitTx,
      sessionInitTxs,
      keeperFundingTx,
      recentBlockhash,
      lastValidBlockHeight,
      resume
    }
  });
});

// 4. Confirm broadcast
app.post('/api/v1/transfers/:id/confirm-broadcast', (req, res) => {
  const apiKey = req.headers['x-api-key'] || req.headers['authorization'];
  if (!apiKey) {
    return res.status(401).json({ error: { code: 'MH_001', message: 'Invalid or missing API key' } });
  }

  const idempotencyKey = req.headers['idempotency-key'];
  if (!idempotencyKey) {
    return res.status(400).json({ error: { code: 'MH_070', message: 'Idempotency-Key header missing or invalid' } });
  }

  const transfer = transfersDb.get(req.params.id);
  if (!transfer) {
    return res.status(404).json({ error: { code: 'MH_030', message: 'Transfer not found' } });
  }

  const {
    routeInitSignatures,
    orchestratorInitSignature,
    sessionInitSignatures,
    keeperFundingSignature
  } = req.body;

  // 1st confirm-broadcast call (keeper funding only)
  if (keeperFundingSignature && (!routeInitSignatures || routeInitSignatures.length === 0)) {
    transfer.keeperFundingSignature = keeperFundingSignature;
    transfer.status = 'awaiting_signature';
    return res.json(transfer);
  }

  // 2nd confirm-broadcast call (remaining signatures)
  // Check if keeper funding signature was provided earlier or in this request
  const hasKeeperFunding = transfer.keeperFundingSignature || keeperFundingSignature;
  if (!hasKeeperFunding) {
    return res.status(400).json({ error: { code: 'MH_039', message: 'Keeper funding signature required but not provided' } });
  }

  if (keeperFundingSignature) transfer.keeperFundingSignature = keeperFundingSignature;
  if (routeInitSignatures) transfer.routeInitSignatures = routeInitSignatures;
  if (orchestratorInitSignature) transfer.orchestratorInitSignature = orchestratorInitSignature;
  if (sessionInitSignatures) transfer.sessionInitSignatures = sessionInitSignatures;

  // Move transfer status forward
  transfer.status = 'processing';
  transfer.phase = 'deploying';

  // Simulating asynchronous keepers execution
  setTimeout(() => {
    if (transfer.testScenario === 'compliance_fail') {
      transfer.status = 'refunded';
      transfer.phase = 'failed';
    } else {
      transfer.status = 'completed';
      transfer.phase = 'settled';
      transfer.progress.hopsCompleted = transfer.progress.hopsTotal;
    }
  }, 100);

  return res.json(transfer);
});

// 5. List transfers
app.get('/api/v1/transfers', (req, res) => {
  const apiKey = req.headers['x-api-key'] || req.headers['authorization'];
  if (!apiKey) {
    return res.status(401).json({ error: { code: 'MH_001', message: 'Invalid or missing API key' } });
  }

  const { externalId } = req.query;
  const transfers = Array.from(transfersDb.values());

  if (externalId) {
    const filtered = transfers.filter(t => t.externalId === externalId);
    return res.json({ transfers: filtered });
  }

  return res.json({ transfers });
});

// 6. Get transfer
app.get('/api/v1/transfers/:id', (req, res) => {
  const apiKey = req.headers['x-api-key'] || req.headers['authorization'];
  if (!apiKey) {
    return res.status(401).json({ error: { code: 'MH_001', message: 'Invalid or missing API key' } });
  }

  const transfer = transfersDb.get(req.params.id);
  if (!transfer) {
    return res.status(404).json({ error: { code: 'MH_030', message: 'Transfer not found' } });
  }

  return res.json({ transfer });
});

// Start server
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Mock MultiHopper Server running on port ${PORT}`);
});
