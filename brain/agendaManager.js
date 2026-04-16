// ============================================================
// 📅 brain/agendaManager.js — Ajanda Motoru v1
//
// Brain sistemine tam entegre, Ollama destekli ajanda yöneticisi.
// Mevcut hiçbir dosyaya dokunmaz.
//
// KURULUM — server.js'in en altına (proactiveEngine'den sonra) ekle:
//   const agendaRoutes = require('./agendaRoutes');
//   agendaRoutes.mount(app, brain, axios, proactiveEngine, wss);
//
// ============================================================

'use strict';

const fs   = require('fs');
const path = require('path');

const AGENDA_FILE = path.join(__dirname, '..', 'agenda_events.json');

// ── Varsayılan etkinlik şablonu ───────────────────────────
function _defaultEvent(overrides = {}) {
  return {
    id:          Date.now() + Math.floor(Math.random() * 10000),
    date:        _todayISO(),          // 'YYYY-MM-DD'
    start:       '09:00',             // 'HH:MM'
    end:         '10:00',             // 'HH:MM'
    title:       'Yeni Etkinlik',
    type:        'work',              // work | personal | school | health | other
    notes:       '',
    notified:    {},                  // { '60min': bool, '15min': bool, '5min': bool }
    source:      'manual',            // manual | ollama | nlp
    createdAt:   new Date().toISOString(),
    updatedAt:   new Date().toISOString(),
    ...overrides,
  };
}

// ── Yardımcılar ───────────────────────────────────────────
function _todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function _toISODate(d) {
  const offset = d.getTimezoneOffset() * 60000;
  return new Date(d.getTime() - offset).toISOString().split('T')[0];
}

function _timeToMinutes(timeStr) {
  const [h, m] = (timeStr || '00:00').split(':').map(Number);
  return h * 60 + m;
}

// ── Disk I/O ──────────────────────────────────────────────
let _events = [];
let _saveTimer = null;

function _load() {
  try {
    if (fs.existsSync(AGENDA_FILE)) {
      _events = JSON.parse(fs.readFileSync(AGENDA_FILE, 'utf-8'));
      console.log(`[AgendaManager] 📅 ${_events.length} etkinlik yüklendi.`);
    }
  } catch (e) {
    console.warn('[AgendaManager] ⚠️ Yüklenemedi, sıfır başlıyor:', e.message);
    _events = [];
  }
}

function _save() {
  if (_saveTimer) clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => {
    try {
      fs.writeFileSync(AGENDA_FILE, JSON.stringify(_events, null, 2), 'utf-8');
    } catch (e) {
      console.error('[AgendaManager] ❌ Kaydetme hatası:', e.message);
    }
  }, 1000);
}

// ── CRUD İşlemleri ────────────────────────────────────────

function addEvent(data) {
  const event = _defaultEvent(data);
  _events.push(event);
  _save();
  console.log(`[AgendaManager] ✅ Etkinlik eklendi: "${event.title}" ${event.date} ${event.start}`);
  return event;
}

function removeEvent(id) {
  const idx = _events.findIndex(e => String(e.id) === String(id));
  if (idx === -1) return null;
  const removed = _events.splice(idx, 1)[0];
  _save();
  console.log(`[AgendaManager] 🗑️ Etkinlik silindi: "${removed.title}"`);
  return removed;
}

function updateEvent(id, patch) {
  const event = _events.find(e => String(e.id) === String(id));
  if (!event) return null;
  Object.assign(event, patch, { updatedAt: new Date().toISOString() });
  _save();
  console.log(`[AgendaManager] ✏️ Etkinlik güncellendi: "${event.title}"`);
  return event;
}

function getAll() {
  return [..._events].sort((a, b) =>
    (a.date + a.start).localeCompare(b.date + b.start)
  );
}

function getByDate(dateStr) {
  return _events
    .filter(e => e.date === dateStr)
    .sort((a, b) => a.start.localeCompare(b.start));
}

