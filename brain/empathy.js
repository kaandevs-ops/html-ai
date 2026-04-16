// ============================================================
// 💙 brain/empathy.js — Empati & Kullanıcı Duygu Tespiti
// Kullanıcının mesaj tonuna göre cevap tonunu ayarlar
// ============================================================

// ── Duygu kelime listeleri ────────────────────────────────
const EMOTION_KEYWORDS = {
  angry: [
    "sinir", "kızgın", "saçma", "berbat", "olmaz", "neden", "niye",
    "işe yaramıyor", "çalışmıyor", "bozuk", "lanet", "aptal", "salak"
  ],
  stressed: [
    "acil", "hızlı", "çabuk", "zaman yok", "yetişemiyorum", "panik",
    "deadline", "bitmedi", "hala", "hâlâ", "ne zaman"
  ],
  happy: [
    "harika", "süper", "mükemmel", "teşekkür", "güzel", "çok iyi",
    "oldu", "başardım", "sevdim", "bravo", "eyvallah"
  ],
  confused: [
    "anlamadım", "nasıl", "nedir", "ne demek", "açıkla", "bilmiyorum",
    "emin değilim", "karıştım", "kafam karıştı"
  ],
  sad: [
    "üzgün", "kötü", "yorgun", "bıktım", "sıkıldım", "motivasyon yok",
    "olmuyor", "başaramıyorum", "zor"
  ]
};

// ── Kullanıcı duygusunu tespit et ─────────────────────────
function detectEmotion(message) {
  const msg    = message.toLowerCase();
  const scores = {};

  Object.entries(EMOTION_KEYWORDS).forEach(([emotion, keywords]) => {
    scores[emotion] = keywords.filter(k => msg.includes(k)).length;
  });

  const dominant = Object.entries(scores)
    .sort((a, b) => b[1] - a[1])[0];

  if (dominant[1] === 0) return { emotion: "neutral", score: 0 };

  return {
    emotion:  dominant[0],
    score:    dominant[1],
    allScores: scores
  };
}

// ── Duyguya göre LLM ton önerisi ─────────────────────────
function getTonePrompt(message) {
  const { emotion, score } = detectEmotion(message);
  if (score === 0) return "";

  const tones = {
    angry:    "Kullanıcı sinirli görünüyor. Savunmacı olma, kısa ve çözüm odaklı cevap ver. Özür dileme ama anlayışlı ol.",
    stressed: "Kullanıcı stres altında. Hızlı ve net cevap ver, gereksiz açıklama yapma. Önce çözümü söyle.",
    happy:    "Kullanıcı iyi bir ruh halinde. Samimi ve pozitif bir ton kullanabilirsin.",
    confused: "Kullanıcı kafası karışmış. Adım adım, basit ve anlaşılır açıkla. Jargon kullanma.",
    sad:      "Kullanıcı yorgun veya motivasyonsuz görünüyor. Anlayışlı ol, küçük adımlar öner, cesaretlendir."
  };

  const prompt = tones[emotion];
  if (!prompt) return "";

  console.log(`[Empathy] 💙 Kullanıcı duygusu: ${emotion} (skor: ${score})`);
  return `=== KULLANICI DUYGU DURUMU: ${emotion.toUpperCase()} ===\n${prompt}`;
}

// ── Kullanıcı profilini güncelle ──────────────────────────
const _userEmotionHistory = [];

function trackUserEmotion(message) {
  const result = detectEmotion(message);
  _userEmotionHistory.unshift({
    emotion:   result.emotion,
    score:     result.score,
    timestamp: new Date().toISOString()
  });
  if (_userEmotionHistory.length > 50) _userEmotionHistory.length = 50;
  return result;
}

// ── Kullanıcının genel duygu eğilimi ─────────────────────
function getUserEmotionProfile() {
  if (_userEmotionHistory.length === 0) return null;

  const counts = {};
  _userEmotionHistory.forEach(e => {
    counts[e.emotion] = (counts[e.emotion] || 0) + 1;
  });

  const dominant = Object.entries(counts)
    .sort((a, b) => b[1] - a[1])[0];

  return {
    dominantEmotion: dominant[0],
    distribution:    counts,
    totalSamples:    _userEmotionHistory.length
  };
}

module.exports = {
  detectEmotion,
  getTonePrompt,
  trackUserEmotion,
  getUserEmotionProfile
};