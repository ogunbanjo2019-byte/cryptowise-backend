import { FieldValue } from 'firebase-admin/firestore';
import { db } from '../firebase.js';
import { validAtomic, validEvmAddress, validTxHash } from './validation.js';

export const ASSET_DECIMALS = Object.freeze({ ETH:18, USDT:6 });
export const zeroBalances = () => ({ ETH:'0', USDT:'0' });
export function accountRef(uid) { return db.collection('accounts').doc(uid); }
export function userLedgerRef(uid) { return db.collection('users').doc(uid).collection('ledger'); }

export async function creditDeposit({ depositRef, reviewerUid, amountAtomic, txHash }) {
  return db.runTransaction(async tx => {
    const snap=await tx.get(depositRef);
    if(!snap.exists) throw Object.assign(new Error('Deposit request not found.'),{statusCode:404});
    const d=snap.data();
    if(d.status!=='awaiting_second_approval') throw Object.assign(new Error('Deposit is not awaiting second approval.'),{statusCode:409});
    if(d.reviewedBy===reviewerUid) throw Object.assign(new Error('A different authorized reviewer must approve this credit.'),{statusCode:403});
    if(d.asset!=='ETH'&&d.asset!=='USDT') throw Object.assign(new Error('Unsupported asset.'),{statusCode:400});
    if(!validAtomic(amountAtomic)||amountAtomic!==d.reviewedAmountAtomic) throw Object.assign(new Error('Amount must match the first reviewer’s recorded amount.'),{statusCode:400});
    const account=accountRef(d.uid), accountSnap=await tx.get(account), old=accountSnap.exists?accountSnap.data():{};
    const balances={...zeroBalances(),...(old.availableAtomic||{})};
    const next=(BigInt(balances[d.asset]||'0')+BigInt(amountAtomic)).toString();
    const ledger=userLedgerRef(d.uid).doc(`deposit_${depositRef.id}`);
    const ledgerSnap=await tx.get(ledger);
    if(ledgerSnap.exists) throw Object.assign(new Error('This deposit was already credited.'),{statusCode:409});
    tx.set(account,{uid:d.uid,availableAtomic:{...balances,[d.asset]:next},reservedAtomic:{...zeroBalances(),...(old.reservedAtomic||{})},updatedAt:FieldValue.serverTimestamp()},{merge:true});
    tx.create(ledger,{kind:'deposit_credit',asset:d.asset,amountAtomic,referenceId:depositRef.id,txHash,createdAt:FieldValue.serverTimestamp(),createdBy:reviewerUid,immutable:true});
    tx.update(depositRef,{status:'credited',creditedBy:reviewerUid,creditedAt:FieldValue.serverTimestamp(),updatedAt:FieldValue.serverTimestamp()});
    tx.create(db.collection('auditLogs').doc(),{actorUid:reviewerUid,action:'deposit.credited',resourceId:depositRef.id,resourceType:'deposit',createdAt:FieldValue.serverTimestamp(),amountAtomic,asset:d.asset});
    return {uid:d.uid,asset:d.asset,amountAtomic};
  });
}

export async function reserveWithdrawal({ uid, withdrawalRef, asset, amountAtomic, destination }) {
  return db.runTransaction(async tx=>{
    const reqSnap=await tx.get(withdrawalRef);
    if(reqSnap.exists) throw Object.assign(new Error('Request already exists.'),{statusCode:409});
    const account=accountRef(uid), snap=await tx.get(account), old=snap.exists?snap.data():{};
    const available={...zeroBalances(),...(old.availableAtomic||{})};
    const reserved={...zeroBalances(),...(old.reservedAtomic||{})};
    const balance=BigInt(available[asset]||'0'), amount=BigInt(amountAtomic);
    if(balance<amount) throw Object.assign(new Error('Insufficient available balance.'),{statusCode:409});
    const ledger=userLedgerRef(uid).doc(`withdrawal_hold_${withdrawalRef.id}`);
    tx.set(account,{uid,availableAtomic:{...available,[asset]:(balance-amount).toString()},reservedAtomic:{...reserved,[asset]:(BigInt(reserved[asset]||'0')+amount).toString()},updatedAt:FieldValue.serverTimestamp()},{merge:true});
    tx.create(withdrawalRef,{uid,asset,amountAtomic,destination,status:'pending_review',createdAt:FieldValue.serverTimestamp(),updatedAt:FieldValue.serverTimestamp()});
    tx.create(ledger,{kind:'withdrawal_hold',asset,amountAtomic,referenceId:withdrawalRef.id,createdAt:FieldValue.serverTimestamp(),immutable:true});
    return withdrawalRef.id;
  });
}

