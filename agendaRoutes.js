// ============================================================
// 📅 agendaRoutes.js — Ajanda API + Ollama AI Entegrasyonu v1
//
// server.js'in sonuna (proactiveEngine mount'tan sonra) ekle:
//
//   const agendaRoutes = require('./agendaRoutes');
//   const agendaEngine = agendaRoutes.mount(app, brain, axios, proactiveEngine, wss);
//   // wss.on('connection') içine:
//   agendaEngine.registerWsClient(ws);
//
// Mevcut hiçbir kodu bozmaz.
// ============================================================

'use strict';

const agendaManager  = require('./brain/agendaManager');
const agendaProactive = require('./brain/agendaProactive');

// ── Ollama ile Doğal Dil Komutunu İşle ───────────────────
async function _processWithOllama(text, axios, brain) {
  const agendaContext = agendaManager.getAgendaPrompt();
  const profileHint   = brain?.userProfile?.getProfilePrompt() || '';

  const systemPrompt = `Sen bir ajanda yönetim asistanısın. Kullanıcının doğal dil komutlarını analiz edip JSON formatında yanıt veriyorsun.

MEVCUT AJANDA:
${agendaContext || 'Ajanda boş.'}

KURALLLAR:
- SADECE JSON döndür, başka hiçbir şey yazma
- Yanıt formatı:
{
  "action": "add" | "delete" | "update" | "list" | "unknown",
  "event": {            // sadece add/update için
    "title": "başlık",
    "date":  "YYYY-MM-DD",
    "start": "HH:MM",
    "end":   "HH:MM",
    "type":  "work|personal|school|health|other",
    "notes": "varsa not"
  },
  "deleteTitle": "...",  // delete için: hangi başlıkla eşleşsin
  "deleteDate": "...",   // delete için: hangi tarihteki
  "message": "kullanıcıya söylenecek kısa Türkçe mesaj"
}

Bugünün tarihi: ${new Date().toLocaleDateString('tr-TR', { year:'numeric', month:'long', day:'numeric', weekday:'long' })}
Şu anki saat: ${new Date().toLocaleTimeString('tr-TR', { hour:'2-digit', minute:'2-digit' })}`;

  try {
    const r = await axios.post('http://localhost:11434/api/chat', {
      model:  'llama3.1:8b',
      stream: false,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: text },
      ],
    });

    const raw = r.data?.message?.content || '{}';
    // JSON'u güvenli parse et
    const cleaned = raw.replace(/```json|```/g, '').trim();
    const firstBrace = cleaned.indexOf('{');
    const lastBrace  = cleaned.lastIndexOf('}');
    if (firstBrace === -1) throw new Error('JSON bulunamadı');
    return JSON.parse(cleaned.slice(firstBrace, lastBrace + 1));
  } catch (e) {
    console.warn('[AgendaRoutes] Ollama parse hatası, NLP fallback:', e.message);
    // Ollama'ya ulaşılamaz veya parse hatası → NLP fallback
    return _nlpFallback(text);
  }
}

// ── NLP Fallback (Ollama kapalıysa) ──────────────────────
function _nlpFallback(text) {
  const parsed = agendaManager.parseNaturalLanguage(text);
  return {
    action:  parsed.action || 'unknown',
    event:   parsed.event  || null,
    message: parsed.message || '',
  };
}

// ── Ollama ile Akıllı Cevap Üret ─────────────────────────
async function _generateReply(action, event, deletedEvent, upcoming, userText, axios, brain) {
  try {
    const profileHint = brain?.userProfile?.getProfilePrompt() || '';
    let situationDesc = '';
    if (action === 'add' && event) {
      situationDesc = `Kullanıcı "${event.title}" etkinliğini ${event.date} tarihine ${event.start} saatine ekledi.`;
    } else if (action === 'delete' && deletedEvent) {
      situationDesc = `Kullanıcı "${deletedEvent.title}" etkinliğini sildi.`;
    } else if (action === 'list') {
      const lines = (upcoming || []).slice(0, 5).map(e => `  • ${e.date} ${e.start}: ${e.title}`).join('\n');
      situationDesc = `Kullanıcı ajanda listesini istedi. Yaklaşan etkinlikler:\n${lines || '(boş)'}`;
    } else {
      situationDesc = `Kullanıcı şunu dedi: "${userText}"`;
    }

    const r = await axios.post('http://localhost:11434/api/generate', {
      model:  'llama3.1:8b',
      stream: false,
      prompt: [
        profileHint,
        situationDesc,
        'Bu duruma uygun, kısa ve samimi Türkçe bir yanıt yaz. Maksimum 2 cümle.',
      ].filter(Boolean).join('\n\n'),
    });
    return (r.data?.response || '').trim().slice(0, 300);
  } catch (e) {
    return null;
  }
}

