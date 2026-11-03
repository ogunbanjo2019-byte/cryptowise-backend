import { ethers } from 'ethers';
import { config } from '../config.js';
import { DEPOSIT_AUTOMATIC_CREDIT_READY, DEPOSIT_CHAIN_VERIFICATION_READY } from './deposit-readiness.js';
export function startDepositMonitor() {
  if (!config.liveFundsEnabled || !DEPOSIT_CHAIN_VERIFICATION_READY || !DEPOSIT_AUTOMATIC_CREDIT_READY) { console.log('Deposit monitor disabled: live funds readiness controls are fail-closed.'); return; }
  // A real implementation must use an idempotent indexer/reconciliation worker with
  // confirmation depth and reorg handling. Do not attach a raw event listener here.
  console.log('Deposit monitor is not started: audited chain indexer is not configured.');
}
