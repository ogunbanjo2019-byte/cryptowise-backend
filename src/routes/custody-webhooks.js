import crypto from 'node:crypto';
import { Router } from 'express';
import { verifyCustodyWebhook } from '../services/custody.js';
import { createLedgerPool, creditDeposit, findWalletOwner, recordSafetyGateAttempt, recordWebhookEvent } from '../services/postgres-ledger.js';
import { isSafetyGateActive } from '../services/safety-gate.js';

const router = Router();
const USDT = '0xdac17f958d2ee523a2206206994597c13d831ec7';
const HASH = /^0x[a-fA-F0-9]{64}$/;
const ADDRESS = /^0x[a-fA-F0-9]{40}$/;
const AMOUNT = /^[1-9][0-9]{0,77}$/;
const pool = () => createLedgerPool();

function verifyHmac(rawBody, supplied) {
  const secret = process.env.CUSTODY_WEBHOOK_SECRET;
  if (!secret || !rawBody || !supplied) return false;
  const signature = String(supplied).replace(/^sha256=/i, '').trim();
  if (!/^[a-f0-9]{64}$/i.test(signature)) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expected, 'hex'));
}

async function verifySignature(rawBody, req) {
  const signature = req.get('Fireblocks-Webhook-Signature') || req.get('X-Custody-Signature') || req.get('X-Fireblocks-Signature') || '';
  if (String(process.env.CUSTODY_PROVIDER || '').toLowerCase() === 'fireblocks') return verifyCustodyWebhook(rawBody, signature);
  return verifyHmac(rawBody, signature);
}

function normalize(payload) {
  const event = payload?.data && typeof payload.data === 'object' ? payload.data : payload;
  const eventId = String(event?.eventId || event?.id || payload?.resourceId || '').trim();
  const status = String(event?.status || event?.state || '').toLowerCase();
  const asset = String(event?.asset || event?.assetId || '').toUpperCase().replace(/_ERC20$/, '').replace(/_TEST\d*$/, '');
  const chainId = Number(event?.chainId || 1);
  const txHash = String(event?.txHash || event?.transactionHash || event?.tx_hash || '').toLowerCase();
  const address = String(event?.address || event?.destinationAddress || event?.toAddress || '').toLowerCase();
  const tokenContract = String(event?.tokenContract || event?.contractAddress || event?.assetContract || '').toLowerCase();
  const amountAtomic = String(event?.amountAtomic || '').trim();
  const customerId = typeof event?.uid === 'string' ? event.uid : null;
  if (!eventId || !['confirmed', 'completed', 'settled'].includes(status) || !['ETH', 'USDT'].includes(asset) || chainId !== 1 || !HASH.test(txHash) || !ADDRESS.test(address) || !AMOUNT.test(amountAtomic)) return null;
  if (asset === 'USDT' && tokenContract !== USDT) return null;
  return { eventId, status, asset, chainId, txHash, address, tokenContract: asset === 'USDT' ? USDT : null, amountAtomic, customerId, raw: payload };
}

router.post('/custody', async (req, res, next) => {
  const rawBody = req.rawBody || Buffer.from(JSON.stringify(req.body || {}));
  try {
    if (!await verifySignature(rawBody, req)) return res.status(401).json({ error: 'Invalid custody webhook signature.' });
    const event = normalize(req.body);
    if (!event) return res.status(400).json({ error: 'Invalid mainnet custody event.' });
    const db = pool();
    try {
      const existing = await db.query('SELECT provider_event_id, status FROM custody_webhook_events WHERE provider_event_id = $1', [event.eventId]);
      if (existing.rowCount) return res.status(200).json({ received: true, duplicate: true, eventId: event.eventId });
      await recordWebhookEvent(db, { providerEventId: event.eventId, txHash: event.txHash, asset: event.asset, chainId: event.chainId, payload: event.raw, status: 'received' });
      const mapping = event.customerId ? { customer_id: event.customerId } : await findWalletOwner(db, { asset: event.asset, address: event.address });
      if (!mapping?.customer_id) {
        await recordSafetyGateAttempt(db, { action: 'unattributed_deposit', reason: 'No unique customer wallet mapping.', providerEventId: event.eventId, txHash: event.txHash, payload: event.raw });
        return res.status(202).json({ received: true, status: 'unattributed', eventId: event.eventId });
      }
      if (isSafetyGateActive()) {
        await recordSafetyGateAttempt(db, { action: 'deposit_credit_blocked', reason: 'Safety gate is active.', providerEventId: event.eventId, txHash: event.txHash, customerId: mapping.customer_id, payload: event.raw });
        return res.status(202).json({ received: true, status: 'blocked_for_review', eventId: event.eventId });
      }
      const result = await creditDeposit(db, { ...event, customerId: mapping.customer_id });
      return res.status(200).json({ received: true, eventId: event.eventId, ...result });
    } finally { await db.end(); }
  } catch (error) { return next(error); }
});

export default router;
