// ============================================================
// 🧠 brain/memory.js — Kalıcı Bellek Sistemi v2
// DÜZELTİLEN HATALAR:
//   - totalTasks hem başarı hem hatada artıyor (önceden sadece başarıda artıyordu)
//   - recall() artık tam kelime + kısmi eşleşme skoru hesaplıyor
//   - getContextSummary() daha zengin bilgi dönüyor
//   - commandCache TTL (24 saat) eklendi
//   - Bellek önemi zaman bazlı decay ile güncelleniyor
// ============================================================

const fs   = require("fs");
const path = require("path");

const MEMORY_FILE  = path.join(__dirname, "..", "agent_memory.json");
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 saat

// ── Varsayılan şablon ──────────────────────────────────────
const DEFAULT_MEMORY = {
  semanticMemory:   [],
  failurePatterns:  [],
  successPatterns:  [],
  longTermGoals: [
    { goal: "Kod tabanımı geliştirmek", priority: 5, progress: 0 },
    { goal: "Kullanıcıyı hızlandırmak",  priority: 4, progress: 0 }
  ],
  userPreferences: {},
  commandCache:    {},
  stats: {
    totalTasks:   0,
    successCount: 0,
    failCount:    0,
    lastActive:   null,
    sessionCount: 0
  }
};

// ── Disk I/O ───────────────────────────────────────────────
function loadMemory() {
  try {
    if (fs.existsSync(MEMORY_FILE)) {
      const raw = fs.readFileSync(MEMORY_FILE, "utf-8");
      const parsed = JSON.parse(raw);
      // Deep merge: yeni alanlar eksikse DEFAULT'tan al
      return {
        ...DEFAULT_MEMORY,
        ...parsed,
        stats: { ...DEFAULT_MEMORY.stats, ...parsed.stats }
      };
    }
  } catch (e) {
    console.warn("[Memory] ⚠️ Bellek yüklenemedi, sıfırlandı:", e.message);
  }
  return JSON.parse(JSON.stringify(DEFAULT_MEMORY));
}

let _saveTimer = null;
function saveMemory(mem) {
  try {
    fs.writeFileSync(MEMORY_FILE, JSON.stringify(mem, null, 2), "utf-8");
  } catch (e) {
    console.error("[Memory] ❌ Kaydetme hatası:", e.message);
  }
}

let _mem = loadMemory();
_mem.stats.sessionCount = (_mem.stats.sessionCount || 0) + 1;
saveMemory(_mem);

// ── Semantik bellek: ekle ─────────────────────────────────
function remember(key, value, importance = 0.5) {
  // Aynı key varsa güncelle
  const existing = _mem.semanticMemory.find(e => e.key === key);
  if (existing) {
    existing.value       = value;
    existing.importance  = Math.min(1.0, existing.importance + 0.05);
    existing.updatedAt   = new Date().toISOString();
    existing.accessCount = (existing.accessCount || 0) + 1;
    saveMemory(_mem);
    return existing;
  }

  const entry = {
    id:          Date.now(),
    key,
    value,
    importance,
    createdAt:   new Date().toISOString(),
    updatedAt:   new Date().toISOString(),
    accessCount: 0
  };
  _mem.semanticMemory.push(entry);

  // Max 500 — önem + yaş skoru ile prune
  if (_mem.semanticMemory.length > 500) {
    _mem.semanticMemory.sort((a, b) => _score(b) - _score(a));
    _mem.semanticMemory = _mem.semanticMemory.slice(0, 400);
  }

  saveMemory(_mem);
  return entry;
}

// Erişim sıklığı + önem + tazelik skoru
function _score(entry) {
  const ageMs    = Date.now() - new Date(entry.createdAt).getTime();
  const ageDays  = ageMs / (1000 * 60 * 60 * 24);
  const decayed  = entry.importance * Math.exp(-0.05 * ageDays);
  const access   = Math.log1p(entry.accessCount || 0) * 0.1;
  return decayed + access;
}

// ── Semantik bellek: ara ──────────────────────────────────
function recall(query, topN = 5) {
  if (!query) return [];
  const words = query.toLowerCase().split(/\s+/).filter(w => w.length > 2);

  const scored = _mem.semanticMemory
    .map(e => {
      const haystack = `${String(e.key)} ${String(e.value)}`.toLowerCase();
      let score      = 0;
      words.forEach(w => {
        if (haystack.includes(w)) score += 1;
      });
      // Tam cümle eşleşmesi bonus
      if (haystack.includes(query.toLowerCase())) score += 2;
      return { entry: e, score };
    })
    .filter(x => x.score > 0)
    .sort((a, b) => (b.score * _score(b.entry)) - (a.score * _score(a.entry)))
    .slice(0, topN)
    .map(x => x.entry);

  // Erişim kaydı
  scored.forEach(e => {
    e.accessCount = (e.accessCount || 0) + 1;
    e.importance  = Math.min(1.0, e.importance + 0.01);
  });
  if (scored.length) saveMemory(_mem);
  return scored;
}

