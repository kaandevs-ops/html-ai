// ============================================================
// 🔐 auth.js — API Key Authentication Middleware
// server.js'e ekle: const auth = require('./auth');
// Korumak istediğin endpoint'e ekle: app.post('/yol', auth, handler)
// Veya tüm route'ları koru: app.use(auth)
// ============================================================

require('dotenv').config();

const VALID_KEYS = new Set([
  process.env.API_KEY,
  // Birden fazla kullanıcı için buraya ekle:
  // 'musteri1_key',
  // 'musteri2_key',
]);

// Whitelist — auth gerektirmeyen endpoint'ler
const PUBLIC_PATHS = [
  '/',
  '/kaan_biometric_full_v5.html',
  '/favicon.ico'
];

function auth(req, res, next) {
  // Public path kontrolü
  if (PUBLIC_PATHS.includes(req.path)) return next();
  if (req.ip === '::1' || req.ip === '127.0.0.1' || req.ip === '::ffff:127.0.0.1') return next();

  // Key'i header, query veya body'den al
  const key =
    req.headers['x-api-key'] ||
    req.query.api_key ||
    req.body?.api_key;

  if (!key || !VALID_KEYS.has(key)) {
    console.warn(`[Auth] ❌ Yetkisiz istek: ${req.method} ${req.path} — IP: ${req.ip}`);
    return res.status(401).json({
      status: 'error',
      message: 'Yetkisiz erişim. API key gerekli.'
    });
  }

  next();
}

module.exports = auth;
