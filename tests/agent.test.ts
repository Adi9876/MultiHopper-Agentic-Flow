import assert from 'assert';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import fs from 'fs';
import { 
  MultiHopperAgent, 
  ConnectionInterface, 
  AgentStateStore
} from '../src/agent.js';

// Define Mock Connection to intercept and record Solana RPC calls
class TestConnection implements ConnectionInterface {
  public broadcastLogs: { label: string; signature: string }[] = [];
  public rawTxCount = 0;

  async sendRawTransaction(rawTransaction: Uint8Array, options?: any): Promise<string> {
    this.rawTxCount++;
    // Generate mock transaction signature
    const dummySig = bs58.encode(Keypair.generate().secretKey.slice(0, 64));
    this.broadcastLogs.push({ label: options?.label || 'unknown', signature: dummySig });
    return dummySig;
  }

  async confirmTransaction(signature: string, commitment?: any): Promise<any> {
    return { value: { err: null } };
  }
}

// Simple test runner structure
async function runTests() {
  console.log('=== STARTING MULTIHOPPER AGENTIC FLOW TEST SUITE ===\n');

  // Start Mock Server on Port 3001
  const port = 3001;
  const apiBase = `http://localhost:${port}`;
  const apiKey = 'mh_test_bounty_key_12345';
  
  // We launch the express server
  await import('../src/mockServer.js');
  
  console.log('[TEST] Starting mock server on port 3001...');
  
  // Wait a moment for server to initialize
  await new Promise(r => setTimeout(r, 1000));

  const clientKeypair = Keypair.generate();
  process.env.SOLANA_PRIVATE_KEY = bs58.encode(clientKeypair.secretKey);

  let success = true;

  try {
    // -------------------------------------------------------------------------
    // TEST CASE 1: Standard Transfer Flow (Happy Path)
    // -------------------------------------------------------------------------
    console.log('\n--- TEST CASE 1: Standard Transfer Flow ---');
    const conn1 = new TestConnection();
    // Wrap connection to trace labels
    const trackedConn1: ConnectionInterface = {
      sendRawTransaction: async (rawTx) => {
        // Parse transaction to verify it is valid deserializable Solana transaction
        const tx = await import('@solana/web3.js').then(web3 => web3.VersionedTransaction.deserialize(Buffer.from(rawTx)));
        
        // Assert that the transaction has the expected signers
        assert.ok(tx.signatures.length > 0, 'Transaction has signatures');
        
        // Assert that the server signature was PRESERVED in slot 0 (should not be all zeroes)
        if (tx.signatures.length > 1) {
          const serverSig = tx.signatures[0];
          const allZeroes = serverSig.every(x => x === 0);
          assert.strictEqual(allZeroes, false, 'Server pre-signature was preserved in VersionedTransaction!');
        }

        return conn1.sendRawTransaction(rawTx);
      },
      confirmTransaction: (sig) => conn1.confirmTransaction(sig)
    };

    const stateStore1 = new AgentStateStore('./test-state-1.json');
    const agent1 = new MultiHopperAgent(apiBase, apiKey, trackedConn1, stateStore1);

    const result1 = await agent1.transfer({
      sourceOwner: clientKeypair.publicKey.toBase58(),
      recipientWallet: Keypair.generate().publicKey.toBase58(),
      amountRaw: '1000000000',
      amountTokens: '1.0',
      tokenMint: 'So11111111111111111111111111111111111111112',
      tokenDecimals: 9,
      hops: 5,
      arrivalSeconds: 300,
      testScenario: 'standard'
    });

    assert.strictEqual(result1.status, 'completed', 'Transfer should be completed');
    assert.strictEqual(result1.phase, 'settled', 'Transfer should be settled');
    console.log('✓ Test Case 1 Passed! Standard transfer successfully executed with preserved signatures.');

    // -------------------------------------------------------------------------
    // TEST CASE 2: Double-Funding Prevention
    // -------------------------------------------------------------------------
    console.log('\n--- TEST CASE 2: Double-Funding Prevention ---');
    
    // We will run the agent but mock confirm-broadcast failing on the first keeper funding call
    const conn2 = new TestConnection();
    const stateStore2 = new AgentStateStore('./test-state-2.json');
    const agent2 = new MultiHopperAgent(apiBase, apiKey, conn2, stateStore2);

    const externalId2 = Keypair.generate().publicKey.toBase58();
    const params2 = {
      sourceOwner: clientKeypair.publicKey.toBase58(),
      recipientWallet: Keypair.generate().publicKey.toBase58(),
      amountRaw: '1000000000',
      amountTokens: '1.0',
      tokenMint: 'So11111111111111111111111111111111111111112',
      tokenDecimals: 9,
      hops: 5,
      arrivalSeconds: 300,
      testScenario: 'double_funding',
      externalId: externalId2
    };

    // We simulate a crash by overriding axios to throw on the 1st confirm-broadcast call
    const originalPost = (await import('axios')).default.post;
    let postCallCount = 0;
    
    ((await import('axios')).default as any).post = async function (url: string, data: any, config: any) {
      if (url.includes('confirm-broadcast')) {
        postCallCount++;
        // If it is the first call (keeper funding confirmation), simulate a crash/timeout
        if (postCallCount === 1) {
          console.log('[MOCK CRASH] Simulating network failure during confirm-broadcast...');
          throw new Error('Timeout communicating with MultiHopper API');
        }
      }
      return originalPost.call(this, url, data, config);
    };

    console.log('[TEST] Initiating first transfer attempt (will fail after keeper funding)...');
    try {
      await agent2.transfer(params2);
      assert.fail('Should have thrown crash error');
    } catch (e: any) {
      console.log(`[TEST] Safely caught expected crash: ${e.message}`);
    }

    // Check that keeperFundingTx was signed and broadcasted once
    assert.strictEqual(conn2.rawTxCount, 1, 'Should have broadcasted keeperFundingTx once before crash');
    
    // Restore axios original post
    (await import('axios')).default.post = originalPost;

    // Now resume by calling transfer again
    console.log('\n[TEST] Resuming transfer after crash...');
    const result2 = await agent2.transfer(params2);
    
    assert.strictEqual(result2.status, 'completed', 'Resumed transfer should complete');
    // Ensure rawTxCount is 4 (1 keeper funding, 1 route init, 1 orchestrator, 1 session init)
    // If it did NOT prevent double-funding, rawTxCount would be 5 (keeper funding broadcasted twice).
    assert.strictEqual(conn2.rawTxCount, 4, 'Raw transaction count must be exactly 4. Double funding was successfully prevented!');
    console.log('✓ Test Case 2 Passed! Resumed transfer completed without double-funding the keeper.');

    // -------------------------------------------------------------------------
    // TEST CASE 3: Blockhash Expiry & Resumption
    // -------------------------------------------------------------------------
    console.log('\n--- TEST CASE 3: Blockhash Expiry & Resumption ---');
    const conn3 = new TestConnection();
    const stateStore3 = new AgentStateStore('./test-state-3.json');
    const agent3 = new MultiHopperAgent(apiBase, apiKey, conn3, stateStore3);

    const result3 = await agent3.transfer({
      sourceOwner: clientKeypair.publicKey.toBase58(),
      recipientWallet: Keypair.generate().publicKey.toBase58(),
      amountRaw: '1000000000',
      amountTokens: '1.0',
      tokenMint: 'So11111111111111111111111111111111111111112',
      tokenDecimals: 9,
      hops: 5,
      arrivalSeconds: 300,
      testScenario: 'expiry'
    });

    assert.strictEqual(result3.status, 'completed', 'Transfer should complete successfully');
    console.log('✓ Test Case 3 Passed! Resumed successfully after mock blockhash expiry.');

    // -------------------------------------------------------------------------
    // TEST CASE 4: Compliance Screening Failure (Refunded path)
    // -------------------------------------------------------------------------
    console.log('\n--- TEST CASE 4: Compliance Screening Failure ---');
    const conn4 = new TestConnection();
    const stateStore4 = new AgentStateStore('./test-state-4.json');
    const agent4 = new MultiHopperAgent(apiBase, apiKey, conn4, stateStore4);

    const result4 = await agent4.transfer({
      sourceOwner: clientKeypair.publicKey.toBase58(),
      recipientWallet: Keypair.generate().publicKey.toBase58(),
      amountRaw: '1000000000',
      amountTokens: '1.0',
      tokenMint: 'So11111111111111111111111111111111111111112',
      tokenDecimals: 9,
      hops: 5,
      arrivalSeconds: 300,
      testScenario: 'compliance_fail'
    });

    assert.strictEqual(result4.status, 'refunded', 'Flagged wallet should cause transfer to be refunded');
    console.log('✓ Test Case 4 Passed! Blocked and refunded flagged compliance route correctly.');

  } catch (err) {
    console.error('\n✗ TEST RUN ENCOUNTERED ERROR:', err);
    success = false;
  } finally {
    // Cleanup state files
    try {
      if (fs.existsSync('./test-state-1.json')) fs.unlinkSync('./test-state-1.json');
      if (fs.existsSync('./test-state-2.json')) fs.unlinkSync('./test-state-2.json');
      if (fs.existsSync('./test-state-3.json')) fs.unlinkSync('./test-state-3.json');
      if (fs.existsSync('./test-state-4.json')) fs.unlinkSync('./test-state-4.json');
    } catch {}
    
    console.log('\n[TEST] Tests execution completed. Exiting...');
    process.exit(success ? 0 : 1);
  }
}

runTests();
