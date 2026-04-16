// ============================================================
// 🌅 dailyRoutine.js — Sabah & Akşam Rutin Motoru v1.0
//
// Mevcut hiçbir dosyaya dokunmaz.
// server.js'in EN SONUNA (wss.on'dan önce) şunu ekle:
//
//   const { mountDailyRoutine } = require('./dailyRoutine');
//   mountDailyRoutine(app, brain, axios, proactiveEngine, { isMac, isWindows, exec, cron });
//
// Özellikler:
//   ✅ Sabah rutini (07:30): hava durumu + haberler + ajanda + brain özeti
//   ✅ Akşam rutini (21:00): günün özeti + yarına kalan görevler
//   ✅ Ollama ile kişiselleştirilmiş özet üretimi
//   ✅ Tüm bildirimler proactiveEngine üzerinden gider (chat + masaüstü)
//   ✅ /routine/* endpoint'leri ile manuel tetikleme ve ayar
// ============================================================

'use strict';

// ── Durum ─────────────────────────────────────────────────
const ROUTINE_STATE = {
  morningDone: {},   // { 'YYYY-MM-DD': true }
  eveningDone: {},
  lastMorning:  null,
  lastEvening:  null,
  config: {
    morningHour:  7,
    morningMin:   30,
    eveningHour:  21,
    eveningMin:   0,
    weatherCity:  'Istanbul',   // wttr.in şehri — .env'de ROUTINE_CITY ile override
    enabled:      true,
    timezone:     'Europe/Istanbul'
  }
};

// ── Tarih anahtarı ─────────────────────────────────────────
function _today() {
  return new Date().toISOString().split('T')[0];
}

// ── Hava durumu (wttr.in — ücretsiz, kayıt yok) ───────────
async function _getWeather(axios, city) {
  try {
    const r = await axios.get(
      `https://wttr.in/${encodeURIComponent(city)}?format=3`,
      { timeout: 8000, headers: { 'User-Agent': 'KaanAI/1.0' } }
    );
    return (r.data || '').toString().trim().slice(0, 120);
  } catch (e) {
    console.warn('[DailyRoutine] ⚠️ Hava durumu alınamadı:', e.message.slice(0, 60));
    return null;
  }
}

// ── Türkçe haberler — mevcut /agent/news-tr endpoint'ini çağır ─
async function _getNews(axios, port) {
  try {
    const r = await axios.get(`http://localhost:${port}/agent/news-tr?limit=5`, { timeout: 25000 });
    const headlines = (r.data?.headlines || []).slice(0, 5);
    if (!headlines.length) return null;
    return headlines.map((h, i) => `${i + 1}. ${h.title}`).join('\n');
  } catch (e) {
    console.warn('[DailyRoutine] ⚠️ Haberler alınamadı:', e.message.slice(0, 60));
    return null;
  }
}

// ── Ajanda — mevcut /agenda/upcoming endpoint'ini çağır ────
async function _getAgenda(axios, port) {
  try {
    const r = await axios.get(`http://localhost:${port}/agenda/upcoming?days=1`, { timeout: 8000 });
    const events = r.data?.events || [];
    if (!events.length) return 'Bugün ajandanda etkinlik yok.';
    return events.map(e => `• ${e.start} — ${e.title}`).join('\n');
  } catch (e) {
    console.warn('[DailyRoutine] ⚠️ Ajanda alınamadı:', e.message.slice(0, 60));
    return null;
  }
}

// ── Brain özeti ────────────────────────────────────────────
function _getBrainSummary(brain) {
  try {
    const emo   = brain.emo.getState();
    const goals = brain.goals.getGoals().slice(0, 2);
    const mood  = emo.mood || 'NORMAL';
    const conf  = Math.round((emo.confidence || 0.7) * 100);
    const goalList = goals.map(g => g.goal).join(', ') || 'Hedef tanımlanmamış';
    return `Ruh hali: ${mood} | Özgüven: %${conf}\nAktif hedefler: ${goalList}`;
  } catch (e) {
    return null;
  }
}

// ── Dünün tamamlanmamış görevleri ─────────────────────────
function _getUnfinishedTasks(brain) {
  try {
    const mem = brain.mem.getAll();
    const failed = (mem.failurePatterns || [])
      .filter(f => {
        const ageHours = (Date.now() - new Date(f.lastSeen).getTime()) / 3600000;
        return ageHours < 24 && f.count >= 1;
      })
      .slice(0, 3)
      .map(f => `• [${f.tool}] ${f.error.slice(0, 60)}`);
    return failed.length ? failed.join('\n') : null;
  } catch (e) {
    return null;
  }
}

