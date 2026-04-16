// ============================================================
// 🔮 brain/intuition.js — Sezgi & Tahmin Sistemi
// Daha önce görülmemiş durumlarda pattern'lardan tahmin üretir
// ============================================================

const mem = require("./memory");

// ── Benzer pattern'lardan tahmin üret ────────────────────
function predict(input) {
  const all      = mem.getAll();
  const inputLow = input.toLowerCase();

  // Başarılı pattern'larla eşleştir
  const matches = all.successPatterns
    .map(p => {
      const similarity = _similarity(inputLow, p.command.toLowerCase());
      return { pattern: p, similarity };
    })
    .filter(x => x.similarity > 0.3)
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, 3);

  if (matches.length === 0) return null;

  const best       = matches[0];
  const confidence = Math.min(0.95, best.similarity * (1 + Math.log1p(best.pattern.count) * 0.1));

  const prediction = {
    input,
    predictedTool:   best.pattern.tool,
    predictedResult: best.pattern.result,
    confidence:      parseFloat(confidence.toFixed(2)),
    basedOn:         matches.length,
    reasoning:       `${matches.length} benzer başarılı pattern'a dayanarak %${(confidence * 100).toFixed(0)} ihtimalle "${best.pattern.tool}" işe yarar.`
  };

  mem.remember(
    `intuition:${input.substring(0, 40)}`,
    prediction.reasoning,
    0.5
  );

  console.log(`[Intuition] 🔮 Tahmin: ${prediction.reasoning}`);
  return prediction;
}

// ── İki string arasında benzerlik skoru (0-1) ─────────────
function _similarity(a, b) {
  const wordsA = new Set(a.split(/\s+/).filter(w => w.length > 2));
  const wordsB = new Set(b.split(/\s+/).filter(w => w.length > 2));
  if (wordsA.size === 0 || wordsB.size === 0) return 0;

  let common = 0;
  wordsA.forEach(w => { if (wordsB.has(w)) common++; });

  return common / Math.max(wordsA.size, wordsB.size);
}

// ── Tahmin doğru muydu? Geri bildirim ver ────────────────
function feedback(input, wasCorrect) {
  const key     = `intuition:${input.substring(0, 40)}`;
  const entries = mem.recall(key, 1);
  if (entries.length > 0) {
    entries[0].importance = wasCorrect
      ? Math.min(1.0, entries[0].importance + 0.1)
      : Math.max(0.1, entries[0].importance - 0.1);
    console.log(`[Intuition] ${wasCorrect ? "✅" : "❌"} Geri bildirim alındı: ${input.substring(0, 40)}`);
  }
}

// ── Genel tahmin özeti ────────────────────────────────────
function getSummary() {
  const all         = mem.getAll();
  const totalPatt   = all.successPatterns.length;
  const avgCount    = totalPatt > 0
    ? (all.successPatterns.reduce((s, p) => s + p.count, 0) / totalPatt).toFixed(1)
    : 0;
  return `${totalPatt} pattern, ortalama ${avgCount}x tekrar`;
}

module.exports = { predict, feedback, getSummary };