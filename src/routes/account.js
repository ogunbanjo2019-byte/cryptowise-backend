import { Router } from 'express';
import { FieldValue } from 'firebase-admin/firestore';
import { db } from '../firebase.js';
import { config } from '../config.js';
import { requireUser } from '../middleware/auth.js';
import {
  accountRef,
  zeroBalances,
  reserveWithdrawal,
} from '../services/ledger.js';
import {
  validEvmAddress,
  validTxHash,
} from '../services/validation.js';
import {
  DEPOSIT_AUTOMATIC_CREDIT_READY,
  DEPOSIT_CHAIN_VERIFICATION_READY,
  DEPOSIT_CUSTOMER_INTAKE_READY,
} from '../services/deposit-readiness.js';
import {
  demoAccountRef,
  initialDemoBalances,
} from '../services/demo-trading.js';

const router = Router();
const NETWORK =
  config.CHAIN_MODE === 'mainnet' ? 'ethereum' : 'ethereum-testnet';

function serialize(value) {
  if (!value) return null;
  if (typeof value.toDate === 'function') return value.toDate().toISOString();
  if (typeof value.toMillis === 'function') {
    return new Date(value.toMillis()).toISOString();
  }
  return value;
}

function generatedIdentity(uid, token) {
  const emailName = String(token.email || token.name || 'user')
    .split('@')[0]
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 12) || 'user';

  const uidPart = String(uid)
    .replace(/[^a-zA-Z0-9]/g, '')
    .slice(-8)
    .toLowerCase();

  return {
    username: `cw_${emailName}_${uidPart}`,
    customerNumber: `CW-${String(uid)
      .replace(/[^a-zA-Z0-9]/g, '')
      .slice(0, 10)
      .toUpperCase()}`,
  };
}

async function ensureProfile(uid, token) {
  const ref = db.collection('users').doc(uid);
  const identity = generatedIdentity(uid, token);

  return db.runTransaction(async (transaction) => {
    const snap = await transaction.get(ref);
    const existing = snap.exists ? snap.data() : {};

    const data = {
      uid,
      email: token.email || existing.email || null,
      displayName: token.name || existing.displayName || null,
      username: existing.username || identity.username,
      customerNumber: existing.customerNumber || identity.customerNumber,
      kycStatus: existing.kycStatus || 'not_started',
      updatedAt: FieldValue.serverTimestamp(),
    };

    if (!snap.exists) data.createdAt = FieldValue.serverTimestamp();

    if (!snap.exists || !existing.username || !existing.customerNumber) {
      transaction.set(ref, data, { merge: true });
    }

    return { ...existing, ...data };
  });
}

router.get('/me', requireUser, async (req, res, next) => {
  try {
    const data = await ensureProfile(req.user.uid, req.user);

    res.json({
      uid: req.user.uid,
      email: req.user.email || data.email || null,
      displayName: req.user.name || data.displayName || null,
      username: data.username || null,
      customerNumber: data.customerNumber || null,
      kycStatus: data.kycStatus || 'not_started',
    });
  } catch (error) {
    next(error);
  }
});

router.get('/wallet', requireUser, async (req, res, next) => {
  try {
    const [snap, ledgerSnap, demoSnap] = await Promise.all([
      accountRef(req.user.uid).get(),
      db.collection('users')
        .doc(req.user.uid)
        .collection('ledger')
        .orderBy('createdAt', 'desc')
        .limit(50)
        .get(),
      demoAccountRef(req.user.uid).get(),
    ]);

    const data = snap.exists ? snap.data() : {};
    const demo = demoSnap.exists ? demoSnap.data() : {};

    const demoHistory = await demoAccountRef(req.user.uid)
      .collection('ledger')
      .orderBy('createdAt', 'desc')
      .limit(50)
      .get();

    res.json({
      uid: req.user.uid,
      availableAtomic: {
        ...zeroBalances(),
        ...(data.availableAtomic || {}),
      },
      reservedAtomic: {
        ...zeroBalances(),
        ...(data.reservedAtomic || {}),
      },
      transactions: ledgerSnap.docs.map((doc) => ({
        id: doc.id,
        ...doc.data(),
        createdAt: serialize(doc.data().createdAt),
      })),
      demo: {
        availableAtomic: {
          ...initialDemoBalances(),
          ...(demo.availableAtomic || {}),
        },
        transactions: demoHistory.docs.map((doc) => ({
          id: doc.id,
          ...doc.data(),
          createdAt: serialize(doc.data().createdAt),
        })),
      },
    });
  } catch (error) {
    next(error);
  }
});

router.get('/deposit-instructions', requireUser, (_req, res) => {
  const addresses = [
    { asset: 'ETH', address: config.ETH_DEPOSIT_ADDRESS },
    {
      asset: 'USDT',
      address: config.USDT_DEPOSIT_ADDRESS,
      tokenContract: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
    },
  ].filter((item) => validEvmAddress(item.address));

  const enabled =
    config.liveFundsEnabled &&
    DEPOSIT_CUSTOMER_INTAKE_READY &&
    DEPOSIT_CHAIN_VERIFICATION_READY &&
    DEPOSIT_AUTOMATIC_CREDIT_READY &&
    addresses.length === 2;

  res.json({
    enabled,
    network: NETWORK,
    notice: enabled
      ? 'Only use the active address shown here and the exact network.'
      : 'Receiving addresses may be configured below, but CryptoWise deposits are paused. Transfers will not be automatically detected or credited. Do not send funds until the service announces deposits are open.',
    assets: addresses,
  });
});