// ── Ollama ile kişiselleştirilmiş özet üret ───────────────
async function _buildOllamaSummary(axios, type, data, brain) {
  try {
    const profileHint = brain?.userProfile?.getProfilePrompt() || '';
    const name        = brain?.userProfile?.getProfile()?.identity?.name || '';
    const greeting    = name ? `Merhaba ${name}!` : 'Merhaba!';

    let prompt = '';

    if (type === 'morning') {
      prompt = [
        profileHint,
        `=== SABAH ÖZET VERİSİ ===`,
        data.weather  ? `Hava: ${data.weather}`      : '',
        data.news     ? `Haberler:\n${data.news}`     : '',
        data.agenda   ? `Bugünkü ajanda:\n${data.agenda}` : '',
        data.brain    ? `Sistem durumu:\n${data.brain}` : '',
        `=== GÖREV ===`,
        `"${greeting}" diye başlayan, kısa (3-4 cümle), Türkçe, samimi bir sabah mesajı yaz.`,
        `Bugünkü programı ve hava durumunu dahil et. Motive edici bitir.`,
      ].filter(Boolean).join('\n\n');
    } else {
      prompt = [
        profileHint,
        `=== AKŞAM ÖZET VERİSİ ===`,
        data.agenda   ? `Bugünkü plan:\n${data.agenda}`           : '',
        data.failed   ? `Tamamlanamayan görevler:\n${data.failed}` : '',
        data.brain    ? `Sistem durumu:\n${data.brain}`            : '',
        `=== GÖREV ===`,
        `Kısa (3-4 cümle), Türkçe, samimi bir akşam özeti yaz.`,
        `Gün nasıl geçti, yarına ne kaldı. Rahatlatıcı bitir.`,
      ].filter(Boolean).join('\n\n');
    }

    const r = await axios.post('http://localhost:11434/api/generate', {
      model:  process.env.OLLAMA_MODEL || 'llama3.1:8b',
      stream: false,
      prompt,
    });
    return (r.data?.response || '').trim().slice(0, 600);
  } catch (e) {
    console.warn('[DailyRoutine] ⚠️ Ollama özet hatası:', e.message.slice(0, 60));
    return null;
  }
}

// ══════════════════════════════════════════════════════════
// 🌅 SABAH RUTİNİ
// ══════════════════════════════════════════════════════════
async function runMorningRoutine(brain, axios, proactiveEngine, port) {
  const today = _today();
  if (ROUTINE_STATE.morningDone[today]) {
    console.log('[DailyRoutine] 🌅 Sabah rutini bugün zaten çalıştı.');
    return { skipped: true, reason: 'already_done' };
  }

  console.log('[DailyRoutine] 🌅 Sabah rutini başladı...');

  const city = process.env.ROUTINE_CITY || ROUTINE_STATE.config.weatherCity;

  // Paralel veri çek
  const [weather, news, agenda] = await Promise.all([
    _getWeather(axios, city),
    _getNews(axios, port),
    _getAgenda(axios, port),
  ]);

  const brainSummary = _getBrainSummary(brain);

  // Ollama özeti
  const summary = await _buildOllamaSummary(axios, 'morning', {
    weather, news, agenda, brain: brainSummary
  }, brain);

  // Ham fallback mesaj
  const fallback = [
    `☀️ Günaydın!`,
    weather  ? `🌤️ Hava: ${weather}` : '',
    agenda   ? `📅 Bugünkü ajandan:\n${agenda}` : '',
    news     ? `📰 Günün haberleri:\n${news}` : '',
  ].filter(Boolean).join('\n\n');

  const message = summary || fallback;
  const title   = `☀️ Günaydın — ${new Date().toLocaleDateString('tr-TR', { weekday: 'long', day: 'numeric', month: 'long' })}`;

  // Bildir
  if (proactiveEngine?.sendManual) {
    await proactiveEngine.sendManual(message, ['chat', 'desktop']);
  }

  // Brain'e öğret
  try {
    brain.learn(`Sabah rutini: ${today}`, message.slice(0, 200));
  } catch (e) {}

  ROUTINE_STATE.morningDone[today] = true;
  ROUTINE_STATE.lastMorning = new Date().toISOString();

  console.log('[DailyRoutine] ✅ Sabah rutini tamamlandı.');
  return { done: true, title, message: message.slice(0, 300), weather, agendaCount: (agenda || '').split('\n').length };
}

