require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { port } = require('./config');

// Initialise DB (runs CREATE TABLE IF NOT EXISTS on startup)
require('./database');

const requireApiKey = require('./middleware/auth');

const app = express();

app.use(cors({ origin: false }));   // same-network clients only, no browser CORS needed
app.use(express.json());

// ── Health check (no auth — lets the Tauri app test connectivity) ─────────────
app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'castshadow-inventory', version: '1.0.0' });
});

// ── All routes below require a valid API key ─────────────────────────────────
app.use(requireApiKey);

app.use('/inventory', require('./routes/inventory'));
app.use('/products',  require('./routes/products'));

// ── Global error handler ─────────────────────────────────────────────────────
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  console.error('[error]', err);
  res.status(500).json({ error: err.message || 'Internal server error' });
});

app.listen(port, () => {
  console.log(`[inventory-server] Listening on port ${port}`);
  console.log(`[inventory-server] Health: http://localhost:${port}/health`);
});
