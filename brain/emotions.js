// ============================================================
// 💜 brain/emotions.js — Duygusal State Motoru v2
// DÜZELTİLEN HATALAR:
//   - Çift tetiklenme koruması eklendi (cooldown)
//   - Yeni: valence (pozitif/negatif ton) metriği eklendi
//   - Yeni: streak (art arda başarı/hata) sistemi
//   - getMoodPrompt() daha akıllı ve bağlama duyarlı
//   - Periyodik decay daha gerçekçi (üstel azalma)
//   - getState() artık hesaplanmış "mood" etiketi de döndürüyor
// ============================================================

// ── Duygusal state ─────────────────────────────────────────
const state = {
  confidence:   0.75,  // 0–1: ne kadar emin
  urgency:      0.3,   // 0–1: aciliyet
  fatigue:      0.0,   // 0–1: yorgunluk
  frustration:  0.0,   // 0–1: hayal kırıklığı
  curiosity:    0.6,   // 0–1: merak / keşif isteği
  valence:      0.5,   // 0–1: genel pozitiflik (0=çok negatif, 1=çok pozitif)

  // Streak sistemi
  successStreak: 0,    // art arda kaç başarı
  failStreak:    0,    // art arda kaç hata

  lastUpdated:   new Date().toISOString(),
  _lastEventMs:  0     // çift tetiklenme koruması için
};

const COOLDOWN_MS = 200; // 200ms içinde aynı event tekrar sayılmaz

// ── Başarı ────────────────────────────────────────────────
function onSuccess() {
  if (!_checkCooldown()) return;

  state.successStreak++;
  state.failStreak = 0;

  // Art arda başarılar güven artışını katlıyor
  const bonus = Math.min(0.05 * state.successStreak, 0.15);
  state.confidence  = Math.min(1.0, state.confidence  + bonus);
  state.frustration = Math.max(0.0, state.frustration - 0.12);
  state.urgency     = Math.max(0.0, state.urgency     - 0.05);
  state.fatigue     = Math.min(1.0, state.fatigue     + 0.02); // az yorar
  state.valence     = Math.min(1.0, state.valence     + 0.07);

  _update();
  _log(`✅ Başarı (#${state.successStreak} seri)`);
}

// ── Başarısızlık ──────────────────────────────────────────
function onFailure(isCritical = false) {
  if (!_checkCooldown()) return;

  state.failStreak++;
  state.successStreak = 0;

  const penalty = isCritical
    ? 0.18
    : Math.min(0.06 * state.failStreak, 0.18); // tekrar hatalarda ceza artıyor

  state.confidence  = Math.max(0.1,  state.confidence  - penalty);
  state.frustration = Math.min(1.0,  state.frustration + 0.12);
  state.urgency     = Math.min(1.0,  state.urgency     + 0.06);
  state.fatigue     = Math.min(1.0,  state.fatigue     + 0.05);
  state.valence     = Math.max(0.0,  state.valence     - 0.08);

  _update();
  _log(`❌ Hata (#${state.failStreak} seri, kritik: ${isCritical})`);
}

// ── Zaman geçişi ──────────────────────────────────────────
function onTimeTick(hoursPassed = 1) {
  // Üstel decay — doğal iyileşme
  const decay = Math.exp(-0.08 * hoursPassed);
  state.fatigue     = state.fatigue     * decay;
  state.frustration = state.frustration * decay;
  state.urgency     = Math.max(0.2, state.urgency * decay); // baseline urgency 0.2

  // Confidence normalize olur ama tam sıfırlanmaz
  state.confidence  = state.confidence * 0.99 + 0.01 * 0.75;
  state.valence     = state.valence    * 0.98 + 0.02 * 0.5;  // nötre çeker

  // Uzun dinlenme → streak sıfırlanır (gün değişimi)
  if (hoursPassed >= 8) {
    state.successStreak = 0;
    state.failStreak    = 0;
  }

  _update();
}