// ══════════════════════════════════════════════════════════
// 🌙 AKŞAM RUTİNİ
// ══════════════════════════════════════════════════════════
async function runEveningRoutine(brain, axios, proactiveEngine, port) {
  const today = _today();
  if (ROUTINE_STATE.eveningDone[today]) {
    console.log('[DailyRoutine] 🌙 Akşam rutini bugün zaten çalıştı.');
    return { skipped: true, reason: 'already_done' };
  }

  console.log('[DailyRoutine] 🌙 Akşam rutini başladı...');

  // Bugünkü ajanda
  const agenda      = await _getAgenda(axios, port);
  const brainSummary = _getBrainSummary(brain);
  const failed       = _getUnfinishedTasks(brain);

  // Yarınki ajanda
  let tomorrowAgenda = null;
  try {
    const r = await axios.get(`http://localhost:${port}/agenda/upcoming?days=2`, { timeout: 8000 });
    const tomorrow = _today(); // bir sonraki gün — basit filtre
    const events = (r.data?.events || []).filter(e => e.date > today).slice(0, 3);
    if (events.length) {
      tomorrowAgenda = events.map(e => `• ${e.date} ${e.start} — ${e.title}`).join('\n');
    }
  } catch (e) {}

  // Ollama özeti
  const summary = await _buildOllamaSummary(axios, 'evening', {
    agenda, failed, brain: brainSummary
  }, brain);

  const fallback = [
    `🌙 İyi akşamlar!`,
    agenda         ? `📅 Bugün planlanmıştı:\n${agenda}`          : '',
    failed         ? `⚠️ Tamamlanamayan:\n${failed}`               : '',
    tomorrowAgenda ? `📋 Yarın için:\n${tomorrowAgenda}`           : '',
  ].filter(Boolean).join('\n\n');

  const message = summary || fallback;
  const title   = `🌙 Günün Özeti — ${new Date().toLocaleDateString('tr-TR')}`;

  if (proactiveEngine?.sendManual) {
    await proactiveEngine.sendManual(message, ['chat', 'desktop']);
  }

  try {
    brain.learn(`Akşam rutini: ${today}`, message.slice(0, 200));
  } catch (e) {}

  ROUTINE_STATE.eveningDone[today] = true;
  ROUTINE_STATE.lastEvening = new Date().toISOString();

  console.log('[DailyRoutine] ✅ Akşam rutini tamamlandı.');
  return { done: true, title, message: message.slice(0, 300) };
}

