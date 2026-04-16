// ============================================================
// 💭 brain/distraction.js — Dikkat Dağılması & Geri Odaklanma
// Önemli şeyleri not alır, sonra gündeme getirir
// ============================================================

const mem = require("./memory");

// ── Bekleyen notlar ───────────────────────────────────────
let _pending = [];   // not alınan ama henüz gündeme getirilmemiş şeyler
let _focus   = null; // şu anki odak noktası

// ── Odak noktasını ayarla ─────────────────────────────────
function setFocus(topic) {
  _focus = {
    topic,
    setAt:   new Date().toISOString(),
    turnCount: 0
  };
  console.log(`[Distraction] 🎯 Odak: "${topic}"`);
}

// ── Dikkat dağıldığında not al ────────────────────────────
function noteAside(content, importance = 0.5) {
  const note = {
    id:        Date.now(),
    content,
    importance,
    notedAt:   new Date().toISOString(),
    surfaced:  false
  };
  _pending.unshift(note);
  if (_pending.length > 20) _pending.length = 20;

  mem.remember(`aside:${note.id}`, content, importance);
  console.log(`[Distraction] 📌 Not alındı: "${content.substring(0, 50)}"`);
  return note;
}

// ── Her konuşmada kontrol et — önemli bir not var mı? ────
function tick(currentMessage) {
  if (_focus) _focus.turnCount++;

  // Odaktan çok uzaklaşıldıysa hatırlat
  if (_focus && _focus.turnCount > 5) {
    const reminder = `(Not: Orijinal odak "${_focus.topic}" idi, konudan saptık mı?)`;
    _focus.turnCount = 0;
    return { type: "refocus", message: reminder };
  }

  // Bekleyen önemli bir not var mı?
  const important = _pending
    .filter(n => !n.surfaced && n.importance >= 0.7)
    .sort((a, b) => b.importance - a.importance)[0];

  if (important) {
    important.surfaced = true;
    return {
      type:    "pending_note",
      message: `(Daha önce not etmiştim: "${important.content.substring(0, 80)}")`
    };
  }

  return null;
}

// ── Dikkat dağılması prompt'u ─────────────────────────────
function getDistractionPrompt(currentMessage) {
  const result = tick(currentMessage);
  if (!result) return "";

  if (result.type === "refocus") {
    return `=== ODAK HATIRLATICI ===\n${result.message}`;
  }
  if (result.type === "pending_note") {
    return `=== BEKLEYİM NOT ===\n${result.message}`;
  }
  return "";
}

// ── Mevcut odak ve bekleyen notlar ───────────────────────
function getStatus() {
  return {
    focus:   _focus,
    pending: _pending.filter(n => !n.surfaced).length
  };
}

module.exports = {
  setFocus,
  noteAside,
  tick,
  getDistractionPrompt,
  getStatus
};