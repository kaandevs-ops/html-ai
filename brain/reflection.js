// ============================================================
// 🪞 brain/reflection.js — Yansıtma, Merak, Uyku, Bağlam, Öncelik
// ============================================================
const dream = require("./dream");
const mem = require("./memory");

// ── Aktif bağlam (konuşmalar arası) ──────────────────────
const _context = {
  topics:       [],   // son konuşulan konular
  entities:     {},   // geçen isimler, yerler, kavramlar
  lastQuestion: null,
  lastAnswer:   null,
  turnCount:    0
};

// ── Bağlam güncelle ───────────────────────────────────────
function updateContext(userMessage, answer) {
  _context.lastQuestion = userMessage;
  _context.lastAnswer   = answer;
  _context.turnCount++;

  // Basit konu çıkarımı — ilk 3 kelime
  const topic = userMessage.trim().split(/\s+/).slice(0, 3).join(" ").toLowerCase();
  if (topic && !_context.topics.includes(topic)) {
    _context.topics.unshift(topic);
    if (_context.topics.length > 10) _context.topics.pop();
  }

  // Büyük harfle başlayan kelimeleri entity olarak say
  const entities = userMessage.match(/\b[A-ZÇĞİÖŞÜ][a-züçğışöı]+/g) || [];
  entities.forEach(e => {
    _context.entities[e] = (_context.entities[e] || 0) + 1;
  });
}

// ── Bağlam özeti (LLM prompt'una eklenecek) ───────────────
function getContextPrompt() {
  if (_context.turnCount === 0) return "";

  const recentTopics = _context.topics.slice(0, 3).join(", ");
  const topEntities  = Object.entries(_context.entities)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([k]) => k)
    .join(", ");

  let prompt = `=== KONUŞMA BAĞLAMI ===\n`;
  if (recentTopics)  prompt += `Son konular: ${recentTopics}\n`;
  if (topEntities)   prompt += `Geçen kavramlar: ${topEntities}\n`;
  if (_context.lastQuestion) {
    prompt += `Önceki soru: "${_context.lastQuestion.substring(0, 60)}"\n`;
  }
  prompt += `Konuşma turu: ${_context.turnCount}\n`;
  return prompt;
}

// ── Yansıtma — neden hata yaptım? ────────────────────────
function reflect(failurePatterns) {
  if (!failurePatterns || failurePatterns.length === 0) return null;

  // En çok tekrar eden hataları bul
  const sorted = [...failurePatterns]
    .sort((a, b) => b.count - a.count)
    .slice(0, 3);

  const insights = sorted.map(f => {
    let insight = "";
    const err   = f.error.toLowerCase();

    if (err.includes("enoent") || err.includes("no such file")) {
      insight = `"${f.tool}" aracında dosya yolu hatası yapıyorum. Önce dosyanın var olup olmadığını kontrol etmeliyim.`;
    } else if (err.includes("permission") || err.includes("eacces")) {
      insight = `"${f.tool}" aracında izin hatası yapıyorum. sudo veya farklı yol denemem gerekiyor.`;
    } else if (err.includes("timeout") || err.includes("econnrefused")) {
      insight = `"${f.tool}" aracında bağlantı hatası yapıyorum. Servisin açık olup olmadığını kontrol etmeliyim.`;
    } else if (f.count >= 3) {
      insight = `"${f.tool}" aracında aynı hatayı ${f.count} kez yaptım. Bu yaklaşımı tamamen değiştirmeliyim.`;
    } else {
      insight = `"${f.tool}" aracında hata: ${f.error.substring(0, 60)}`;
    }
    return insight;
  });

  // Hafızaya yaz
  insights.forEach((insight, i) => {
    mem.remember(`reflection:${Date.now()}_${i}`, insight, 0.85);
  });

  console.log(`[Reflection] 🪞 ${insights.length} içgörü üretildi`);
  return insights;
}

