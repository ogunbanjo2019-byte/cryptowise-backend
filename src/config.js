import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development','test','production']).default('development'),
  PORT: z.coerce.number().int().positive().default(10000),
  FIREBASE_PROJECT_ID: z.string().min(1),
  FIREBASE_SERVICE_ACCOUNT_JSON: z.string().min(2),
  CORS_ORIGINS: z.string().min(1),
  FIREBASE_APP_CHECK_REQUIRED: z.enum(['true','false']).default('false'),
  LIVE_FUNDS_ENABLED: z.enum(['true','false']).default('false'),
  TRADING_ENABLED: z.enum(['true','false']).default('false'),
  CHAIN_MODE: z.enum(['testnet','mainnet']).default('testnet'),
  ETH_DEPOSIT_ADDRESS: z.string().default(''),
  USDT_DEPOSIT_ADDRESS: z.string().default(''),
  SUPPORT_EMAIL: z.string().email().default('support@example.invalid'),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid backend environment configuration:', parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; '));
  process.exit(1);
}

export const config = {
  ...parsed.data,
  corsOrigins: parsed.data.CORS_ORIGINS.split(',').map(s => s.trim()).filter(Boolean),
  appCheckRequired: parsed.data.FIREBASE_APP_CHECK_REQUIRED === 'true',
  liveFundsEnabled: parsed.data.LIVE_FUNDS_ENABLED === 'true',
  tradingEnabled: parsed.data.TRADING_ENABLED === 'true',
};

if (config.liveFundsEnabled && config.CHAIN_MODE !== 'mainnet') {
  throw new Error('LIVE_FUNDS_ENABLED requires explicit mainnet configuration; keep it false for MVP testing.');
}

if (config.liveFundsEnabled && (![config.ETH_DEPOSIT_ADDRESS, config.USDT_DEPOSIT_ADDRESS].every(a => /^0x[a-fA-F0-9]{40}$/.test(a)))) {
  throw new Error('Live funds require both validated public Ethereum receiving addresses. Do not provide private keys.');
}