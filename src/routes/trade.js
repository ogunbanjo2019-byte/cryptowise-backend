import express from 'express';
import { config } from '../config.js';
import { requireUser } from '../middleware/auth.js';
import { executeDemoTrade, tradingStatus } from '../services/demo-trading.js';
const router = express.Router();
router.get('/trading/status', requireUser, (_req, res) => res.json(tradingStatus(config)));
router.post('/trade', requireUser, async (req, res, next) => { try { const { mode = 'demo', side, baseAsset = 'ETH', quoteAsset = 'USDT', amountUsd } = req.body || {}; if (mode === 'live') return res.status(503).json({ error: 'Live trading is not available: configure and independently review a licensed exchange execution and custody adapter before enabling it.' }); if (mode !== 'demo') return res.status(400).json({ error: 'Trade mode must be demo or live.' }); const trade = await executeDemoTrade({ uid: req.user.uid, side, baseAsset, quoteAsset, amountUsd, idempotencyKey: req.headers['idempotency-key'] }); res.status(201).json({ success: true, trade }); } catch (error) { if (error.statusCode) return res.status(error.statusCode).json({ error: error.message }); next(error); } });
export default router;
