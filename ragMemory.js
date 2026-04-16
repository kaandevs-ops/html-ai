// ============================================================
// 🧠 ragMemory.js — RAG ↔ Otonom Agent Hafıza Köprüsü v1.0
//
// Orijinal hiçbir dosyaya dokunmaz.
// server.js'e sadece şunu ekle (EN SONA):
//   const { mountRagMemory } = require('./ragMemory');
//   mountRagMemory(app, autoAgent, brain, rag, axios);
//
// Sağladığı özellikler:
//   ✅ Her agent adımı sonucu otomatik RAG'a kaydedilir
//   ✅ Yeni görev başlamadan önce RAG'dan ilgili hafıza çekilir
//   ✅ Geçmiş konuşmaları sorgulama endpoint'i
//   ✅ Brain memory ↔ RAG çift yönlü senkronizasyon
// ============================================================

'use strict';

const fs = require('fs');
const path = require('path');

// ── RAG hafıza dosyası (JSON-based lightweight vector store) ──
const RAG_MEM_FILE = './rag_agent_memory.json';

// ── Bellek durumu ─────────────────────────────────────────
const RAG_STATE = {
  entries: [],      // { id, text, embedding, ts, source, goal }
  totalSaved: 0,
  totalQueried: 0,
  enabled: true
};

