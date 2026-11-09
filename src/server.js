import { app } from './app.js';
import { config } from './config.js';
import { startDepositMonitor } from './services/depositMonitor.js';

const PORT = config.PORT || 10000;
const NODE_ENV = config.NODE_ENV || 'development';

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`CryptoWise API listening on port ${PORT} in ${NODE_ENV} mode`);
  
  // Start background monitoring worker
  startDepositMonitor();
});

function shutdown(signal) {
  console.log(`${signal} received; closing HTTP server.`);
  server.close(error => { 
    if (error) { 
      console.error('Server shutdown failed:', error); 
      process.exit(1); 
    } 
    process.exit(0); 
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));     