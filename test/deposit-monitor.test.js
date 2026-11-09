import test from 'node:test';
import assert from 'node:assert/strict';
import { ethers } from 'ethers';
import { verifyDepositRequest } from '../src/services/deposit-verifier.js';

const hash = `0x${'a'.repeat(64)}`;
const recipient = `0x${'1'.repeat(40)}`;
const sender = `0x${'2'.repeat(40)}`;
const token = `0x${'3'.repeat(40)}`;
const blockHash = `0x${'b'.repeat(64)}`;
const baseSettings = {
  ETH_CHAIN_ID: 11155111,
  ETH_DEPOSIT_ADDRESS: recipient,
  USDT_DEPOSIT_ADDRESS: recipient,
  USDT_TOKEN_CONTRACT: token,
  DEPOSIT_CONFIRMATIONS_REQUIRED: 12,
};

function fakeProvider({ transaction = null, receipt = null, chainId = 11155111, latestBlock = 111 } = {}) {
  return {
    getTransaction: async () => transaction,
    getTransactionReceipt: async () => receipt,
    getNetwork: async () => ({ chainId: BigInt(chainId) }),
    getBlock: async () => ({ hash: blockHash }),
    getBlockNumber: async () => latestBlock,
  };
}

function request(asset = 'ETH', extra = {}) {
  return { asset, txHash: hash, network: 'ethereum-testnet', ...extra };
}

test('valid ETH transfer becomes confirmed only at configured confirmation depth', async () => {
  const provider = fakeProvider({
    transaction: { to: recipient, value: 100n, chainId: 11155111 },
    receipt: { status: 1, blockNumber: 100, blockHash, logs: [] },
  });
  const result = await verifyDepositRequest(request('ETH'), provider, baseSettings);
  assert.equal(result.status, 'confirmed');
  assert.equal(result.confirmations, 12);
  assert.equal(result.observedAmountAtomic, '100');
});

test('valid ETH transfer remains confirming below required finality depth', async () => {
  const provider = fakeProvider({
    transaction: { to: recipient, value: 100n, chainId: 11155111 },
    receipt: { status: 1, blockNumber: 105, blockHash, logs: [] },
  });
  const result = await verifyDepositRequest(request('ETH'), provider, baseSettings);
  assert.equal(result.status, 'confirming');
  assert.equal(result.confirmations, 7);
});

test('pending, failed, wrong-recipient and wrong-network requests are not confirmed', async () => {
  const absent = await verifyDepositRequest(request('ETH'), fakeProvider(), baseSettings);
  assert.equal(absent.status, 'pending_manual_review');
  const failed = await verifyDepositRequest(request('ETH'), fakeProvider({
    transaction: { to: recipient, value: 1n, chainId: 11155111 },
    receipt: { status: 0, blockNumber: 100, blockHash, logs: [] },
  }), baseSettings);
  assert.equal(failed.status, 'failed');
  const wrongRecipient = await verifyDepositRequest(request('ETH'), fakeProvider({
    transaction: { to: sender, value: 1n, chainId: 11155111 },
    receipt: { status: 1, blockNumber: 100, blockHash, logs: [] },
  }), baseSettings);
  assert.equal(wrongRecipient.status, 'manual_review');
  const wrongNetwork = await verifyDepositRequest(request('ETH', { network: 'ethereum' }), fakeProvider(), baseSettings);
  assert.equal(wrongNetwork.status, 'manual_review');
});

test('USDT verification requires a Transfer from the configured token to the configured receiver', async () => {
  const iface = new ethers.Interface(['event Transfer(address indexed from, address indexed to, uint256 value)']);
  const encoded = iface.encodeEventLog(iface.getEvent('Transfer'), [sender, recipient, 5000000n]);
  const provider = fakeProvider({
    transaction: { to: token, value: 0n, chainId: 11155111 },
    receipt: {
      status: 1,
      blockNumber: 100,
      blockHash,
      logs: [{ address: token, blockHash, topics: encoded.topics, data: encoded.data }],
    },
  });
  const result = await verifyDepositRequest(request('USDT'), provider, baseSettings);
  assert.equal(result.status, 'confirmed');
  assert.equal(result.observedAmountAtomic, '5000000');
});

test('non-canonical receipt block is marked reorged, not confirmed', async () => {
  const provider = fakeProvider({
    transaction: { to: recipient, value: 100n, chainId: 11155111 },
    receipt: { status: 1, blockNumber: 100, blockHash, logs: [] },
  });
  provider.getBlock = async () => ({ hash: `0x${'c'.repeat(64)}` });
  const result = await verifyDepositRequest(request('ETH'), provider, baseSettings);
  assert.equal(result.status, 'reorged');
});
