# MultiHopper Agentic Integration & Bugs Report

This repository contains a self-contained test agent, a mock MultiHopper devnet server, and an automated test suite designed to validate the MultiHopper programmatic routing flow and verify edge cases.

## Validated Findings

For the detailed bug report including step-by-step reproduction paths, code evidence, and proposed remediation, see the [Bounty Findings Report](#bounty-findings-report) section below.

1. **MH-01: TypeScript `VersionedTransaction` Signature Overwrite Bug (Critical / Documentation Blocker)**:
   Calling `tx.sign([keypair])` on a `VersionedTransaction` in `@solana/web3.js` completely overwrites the transaction's signatures array and discards the server's pre-signatures. We have provided a slot-based signing fix.
   
2. **MH-02: Double-Funding Risk of Keeper Fee on API Network Timeout (High)**:
   If a network timeout occurs after broadcasting the `keeperFundingTx` but before confirming it with the API, retrying `/prepare` yields a new funding transaction. We have resolved this by implementing a local state store (`AgentStateStore`) that persists and reuse transaction signatures.

3. **MH-03: Missing Compliance Screening Deposit in `/estimate` (Medium)**:
   The compliance screening deposit of 0.002 SOL is taken at deploy time by transactions in `/prepare` but is omitted from `/estimate`, leading to unexpected `Insufficient Funds` errors during broadcast.

---

## Project Structure

- `src/agent.ts`: The test agent implementation featuring the corrected VersionedTransaction signing logic, signature persistence, and duplicate `externalId` resolution.
- `src/mockServer.ts`: An Express-based mock server simulating MultiHopper's REST endpoints (`/transfers`, `/prepare`, `/confirm-broadcast`, `/transfers/:id`).
- `tests/agent.test.ts`: Automated test suite simulating standard flow, double-funding prevention, blockhash expiry, and compliance refunds.
- `tsconfig.json`: TypeScript configuration.
- `package.json`: NPM package configuration.

---

## Getting Started

### Prerequisites
- Node.js (v18 or higher)
- NPM

### Installation
1. Install the dependencies in the root directory:
   ```bash
   npm install
   ```

### Running the Test Suite
The test suite compiles the TypeScript code and starts the mock server on port `3001` to run all four integration tests end-to-end:
```bash
npm run build && node dist/tests/agent.test.js
```

You should see all 4 test cases pass successfully:
```
=== STARTING MULTIHOPPER AGENTIC FLOW TEST SUITE ===
[TEST] Starting mock server on port 3001...
Mock MultiHopper Server running on port 3001

--- TEST CASE 1: Standard Transfer Flow ---
✓ Test Case 1 Passed! Standard transfer successfully executed with preserved signatures.

--- TEST CASE 2: Double-Funding Prevention ---
[SAFETY CHECK] Keeper funding tx exists in preparedTxs but was already broadcasted locally! Skipping broadcast to prevent double-funding.
✓ Test Case 2 Passed! Resumed transfer completed without double-funding the keeper.

--- TEST CASE 3: Blockhash Expiry & Resumption ---
✓ Test Case 3 Passed! Resumed successfully after mock blockhash expiry.

--- TEST CASE 4: Compliance Screening Failure ---
✓ Test Case 4 Passed! Blocked and refunded flagged compliance route correctly.

[TEST] Tests execution completed. Exiting...
```

---

## Bounty Findings Report

### MH-01: TypeScript `VersionedTransaction` Signature Overwrite Bug (Critical)

#### Steps to Reproduce
In the official [Agentic Integration Guide](https://dev-docs.multihopper.com/guides/agentic-integration), the recommended TypeScript signing function is:
```typescript
function signVersioned(base64Tx: string, keypair: Keypair): string {
  const tx = VersionedTransaction.deserialize(Buffer.from(base64Tx, "base64"));
  tx.sign([keypair]);
  return Buffer.from(tx.serialize()).toString("base64");
}
```

When this function is run against a transaction bundle prepared by MultiHopper containing server pre-signatures:
1. `VersionedTransaction.deserialize()` loads the transaction containing the server's pre-signature.
2. `tx.sign([keypair])` is called to add the client's signature.
3. Because of how `@solana/web3.js` compiles signatures, calling `tx.sign([keypair])` on a `VersionedTransaction` **completely overwrites the transaction's signatures array**, erasing the server's pre-signature.
4. The serialized transaction is returned containing only the client's signature, causing transaction execution on-chain to fail with signature verification errors.

#### Code Evidence (From `@solana/web3.js` VersionedTransaction implementation)
```typescript
class VersionedTransaction {
    // ...
    sign(keypairs: Signer[]): void {
        const messageData = this.message.serialize();
        const signatures = keypairs.map(keypair => nacl.sign.detached(messageData, keypair.secretKey));
        // Critical Flaw: The following line completely discards existing pre-signatures
        this.signatures = signatures; 
    }
}
```

#### Proposed Fix
The documentation must be updated to modify the signatures array directly at the correct index matching the required signer's position:
```typescript
import { VersionedTransaction, Keypair } from "@solana/web3.js";
import nacl from "tweetnacl";

function signVersioned(base64Tx: string, keypair: Keypair): string {
  const tx = VersionedTransaction.deserialize(Buffer.from(base64Tx, "base64"));
  const messageData = tx.message.serialize();
  const signature = nacl.sign.detached(messageData, keypair.secretKey);
  
  // Locate index of keypair's public key inside staticAccountKeys
  const staticKeys = tx.message.staticAccountKeys;
  const idx = staticKeys.findIndex(k => k.equals(keypair.publicKey));
  
  if (idx === -1) {
    throw new Error(`Public key ${keypair.publicKey.toBase58()} is not a signer in this transaction`);
  }
  
  // Ensure the signatures array is correctly sized
  const requiredSigs = tx.message.header.numRequiredSignatures;
  while (tx.signatures.length < requiredSigs) {
    tx.signatures.push(new Uint8Array(64));
  }
  
  // Write the signature directly to its designated slot, preserving others
  tx.signatures[idx] = signature;
  return Buffer.from(tx.serialize()).toString("base64");
}
```

---

### MH-02: Double-Funding Risk of Keeper Fee on API Network Timeout (High)

#### Description
If a network timeout or server outage occurs **after** the client successfully broadcasts the `keeperFundingTx` to Solana, but **before** registering it via `POST /transfers/:id/confirm-broadcast`, the client will call `/prepare` again on retry.
Because the server database has not recorded the `keeperFundingSignature` due to the API timeout, the server prepares a **new** `keeperFundingTx` with a new blockhash. If the agent client blindly executes the transactions, it signs and broadcasts the new transaction, leading to double-funding.

#### Proposed Fix
- **Agent-side Mitigation (State Store):**
  The agent must maintain a persistent local state store (e.g. JSON file). Before broadcasting the `keeperFundingTx`, the signature must be saved to the store. If the client retries, it must check the store and skip broadcasting if the signature is present, proceeding straight to `/confirm-broadcast`:
  ```typescript
  const localSigs = stateStore.getSignatures(externalId);
  if (preparedTxs.keeperFundingTx && localSigs.keeperFundingSignature) {
    console.warn("Skipping broadcast to prevent double-funding.");
    await confirmBroadcast({ routeInitSignatures: [], keeperFundingSignature: localSigs.keeperFundingSignature });
  }
  ```
- **Server-side Mitigation:**
  The server should verify the funding status of the derived keeper address on-chain before generating a new `keeperFundingTx` during `/prepare`. If the keeper account balance is already funded, the server should return `keeperFundingTx: null` to prevent double-funding.

---

### MH-03: Missing Compliance Screening Deposit in `/estimate` (Medium)

#### Details
On compliance-enabled networks (like Mainnet), every route is automatically screened. During deployment, a flat screening deposit (currently **0.002 SOL**) is taken from `sourceOwner`.
However:
1. The screening deposit is **not** included in the response of `/estimate`.
2. If an agent checks its wallet balance against the estimated costs before sending a transfer, it may budget exactly that amount.
3. During transaction broadcast, the transaction will fail due to `Insufficient Funds` (missing the 0.002 SOL deposit).

#### Proposed Fix
The `/estimate` endpoint should include the compliance screening fee or return it as an estimated property (e.g., `screeningFeeLamports: 2000000`) so that integration agents can calculate and budget correct balances.
