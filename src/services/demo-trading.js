import crypto from 'node:crypto';
import { FieldValue } from 'firebase-admin/firestore';
import { db } from '../firebase.js';
import { ASSET_DECIMALS, zeroBalances } from './ledger.js';
import { parseDecimalToAtomic } from './validation.js';

export const DEMO_PRICES = Object.freeze({
  ETH_USDT: '3245.67',
  BTC_USDT: '67432.21',
});

export const DEMO_START_USDT = '10000000000'; // 10,000 USDT in six-decimal atomic units.

export function demoAccountRef(uid) {
  return db.collection('demoAccounts').doc(uid);
}

export function initialDemoBalances() {
  return { ...zeroBalances(), USDT: DEMO_START_USDT };
}

export async function executeDemoTrade({
  uid,
  side,
  baseAsset,
  quoteAsset,
  amountUsd,
  idempotencyKey,
}) {
  if (baseAsset !== 'ETH' || quoteAsset !== 'USDT') {
    throw Object.assign(
      new Error('Only ETH/USDT demo trading is enabled.'),
      { statusCode: 400 },
    );
  }

  if (!['buy', 'sell'].includes(side)) {
    throw Object.assign(
      new Error('Trade side must be buy or sell.'),
      { statusCode: 400 },
    );
  }

  const quoteAtomic = parseDecimalToAtomic(
    String(amountUsd),
    ASSET_DECIMALS.USDT,
  );

  if (BigInt(quoteAtomic) < 100000000n) {
    throw Object.assign(
      new Error('Demo orders must be at least 100 USDT.'),
      { statusCode: 400 },
    );
  }

  const priceAtomic = parseDecimalToAtomic(
    DEMO_PRICES.ETH_USDT,
    ASSET_DECIMALS.USDT,
  );
  const baseAtomic = (
    BigInt(quoteAtomic) * 10n ** 18n / BigInt(priceAtomic)
  ).toString();

  const tradeId = String(idempotencyKey || crypto.randomUUID())
    .replace(/[^A-Za-z0-9_-]/g, '')
    .slice(0, 100) || crypto.randomUUID();

  return db.runTransaction(async (tx) => {
    const account = demoAccountRef(uid);
    const snap = await tx.get(account);
    const old = snap.exists ? snap.data() : {};
    const available = {
      ...initialDemoBalances(),
      ...(old.availableAtomic || {}),
    };

    const sellAsset = side === 'buy' ? 'USDT' : 'ETH';
    const buyAsset = side === 'buy' ? 'ETH' : 'USDT';
    const sellAmount = side === 'buy' ? quoteAtomic : baseAtomic;
    const buyAmount = side === 'buy' ? baseAtomic : quoteAtomic;

    if (BigInt(available[sellAsset] || '0') < BigInt(sellAmount)) {
      throw Object.assign(
        new Error(`Insufficient demo ${sellAsset} balance.`),
        { statusCode: 409 },
      );
    }

    const ledgerRef = account.collection('ledger')
      .doc(`demo_trade_${tradeId}`);
    const notificationRef = db.collection('users').doc(uid)
      .collection('notifications').doc(`demo_trade_${tradeId}`);

    const ledgerSnap = await tx.get(ledgerRef);
    const notificationSnap = await tx.get(notificationRef);

    if (ledgerSnap.exists || notificationSnap.exists) {
      throw Object.assign(
        new Error('This demo order has already been executed.'),
        { statusCode: 409 },
      );
    }

    available[sellAsset] = (
      BigInt(available[sellAsset] || '0') - BigInt(sellAmount)
    ).toString();
    available[buyAsset] = (
      BigInt(available[buyAsset] || '0') + BigInt(buyAmount)
    ).toString();

    tx.set(account, {
      uid,
      mode: 'demo',
      availableAtomic: available,
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });

    tx.create(ledgerRef, {
      kind: 'demo_trade_execution',
      mode: 'demo',
      side,
      baseAsset,
      quoteAsset,
      sellAsset,
      sellAmountAtomic: sellAmount,
      buyAsset,
      buyAmountAtomic: buyAmount,
      price: DEMO_PRICES.ETH_USDT,
      amountUsd: String(amountUsd),
      referenceId: tradeId,
      createdAt: FieldValue.serverTimestamp(),
      immutable: true,
    });

    tx.create(notificationRef, {
      type: 'demo_trade_filled',
      title: 'Demo order completed',
      message: `${side === 'buy' ? 'Buy' : 'Sell'} ETH/USDT practice order for ${String(amountUsd)} USDT filled at the simulated price of ${DEMO_PRICES.ETH_USDT} USDT per ETH. No real assets were traded.`,
      createdAt: FieldValue.serverTimestamp(),
      readAt: null,
      referenceId: tradeId,
    });

    return {
      tradeId,
      mode: 'demo',
      status: 'filled',
      side,
      pair: 'ETH/USDT',
      amountUsd: String(amountUsd),
      price: DEMO_PRICES.ETH_USDT,
      baseAmountAtomic: baseAtomic,
    };
  });
}

export function tradingStatus(config) {
  return {
    demo: {
      enabled: true,
      pair: 'ETH/USDT',
      price: DEMO_PRICES.ETH_USDT,
      priceType: 'simulated',
      startingBalance: '10000 USDT',
    },
    live: {
      enabled: false,
      reason: config.tradingEnabled
        ? 'No production exchange execution adapter, verified credentials, or risk controls are configured.'
        : 'Live trading is disabled by server configuration.',
    },
  };
}
