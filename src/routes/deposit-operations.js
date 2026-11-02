import { Router } from 'express';
import { db } from '../firebase.js';
import { config } from '../config.js';
import { requireRole } from '../middleware/auth.js';
import {
  DEPOSIT_AUTOMATIC_CREDIT_READY,
  DEPOSIT_CHAIN_VERIFICATION_READY,
  DEPOSIT_CUSTOMER_INTAKE_READY,
} from '../services/deposit-readiness.js';

const router = Router();
const ACTIVE_QUEUE_STATUSES = new Set([
  'pending_manual_review',
  'awaiting_second_approval',
  'verification_failed',
  'amount_mismatch',
  'stuck',
  'reorg_detected',
]);
const EXCEPTION_STATUSES = new Set([
  'verification_failed',
  'amount_mismatch',
  'stuck',
  'reorg_detected',
]);
const STALE_AFTER_MS = 30 * 60 * 1000;

function millis(value) {
  if (!value) return null;
  if (typeof value.toMillis === 'function') return value.toMillis();
  if (value.seconds) return value.seconds * 1000;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

router.get('/', requireRole('owner', 'admin', 'finance', 'compliance'), async (_req, res, next) => {
  try {
    const snapshot = await db.collection('depositRequests')
      .orderBy('createdAt', 'desc')
      .limit(100)
      .get();
    const now = Date.now();
    const requests = snapshot.docs.map((doc) => {
      const data = doc.data();
      const createdAtMs = millis(data.createdAt);
      const status = String(data.status || 'unknown');
      return {
        id: doc.id,
        uid: data.uid || null,
        asset: data.asset || null,
        txHash: data.txHash || null,
        network: data.network || null,
        status,
        amountAtomic: data.verifiedAmountAtomic || data.reviewedAmountAtomic || null,
        createdAt: data.createdAt || null,
        updatedAt: data.updatedAt || null,
        stale: ACTIVE_QUEUE_STATUSES.has(status) && createdAtMs !== null && now - createdAtMs > STALE_AFTER_MS,
      };
    });

    const active = requests.filter((request) => ACTIVE_QUEUE_STATUSES.has(request.status));
    const exceptionCount = requests.filter((request) => EXCEPTION_STATUSES.has(request.status)).length;
    const staleCount = active.filter((request) => request.stale).length;

    res.json({
      asOf: new Date(now).toISOString(),
      liveFundsFlag: config.liveFundsEnabled,
      customerDepositsEnabled: config.liveFundsEnabled && DEPOSIT_CUSTOMER_INTAKE_READY && DEPOSIT_CHAIN_VERIFICATION_READY && DEPOSIT_AUTOMATIC_CREDIT_READY,
      automaticCreditingEnabled: DEPOSIT_AUTOMATIC_CREDIT_READY,
      chainMonitor: {
        status: DEPOSIT_CHAIN_VERIFICATION_READY ? 'ready' : 'not_implemented',
        networkConfigured: config.CHAIN_MODE,
        lastHeartbeatAt: null,
        confirmationsTracked: false,
        reorgHandling: false,
      },
      reconciliation: { status: 'not_implemented', lastRunAt: null },
      backups: { status: 'not_reported_by_application', lastVerifiedAt: null },
      queue: {
        requestsReturned: requests.length,
        requestWindowLimit: 100,
        activeInReturnedWindow: active.length,
        exceptionsInReturnedWindow: exceptionCount,
        staleOver30MinutesInReturnedWindow: staleCount,
        windowMayBeTruncated: requests.length === 100,
      },
      controls: [
        { key: 'chain_monitor', label: 'Ethereum chain monitor', status: DEPOSIT_CHAIN_VERIFICATION_READY ? 'ready' : 'blocked' },
        { key: 'confirmations_and_reorgs', label: 'Confirmations and reorg recovery', status: 'blocked' },
        { key: 'automatic_crediting', label: 'Duplicate-safe verified crediting', status: DEPOSIT_AUTOMATIC_CREDIT_READY ? 'ready' : 'blocked' },
        { key: 'chain_reconciliation', label: 'On-chain reconciliation', status: 'blocked' },
        { key: 'backup_restore', label: 'Backup and restore verification', status: 'not_reported' },
      ],
      requests,
      notice: 'This is an operational visibility endpoint, not a chain verifier. No request shown here is independently confirmed on Ethereum; do not credit funds from this view.',
    });
  } catch (error) {
    next(error);
  }
});

export default router;
