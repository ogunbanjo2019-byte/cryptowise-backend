import { createLedgerPool, readInternalBalances } from '../services/postgres-ledger.js';
import { engageSafetyGate, safetyGateStatus } from '../services/safety-gate.js';

const ASSETS = ['ETH', 'USDT'];
function normalize(snapshot = {}) {
  return Object.fromEntries(ASSETS.map((asset) => [asset, BigInt(String(snapshot[asset] ?? '0'))]));
}
function differences(internal, custody, chain) {
  return ASSETS.flatMap((asset) => {
    const values = [internal[asset], custody[asset], chain[asset]];
    return values.every((value) => value === values[0]) ? [] : [{ asset, internal: values[0].toString(), custody: values[1].toString(), chain: values[2].toString() }];
  });
}

export async function sendEmergencyAlert(payload) {
  if (!process.env.ALERT_WEBHOOK_URL) return { sent: false, configured: false };
  const response = await fetch(process.env.ALERT_WEBHOOK_URL, {
    method: 'POST', headers: { 'content-type': 'application/json', ...(process.env.ALERT_WEBHOOK_TOKEN ? { authorization: `Bearer ${process.env.ALERT_WEBHOOK_TOKEN}` } : {}) },
    body: JSON.stringify({ service: 'cryptowise', severity: 'critical', ...payload, safetyGate: safetyGateStatus(), occurredAt: new Date().toISOString() }),
  });
  return { sent: response.ok, configured: true };
}

export async function reconcileOnce({ pool = createLedgerPool(), readCustodyBalances, readChainBalances, alert = sendEmergencyAlert } = {}) {
  if (typeof readCustodyBalances !== 'function' || typeof readChainBalances !== 'function') throw new Error('Custody and chain balance readers are required.');
  const [internalRaw, custodyRaw, chainRaw] = await Promise.all([readInternalBalances(pool), readCustodyBalances(), readChainBalances()]);
  const internal = normalize(internalRaw); const custody = normalize(custodyRaw); const chain = normalize(chainRaw);
  const variance = differences(internal, custody, chain);
  if (variance.length) {
    const gate = engageSafetyGate(`Reconciliation variance detected for ${variance.map((item) => item.asset).join(', ')}.`);
    await alert({ event: 'reconciliation.variance', variance, gate });
    return { ok: false, variance, gate };
  }
  return { ok: true, variance: [], gate: safetyGateStatus() };
}

export function startReconciliation({ intervalMs = Number(process.env.RECONCILIATION_INTERVAL_MS || 60000), ...options } = {}) {
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try { await reconcileOnce(options); } catch (error) { engageSafetyGate(`Reconciliation failed: ${error.message}`); await sendEmergencyAlert({ event: 'reconciliation.failed', error: error.message }).catch(() => {}); } finally { running = false; }
  };
  void run();
  const timer = setInterval(run, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
