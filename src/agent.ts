import { 
  Keypair, 
  VersionedTransaction, 
  Transaction, 
  PublicKey 
} from '@solana/web3.js';
import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';
import * as fs from 'fs';
import * as path from 'path';
import nacl from 'tweetnacl';
import bs58 from 'bs58';

// Interface matching MultiHopper prepared transactions
export interface PreparedTxs {
  routeInitTxs?: { base64: string }[] | null;
  orchestratorInitTx?: string | null;
  sessionInitTxs?: string[] | null;
  keeperFundingTx?: string | null;
  recentBlockhash?: string;
  lastValidBlockHeight?: number;
  resume?: {
    nothingToDo?: boolean;
    routeAlreadyDeployed?: boolean;
  };
}

export interface BroadcastSignatures {
  transferId?: string;
  keeperFundingSignature?: string;
  routeInitSignatures?: string[];
  orchestratorInitSignature?: string;
  sessionInitSignatures?: string[];
}

export interface ConnectionInterface {
  sendRawTransaction(rawTransaction: Buffer | Uint8Array, options?: any): Promise<string>;
  confirmTransaction(signature: string, commitment?: any): Promise<any>;
}

// State Store to prevent double-funding and handle resumption safely
export class AgentStateStore {
  private filePath: string;
  private memoryDb: Map<string, BroadcastSignatures> = new Map();

  constructor(filePath?: string) {
    this.filePath = filePath || path.join(process.cwd(), '.multihopper-agent-state.json');
    this.loadFromFile();
  }

  private loadFromFile() {
    try {
      if (fs.existsSync(this.filePath)) {
        const data = fs.readFileSync(this.filePath, 'utf8');
        const json = JSON.parse(data);
        for (const [key, val] of Object.entries(json)) {
          this.memoryDb.set(key, val as BroadcastSignatures);
        }
      }
    } catch (e) {
      console.warn('Could not load agent state from file, using in-memory store', e);
    }
  }

  private saveToFile() {
    try {
      const obj: Record<string, BroadcastSignatures> = {};
      for (const [key, val] of this.memoryDb.entries()) {
        obj[key] = val;
      }
      fs.writeFileSync(this.filePath, JSON.stringify(obj, null, 2), 'utf8');
    } catch (e) {
      console.warn('Could not save agent state to file', e);
    }
  }

  public getSignatures(transferId: string): BroadcastSignatures {
    return this.memoryDb.get(transferId) || {};
  }

  public saveSignatures(transferId: string, signatures: BroadcastSignatures) {
    const existing = this.getSignatures(transferId);
    const updated = { ...existing, ...signatures };
    this.memoryDb.set(transferId, updated);
    this.saveToFile();
  }

  public clear(transferId: string) {
    this.memoryDb.delete(transferId);
    this.saveToFile();
  }
}

// ----------------------------------------------------
// Fixed Signing Functions (addresses documentation bug)
// ----------------------------------------------------

/**
 * Sign a VersionedTransaction (v0) while preserving existing signatures (e.g. server pre-signatures).
 * This fixes the official documentation bug where tx.sign([keypair]) would overwrite all signatures.
 */
export function signVersioned(base64Tx: string, keypair: Keypair): string {
  const tx = VersionedTransaction.deserialize(Buffer.from(base64Tx, 'base64'));
  const messageData = tx.message.serialize();
  const signature = nacl.sign.detached(messageData, keypair.secretKey);
  
  // Find the index of the keypair's public key in the message's static accounts list
  const staticKeys = tx.message.staticAccountKeys;
  const idx = staticKeys.findIndex(k => k.equals(keypair.publicKey));
  
  if (idx === -1) {
    throw new Error(`Public key ${keypair.publicKey.toBase58()} not found in transaction required signers`);
  }
  
  // Ensure the signatures array has enough slots allocated
  const requiredSigs = tx.message.header.numRequiredSignatures;
  while (tx.signatures.length < requiredSigs) {
    tx.signatures.push(new Uint8Array(64));
  }
  
  // Write our signature to the correct index, leaving other signature slots unchanged
  tx.signatures[idx] = signature;
  
  return Buffer.from(tx.serialize()).toString('base64');
}

