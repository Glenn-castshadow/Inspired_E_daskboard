require('dotenv').config();

const port = parseInt(process.env.PORT || '3456', 10);
const dbPath = process.env.DB_PATH || './inventory.db';
const apiKey = process.env.API_KEY || '';

if (!apiKey) {
  console.warn('[warn] API_KEY is not set — server is open to anyone on the network');
}

module.exports = { port, dbPath, apiKey };
