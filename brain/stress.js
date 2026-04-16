// ============================================================
// 😤 brain/stress.js — Stres Yönetimi & Yük Altında Önceliklendirme
// Fatigue + frustration yüksek olduğunda görev stratejisini değiştirir
// ============================================================

const STRESS_THRESHOLD  = 0.6;  // bu değerin üzerinde stres var
const BURNOUT_THRESHOLD = 0.85; // bu değerin üzerinde kritik

// ── Stres seviyesini hesapla ──────────────────────────────
function getStressLevel(emotionState) {
  const { fatigue = 0, frustration = 0, urgency = 0 } = emotionState;
  // Ağırlıklı ortalama: fatigue en önemli
  return (fatigue * 0.45) + (frustration * 0.35) + (urgency * 0.2);
}

// ── Stres durumuna göre strateji üret ────────────────────
function getStrategy(emotionState) {
  const level = getStressLevel(emotionState);

  if (level >= BURNOUT_THRESHOLD) {
    return {
      level:      "TÜKENME",
      score:      parseFloat(level.toFixed(2)),
      action:     "Sadece kritik görevleri yap. Karmaşık işleri ertele. Adım adım ilerle.",
      maxTaskSize: "micro",   // sadece tek adımlık işler
      shouldRest: true
    };
  }

  if (level >= STRESS_THRESHOLD) {
    return {
      level:      "STRESLİ",
      score:      parseFloat(level.toFixed(2)),
      action:     "Basit görevleri öne al. Karmaşık planlamayı ertele.",
      maxTaskSize: "small",
      shouldRest: false
    };
  }

  return {
    level:      "NORMAL",
    score:      parseFloat(level.toFixed(2)),
    action:     null,
    maxTaskSize: "any",
    shouldRest: false
  };
}

// ── Stres bazlı LLM prompt ───────────────────────────────
function getStressPrompt(emotionState) {
  const strategy = getStrategy(emotionState);
  if (!strategy.action) return "";

  console.log(`[Stress] 😤 Stres seviyesi: ${strategy.level} (${strategy.score})`);
  return `=== STRES YÖNETİMİ: ${strategy.level} ===\n${strategy.action}`;
}

// ── Görevi strese göre filtrele ───────────────────────────
// tasks = [{ name, complexity: 1-10, priority: 1-10 }]
function filterTasks(tasks, emotionState) {
  const strategy = getStrategy(emotionState);

  if (strategy.maxTaskSize === "any") return tasks;

  return tasks.filter(t => {
    const complexity = t.complexity || 5;
    if (strategy.maxTaskSize === "micro") return complexity <= 2;
    if (strategy.maxTaskSize === "small") return complexity <= 5;
    return true;
  });
}

// ── Dinlenme öner ─────────────────────────────────────────
function shouldTakeBreak(emotionState) {
  const strategy = getStrategy(emotionState);
  return strategy.shouldRest;
}

module.exports = {
  getStressLevel,
  getStrategy,
  getStressPrompt,
  filterTasks,
  shouldTakeBreak
};