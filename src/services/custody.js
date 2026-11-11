import crypto from 'node:crypto';
import { config } from '../config.js';
import { createFireblocksDepositAddress, createFireblocksWithdrawal, verifyFireblocksWebhook } from './fireblocks.js';

const PROVIDERS = new Set(['disabled', 'fireblocks', 'bitgo', 'gateway']);

function custodyError(message, statusCode = 503) {
  return Object.assign(new Error(message), { statusCode });
}

export function custodyStatus() {
  const configured = config.custodyProvider === 'fireblocks'
    ? Boolean(config.FIREBLOCKS_API_KEY && config.FIREBLOCKS_SECRET_KEY && config.FIREBLOCKS_SOURCE_VAULT_ACCOUNT_ID)
    : config.custodyProvider !== 'disabled' && Boolean(config.CUSTODY_API_URL) && Boolean(config.CUSTODY_API_TOKEN);
  return {
    provider: config.custodyProvider,
    enabled: config.custodyEnabled && configured,
    configured,
    webhookConfigured: config.custodyProvider === 'fireblocks' ? Boolean(config.FIREBLOCKS_JWKS_URL) : Boolean(config.CUSTODY_WEBHOOK_SECRET),
    withdrawalsEnabled: config.custodyWithdrawalsEnabled,
  };
}

export function assertCustodyConfigured() {
  const status = custodyStatus();
  if (!config.custodyEnabled || !status.configured) {
    throw custodyError('MPC custody is not configured. Keep customer deposits and withdrawals disabled.');
  }
  if (!PROVIDERS.has(config.custodyProvider) || config.custodyProvider === 'disabled') {
    throw custodyError('A supported MPC custody provider must be configured.');
  }
}

function custodyHeaders(idempotencyKey) {
  return {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    Authorization: `Bearer ${config.CUSTODY_API_TOKEN}`,
    ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
  };
}

async function custodyRequest(path, { method = 'GET', body, idempotencyKey } = {}) {
  assertCustodyConfigured();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.CUSTODY_REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${config.CUSTODY_API_URL.replace(/\/$/, '')}${path}`, {
      method,
      headers: custodyHeaders(idempotencyKey),
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw custodyError(data.error || data.message || `Custody provider request failed (${response.status}).`, response.status >= 400 && response.status < 500 ? response.status : 502);
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

// The API URL points to the provider adapter/gateway owned by the company.
// It prevents provider-specific signing code and secrets from entering this app.
export async function getDepositAddress({ uid, asset, network }) {
  if (!uid || !['ETH', 'USDT'].includes(asset)) throw custodyError('Invalid custody address request.', 400);
  if (config.custodyProvider === 'fireblocks') { assertCustodyConfigured(); return createFireblocksDepositAddress({ uid, asset, network }); }
  return custodyRequest(`/v1/deposit-addresses/${encodeURIComponent(uid)}`, {
    method: 'POST',
    body: { asset, network },
    idempotencyKey: `deposit-address:${uid}:${asset}:${network}`,
  });
}

export async function submitWithdrawal({ requestId, uid, asset, amountAtomic, destination, network, chainId }) {
  if (!requestId || !uid || !['ETH', 'USDT'].includes(asset)) throw custodyError('Invalid custody withdrawal request.', 400);
  if (config.custodyProvider === 'fireblocks') { assertCustodyConfigured(); return createFireblocksWithdrawal({ requestId, uid, asset, amountAtomic, destination, network, chainId }); }
  return custodyRequest('/v1/withdrawals', {
    method: 'POST',
    body: { requestId, uid, asset, amountAtomic, destination, network, chainId },
    idempotencyKey: `withdrawal:${requestId}`,
  });
}

export function verifyCustodyWebhook(rawBody, signature) {
  if (config.custodyProvider === 'fireblocks') return verifyFireblocksWebhook(rawBody, signature);
  if (!config.CUSTODY_WEBHOOK_SECRET || !rawBody || typeof signature !== 'string') return false;
  const supplied = signature.replace(/^sha256=/i, '').trim();
  if (!/^[a-f0-9]{64}$/i.test(supplied)) return false;
  const expected = crypto.createHmac('sha256', config.CUSTODY_WEBHOOK_SECRET).update(rawBody).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(supplied, 'hex'), Buffer.from(expected, 'hex'));
}

export function normalizeCustodyEvent(payload) {
  const event = payload?.data && typeof payload.data === 'object' ? payload.data : payload;
  const id = String(event?.id || event?.eventId || payload?.resourceId || event?.txHash || '').trim();
  const status = String(event?.status || event?.state || '').toLowerCase();
  const eventType = String(payload?.type || payload?.eventType || event?.type || 'transaction').toLowerCase();
  if (!id || !['deposit', 'transaction', 'transfer'].includes(eventType) && !eventType.startsWith('transaction.')) return null;
  if (!['confirmed', 'completed', 'settled', 'failed', 'reorged', 'pending', 'submitted', 'broadcasting', 'confirming', 'rejected', 'blocked', 'cancelled'].includes(status)) return null;
  const asset = String(event.asset || event.assetId || '').toUpperCase().replace(/_TEST\d*$/, '').replace(/_ERC20$/, '');
  const decimals = asset === 'USDT' ? 6 : 18;
  const atomicAmount = event.amountAtomic === undefined ? null : String(event.amountAtomic).trim();
  const rawAmount = String(event.amountInfo?.amount || event.amount || '').trim();
  const amountAtomic = atomicAmount || (/^\d+(\.\d+)?$/.test(rawAmount) ? decimalToAtomic(rawAmount, decimals) : rawAmount);
  const address = String(event.address || event.destinationAddress || event.destination?.oneTimeAddress?.address || event.toAddress || '').trim();
  const txHash = String(event.txHash || event.tx_hash || event.transactionHash || '').trim();
  if (!['ETH', 'USDT'].includes(asset) || !/^[1-9][0-9]{0,77}$/.test(amountAtomic) || !/^0x[a-fA-F0-9]{40}$/.test(address)) return null;
  return {
    eventId: id,
    status,
    asset,
    amountAtomic,
    address: address.toLowerCase(),
    txHash: /^0x[a-fA-F0-9]{64}$/.test(txHash) ? txHash.toLowerCase() : null,
    providerTransactionId: String(event.id || payload?.resourceId || id),
    externalTxId: event.externalTxId || null,
    uid: typeof event.uid === 'string' ? event.uid : null,
    network: event.network || null,
    chainId: Number.isInteger(Number(event.chainId)) ? Number(event.chainId) : null,
    provider: config.custodyProvider,
  };
}

function decimalToAtomic(value, decimals) {
  const [whole, fraction = ''] = value.split('.');
  if (fraction.length > decimals) return '';
  return `${whole}${fraction.padEnd(decimals, '0')}`.replace(/^0+(?=\d)/, '') || '0';
}
