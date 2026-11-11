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
  ETH_CHAIN_ID: z.coerce.number().int().positive().optional(),
  RPC_URL: z.string().url().optional(),
  ETH_DEPOSIT_ADDRESS: z.string().default(''),
  USDT_DEPOSIT_ADDRESS: z.string().default(''),
  USDT_TOKEN_CONTRACT: z.string().default(''),
  DEPOSIT_XPUB: z.string().default(''),
  DEPOSIT_ADDRESS_DERIVATION_ENABLED: z.enum(['true','false']).default('false'),
  DEPOSIT_TESTNET_INTAKE_ENABLED: z.enum(['true','false']).default('false'),
  DEPOSIT_TESTNET_AUTO_CREDIT_ENABLED: z.enum(['true','false']).default('false'),
  WITHDRAWALS_TESTNET_QUEUE_ENABLED: z.enum(['true','false']).default('false'),
  DEPOSIT_MONITOR_ENABLED: z.enum(['true','false']).default('false'),
  DEPOSIT_MONITOR_INTERVAL_MS: z.coerce.number().int().min(5000).max(300000).default(15000),
  DEPOSIT_CONFIRMATIONS_REQUIRED: z.coerce.number().int().min(1).max(10000).default(12),
  SUPPORT_EMAIL: z.string().email().default('support@example.invalid'),
  BYBIT_ENV: z.enum(['testnet','demo','mainnet']).default('testnet'),
  BYBIT_API_KEY: z.string().default(''),
  BYBIT_API_SECRET: z.string().default(''),
  BYBIT_CONNECTOR_ENABLED: z.enum(['true','false']).default('false'),
  BYBIT_CATEGORY: z.enum(['spot']).default('spot'),
  BYBIT_SYMBOL: z.string().regex(/^[A-Z0-9]{5,20}$/).default('ETHUSDT'),
  BYBIT_OPERATOR_UID: z.string().default(''),
  CUSTODY_PROVIDER: z.enum(['disabled','fireblocks','bitgo','gateway']).default('disabled'),
  CUSTODY_ENABLED: z.enum(['true','false']).default('false'),
  CUSTODY_API_URL: z.string().url().optional(),
  CUSTODY_API_TOKEN: z.string().default(''),
  CUSTODY_WEBHOOK_SECRET: z.string().default(''),
  CUSTODY_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60000).default(10000),
  CUSTODY_WITHDRAWALS_ENABLED: z.enum(['true','false']).default('false'),
  FIREBLOCKS_API_BASE_URL: z.string().url().default('https://sandbox-api.fireblocks.io/v1'),
  FIREBLOCKS_API_KEY: z.string().default(''),
  FIREBLOCKS_SECRET_KEY: z.string().default(''),
  FIREBLOCKS_JWKS_URL: z.string().url().default('https://keys.fireblocks.io/.well-known/jwks.json'),
  FIREBLOCKS_SOURCE_VAULT_ACCOUNT_ID: z.string().default(''),
  FIREBLOCKS_DEPOSIT_VAULT_ACCOUNT_ID: z.string().default(''),
  FIREBLOCKS_ETH_ASSET_ID: z.string().default('ETH_TEST5'),
  FIREBLOCKS_USDT_ASSET_ID: z.string().default('USDT_TEST'),
  WITHDRAWAL_MAX_ETH_ATOMIC: z.string().regex(/^[1-9][0-9]{0,77}$/).default('1000000000000000000'),
  WITHDRAWAL_MAX_USDT_ATOMIC: z.string().regex(/^[1-9][0-9]{0,77}$/).default('1000000000'),
  WITHDRAWAL_DAILY_LIMIT_ETH_ATOMIC: z.string().regex(/^[1-9][0-9]{0,77}$/).default('5000000000000000000'),
  WITHDRAWAL_DAILY_LIMIT_USDT_ATOMIC: z.string().regex(/^[1-9][0-9]{0,77}$/).default('5000000000'),
  SCREENING_API_URL: z.string().url().optional(),
  SCREENING_API_TOKEN: z.string().default(''),
  ALERT_WEBHOOK_URL: z.string().url().optional(),
  ALERT_WEBHOOK_TOKEN: z.string().default(''),
  RECOVERY_MODE: z.enum(['normal','freeze_withdrawals']).default('normal'),
  CUSTODY_RECONCILIATION_ENABLED: z.enum(['true','false']).default('false'),
  CUSTODY_RECONCILIATION_INTERVAL_MS: z.coerce.number().int().min(10000).max(3600000).default(60000),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid backend environment configuration:', parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; '));
  process.exit(1);
}

export const config = {
  ...parsed.data,
  ETH_CHAIN_ID: parsed.data.ETH_CHAIN_ID ?? (parsed.data.CHAIN_MODE === 'mainnet' ? 1 : 11155111),
  corsOrigins: parsed.data.CORS_ORIGINS.split(',').map(s => s.trim()).filter(Boolean),
  appCheckRequired: parsed.data.FIREBASE_APP_CHECK_REQUIRED === 'true',
  liveFundsEnabled: parsed.data.LIVE_FUNDS_ENABLED === 'true',
  tradingEnabled: parsed.data.TRADING_ENABLED === 'true',
  bybitConnectorEnabled: parsed.data.BYBIT_CONNECTOR_ENABLED === 'true',
  depositMonitorEnabled: parsed.data.DEPOSIT_MONITOR_ENABLED === 'true',
  depositAddressDerivationEnabled: parsed.data.DEPOSIT_ADDRESS_DERIVATION_ENABLED === 'true',
  depositTestnetIntakeEnabled: parsed.data.DEPOSIT_TESTNET_INTAKE_ENABLED === 'true',
  depositTestnetAutoCreditEnabled: parsed.data.DEPOSIT_TESTNET_AUTO_CREDIT_ENABLED === 'true',
  withdrawalsTestnetQueueEnabled: parsed.data.WITHDRAWALS_TESTNET_QUEUE_ENABLED === 'true',
  custodyProvider: parsed.data.CUSTODY_PROVIDER,
  custodyEnabled: parsed.data.CUSTODY_ENABLED === 'true',
  custodyWithdrawalsEnabled: parsed.data.CUSTODY_WITHDRAWALS_ENABLED === 'true',
  custodyReconciliationEnabled: parsed.data.CUSTODY_RECONCILIATION_ENABLED === 'true',
};

