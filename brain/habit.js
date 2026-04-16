// ============================================================
// 🔄 brain/habit.js — Alışkanlık Döngüsü
// Tetikleyici → Rutin → Ödül mantığıyla çalışır
// Sık tekrar eden davranışları otomatikleştirir
// ============================================================

const mem = require("./memory");

// ── Alışkanlık listesi ────────────────────────────────────
let _habits = [];

// ── Yeni alışkanlık oluştur ───────────────────────────────
function createHabit(trigger, routine, reward = "tamamlandı") {
  const existing = _habits.find(h =>
    h.trigger.toLowerCase() === trigger.toLowerCase()
  );
  if (existing) {
    existing.count++;
    existing.lastSeen = new Date().toISOString();
    _save();
    return existing;
  }

  const habit = {
    id:        Date.now(),
    trigger:   trigger.toLowerCase().trim(),
    routine,
    reward,
    count:     1,
    strength:  0.1,   // 0–1: alışkanlık gücü
    createdAt: new Date().toISOString(),
    lastSeen:  new Date().toISOString()
  };

  _habits.push(habit);
  _save();
  console.log(`[Habit] 🔄 Yeni alışkanlık: "${trigger}" → "${routine}"`);
  return habit;
}

// ── Tetikleyiciyi kontrol et ──────────────────────────────
function checkTrigger(input) {
  const inputLow = input.toLowerCase();
  const matched  = _habits
    .filter(h => inputLow.includes(h.trigger))
    .sort((a, b) => b.strength - a.strength);

  if (matched.length === 0) return null;

  const habit = matched[0];
  habit.count++;
  habit.strength  = Math.min(1.0, habit.strength + 0.05);
  habit.lastSeen  = new Date().toISOString();
  _save();

  console.log(`[Habit] ⚡ Tetiklendi: "${habit.trigger}" (güç: ${habit.strength.toFixed(2)})`);
  return habit;
}

// ── Alışkanlığı pekiştir (ödül alındı) ───────────────────
function reinforce(triggerId) {
  const habit = _habits.find(h => h.id === triggerId);
  if (habit) {
    habit.strength = Math.min(1.0, habit.strength + 0.1);
    _save();
  }
}

// ── Alışkanlığı zayıflat (kullanılmadı) ──────────────────
function decay() {
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000; // 7 gün
  _habits.forEach(h => {
    if (new Date(h.lastSeen).getTime() < cutoff) {
      h.strength = Math.max(0.0, h.strength - 0.05);
    }
  });
  // Çok zayıf alışkanlıkları sil
  _habits = _habits.filter(h => h.strength > 0.05);
  _save();
}

// ── Güçlü alışkanlıkları LLM prompt'una ekle ─────────────
function getHabitPrompt() {
  const strong = _habits
    .filter(h => h.strength >= 0.5)
    .sort((a, b) => b.strength - a.strength)
    .slice(0, 3);

  if (strong.length === 0) return "";

  const lines = strong.map(h =>
    `  • "${h.trigger}" gelince → ${h.routine} (${h.count}x)`
  ).join("\n");

  return `=== ALIŞKANLİKLAR ===\n${lines}`;
}

function getHabits() { return [..._habits]; }

// ── Disk ──────────────────────────────────────────────────
function _save() {
  mem.remember("brain:habits", JSON.stringify(_habits), 1.0);
}

function _load() {
  const entries = mem.recall("brain:habits", 1);
  if (entries.length > 0) {
    try {
      const loaded = JSON.parse(entries[0].value);
      if (Array.isArray(loaded)) {
        _habits = loaded;
        console.log(`[Habit] 🔄 ${_habits.length} alışkanlık yüklendi`);
      }
    } catch(e) {}
  }
}

// Haftalık decay
setInterval(decay, 7 * 24 * 60 * 60 * 1000);

_load();

module.exports = {
  createHabit,
  checkTrigger,
  reinforce,
  decay,
  getHabitPrompt,
  getHabits
};