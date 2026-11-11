import { FieldValue } from 'firebase-admin/firestore';
import { db } from '../firebase.js';
import { config } from '../config.js';
import { getFireblocksTransaction } from './fireblocks.js';
import { normalizeCustodyEvent } from './custody.js';
import { settleCustodyWithdrawal } from './ledger.js';
import { sendAlert } from './withdrawal-controls.js';

let timer = null;
let running = false;

function providerEvent(transaction) {
  return normalizeCustodyEvent({
    eventType: 'transaction.status.updated',
    resourceId: transaction.id,
    data: {
      ...transaction,
      type: 'transaction',
      address: transaction.destinationAddress,
      amount: transaction.amountInfo?.amount || transaction.amount,
      asset: transaction.assetId,
    },
  });
}

async function reconcileOnce() {
  if (running || config.custodyProvider !== 'fireblocks' || !config.custodyReconciliationEnabled) return;
  running = true;
  try {
    const snapshot = await db.collection('withdrawalRequests')
      .where('status', 'in', ['submitted', 'broadcasting', 'confirming', 'approved_for_custody'])
      .limit(100)
      .get();
    for (const doc of snapshot.docs) {
      const request = doc.data();
      if (!request.providerTransactionId) continue;
      try {
        const transaction = await getFireblocksTransaction(request.providerTransactionId);
        const event = providerEvent(transaction);
        if (!event) continue;
        if (['completed', 'failed', 'rejected', 'blocked', 'cancelled'].includes(event.status)) {
          await settleCustodyWithdrawal({ withdrawalRef: doc.ref, event, actorUid: 'fireblocks-reconciliation' });
        } else {
          await doc.ref.update({ custodyStatus: event.status, providerStatus: transaction.status, txHash: event.txHash, updatedAt: FieldValue.serverTimestamp() });
        }
      } catch (error) {
        await doc.ref.update({ reconciliationError: error.message, updatedAt: FieldValue.serverTimestamp() });
        await sendAlert('withdrawal.reconciliation_failed', { withdrawalId: doc.id, providerTransactionId: request.providerTransactionId, error: error.message }).catch(() => {});
      }
    }
  } finally {
    running = false;
  }
}

export async function startCustodyReconciliation() {
  if (!config.custodyReconciliationEnabled) {
    console.log('Custody reconciliation disabled.');
    return;
  }
  await reconcileOnce();
  timer = setInterval(reconcileOnce, config.CUSTODY_RECONCILIATION_INTERVAL_MS);
  timer.unref?.();
}

export async function stopCustodyReconciliation() {
  if (timer) clearInterval(timer);
  timer = null;
}

export { reconcileOnce };