// ── Merak — kendi kendine soru üret ──────────────────────
function generateCuriosity(successPatterns, semanticMemory) {
  const questions = [];

  // Başarılı pattern'lardan soru üret
  if (successPatterns.length > 0) {
    const last = successPatterns[successPatterns.length - 1];
    questions.push(`"${last.tool}" aracını daha verimli nasıl kullanabilirim?`);
  }

  // Hafızadaki önemli konulardan soru üret
  const topMemories = semanticMemory
    .sort((a, b) => b.importance - a.importance)
    .slice(0, 3);

  topMemories.forEach(m => {
    if (String(m.value) === "SUCCESS") {
      questions.push(`"${m.key}" görevini daha hızlı yapmanın yolu var mı?`);
    }
  });

  if (questions.length > 0) {
    questions.forEach((q, i) => {
      mem.remember(`curiosity:${Date.now()}_${i}`, q, 0.6);
    });
    console.log(`[Reflection] 🤔 ${questions.length} merak sorusu üretildi`);
  }

  return questions;
}

// ── Uyku konsolidasyonu — hafızayı pekiştir ───────────────
function sleep() {
  const all = mem.getAll();
  let consolidated = 0;

  // Çok erişilen hafızaların önemini artır
  all.semanticMemory.forEach(entry => {
    if (entry.accessCount >= 3) {
      entry.importance = Math.min(1.0, entry.importance + 0.1);
      consolidated++;
    }
    // Hiç erişilmemiş ve düşük öncelikli olanları zayıflat
    if (entry.accessCount === 0 && entry.importance < 0.3) {
      entry.importance = Math.max(0.05, entry.importance - 0.05);
    }
  });

  // Tekrar eden başarı pattern'larının önemini artır
  all.successPatterns.forEach(p => {
    if (p.count >= 2) {
      mem.remember(
        `consolidated:${p.tool}:${p.command.substring(0, 30)}`,
        `${p.count} kez başarılı: ${p.result.substring(0, 60)}`,
        0.75
      );
      consolidated++;
    }
  });

  // Yansıtma yap
  const insights = reflect(all.failurePatterns);
  dream.dream();

  // Merak soruları üret
  const curiosities = generateCuriosity(all.successPatterns, all.semanticMemory);

  console.log(`[Reflection] 😴 Uyku konsolidasyonu: ${consolidated} hafıza pekiştirildi`);

  return { consolidated, insights, curiosities };
}

// ── Önceliklendirme — hangi bilgi önemli? ─────────────────
function prioritize(items, scoreFunc) {
  return [...items]
    .map(item => ({ item, score: scoreFunc(item) }))
    .sort((a, b) => b.score - a.score)
    .map(x => x.item);
}

// Hafızadaki en önemli 5 şeyi döndür
function getTopPriorities() {
  const all = mem.getAll();
  return prioritize(
    all.semanticMemory,
    entry => entry.importance * Math.log1p(entry.accessCount + 1)
  ).slice(0, 5);
}

// ── Bağlamı sıfırla (yeni konuşma başladığında) ───────────
function resetContext() {
  _context.topics       = [];
  _context.entities     = {};
  _context.lastQuestion = null;
  _context.lastAnswer   = null;
  _context.turnCount    = 0;
}

function getContext() { return { ..._context }; }

// ── Gece yarısı uyku konsolidasyonu (her gece 03:00) ──────
function _scheduleNightSleep() {
  const now    = new Date();
  const night  = new Date();
  night.setHours(3, 0, 0, 0);
  if (night <= now) night.setDate(night.getDate() + 1);
  const msUntil = night - now;

  setTimeout(() => {
    console.log("[Reflection] 🌙 Gece konsolidasyonu başlıyor...");
    sleep();
    setInterval(() => sleep(), 24 * 60 * 60 * 1000); // her 24 saatte bir
  }, msUntil);

  console.log(`[Reflection] 🌙 Gece konsolidasyonu planlandı (${Math.round(msUntil / 1000 / 60)} dakika sonra)`);
}

_scheduleNightSleep();

module.exports = {
  updateContext,
  getContextPrompt,
  reflect,
  generateCuriosity,
  sleep,
  getTopPriorities,
  resetContext,
  getContext
};