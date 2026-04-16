// ============================================================
// 🌐 webMonitor.js — Sürekli Web İzleme Motoru v1.0
//
// Mevcut hiçbir dosyaya dokunmaz.
// server.js'in EN SONUNA şunu ekle:
//
//   const { mountWebMonitor } = require('./webMonitor');
//   mountWebMonitor(app, brain, axios, proactiveEngine, { cron, PORT });
//
// Özellikler:
//   ✅ URL listesi izlenir, içerik değişince bildirim gönderilir
//   ✅ Diff algoritması — küçük değişiklikler filtrelenir (eşik ayarlanabilir)
//   ✅ GitHub repo değişimi, fiyat değişimi, haber takibi
//   ✅ Selector desteği (sayfanın yalnızca belirli bölümü izlenir)
//   ✅ Cron ile kontrol aralığı ayarlanabilir
//   ✅ Brain hafızasına önceki içerik kaydedilir (diff için)
//   ✅ /monitor/* endpoint'leri ile yönetim
// ============================================================

'use strict';

const fs   = require('fs');
const path = require('path');

const MONITORS_FILE = path.join(process.cwd(), 'web_monitors.json');

// ── Monitor deposu ─────────────────────────────────────────
let _monitors = {};   // { id: MonitorDef }
let _history  = {};   // { id: [{ ts, snippet, changed }] }
let _cronJobs = {};   // { id: cronJob }

function _loadMonitors() {
  try {
    if (fs.existsSync(MONITORS_FILE)) {
      const data = JSON.parse(fs.readFileSync(MONITORS_FILE, 'utf-8'));
      _monitors = data.monitors || {};
      _history  = data.history  || {};
      console.log(`[WebMonitor] 📂 ${Object.keys(_monitors).length} monitor yüklendi`);
    }
  } catch (e) {
    console.warn('[WebMonitor] ⚠️ Yükleme hatası:', e.message);
  }
}

function _saveMonitors() {
  try {
    fs.writeFileSync(MONITORS_FILE, JSON.stringify({ monitors: _monitors, history: _history }, null, 2));
  } catch (e) {}
}

// ── Basit metin benzerlik skoru (0-1, 1=aynı) ─────────────
function _similarity(a, b) {
  if (!a || !b) return 0;
  if (a === b)  return 1;
  const sa = a.split(/\s+/);
  const sb = b.split(/\s+/);
  const setA = new Set(sa), setB = new Set(sb);
  let inter = 0;
  setA.forEach(w => { if (setB.has(w)) inter++; });
  const union = setA.size + setB.size - inter;
  return union === 0 ? 1 : inter / union;
}

// ── Sayfa içeriği çek ─────────────────────────────────────
async function _fetchContent(url, selector, axios, PORT) {
  try {
    // Mevcut /assistant/browser/extract endpoint'ini kullan
    const r = await axios.post(
      `http://localhost:${PORT}/assistant/browser/extract`,
      { url, selector: selector || 'body' },
      { timeout: 30000 }
    );
    const text = (r.data?.text || '').replace(/\s+/g, ' ').trim();
    return text.slice(0, 5000);
  } catch (e) {
    // Fallback: doğrudan axios GET (HTML)
    try {
      const r2 = await axios.get(url, { timeout: 20000, headers: { 'User-Agent': 'KaanAI-Monitor/1.0' } });
      const html = typeof r2.data === 'string' ? r2.data : JSON.stringify(r2.data);
      // Basit HTML temizleme
      const text = html
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      return text.slice(0, 5000);
    } catch (e2) {
      console.warn(`[WebMonitor] ⚠️ İçerik alınamadı: ${url} — ${e2.message.slice(0, 60)}`);
      return null;
    }
  }
}

// ── Tek monitor kontrol ────────────────────────────────────
async function _checkMonitor(monitor, axios, brain, proactiveEngine, PORT) {
  const { id, url, name, selector, changeThreshold = 0.05, notifyOnChange = true } = monitor;

  console.log(`[WebMonitor] 🔍 Kontrol: "${name}" → ${url.slice(0, 60)}`);

  const content = await _fetchContent(url, selector, axios, PORT);
  if (!content) {
    _updateHistory(id, null, false, 'fetch_error');
    return null;
  }

  // Önceki içeriği brain hafızasından al
  const prevEntries = brain.mem.recall(`webmonitor:${id}`, 1);
  const prevContent = prevEntries.length ? prevEntries[0].value : null;

  const sim     = prevContent ? _similarity(content, prevContent) : 1;
  const changed = prevContent ? (1 - sim) >= changeThreshold : false;

  // Güncel içeriği kaydet
  brain.mem.remember(`webmonitor:${id}`, content.slice(0, 500), 0.8);

  _updateHistory(id, content.slice(0, 300), changed);

  if (changed && notifyOnChange) {
    const changePct = Math.round((1 - sim) * 100);
    const message   = `🔔 Değişiklik tespit edildi!\n\n📌 "${name}"\n🌐 ${url}\n📊 Değişim: %${changePct}\n\n📝 Güncel içerik:\n${content.slice(0, 300)}...`;

    console.log(`[WebMonitor] ⚡ Değişiklik: "${name}" (%${changePct} farklı)`);

    if (proactiveEngine?.sendManual) {
      await proactiveEngine.sendManual(message, ['chat', 'desktop']);
    }

    try {
      brain.learn(`WebMonitor değişiklik: ${name}`, `%${changePct} değişim`);
    } catch (e) {}
  }

  monitor.lastChecked  = new Date().toISOString();
  monitor.lastChanged  = changed ? new Date().toISOString() : (monitor.lastChanged || null);
  monitor.checkCount   = (monitor.checkCount || 0) + 1;
  monitor.changeCount  = (monitor.changeCount || 0) + (changed ? 1 : 0);
  _saveMonitors();

  return { id, url, name, changed, similarity: +sim.toFixed(3) };
}

