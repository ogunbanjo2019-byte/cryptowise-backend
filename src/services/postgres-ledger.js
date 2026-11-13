import pg from 'pg';
import { isSafetyGateActive } from './safety-gate.js';

const { Pool } = pg;
const MAINNET_CHAIN_ID = 1;
const ASSETS = new Set(['ETH', 'USDT']);
const TX_HASH = /^0x[a-fA-F0-9]{64}$/;
const ADDRESS = /^0x[a-fA-F0-9]{40}$/;
const ATOMIC = /^[1-9][0-9]{0,77}$/;

export function createLedgerPool({ connectionString = process.env.DATABASE_URL } = {}) {
  if (!connectionString) throw new Error('DATABASE_URL is required for the PostgreSQL ledger.');
  return new Pool({
    connectionString,
    max: Number(process.env.PG_POOL_MAX || 10),
    connectionTimeoutMillis: Number(process.env.PG_CONNECTION_TIMEOUT_MS || 5000),
    ssl: String(process.env.PGSSL || '').toLowerCase() === 'true' ? { rejectUnauthorized: true } : undefined,
  });
}

function assertDeposit(input) {
  if (!input || typeof input !== 'object') throw new Error('Deposit is required.');
  if (!ASSETS.has(input.asset)) throw new Error('Only ETH and USDT are supported.');
  if (Number(input.chainId) !== MAINNET_CHAIN_ID) throw new Error('Only Ethereum mainnet deposits are supported.');
  if (!TX_HASH.test(String(input.txHash || ''))) throw new Error('A valid Ethereum transaction hash is required.');
  if (!ATOMIC.test(String(input.amountAtomic || ''))) throw new Error('A positive atomic amount is required.');
  if (!input.customerId || !input.providerEventId) throw new Error('Customer and provider event identifiers are required.');
}

export async function recordSafetyGateAttempt(pool, { action, reason, providerEventId = null, txHash = null, customerId = null, payload = null }) {
  await pool.query(
    `INSERT INTO safety_gate_events (action, reason, provider_event_id, tx_hash, customer_id, payload)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
    [action, reason, providerEventId, txHash, customerId, JSON.stringify(payload || {})],
  );
}

export async function upsertWalletMapping(pool, mapping) {
  const { customerId, asset, network, chainId, address, tokenContract = null, provider, providerReference } = mapping;
  if (!customerId || !ASSETS.has(asset) || network !== 'ethereum' || Number(chainId) !== MAINNET_CHAIN_ID || !ADDRESS.test(address) || !provider || !providerReference) {
    throw new Error('Invalid mainnet wallet mapping.');
  }
  if (asset === 'USDT' && String(tokenContract || '').toLowerCase() !== '0xdac17f958d2ee523a2206206994597c13d831ec7') {
    throw new Error('USDT wallet mappings must use the official Ethereum USDT contract.');
  }
  const result = await pool.query(
    `INSERT INTO wallet_mappings
      (customer_id, asset, network, chain_id, address, token_contract, provider, provider_reference)
     VALUES ($1, $2, $3, $4, lower($5), $6, $7, $8)
     ON CONFLICT (customer_id, asset, network) DO UPDATE SET
       address = EXCLUDED.address, token_contract = EXCLUDED.token_contract,
       provider = EXCLUDED.provider, provider_reference = EXCLUDED.provider_reference
     RETURNING *`,
    [customerId, asset, network, MAINNET_CHAIN_ID, address, tokenContract, provider, providerReference],
  );
  return result.rows[0];
}

export async function findWalletOwner(pool, { asset, network = 'ethereum', address }) {
  const result = await pool.query(
    `SELECT customer_id, asset, network, chain_id, address, token_contract, provider, provider_reference
       FROM wallet_mappings WHERE asset = $1 AND network = $2 AND lower(address) = lower($3) LIMIT 2`,
    [asset, network, address],
  );
  return result.rows.length === 1 ? result.rows[0] : null;
}

export async function recordWebhookEvent(pool, { providerEventId, txHash, asset, chainId, payload, status }) {
  const result = await pool.query(
    `INSERT INTO custody_webhook_events
      (provider_event_id, tx_hash, asset, chain_id, payload, status, processed_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, CASE WHEN $6 = 'processed' THEN now() ELSE NULL END)
     ON CONFLICT (provider_event_id) DO UPDATE SET status = EXCLUDED.status
     RETURNING provider_event_id, status`,
    [providerEventId, txHash, asset, chainId, JSON.stringify(payload || {}), status],
  );
  return result.rows[0];
}

export async function creditDeposit(pool, deposit) {
  assertDeposit(deposit);
  if (isSafetyGateActive()) {
    await recordSafetyGateAttempt(pool, {
      action: 'deposit_credit_blocked',
      reason: 'Safety gate is active.',
      providerEventId: deposit.providerEventId,
      txHash: deposit.txHash,
      customerId: deposit.customerId,
      payload: deposit,
    });
    return { credited: false, blocked: true, reason: 'Safety gate is active.' };
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const inserted = await client.query(
      `INSERT INTO ledger_transactions
        (customer_id, asset, chain_id, tx_hash, provider_event_id, amount_atomic, transaction_type)
       VALUES ($1, $2, $3, lower($4), $5, $6::numeric, 'deposit')
       ON CONFLICT DO NOTHING RETURNING id`,
      [deposit.customerId, deposit.asset, MAINNET_CHAIN_ID, deposit.txHash, deposit.providerEventId, deposit.amountAtomic],
    );
    if (inserted.rowCount === 0) {
      await client.query('ROLLBACK');
      return { credited: false, duplicate: true };
    }
    const transactionId = inserted.rows[0].id;
    await client.query(
      `INSERT INTO customer_balances (customer_id, asset, available_atomic)
       VALUES ($1, $2, $3::numeric)
       ON CONFLICT (customer_id, asset) DO UPDATE SET
         available_atomic = customer_balances.available_atomic + EXCLUDED.available_atomic,
         updated_at = now()`,
      [deposit.customerId, deposit.asset, deposit.amountAtomic],
    );
    await client.query(
      `INSERT INTO ledger_postings (transaction_id, account_code, direction, amount_atomic)
       VALUES ($1, $2, 'debit', $3::numeric), ($1, $4, 'credit', $3::numeric)`,
      [transactionId, `custody:${deposit.asset}`, deposit.amountAtomic, `customer:${deposit.customerId}:${deposit.asset}`],
    );
    await client.query(
      `UPDATE custody_webhook_events SET status = 'processed', processed_at = now() WHERE provider_event_id = $1`,
      [deposit.providerEventId],
    );
    await client.query('COMMIT');
    return { credited: true, duplicate: false, transactionId };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function readInternalBalances(pool) {
  const result = await pool.query(
    `SELECT asset, COALESCE(SUM(available_atomic), 0)::text AS amount_atomic
       FROM customer_balances GROUP BY asset`,
  );
  return Object.fromEntries(result.rows.map((row) => [row.asset, row.amount_atomic]));
}
