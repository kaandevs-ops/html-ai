// ============================================================
// 📅 brain/agendaProactive.js — Ajanda Bildirim Motoru v1
//
// Proactive.js'e DOKUNMAZ. Bağımsız çalışır.
// agendaRoutes.js tarafından mount edilir.
//
// Kontrol aralıkları: 60dk, 30dk, 15dk, 5dk, 1dk
// Brain'e de öğretir.
// ============================================================

'use strict';

function mount(agendaManager, proactiveEngine, brain, wss) {
  let _interval = null;
  let _wsClients = new Set();

  // proactiveEngine varsa onun istemcilerini de kullan
  // Yoksa kendi WS istemci setimizi yönetiriz

  function registerWsClient(ws) {
    _wsClients.add(ws);
    ws.on('close', () => _wsClients.delete(ws));
  }

  function _sendWS(payload) {
    const msg = JSON.stringify(payload);
    // Kendi istemcilerimize gönder
    _wsClients.forEach(ws => {
      try { ws.send(msg); } catch (e) {}
    });
    // Proactive engine varsa oraya da gönder (zaten göndermiş olabilir)
    // Çift gönderimi önlemek için sadece kendi set'imizi kullanıyoruz
  }

  // WSS'ten gelen bağlantıları yakala (eğer wss verilmişse)
  if (wss) {
    wss.on('connection', ws => {
      registerWsClient(ws);
    });
  }

  function start() {
    if (_interval) return;
    // Her 1 dakikada bir kontrol et
    _interval = setInterval(_checkApproaching, 60 * 1000);
    // 5 saniye sonra ilk kontrol
    setTimeout(_checkApproaching, 5000);
    console.log('[AgendaProactive] 📅 Ajanda bildirim motoru başladı.');
  }

  function stop() {
    if (_interval) clearInterval(_interval);
    _interval = null;
    console.log('[AgendaProactive] 📅 Ajanda bildirim motoru durduruldu.');
  }

  async function _checkApproaching() {
    const thresholds = [
      { minutes: 60,  level: '60min',  label: '1 saat sonra' },
      { minutes: 30,  level: '30min',  label: '30 dakika sonra' },
      { minutes: 15,  level: '15min',  label: '15 dakika sonra' },
      { minutes: 5,   level: '5min',   label: '5 dakika sonra' },
      { minutes: 1,   level: '1min',   label: '1 dakika sonra' },
    ];

    for (const { minutes, level, label } of thresholds) {
      const events = agendaManager.getApproachingEvents(minutes);
      for (const event of events) {
        if (agendaManager.isNotified(event, level)) continue;

        const title   = `⏰ Etkinlik Hatırlatma`;
        const message = `"${event.title}" ${label} başlıyor (${event.start} - ${event.end})`;

        // 1. WS üzerinden chat'e gönder
        _sendWS({
          type:      'agenda_notification',
          level,
          title,
          message,
          event: {
            id:    event.id,
            title: event.title,
            date:  event.date,
            start: event.start,
            end:   event.end,
            type:  event.type,
          },
          timestamp: new Date().toISOString(),
        });

        // 2. Proactive engine varsa ona da gönder (masaüstü + ses)
        if (proactiveEngine && typeof proactiveEngine.sendManual === 'function') {
          try {
            await proactiveEngine.sendManual(message, ['chat', 'desktop']);
          } catch (e) {
            console.warn('[AgendaProactive] Proactive gönderim hatası:', e.message);
          }
        }

        // 3. Brain'e öğret
        if (brain) {
          try {
            brain.learn(
              `Ajanda hatırlatma: ${event.title} ${label}`,
              `[AgendaProactive] Bildirim gönderildi: ${level}`
            );
          } catch (e) {}
        }

        // 4. Bildirimi işaretleme
        agendaManager.markNotified(event.id, level);

        console.log(`[AgendaProactive] 🔔 "${event.title}" → ${label} bildirimi gönderildi.`);
      }
    }
  }

  // ── Ollama ile Akıllı Bildirim Üret ─────────────────────
  // Yaklaşan etkinlik için Ollama'ya kişiselleştirilmiş mesaj oluşturtur
  async function generateSmartNotification(event, minutesLeft, axios, brain) {
    if (!axios) return null;
    try {
      const profileHint = brain?.userProfile?.getProfilePrompt() || '';
      const prompt = [
        profileHint,
        `=== GÖREV ===`,
        `Kullanıcının "${event.title}" adlı etkinliği ${minutesLeft} dakika sonra başlıyor (${event.start}).`,
        `Bu etkinlik için kısa, samimi ve motive edici bir Türkçe hatırlatma mesajı yaz.`,
        `Maksimum 2 cümle. Emoji kullan.`,
      ].filter(Boolean).join('\n\n');

      const r = await axios.post('http://localhost:11434/api/generate', {
        model:  'llama3.1:8b',
        stream: false,
        prompt,
      });
      return (r.data?.response || '').trim().slice(0, 300);
    } catch (e) {
      return null;
    }
  }

  // ── Günlük Özet (Sabah) ─────────────────────────────────
  async function sendDailySummary(axios, brain) {
    const todayISO = new Date().toISOString().split('T')[0];
    const todayEvents = agendaManager.getByDate(todayISO);
    if (todayEvents.length === 0) return;

    const eventLines = todayEvents.map(e => `  • ${e.start}: ${e.title}`).join('\n');
    const message = `📅 Bugünkü ajandan:\n${eventLines}`;

    _sendWS({
      type:    'agenda_notification',
      level:   'daily_summary',
      title:   '☀️ Bugünkü Ajanda',
      message,
      events:  todayEvents,
      timestamp: new Date().toISOString(),
    });

    if (proactiveEngine) {
      try { await proactiveEngine.sendManual(message, ['chat']); } catch (e) {}
    }
    console.log('[AgendaProactive] 📋 Günlük özet gönderildi.');
  }

  start();

  return {
    start,
    stop,
    registerWsClient,
    sendDailySummary,
    generateSmartNotification,
    checkNow: _checkApproaching,
  };
}

module.exports = { mount };