function getUpcoming(limitDays = 7) {
  const today = _todayISO();
  const maxDate = _toISODate(new Date(Date.now() + limitDays * 86400000));
  return _events
    .filter(e => e.date >= today && e.date <= maxDate)
    .sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start));
}

function getEventById(id) {
  return _events.find(e => String(e.id) === String(id)) || null;
}

// ── Bildirim Durumu ──────────────────────────────────────
function markNotified(id, level) {
  const event = _events.find(e => String(e.id) === String(id));
  if (!event) return;
  if (!event.notified) event.notified = {};
  event.notified[level] = true;
  _save();
}

function isNotified(event, level) {
  return !!(event.notified && event.notified[level]);
}

// ── Yaklaşan Kontrol ─────────────────────────────────────
// Şu andan X dakika sonra başlayan etkinlikleri döner
function getApproachingEvents(thresholdMinutes) {
  const now = new Date();
  const todayISO = _todayISO();
  const nowMinutes = now.getHours() * 60 + now.getMinutes();

  return _events.filter(event => {
    if (event.date !== todayISO) return false;
    const startMin = _timeToMinutes(event.start);
    const diff = startMin - nowMinutes;
    return diff >= 0 && diff <= thresholdMinutes;
  });
}

// ── NLP: Doğal Dil → Etkinlik (sunucu tarafı) ─────────────
const _MONTHS_TR = ['ocak','şubat','mart','nisan','mayıs','haziran','temmuz','ağustos','eylül','ekim','kasım','aralık'];
const _DAYS_TR   = ['pazar','pazartesi','salı','çarşamba','perşembe','cuma','cumartesi'];