// ── Başarısızlık kaydet ────────────────────────────────────
function recordFailure(tool, command, errorMsg) {
  const entry = {
    id:       Date.now(),
    tool,
    command:  String(command  || "").substring(0, 200),
    error:    String(errorMsg || "").substring(0, 300),
    count:    1,
    lastSeen: new Date().toISOString()
  };

  const existing = _mem.failurePatterns.find(
    f => f.tool === tool && f.error === entry.error
  );
  if (existing) {
    existing.count++;
    existing.lastSeen = entry.lastSeen;
  } else {
    _mem.failurePatterns.push(entry);
    if (_mem.failurePatterns.length > 200) {
      _mem.failurePatterns = _mem.failurePatterns.slice(-150);
    }
  }

  // ✅ DÜZELTİLDİ: totalTasks BURADA DA artıyor
  _mem.stats.failCount++;
  _mem.stats.totalTasks++;
  _mem.stats.lastActive = new Date().toISOString();
  saveMemory(_mem);
}

// ── Başarı kaydet ──────────────────────────────────────────
function recordSuccess(tool, command, result) {
  const entry = {
    id:       Date.now(),
    tool,
    command:  String(command || "").substring(0, 200),
    result:   String(result  || "").substring(0, 300),
    count:    1,
    lastSeen: new Date().toISOString()
  };

  const existing = _mem.successPatterns.find(
    s => s.tool === tool && s.command === entry.command
  );
  if (existing) {
    existing.count++;
    existing.lastSeen = entry.lastSeen;
    existing.result   = entry.result; // son sonucu güncelle
  } else {
    _mem.successPatterns.push(entry);
    if (_mem.successPatterns.length > 200) {
      _mem.successPatterns = _mem.successPatterns.slice(-150);
    }
  }

  _mem.stats.successCount++;
  _mem.stats.totalTasks++;
  _mem.stats.lastActive = new Date().toISOString();
  saveMemory(_mem);
}

// ── Komut cache ────────────────────────────────────────────
function cacheCommand(inputText, response) {
  const key = _cacheKey(inputText);
  _mem.commandCache[key] = {
    response,
    cachedAt:  new Date().toISOString(),
    expiresAt: new Date(Date.now() + CACHE_TTL_MS).toISOString(),
    hitCount:  0
  };
  // Max 300 cache girişi
  const keys = Object.keys(_mem.commandCache);
  if (keys.length > 300) {
    // En eski, en az kullanılanı sil
    keys
      .sort((a, b) => (_mem.commandCache[a].hitCount || 0) - (_mem.commandCache[b].hitCount || 0))
      .slice(0, 50)
      .forEach(k => delete _mem.commandCache[k]);
  }
  saveMemory(_mem);
}

function getCachedCommand(inputText) {
  const key    = _cacheKey(inputText);
  const cached = _mem.commandCache[key];
  if (!cached) return null;

  // TTL kontrolü
  if (cached.expiresAt && new Date() > new Date(cached.expiresAt)) {
    delete _mem.commandCache[key];
    saveMemory(_mem);
    return null;
  }

  cached.hitCount++;
  saveMemory(_mem);
  return cached.response;
}

function _cacheKey(text) {
  return text.trim().toLowerCase().substring(0, 120);
}

// ── LLM bağlam özeti ──────────────────────────────────────
function getContextSummary() {
  const s    = _mem.stats;
  const rate = s.totalTasks > 0 ? ((s.successCount / s.totalTasks) * 100).toFixed(0) : "0";

  const recentFailures = _mem.failurePatterns
    .slice(-5)
    .map(f => `  • [${f.tool}] "${f.error.substring(0, 80)}" — ${f.count}x tekrar`)
    .join("\n");

  const recentSuccesses = _mem.successPatterns
    .slice(-5)
    .map(s => `  • [${s.tool}] "${s.command.substring(0, 80)}" — ${s.count}x başarılı`)
    .join("\n");

  const topMemories = _mem.semanticMemory
    .sort((a, b) => _score(b) - _score(a))
    .slice(0, 5)
    .map(m => `  • ${m.key}: ${String(m.value).substring(0, 100)}`)
    .join("\n");

  return `=== HAFIZA ÖZETİ ===
Toplam görev: ${s.totalTasks} | Başarı: ${s.successCount} | Hata: ${s.failCount} | Oran: %${rate}
Oturum: #${s.sessionCount} | Son aktif: ${s.lastActive ? s.lastActive.substring(0, 16) : "—"}

Son başarısızlıklar:
${recentFailures || "  (yok)"}

Son başarılar:
${recentSuccesses || "  (yok)"}

Önemli bilgiler:
${topMemories || "  (yok)"}`.trim();
}

function getAll()      { return _mem; }
function resetMemory() { _mem = JSON.parse(JSON.stringify(DEFAULT_MEMORY)); saveMemory(_mem); }
process.on("SIGINT",  () => { fs.writeFileSync(MEMORY_FILE, JSON.stringify(_mem, null, 2)); process.exit(); });
process.on("SIGTERM", () => { fs.writeFileSync(MEMORY_FILE, JSON.stringify(_mem, null, 2)); process.exit(); });
module.exports = {
  remember,
  recall,
  recordFailure,
  recordSuccess,
  cacheCommand,
  getCachedCommand,
  getContextSummary,
  getAll,
  resetMemory
};