/**
 * Sign a legacy Transaction partially.
 */
export function signLegacy(base64Tx: string, keypair: Keypair): string {
  const tx = Transaction.from(Buffer.from(base64Tx, 'base64'));
  tx.partialSign(keypair);
  return tx.serialize({ requireAllSignatures: false }).toString('base64');
}

export function signPreparedTxs(preparedTxs: PreparedTxs, keypair: Keypair): PreparedTxs {
  const signed: PreparedTxs = {};
  
  if (preparedTxs.keeperFundingTx) {
    signed.keeperFundingTx = signVersioned(preparedTxs.keeperFundingTx, keypair);
  }
  if (preparedTxs.routeInitTxs && preparedTxs.routeInitTxs.length > 0) {
    signed.routeInitTxs = preparedTxs.routeInitTxs.map(e => ({
      base64: signVersioned(e.base64, keypair),
    }));
  }
  if (preparedTxs.orchestratorInitTx) {
    signed.orchestratorInitTx = signLegacy(preparedTxs.orchestratorInitTx, keypair);
  }
  if (preparedTxs.sessionInitTxs && preparedTxs.sessionInitTxs.length > 0) {
    signed.sessionInitTxs = preparedTxs.sessionInitTxs.map(b => 
      signVersioned(b, keypair)
    );
  }
  
  return signed;
}

// ----------------------------------------------------
// Robust Broadcaster
// ----------------------------------------------------

export async function broadcastAndConfirm(
  connection: ConnectionInterface,
  base64Tx: string,
  label: string
): Promise<string> {
  const txBytes = Buffer.from(base64Tx, 'base64');
  const signature = await connection.sendRawTransaction(txBytes, { skipPreflight: false });
  console.log(`  [SOLANA BROADCAST] ${label} signature: ${signature}`);
  
  await connection.confirmTransaction(signature, 'confirmed');
  return signature;
}

// ----------------------------------------------------
// Agent client class
// ----------------------------------------------------

export class MultiHopperAgent {
  private apiBase: string;
  private apiKey: string;
  private connection: ConnectionInterface;
  private stateStore: AgentStateStore;

  constructor(
    apiBase: string,
    apiKey: string,
    connection: ConnectionInterface,
    stateStore?: AgentStateStore
  ) {
    this.apiBase = apiBase;
    this.apiKey = apiKey;
    this.connection = connection;
    this.stateStore = stateStore || new AgentStateStore();
  }

  private getHeaders(idempotencyKey?: string) {
    const headers: Record<string, string> = {
      'x-api-key': this.apiKey,
      'Content-Type': 'application/json'
    };
    if (idempotencyKey) {
      headers['Idempotency-Key'] = idempotencyKey;
    }
    return headers;
  }

