import express from 'express';
import { config } from '../config.js';
import { requireUser } from '../middleware/auth.js';
import { executeDemoTrade, tradingStatus } from '../services/demo-trading.js';
import { bybitStatus, placeSpotMarketOrder } from '../services/bybit.js';

const router = express.Router();

function liveTradingEnabled() {
  return config.tradingEnabled && bybitStatus().enabled && Boolean(config.BYBIT_OPERATOR_UID);
}

router.get('/trading/status', requireUser, (_req, res) => {
  const status = tradingStatus(config);
  const enabled = liveTradingEnabled();
  res.json({
    ...status,
    live: {
      ...status.live,
      enabled,
      reason: enabled
        ? `Live ${config.BYBIT_ENV} Bybit spot trading is enabled for the configured operator.`
        : 'Live trading requires TRADING_ENABLED=true, BYBIT_CONNECTOR_ENABLED=true, valid server-side Bybit credentials, and BYBIT_OPERATOR_UID.',
      exchange: 'Bybit',
      environment: config.BYBIT_ENV,
      symbol: config.BYBIT_SYMBOL,
    },
  });
});

router.post('/trade', requireUser, async (req, res, next) => {
  try {
    const { mode = 'demo', side, baseAsset = 'ETH', quoteAsset = 'USDT', amountUsd } = req.body || {};

    if (mode === 'live') {
      if (!liveTradingEnabled()) {
        return res.status(503).json({ error: 'Live Bybit trading is not configured. Ask the CryptoWise operator to configure and verify the server-side exchange settings.' });
      }
      if (req.user.uid !== config.BYBIT_OPERATOR_UID) {
        return res.status(403).json({ error: 'Live Bybit trading is restricted to the configured operator account.' });
      }
      if (baseAsset !== 'ETH' || quoteAsset !== 'USDT' || !['buy', 'sell'].includes(side)) {
        return res.status(400).json({ error: 'Only ETH/USDT buy and sell orders are supported.' });
      }
      const trade = await placeSpotMarketOrder({
        side: side === 'buy' ? 'Buy' : 'Sell',
        quoteAmount: amountUsd,
      });
      return res.status(201).json({ success: true, trade: { ...trade, mode: 'live' } });
    }

    if (mode !== 'demo') return res.status(400).json({ error: 'Trade mode must be demo or live.' });
    const trade = await executeDemoTrade({
      uid: req.user.uid,
      side,
      baseAsset,
      quoteAsset,
      amountUsd,
      idempotencyKey: req.headers['idempotency-key'],
    });
    return res.status(201).json({ success: true, trade });
  } catch (error) {
    if (error.statusCode) return res.status(error.statusCode).json({ error: error.message });
    return next(error);
  }
});

export default router;
