// ============================================================
// 💭 brain/dream.js — Rüya & Senaryo Simülasyonu
// Uyku sırasında "eğer şu olsaydı ne yapardım" senaryoları üretir
// ============================================================

const mem = require("./memory");

const _dreams = [];  // son üretilen rüyalar

// ── Senaryo simüle et ─────────────────────────────────────
function dream() {
  const all      = mem.getAll();
  const failures = all.failurePatterns.slice(-5);
  const successes= all.successPatterns.slice(-5);

  if (failures.length === 0 && successes.length === 0) {
    console.log("[Dream] 💭 Henüz yeterli veri yok, rüya atlandı.");
    return [];
  }

  const scenarios = [];

  // Başarısız senaryoların alternatifini hayal et
  failures.forEach(f => {
    const scenario = {
      type:      "failure_recovery",
      original:  `[${f.tool}] ${f.error.substring(0, 60)}`,
      imagined:  _imagineAlternative(f),
      createdAt: new Date().toISOString()
    };
    scenarios.push(scenario);
    mem.remember(
      `dream:recovery:${f.tool}`,
      scenario.imagined,
      0.65
    );
  });

  // Başarılı senaryoları daha da iyi hayal et
  successes.slice(0, 2).forEach(s => {
    const scenario = {
      type:      "success_enhancement",
      original:  `[${s.tool}] ${s.command.substring(0, 60)}`,
      imagined:  `"${s.tool}" aracını ${s.count} kez başarıyla kullandım. Bunu otomatikleştirirsem daha hızlı olur.`,
      createdAt: new Date().toISOString()
    };
    scenarios.push(scenario);
    mem.remember(
      `dream:enhance:${s.tool}`,
      scenario.imagined,
      0.55
    );
  });

  _dreams.unshift(...scenarios);
  if (_dreams.length > 20) _dreams.length = 20;

  console.log(`[Dream] 💭 ${scenarios.length} senaryo simüle edildi`);
  return scenarios;
}

// ── Başarısız durumun alternatifini üret ──────────────────
function _imagineAlternative(failure) {
  const err  = failure.error.toLowerCase();
  const tool = failure.tool;

  if (err.includes("enoent") || err.includes("no such file")) {
    return `Eğer "${tool}" çalıştırmadan önce dosya varlığını kontrol etseydim bu hata olmazdı. Bir sonraki seferde önce "ls" veya "exist" kontrolü yapacağım.`;
  }
  if (err.includes("permission") || err.includes("eacces")) {
    return `Eğer "${tool}" için izin kontrolü yapsaydım bu hata olmazdı. Bir sonraki seferde önce izinleri kontrol edeceğim.`;
  }
  if (err.includes("timeout") || err.includes("econnrefused")) {
    return `Eğer "${tool}" çağırmadan önce servisin ayakta olup olmadığını kontrol etseydim zaman kaybetmezdim.`;
  }
  if (failure.count >= 3) {
    return `"${tool}" aracında ${failure.count} kez aynı hatayı yaptım. Tamamen farklı bir araç veya yöntem denemem gerekiyor.`;
  }
  return `"${tool}" aracında hata aldım. Bir sonraki seferde önce daha küçük bir test yapacağım.`;
}

// ── Son rüyaları getir ────────────────────────────────────
function getRecentDreams(n = 5) {
  return _dreams.slice(0, n);
}

// ── Rüya özetini LLM prompt'una ekle ─────────────────────
function getDreamPrompt() {
  if (_dreams.length === 0) return "";

  const recent = _dreams.slice(0, 3)
    .map(d => `  • ${d.imagined}`)
    .join("\n");

  return `=== ÇIKARILAN DERSLER ===\n${recent}`;
}

module.exports = { dream, getRecentDreams, getDreamPrompt };