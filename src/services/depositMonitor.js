import { ethers } from 'ethers';
import { FieldValue } from 'firebase-admin/firestore';
import { db } from '../firebase.js';
import { config } from '../config.js';
import { verifyDepositRequest } from './deposit-verifier.js';

const WATCHED_STATUSES = ['pending_manual_review', 'detected', 'confirming', 'confirmed', 'reorged'];
let provider;
let timer;
let scanRunning = false;

async function scanPendingDepositRequests() {
  if (scanRunning) return;
  scanRunning = true;
  try {
    const snapshot = await db.collection('depositRequests')
      .where('status', 'in', WATCHED_STATUSES)
      .limit(100)
      .get();
    const requests = snapshot.docs.map((doc) => ({ id: doc.id, ref: doc.ref, ...doc.data() }));

    // A submitted hash cannot safely identify a customer when multiple requests claim it.
    // These are flagged for review; no ledger writes are performed by this monitor.
    const byHash = new Map();
    for (const request of requests) {
      const key = String(request.txHash || '').toLowerCase();
      if (!key) continue;
      byHash.set(key, [...(byHash.get(key) || []), request]);
    }

    for (const group of byHash.values()) {
      if (group.length > 1) {
        for (const request of group) {
          await request.ref.update({
            status: 'manual_review',
            statusReason: 'Transaction hash is claimed by more than one deposit request.',
            updatedAt: FieldValue.serverTimestamp(),
          });
        }
        continue;
      }

      const request = group[0];
      try {
        const verification = await verifyDepositRequest(request, provider, config);
        const current = String(request.status || '');
        if (current === verification.status && current !== 'confirming') continue;
        await request.ref.update({
          status: verification.status,
          confirmations: verification.confirmations ?? 0,
          chainId: verification.chainId ?? config.ETH_CHAIN_ID,
          blockNumber: verification.blockNumber ?? null,
          blockHash: verification.blockHash ?? null,
          observedAmountAtomic: verification.observedAmountAtomic ?? null,
          statusReason: verification.reason ?? null,
          verifiedAt: verification.status === 'confirmed' ? FieldValue.serverTimestamp() : null,
          updatedAt: FieldValue.serverTimestamp(),
        });
      } catch (error) {
        // Provider failures are retried on the next scan and never mark a request confirmed.
        console.error(`Deposit monitor lookup failed for request ${request.id}:`, error.message);
      }
    }
  } catch (error) {
    console.error('Deposit monitor scan failed:', error.message);
  } finally {
    scanRunning = false;
  }
}

export async function startDepositMonitor() {
  if (!config.depositMonitorEnabled) {
    console.log('Deposit monitor disabled: set DEPOSIT_MONITOR_ENABLED=true only after reviewing chain settings.');
    return;
  }
  if (![1, 11155111].includes(config.ETH_CHAIN_ID)) {
    throw new Error('Deposit monitor supports Ethereum mainnet or Sepolia only.');
  }
  if (![config.ETH_DEPOSIT_ADDRESS, config.USDT_DEPOSIT_ADDRESS].every(ethers.isAddress)) {
    throw new Error('Deposit monitor requires verified public ETH and USDT receiving addresses.');
  }

  provider = new ethers.JsonRpcProvider(config.RPC_URL, config.ETH_CHAIN_ID, { staticNetwork: true });
  const network = await provider.getNetwork();
  if (Number(network.chainId) !== config.ETH_CHAIN_ID) {
    throw new Error(`Deposit monitor RPC reports chain ID ${network.chainId}; expected ${config.ETH_CHAIN_ID}.`);
  }
  if (config.ETH_CHAIN_ID !== 1 && !config.USDT_TOKEN_CONTRACT) {
    console.warn('USDT requests will remain in manual review until a verified test-network token contract is configured.');
  }

  console.log(`Read-only deposit monitor started for chain ${config.ETH_CHAIN_ID}; requiring ${config.DEPOSIT_CONFIRMATIONS_REQUIRED} confirmations. No ledger credits are performed.`);
  await scanPendingDepositRequests();
  timer = setInterval(scanPendingDepositRequests, config.DEPOSIT_MONITOR_INTERVAL_MS);
  timer.unref?.();
}

export async function stopDepositMonitor() {
  if (timer) clearInterval(timer);
  timer = null;
  if (provider) await provider.destroy();
  provider = null;
}
  