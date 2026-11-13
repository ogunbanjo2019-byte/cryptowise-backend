import { Router } from 'express';
import { requireUser } from '../middleware/auth.js';
import { getDepositAddress } from '../services/custody.js';
import { createLedgerPool, upsertWalletMapping } from '../services/postgres-ledger.js';
import { isSafetyGateActive } from '../services/safety-gate.js';

const router = Router();
const CHAIN_ID = 1;
const NETWORK = 'ethereum';
const USDT = '0xdac17f958d2ee523a2206206994597c13d831ec7';
const pool = () => createLedgerPool();

router.post('/deposit-address', requireUser, async (req, res, next) => {
  try {
    if (isSafetyGateActive()) return res.status(503).json({ error: 'Safety gate is active; deposit addresses are not published.' });
    const asset = String(req.body?.asset || '').toUpperCase();
    if (!['ETH', 'USDT'].includes(asset)) return res.status(400).json({ error: 'Asset must be ETH or USDT.' });
    if (String(req.body?.network || NETWORK).toLowerCase() !== NETWORK) return res.status(400).json({ error: 'Only Ethereum mainnet is supported.' });
    if (asset === 'USDT' && String(req.body?.tokenContract || USDT).toLowerCase() !== USDT) return res.status(400).json({ error: 'Only the official Ethereum USDT contract is supported.' });

    const providerResult = await getDepositAddress({ uid: req.user.uid, asset, network: NETWORK });
    const address = String(providerResult?.address || '').toLowerCase();
    if (!/^0x[a-f0-9]{40}$/.test(address)) return res.status(502).json({ error: 'Custody provider returned an invalid deposit address.' });
    const db = pool();
    try {
      const mapping = await upsertWalletMapping(db, {
        customerId: req.user.uid, asset, network: NETWORK, chainId: CHAIN_ID, address,
        tokenContract: asset === 'USDT' ? USDT : null,
        provider: String(providerResult.provider || process.env.CUSTODY_PROVIDER || 'unknown'),
        providerReference: String(providerResult.providerAccountId || providerResult.id || address),
      });
      return res.status(200).json({ asset, network: NETWORK, chainId: CHAIN_ID, address: mapping.address, tokenContract: mapping.token_contract });
    } finally { await db.end(); }
  } catch (error) { next(error); }
});

export default router;
