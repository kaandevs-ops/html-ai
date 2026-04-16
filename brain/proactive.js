// ============================================================
// 🔔 brain/proactive.js — Proaktif Bildirim Motoru v2
//
// deepMemory.js'e GEREK YOK — userProfile.js ile çalışır
//
// server.js'e ekle (brain require'dan sonra):
//
//   const proactive = require('./brain/proactive');
//   const proactiveEngine = proactive.mount(app, userProfile, {
//     axios,
//     isMac,
//     isWindows,
//     exec,
//     ElevenLabs: {
//       apiKey:  process.env.ELEVENLABS_API_KEY,
//       voiceId: process.env.ELEVENLABS_VOICE_ID,
//     }
//   });
//
//   // wss.on('connection') içine:
//   proactiveEngine.registerWsClient(ws);
//
// ============================================================

'use strict';

function mount(app, userProfile, ctx) {
  const { axios, isMac, isWindows, exec, ElevenLabs } = ctx;

  // ── Kullanıcı tercihleri ────────────────────────────────
  let _prefs = {
    enableChat: true,
    enableDesktop: true,
    enableVoice: false,
    quietHours: { start: 23, end: 7 },
    minIntervalMs: 15 * 60 * 1000,
  };

  const _lastNotif = {};
  const _wsClients = new Set();
  let _running = false;
  let _telegramChatId = null;
  let _interval = null;

  // ── Döngü ──────────────────────────────────────────────
  function start() {
    if (_running) return;
    _running = true;
    _interval = setInterval(_checkAll, 5 * 60 * 1000);
    setTimeout(_checkAll, 30 * 1000);
    console.log('[Proactive] 🔔 Bildirim motoru başladı');
  }

  function stop() {
    _running = false;
    if (_interval) clearInterval(_interval);
    console.log('[Proactive] 🔕 Bildirim motoru durduruldu');
  }

  async function _checkAll() {
    if (!_running || _isQuietHour()) return;
    const data = userProfile.getProactiveData();

    // ── v3: Yeni modülleri lazy yükle ──────────────────────
    let episodicMod, uuMod, infMod, prMod;
    try { episodicMod = require('./episodic'); } catch (e) { }
    try { uuMod = require('./userUnderstanding'); } catch (e) { }
    try { infMod = require('./inference'); } catch (e) { }
    try { prMod = require('./prediction'); } catch (e) { }

    await Promise.allSettled([
      _checkMorningGreeting(data),
      _checkRoutineReminder(data),
      _checkMeetingWarning(data),
      _checkMoodCheck(data),
      _checkPatternInsight(data),
      _checkEveningWrapup(data),
      // ── v3: Yeni triggerlar ─────────────────────────────
      _checkEpisodicFollowUp(episodicMod),
      _checkStressTimeWarning(infMod),
      _checkKnowledgeGapHelp(uuMod),
      _checkPredictionInsight(prMod),
    ]);
  }

  function _isQuietHour() {
    const h = new Date().getHours();
    const { start, end } = _prefs.quietHours;
    if (start > end) return h >= start || h < end;
    return h >= start && h < end;
  }

  function _canNotify(key) { return Date.now() - (_lastNotif[key] || 0) > _prefs.minIntervalMs; }
  function _markNotified(key) { _lastNotif[key] = Date.now(); }

  async function _checkMorningGreeting(data) {
    if (data.currentHour < 7 || data.currentHour > 10) return;
    if (!_canNotify('morning')) return;
    const summary = userProfile.getMorningSummary();
    if (!summary) return;
    await _notify('morning', { title: '☀️ Günaydın!', message: summary });
  }

  async function _checkRoutineReminder(data) {
    for (const [key, r] of Object.entries(data.routines)) {
      if (r.count < 3 || r.avgHour === null) continue;
      if (r.avgHour !== data.currentHour) continue;
      if (!_canNotify(`routine_${key}`)) continue;
      await _notify(`routine_${key}`, {
        title: '🔁 Rutin Hatırlatma',
        message: `Genellikle bu saatte "${r.label}" yapıyorsun.`,
      });
      break;
    }
  }

  async function _checkMeetingWarning(data) {
    const gec = data.patterns['gec_kalma'];
    if (!gec || gec.count < 2) return;
    if (!_canNotify('meeting_warning')) return;
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const hasMeeting = data.events.some(e => e.type === 'toplanti' && e.date >= yesterday);
    if (!hasMeeting) return;
    const name = data.identity?.name ? `${data.identity.name}, ` : '';
    await _notify('meeting_warning', {
      title: '⚠️ Zaman Uyarısı',
      message: `${name}daha önce ${gec.count}x gecikme yaşandı. Bugün toplantın var — erken çıkmayı düşün.`,
    });
  }

  async function _checkMoodCheck(data) {
    if (data.currentHour < 14 || data.currentHour > 16) return;
    if (!_canNotify('mood_check')) return;
    if (data.todayMood.length > 0) return;
    const name = data.identity?.name ? `${data.identity.name},` : '';
    await _notify('mood_check', {
      title: '💬 Nasılsın?',
      message: `${name} öğleden sonra nasıl gidiyor?`,
    });
  }

  async function _checkPatternInsight(data) {
    if (data.currentHour < 10 || data.currentHour > 12) return;
    if (!_canNotify('pattern_insight')) return;
    const strong = Object.values(data.patterns)
      .filter(p => p.strength >= 0.5 && p.count >= 5)
      .sort((a, b) => b.strength - a.strength)[0];
    if (!strong) return;
    await _notify('pattern_insight', {
      title: '🔍 Fark Ettim',
      message: `${strong.desc} (${strong.count} kez gözlemlendi).`,
    });
  }

  async function _checkEveningWrapup(data) {
    if (data.currentHour < 19 || data.currentHour > 21) return;
    if (!_canNotify('evening')) return;
    const todayEvents = data.events.filter(e => e.date === data.dateStr);
    if (todayEvents.length === 0) return;
    const summary = todayEvents.map(e => e.summary).join(', ');
    const name = data.identity?.name ? `${data.identity.name}, ` : '';
    await _notify('evening', {
      title: '🌙 Günün Özeti',
      message: `${name}bugün: ${summary}. Yarına bir notun var mı?`,
    });
  }

  // ── v3: Episodik takip — geçmiş konuşma follow-up ─────────
  async function _checkEpisodicFollowUp(epMod) {
    if (!epMod) return;
    if (!_canNotify('episodic_followup')) return;
    if (new Date().getHours() < 10 || new Date().getHours() > 20) return;
    const stats = epMod.getStats();
    if (!stats.topTopics || stats.topTopics.length === 0) return;
    const top = stats.topTopics[0];
    if (!top || top.count < 5) return;
    await _notify('episodic_followup', {
      title: '📖 Geçmiş Konu',
      message: `"${top.topic}" üzerine ${top.count} konuşman var. Bu konuyu tamamladın mı?`,
    });
  }

  // ── v3: Stresli zaman dilimi uyarısı ─────────────────────
  async function _checkStressTimeWarning(infMod) {
    if (!infMod) return;
    if (!_canNotify('stress_time')) return;
    const stats = infMod.getStats();
    if (!stats.stressfulTimes || stats.stressfulTimes.length === 0) return;
    const h = new Date().getHours();
    const period = h < 12 ? 'sabah' : h < 17 ? 'öğleden-sonra' : h < 21 ? 'akşam' : 'gece';
    const days = ['Pazar', 'Pazartesi', 'Salı', 'Çarşamba', 'Perşembe', 'Cuma', 'Cumartesi'];
    const curKey = `${days[new Date().getDay()]}-${period}`;
    const hit = stats.stressfulTimes.find(e => e.startsWith(curKey));
    if (!hit) return;
    await _notify('stress_time', {
      title: '⚠️ Dikkat',
      message: `Bu saatlerde genellikle stresli oluyorsun. Yavaş al, bir adım adım gidelim.`,
    });
  }

  // ── v3: Kapanmayan bilgi boşluğu ─────────────────────────
  async function _checkKnowledgeGapHelp(uuMod) {
    if (!uuMod) return;
    if (!_canNotify('knowledge_gap')) return;
    if (new Date().getHours() < 9 || new Date().getHours() > 18) return;
    const summary = uuMod.getSummary();
    if (!summary.knowledgeGaps || summary.knowledgeGaps.length === 0) return;
    const gap = summary.knowledgeGaps[0];
    await _notify('knowledge_gap', {
      title: '💡 Açık Konu',
      message: `"${gap}" konusunu henüz tam oturtamadık. Farklı bir açıdan bakmak ister misin?`,
    });
  }

  // ── v3: Tahmin doğruluğu içgörüsü ────────────────────────
  async function _checkPredictionInsight(prMod) {
    if (!prMod) return;
    if (!_canNotify('prediction_insight')) return;
    if (new Date().getHours() < 11 || new Date().getHours() > 13) return;
    const acc = prMod.getAccuracy();
    if (acc.total < 20 || acc.rate < 0.65) return;
    await _notify('prediction_insight', {
      title: '🔮 Seni Tanıyorum',
      message: `Sorularının %${Math.round(acc.rate * 100)}'ini tahmin edebiliyorum artık. Sistem seni gerçekten öğreniyor.`,
    });
  }

  async function _notify(key, { title, message }) {
    _markNotified(key);
    const channels = [];
    if (_prefs.enableChat) channels.push('chat');
    if (_prefs.enableDesktop) channels.push('masaüstü');
    if (_prefs.enableVoice && ElevenLabs?.apiKey) channels.push('ses');
    console.log(`\n[Proactive] 🔔 YENİ BİLDİRİM`);
    console.log(`  Başlık  : ${title}`);
    console.log(`  Mesaj   : ${message.slice(0, 100)}`);
    console.log(`  Kanallar: ${channels.join(', ')}`);
    console.log(`  Saat    : ${new Date().toLocaleTimeString('tr-TR')}`);
    const tasks = [];
    if (_prefs.enableChat) tasks.push(_sendChat(title, message));
    if (_prefs.enableDesktop) tasks.push(_sendDesktop(title, message));
    if (_prefs.enableVoice && ElevenLabs?.apiKey) tasks.push(_sendVoice(message));
    tasks.push(_sendTelegram(title, message));
    await Promise.allSettled(tasks);
  }

  async function _sendChat(title, message) {
    const payload = JSON.stringify({
      type: 'proactive_notification', title, message,
      timestamp: new Date().toISOString(),
    });
    _wsClients.forEach(ws => { try { ws.send(payload); } catch (e) { } });
  }

  async function _sendDesktop(title, message) {
    return new Promise(resolve => {
      const t = title.replace(/['"]/g, '').slice(0, 60);
      const m = message.replace(/['"]/g, '').slice(0, 200);
      let cmd;
      if (isMac) cmd = `osascript -e 'display notification "${m}" with title "${t}"'`;
      else if (isWindows) cmd = `powershell -Command "[System.Windows.Forms.MessageBox]::Show('${m}','${t}')"`;
      else cmd = `notify-send "${t}" "${m}"`;
      exec(cmd, { timeout: 5000 }, err => {
        if (err) console.warn('[Proactive] Desktop hatası:', err.message?.slice(0, 60));
        resolve();
      });
    });
  }

  async function _sendVoice(message) {
    if (!ElevenLabs?.apiKey || !ElevenLabs?.voiceId) return;
    try {
      const r = await axios.post(
        `https://api.elevenlabs.io/v1/text-to-speech/${ElevenLabs.voiceId}`,
        { text: message.slice(0, 500), model_id: 'eleven_multilingual_v2' },
        { headers: { 'xi-api-key': ElevenLabs.apiKey }, responseType: 'arraybuffer', timeout: 10000 }
      );
      const fs = require('fs');
      const path = require('path');
      const tmp = path.join(process.cwd(), '_proactive_voice.mp3');
      fs.writeFileSync(tmp, Buffer.from(r.data));
      const play = isMac ? `afplay "${tmp}"` : isWindows ? `start "" "${tmp}"` : `mpg123 "${tmp}"`;
      exec(play, { timeout: 30000 }, () => { try { fs.unlinkSync(tmp); } catch (e) { } });
    } catch (e) { console.warn('[Proactive] Ses hatası:', e.message?.slice(0, 60)); }
  }
  async function _sendTelegram(title, message) {
    if (!_telegramChatId) return;
    try {
      const TelegramBot = require('node-telegram-bot-api');
      const token = process.env.TELEGRAM_BOT_TOKEN;
      if (!token) return;
      const bot = new TelegramBot(token, { polling: false });
      await bot.sendMessage(_telegramChatId, `🔔 *${title}*\n\n${message}`, { parse_mode: 'Markdown' });
    } catch (e) { console.warn('[Proactive] Telegram hatası:', e.message?.slice(0, 60)); }
  }
  async function sendManual(message, types = ['chat', 'desktop']) {
    console.log(`[Proactive] 🔔 Manuel bildirim: ${message.slice(0, 80)}`);
    if (types.includes('chat')) await _sendChat('💬 KaanAI', message);
    if (types.includes('desktop')) await _sendDesktop('💬 KaanAI', message);
    if (types.includes('voice')) await _sendVoice(message);
  }

  function registerWsClient(ws) {
    _wsClients.add(ws);
    ws.on('close', () => _wsClients.delete(ws));
  }

  app.get('/proactive/status', (req, res) => res.json({
    status: 'success', running: _running, prefs: _prefs,
    lastNotifs: Object.fromEntries(Object.entries(_lastNotif).map(([k, v]) => [k, new Date(v).toISOString()])),
    wsClients: _wsClients.size,
  }));

  app.get('/proactive/check', async (req, res) => { await _checkAll(); res.json({ status: 'success' }); });
  app.post('/proactive/send', async (req, res) => {
    const { message, types } = req.body;
    if (!message) return res.json({ status: 'error', message: 'message gerekli' });
    await sendManual(message, types || ['chat', 'desktop']);
    res.json({ status: 'success' });
  });
  app.post('/proactive/prefs', (req, res) => {
    const { enableChat, enableDesktop, enableVoice, quietHours, minIntervalMs } = req.body;
    if (typeof enableChat === 'boolean') _prefs.enableChat = enableChat;
    if (typeof enableDesktop === 'boolean') _prefs.enableDesktop = enableDesktop;
    if (typeof enableVoice === 'boolean') _prefs.enableVoice = enableVoice;
    if (quietHours?.start !== undefined) _prefs.quietHours = quietHours;
    if (typeof minIntervalMs === 'number') _prefs.minIntervalMs = Math.max(60000, minIntervalMs);
    res.json({ status: 'success', prefs: _prefs });
  });
  app.post('/proactive/start', (req, res) => { start(); res.json({ status: 'success' }); });
  app.post('/proactive/stop', (req, res) => { stop(); res.json({ status: 'success' }); });

  start();
  console.log('🔔 Proaktif Bildirim Motoru yüklendi!');
  function setTelegramChatId(id) { _telegramChatId = id; }
return { start, stop, sendManual, registerWsClient, setTelegramChatId };
}

module.exports = { mount };