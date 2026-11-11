import { db } from '../firebase.js';
import { config } from '../config.js';
import { validEvmAddress } from './validation.js';

function policyError(message, statusCode = 409) {
  return Object.assign(new Error(message), { statusCode });
}

function maxFor(asset) {
  return BigInt(asset === 'ETH' ? config.WITHDRAWAL_MAX_ETH_ATOMIC : config.WITHDRAWAL_MAX_USDT_ATOMIC);
}

function dailyFor(asset) {
  return BigInt(asset === 'ETH' ? config.WITHDRAWAL_DAILY_LIMIT_ETH_ATOMIC : config.WITHDRAWAL_DAILY_LIMIT_USDT_ATOMIC);
}

function dayKey() {
  return new Date().toISOString().slice(0, 10);
}

export async function enforceWithdrawalPolicy({ uid, asset, amountAtomic, destination, network }) {
  if (config.RECOVERY_MODE === 'freeze_withdrawals') throw policyError('Withdrawals are temporarily frozen while recovery procedures are active.', 503);
  if (!validEvmAddress(destination)) throw policyError('Withdrawal destination is not a valid EVM address.', 400);
  const amount = BigInt(amountAtomic);
  if (amount > maxFor(asset)) throw policyError(`Withdrawal exceeds the ${asset} per-transaction limit.`);

  const existing = await db.collection('withdrawalRequests')
    .where('uid', '==', uid)
    .where('asset', '==', asset)
    .where('velocityDay', '==', dayKey())
    .where('status', 'in', ['pending_review', 'awaiting_second_approval', 'submitted', 'broadcasting', 'confirming', 'completed'])
    .limit(100)
    .get();
  const today = existing.docs.reduce((sum, doc) => sum + BigInt(doc.data().amountAtomic || '0'), 0n);
  if (today + amount > dailyFor(asset)) throw policyError(`Withdrawal exceeds the daily ${asset} velocity limit.`);

  if (config.custodyProvider === 'fireblocks' && config.custodyEnabled && (!config.SCREENING_API_URL || !config.SCREENING_API_TOKEN)) {
    throw policyError('Withdrawal screening is not configured.', 503);
  }
  if (config.SCREENING_API_URL) {
    const response = await fetch(`${config.SCREENING_API_URL.replace(/\/$/, '')}/v1/screen`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: `Bearer ${config.SCREENING_API_TOKEN}` },
      body: JSON.stringify({ uid, asset, amountAtomic, destination, network }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || result.decision !== 'allow') throw policyError(result.reason || 'Withdrawal was not cleared by screening.', 403);
  }
  return { velocityDay: dayKey() };
}

export async function sendAlert(event, details = {}) {
  if (!config.ALERT_WEBHOOK_URL) return { sent: false, configured: false };
  const response = await fetch(config.ALERT_WEBHOOK_URL, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...(config.ALERT_WEBHOOK_TOKEN ? { Authorization: `Bearer ${config.ALERT_WEBHOOK_TOKEN}` } : {}) },
    body: JSON.stringify({ service: 'cryptowise', event, details, occurredAt: new Date().toISOString() }),
  });
  return { sent: response.ok, configured: true };
}
  