import { HDNodeWallet, getAddress } from 'ethers';

const HARDENED_LIMIT = 0x80000000;

/** Accept a public-only node at m/44'/60'/0'/0; it can derive addresses but cannot sign. */
export function deriveDepositAddressFromXpub(extendedPublicKey, index) {
  if (!Number.isInteger(index) || index < 0 || index >= HARDENED_LIMIT) {
    throw new Error('Deposit address index must be a non-hardened BIP-32 index.');
  }
  if (typeof extendedPublicKey !== 'string' || !/^xpub/.test(extendedPublicKey)) {
    throw new Error('DEPOSIT_XPUB must be a public extended key, never an xprv or seed phrase.');
  }
  const accountNode = HDNodeWallet.fromExtendedKey(extendedPublicKey);
  if (accountNode.privateKey || accountNode.depth !== 4) {
    throw new Error("DEPOSIT_XPUB must be a public-only key at m/44'/60'/0'/0 (depth 4).");
  }
  return getAddress(accountNode.deriveChild(index).address);
}