// ── Yeni görev ────────────────────────────────────────────
function onNewTask() {
  state.curiosity = Math.min(1.0, state.curiosity + 0.04);
  state.urgency   = Math.min(1.0, state.urgency   + 0.02);
  _update();
}

// ── Hesaplanmış ruh hali etiketi ──────────────────────────
function getMoodLabel() {
  const { confidence, frustration, fatigue, urgency, valence } = state;

  if (fatigue > 0.8)          return "TÜKENMİŞ";
  if (frustration > 0.75)     return "HAYAL_KIRIKLIGI";
  if (confidence > 0.85 && valence > 0.6) return "AKIŞ";       // Flow state
  if (confidence > 0.7  && frustration < 0.3) return "ODAKLI";
  if (urgency > 0.8)          return "KRİTİK";
  if (confidence < 0.35)      return "BELIRSIZ";
  if (frustration > 0.45)     return "ZORLANIYORUM";
  return "NORMAL";
}

// ── LLM için ton önerisi ──────────────────────────────────
function getMoodPrompt() {
  const parts  = [];
  const label  = getMoodLabel();
  const { confidence, frustration, fatigue, urgency, curiosity, failStreak, successStreak } = state;

  // Ruh hali başlığı
  parts.push(`Mevcut mod: ${label}`);

  if (confidence < 0.35) {
    parts.push("Düşük özgüven: Adım adım, çok dikkatli ilerle. Emin olmadığın şeyi YAPMA.");
  } else if (confidence > 0.85) {
    parts.push("Yüksek özgüven: Hızlı ve kararlı kararlar alabilirsin.");
  }

  if (failStreak >= 3) {
    parts.push(`${failStreak} üst üste hata var. Tamamen farklı bir yaklaşım dene — aynı yöntemi TEKRARLAMA.`);
  } else if (frustration > 0.5) {
    parts.push("Birkaç hata üst üste geldi. Farklı bir yol dene.");
  }

  if (successStreak >= 3) {
    parts.push(`${successStreak} üst üste başarı var. Ritim iyi, devam et.`);
  }

  if (fatigue > 0.75) {
    parts.push("Yüksek yorgunluk: Karmaşık işleri küçük parçalara böl.");
  }

  if (urgency > 0.75) {
    parts.push("Yüksek aciliyet: Önce kritik adımları tamamla.");
  }

  if (curiosity > 0.8) {
    parts.push("Yeni yöntemler denemeye açıksın — kullan bunu.");
  }

  if (parts.length <= 1) return ""; // sadece label varsa ekleme

  return "=== MOD DURUMU ===\n" + parts.join("\n");
}

// ── State oku ─────────────────────────────────────────────
function getState() {
  return {
    ...state,
    mood: getMoodLabel(),    // hesaplanmış etiket de ekleniyor
    _lastEventMs: undefined  // internal field'ı dışarıya verme
  };
}

function getSummary() {
  return (
    `conf:${state.confidence.toFixed(2)} ` +
    `urg:${state.urgency.toFixed(2)} ` +
    `fat:${state.fatigue.toFixed(2)} ` +
    `frus:${state.frustration.toFixed(2)} ` +
    `cur:${state.curiosity.toFixed(2)} ` +
    `val:${state.valence.toFixed(2)} ` +
    `mood:${getMoodLabel()}`
  );
}

// ── Yardımcılar ───────────────────────────────────────────
function _checkCooldown() {
  const now = Date.now();
  if (now - state._lastEventMs < COOLDOWN_MS) return false;
  state._lastEventMs = now;
  return true;
}

function _update() {
  state.lastUpdated = new Date().toISOString();
}

function _log(msg) {
  console.log(`[Emotions] ${msg} | ${getSummary()}`);
}

// ── Periyodik decay (her saat) ────────────────────────────
setInterval(() => {
  onTimeTick(1);
  _log("⏰ Saatlik tick");
}, 60 * 60 * 1000);

module.exports = {
  onSuccess,
  onFailure,
  onNewTask,
  onTimeTick,
  getMoodPrompt,
  getMoodLabel,
  getState,
  getSummary
};