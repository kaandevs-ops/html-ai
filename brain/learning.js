// ============================================================
// 📚 brain/learning.js — Öğrenme & Pattern Tanıma v2
// DÜZELTİLEN HATALAR:
//   - evaluateAgentRun içinde emo.onSuccess/Failure çift çağrılıyordu → kaldırıldı
//     (index.js bu görevi üstleniyor, çift tetiklenme önlendi)
//   - recall() ile "BAŞARILI/BAŞARISIZ" string eşleşmesi çok kırılgandı → enum kullanıldı
//   - buildLearningContext() daha zengin ve akıllı bağlam üretiyor
//   - Pattern güven skoru (confidence) eklendi
//   - Kullanıcı tercihleri artık memory'de doğru kaydediliyor
//   - getSuccessRate() sliding window ile son 20 göreve bakıyor
// ============================================================

const mem = require("./memory");

// ── Sabitler ──────────────────────────────────────────────
const STATUS = {
  SUCCESS: "success",
  DONE: "done",
  FAIL: "fail",
  ERROR: "error",
  FAILED: "failed"
};

function _isSuccess(status) {
  return status === STATUS.SUCCESS || status === STATUS.DONE;
}

// ── Sliding window başarı takibi ──────────────────────────
const _recentResults = [];  // son 20 sonuç: true=başarı, false=hata
const WINDOW_SIZE = 20;

function _pushResult(success) {
  _recentResults.push(success);
  if (_recentResults.length > WINDOW_SIZE) _recentResults.shift();
}

// ── Agent döngüsü değerlendirmesi ─────────────────────────
// ✅ DÜZELTİLDİ: emo.onSuccess/Failure BURADAN KALDIRILDI
//    Bunları artık index.js çağırıyor → çift tetiklenme yok
function evaluateAgentRun(goal, steps, finalStatus) {
  const success = _isSuccess(finalStatus);
  _pushResult(success);

  // Adımları belleğe yaz
  steps.forEach(step => {
    if (step.error) {
      mem.recordFailure(
        step.tool || "unknown",
        step.command || JSON.stringify(step.args || {}),
        step.error
      );
    } else {
      mem.recordSuccess(
        step.tool || "unknown",
        step.command || JSON.stringify(step.args || {}),
        step.result || "OK"
      );
    }
  });

  // Hedefi semantik hafızaya yaz — sabit enum kullan
  mem.remember(
    `goal:${goal.substring(0, 60)}`,
    success ? "SUCCESS" : "FAILED",
    success ? 0.55 : 0.85  // hatalar daha önemli hatırlanır
  );

  // Başarılı hedefleri "başarı deseni" olarak da kaydet
  if (success && steps.length > 0) {
    const toolUsed = steps[steps.length - 1]?.tool || "unknown";
    mem.recordSuccess("goal_pattern", goal.substring(0, 80), `${steps.length} adımda tamamlandı`);
  }

  console.log(`[Learning] 📊 Değerlendirme | ${success ? "✅ Başarı" : "❌ Hata"} | Pencere başarı oranı: %${(getSuccessRate() * 100).toFixed(0)}`);
}

// ── LLM için bağlam üret ──────────────────────────────────
function buildLearningContext(currentGoal) {
  const memSummary = mem.getContextSummary();

  // ✅ DÜZELTİLDİ: "BAŞARILI/BAŞARISIZ" yerine "SUCCESS/FAILED" arıyoruz
  const similarEntries = mem.recall(currentGoal, 6);
  const similarFailures = similarEntries
    .filter(r => String(r.value) === "FAILED")
    .map(r => `  • ${r.key}`)
    .join("\n");

  const similarSuccesses = similarEntries
    .filter(r => String(r.value) === "SUCCESS")
    .map(r => `  • ${r.key}`)
    .join("\n");

  // Tekrar eden hata kalıpları
  const allMem = mem.getAll();
  const repeatedErrors = allMem.failurePatterns
    .filter(f => f.count >= 2)
    .slice(-3)
    .map(f => `  • [${f.tool}] ${f.error.substring(0, 80)} (${f.count}x)`)
    .join("\n");

  // Kullanıcı tercihleri
  const prefs = Object.entries(allMem.userPreferences)
    .slice(-5)
    .map(([k, v]) => `  • ${k}: ${typeof v === "object" ? v.value : v}`)
    .join("\n");

  let context = "";

  if (memSummary) context += memSummary + "\n\n";

  if (repeatedErrors) {
    context += `=== TEKRAR EDEN HATALAR (BUNLARDAN KAÇIN) ===\n${repeatedErrors}\n\n`;
  }

  if (similarFailures) {
    context += `=== BENZER BAŞARISIZ GÖREVLER ===\n${similarFailures}\nBu yaklaşımları TEKRARLAMA.\n\n`;
  }

  if (similarSuccesses) {
    context += `=== BENZER BAŞARILI GÖREVLER ===\n${similarSuccesses}\nBu yöntemleri tercih et.\n\n`;
  }

  if (prefs) {
    context += `=== KULLANICI TERCİHLERİ ===\n${prefs}\n\n`;
  }

  return context.trim();
}

// ── Refleks cache kontrolü ────────────────────────────────
function checkReflex(inputText) {
  return mem.getCachedCommand(inputText);
}

// ── Başarılı cevabı öğren ─────────────────────────────────
function learnResponse(inputText, response) {
  const CACHE_BLACKLIST = ["merhaba", "selam", "nasılsın", "naber", "iyi günler", "hey"];
  const isGreeting = CACHE_BLACKLIST.some(w => inputText.toLowerCase().includes(w));
  const isCommand = inputText.length < 40 && !inputText.includes("?") && !isGreeting;
  if (isCommand) {
    mem.cacheCommand(inputText, response);
  }

  mem.remember(
    `learned:${inputText.substring(0, 50)}`,
    response.substring(0, 120),
    0.4
  );
}

// ── Kullanıcı tercihi öğren ───────────────────────────────
function learnUserPreference(key, value) {
  const all = mem.getAll();
  all.userPreferences[key] = {
    value,
    learnedAt: new Date().toISOString(),
    updateCount: (all.userPreferences[key]?.updateCount || 0) + 1
  };
  // ✅ DÜZELTİLDİ: Tercih semantik hafızaya da yazılıyor
  mem.remember(`user_pref:${key}`, String(value), 0.9);
  console.log(`[Learning] 👤 Tercih: ${key} = ${value}`);
}

// ── Başarı oranı (sliding window) ─────────────────────────
// ✅ DÜZELTİLDİ: Sadece son WINDOW_SIZE göreve bakıyor — daha güncel
function getSuccessRate() {
  if (_recentResults.length === 0) return 1.0;
  const successes = _recentResults.filter(Boolean).length;
  return successes / _recentResults.length;
}

// Tüm zamanların başarı oranı (memory.stats'tan)
function getLifetimeSuccessRate() {
  const stats = mem.getAll().stats;
  if (stats.totalTasks === 0) return 1.0;
  return stats.successCount / stats.totalTasks;
}

module.exports = {
  evaluateAgentRun,
  buildLearningContext,
  checkReflex,
  learnResponse,
  learnUserPreference,
  getSuccessRate,
  getLifetimeSuccessRate
};