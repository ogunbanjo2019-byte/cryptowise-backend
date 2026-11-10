import { FieldValue } from 'firebase-admin/firestore';
import { db } from '../firebase.js';
import { config } from '../config.js';
import { deriveDepositAddressFromXpub } from './xpub-derivation.js';
export { deriveDepositAddressFromXpub } from './xpub-derivation.js';

const HARDENED_LIMIT = 0x80000000;
const NETWORK = 'ethereum-testnet';

export async function getOrCreateDepositAddress(uid) {
  if (!config.depositAddressDerivationEnabled || !config.DEPOSIT_XPUB) {
    throw Object.assign(new Error('Unique deposit addresses are not configured.'), { statusCode: 503 });
  }
  if (!uid || typeof uid !== 'string' || uid.includes('/')) {
    throw Object.assign(new Error('A valid signed-in user is required.'), { statusCode: 401 });
  }

  const addressRef = db.collection('depositAddresses').doc(uid);
  const counterRef = db.collection('depositAddressCounters').doc(`ethereum-${config.ETH_CHAIN_ID}`);
  return db.runTransaction(async (transaction) => {
    const existing = await transaction.get(addressRef);
    if (existing.exists) {
      const data = existing.data();
      const expected = deriveDepositAddressFromXpub(config.DEPOSIT_XPUB, data.index);
      if (expected.toLowerCase() !== String(data.address || '').toLowerCase() || data.chainId !== config.ETH_CHAIN_ID || data.uid !== uid) {
        throw Object.assign(new Error('Stored deposit address failed derivation integrity verification.'), { statusCode: 409 });
      }
      return { index: data.index, address: expected, network: data.network, chainId: data.chainId };
    }

    const counter = await transaction.get(counterRef);
    const index = counter.exists ? Number(counter.data().nextIndex || 0) : 0;
    if (!Number.isSafeInteger(index) || index < 0 || index >= HARDENED_LIMIT) {
      throw new Error('Deposit address derivation index is invalid or exhausted.');
    }
    const address = deriveDepositAddressFromXpub(config.DEPOSIT_XPUB, index);
    transaction.create(addressRef, {
      uid,
      index,
      address,
      network: NETWORK,
      chainId: config.ETH_CHAIN_ID,
      derivationPath: `m/44'/60'/0'/0/${index}`,
      createdAt: FieldValue.serverTimestamp(),
    });
    transaction.set(counterRef, {
      nextIndex: index + 1,
      chainId: config.ETH_CHAIN_ID,
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    return { index, address, network: NETWORK, chainId: config.ETH_CHAIN_ID };
  });
}
