import { fileURLToPath } from 'node:url';
import { createLedgerPool } from '../services/postgres-ledger.js';
import { startReconciliation } from './reconciliation.js';

function makeReader(urlEnv, tokenEnv) {
  const url = process.env[urlEnv];
  if (!url) throw new Error(`${urlEnv} is required when reconciliation is enabled.`);
  return async () => {
    const response = await fetch(url, {
      headers: { accept: 'application/json', ...(process.env[tokenEnv] ? { authorization: `Bearer ${process.env[tokenEnv]}` } : {}) },
    });
    if (!response.ok) throw new Error(`${urlEnv} returned HTTP ${response.status}.`);
    const data = await response.json();
    return data.balances || data;
  };
}

export function startConfiguredReconciliation() {
  if (String(process.env.RECONCILIATION_ENABLED || 'false').toLowerCase() !== 'true') {
    console.log('Reconciliation runner disabled.');
    return () => {};
  }
  const pool = createLedgerPool();
  return startReconciliation({
    pool,
    readCustodyBalances: makeReader('CUSTODY_BALANCES_URL', 'CUSTODY_BALANCES_TOKEN'),
    readChainBalances: makeReader('CHAIN_BALANCES_URL', 'CHAIN_BALANCES_TOKEN'),
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  startConfiguredReconciliation();
}
