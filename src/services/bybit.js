import crypto from 'node:crypto';
import { config } from '../config.js';

const BASE_URLS = Object.freeze({ testnet: 'https://api-testnet.bybit.com', demo: 'https://api-demo.bybit.com', mainnet: 'https://api.bybit.com' });
const RECV_WINDOW = '5000';

function requireConfigured() {
  if (!config.bybitConnectorEnabled || !config.BYBIT_API_KEY || !config.BYBIT_API_SECRET) {
    throw Object.assign(new Error('Bybit connector is disabled or missing server-side credentials.'), { statusCode: 503 });
  }
}
function queryString(params = {}) { return new URLSearchParams(Object.entries(params).filter(([, value]) => value !== undefined && value !== null && value !== '')).toString(); }
function signedHeaders(method, payload) {
  const timestamp = String(Date.now());
  const body = method === 'GET' ? payload : JSON.stringify(payload || {});
  const signature = crypto.createHmac('sha256', config.BYBIT_API_SECRET).update(timestamp + config.BYBIT_API_KEY + RECV_WINDOW + body).digest('hex');
  return { 'X-BAPI-API-KEY': config.BYBIT_API_KEY, 'X-BAPI-TIMESTAMP': timestamp, 'X-BAPI-RECV-WINDOW': RECV_WINDOW, 'X-BAPI-SIGN': signature, 'Content-Type': 'application/json' };
}
async function request(path, { method = 'GET', params, body, auth = true } = {}) {
  const query = queryString(params); const url = `${BASE_URLS[config.BYBIT_ENV]}${path}${query ? `?${query}` : ''}`;
  const headers = auth ? signedHeaders(method, method === 'GET' ? query : body) : { Accept: 'application/json' };
  const response = await fetch(url, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(body || {}) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.retCode !== 0) throw Object.assign(new Error(data.retMsg || `Bybit request failed (${response.status}).`), { statusCode: response.status >= 400 ? response.status : 502, bybitCode: data.retCode });
  return data.result;
}
export function bybitStatus() { return { enabled: config.bybitConnectorEnabled && Boolean(config.BYBIT_API_KEY && config.BYBIT_API_SECRET), environment: config.BYBIT_ENV, category: config.BYBIT_CATEGORY, symbol: config.BYBIT_SYMBOL, endpoint: BASE_URLS[config.BYBIT_ENV] }; }
export async function getWalletBalance(coins = 'ETH,USDT') { requireConfigured(); return request('/v5/account/wallet-balance', { params: { accountType: 'UNIFIED', coin: coins } }); }
export async function getTicker(symbol = config.BYBIT_SYMBOL) { return request('/v5/market/tickers', { params: { category: config.BYBIT_CATEGORY, symbol }, auth: false }); }
export async function getKlines(symbol = config.BYBIT_SYMBOL, interval = '15', limit = 100) { return request('/v5/market/kline', { params: { category: config.BYBIT_CATEGORY, symbol, interval, limit }, auth: false }); }
export async function placeSpotMarketOrder({ side, quoteAmount }) {
  requireConfigured();
  if (!['Buy', 'Sell'].includes(side)) throw Object.assign(new Error('Bybit side must be Buy or Sell.'), { statusCode: 400 });
  if (!/^\d+(\.\d{1,8})?$/.test(String(quoteAmount)) || Number(quoteAmount) <= 0) throw Object.assign(new Error('Invalid quote amount.'), { statusCode: 400 });
  const ticker = await getTicker(); const price = Number(ticker?.list?.[0]?.lastPrice); if (!Number.isFinite(price) || price <= 0) throw Object.assign(new Error('Bybit market price is unavailable.'), { statusCode: 503 });
  const body = { category: 'spot', symbol: config.BYBIT_SYMBOL, side, orderType: 'Market', qty: side === 'Buy' ? String(quoteAmount) : (Number(quoteAmount) / price).toFixed(8), marketUnit: side === 'Buy' ? 'quoteCoin' : 'baseCoin', orderLinkId: `cw_${crypto.randomUUID().replaceAll('-', '').slice(0, 28)}` };
  const result = await request('/v5/order/create', { method: 'POST', body });
  return { ...result, symbol: config.BYBIT_SYMBOL, side, quoteAmount: String(quoteAmount), referencePrice: String(price), environment: config.BYBIT_ENV };
}
