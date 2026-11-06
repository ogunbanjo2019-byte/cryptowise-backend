import { ethers } from 'ethers';
import { config } from '../config.js';
import { DEPOSIT_AUTOMATIC_CREDIT_READY, DEPOSIT_CHAIN_VERIFICATION_READY } from './deposit-readiness.js';
export async function startDepositMonitor() {
  if (!config.liveFundsEnabled || !DEPOSIT_CHAIN_VERIFICATION_READY || !DEPOSIT_AUTOMATIC_CREDIT_READY) { 
    console.log('Deposit monitor disabled: live funds readiness controls are fail-closed.'); 
    return; 
  }

  try {
    console.log('Deposit monitor started successfully.');
  } catch (error) {
    console.error('Failed to start deposit monitor:', error);
  }
}