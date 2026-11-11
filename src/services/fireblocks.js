import crypto from 'node:crypto';
import { config } from '../config.js';

let jwksCache = { expiresAt: 0, keys: new Map() };

function error(message, statusCode = 503) {
  return Object.assign(new Error(message), { statusCode });
}

function base64url(value) {
  return Buffer.from(value).toString('base64url');
}

function signJwt(uri, body) {
  if (!config.FIREBLOCKS_API_KEY || !config.FIREBLOCKS_SECRET_KEY) throw error('Fireblocks server credentials are not configured.');
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64url(JSON.stringify({
    uri,
    nonce: crypto.randomUUID(),
    iat: now,
    exp: now + 25,
    sub: config.FIREBLOCKS_API_KEY,
    bodyHash: crypto.createHash('sha256').update(body).digest('hex'),
  }));
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(`${header}.${payload}`);
  return `${header}.${payload}.${signer.sign(config.FIREBLOCKS_SECRET_KEY, 'base64url')}`;
}

async function fireblocksRequest(path, { method = 'GET', body = {}, idempotencyKey = null } = {}) {
  const rawBody = method === 'GET' ? '' : JSON.stringify(body);
  const uri = `${new URL(config.FIREBLOCKS_API_BASE_URL).pathname.replace(/\/$/, '')}${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.CUSTODY_REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${config.FIREBLOCKS_API_BASE_URL.replace(/\/$/, '')}${path}`, {
      method,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'X-API-Key': config.FIREBLOCKS_API_KEY,
        ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
        Authorization: `Bearer ${signJwt(uri, rawBody)}`,
      },
      body: method === 'GET' ? undefined : rawBody,
      signal: controller.signal,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw error(data.message || data.error || `Fireblocks request failed (${response.status}).`, response.status >= 400 && response.status < 500 ? response.status : 502);
    return data;
  } finally {
    clearTimeout(timer);
  }
}

function assetId(asset) {
  if (asset === 'ETH') return config.FIREBLOCKS_ETH_ASSET_ID;
  if (asset === 'USDT') return config.FIREBLOCKS_USDT_ASSET_ID;
  throw error('Unsupported Fireblocks asset.', 400);
}

export async function createFireblocksDepositAddress({ uid, asset }) {
  const { db } = await import('../firebase.js');
  const mappingRef = db.collection('custodyDepositAddresses').doc(crypto.createHash('sha256').update(`${uid}:${asset}`).digest('hex'));
  const existing = await mappingRef.get();
  if (existing.exists) return existing.data();
  const vaultId = config.FIREBLOCKS_DEPOSIT_VAULT_ACCOUNT_ID || config.FIREBLOCKS_SOURCE_VAULT_ACCOUNT_ID;
  if (!vaultId) throw error('Fireblocks deposit vault account is not configured.');
  const account = await fireblocksRequest('/vault/accounts', {
    method: 'POST',
    body: { name: `cw-${crypto.createHash('sha256').update(uid).digest('hex').slice(0, 20)}`, hiddenOnUi: true },
    idempotencyKey: `deposit-account:${crypto.createHash('sha256').update(`${uid}:${asset}`).digest('hex')}`,
  });
  const wallet = await fireblocksRequest(`/vault/accounts/${encodeURIComponent(account.id)}/${encodeURIComponent(assetId(asset))}`, { method: 'POST', body: {} });
  const result = { uid, address: wallet.address, asset, network: config.CHAIN_MODE === 'mainnet' ? 'ethereum' : 'ethereum-testnet', chainId: config.ETH_CHAIN_ID, provider: 'fireblocks', providerAccountId: account.id };
  await mappingRef.create(result).catch(async (writeError) => {
    if (writeError.code !== 6 && writeError.code !== 5) throw writeError;
  });
  return result;
}

export async function createFireblocksWithdrawal({ requestId, asset, amountAtomic, destination }) {
  const amount = atomicToDecimal(amountAtomic, asset === 'ETH' ? 18 : 6);
  if (!amount) throw error('Invalid withdrawal amount.', 400);
  const response = await fireblocksRequest('/transactions', {
    method: 'POST',
    body: {
      externalTxId: requestId,
      operation: 'TRANSFER',
      source: { type: 'VAULT_ACCOUNT', id: config.FIREBLOCKS_SOURCE_VAULT_ACCOUNT_ID },
      destination: { type: 'ONE_TIME_ADDRESS', oneTimeAddress: { address: destination } },
      assetId: assetId(asset),
      amount,
      note: `CryptoWise withdrawal ${requestId}`,
    },
  });
  return { provider: 'fireblocks', providerTransactionId: response.id, externalTxId: requestId, status: response.status || 'SUBMITTED' };
}

export async function getFireblocksTransaction(transactionId) {
  if (!transactionId) throw error('Fireblocks transaction ID is required.', 400);
  return fireblocksRequest(`/transactions/${encodeURIComponent(transactionId)}`);
}

async function loadJwks(force = false) {
  if (!force && jwksCache.expiresAt > Date.now() && jwksCache.keys.size) return jwksCache.keys;
  const response = await fetch(config.FIREBLOCKS_JWKS_URL, { headers: { Accept: 'application/json' } });
  if (!response.ok) throw error(`Fireblocks JWKS request failed (${response.status}).`, 502);
  const data = await response.json();
  const keys = new Map((data.keys || []).map((key) => [key.kid, key]));
  jwksCache = { keys, expiresAt: Date.now() + 60 * 60 * 1000 };
  return keys;
}

export async function verifyFireblocksWebhook(rawBody, detachedJws) {
  if (!rawBody || typeof detachedJws !== 'string') return false;
  const parts = detachedJws.split('.');
  if (parts.length !== 3 || !parts[0] || parts[1] !== '' || !parts[2]) return false;
  try {
    const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    const keys = await loadJwks();
    let jwk = keys.get(header.kid);
    if (!jwk) { jwk = (await loadJwks(true)).get(header.kid); }
    if (!jwk || jwk.alg !== 'RS512') return false;
    const publicKey = crypto.createPublicKey({ key: jwk, format: 'jwk' });
    const verifier = crypto.createVerify('RSA-SHA512');
    verifier.update(`${parts[0]}.${Buffer.from(rawBody).toString('base64url')}`);
    return verifier.verify(publicKey, Buffer.from(parts[2], 'base64url'));
  } catch {
    return false;
  }
}

export function fireblocksAssetId(asset) { return assetId(asset); }

function atomicToDecimal(value, decimals) {
  if (!/^[1-9][0-9]{0,77}$/.test(String(value))) return null;
  const digits = String(value).padStart(decimals + 1, '0');
  const split = digits.length - decimals;
  const whole = digits.slice(0, split);
  const fraction = digits.slice(split).replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole;
}