export async function finishWithdrawal({withdrawalRef,actorUid,txHash,release=false,note=null}) {
  return db.runTransaction(async tx=>{
    const snap=await tx.get(withdrawalRef);
    if(!snap.exists) throw Object.assign(new Error('Withdrawal request not found.'),{statusCode:404});
    const d=snap.data();
    if(release ? !['pending_review','awaiting_second_approval','approved_for_manual_send'].includes(d.status) : d.status!=='approved_for_manual_send') throw Object.assign(new Error('Withdrawal cannot be completed from its current state.'),{statusCode:409});
    if(!release&&(actorUid===d.reviewedBy||actorUid===d.secondApprovedBy)) throw Object.assign(new Error('A separate authorized operator must record the manual transfer.'),{statusCode:403});
    const account=accountRef(d.uid),accountSnap=await tx.get(account),old=accountSnap.exists?accountSnap.data():{};
    const available={...zeroBalances(),...(old.availableAtomic||{})};
    const reserved={...zeroBalances(),...(old.reservedAtomic||{})};
    const hold=BigInt(reserved[d.asset]||'0'),amount=BigInt(d.amountAtomic);
    if(hold<amount) throw Object.assign(new Error('Reserved balance is inconsistent; escalate to operations.'),{statusCode:409});
    const nextAvailable=release?(BigInt(available[d.asset]||'0')+amount).toString():(available[d.asset]||'0');
    const ledger=userLedgerRef(d.uid).doc(`${release?'withdrawal_release':'withdrawal_debit'}_${withdrawalRef.id}`);
    tx.set(account,{availableAtomic:{...available,[d.asset]:nextAvailable},reservedAtomic:{...reserved,[d.asset]:(hold-amount).toString()},updatedAt:FieldValue.serverTimestamp()},{merge:true});
    tx.create(ledger,{kind:release?'withdrawal_release':'withdrawal_debit',asset:d.asset,amountAtomic:d.amountAtomic,referenceId:withdrawalRef.id,txHash:txHash||null,createdAt:FieldValue.serverTimestamp(),createdBy:actorUid,immutable:true});
    tx.update(withdrawalRef,{status:release?'cancelled':'sent',txHash:txHash||null,completedBy:actorUid,completedAt:FieldValue.serverTimestamp(),updatedAt:FieldValue.serverTimestamp()});
    tx.create(db.collection('auditLogs').doc(),{actorUid,action:release?'withdrawal.released':'withdrawal.marked_sent',resourceId:withdrawalRef.id,resourceType:'withdrawal',note,createdAt:FieldValue.serverTimestamp()});
  });
}

/**
 * Executes an instant trade by atomically debiting the source asset 
 * and crediting the target destination asset.
 */
export async function executeTrade({ uid, sellAsset, sellAmountAtomic, buyAsset, buyAmountAtomic, tradeId }) {
  return db.runTransaction(async tx => {
    const account = accountRef(uid);
    const accountSnap = await tx.get(account);
    const old = accountSnap.exists ? accountSnap.data() : {};

    const available = { ...zeroBalances(), ...(old.availableAtomic || {}) };

    const sellBalance = BigInt(available[sellAsset] || '0');
    const sellAmount = BigInt(sellAmountAtomic);

    // 1. Ensure user has enough balance of the asset they are selling
    if (sellBalance < sellAmount) {
      throw Object.assign(new Error(`Insufficient ${sellAsset} balance for trade.`), { statusCode: 409 });
    }

    const buyBalance = BigInt(available[buyAsset] || '0');
    const buyAmount = BigInt(buyAmountAtomic);

    // 2. Compute new balances atomically
    const nextSellBalance = (sellBalance - sellAmount).toString();
    const nextBuyBalance = (buyBalance + buyAmount).toString();

    const ledgerDocId = `trade_${tradeId}`;
    const ledgerRef = userLedgerRef(uid).doc(ledgerDocId);
    const ledgerSnap = await tx.get(ledgerRef);

    if (ledgerSnap.exists) {
      throw Object.assign(new Error('This trade has already been executed.'), { statusCode: 409 });
    }

    // 3. Update account balances
    tx.set(account, {
      uid,
      availableAtomic: {
        ...available,
        [sellAsset]: nextSellBalance,
        [buyAsset]: nextBuyBalance
      },
      updatedAt: FieldValue.serverTimestamp()
    }, { merge: true });

    // 4. Create permanent immutable ledger records for the trade settlement
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

    // 5. Audit Log entry
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