router.get('/deposit-requests', requireUser, async (req, res, next) => {
  try {
    const snap = await db.collection('depositRequests')
      .where('uid', '==', req.user.uid)
      .orderBy('createdAt', 'desc')
      .limit(100)
      .get();

    res.json({
      requests: snap.docs.map((doc) => ({
        id: doc.id,
        ...doc.data(),
      })),
    });
  } catch (error) {
    next(error);
  }
});

router.post('/deposit-requests', requireUser, async (req, res, next) => {
  try {
    if (
      !config.liveFundsEnabled ||
      !DEPOSIT_CUSTOMER_INTAKE_READY ||
      !DEPOSIT_CHAIN_VERIFICATION_READY ||
      !DEPOSIT_AUTOMATIC_CREDIT_READY
    ) {
      return res.status(503).json({
        error:
          'Deposits are paused until customer intake, chain verification, ' +
          'and duplicate-safe crediting are implemented and reviewed.',
      });
    }

    const { asset, txHash, network } = req.body || {};

    if (
      !['ETH', 'USDT'].includes(asset) ||
      network !== NETWORK ||
      !validTxHash(txHash)
    ) {
      return res.status(400).json({
        error: 'Asset, exact network, and transaction hash are required.',
      });
    }

    const ref = db.collection('depositRequests').doc();

    await ref.set({
      uid: req.user.uid,
      asset,
      txHash,
      network,
      status: 'pending_manual_review',
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });

    res.status(201).json({
      id: ref.id,
      status: 'pending_manual_review',
      message:
        'Deposit submitted for protected review. A transaction hash is not proof of payment.',
    });
  } catch (error) {
    next(error);
  }
});

router.post('/withdrawal-requests', requireUser, async (req, res, next) => {
  try {
    const { asset, amountAtomic, destination, network } = req.body || {};

    if (
      !['ETH', 'USDT'].includes(asset) ||
      network !== NETWORK ||
      !/^[1-9][0-9]{0,77}$/.test(amountAtomic) ||
      !validEvmAddress(destination)
    ) {
      return res.status(400).json({
        error: 'Valid asset, amount, destination, and network are required.',
      });
    }

    const ref = db.collection('withdrawalRequests').doc();

    await reserveWithdrawal({
      uid: req.user.uid,
      withdrawalRef: ref,
      asset,
      amountAtomic,
      destination,
    });

    res.status(201).json({
      id: ref.id,
      status: 'pending_review',
    });
  } catch (error) {
    next(error);
  }
});

router.get('/preferences', requireUser, async (req, res, next) => {
  try {
    const snap = await db.collection('users')
      .doc(req.user.uid)
      .collection('private')
      .doc('preferences')
      .get();

    res.json({
      preferences: snap.exists
        ? snap.data()
        : {
            displayCurrency: 'USD',
            timeZone: 'UTC',
            notifications: { email: true, product: true },
          },
    });
  } catch (error) {
    next(error);
  }
});

router.patch('/preferences', requireUser, async (req, res, next) => {
  try {
    const preferences = {
      displayCurrency: String(req.body?.displayCurrency || 'USD').slice(0, 8),
      timeZone: String(req.body?.timeZone || 'UTC').slice(0, 64),
      notifications: {
        email: req.body?.notifications?.email !== false,
        product: req.body?.notifications?.product !== false,
      },
    };

    await db.collection('users')
      .doc(req.user.uid)
      .collection('private')
      .doc('preferences')
      .set(preferences, { merge: true });

    res.json({ preferences });
  } catch (error) {
    next(error);
  }
});

router.get('/notifications', requireUser, async (req, res, next) => {
  try {
    const snap = await db.collection('users')
      .doc(req.user.uid)
      .collection('notifications')
      .orderBy('createdAt', 'desc')
      .limit(50)
      .get();

    res.json({
      notifications: snap.docs.map((doc) => ({
        id: doc.id,
        ...doc.data(),
      })),
    });
  } catch (error) {
    next(error);
  }
});

router.patch('/notifications/:id/read', requireUser, async (req, res, next) => {
  try {
    const ref = db.collection('users')
      .doc(req.user.uid)
      .collection('notifications')
      .doc(req.params.id);

    const snap = await ref.get();

    if (!snap.exists) {
      return res.status(404).json({ error: 'Notification not found.' });
    }

    await ref.update({ readAt: FieldValue.serverTimestamp() });
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

router.get('/account-export', requireUser, async (req, res, next) => {
  try {
    const wallet = await accountRef(req.user.uid).get();
    const ledger = await db.collection('users')
      .doc(req.user.uid)
      .collection('ledger')
      .limit(1000)
      .get();

    const rows = [
      [
        'recordType',
        'id',
        'asset',
        'amountAtomic',
        'kind',
        'referenceId',
      ],
      [
        'wallet',
        req.user.uid,
        '',
        JSON.stringify(wallet.data()?.availableAtomic || {}),
        '',
        '',
      ],
      ...ledger.docs.map((doc) => {
        const x = doc.data();

        return [
          'ledger',
          doc.id,
          x.asset || x.sellAsset || '',
          x.amountAtomic || x.sellAmountAtomic || '',
          x.kind || '',
          x.referenceId || '',
        ];
      }),
    ];

    const csv = rows
      .map((row) =>
        row.map((x) => `"${String(x ?? '').replaceAll('"', '""')}"`).join(','),
      )
      .join('\r\n');

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      'attachment; filename="cryptowise-account-export.csv"',
    );
    res.send(`\uFEFF${csv}\r\n`);
  } catch (error) {
    next(error);
  }
});

export default router;
