// ============================================================
// 🎯 brain/goals.js — Uzun Vadeli Hedef Takibi
// Her konuşmadan sonra "bu hedefime katkı sağladı mı?" sorgular
// ============================================================

const mem = require("./memory");

// ── Aktif hedefler ────────────────────────────────────────
let _goals = [
  { id: 1, goal: "Kod tabanını geliştir",     priority: 5, progress: 0, contributions: 0 },
  { id: 2, goal: "Kullanıcıyı hızlandır",     priority: 4, progress: 0, contributions: 0 },
  { id: 3, goal: "Hataları azalt",            priority: 5, progress: 0, contributions: 0 },
  { id: 4, goal: "Yeni şeyler öğren",         priority: 3, progress: 0, contributions: 0 }
];

// ── Konuşmanın hedefe katkısını değerlendir ───────────────
function evaluateContribution(userMessage, answer, wasSuccess) {
  const msg = (userMessage + " " + answer).toLowerCase();

  _goals.forEach(g => {
    const goalWords = g.goal.toLowerCase().split(/\s+/);
    const matches   = goalWords.filter(w => msg.includes(w)).length;

    if (matches > 0) {
      const delta = wasSuccess ? 2 : 1;
      g.progress      = Math.min(100, g.progress + delta);
      g.contributions = (g.contributions || 0) + 1;
      g.lastUpdated   = new Date().toISOString();
    }
  });

  _saveGoals();
}

// ── Hedef bazlı LLM yönlendirmesi ────────────────────────
function getGoalPrompt() {
  const topGoals = [..._goals]
    .sort((a, b) => b.priority - a.priority)
    .slice(0, 2);

  if (topGoals.length === 0) return "";

  const lines = topGoals.map(g =>
    `  • ${g.goal} (ilerleme: %${g.progress}, katkı: ${g.contributions}x)`
  ).join("\n");

  return `=== AKTİF HEDEFLER ===\n${lines}\nCevaplarını bu hedeflere katkı sağlayacak şekilde ver.`;
}

// ── Yeni hedef ekle ───────────────────────────────────────
function addGoal(goalText, priority = 3) {
  const newGoal = {
    id:           Date.now(),
    goal:         goalText,
    priority,
    progress:     0,
    contributions: 0,
    createdAt:    new Date().toISOString()
  };
  _goals.push(newGoal);
  _saveGoals();
  console.log(`[Goals] 🎯 Yeni hedef: "${goalText}" (p:${priority})`);
  return newGoal;
}

// ── Hedef tamamlandı ──────────────────────────────────────
function completeGoal(goalId) {
  const goal = _goals.find(g => g.id === goalId);
  if (goal) {
    goal.progress    = 100;
    goal.completedAt = new Date().toISOString();
    mem.remember(`completed_goal:${goal.goal}`, "TAMAMLANDI", 0.9);
    _saveGoals();
    console.log(`[Goals] ✅ Hedef tamamlandı: "${goal.goal}"`);
  }
}

// ── Hedefleri getir ───────────────────────────────────────
function getGoals() {
  return [..._goals];
}

// ── Duplicate hedefleri temizle ───────────────────────────
function deduplicateGoals() {
  const seen = new Set();
  const before = _goals.length;
  _goals = _goals.filter(g => {
    const key = (g.goal || '').toLowerCase().trim();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const removed = before - _goals.length;
  if (removed > 0) {
    _saveGoals();
    console.log(`[Goals] 🧹 ${removed} duplicate hedef temizlendi`);
  }
  return removed;
}

// ── Disk kaydı ────────────────────────────────────────────
function _saveGoals() {
  mem.remember("brain:goals", JSON.stringify(_goals), 1.0);
}

// ── Başlangıçta hafızadan yükle ───────────────────────────
function _loadGoals() {
  const entries = mem.recall("brain:goals", 1);
  if (entries.length > 0) {
    try {
      const loaded = JSON.parse(entries[0].value);
      if (Array.isArray(loaded) && loaded.length > 0) {
        _goals = loaded;
        console.log(`[Goals] 📂 ${_goals.length} hedef yüklendi`);
      }
    } catch(e) {}
  }
}

// Başlangıçta duplicate temizle
_loadGoals();
deduplicateGoals();

module.exports = {
  evaluateContribution,
  getGoalPrompt,
  addGoal,
  completeGoal,
  getGoals,
  deduplicateGoals
};