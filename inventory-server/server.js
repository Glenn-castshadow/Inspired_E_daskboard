require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { port } = require('./config');

// Initialise DB (runs CREATE TABLE IF NOT EXISTS on startup)
require('./database');

const requireApiKey = require('./middleware/auth');

const app = express();

app.use(cors({ origin: false }));   // same-network clients only, no browser CORS needed
app.use(express.json({ limit: '50mb' }));  // Lightburn files sent as base64 can be several MB

// ── Health check (no auth — lets the Tauri app test connectivity) ─────────────
app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'castshadow-inventory', version: '1.0.0' });
});

// Scan routes — no auth required (iPhone users, no API key)
app.use('/m', require('./routes/scan'));

// Label routes — per-route auth (print/qr public, generate/counts protected)
app.use('/labels', require('./routes/labels'));

// ── All routes below require a valid API key ─────────────────────────────────
app.use(requireApiKey);

app.use('/inventory',  require('./routes/inventory'));
app.use('/products',   require('./routes/products'));
app.use('/lightburn',  require('./routes/lightburn'));

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