function _updateHistory(id, snippet, changed, error = null) {
  if (!_history[id]) _history[id] = [];
  _history[id].unshift({ ts: new Date().toISOString(), snippet, changed, error });
  if (_history[id].length > 20) _history[id].pop();
}

// ── Monitor oluştur / güncelle ────────────────────────────
function createMonitor(def) {
  const id = def.id || `mon_${Date.now()}`;
  _monitors[id] = {
    id,
    name:            def.name || def.url,
    url:             def.url,
    selector:        def.selector || null,
    checkIntervalMin: def.checkIntervalMin || 60,    // dakika
    changeThreshold: def.changeThreshold || 0.05,   // 0-1 (5%)
    notifyOnChange:  def.notifyOnChange !== false,
    enabled:         def.enabled !== false,
    tags:            def.tags || [],
    createdAt:       new Date().toISOString(),
    lastChecked:     null,
    lastChanged:     null,
    checkCount:      0,
    changeCount:     0,
  };
  _saveMonitors();
  return _monitors[id];
}

// ══════════════════════════════════════════════════════════
// 🔌 MOUNT
// ══════════════════════════════════════════════════════════
function mountWebMonitor(app, brain, axios, proactiveEngine, deps = {}) {
  const { cron, PORT } = deps;
  const port = PORT || 3000;

  if (!app || !brain || !axios) {
    console.warn('[WebMonitor] ⚠️ Eksik parametre, mount atlandı.');
    return;
  }

  _loadMonitors();

  // ── Mevcut monitor'lar için cron başlat ───────────────
  function _startCron(monitor) {
    if (!cron) return;
    const intervalMin = monitor.checkIntervalMin || 60;

    // node-cron her X dakika için '*/X * * * *' formatı — max 60dk
    const cronMin = intervalMin < 60 ? `*/${intervalMin} * * * *` : intervalMin === 60 ? '0 * * * *' : `0 */${Math.floor(intervalMin / 60)} * * *`;

    if (_cronJobs[monitor.id]) {
      _cronJobs[monitor.id].stop();
    }

    _cronJobs[monitor.id] = cron.schedule(cronMin, async () => {
      if (!monitor.enabled || !_monitors[monitor.id]) return;
      await _checkMonitor(_monitors[monitor.id], axios, brain, proactiveEngine, port);
    }, { timezone: 'Europe/Istanbul' });

    console.log(`[WebMonitor] ⏰ Cron: "${monitor.name}" her ${intervalMin} dk`);
  }

  // Yüklenen monitor'lar için cron'ları başlat
  Object.values(_monitors).forEach(m => {
    if (m.enabled) _startCron(m);
  });

  // ── Monitor ekle ──────────────────────────────────────
  app.post('/monitor/add', (req, res) => {
    const { url, name, selector, checkIntervalMin, changeThreshold, notifyOnChange, tags } = req.body;
    if (!url) return res.json({ status: 'error', message: 'url gerekli' });

    const monitor = createMonitor({ url, name, selector, checkIntervalMin, changeThreshold, notifyOnChange, tags });
    _startCron(monitor);

    res.json({ status: 'success', monitor, message: `"${monitor.name}" izlemeye alındı` });
  });

  // ── Monitor listele ───────────────────────────────────
  app.get('/monitor/list', (req, res) => {
    const tag = req.query.tag;
    let list = Object.values(_monitors);
    if (tag) list = list.filter(m => (m.tags || []).includes(tag));
    res.json({ status: 'success', count: list.length, monitors: list });
  });

  // ── Manuel kontrol et ─────────────────────────────────
  app.post('/monitor/check/:id', async (req, res) => {
    const monitor = _monitors[req.params.id];
    if (!monitor) return res.json({ status: 'error', message: 'Monitor bulunamadı' });

    const result = await _checkMonitor(monitor, axios, brain, proactiveEngine, port);
    res.json({ status: 'success', result });
  });

  // ── Tüm monitor'ları kontrol et ───────────────────────
  app.post('/monitor/check-all', async (req, res) => {
    const monitors = Object.values(_monitors).filter(m => m.enabled);
    res.json({ status: 'accepted', message: `${monitors.length} monitor arka planda kontrol ediliyor` });

    for (const m of monitors) {
      await _checkMonitor(m, axios, brain, proactiveEngine, port);
      await new Promise(r => setTimeout(r, 2000)); // rate limit
    }
  });

  // ── Geçmiş ───────────────────────────────────────────
  app.get('/monitor/history/:id', (req, res) => {
    const history = _history[req.params.id] || [];
    res.json({ status: 'success', id: req.params.id, history });
  });

  // ── Monitor aç/kapat ──────────────────────────────────
  app.post('/monitor/toggle/:id', (req, res) => {
    const monitor = _monitors[req.params.id];
    if (!monitor) return res.json({ status: 'error', message: 'Bulunamadı' });
    monitor.enabled = !monitor.enabled;
    if (monitor.enabled) _startCron(monitor);
    else if (_cronJobs[monitor.id]) { _cronJobs[monitor.id].stop(); delete _cronJobs[monitor.id]; }
    _saveMonitors();
    res.json({ status: 'success', id: monitor.id, enabled: monitor.enabled });
  });

  // ── Monitor sil ───────────────────────────────────────
  app.delete('/monitor/:id', (req, res) => {
    const id = req.params.id;
    if (!_monitors[id]) return res.json({ status: 'error', message: 'Bulunamadı' });
    const name = _monitors[id].name;
    if (_cronJobs[id]) { _cronJobs[id].stop(); delete _cronJobs[id]; }
    delete _monitors[id];
    delete _history[id];
    _saveMonitors();
    res.json({ status: 'success', message: `"${name}" silindi` });
  });

  // ── Monitor güncelle ──────────────────────────────────
  app.put('/monitor/:id', (req, res) => {
    const monitor = _monitors[req.params.id];
    if (!monitor) return res.json({ status: 'error', message: 'Bulunamadı' });
    const { name, selector, checkIntervalMin, changeThreshold, notifyOnChange, tags, enabled } = req.body;
    if (name              !== undefined) monitor.name             = name;
    if (selector          !== undefined) monitor.selector         = selector;
    if (checkIntervalMin  !== undefined) monitor.checkIntervalMin = checkIntervalMin;
    if (changeThreshold   !== undefined) monitor.changeThreshold  = changeThreshold;
    if (notifyOnChange    !== undefined) monitor.notifyOnChange   = notifyOnChange;
    if (tags              !== undefined) monitor.tags             = tags;
    if (typeof enabled === 'boolean')    monitor.enabled          = enabled;
    _saveMonitors();
    if (monitor.enabled) _startCron(monitor);
    res.json({ status: 'success', monitor });
  });

  // ── İstatistikler ─────────────────────────────────────
  app.get('/monitor/stats', (req, res) => {
    const monitors = Object.values(_monitors);
    res.json({
      status: 'success',
      total:       monitors.length,
      enabled:     monitors.filter(m => m.enabled).length,
      totalChecks: monitors.reduce((s, m) => s + (m.checkCount || 0), 0),
      totalChanges: monitors.reduce((s, m) => s + (m.changeCount || 0), 0),
      mostActive:  monitors.sort((a, b) => (b.changeCount || 0) - (a.changeCount || 0))[0]?.name || null,
    });
  });

  // ── Örnek monitor'lar ─────────────────────────────────
  app.post('/monitor/examples', async (req, res) => {
    const examples = [
      {
        name: 'GitHub Trending',
        url: 'https://github.com/trending',
        checkIntervalMin: 120,
        changeThreshold: 0.1,
        tags: ['tech', 'github'],
      },
      {
        name: 'Hacker News',
        url: 'https://news.ycombinator.com',
        checkIntervalMin: 60,
        changeThreshold: 0.08,
        tags: ['news', 'tech'],
      },
    ];

    const created = examples.map(e => {
      const m = createMonitor(e);
      _startCron(m);
      return m.name;
    });

    res.json({ status: 'success', message: `${created.length} örnek monitor eklendi`, created });
  });

  console.log('[WebMonitor] 🔌 Mount tamamlandı.');
  console.log('  POST /monitor/add           → monitor ekle {url, name, checkIntervalMin}');
  console.log('  GET  /monitor/list          → listele ?tag=...');
  console.log('  POST /monitor/check/:id     → manuel kontrol');
  console.log('  POST /monitor/check-all     → hepsini kontrol et');
  console.log('  GET  /monitor/history/:id   → değişiklik geçmişi');
  console.log('  POST /monitor/toggle/:id    → aç/kapat');
  console.log('  PUT  /monitor/:id           → güncelle');
  console.log('  DELETE /monitor/:id         → sil');
  console.log('  GET  /monitor/stats         → istatistik');
  console.log('  POST /monitor/examples      → örnek monitor\'lar ekle');

  return { createMonitor };
}

module.exports = { mountWebMonitor, createMonitor };
