// ============================================================
// 🔗 brain/association.js — Çağrışım & Zincirleme Bağlantı
// "elma" → "meyve, kırmızı, ağaç" gibi bağlantılar kurar
// ============================================================

const mem = require("./memory");

// ── Çağrışım haritası (RAM) ───────────────────────────────
let _map = {};  // { "elma": ["meyve", "kırmızı", "ağaç"], ... }

// ── İki kavramı ilişkilendir ──────────────────────────────
function associate(conceptA, conceptB, strength = 0.5) {
  const a = conceptA.toLowerCase().trim();
  const b = conceptB.toLowerCase().trim();
  if (!a || !b || a === b) return;

  if (!_map[a]) _map[a] = [];
  if (!_map[b]) _map[b] = [];

  // Zaten var mı?
  const existingA = _map[a].find(x => x.concept === b);
  if (existingA) {
    existingA.strength = Math.min(1.0, existingA.strength + 0.05);
  } else {
    _map[a].push({ concept: b, strength });
  }

  // Çift yönlü
  const existingB = _map[b].find(x => x.concept === a);
  if (existingB) {
    existingB.strength = Math.min(1.0, existingB.strength + 0.05);
  } else {
    _map[b].push({ concept: a, strength });
  }

  _save();
}

// ── Bir kavramın çağrışımlarını getir ─────────────────────
function recall(concept, depth = 1, topN = 5) {
  const key     = concept.toLowerCase().trim();
  const results = new Map();

  function _traverse(c, currentDepth, decayedStrength) {
    if (currentDepth > depth) return;
    const links = _map[c] || [];
    links
      .sort((a, b) => b.strength - a.strength)
      .slice(0, topN)
      .forEach(link => {
        if (!results.has(link.concept)) {
          results.set(link.concept, decayedStrength * link.strength);
          _traverse(link.concept, currentDepth + 1, decayedStrength * 0.7);
        }
      });
  }

  _traverse(key, 1, 1.0);

  return [...results.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)
    .map(([concept, score]) => ({ concept, score: parseFloat(score.toFixed(2)) }));
}

// ── Metinden otomatik çağrışım çıkar ─────────────────────
function extractAndAssociate(text) {
  const words = text
    .toLowerCase()
    .replace(/[^a-züçğışöı\s]/g, "")
    .split(/\s+/)
    .filter(w => w.length > 3);

  // Yan yana gelen kelimeleri ilişkilendir
  for (let i = 0; i < words.length - 1; i++) {
    associate(words[i], words[i + 1], 0.3);
  }

  // 2 uzaktaki kelimeleri de ilişkilendir (zayıf)
  for (let i = 0; i < words.length - 2; i++) {
    associate(words[i], words[i + 2], 0.15);
  }
}

// ── LLM prompt için çağrışım bağlamı ─────────────────────
function getAssociationPrompt(userMessage) {
  const words = userMessage
    .toLowerCase()
    .split(/\s+/)
    .filter(w => w.length > 3)
    .slice(0, 3);

  const associations = [];
  words.forEach(w => {
    const linked = recall(w, 1, 3);
    if (linked.length > 0) {
      associations.push(`"${w}" → ${linked.map(l => l.concept).join(", ")}`);
    }
  });

  if (associations.length === 0) return "";
  return `=== ÇAĞRIŞIMLAR ===\n${associations.join("\n")}`;
}

// ── Disk kayıt / yükleme ──────────────────────────────────
function _save() {
  mem.remember("brain:associations", JSON.stringify(_map), 1.0);
}

function _load() {
  const entries = mem.recall("brain:associations", 1);
  if (entries.length > 0) {
    try {
      const loaded = JSON.parse(entries[0].value);
      if (loaded && typeof loaded === "object") {
        _map = loaded;
        const count = Object.keys(_map).length;
        if (count > 0) console.log(`[Association] 🔗 ${count} çağrışım yüklendi`);
      }
    } catch(e) {}
  }
}

_load();

module.exports = {
  associate,
  recall,
  extractAndAssociate,
  getAssociationPrompt
};