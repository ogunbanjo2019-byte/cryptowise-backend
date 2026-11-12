import { FieldValue } from 'firebase-admin/firestore';
import { db } from '../firebase.js';
import { validAtomic, validEvmAddress, validTxHash } from './validation.js';
import { config } from '../config.js';
import { deriveDepositAddressFromXpub } from './xpub-derivation.js';

export const ASSET_DECIMALS = Object.freeze({ ETH: 18, USDT: 6 });
export const zeroBalances = () => ({ ETH: '0', USDT: '0' });
export function accountRef(uid) { return db.collection('accounts').doc(uid); }
export function userLedgerRef(uid) { return db.collection('users').doc(uid).collection('ledger'); }

export async function creditDeposit({ depositRef, reviewerUid, amountAtomic, txHash }) {
  return db.runTransaction(async tx => {
    const snap = await tx.get(depositRef);
    if (!snap.exists) throw Object.assign(new Error('Deposit request not found.'), { statusCode: 404 });
    const d = snap.data();
    if (d.status !== 'awaiting_second_approval') throw Object.assign(new Error('Deposit is not awaiting second approval.'), { statusCode: 409 });
    if (d.reviewedBy === reviewerUid) throw Object.assign(new Error('A different authorized reviewer must approve this credit.'), { statusCode: 403 });
    if (d.asset !== 'ETH' && d.asset !== 'USDT') throw Object.assign(new Error('Unsupported asset.'), { statusCode: 400 });
    if (!validAtomic(amountAtomic) || amountAtomic !== d.reviewedAmountAtomic) throw Object.assign(new Error('Amount must match the first reviewer’s recorded amount.'), { statusCode: 400 });
    const account = accountRef(d.uid), accountSnap = await tx.get(account), old = accountSnap.exists ? accountSnap.data() : {};
    const balances = { ...zeroBalances(), ...(old.availableAtomic || {}) };
    const next = (BigInt(balances[d.asset] || '0') + BigInt(amountAtomic)).toString();
    const ledger = userLedgerRef(d.uid).doc(`deposit_${depositRef.id}`);
    const ledgerSnap = await tx.get(ledger);
    if (ledgerSnap.exists) throw Object.assign(new Error('This deposit was already credited.'), { statusCode: 409 });
    tx.set(account, { uid: d.uid, availableAtomic: { ...balances, [d.asset]: next }, reservedAtomic: { ...zeroBalances(), ...(old.reservedAtomic || {}) }, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    tx.create(ledger, { kind: 'deposit_credit', asset: d.asset, amountAtomic, referenceId: depositRef.id, txHash, createdAt: FieldValue.serverTimestamp(), createdBy: reviewerUid, immutable: true });
    tx.update(depositRef, { status: 'credited', creditedBy: reviewerUid, creditedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
    tx.create(db.collection('auditLogs').doc(), { actorUid: reviewerUid, action: 'deposit.credited', resourceId: depositRef.id, resourceType: 'deposit', createdAt: FieldValue.serverTimestamp(), amountAtomic, asset: d.asset });
    return { uid: d.uid, asset: d.asset, amountAtomic };
  });
}

/** Test balances only: Sepolia, non-production, explicit opt-in, and atomic deduplication. */
export async function creditConfirmedTestnetDeposit({ depositRef }) {
  if (!config.depositTestnetAutoCreditEnabled || config.NODE_ENV === 'production' ||
      config.CHAIN_MODE !== 'testnet' || config.ETH_CHAIN_ID !== 11155111 || config.liveFundsEnabled) {
    throw Object.assign(new Error('Automatic deposit crediting is available only for explicitly enabled non-production Sepolia tests.'), { statusCode: 503 });
  }

  return db.runTransaction(async (tx) => {
    const requestSnap = await tx.get(depositRef);
    if (!requestSnap.exists) throw Object.assign(new Error('Deposit request not found.'), { statusCode: 404 });
    const request = requestSnap.data();
    if (request.status === 'credited') return { idempotent: true, uid: request.uid, asset: request.asset };
    if (request.status !== 'confirmed' || request.chainId !== 11155111 || request.network !== 'ethereum-testnet' ||
        typeof request.uid !== 'string' || !Number.isInteger(request.depositAddressIndex)) {
      throw Object.assign(new Error('Only a confirmed Sepolia deposit can be test-credited.'), { statusCode: 409 });
    }
    if (!['ETH', 'USDT'].includes(request.asset) || !validTxHash(request.txHash) ||
        !validAtomic(request.observedAmountAtomic) || !validEvmAddress(request.depositAddress)) {
      throw Object.assign(new Error('Confirmed test deposit data failed validation.'), { statusCode: 400 });
    }

    const normalizedHash = request.txHash.toLowerCase();
    const eventId = `sepolia_${request.asset.toLowerCase()}_${normalizedHash}`;
    const eventRef = db.collection('depositEvents').doc(eventId);
    const ledgerRef = userLedgerRef(request.uid).doc(`deposit_${eventId}`);
    const account = accountRef(request.uid);
    const assignedAddressRef = db.collection('depositAddresses').doc(request.uid);
    const [eventSnap, ledgerSnap, accountSnap, assignedAddressSnap] = await Promise.all([
      tx.get(eventRef), tx.get(ledgerRef), tx.get(account), tx.get(assignedAddressRef),
    ]);
    if (eventSnap.exists || ledgerSnap.exists) {
      throw Object.assign(new Error('This chain event has already been credited or requires reconciliation.'), { statusCode: 409 });
    }
    const assignedAddress = assignedAddressSnap.exists ? assignedAddressSnap.data() : null;
    const derivedAddress = assignedAddress && Number.isInteger(assignedAddress.index)
      ? deriveDepositAddressFromXpub(config.DEPOSIT_XPUB, assignedAddress.index)
      : null;
    if (!assignedAddress || assignedAddress.uid !== request.uid ||
        assignedAddress.chainId !== 11155111 || assignedAddress.index !== request.depositAddressIndex ||
        typeof assignedAddress.address !== 'string' || !derivedAddress ||
        derivedAddress.toLowerCase() !== assignedAddress.address.toLowerCase() ||
        derivedAddress.toLowerCase() !== String(request.depositAddress).toLowerCase()) {
      throw Object.assign(new Error('Confirmed test deposit is not bound to the user’s verified derived address.'), { statusCode: 409 });
    }

    const old = accountSnap.exists ? accountSnap.data() : {};
    const balances = { ...zeroBalances(), ...(old.availableAtomic || {}) };
    const amountAtomic = request.observedAmountAtomic;
    const nextBalance = (BigInt(balances[request.asset] || '0') + BigInt(amountAtomic)).toString();
    tx.set(account, {
      uid: request.uid,
      availableAtomic: { ...balances, [request.asset]: nextBalance },
      reservedAtomic: { ...zeroBalances(), ...(old.reservedAtomic || {}) },
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    tx.create(eventRef, {
      uid: request.uid,
      requestId: depositRef.id,
      chainId: 11155111,
      network: 'ethereum-testnet',
      asset: request.asset,
      txHash: normalizedHash,
      depositAddress: request.depositAddress,
      amountAtomic,
      blockNumber: request.blockNumber,
      blockHash: request.blockHash,
      status: 'credited_testnet',
      createdAt: FieldValue.serverTimestamp(),
    });
    tx.create(ledgerRef, {
      kind: 'deposit_credit_testnet',
      asset: request.asset,
      amountAtomic,
      referenceId: depositRef.id,
      eventId,
      txHash: normalizedHash,
      chainId: 11155111,
      createdAt: FieldValue.serverTimestamp(),
      immutable: true,
    });
    tx.update(depositRef, {
      status: 'credited',
      creditedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    tx.create(db.collection('auditLogs').doc(), {
      actorUid: 'deposit-monitor-testnet',
      action: 'deposit.credited_testnet',
      resourceId: depositRef.id,
      resourceType: 'deposit',
      asset: request.asset,
      amountAtomic,
      chainId: 11155111,
      createdAt: FieldValue.serverTimestamp(),
    });
    return { idempotent: false, uid: request.uid, asset: request.asset, amountAtomic };
  });
}

/** Production balances: Mainnet, live funds, atomic deduplication. */
export async function creditConfirmedProductionDeposit({ depositRef }) {
  if (!config.LIVE_FUNDS_ENABLED || config.CHAIN_MODE !== 'mainnet' || config.ETH_CHAIN_ID !== 1) {
    throw Object.assign(new Error('Production deposit crediting requires mainnet live funds configuration.'), { statusCode: 503 });
  }

  return db.runTransaction(async (tx) => {
    const requestSnap = await tx.get(depositRef);
    if (!requestSnap.exists) throw Object.assign(new Error('Deposit request not found.'), { statusCode: 404 });
    const request = requestSnap.data();
    if (request.status === 'credited') return { idempotent: true, uid: request.uid, asset: request.asset };
    if (request.status !== 'confirmed' || request.chainId !== 1 || 
        typeof request.uid !== 'string' || !Number.isInteger(request.depositAddressIndex)) {
      throw Object.assign(new Error('Only a confirmed mainnet deposit can be credited.'), { statusCode: 409 });
    }
    if (!['ETH', 'USDT'].includes(request.asset) || !validTxHash(request.txHash) ||
        !validAtomic(request.observedAmountAtomic) || !validEvmAddress(request.depositAddress)) {
      throw Object.assign(new Error('Confirmed mainnet deposit data failed validation.'), { statusCode: 400 });
    }

    const normalizedHash = request.txHash.toLowerCase();
    const eventId = `mainnet_${request.asset.toLowerCase()}_${normalizedHash}`;
    const eventRef = db.collection('depositEvents').doc(eventId);
    const ledgerRef = userLedgerRef(request.uid).doc(`deposit_${eventId}`);
    const account = accountRef(request.uid);
    const assignedAddressRef = db.collection('depositAddresses').doc(request.uid);
    
    const [eventSnap, ledgerSnap, accountSnap, assignedAddressSnap] = await Promise.all([
      tx.get(eventRef), tx.get(ledgerRef), tx.get(account), tx.get(assignedAddressRef),
    ]);
    
    if (eventSnap.exists || ledgerSnap.exists) {
      throw Object.assign(new Error('This mainnet chain event has already been credited or requires reconciliation.'), { statusCode: 409 });
    }
    
    const assignedAddress = assignedAddressSnap.exists ? assignedAddressSnap.data() : null;
    const derivedAddress = assignedAddress && Number.isInteger(assignedAddress.index)
      ? deriveDepositAddressFromXpub(config.DEPOSIT_XPUB, assignedAddress.index)
      : null;
      
    if (!assignedAddress || assignedAddress.uid !== request.uid ||
        assignedAddress.chainId !== 1 || assignedAddress.index !== request.depositAddressIndex ||
        typeof assignedAddress.address !== 'string' || !derivedAddress ||
        derivedAddress.toLowerCase() !== assignedAddress.address.toLowerCase() ||
        derivedAddress.toLowerCase() !== String(request.depositAddress).toLowerCase()) {
      throw Object.assign(new Error('Confirmed mainnet deposit is not bound to the user’s verified derived address.'), { statusCode: 409 });
    }

    const old = accountSnap.exists ? accountSnap.data() : {};
    const balances = { ...zeroBalances(), ...(old.availableAtomic || {}) };
    const amountAtomic = request.observedAmountAtomic;
    const nextBalance = (BigInt(balances[request.asset] || '0') + BigInt(amountAtomic)).toString();
    
    tx.set(account, {
      uid: request.uid,
      availableAtomic: { ...balances, [request.asset]: nextBalance },
      reservedAtomic: { ...zeroBalances(), ...(old.reservedAtomic || {}) },
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    
    tx.create(eventRef, {
      uid: request.uid,
      requestId: depositRef.id,
      chainId: 1,
      network: 'ethereum-mainnet',
      asset: request.asset,
      txHash: normalizedHash,
      depositAddress: request.depositAddress,
      amountAtomic,
      blockNumber: request.blockNumber,
      blockHash: request.blockHash,
      status: 'credited_mainnet',
      createdAt: FieldValue.serverTimestamp(),
    });
    
    tx.create(ledgerRef, {
      kind: 'deposit_credit_mainnet',
      asset: request.asset,
      amountAtomic,
      referenceId: depositRef.id,
      eventId,
      txHash: normalizedHash,
      chainId: 1,
      createdAt: FieldValue.serverTimestamp(),
      immutable: true,
    });
    
    tx.update(depositRef, {
      status: 'credited',
      creditedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    
    tx.create(db.collection('auditLogs').doc(), {
      actorUid: 'deposit-monitor-mainnet',
      action: 'deposit.credited_mainnet',
      resourceId: depositRef.id,
      resourceType: 'deposit',
      asset: request.asset,
      amountAtomic,
      chainId: 1,
      createdAt: FieldValue.serverTimestamp(),
    });
    
    return { idempotent: false, uid: request.uid, asset: request.asset, amountAtomic };
  });
}

export async function reserveWithdrawal({ uid, withdrawalRef, asset, amountAtomic, destination, network, chainId, testnet = false, velocityDay = null }) {
  return db.runTransaction(async tx => {
    const reqSnap = await tx.get(withdrawalRef);
    if (reqSnap.exists) throw Object.assign(new Error('Request already exists.'), { statusCode: 409 });
    const account = accountRef(uid), snap = await tx.get(account), old = snap.exists ? snap.data() : {};
    const available = { ...zeroBalances(), ...(old.availableAtomic || {}) };
    const reserved = { ...zeroBalances(), ...(old.reservedAtomic || {}) };
    const balance = BigInt(available[asset] || '0'), amount = BigInt(amountAtomic);
    if (balance < amount) throw Object.assign(new Error('Insufficient available balance.'), { statusCode: 409 });
    const ledger = userLedgerRef(uid).doc(`withdrawal_hold_${withdrawalRef.id}`);
    tx.set(account, { uid, availableAtomic: { ...available, [asset]: (balance - amount).toString() }, reservedAtomic: { ...reserved, [asset]: (BigInt(reserved[asset] || '0') + amount).toString() }, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    tx.create(withdrawalRef, { uid, asset, amountAtomic, destination, network: network || null, chainId: chainId || null, testnet, velocityDay, status: 'pending_review', createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
    tx.create(ledger, { kind: 'withdrawal_hold', asset, amountAtomic, referenceId: withdrawalRef.id, network: network || null, chainId: chainId || null, createdAt: FieldValue.serverTimestamp(), immutable: true });
    return withdrawalRef.id;
  });
}

export async function settleCustodyWithdrawal({ withdrawalRef, event, actorUid = 'fireblocks-webhook' }) {
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(withdrawalRef);
    if (!snap.exists) throw Object.assign(new Error('Withdrawal request not found.'), { statusCode: 404 });
    const d = snap.data();
    if (['completed', 'failed_released', 'cancelled'].includes(d.status)) return { idempotent: true, status: d.status };
    if (!['submitted', 'broadcasting', 'confirming', 'approved_for_custody'].includes(d.status)) throw Object.assign(new Error('Withdrawal is not eligible for custody settlement.'), { statusCode: 409 });
    if (d.asset !== event.asset || d.amountAtomic !== event.amountAtomic || String(d.destination).toLowerCase() !== event.address.toLowerCase()) throw Object.assign(new Error('Custody event does not match the withdrawal request.'), { statusCode: 409 });
    const account = accountRef(d.uid);
    const accountSnap = await tx.get(account);
    const old = accountSnap.exists ? accountSnap.data() : {};
    const available = { ...zeroBalances(), ...(old.availableAtomic || {}) };
    const reserved = { ...zeroBalances(), ...(old.reservedAtomic || {}) };
    const hold = BigInt(reserved[d.asset] || '0');
    const amount = BigInt(d.amountAtomic);
    if (hold < amount) throw Object.assign(new Error('Reserved balance is inconsistent; escalate to operations.'), { statusCode: 409 });
    if (['failed', 'rejected', 'cancelled', 'blocked'].includes(event.status)) {
      const release = userLedgerRef(d.uid).doc(`withdrawal_release_${withdrawalRef.id}`);
      tx.set(account, { availableAtomic: { ...available, [d.asset]: (BigInt(available[d.asset] || '0') + amount).toString() }, reservedAtomic: { ...reserved, [d.asset]: (hold - amount).toString() }, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
      tx.create(release, { kind: 'withdrawal_release', asset: d.asset, amountAtomic: d.amountAtomic, referenceId: withdrawalRef.id, providerTransactionId: event.providerTransactionId, createdAt: FieldValue.serverTimestamp(), immutable: true });
      tx.update(withdrawalRef, { status: 'failed_released', custodyStatus: event.status, updatedAt: FieldValue.serverTimestamp() });
      tx.create(db.collection('auditLogs').doc(), { actorUid, action: 'withdrawal.custody_failed_released', resourceId: withdrawalRef.id, providerTransactionId: event.providerTransactionId, createdAt: FieldValue.serverTimestamp() });
      return { idempotent: false, status: 'failed_released' };
    }
    const debit = userLedgerRef(d.uid).doc(`withdrawal_debit_${withdrawalRef.id}`);
    const debitSnap = await tx.get(debit);
    if (!debitSnap.exists) tx.create(debit, { kind: 'withdrawal_debit', asset: d.asset, amountAtomic: d.amountAtomic, referenceId: withdrawalRef.id, txHash: event.txHash, providerTransactionId: event.providerTransactionId, createdAt: FieldValue.serverTimestamp(), immutable: true });
    tx.set(account, { reservedAtomic: { ...reserved, [d.asset]: (hold - amount).toString() }, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    tx.update(withdrawalRef, { status: 'completed', custodyStatus: event.status, txHash: event.txHash, providerTransactionId: event.providerTransactionId, completedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
    tx.create(db.collection('auditLogs').doc(), { actorUid, action: 'withdrawal.custody_completed', resourceId: withdrawalRef.id, providerTransactionId: event.providerTransactionId, txHash: event.txHash, createdAt: FieldValue.serverTimestamp() });
    return { idempotent: false, status: 'completed' };
  });
}

export async function finishWithdrawal({ withdrawalRef, actorUid, txHash, release = false, note = null }) {
  return db.runTransaction(async tx => {
    const snap = await tx.get(withdrawalRef);
    if (!snap.exists) throw Object.assign(new Error('Withdrawal request not found.'), { statusCode: 404 });
    const d = snap.data();
    if (release ? !['pending_review', 'awaiting_second_approval', 'approved_for_manual_send'].includes(d.status) : d.status !== 'approved_for_manual_send') throw Object.assign(new Error('Withdrawal cannot be completed from its current state.'), { statusCode: 409 });
    if (!release && (actorUid === d.reviewedBy || actorUid === d.secondApprovedBy)) throw Object.assign(new Error('A separate authorized operator must record the manual transfer.'), { statusCode: 403 });
    const account = accountRef(d.uid), accountSnap = await tx.get(account), old = accountSnap.exists ? accountSnap.data() : {};
    const available = { ...zeroBalances(), ...(old.availableAtomic || {}) };
    const reserved = { ...zeroBalances(), ...(old.reservedAtomic || {}) };
    const hold = BigInt(reserved[d.asset] || '0'), amount = BigInt(d.amountAtomic);
    if (hold < amount) throw Object.assign(new Error('Reserved balance is inconsistent; escalate to operations.'), { statusCode: 409 });
    const nextAvailable = release ? (BigInt(available[d.asset] || '0') + amount).toString() : (available[d.asset] || '0');
    const ledger = userLedgerRef(d.uid).doc(`${release ? 'withdrawal_release' : 'withdrawal_debit'}_${withdrawalRef.id}`);
    tx.set(account, { availableAtomic: { ...available, [d.asset]: nextAvailable }, reservedAtomic: { ...reserved, [d.asset]: (hold - amount).toString() }, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    tx.create(ledger, { kind: release ? 'withdrawal_release' : 'withdrawal_debit', asset: d.asset, amountAtomic: d.amountAtomic, referenceId: withdrawalRef.id, txHash: txHash || null, createdAt: FieldValue.serverTimestamp(), createdBy: actorUid, immutable: true });
    tx.update(withdrawalRef, { status: release ? 'cancelled' : 'sent', txHash: txHash || null, completedBy: actorUid, completedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
    tx.create(db.collection('auditLogs').doc(), { actorUid, action: release ? 'withdrawal.released' : 'withdrawal.marked_sent', resourceId: withdrawalRef.id, resourceType: 'withdrawal', note, createdAt: FieldValue.serverTimestamp() });
  });
}

export async function executeTrade({ uid, sellAsset, sellAmountAtomic, buyAsset, buyAmountAtomic, tradeId }) {
  return db.runTransaction(async tx => {
    const account = accountRef(uid);
    const accountSnap = await tx.get(account);
    const old = accountSnap.exists ? accountSnap.data() : {};

    const available = { ...zeroBalances(), ...(old.availableAtomic || {}) };

    const sellBalance = BigInt(available[sellAsset] || '0');
    const sellAmount = BigInt(sellAmountAtomic);

    if (sellBalance < sellAmount) {
      throw Object.assign(new Error(`Insufficient ${sellAsset} balance for trade.`), { statusCode: 409 });
    }

    const buyBalance = BigInt(available[buyAsset] || '0');
    const buyAmount = BigInt(buyAmountAtomic);

    const nextSellBalance = (sellBalance - sellAmount).toString();
    const nextBuyBalance = (buyBalance + buyAmount).toString();

    const ledgerDocId = `trade_${tradeId}`;
    const ledgerRef = userLedgerRef(uid).doc(ledgerDocId);
    const ledgerSnap = await tx.get(ledgerRef);

    if (ledgerSnap.exists) {
      throw Object.assign(new Error('This trade has already been executed.'), { statusCode: 409 });
    }

    tx.set(account, {
      uid,
      availableAtomic: {
        ...available,
        [sellAsset]: nextSellBalance,
        [buyAsset]: nextBuyBalance
      },
      updatedAt: FieldValue.serverTimestamp()
    }, { merge: true });

    tx.create(ledgerRef, {
      kind: 'trade_execution',
      sellAsset,
      sellAmountAtomic,
      buyAsset,
      buyAmountAtomic,
      referenceId: tradeId,
      createdAt: FieldValue.serverTimestamp(),
      immutable: true
    });

    tx.create(db.collection('auditLogs').doc(), {
      actorUid: uid,
      action: 'trade.executed',
      resourceId: tradeId,
      resourceType: 'trade',
      sellAsset,
      sellAmountAtomic,
      buyAsset,
      buyAmountAtomic,
      createdAt: FieldValue.serverTimestamp()
    });

    return { uid, tradeId, sellAsset, sellAmountAtomic, buyAsset, buyAmountAtomic };
  });
}