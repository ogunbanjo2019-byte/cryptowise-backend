  import { Router } from 'express';
import { FieldValue } from 'firebase-admin/firestore';
import { db } from '../firebase.js';
import { config } from '../config.js';
import { normalizeCustodyEvent, verifyCustodyWebhook } from '../services/custody.js';
import { settleCustodyWithdrawal } from '../services/ledger.js';
import { sendAlert } from '../services/withdrawal-controls.js';

const router = Router();

router.post('/custody', async (req, res, next) => {
  try {
    const rawBody = req.rawBody || Buffer.from(JSON.stringify(req.body || {}));
    const signature = req.get('Fireblocks-Webhook-Signature') || req.get('X-Custody-Signature') || req.get('X-Fireblocks-Signature') || '';
    if (!await verifyCustodyWebhook(rawBody, signature)) return res.status(401).json({ error: 'Invalid custody webhook signature.' });
    if (!config.custodyEnabled) return res.status(503).json({ error: 'Custody webhooks are disabled.' });

    const event = normalizeCustodyEvent(req.body);
    if (!event) return res.status(400).json({ error: 'Unsupported or invalid custody event.' });
    const eventRef = db.collection('custodyEvents').doc(event.eventId);
    const existing = await eventRef.get();
    if (existing.exists && existing.data()?.processed === true) return res.status(200).json({ received: true, duplicate: true, eventId: event.eventId });

    const withdrawalId = event.externalTxId || null;
    if (withdrawalId) {
      const withdrawalRef = db.collection('withdrawalRequests').doc(withdrawalId);
      const withdrawal = await withdrawalRef.get();
      if (withdrawal.exists) {
        if (!existing.exists) {
          await eventRef.create({ ...event, direction: 'outgoing', processed: false, receivedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(), immutable: true });
        }
        const result = await settleCustodyWithdrawal({ withdrawalRef, event });
        await eventRef.set({ processed: true, processedResult: result.status, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
        if (['failed_released', 'completed'].includes(result.status)) await sendAlert(`withdrawal.custody_${result.status}`, { withdrawalId, providerTransactionId: event.providerTransactionId, txHash: event.txHash });
        return res.status(200).json({ received: true, eventId: event.eventId, status: result.status });
      }
    }

    const matching = await db.collection('depositAddresses').where('address', '==', event.address).limit(2).get();
    const matchedAddress = matching.docs.length === 1 ? { uid: matching.docs[0].id, ...matching.docs[0].data() } : null;
    const status = ['confirmed', 'completed', 'settled'].includes(event.status)
      ? (matchedAddress ? 'confirmed_pending_credit' : 'unattributed')
      : event.status;

    await db.runTransaction(async (tx) => {
      const fresh = await tx.get(eventRef);
      if (fresh.exists && fresh.data()?.processed === true) return;
      if (!fresh.exists) tx.create(eventRef, { ...event, direction: 'incoming', status, matchedUid: matchedAddress?.uid || null, receivedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(), processed: false, immutable: true });
      if (event.txHash) {
        const requestSnap = await tx.get(db.collection('depositRequests').where('txHash', '==', event.txHash).limit(2));
        if (!requestSnap.empty && requestSnap.size === 1) {
          tx.update(requestSnap.docs[0].ref, { custodyEventId: event.eventId, status: status === 'confirmed_pending_credit' ? 'confirmed' : status, observedAmountAtomic: event.amountAtomic, updatedAt: FieldValue.serverTimestamp() });
        }
      }
    });
    await eventRef.set({ processed: true, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    return res.status(202).json({ received: true, eventId: event.eventId, status });
  } catch (error) {
    await sendAlert('custody.webhook_processing_failed', { error: error.message }).catch(() => {});
    return next(error);
  }
});

export default router;
  