// ══════════════════════════════════════════════════════════
// 🔌 MOUNT
// ══════════════════════════════════════════════════════════
function mountDailyRoutine(app, brain, axios, proactiveEngine, deps = {}) {
  const { cron, PORT } = deps;
  const port = PORT || 3000;

  if (!app || !brain || !axios) {
    console.warn('[DailyRoutine] ⚠️ Eksik parametre, mount atlandı.');
    return;
  }

  // ── Cron: sabah rutini ─────────────────────────────────
  if (cron) {
    const { morningHour, morningMin, eveningHour, eveningMin, timezone } = ROUTINE_STATE.config;

    cron.schedule(
      `${morningMin} ${morningHour} * * *`,
      async () => {
        if (!ROUTINE_STATE.config.enabled) return;
        await runMorningRoutine(brain, axios, proactiveEngine, port);
      },
      { timezone }
    );

    cron.schedule(
      `${eveningMin} ${eveningHour} * * *`,
      async () => {
        if (!ROUTINE_STATE.config.enabled) return;
        await runEveningRoutine(brain, axios, proactiveEngine, port);
      },
      { timezone }
    );

    console.log(`[DailyRoutine] ⏰ Cron: sabah ${morningHour}:${String(morningMin).padStart(2,'0')} | akşam ${eveningHour}:${String(eveningMin).padStart(2,'0')}`);
  }

  // ── Durum ─────────────────────────────────────────────
  app.get('/routine/status', (req, res) => {
    const today = _today();
    res.json({
      status:        'success',
      enabled:       ROUTINE_STATE.config.enabled,
      config:        ROUTINE_STATE.config,
      today,
      morningDone:   !!ROUTINE_STATE.morningDone[today],
      eveningDone:   !!ROUTINE_STATE.eveningDone[today],
      lastMorning:   ROUTINE_STATE.lastMorning,
      lastEvening:   ROUTINE_STATE.lastEvening,
    });
  });

  // ── Manuel sabah tetikle ───────────────────────────────
  app.post('/routine/morning', async (req, res) => {
    const force = req.body?.force === true;
    if (force) delete ROUTINE_STATE.morningDone[_today()];
    const result = await runMorningRoutine(brain, axios, proactiveEngine, port);
    res.json({ status: 'success', ...result });
  });

  // ── Manuel akşam tetikle ──────────────────────────────
  app.post('/routine/evening', async (req, res) => {
    const force = req.body?.force === true;
    if (force) delete ROUTINE_STATE.eveningDone[_today()];
    const result = await runEveningRoutine(brain, axios, proactiveEngine, port);
    res.json({ status: 'success', ...result });
  });

  // ── Hava durumu önizleme ──────────────────────────────
  app.get('/routine/weather', async (req, res) => {
    const city = req.query.city || ROUTINE_STATE.config.weatherCity;
    const weather = await _getWeather(axios, city);
    res.json({ status: 'success', city, weather });
  });

  // ── Ayar güncelle ─────────────────────────────────────
  app.post('/routine/config', (req, res) => {
    const { morningHour, morningMin, eveningHour, eveningMin, weatherCity, enabled, timezone } = req.body;
    if (typeof morningHour === 'number') ROUTINE_STATE.config.morningHour = morningHour;
    if (typeof morningMin  === 'number') ROUTINE_STATE.config.morningMin  = morningMin;
    if (typeof eveningHour === 'number') ROUTINE_STATE.config.eveningHour = eveningHour;
    if (typeof eveningMin  === 'number') ROUTINE_STATE.config.eveningMin  = eveningMin;
    if (weatherCity)                     ROUTINE_STATE.config.weatherCity  = weatherCity;
    if (typeof enabled === 'boolean')    ROUTINE_STATE.config.enabled      = enabled;
    if (timezone)                        ROUTINE_STATE.config.timezone      = timezone;
    res.json({ status: 'success', config: ROUTINE_STATE.config });
  });

  // ── Aç/kapat ─────────────────────────────────────────
  app.post('/routine/toggle', (req, res) => {
    ROUTINE_STATE.config.enabled = !ROUTINE_STATE.config.enabled;
    res.json({ status: 'success', enabled: ROUTINE_STATE.config.enabled });
  });

  console.log('[DailyRoutine] 🔌 Mount tamamlandı.');
  console.log('  GET  /routine/status   → durum');
  console.log('  POST /routine/morning  → sabah rutinini çalıştır {force:true}');
  console.log('  POST /routine/evening  → akşam rutinini çalıştır {force:true}');
  console.log('  GET  /routine/weather  → hava durumu önizle ?city=...');
  console.log('  POST /routine/config   → ayarları güncelle');
  console.log('  POST /routine/toggle   → aç/kapat');

  return { runMorningRoutine, runEveningRoutine };
}

// ── Dışarıdan config set et (customerConfig.js mount öncesi çağırır) ──────
function configure(cfg = {}) {
  if (typeof cfg.morningHour  === 'number') ROUTINE_STATE.config.morningHour  = cfg.morningHour;
  if (typeof cfg.morningMin   === 'number') ROUTINE_STATE.config.morningMin   = cfg.morningMin;
  if (typeof cfg.eveningHour  === 'number') ROUTINE_STATE.config.eveningHour  = cfg.eveningHour;
  if (typeof cfg.eveningMin   === 'number') ROUTINE_STATE.config.eveningMin   = cfg.eveningMin;
  if (cfg.weatherCity)                      ROUTINE_STATE.config.weatherCity   = cfg.weatherCity;
  if (typeof cfg.enabled  === 'boolean')    ROUTINE_STATE.config.enabled       = cfg.enabled;
  if (cfg.timezone)                         ROUTINE_STATE.config.timezone       = cfg.timezone;
}

module.exports = { mountDailyRoutine, runMorningRoutine, runEveningRoutine, configure };