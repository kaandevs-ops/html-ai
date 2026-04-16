// ============================================================
// ⚡ eventTriggers.js — Event-Driven Tetikleyiciler v1.0
//
// Orijinal hiçbir dosyaya dokunmaz.
// server.js'e sadece şunu ekle (EN SONA):
//   const { mountEventTriggers } = require('./eventTriggers');
//   mountEventTriggers(app, autoAgent, brain, { fs, path, exec, chokidar, cron });
//
// Sağladığı özellikler:
//   ✅ Dosya watcher — belirli klasörleri izler, değişince agent'a bildirir
//   ✅ Cron tabanlı görevler — tanımlı saatlerde otomatik tetikler
//   ✅ Idle algılama — kullanıcı 10+ dk aktif değilse arka plan işi yapar
//   ✅ /triggers/* endpoint'leri ile runtime yönetim
// ============================================================

'use strict';

// ── Tetikleyici durumu ────────────────────────────────────
const TRIGGER_STATE = {
  watchers: {},          // klasör → chokidar watcher
  cronJobs: {},          // isim → cron job
  lastUserActivity: Date.now(),
  idleThresholdMs: 10 * 60 * 1000,  // 10 dakika
  idleCheckInterval: null,
  eventLog: [],          // son 50 event
  enabled: true
};

function _logEvent(type, message, data) {
  const entry = { ts: Date.now(), type, message, data: data || null };
  TRIGGER_STATE.eventLog.unshift(entry);
  if (TRIGGER_STATE.eventLog.length > 50) TRIGGER_STATE.eventLog.pop();
  console.log(`[EventTriggers] ${type === 'error' ? '❌' : type === 'trigger' ? '⚡' : '🔵'} ${message}`);
}

