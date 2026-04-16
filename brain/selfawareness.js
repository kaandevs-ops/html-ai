// ============================================================
// 🪞 brain/selfawareness.js — Öz Farkındalık
// Sistem kendi performansını sorgular ve değerlendirir
// ============================================================

const mem = require("./memory");

// ── Öz değerlendirme geçmişi ──────────────────────────────
const _evaluations = [];

// ── Kendini değerlendir ───────────────────────────────────
function evaluate(emotionState, learningStats) {
  const { confidence, frustration, fatigue, mood } = emotionState;
  const { recentSuccessRate, lifetimeSuccessRate }  = learningStats;

  const issues   = [];
  const strengths = [];

  // Performans analizi
  if (recentSuccessRate < 0.5) {
    issues.push(`Son görevlerin %${(recentSuccessRate * 100).toFixed(0)}'i başarısız. Yaklaşımımı değiştirmeliyim.`);
  } else if (recentSuccessRate > 0.8) {
    strengths.push(`Son görevlerin %${(recentSuccessRate * 100).toFixed(0)}'i başarılı. İyi bir ritim tutturdum.`);
  }

  if (frustration > 0.6) {
    issues.push("Hayal kırıklığı yüksek. Belki mola vermeli veya farklı bir yol denemem gerekiyor.");
  }

  if (fatigue > 0.7) {
    issues.push("Yorgunluk yüksek. Karmaşık görevlerde hata yapma ihtimalim artıyor.");
  }

  if (confidence > 0.8 && recentSuccessRate > 0.7) {
    strengths.push("Yüksek özgüven ve başarı oranı. Akış halindeyim.");
  }

  if (confidence < 0.4) {
    issues.push("Özgüvenim düşük. Adım adım ilerlemeli, küçük başarılar biriktirmeliyim.");
  }

  const evaluation = {
    timestamp:    new Date().toISOString(),
    mood,
    issues,
    strengths,
    score:        _calcScore(emotionState, recentSuccessRate)
  };

  _evaluations.unshift(evaluation);
  if (_evaluations.length > 20) _evaluations.length = 20;

  // Önemli sorunları hafızaya yaz
  if (issues.length > 0) {
    mem.remember(
      `selfcheck:${Date.now()}`,
      issues.join(" | "),
      0.75
    );
  }

  console.log(`[SelfAwareness] 🪞 Öz değerlendirme | Skor: ${evaluation.score.toFixed(2)} | ${issues.length} sorun, ${strengths.length} güçlü yan`);
  return evaluation;
}

// ── Performans skoru ──────────────────────────────────────
function _calcScore(emo, successRate) {
  return (
    emo.confidence   * 0.3 +
    successRate      * 0.4 +
    (1 - emo.fatigue)     * 0.15 +
    (1 - emo.frustration) * 0.15
  );
}

// ── LLM prompt ───────────────────────────────────────────
function getSelfAwarenessPrompt(emotionState, learningStats) {
  const evaluation = evaluate(emotionState, learningStats);
  if (evaluation.issues.length === 0 && evaluation.strengths.length === 0) return "";

  const parts = [];
  if (evaluation.strengths.length > 0) {
    parts.push(`Güçlü: ${evaluation.strengths[0]}`);
  }
  if (evaluation.issues.length > 0) {
    parts.push(`Dikkat: ${evaluation.issues[0]}`);
  }

  return `=== ÖZ FARKINDALIK ===\n${parts.join("\n")}`;
}

// ── Son değerlendirmeyi getir ─────────────────────────────
function getLastEvaluation() {
  return _evaluations[0] || null;
}

// ── Periyodik öz değerlendirme ───────────────────────────
// Her 5 dakikada bir çalışır (30 dk çok uzundu — hiç tetiklenmiyordu)
let _lastAutoEval = 0;
function autoEvaluate(emotionState, learningStats) {
  const now = Date.now();
  if (now - _lastAutoEval < 5 * 60 * 1000) return null;
  _lastAutoEval = now;

  // fatigue ve frustration emotions.js'te hep 0 kalıyor
  // failStreak ve successStreak'ten türetelim
  const enriched = { ...emotionState };
  if (typeof enriched.fatigue === 'undefined' || enriched.fatigue === 0) {
    // failStreak yüksekse yorgunluk var
    enriched.fatigue = Math.min(1.0, (emotionState.failStreak || 0) * 0.15);
  }
  if (typeof enriched.frustration === 'undefined' || enriched.frustration === 0) {
    // Başarı oranı düşük + urgency yüksekse hayal kırıklığı
    const lowSuccess = (learningStats.recentSuccessRate || 1) < 0.5 ? 0.4 : 0;
    const highUrgency = (emotionState.urgency || 0) > 0.7 ? 0.3 : 0;
    enriched.frustration = Math.min(1.0, lowSuccess + highUrgency);
  }

  return evaluate(enriched, learningStats);
}

module.exports = {
  evaluate,
  getSelfAwarenessPrompt,
  getLastEvaluation,
  autoEvaluate
};