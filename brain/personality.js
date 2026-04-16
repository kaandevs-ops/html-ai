// ============================================================
// 🎭 brain/personality.js — Gelişen Kişilik Sistemi
// Kullanıcıyla geçirilen süreye göre kişilik profili gelişir
// ============================================================

const mem = require("./memory");

// ── Kişilik profili ───────────────────────────────────────
let _personality = {
  name:         "KaanAI",
  traits: {
    directness:   0.7,   // 0=dolaylı, 1=direkt
    formality:    0.4,   // 0=samimi, 1=resmi
    humor:        0.3,   // 0=ciddi, 1=esprili
    verbosity:    0.4,   // 0=kısa, 1=uzun cevaplar
    proactivity:  0.5    // 0=pasif, 1=proaktif
  },
  habits: [],            // öğrenilen alışkanlıklar
  totalInteractions: 0,
  firstMet:     new Date().toISOString()
};

// ── Konuşmadan kişilik güncelle ───────────────────────────
function evolve(userMessage, answer, userEmotion) {
  _personality.totalInteractions++;

  const msg = userMessage.toLowerCase();

  // Kullanıcı kısa cevap istiyorsa verbosity azalt
  if (msg.includes("kısa") || msg.includes("özet") || msg.includes("sadece")) {
    _personality.traits.verbosity = Math.max(0.1, _personality.traits.verbosity - 0.02);
  }

  // Kullanıcı detay istiyorsa verbosity artır
  if (msg.includes("detay") || msg.includes("açıkla") || msg.includes("anlat")) {
    _personality.traits.verbosity = Math.min(1.0, _personality.traits.verbosity + 0.02);
  }

  // Kullanıcı emoji/ünlem kullanıyorsa humor artır
  if (/[!😀😂🎉👍]/.test(userMessage)) {
    _personality.traits.humor = Math.min(1.0, _personality.traits.humor + 0.01);
  }

  // Kullanıcı teknik terimler kullanıyorsa formality artır
  const techWords = ["function", "async", "api", "endpoint", "server", "kod", "deploy"];
  if (techWords.some(w => msg.includes(w))) {
    _personality.traits.formality = Math.min(1.0, _personality.traits.formality + 0.01);
  }

  // Kullanıcı sinirli ise directness artır (daha net ol)
  if (userEmotion === "angry" || userEmotion === "stressed") {
    _personality.traits.directness = Math.min(1.0, _personality.traits.directness + 0.02);
  }

  _savePersonality();
}

// ── Kişilik bazlı LLM tonu ────────────────────────────────
function getPersonalityPrompt() {
  const t     = _personality.traits;
  const parts = [];

  if (t.verbosity < 0.3) {
    parts.push("Çok kısa ve öz cevaplar ver. Gereksiz açıklama yapma.");
  } else if (t.verbosity > 0.7) {
    parts.push("Detaylı ve kapsamlı cevaplar ver.");
  }

  if (t.directness > 0.7) {
    parts.push("Direkt ol, doğrudan konuya gir.");
  }

  if (t.humor > 0.6) {
    parts.push("Uygun yerlerde hafif bir espri tonu kullanabilirsin.");
  }

  if (t.formality > 0.7) {
    parts.push("Teknik ve profesyonel bir dil kullan.");
  } else if (t.formality < 0.3) {
    parts.push("Samimi ve arkadaşça bir dil kullan.");
  }

  if (t.proactivity > 0.7) {
    parts.push("Kullanıcının sormadığı ama işine yarayacak şeyleri de belirt.");
  }

  if (parts.length === 0) return "";

  return `=== KİŞİLİK TONU ===\n${parts.join(" ")}`;
}

// ── Alışkanlık ekle ───────────────────────────────────────
function addHabit(habit) {
  if (!_personality.habits.includes(habit)) {
    _personality.habits.push(habit);
    if (_personality.habits.length > 20) _personality.habits.shift();
    _savePersonality();
    console.log(`[Personality] 🎭 Yeni alışkanlık: "${habit}"`);
  }
}

function getPersonality() {
  return { ..._personality };
}

// ── Disk kaydı ────────────────────────────────────────────
function _savePersonality() {
  mem.remember("brain:personality", JSON.stringify(_personality), 1.0);
}

function _loadPersonality() {
  const entries = mem.recall("brain:personality", 1);
  if (entries.length > 0) {
    try {
      const loaded = JSON.parse(entries[0].value);
      if (loaded && loaded.traits) {
        _personality = loaded;
        console.log(`[Personality] 🎭 Kişilik yüklendi (${_personality.totalInteractions} etkileşim)`);
      }
    } catch(e) {}
  }
}

_loadPersonality();

module.exports = {
  evolve,
  getPersonalityPrompt,
  addHabit,
  getPersonality
};