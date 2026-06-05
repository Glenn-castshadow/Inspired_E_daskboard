require('dotenv').config();

const { networkInterfaces } = require('os');

const port    = parseInt(process.env.PORT || '3456', 10);
const dbPath  = process.env.DB_PATH || './inventory.db';
const apiKey  = process.env.API_KEY || '';

// The base URL iPhones use to reach scan pages (e.g. http://192.168.1.100:3456).
// In Docker: set SCAN_BASE_URL in .env.docker — must be the host machine's LAN IP,
// not the container's internal IP.
// Locally: auto-detected from the first non-loopback IPv4 address.
function detectLanIp() {
  const nets = networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return 'localhost';
}

const scanBaseUrl = process.env.SCAN_BASE_URL
  ? process.env.SCAN_BASE_URL.replace(/\/$/, '')
  : `http://${detectLanIp()}:${port}`;

if (!apiKey) {
  console.warn('[warn] API_KEY is not set — server is open to anyone on the network');
}

module.exports = { port, dbPath, apiKey, scanBaseUrl };
