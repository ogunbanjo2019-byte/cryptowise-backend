import { ethers } from 'ethers';

const OFFICIAL_MAINNET_USDT = '0xdAC17F958D2ee523a2206206994597C13D831ec7';
const transferInterface = new ethers.Interface([
  'event Transfer(address indexed from, address indexed to, uint256 value)',
]);

const result = (status, details = {}) => ({ status, ...details });

export async function verifyDepositRequest(request, chainProvider, settings) {
  const asset = String(request.asset || '').toUpperCase();
  const txHash = String(request.txHash || '');
  if (!['ETH', 'USDT'].includes(asset) || !/^0x[a-fA-F0-9]{64}$/.test(txHash)) {
    return result('manual_review', { reason: 'Invalid asset or transaction hash.' });
  }
  const expectedNetwork = settings.ETH_CHAIN_ID === 1 ? 'ethereum' : 'ethereum-testnet';
  if (request.network !== expectedNetwork || (request.chainId != null && Number(request.chainId) !== settings.ETH_CHAIN_ID)) {
    return result('manual_review', { reason: 'Deposit request network does not match the configured chain.' });
  }
  const recipient = request.depositAddress ||
    (asset === 'ETH' ? settings.ETH_DEPOSIT_ADDRESS : settings.USDT_DEPOSIT_ADDRESS);
  if (!ethers.isAddress(recipient)) {
    return result('manual_review', { reason: `No valid configured ${asset} receiving address.` });
  }

  let transaction;
  let receipt;
  try {
    [transaction, receipt] = await Promise.all([
      chainProvider.getTransaction(txHash),
      chainProvider.getTransactionReceipt(txHash),
    ]);
  } catch (error) {
    throw new Error(`RPC lookup failed for ${txHash}: ${error.message}`);
  }
  if (!transaction || !receipt) {
    const prior = String(request.status || '').toLowerCase();
    return ['detected', 'confirming', 'confirmed'].includes(prior)
      ? result('reorged', { confirmations: 0, reason: 'Previously observed transaction is no longer available on the canonical chain.' })
      : result('pending_manual_review', { confirmations: 0 });
  }
  if (Number(receipt.status) !== 1) {
    return result('failed', { confirmations: 0, reason: 'Transaction receipt indicates failure.' });
  }

  const network = await chainProvider.getNetwork();
  if (Number(network.chainId) !== settings.ETH_CHAIN_ID || (transaction.chainId && Number(transaction.chainId) !== settings.ETH_CHAIN_ID)) {
    return result('manual_review', { confirmations: 0, reason: 'Transaction/provider chain ID does not match configured network.' });
  }

  let observedAmountAtomic = 0n;
  if (asset === 'ETH') {
    if (!transaction.to || transaction.to.toLowerCase() !== recipient.toLowerCase() || BigInt(transaction.value || 0) <= 0n) {
      return result('manual_review', { confirmations: 0, reason: 'Native ETH transfer recipient or amount does not match.' });
    }
    observedAmountAtomic = BigInt(transaction.value);
  } else {
    const token = settings.USDT_TOKEN_CONTRACT || (settings.ETH_CHAIN_ID === 1 ? OFFICIAL_MAINNET_USDT : '');
    if (!ethers.isAddress(token)) {
      return result('manual_review', { confirmations: 0, reason: 'USDT token contract is not configured for this network.' });
    }
    for (const log of receipt.logs || []) {
      if (log.address.toLowerCase() !== token.toLowerCase()) continue;
      if (log.blockHash && log.blockHash.toLowerCase() !== receipt.blockHash?.toLowerCase()) continue;
      try {
        const parsed = transferInterface.parseLog(log);
        if (parsed?.name === 'Transfer' && parsed.args.to.toLowerCase() === recipient.toLowerCase()) {
          observedAmountAtomic += BigInt(parsed.args.value);
        }
      } catch {
        // Ignore unrelated or malformed logs; only the configured token's Transfer event counts.
      }
    }
    if (observedAmountAtomic <= 0n) {
      return result('manual_review', { confirmations: 0, reason: 'No positive transfer to the configured address from the configured USDT contract.' });
    }
  }

  const canonicalBlock = await chainProvider.getBlock(receipt.blockNumber);
  if (!canonicalBlock || canonicalBlock.hash?.toLowerCase() !== receipt.blockHash?.toLowerCase()) {
    return result('reorged', { confirmations: 0, reason: 'Receipt block is not canonical.' });
  }
  const latestBlock = await chainProvider.getBlockNumber();
  const confirmations = Math.max(0, latestBlock - receipt.blockNumber + 1);
  const status = confirmations >= settings.DEPOSIT_CONFIRMATIONS_REQUIRED
    ? 'confirmed'
    : confirmations > 0
      ? 'confirming'
      : 'detected';

  return result(status, {
    confirmations,
    blockNumber: receipt.blockNumber,
    blockHash: receipt.blockHash,
    observedAmountAtomic: observedAmountAtomic.toString(),
    chainId: settings.ETH_CHAIN_ID,
    reason: null,
  });
}