function parseNaturalLanguage(text) {
  text = text.toLowerCase().trim();
  const result = { action: null, event: null, message: '' };

  // ── Silme ──────────────────────────────────────────────
  if (text.includes('sil') || text.includes('kaldır') || text.includes('iptal')) {
    result.action = 'delete';
    // Başlık tahmini
    const titleMatch = text.match(/[""](.+?)[""]/) || text.match(/["'](.+?)["']/);
    result.title = titleMatch ? titleMatch[1] : null;
    result.message = 'Silme işlemi için id veya başlık gerekmez — Ollama halleder.';
    return result;
  }

  // ── Listeleme ──────────────────────────────────────────
  if (text.includes('liste') || text.includes('göster') || text.includes('neler var') || text.includes('bugün ne var')) {
    result.action = 'list';
    return result;
  }

  // ── Tarih tespiti ──────────────────────────────────────
  let targetDate = new Date();

  const dateRegex = new RegExp(`(\\d{1,2})\\s+(${_MONTHS_TR.join('|')})`, 'i');
  const dateMatch = text.match(dateRegex);

  if (dateMatch) {
    const day        = parseInt(dateMatch[1]);
    const monthIndex = _MONTHS_TR.indexOf(dateMatch[2].toLowerCase());
    const year       = new Date().getFullYear();
    targetDate       = new Date(year, monthIndex, day);
    if (targetDate < new Date() && !text.includes('geçen'))
      targetDate.setFullYear(year + 1);
  } else if (text.includes('yarın')) {
    targetDate = new Date(Date.now() + 86400000);
  } else if (text.includes('öbür gün')) {
    targetDate = new Date(Date.now() + 2 * 86400000);
  } else if (!text.includes('bugün')) {
    for (let i = 0; i < 7; i++) {
      if (text.includes(_DAYS_TR[i])) {
        const today = new Date().getDay();
        let diff = i - today;
        if (diff <= 0) diff += 7;
        if (text.includes('haftaya')) diff += 7;
        targetDate = new Date(Date.now() + diff * 86400000);
        break;
      }
    }
  }

  const isoDate = _toISODate(targetDate);

  // ── Saat tespiti ───────────────────────────────────────
  let startH = 9, startM = 0, endH = 10, endM = 0;
  const timeRegex = /(\d{1,2})(?:[.:]((\d{2})))?/g;
  const times = [...text.matchAll(timeRegex)];
  if (times.length > 0) {
    startH = parseInt(times[0][1]);
    startM = times[0][2] ? parseInt(times[0][2]) : 0;
    if (times.length > 1) {
      endH = parseInt(times[1][1]);
      endM = times[1][2] ? parseInt(times[1][2]) : 0;
    } else {
      endH   = startH + 1;
    }
  }

  // ── Başlık tespiti ─────────────────────────────────────
  let title = text
    .replace(dateRegex, '')
    .replace(/yarın|bugün|haftaya|öbür gün/gi, '')
    .replace(new RegExp(_DAYS_TR.join('|'), 'gi'), '')
    .replace(/program|hazırla|ekle|randevusu|yap|saat|koy|oluştur|ayarla/gi, '')
    .replace(/\d{1,2}[:.]\d{0,2}/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();

  if (title.length < 2) title = 'Yeni Etkinlik';
  else title = title.charAt(0).toUpperCase() + title.slice(1);

  let type = 'work';
  if (/doktor|diş|spor|jimnastik|yürüyüş/.test(text)) type = 'personal';
  if (/okul|sınav|ödev|ders/.test(text)) type = 'school';
  if (/ilaç|hastane|tedavi/.test(text)) type = 'health';

  result.action = 'add';
  result.event  = {
    date:  isoDate,
    start: `${String(startH).padStart(2,'0')}:${String(startM).padStart(2,'0')}`,
    end:   `${String(endH).padStart(2,'0')}:${String(endM).padStart(2,'0')}`,
    title,
    type,
    source: 'nlp',
  };
  return result;
}

// ── Brain Entegrasyonu ────────────────────────────────────
// Brain modülüne etkinlik ekleme/silme öğret
function notifyBrain(brain, action, event) {
  if (!brain) return;
  try {
    const msg = action === 'add'
      ? `Ajandaya eklendi: ${event.title} - ${event.date} saat ${event.start}`
      : `Ajandadan silindi: ${event.title}`;
    brain.learn(msg, `[AgendaManager] ${action}: ${event.title}`);
    brain.userProfile.onInteraction(msg, `Ajanda güncellendi.`, { emotion: 'neutral' });
    console.log(`[AgendaManager] 🧠 Brain güncellendi: ${action} "${event.title}"`);
  } catch (e) {
    console.warn('[AgendaManager] Brain güncelleme hatası:', e.message);
  }
}

// ── Ajanda Özeti (Brain Prompt için) ─────────────────────
function getAgendaPrompt() {
  const upcoming = getUpcoming(3);
  if (upcoming.length === 0) return '';
  const lines = upcoming.slice(0, 5).map(e => {
    const d = new Date(e.date);
    const dateStr = d.toLocaleDateString('tr-TR', { day:'numeric', month:'long' });
    return `  • ${dateStr} ${e.start}: ${e.title} (${e.type})`;
  });
  return `=== AJANDA (Yaklaşan Etkinlikler) ===\n${lines.join('\n')}`;
}

// ── Başlat ────────────────────────────────────────────────
_load();

// Graceful shutdown
process.on('SIGINT',  () => { if (_saveTimer) { clearTimeout(_saveTimer); try { fs.writeFileSync(AGENDA_FILE, JSON.stringify(_events, null, 2)); } catch(e){} } });
process.on('SIGTERM', () => { if (_saveTimer) { clearTimeout(_saveTimer); try { fs.writeFileSync(AGENDA_FILE, JSON.stringify(_events, null, 2)); } catch(e){} } });

console.log('[AgendaManager] 📅 v1 yüklendi.');

module.exports = {
  addEvent,
  removeEvent,
  updateEvent,
  getAll,
  getByDate,
  getUpcoming,
  getEventById,
  markNotified,
  isNotified,
  getApproachingEvents,
  parseNaturalLanguage,
  notifyBrain,
  getAgendaPrompt,
};
