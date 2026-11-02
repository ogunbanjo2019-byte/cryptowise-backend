import { app } from './app.js';
import { config } from './config.js';
const server = app.listen(config.PORT, '0.0.0.0', () => console.log(`CryptoWise API listening on ${config.PORT}`));
function shutdown(signal) {
  console.log(`${signal} received; closing HTTP server.`);
  server.close(error => { if (error) { console.error('Shutdown failed.'); process.exit(1); } process.exit(0); });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