  /**
   * Run a complete transfer.
   */
  public async transfer(params: {
    sourceOwner: string;
    recipientWallet: string;
    amountRaw: string;
    amountTokens: string;
    tokenMint: string;
    tokenDecimals: number;
    tokenSymbol?: string;
    hops?: number;
    arrivalSeconds?: number;
    externalId?: string;
    testScenario?: string; // Passed for mock server controls
  }): Promise<any> {
    const externalId = params.externalId || uuidv4();
    
    // Check local state store first
    const localSigs = this.stateStore.getSignatures(externalId);
    let transferId = localSigs.transferId || '';
    
    if (transferId) {
      console.log(`[AGENT] Found existing transferId in local store: ${transferId} for externalId: ${externalId}. Skipping create.`);
    } else {
      // 1. Create Transfer
      console.log(`[AGENT] 1. Creating transfer with externalId: ${externalId}`);
      try {
        const createResponse = await axios.post(
          `${this.apiBase}/api/v1/transfers`,
          { ...params, externalId },
          { headers: this.getHeaders(uuidv4()) }
        );
        transferId = createResponse.data.id;
        console.log(`[AGENT] Transfer created on server. ID: ${transferId}`);
        // Save initial state with transferId
        this.stateStore.saveSignatures(externalId, { transferId });
      } catch (e: any) {
        if (e.response?.data?.error?.code === 'MH_033') {
          console.log(`[AGENT] Duplicate externalId detected on server. Querying server to resolve existing transferId...`);
          try {
            const listResponse = await axios.get(
              `${this.apiBase}/api/v1/transfers?externalId=${externalId}`,
              { headers: this.getHeaders() }
            );
            const matchingTransfers = listResponse.data.transfers || [];
            if (matchingTransfers.length > 0) {
              transferId = matchingTransfers[0].id;
              console.log(`[AGENT] Resolved existing transferId: ${transferId}`);
              this.stateStore.saveSignatures(externalId, { transferId });
            } else {
              throw new Error(`Server returned duplicate externalId error, but listing returned no matches for externalId: ${externalId}`);
            }
          } catch (listErr: any) {
            console.error('[AGENT] Failed to resolve duplicate externalId:', listErr.message);
            throw listErr;
          }
        } else {
          console.error('[AGENT] Create transfer failed:', e.response?.data || e.message);
          throw e;
        }
      }
    }

    // Helper: confirm-broadcast wrapper
    const confirmBroadcast = async (body: Record<string, any>) => {
      console.log(`[AGENT] Sending confirm-broadcast for ${transferId}...`);
      await axios.post(
        `${this.apiBase}/api/v1/transfers/${transferId}/confirm-broadcast`,
        body,
        { headers: this.getHeaders(uuidv4()) }
      );
    };

    // Load keypair for signing
    const pkBase58 = process.env.SOLANA_PRIVATE_KEY || bs58.encode(Keypair.generate().secretKey);
    const keypair = Keypair.fromSecretKey(bs58.decode(pkBase58));

    let attempts = 0;
    
    // 2. Prepare & sign & broadcast loop
    while (true) {
      if (attempts++ > 3) {
        throw new Error('Too many prepare/broadcast retry attempts');
      }

      console.log(`[AGENT] 2. Preparing transactions (Attempt ${attempts})...`);
      const prepResponse = await axios.post(
        `${this.apiBase}/api/v1/transfers/${transferId}/prepare`,
        {},
        { headers: this.getHeaders(uuidv4()) }
      );

      const preparedTxs: PreparedTxs = prepResponse.data.preparedTxs;

      if (preparedTxs.resume?.nothingToDo) {
        console.log('[AGENT] No more transactions to execute.');
        break;
      }

      // Check if keeper funding has already been done to prevent double funding
      const currentSigs = this.stateStore.getSignatures(externalId);
      
      let keeperFundingSignature = currentSigs.keeperFundingSignature;

      if (preparedTxs.keeperFundingTx) {
        if (keeperFundingSignature) {
          console.warn(`[SAFETY CHECK] Keeper funding tx exists in preparedTxs but was already broadcasted locally! Signature: ${keeperFundingSignature}. Skipping broadcast to prevent double-funding.`);
          // Call confirm-broadcast immediately with the saved signature
          await confirmBroadcast({ routeInitSignatures: [], keeperFundingSignature });
        } else {
          console.log('[AGENT] Signing and broadcasting keeperFundingTx...');
          const signedFundingTx = signVersioned(preparedTxs.keeperFundingTx, keypair);
          keeperFundingSignature = await broadcastAndConfirm(
            this.connection,
            signedFundingTx,
            'keeperFundingTx'
          );
          
          // Save keeper funding signature locally *before* making the API call (safe crash recovery)
          this.stateStore.saveSignatures(externalId, { keeperFundingSignature });
          
          // Confirm immediately to register on server
          await confirmBroadcast({ routeInitSignatures: [], keeperFundingSignature });
        }
      }

      // Route Init Txs
      let routeInitSignatures: string[] = currentSigs.routeInitSignatures || [];
      if (preparedTxs.routeInitTxs && preparedTxs.routeInitTxs.length > 0) {
        if (routeInitSignatures.length > 0) {
          console.log('[AGENT] Using existing routeInitSignatures from local store.');
        } else {
          for (let i = 0; i < preparedTxs.routeInitTxs.length; i++) {
            console.log(`[AGENT] Signing and broadcasting routeInitTxs[${i}]...`);
            const signed = signVersioned(preparedTxs.routeInitTxs[i].base64, keypair);
            const sig = await broadcastAndConfirm(this.connection, signed, `routeInitTxs[${i}]`);
            routeInitSignatures.push(sig);
            
            if (i < preparedTxs.routeInitTxs.length - 1) {
              await new Promise(r => setTimeout(r, 3000)); // sleep 3s to propagate RPC state
            }
          }
          this.stateStore.saveSignatures(externalId, { routeInitSignatures });
          await new Promise(r => setTimeout(r, 3000));
        }
      }

      // Orchestrator Init
      let orchestratorInitSignature = currentSigs.orchestratorInitSignature;
      if (preparedTxs.orchestratorInitTx) {
        if (orchestratorInitSignature) {
          console.log('[AGENT] Using existing orchestratorInitSignature from local store.');
        } else {
          console.log('[AGENT] Signing and broadcasting orchestratorInitTx...');
          const signed = signLegacy(preparedTxs.orchestratorInitTx, keypair);
          orchestratorInitSignature = await broadcastAndConfirm(
            this.connection,
            signed,
            'orchestratorInitTx'
          );
          this.stateStore.saveSignatures(externalId, { orchestratorInitSignature });
          await new Promise(r => setTimeout(r, 3000));
        }
      }

      // Session Init Txs
      let sessionInitSignatures: string[] = currentSigs.sessionInitSignatures || [];
      if (preparedTxs.sessionInitTxs && preparedTxs.sessionInitTxs.length > 0) {
        if (sessionInitSignatures.length > 0) {
          console.log('[AGENT] Using existing sessionInitSignatures from local store.');
        } else {
          for (let i = 0; i < preparedTxs.sessionInitTxs.length; i++) {
            console.log(`[AGENT] Signing and broadcasting sessionInitTxs[${i}]...`);
            const signed = signVersioned(preparedTxs.sessionInitTxs[i], keypair);
            const sig = await broadcastAndConfirm(this.connection, signed, `sessionInitTxs[${i}]`);
            sessionInitSignatures.push(sig);
          }
          this.stateStore.saveSignatures(externalId, { sessionInitSignatures });
        }
      }

      // Submit remaining signatures
      await confirmBroadcast({
        keeperFundingSignature,
        routeInitSignatures,
        orchestratorInitSignature,
        sessionInitSignatures
      });

      if (!preparedTxs.resume?.routeAlreadyDeployed) {
        break;
      }
    }

    // 3. Poll transfer status
    console.log('[AGENT] 3. Starting transfer status monitoring...');
    while (true) {
      const getResponse = await axios.get(`${this.apiBase}/api/v1/transfers/${transferId}`, {
        headers: this.getHeaders()
      });
      const t = getResponse.data.transfer;
      console.log(`[MONITOR] Status: ${t.status} | Phase: ${t.phase} | Progress: ${t.progress.hopsCompleted}/${t.progress.hopsTotal}`);
      
      if (['completed', 'failed', 'expired', 'refunded'].includes(t.status)) {
        // Clear state on completion
        this.stateStore.clear(externalId);
        return t;
      }
      
      await new Promise(r => setTimeout(r, 5000));
    }
  }
}
