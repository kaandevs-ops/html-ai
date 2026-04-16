// ============================================================
// 📍 locationService.js — Konum Servisi v1
//
// İki aşamalı konum tespiti:
//   1. IP bazlı   → her platformda çalışır, kurulum yok
//   2. Native GPS → Mac (CoreLocation) + Windows (Sensors API)
//
// Brain ile TAM entegre:
//   - Konum brain hafızasına kaydedilir
//   - enrichPrompt'a otomatik eklenir
//   - userProfile güncellenir
//
// KURULUM — server.js'in sonuna ekle (turkishAiRouter'dan önce):
//   const { mountLocationService } = require('./locationService');
//   mountLocationService(app, brain, axios, { exec, isMac, isWindows });
//
// Mevcut hiçbir dosyaya dokunmaz.
// ============================================================

'use strict';

const fs   = require('fs');
const path = require('path');

// ── Konum cache ────────────────────────────────────────────
const _state = {
  current:       null,   // son bilinen konum
  lastUpdated:   null,
  source:        null,   // 'ip' | 'native' | 'manual'
  updateInterval: null,
  enabled:       true,
};

// ── IP bazlı konum (ücretsiz, kurulum yok) ────────────────
async function _getLocationByIP(axios) {
  const providers = [
    'https://ipapi.co/json/',
    'http://ip-api.com/json/?fields=status,country,regionName,city,lat,lon,timezone,isp',
    'https://ipwho.is/',
  ];

  for (const url of providers) {
    try {
      const r = await axios.get(url, { timeout: 5000 });
      const d = r.data;

      // Her provider farklı field adı kullanıyor, normalize et
      const city     = d.city     || d.city_name  || null;
      const country  = d.country  || d.country_name || d.country_code || null;
      const region   = d.region   || d.regionName  || d.region_name   || null;
      const lat      = d.latitude || d.lat         || null;
      const lon      = d.longitude|| d.lon         || d.lng           || null;
      const timezone = d.timezone || d.time_zone?.id || null;
      const isp      = d.org      || d.isp         || null;

      if (city || country) {
        return { city, country, region, lat, lon, timezone, isp, source: 'ip' };
      }
    } catch (_) {
      // Bir provider çalışmadıysa diğerini dene
    }
  }
  return null;
}

// ── Mac native konum (CoreLocation via osascript) ─────────
function _getMacLocation(exec) {
  return new Promise(resolve => {
    // Mac'te CoreLocation'a doğrudan osascript erişimi yok,
    // ama WiFi bazlı konum tespiti için airport komutunu kullanabiliriz.
    // En güvenilir yol: system_profiler ile timezone okuyup şehir tahmin et.
    const script = `
      tell application "System Events"
        set tzName to time zone of (current date)
      end tell
      return tzName
    `;

    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) { settled = true; resolve(null); }
    }, 4000);

    try {
      const child = exec(`osascript -e '${script.replace(/\n/g, ' ')}'`, (err, stdout) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err || !stdout) return resolve(null);
        const tz = stdout.trim();
        // Timezone'dan şehir tahmin et (Europe/Istanbul → Istanbul)
        const parts = tz.split('/');
        const city  = parts.length > 1 ? parts[parts.length - 1].replace(/_/g, ' ') : null;
        resolve(city ? { city, timezone: tz, source: 'native_mac' } : null);
      });
      if (child?.on) child.on('error', () => {
        if (!settled) { settled = true; clearTimeout(timer); resolve(null); }
      });
    } catch (e) {
      if (!settled) { settled = true; clearTimeout(timer); resolve(null); }
    }
  });
}

// ── Windows native konum (PowerShell) ────────────────────
function _getWindowsLocation(exec) {
  return new Promise(resolve => {
    // Windows'ta timezone'dan şehir tahmini
    const cmd = `powershell -NoProfile -Command "Get-TimeZone | Select-Object -ExpandProperty Id"`;

    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) { settled = true; resolve(null); }
    }, 4000);

    try {
      const child = exec(cmd, (err, stdout) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err || !stdout) return resolve(null);
        const tz = stdout.trim();
        // "Turkey Standard Time" → "Turkey"
        const city = tz.replace(' Standard Time', '').replace(' Daylight Time', '').trim();
        resolve(city ? { city, timezone: tz, source: 'native_windows' } : null);
      });
      if (child?.on) child.on('error', () => {
        if (!settled) { settled = true; clearTimeout(timer); resolve(null); }
      });
    } catch (e) {
      if (!settled) { settled = true; clearTimeout(timer); resolve(null); }
    }
  });
}

// ── Ana konum tespiti (iki aşamalı) ──────────────────────
async function detectLocation(axios, exec, isMac, isWindows) {
  // Aşama 1: IP bazlı (hızlı, her platformda çalışır)
  const ipLocation = await _getLocationByIP(axios);

  // Aşama 2: Native (daha doğru şehir/timezone)
  let nativeLocation = null;
  try {
    if (isMac)     nativeLocation = await _getMacLocation(exec);
    if (isWindows) nativeLocation = await _getWindowsLocation(exec);
  } catch (_) {}

  // İkisini birleştir — native şehri varsa onu tercih et, IP'den lat/lon al
  if (ipLocation && nativeLocation) {
    return {
      ...ipLocation,
      city:     nativeLocation.city     || ipLocation.city,
      timezone: nativeLocation.timezone || ipLocation.timezone,
      source:   'ip+native',
    };
  }

  return ipLocation || nativeLocation || null;
}