// ── Mount ─────────────────────────────────────────────────
function mount(app, brain, axios, proactiveEngine, wss) {

  // Proactive bildirim motorunu başlat
  const agendaNotifier = agendaProactive.mount(
    agendaManager,
    proactiveEngine,
    brain,
    null  // wss bağlantısını ayrıca registerWsClient ile yönetiriz
  );

  // ── GET /agenda/events ─ Tüm etkinlikler ────────────────
  app.get('/agenda/events', (req, res) => {
    res.json({ status: 'success', events: agendaManager.getAll() });
  });

  // ── GET /agenda/events/date/:date ─ Gün bazlı ────────────
  app.get('/agenda/events/date/:date', (req, res) => {
    const { date } = req.params;
    res.json({ status: 'success', events: agendaManager.getByDate(date) });
  });

  // ── GET /agenda/upcoming ─ Yaklaşan (7 gün) ─────────────
  app.get('/agenda/upcoming', (req, res) => {
    const days = parseInt(req.query.days) || 7;
    res.json({ status: 'success', events: agendaManager.getUpcoming(days) });
  });

  // ── POST /agenda/events ─ Manuel ekle ───────────────────
  app.post('/agenda/events', (req, res) => {
    const { date, start, end, title, type, notes } = req.body;
    if (!title || !date) return res.json({ status: 'error', message: 'title ve date zorunlu' });

    const event = agendaManager.addEvent({ date, start, end, title, type, notes, source: 'manual' });
    agendaManager.notifyBrain(brain, 'add', event);

    res.json({ status: 'success', event });
  });

  // ── PUT /agenda/events/:id ─ Güncelle ───────────────────
  app.put('/agenda/events/:id', (req, res) => {
    const updated = agendaManager.updateEvent(req.params.id, req.body);
    if (!updated) return res.json({ status: 'error', message: 'Etkinlik bulunamadı' });
    agendaManager.notifyBrain(brain, 'update', updated);
    res.json({ status: 'success', event: updated });
  });

  // ── DELETE /agenda/events/:id ─ Sil ─────────────────────
  app.delete('/agenda/events/:id', (req, res) => {
    const removed = agendaManager.removeEvent(req.params.id);
    if (!removed) return res.json({ status: 'error', message: 'Etkinlik bulunamadı' });
    agendaManager.notifyBrain(brain, 'delete', removed);
    res.json({ status: 'success', removed });
  });

  // ── POST /agenda/ai-command ─ Ollama ile doğal dil ──────
  // Ana endpoint: HTML'den gelen doğal dil komutlarını işler
  app.post('/agenda/ai-command', async (req, res) => {
    const { text, sessionId = 'default' } = req.body;
    if (!text) return res.json({ status: 'error', message: 'text zorunlu' });

    console.log(`[AgendaRoutes] 🤖 AI Komut: "${text.slice(0, 80)}"`);

    // 1. Ollama ile analiz et (fallback: NLP)
    const parsed = await _processWithOllama(text, axios, brain);

    let actionResult = null;
    let deletedEvent = null;

    if (parsed.action === 'add' && parsed.event) {
      // Etkinlik ekle
      const newEvent = agendaManager.addEvent({
        ...parsed.event,
        source: 'ollama',
      });
      agendaManager.notifyBrain(brain, 'add', newEvent);
      actionResult = newEvent;

    } else if (parsed.action === 'delete') {
      // Başlık veya tarih ile eşleştirerek sil
      const allEvents = agendaManager.getAll();
      let target = null;

      if (parsed.deleteTitle) {
        const searchTitle = parsed.deleteTitle.toLowerCase();
        target = allEvents.find(e => e.title.toLowerCase().includes(searchTitle));
      }
      if (!target && parsed.deleteDate) {
        target = allEvents.find(e => e.date === parsed.deleteDate);
      }
      if (!target && parsed.event?.title) {
        const searchTitle = parsed.event.title.toLowerCase();
        target = allEvents.find(e => e.title.toLowerCase().includes(searchTitle));
      }

      if (target) {
        deletedEvent = agendaManager.removeEvent(target.id);
        agendaManager.notifyBrain(brain, 'delete', deletedEvent);
        actionResult = deletedEvent;
      }

    } else if (parsed.action === 'update' && parsed.event) {
      // Güncelle: önce eşleştir
      const allEvents = agendaManager.getAll();
      const searchTitle = (parsed.event.title || '').toLowerCase();
      const target = allEvents.find(e => e.title.toLowerCase().includes(searchTitle));
      if (target) {
        const updated = agendaManager.updateEvent(target.id, parsed.event);
        agendaManager.notifyBrain(brain, 'update', updated);
        actionResult = updated;
      }
    }

    // 2. Ollama ile kişiselleştirilmiş cevap üret
    const upcoming = agendaManager.getUpcoming(7);
    const aiReply  = await _generateReply(
      parsed.action,
      parsed.action === 'add' ? actionResult : null,
      deletedEvent,
      upcoming,
      text,
      axios,
      brain
    );

    // 3. Brain'e öğret (komut + sonuç)
    try {
      brain?.learn(text, aiReply || parsed.message || 'Ajanda güncellendi.');
    } catch (e) {}

    res.json({
      status:   'success',
      action:   parsed.action,
      result:   actionResult,
      message:  aiReply || parsed.message || 'Tamam!',
      events:   agendaManager.getAll(),  // güncel listeyi döndür
    });
  });

  // ── POST /agenda/ollama-chat ─ Ajanda hakkında sohbet ───
  // Örn: "Bu hafta yoğun muyum?", "Cuma için ne planlamıştım?"
  app.post('/agenda/ollama-chat', async (req, res) => {
    const { message, sessionId = 'agenda' } = req.body;
    if (!message) return res.json({ status: 'error', message: 'message zorunlu' });

    const agendaCtx = agendaManager.getAgendaPrompt();
    const profile   = brain?.userProfile?.getProfilePrompt() || '';
    const upcoming  = agendaManager.getUpcoming(14);
    const allText   = upcoming.map(e =>
      `${e.date} ${e.start}-${e.end}: ${e.title} (${e.type})`
    ).join('\n') || 'Yaklaşan etkinlik yok.';

    const systemPrompt = [
      profile,
      `Sen kullanıcının kişisel ajanda asistanısın. Türkçe konuş.`,
      `\n=== MEVCUT AJANDA (14 gün) ===\n${allText}`,
      `Bugünün tarihi: ${new Date().toLocaleDateString('tr-TR', { weekday:'long', year:'numeric', month:'long', day:'numeric' })}`,
    ].filter(Boolean).join('\n\n');

    try {
      const r = await axios.post('http://localhost:11434/api/chat', {
        model:  'llama3.1:8b',
        stream: false,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user',   content: message },
        ],
      });
      const answer = r.data?.message?.content || '';
      brain?.learn(message, answer);
      res.json({ status: 'success', answer });
    } catch (e) {
      res.json({ status: 'error', message: 'Ollama yanıt vermedi.' });
    }
  });

  // ── GET /agenda/status ─ Motor durumu ───────────────────
  app.get('/agenda/status', (req, res) => {
    res.json({
      status:       'success',
      totalEvents:  agendaManager.getAll().length,
      upcoming:     agendaManager.getUpcoming(7).length,
      prompt:       agendaManager.getAgendaPrompt(),
    });
  });

  // ── POST /agenda/notify-test ─ Test bildirimi ────────────
  app.post('/agenda/notify-test', async (req, res) => {
    await agendaNotifier.checkNow();
    res.json({ status: 'success', message: 'Kontrol yapıldı.' });
  });

  // ── POST /agenda/daily-summary ─ Günlük özet gönder ─────
  app.post('/agenda/daily-summary', async (req, res) => {
    await agendaNotifier.sendDailySummary(axios, brain);
    res.json({ status: 'success' });
  });

  // ── Brain prompt zenginleştirme (brain.enrichPrompt'u patch) ─
  // Brain'in enrichPrompt'una ajanda bağlamını otomatik ekle
  if (brain && typeof brain.enrichPrompt === 'function') {
    const _originalEnrich = brain.enrichPrompt.bind(brain);
    brain.enrichPrompt = function(userPrompt) {
      const enriched = _originalEnrich(userPrompt);
      const agendaCtx = agendaManager.getAgendaPrompt();
      if (!agendaCtx) return enriched;
      // Ajanda bağlamını ekle (userPrompt bölümünden önce)
      const marker = '=== KULLANICI İSTEĞİ ===';
      if (enriched.includes(marker)) {
        return enriched.replace(marker, agendaCtx + '\n\n' + marker);
      }
      return agendaCtx + '\n\n' + enriched;
    };
    console.log('[AgendaRoutes] 🧠 Brain.enrichPrompt ajanda bağlamıyla genişletildi.');
  }

  console.log('📅 Ajanda Routes yüklendi! Endpointler:');
  console.log('  GET  /agenda/events');
  console.log('  POST /agenda/events');
  console.log('  POST /agenda/ai-command  ← Ollama NL kontrol');
  console.log('  POST /agenda/ollama-chat ← Ajanda hakkında sohbet');
  console.log('  GET  /agenda/upcoming');

  return {
    registerWsClient: agendaNotifier.registerWsClient,
    agendaManager,
    agendaNotifier,
  };
}

module.exports = { mount };
