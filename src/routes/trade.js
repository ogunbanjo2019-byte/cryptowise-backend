import express from 'express';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { executeTrade } from '../services/ledger.js';
import { requireUser } from '../middleware/auth.js';

const router = express.Router();

/**
 * POST /v1/trade
 * Executes a live cryptocurrency trade
 */
router.post('/trade', requireUser, async (req, res, next) => {
  try {
    // 1. Double check environmental configuration
    if (!config.tradingEnabled) {
      return res.status(403).json({ error: 'Trading is currently disabled in system configuration.' });
    }

    // 2. Extract user ID from authenticated token (req.user is set by requireUser) and trade parameters from body
    const uid = req.user?.uid || req.body.userId;
    const { sellAsset, sellAmountAtomic, buyAsset, buyAmountAtomic } = req.body;

    if (!uid) {
      return res.status(401).json({ error: 'Unauthorized user context.' });
    }

    // 3. Validate inputs
    if (!sellAsset || !sellAmountAtomic || !buyAsset || !buyAmountAtomic) {
      return res.status(400).json({ 
        error: 'Missing required trade parameters: sellAsset, sellAmountAtomic, buyAsset, buyAmountAtomic.' 
      });
    }

    // Generate a unique trade ID or use an idempotency key if passed in headers
    const tradeId = req.headers['idempotency-key'] || crypto.randomUUID();

    // 4. Execute transaction atomically via the ledger service
    const result = await executeTrade({
      uid,
      sellAsset,
      sellAmountAtomic,
      buyAsset,
      buyAmountAtomic,
      tradeId
    });

    // 5. Respond with success
    return res.status(200).json({
      success: true,
      message: 'Trade executed successfully.',
      trade: result
    });

  } catch (error) {
    // Pass custom status codes (like 409 for insufficient funds) if thrown from ledger
    if (error.statusCode) {
      return res.status(error.statusCode).json({ error: error.message });
    }
    next(error); // Handled by your app.js error handler
  }
});

export default router;