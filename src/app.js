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
import { bybitStatus } from './services/bybit.js';

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

const fundsEnabled = () => config.liveFundsEnabled && DEPOSIT_CUSTOMER_INTAKE_READY && DEPOSIT_CHAIN_VERIFICATION_READY && DEPOSIT_AUTOMATIC_CREDIT_READY;
const liveTradingEnabled = () => config.tradingEnabled && bybitStatus().enabled && Boolean(config.BYBIT_OPERATOR_UID);

app.get('/health', (_req,res)=>res.status(200).json({ status:'ok', service:'cryptowise-api', mode: config.CHAIN_MODE, fundsEnabled: fundsEnabled(), liveFundsFlag:config.liveFundsEnabled, tradingEnabled: liveTradingEnabled() }));

// --- Added Deposit & Receiving Address Endpoints ---

// Get backend deposit status and readiness
app.get('/v1/deposit/status', (req, res) => {
  const enabled = fundsEnabled();
  res.json({
    status: 'online',
    fundsEnabled: enabled,
    message: enabled ? 'Deposit intake is enabled.' : 'Crypto deposits are paused. Do not send funds; live verification and crediting are not approved.'
  });
});

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
