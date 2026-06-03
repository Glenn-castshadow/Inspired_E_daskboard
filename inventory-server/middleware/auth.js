const { apiKey } = require('../config');

module.exports = function requireApiKey(req, res, next) {
  // If no key is configured, allow all (development / first-run).
  if (!apiKey) return next();

  const header = req.headers['authorization'] || '';
  if (!header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing Authorization: Bearer <key> header' });
  }

  const token = header.slice(7).trim();
  if (token !== apiKey) {
    return res.status(403).json({ error: 'Invalid API key' });
  }

  next();
};