// ── Brain'e konum kaydet ──────────────────────────────────
function _saveToBrain(brain, location) {
  if (!brain || !location) return;

  try {
    // Hafızaya kaydet
    brain.mem.remember('user:location:city',     location.city     || 'bilinmiyor', 0.9);
    brain.mem.remember('user:location:country',  location.country  || 'bilinmiyor', 0.9);
    brain.mem.remember('user:location:timezone', location.timezone || 'bilinmiyor', 0.8);
    if (location.lat && location.lon) {
      brain.mem.remember('user:location:coords', `${location.lat},${location.lon}`, 0.7);
    }

    // userProfile'e de bildir
    const locationStr = [location.city, location.region, location.country]
      .filter(Boolean).join(', ');
    brain.userProfile?.onInteraction?.(
      `Konum güncellendi: ${locationStr}`,
      `Kullanıcı konumu: ${locationStr}`,
      { emotion: 'neutral' }
    );

    console.log(`[LocationService] 📍 Konum kaydedildi: ${locationStr} (${location.source})`);
  } catch (e) {
    console.warn('[LocationService] Brain kayıt hatası:', e.message);
  }
}

// ── Konum bazlı LLM prompt ────────────────────────────────
function getLocationPrompt() {
  if (!_state.current) return '';

  const loc = _state.current;
  const parts = [];

  if (loc.city)    parts.push(loc.city);
  if (loc.region && loc.region !== loc.city) parts.push(loc.region);
  if (loc.country) parts.push(loc.country);

  const locationStr = parts.join(', ');
  const timeStr     = loc.timezone
    ? ` (Saat dilimi: ${loc.timezone})`
    : '';

  return `=== KULLANICI KONUMU ===\nBulunduğu yer: ${locationStr}${timeStr}\nKonum kaynağı: ${loc.source}`;
}

// ── Mount ──────────────────────────────────────────────────
function mountLocationService(app, brain, axios, deps = {}) {
  const { exec, isMac, isWindows } = deps;

  if (!app || !axios) {
    console.warn('[LocationService] ⚠️ Eksik parametre, mount atlandı.');
    return;
  }

  // ── Brain enrichPrompt'una konum bağlamı ekle ─────────
  const _originalEnrich = brain?.enrichPrompt?.bind(brain);
  if (_originalEnrich) {
    brain.enrichPrompt = function (userPrompt) {
      const base    = _originalEnrich(userPrompt);
      const locCtx  = getLocationPrompt();
      if (!locCtx) return base;

      const marker = '=== KULLANICI İSTEĞİ ===';
      if (base.includes(marker)) {
        return base.replace(marker, locCtx + '\n\n' + marker);
      }
      return locCtx + '\n\n' + base;
    };
    console.log('[LocationService] 🧠 brain.enrichPrompt konum bağlamıyla genişletildi.');
  }

  // ── İlk konum tespiti (başlangıçta) ──────────────────
  async function _refresh() {
    if (!_state.enabled) return;
    try {
      const location = await detectLocation(axios, exec, isMac, isWindows);
      if (location) {
        _state.current     = location;
        _state.lastUpdated = new Date().toISOString();
        _state.source      = location.source;
        _saveToBrain(brain, location);
      }
    } catch (e) {
      console.warn('[LocationService] Konum güncellenemedi:', e.message);
    }
  }

  // Başlangıçta çalıştır
  setTimeout(_refresh, 2000);

  // Her 30 dakikada bir güncelle (IP konum değişebilir)
  _state.updateInterval = setInterval(_refresh, 30 * 60 * 1000);

  // ────────────────────────────────────────────────────────
  // GET /location — Mevcut konum
  // ────────────────────────────────────────────────────────
  app.get('/location', (req, res) => {
    res.json({
      status:      'success',
      location:    _state.current,
      lastUpdated: _state.lastUpdated,
      source:      _state.source,
      prompt:      getLocationPrompt() || null,
    });
  });

  // ────────────────────────────────────────────────────────
  // POST /location/refresh — Konumu yenile
  // ────────────────────────────────────────────────────────
  app.post('/location/refresh', async (req, res) => {
    await _refresh();
    res.json({
      status:   'success',
      location: _state.current,
      source:   _state.source,
    });
  });

  // ────────────────────────────────────────────────────────
  // POST /location/manual — Manuel konum gir
  // Body: { city, country, timezone? }
  // ────────────────────────────────────────────────────────
  app.post('/location/manual', (req, res) => {
    const { city, country, timezone } = req.body;
    if (!city) return res.json({ status: 'error', message: 'city gerekli' });

    _state.current = {
      city, country: country || null,
      timezone: timezone || null,
      source: 'manual',
      lat: null, lon: null,
    };
    _state.lastUpdated = new Date().toISOString();
    _state.source = 'manual';
    _saveToBrain(brain, _state.current);

    res.json({ status: 'success', location: _state.current });
  });

  // ────────────────────────────────────────────────────────
  // POST /location/toggle — Konum servisini aç/kapat
  // ────────────────────────────────────────────────────────
  app.post('/location/toggle', (req, res) => {
    _state.enabled = !_state.enabled;
    res.json({ status: 'success', enabled: _state.enabled });
  });

  console.log('[LocationService] 📍 v1 yüklendi. Endpoint\'ler:');
  console.log('  GET  /location          → mevcut konum');
  console.log('  POST /location/refresh  → konumu yenile');
  console.log('  POST /location/manual   → manuel konum {city, country}');
  console.log('  POST /location/toggle   → aç/kapat');

  return { detectLocation, getLocationPrompt, refresh: _refresh };
}

module.exports = { mountLocationService, detectLocation, getLocationPrompt };
