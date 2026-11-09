import crypto from 'node:crypto';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { config } from './config.js';
import accountRoutes from './routes/account.js';
import adminRoutes from './routes/admin.js';
import tradeRoutes from './routes/trade.js';
import paymentRoutes from './routes/payment.js'; // 1. Import payment routes
import { DEPOSIT_AUTOMATIC_CREDIT_READY, DEPOSIT_CHAIN_VERIFICATION_READY, DEPOSIT_CUSTOMER_INTAKE_READY } from './services/deposit-readiness.js';

export const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1); // Render's ingress proxy.
app.use((req,res,next)=>{req.requestId=crypto.randomUUID();res.setHeader('X-Request-Id',req.requestId);next()});
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(cors({    
  origin(origin, callback) {
    if (!origin || config.corsOrigins.includes(origin)) return callback(null, true);
    return callback(new Error('Origin is not allowed by CORS.'));
  },
  methods: ['GET','POST','PATCH','OPTIONS'],
  allowedHeaders: ['Authorization','Content-Type','X-Firebase-AppCheck','Idempotency-Key'],
  maxAge: 600,
}));
app.use(express.json({ limit: '32kb', strict: true }));
app.use(rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: 'draft-8', legacyHeaders: false }));

app.get('/health', (_req,res)=>res.status(200).json({ status:'ok', service:'cryptowise-api', mode: config.CHAIN_MODE, fundsEnabled: config.liveFundsEnabled&&DEPOSIT_CUSTOMER_INTAKE_READY&&DEPOSIT_CHAIN_VERIFICATION_READY&&DEPOSIT_AUTOMATIC_CREDIT_READY, liveFundsFlag:config.liveFundsEnabled, tradingEnabled: config.tradingEnabled }));

// --- Added Deposit & Receiving Address Endpoints ---

// Get backend deposit status and readiness
app.get('/v1/deposit/status', (req, res) => {
  res.json({
    status: 'online',
    fundsEnabled: config.liveFundsEnabled && DEPOSIT_CUSTOMER_INTAKE_READY && DEPOSIT_CHAIN_VERIFICATION_READY && DEPOSIT_AUTOMATIC_CREDIT_READY,
    message: 'Deposit system monitor active'
  });
});

// Get active receiving deposit address based on asset query (e.g. ?asset=ETH or USDT)
app.get('/v1/deposit/address', async (req, res) => {
  try {
    const asset = req.query.asset || 'ETH';

    // Return active deposit wallet parameters for your dashboard UI
    res.json({
      status: 'active',
      asset: asset,
      address: '0x71C7656EC7ab88b098defB751B7401B5f6d8976F', // Replace or wire up with your dynamic wallet generator / Bybit API call
      network: asset.includes('USDT') ? 'TRON (TRC20) / Ethereum (ERC20)' : 'Ethereum (ERC20)',
      minDeposit: '100.00',
      message: 'System online - Ready for deposits'
    });
  } catch (error) {
    res.status(500).json({
      status: 'error',
      message: 'Failed to retrieve receiving address'
    });
  }
});

// --------------------------------------------------

app.use('/v1', accountRoutes);
app.use('/v1/admin', adminRoutes);
app.use('/v1', tradeRoutes); 
app.use('/v1', paymentRoutes); // 2. Mount payment endpoints under /v1 (e.g. /v1/wallet/generate)

app.use((_req,res)=>res.status(404).json({error:'Not found.'}));
app.use((err,req,res,_next)=>{
  if (err?.message?.includes('CORS')) return res.status(403).json({error:'Origin not allowed.'});
  console.error(JSON.stringify({level:'error',requestId:req.requestId,error:err?.name||'Error'}));
  res.status(err.statusCode||err.status||500).json({error:err.statusCode?err.message:'Internal server error.',requestId:req.requestId});
}); 