// ── Agent'a güvenli hedef enjekte et ─────────────────────
async function injectGoal(autoAgent, goal, source) {
  if (!autoAgent || !autoAgent.AUTO) return;
  if (autoAgent.AUTO.running && autoAgent.AUTO.paused) return;

  // ── Geçersiz hedefleri filtrele ──
  if (!goal || goal.trim().length < 5) return;
  if (/^https?:\/\//i.test(goal.trim())) return;
  if (/^curl |^git |^\$\s/i.test(goal.trim())) return;
  if (/localhost:\d+/i.test(goal)) return;        // localhost URL içeren cümleler
  if (/ana sayfa|adres.*yaz|sayfa.*git/i.test(goal)) return;  // browser navigasyon hedefleri
  if (/^pano |clipboard/i.test(goal)) return;     // pano ile başlayan hedefler

  // Meşgulse kuyruğa eklemek yerine sadece logla
  const { AGENT_STATE_REF } = TRIGGER_STATE;
  if (AGENT_STATE_REF && AGENT_STATE_REF.busy) {
    _logEvent('info', `Hedef kuyruğa alındı (meşgul): ${goal.slice(0, 50)}`);
    // 30sn sonra tekrar dene
    setTimeout(() => injectGoal(autoAgent, goal, source + '_retry'), 30000);
    return;
  }

  _logEvent('trigger', `[${source}] Hedef enjekte edildi: ${goal.slice(0, 60)}`);
  try {
    const axios = TRIGGER_STATE.axiosRef;
    if (axios) {
      await axios.post(`http://localhost:${TRIGGER_STATE.port}/auto/inject-goal`, { goal });
    }
  } catch (e) {
    _logEvent('error', `Hedef enjeksiyonu başarısız: ${e.message}`);
  }
}

// ══════════════════════════════════════════════════════════
// 1️⃣ DOSYA WATCHER
// ══════════════════════════════════════════════════════════
function addFileWatcher(chokidar, autoAgent, watchPath, options = {}) {
  if (!chokidar) { console.warn('[EventTriggers] chokidar bulunamadı'); return null; }
  if (TRIGGER_STATE.watchers[watchPath]) {
    console.log(`[EventTriggers] Zaten izleniyor: ${watchPath}`);
    return TRIGGER_STATE.watchers[watchPath];
  }

  const {
    goalTemplate = (file, event) => `${event} olayı: "${file}" dosyasını analiz et`,
    extensions = ['.js', '.py', '.ts', '.json', '.md'],
    ignoreInitial = true,
    events = ['add', 'change']  // add, change, unlink
  } = options;

  const watcher = chokidar.watch(watchPath, {
    ignoreInitial,
    ignored: /(node_modules|\.git|\.DS_Store|venv|__pycache__|\.pytest_cache)/,
    persistent: true
  });

  events.forEach(event => {
    watcher.on(event, (filePath) => {
      if (!TRIGGER_STATE.enabled) return;
      const ext = filePath.split('.').pop();
      if (extensions.length && !extensions.some(e => filePath.endsWith(e))) return;

      const fileName = filePath.split('/').pop();
      const goal = goalTemplate(fileName, event);
      _logEvent('trigger', `Dosya ${event}: ${fileName}`);
      injectGoal(autoAgent, goal, 'file_watcher');
    });
  });

  watcher.on('error', err => _logEvent('error', `Watcher hatası: ${err.message}`));
  TRIGGER_STATE.watchers[watchPath] = watcher;
  _logEvent('info', `Dosya izleme başladı: ${watchPath}`);
  return watcher;
}

function removeFileWatcher(watchPath) {
  const w = TRIGGER_STATE.watchers[watchPath];
  if (w) {
    w.close();
    delete TRIGGER_STATE.watchers[watchPath];
    _logEvent('info', `Dosya izleme durduruldu: ${watchPath}`);
    return true;
  }
  return false;
}

// ══════════════════════════════════════════════════════════
// 2️⃣ CRON TABANLARI GÖREVLERİ
// ══════════════════════════════════════════════════════════
function addCronJob(cron, autoAgent, name, cronExpr, goal, options = {}) {
  if (!cron) { console.warn('[EventTriggers] node-cron bulunamadı'); return null; }
  if (TRIGGER_STATE.cronJobs[name]) {
    TRIGGER_STATE.cronJobs[name].stop();
    _logEvent('info', `Cron güncellendi: ${name}`);
  }

  const { timezone = 'Europe/Istanbul', runOnInit = false } = options;

  const job = cron.schedule(cronExpr, async () => {
    if (!TRIGGER_STATE.enabled) return;
    _logEvent('trigger', `Cron tetiklendi [${name}]: ${goal.slice(0, 60)}`);
    await injectGoal(autoAgent, goal, `cron:${name}`);
  }, { timezone });

  TRIGGER_STATE.cronJobs[name] = job;
  _logEvent('info', `Cron eklendi: ${name} | ${cronExpr}`);

  if (runOnInit) {
    setTimeout(() => injectGoal(autoAgent, goal, `cron:${name}:init`), 3000);
  }

  return job;
}

function removeCronJob(name) {
  const job = TRIGGER_STATE.cronJobs[name];
  if (job) {
    job.stop();
    delete TRIGGER_STATE.cronJobs[name];
    _logEvent('info', `Cron durduruldu: ${name}`);
    return true;
  }
  return false;
}

// ══════════════════════════════════════════════════════════
// 3️⃣ IDLE ALGILAMA
// ══════════════════════════════════════════════════════════
function startIdleDetection(autoAgent, brain, options = {}) {
  const {
    thresholdMs = 10 * 60 * 1000,  // 10 dakika
    checkIntervalMs = 60 * 1000,    // her 1 dakika kontrol
    idleGoals = [
      'Projedeki JavaScript dosyalarını tara ve hata analizi yap',
      'Son yazılan kodları test et ve özet çıkar',
      'Node.js best practices hakkında kısa bir araştırma yap',
      'Proje klasörünü listele ve düzeni değerlendir'
    ]
  } = options;

  TRIGGER_STATE.idleThresholdMs = thresholdMs;
  let idleGoalIndex = 0;

  if (TRIGGER_STATE.idleCheckInterval) {
    clearInterval(TRIGGER_STATE.idleCheckInterval);
  }

  TRIGGER_STATE.idleCheckInterval = setInterval(async () => {
    if (!TRIGGER_STATE.enabled) return;
    const idleMs = Date.now() - TRIGGER_STATE.lastUserActivity;

    if (idleMs >= thresholdMs) {
      // Kullanıcı idle — arka plan görevi ver
      const goal = idleGoals[idleGoalIndex % idleGoals.length];
      idleGoalIndex++;

      _logEvent('trigger', `Idle algılandı (${Math.round(idleMs / 60000)} dk) → ${goal.slice(0, 50)}`);
      if (brain) {
        brain.mem.remember('idle_task:' + Date.now(), goal.slice(0, 80), 0.4);
      }
      await injectGoal(autoAgent, goal, 'idle_detector');

      // Tetiklendikten sonra saydacı sıfırla (sürekli tetiklenmesin)
      TRIGGER_STATE.lastUserActivity = Date.now() - thresholdMs + (5 * 60 * 1000);
    }
  }, checkIntervalMs);

  _logEvent('info', `Idle algılama başladı (eşik: ${thresholdMs / 60000} dk)`);
}

// Kullanıcı aktivitesi kaydedici — server.js'deki mevcut endpointlerden tetiklenir
function recordUserActivity() {
  TRIGGER_STATE.lastUserActivity = Date.now();
}

// ══════════════════════════════════════════════════════════
// 🔌 ANA MOUNT
// ══════════════════════════════════════════════════════════
function mountEventTriggers(app, autoAgent, brain, deps = {}) {
  const { fs, path, exec, chokidar, cron, axios, PORT } = deps;

  // Referansları kaydet (injectGoal için)
  TRIGGER_STATE.axiosRef = axios;
  TRIGGER_STATE.port = PORT || 3000;

  if (!app || !autoAgent) {
    console.warn('[EventTriggers] ⚠️ app veya autoAgent eksik, mount atlandı.');
    return;
  }

  // ── Varsayılan dosya watchers ──────────────────────────
  if (chokidar && fs && path) {
    // Proje klasörünü izle (js/py değişimleri)
    const projectDir = process.cwd();
    addFileWatcher(chokidar, autoAgent, projectDir, {
      extensions: ['.js', '.py', '.ts'],
      events: ['add'],  // Sadece yeni dosya eklenmesi
      goalTemplate: (file) => `"${file}" adlı yeni dosya oluşturuldu, analiz et ve test et`,
      ignoreInitial: true
    });

    // Downloads klasörünü izle
    const downloadsDir = process.env.HOME
      ? path.join(process.env.HOME, 'Downloads')
      : null;
    if (downloadsDir && fs.existsSync(downloadsDir)) {
      addFileWatcher(chokidar, autoAgent, downloadsDir, {
        extensions: ['.js', '.py', '.json', '.txt', '.md'],
        events: ['add'],
        goalTemplate: (file) => `Downloads klasörüne "${file}" indi, içeriğini analiz et`,
        ignoreInitial: true
      });
    }
  }

  // ── Varsayılan cron görevleri ──────────────────────────
  if (cron) {
    // Her sabah 09:00 — günlük özet
    addCronJob(cron, autoAgent, 'morning_summary',
      '0 9 * * *',
      'Proje klasörünü tara, son değişiklikleri özetle ve bugün için öneri sun',
      { timezone: 'Europe/Istanbul' }
    );

    // Her gece 23:00 — temizlik
    addCronJob(cron, autoAgent, 'nightly_cleanup',
      '0 23 * * *',
      'Test dosyalarını kontrol et, başarısız olanları analiz et ve öğrenme özeti çıkar',
      { timezone: 'Europe/Istanbul' }
    );

    // Her 2 saatte bir — kod kalitesi
    addCronJob(cron, autoAgent, 'code_quality_check',
      '0 */2 * * *',
      'Son yazılan JavaScript dosyalarından birini analiz et',
      { timezone: 'Europe/Istanbul' }
    );
  }

  // ── Idle algılama ──────────────────────────────────────
  startIdleDetection(autoAgent, brain, {
    thresholdMs: 10 * 60 * 1000,
    idleGoals: [
      'Projedeki en son JavaScript dosyasını analiz et',
      'Node.js performans optimizasyonu hakkında araştırma yap ve özetle',
      'Proje klasörünü listele, gereksiz dosya var mı kontrol et',
      'Son oluşturulan kodları test et'
    ]
  });

  // ── Kullanıcı aktivite takibi ──────────────────────────
  // Mevcut endpointlere middleware ile aktivite kaydı ekle
  app.use((req, res, next) => {
    // POST isteklerini kullanıcı aktivitesi say (GET'ler pasif olabilir)
    if (req.method === 'POST' || req.method === 'PUT') {
      recordUserActivity();
    }
    next();
  });

  // ── API Endpointleri ───────────────────────────────────

  // Durum
  app.get('/triggers/status', (req, res) => {
    const idleMs = Date.now() - TRIGGER_STATE.lastUserActivity;
    res.json({
      status: 'success',
      enabled: TRIGGER_STATE.enabled,
      watchers: Object.keys(TRIGGER_STATE.watchers),
      cronJobs: Object.keys(TRIGGER_STATE.cronJobs),
      idleMs: Math.round(idleMs),
      idleSince: new Date(TRIGGER_STATE.lastUserActivity).toISOString(),
      isIdle: idleMs >= TRIGGER_STATE.idleThresholdMs,
      recentEvents: TRIGGER_STATE.eventLog.slice(0, 20)
    });
  });

  // Tetikleyiciyi aç/kapat
  app.post('/triggers/toggle', (req, res) => {
    TRIGGER_STATE.enabled = !TRIGGER_STATE.enabled;
    res.json({ status: 'success', enabled: TRIGGER_STATE.enabled });
  });

  // Watcher ekle
  app.post('/triggers/watch', (req, res) => {
    if (!chokidar) return res.json({ status: 'error', message: 'chokidar yok' });
    const { watchPath, extensions, events, goalTemplate } = req.body;
    if (!watchPath) return res.json({ status: 'error', message: 'watchPath gerekli' });
    const opts = {};
    if (extensions) opts.extensions = extensions;
    if (events) opts.events = events;
    if (goalTemplate) opts.goalTemplate = new Function('file', 'event', `return \`${goalTemplate}\``);
    addFileWatcher(chokidar, autoAgent, watchPath, opts);
    res.json({ status: 'success', watching: watchPath });
  });

  // Watcher durdur
  app.delete('/triggers/watch', (req, res) => {
    const { watchPath } = req.body;
    const ok = removeFileWatcher(watchPath);
    res.json({ status: ok ? 'success' : 'error', watchPath });
  });

  // Cron ekle
  app.post('/triggers/cron', (req, res) => {
    if (!cron) return res.json({ status: 'error', message: 'node-cron yok' });
    const { name, cronExpr, goal, timezone } = req.body;
    if (!name || !cronExpr || !goal) {
      return res.json({ status: 'error', message: 'name, cronExpr, goal gerekli' });
    }
    addCronJob(cron, autoAgent, name, cronExpr, goal, { timezone });
    res.json({ status: 'success', name, cronExpr });
  });

  // Cron sil
  app.delete('/triggers/cron/:name', (req, res) => {
    const ok = removeCronJob(req.params.name);
    res.json({ status: ok ? 'success' : 'error', name: req.params.name });
  });

  // Idle eşiğini güncelle
  app.post('/triggers/idle', (req, res) => {
    const { thresholdMinutes, idleGoals } = req.body;
    if (thresholdMinutes) {
      TRIGGER_STATE.idleThresholdMs = thresholdMinutes * 60 * 1000;
    }
    if (idleGoals) {
      startIdleDetection(autoAgent, brain, {
        thresholdMs: TRIGGER_STATE.idleThresholdMs,
        idleGoals
      });
    }
    res.json({ status: 'success', thresholdMs: TRIGGER_STATE.idleThresholdMs });
  });

  // Event log
  app.get('/triggers/log', (req, res) => {
    res.json({ status: 'success', events: TRIGGER_STATE.eventLog });
  });

  console.log('[EventTriggers] 🔌 Mount tamamlandı.');
  console.log('  GET    /triggers/status     → durum + son eventler');
  console.log('  POST   /triggers/toggle     → aç/kapat');
  console.log('  POST   /triggers/watch      → yeni watcher ekle');
  console.log('  DELETE /triggers/watch      → watcher durdur');
  console.log('  POST   /triggers/cron       → cron görevi ekle');
  console.log('  DELETE /triggers/cron/:name → cron durdur');
  console.log('  POST   /triggers/idle       → idle ayarları');
  console.log('  GET    /triggers/log        → event geçmişi');

  return { addFileWatcher, addCronJob, startIdleDetection, recordUserActivity };
}

module.exports = { mountEventTriggers, recordUserActivity };