// ── Basit TF-IDF benzeri benzerlik (vektör DB yoksa) ─────
function _tokenize(text) {
  return (text || '').toLowerCase()
    .replace(/[^a-zA-ZğüşıöçĞÜŞİÖÇ0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 2);
}

function _similarity(text1, text2) {
  const tokens1 = new Set(_tokenize(text1));
  const tokens2 = new Set(_tokenize(text2));
  if (!tokens1.size || !tokens2.size) return 0;
  let common = 0;
  tokens1.forEach(t => { if (tokens2.has(t)) common++; });
  return common / Math.sqrt(tokens1.size * tokens2.size);
}

// ── Hafızayı yükle / kaydet ───────────────────────────────
function _loadMemory() {
  try {
    if (fs.existsSync(RAG_MEM_FILE)) {
      const data = JSON.parse(fs.readFileSync(RAG_MEM_FILE, 'utf8'));
      RAG_STATE.entries = data.entries || [];
      RAG_STATE.totalSaved = data.totalSaved || 0;
      console.log(`[RagMemory] 📂 ${RAG_STATE.entries.length} kayıt yüklendi`);
    }
  } catch (e) {
    console.warn('[RagMemory] ⚠️ Hafıza yüklenemedi:', e.message);
  }
}

function _saveMemory() {
  try {
    fs.writeFileSync(RAG_MEM_FILE, JSON.stringify({
      entries: RAG_STATE.entries.slice(-500), // Max 500 kayıt
      totalSaved: RAG_STATE.totalSaved,
      updatedAt: new Date().toISOString()
    }, null, 2));
  } catch (e) {
    console.warn('[RagMemory] ⚠️ Kayıt hatası:', e.message);
  }
}

// ── Hafızaya ekle ─────────────────────────────────────────
function remember(text, metadata = {}) {
  if (!RAG_STATE.enabled || !text || text.length < 10) return null;

  const entry = {
    id: Date.now() + '_' + Math.random().toString(36).slice(2, 5),
    text: text.slice(0, 1000),
    ts: Date.now(),
    source: metadata.source || 'agent',
    goal: (metadata.goal || '').slice(0, 100),
    tool: metadata.tool || '',
    success: metadata.success !== false
  };

  RAG_STATE.entries.push(entry);
  RAG_STATE.totalSaved++;

  // Her 10 kayıtta bir diske yaz
  if (RAG_STATE.totalSaved % 10 === 0) {
    _saveMemory();
  }

  return entry.id;
}

// ── Hafızadan sorgula ─────────────────────────────────────
function recall(query, topN = 5, options = {}) {
  if (!query || !RAG_STATE.entries.length) return [];

  const { onlySuccess = false, minSimilarity = 0.1 } = options;

  let candidates = RAG_STATE.entries;
  if (onlySuccess) candidates = candidates.filter(e => e.success);

  const scored = candidates.map(entry => ({
    ...entry,
    score: _similarity(query, entry.text + ' ' + entry.goal)
  }));

  RAG_STATE.totalQueried++;

  return scored
    .filter(e => e.score >= minSimilarity)
    .sort((a, b) => b.score - a.score)
    .slice(0, topN)
    .map(e => ({
      id: e.id,
      text: e.text,
      score: Math.round(e.score * 100) / 100,
      source: e.source,
      goal: e.goal,
      tool: e.tool,
      success: e.success,
      ts: e.ts,
      age: Math.round((Date.now() - e.ts) / 60000) + ' dk önce'
    }));
}

// ── Hafıza bağlamı oluştur (prompt'a eklenecek) ──────────
function buildMemoryContext(goal, topN = 3) {
  const results = recall(goal, topN, { onlySuccess: true, minSimilarity: 0.15 });
  if (!results.length) return '';

  const lines = results.map(r =>
    `- [${r.age}] ${r.goal || r.source}: ${r.text.slice(0, 150)}`
  ).join('\n');

  return `\n=== İLGİLİ GEÇMİŞ HAFIZA (${results.length} kayıt) ===\n${lines}\n`;
}

// ── autonomous_agent'ı patch et ───────────────────────────
function patchAutoAgent(autoAgent, brain) {
  if (!autoAgent) return;

  // 1. executePlan'dan sonra sonuçları kaydet
  const originalLoop = autoAgent.AUTO_TOOLS;
  if (!originalLoop) return;

  // Her araç çağrısının sonucunu hafızaya al
  Object.keys(originalLoop).forEach(toolName => {
    const original = originalLoop[toolName];
    if (typeof original !== 'function') return;

    originalLoop[toolName] = async function(args) {
      const startTs = Date.now();
      let result, success = true;

      try {
        result = await original.call(originalLoop, args);

        // Başarılı sonucu hafızaya kaydet
        const text = typeof result === 'string'
          ? result.slice(0, 500)
          : JSON.stringify(result).slice(0, 500);

        remember(text, {
          source: 'tool_result',
          goal: autoAgent.AUTO?.currentGoal || '',
          tool: toolName,
          success: true
        });

        return result;
      } catch (err) {
        success = false;
        // Hataları da kaydet — neyin çalışmadığını bilmek önemli
        remember(`HATA [${toolName}]: ${err.message}`, {
          source: 'tool_error',
          goal: autoAgent.AUTO?.currentGoal || '',
          tool: toolName,
          success: false
        });
        throw err;
      }
    };
  });

  // 2. generatePlan'ı RAG bağlamıyla güçlendir
  // autoAgent içindeki generateGoal çağrısından önce hafıza bağlamı enjekte et
  const originalGenerateGoal = autoAgent._generateGoal;
  if (typeof originalGenerateGoal === 'function') {
    autoAgent._generateGoal = async function(ctx) {
      const memCtx = buildMemoryContext(ctx.recentGoals || 'genel', 3);
      if (memCtx) ctx.ragContext = memCtx;
      return originalGenerateGoal.call(autoAgent, ctx);
    };
  }

  console.log('[RagMemory] ✅ autonomous_agent araçları RAG hafızasıyla patch edildi');
}

// ── Brain memory ile senkronize et ───────────────────────
function syncWithBrain(brain) {
  if (!brain || !brain.mem) return;

  // Brain'in recall sonuçlarını RAG'a besle
  const brainRecall = brain.mem.recall;
  if (typeof brainRecall === 'function') {
    const originalRecall = brainRecall.bind(brain.mem);
    brain.mem.recall = function(query, topN) {
      const results = originalRecall(query, topN);
      // Brain sonuçlarını RAG'a da ekle
      results.forEach(r => {
        if (r.value && typeof r.value === 'string') {
          remember(r.key + ': ' + r.value, {
            source: 'brain_memory',
            goal: query
          });
        }
      });
      return results;
    };
    console.log('[RagMemory] 🔗 Brain memory senkronizasyonu aktif');
  }
}

// ══════════════════════════════════════════════════════════
// 🔌 ANA MOUNT
// ══════════════════════════════════════════════════════════
function mountRagMemory(app, autoAgent, brain, ragModule, axios) {
  if (!app) {
    console.warn('[RagMemory] ⚠️ app eksik, mount atlandı.');
    return;
  }

  // Hafızayı yükle
  _loadMemory();

  // Agent ve brain'i patch et
  if (autoAgent) patchAutoAgent(autoAgent, brain);
  if (brain) syncWithBrain(brain);

  // Mevcut RAG modülü ile entegrasyon
  if (ragModule && typeof ragModule.buildRagContext === 'function') {
    const originalBuildRag = ragModule.buildRagContext.bind(ragModule);
    ragModule.buildRagContext = function(query) {
      const originalCtx = originalBuildRag(query);
      const agentMemCtx = buildMemoryContext(query, 3);
      return (originalCtx || '') + agentMemCtx;
    };
    console.log('[RagMemory] 🔗 Mevcut RAG modülü genişletildi');
  }

  // ── API Endpointleri ───────────────────────────────────

  // Hafızayı sorgula
  app.get('/rag-memory/search', (req, res) => {
    const { q = '', n = 5, onlySuccess } = req.query;
    if (!q) return res.json({ status: 'error', message: 'q parametresi gerekli' });
    const results = recall(q, parseInt(n), { onlySuccess: onlySuccess === 'true' });
    res.json({ status: 'success', query: q, count: results.length, results });
  });

  // Hafızaya manuel ekle
  app.post('/rag-memory/add', (req, res) => {
    const { text, source, goal } = req.body;
    if (!text) return res.json({ status: 'error', message: 'text gerekli' });
    const id = remember(text, { source: source || 'manual', goal });
    res.json({ status: 'success', id });
  });

  // Hafıza istatistikleri
  app.get('/rag-memory/stats', (req, res) => {
    const bySource = {};
    RAG_STATE.entries.forEach(e => {
      bySource[e.source] = (bySource[e.source] || 0) + 1;
    });
    res.json({
      status: 'success',
      totalEntries: RAG_STATE.entries.length,
      totalSaved: RAG_STATE.totalSaved,
      totalQueried: RAG_STATE.totalQueried,
      enabled: RAG_STATE.enabled,
      bySource,
      oldestEntry: RAG_STATE.entries[0]
        ? new Date(RAG_STATE.entries[0].ts).toISOString()
        : null,
      newestEntry: RAG_STATE.entries[RAG_STATE.entries.length - 1]
        ? new Date(RAG_STATE.entries[RAG_STATE.entries.length - 1].ts).toISOString()
        : null
    });
  });

  // Hafıza bağlamı önizleme
  app.get('/rag-memory/context', (req, res) => {
    const { goal = '', n = 3 } = req.query;
    const context = buildMemoryContext(goal, parseInt(n));
    res.json({ status: 'success', goal, context, hasContext: context.length > 0 });
  });

  // Hafızayı aç/kapat
  app.post('/rag-memory/toggle', (req, res) => {
    RAG_STATE.enabled = !RAG_STATE.enabled;
    res.json({ status: 'success', enabled: RAG_STATE.enabled });
  });

  // Hafızayı temizle
  app.delete('/rag-memory/clear', (req, res) => {
    RAG_STATE.entries = [];
    RAG_STATE.totalSaved = 0;
    _saveMemory();
    res.json({ status: 'success', message: 'RAG hafızası temizlendi' });
  });

  // Periyodik kayıt (5 dakikada bir)
  setInterval(_saveMemory, 5 * 60 * 1000);

  console.log('[RagMemory] 🔌 Mount tamamlandı.');
  console.log('  GET    /rag-memory/search    → hafıza sorgula ?q=...&n=5');
  console.log('  POST   /rag-memory/add       → manuel kayıt ekle');
  console.log('  GET    /rag-memory/stats     → istatistikler');
  console.log('  GET    /rag-memory/context   → prompt bağlamı önizle');
  console.log('  POST   /rag-memory/toggle    → aç/kapat');
  console.log('  DELETE /rag-memory/clear     → hafızayı temizle');

  return { remember, recall, buildMemoryContext };
}

module.exports = { mountRagMemory, remember, recall, buildMemoryContext };
