import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEPOSIT_AUTOMATIC_CREDIT_READY,
  DEPOSIT_CHAIN_VERIFICATION_READY,
  DEPOSIT_CUSTOMER_INTAKE_READY,
  WITHDRAWAL_CUSTODY_READY,
} from '../src/services/deposit-readiness.js';

test('live deposit capabilities remain fail-closed until an independent verifier is implemented', () => {
  assert.equal(DEPOSIT_CHAIN_VERIFICATION_READY, false);
  assert.equal(DEPOSIT_CUSTOMER_INTAKE_READY, false);
  assert.equal(DEPOSIT_AUTOMATIC_CREDIT_READY, false);
  assert.equal(WITHDRAWAL_CUSTODY_READY, false);
});