if (config.CHAIN_MODE === 'mainnet' && config.ETH_CHAIN_ID !== 1) {
  throw new Error('Ethereum mainnet monitoring requires ETH_CHAIN_ID=1.');
}
if (config.CHAIN_MODE === 'testnet' && config.ETH_CHAIN_ID !== 11155111) {
  throw new Error('This monitor currently supports Sepolia testnet only (ETH_CHAIN_ID=11155111).');
}
if (config.ETH_CHAIN_ID === 1 && config.USDT_TOKEN_CONTRACT && config.USDT_TOKEN_CONTRACT.toLowerCase() !== '0xdac17f958d2ee523a2206206994597c13d831ec7') {
  throw new Error('Ethereum mainnet USDT_TOKEN_CONTRACT must be the official USDT contract.');
}
if (config.depositMonitorEnabled && !config.depositAddressDerivationEnabled && ![config.ETH_DEPOSIT_ADDRESS, config.USDT_DEPOSIT_ADDRESS].every(a => /^0x[a-fA-F0-9]{40}$/.test(a))) {
  throw new Error('DEPOSIT_MONITOR_ENABLED requires both verified public receiving addresses.');
}
if (config.depositMonitorEnabled && !config.RPC_URL) {
  throw new Error('DEPOSIT_MONITOR_ENABLED requires an explicit RPC_URL for the selected network.');
}
if (config.depositAddressDerivationEnabled && (config.CHAIN_MODE !== 'testnet' || config.ETH_CHAIN_ID !== 11155111 || !/^xpub/.test(config.DEPOSIT_XPUB))) {
  throw new Error('Xpub address derivation is currently restricted to Sepolia testnet and requires a public extended key.');
}
if ((config.depositTestnetIntakeEnabled || config.depositTestnetAutoCreditEnabled || config.withdrawalsTestnetQueueEnabled) && (config.NODE_ENV === 'production' || config.CHAIN_MODE !== 'testnet' || config.ETH_CHAIN_ID !== 11155111 || config.liveFundsEnabled)) {
  throw new Error('Testnet deposit/withdrawal test flags require non-production Sepolia mode with LIVE_FUNDS_ENABLED=false.');
}
if ((config.depositTestnetIntakeEnabled || config.depositTestnetAutoCreditEnabled) && (!config.depositAddressDerivationEnabled || !config.depositMonitorEnabled || !config.DEPOSIT_XPUB)) {
  throw new Error('Testnet deposits require xpub derivation and the read-only monitor to be enabled.');
}
if (config.depositTestnetAutoCreditEnabled && !config.depositTestnetIntakeEnabled) {
  throw new Error('Testnet auto-credit requires testnet deposit intake.');
}

if (config.liveFundsEnabled && config.CHAIN_MODE !== 'mainnet') {
  throw new Error('LIVE_FUNDS_ENABLED requires explicit mainnet configuration; keep it false for MVP testing.');
}

if (config.liveFundsEnabled && (![config.ETH_DEPOSIT_ADDRESS, config.USDT_DEPOSIT_ADDRESS].every(a => /^0x[a-fA-F0-9]{40}$/.test(a)))) {
  throw new Error('Live funds require both validated public Ethereum receiving addresses. Do not provide private keys.');
}
if (config.custodyEnabled && (!config.CUSTODY_API_URL || !config.CUSTODY_API_TOKEN || config.custodyProvider === 'disabled')) {
  throw new Error('CUSTODY_ENABLED requires a supported provider, CUSTODY_API_URL, and server-side CUSTODY_API_TOKEN.');
}
if (config.custodyWithdrawalsEnabled && (!config.custodyEnabled || (config.custodyProvider === 'fireblocks' ? !config.FIREBLOCKS_JWKS_URL : !config.CUSTODY_WEBHOOK_SECRET))) {
  throw new Error('Custody withdrawals require custody and webhook configuration.');
}
if (config.custodyProvider === 'fireblocks' && config.custodyEnabled && (!config.FIREBLOCKS_API_KEY || !config.FIREBLOCKS_SECRET_KEY || !config.FIREBLOCKS_SOURCE_VAULT_ACCOUNT_ID)) {
  throw new Error('Fireblocks custody requires FIREBLOCKS_API_KEY, FIREBLOCKS_SECRET_KEY, and FIREBLOCKS_SOURCE_VAULT_ACCOUNT_ID.');
}
if (config.RECOVERY_MODE === 'freeze_withdrawals' && config.custodyWithdrawalsEnabled) {
  console.warn('RECOVERY_MODE=freeze_withdrawals: custody withdrawal submission is frozen.');
}
