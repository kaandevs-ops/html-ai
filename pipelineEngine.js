// ============================================================
// 🔁 pipelineEngine.js — Görev Zinciri (Pipeline) Motoru v1.0
//
// Mevcut hiçbir dosyaya dokunmaz.
// server.js'in EN SONUNA şunu ekle:
//
//   const { mountPipelineEngine } = require('./pipelineEngine');
//   mountPipelineEngine(app, brain, axios, { exec, fs, path, cron, PORT });
//
// Özellikler:
//   ✅ Birden fazla adımı sıralı zincirleme (pipe)
//   ✅ Pipeline kaydedip isimle tekrar çalıştırma
//   ✅ Cron ile periyodik çalıştırma ("her Pazartesi")
//   ✅ Her adımın çıktısı bir sonraki adıma input olarak geçer
//   ✅ Adım tipleri: agent_goal, http_get, http_post, terminal, wait, notify
//   ✅ WebSocket ile canlı adım takibi
//   ✅ Brain hafızasına sonuçlar kaydedilir
// ============================================================

'use strict';

const fs   = require('fs');
const path = require('path');

const PIPELINES_FILE = path.join(process.cwd(), 'pipelines.json');

// ── Kayıtlı pipeline'lar ───────────────────────────────────
let _pipelines = {};   // { id: PipelineDefinition }
let _runs      = {};   // { runId: RunState }
let _wsClients = new Set();

// ── Disk I/O ──────────────────────────────────────────────
function _loadPipelines() {
  try {
    if (fs.existsSync(PIPELINES_FILE)) {
      _pipelines = JSON.parse(fs.readFileSync(PIPELINES_FILE, 'utf-8'));
      console.log(`[Pipeline] 📂 ${Object.keys(_pipelines).length} pipeline yüklendi`);
    }
  } catch (e) {
    console.warn('[Pipeline] ⚠️ Yükleme hatası:', e.message);
  }
}

function _savePipelines() {
  try {
    fs.writeFileSync(PIPELINES_FILE, JSON.stringify(_pipelines, null, 2));
  } catch (e) {
    console.warn('[Pipeline] ⚠️ Kayıt hatası:', e.message);
  }
}

// ── WebSocket broadcast ───────────────────────────────────
function _broadcast(event, data) {
  const msg = JSON.stringify({ event, ...data, ts: new Date().toISOString() });
  _wsClients.forEach(ws => {
    if (ws.readyState === 1) try { ws.send(msg); } catch (e) {}
  });
}

// ══════════════════════════════════════════════════════════
// ADIM TİPLERİ
// ══════════════════════════════════════════════════════════

async function _runStep(step, ctx) {
  const { axios, exec, brain, PORT, prevOutput } = ctx;
  const args = { ...(step.args || {}) };

  // prevOutput şablonlama: {{prevOutput}} geçiyorsa değeri koy
  function _interpolate(str) {
    if (typeof str !== 'string') return str;
    return str.replace(/\{\{prevOutput\}\}/g, String(prevOutput || '').slice(0, 500));
  }
  Object.keys(args).forEach(k => {
    if (typeof args[k] === 'string') args[k] = _interpolate(args[k]);
  });

  switch (step.type) {

    // ── Otonom agent hedefi gönder ────────────────────────
    case 'agent_goal': {
      const goal = args.goal || prevOutput || 'Görevi tamamla';
      const r = await axios.post(`http://localhost:${PORT}/auto/inject-goal`, { goal }, { timeout: 15000 });
      return `Agent hedefi gönderildi: ${goal.slice(0, 80)}`;
    }

    // ── HTTP GET ──────────────────────────────────────────
    case 'http_get': {
      if (!args.url) throw new Error('url gerekli');
      const r = await axios.get(args.url, { timeout: 20000 });
      const data = typeof r.data === 'string' ? r.data : JSON.stringify(r.data);
      return data.slice(0, 2000);
    }

    // ── HTTP POST ─────────────────────────────────────────
    case 'http_post': {
      if (!args.url) throw new Error('url gerekli');
      const body = args.body || {};
      const r = await axios.post(args.url, body, { timeout: 20000 });
      return JSON.stringify(r.data).slice(0, 2000);
    }

    // ── Terminal komutu ───────────────────────────────────
    case 'terminal': {
      if (!args.command) throw new Error('command gerekli');
      return new Promise((resolve, reject) => {
        exec(args.command, { cwd: args.cwd || process.cwd(), timeout: 60000 }, (err, stdout, stderr) => {
          if (err) return reject(new Error((stderr || err.message).slice(0, 300)));
          resolve((stdout || '').trim().slice(0, 2000));
        });
      });
    }

    // ── Ollama AI soru ────────────────────────────────────
    case 'ai_ask': {
      const prompt = args.prompt || prevOutput || 'Analiz et';
      const r = await axios.post('http://localhost:11434/api/generate', {
        model:  process.env.OLLAMA_MODEL || 'llama3.1:8b',
        stream: false,
        prompt: `${args.system || ''}\n\n${prompt}`.trim(),
      });
      return (r.data?.response || '').trim().slice(0, 3000);
    }

    // ── Brain hafızasına yaz ──────────────────────────────
    case 'remember': {
      const key   = args.key || `pipeline:${Date.now()}`;
      const value = args.value || prevOutput || '';
      if (brain) brain.mem.remember(key, value.slice(0, 300), args.importance || 0.7);
      return `Kaydedildi: ${key}`;
    }

    // ── Proactive bildirim gönder ─────────────────────────
    case 'notify': {
      const message = args.message || prevOutput || 'Pipeline tamamlandı';
      // Mevcut proactiveEngine'e axios üzerinden POST
      await axios.post(`http://localhost:${PORT}/proactive/send`, {
        message: message.slice(0, 500),
        types: args.types || ['chat', 'desktop'],
      }, { timeout: 10000 }).catch(() => {});
      return `Bildirim gönderildi: ${message.slice(0, 60)}`;
    }

    // ── Bekle ─────────────────────────────────────────────
    case 'wait': {
      const ms = Math.min(args.ms || 2000, 30000);
      await new Promise(r => setTimeout(r, ms));
      return `${ms}ms beklendi`;
    }

    // ── Web scrape — mevcut browser endpoint üzerinden ────
    case 'scrape': {
      if (!args.url) throw new Error('url gerekli');
      const r = await axios.post(`http://localhost:${PORT}/assistant/browser/extract`, {
        url: args.url, selector: args.selector || 'body'
      }, { timeout: 30000 });
      return (r.data?.text || '').slice(0, 3000);
    }

    default:
      throw new Error(`Bilinmeyen adım tipi: ${step.type}`);
  }
}

// ══════════════════════════════════════════════════════════
// PIPELINE ÇALIŞTIR
// ══════════════════════════════════════════════════════════
async function runPipeline(pipelineDef, ctx) {
  const runId = `pipe_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`;

  const run = {
    runId,
    pipelineId:  pipelineDef.id || 'anonymous',
    name:        pipelineDef.name,
    status:      'running',
    steps:       [],
    startedAt:   new Date().toISOString(),
    finishedAt:  null,
    finalOutput: null,
  };

  _runs[runId] = run;
  _broadcast('pipeline_started', { runId, name: run.name });
  console.log(`[Pipeline] ▶️ "${run.name}" başladı (${runId})`);

  let prevOutput = ctx.initialInput || '';

  for (let i = 0; i < pipelineDef.steps.length; i++) {
    const step     = pipelineDef.steps[i];
    const stepName = step.name || `${step.type} #${i + 1}`;

    // İptal kontrolü
    if (run.status === 'cancelled') break;

    console.log(`[Pipeline]   📍 Adım ${i + 1}/${pipelineDef.steps.length}: ${stepName}`);
    _broadcast('pipeline_step', { runId, stepIndex: i, stepName, status: 'running' });

    const stepRecord = {
      index:    i,
      type:     step.type,
      name:     stepName,
      status:   'running',
      input:    String(prevOutput).slice(0, 200),
      output:   null,
      error:    null,
      ts:       new Date().toISOString(),
    };
    run.steps.push(stepRecord);

    try {
      const result = await _runStep(step, { ...ctx, prevOutput });
      prevOutput         = result;
      stepRecord.output  = String(result).slice(0, 500);
      stepRecord.status  = 'done';
      _broadcast('pipeline_step', { runId, stepIndex: i, stepName, status: 'done', output: stepRecord.output });
      console.log(`[Pipeline]   ✅ ${stepName} → ${String(result).slice(0, 80)}`);
    } catch (err) {
      stepRecord.error  = err.message.slice(0, 300);
      stepRecord.status = 'error';
      _broadcast('pipeline_step', { runId, stepIndex: i, stepName, status: 'error', error: stepRecord.error });
      console.error(`[Pipeline]   ❌ ${stepName}: ${err.message.slice(0, 100)}`);

      if (pipelineDef.stopOnError !== false) {
        run.status = 'failed';
        break;
      }
      // stopOnError: false → hataya rağmen devam et
      prevOutput = `HATA: ${err.message.slice(0, 100)}`;
    }
  }

  run.finalOutput = String(prevOutput).slice(0, 1000);
  run.finishedAt  = new Date().toISOString();
  if (run.status === 'running') run.status = 'done';

  // Brain'e kaydet
  if (ctx.brain) {
    try {
      ctx.brain.mem.remember(
        `pipeline_run:${run.name}:${_today()}`,
        run.finalOutput.slice(0, 200),
        0.7
      );
    } catch (e) {}
  }

  _broadcast('pipeline_done', { runId, status: run.status, finalOutput: run.finalOutput.slice(0, 300) });
  console.log(`[Pipeline] ${run.status === 'done' ? '✅' : '❌'} "${run.name}" ${run.status} | ${run.steps.length} adım`);

  return run;
}

function _today() {
  return new Date().toISOString().split('T')[0];
}

// ══════════════════════════════════════════════════════════
// 🔌 MOUNT
// ══════════════════════════════════════════════════════════
function mountPipelineEngine(app, brain, axios, deps = {}) {
  const { exec, cron, PORT } = deps;
  const port = PORT || 3000;

  if (!app) {
    console.warn('[Pipeline] ⚠️ app eksik, mount atlandı.');
    return;
  }

  _loadPipelines();

  const ctx = { axios, exec, brain, PORT: port };

  // ── Pipeline oluştur ve hemen çalıştır ────────────────
  app.post('/pipeline/run', async (req, res) => {
    const { name = 'Anonim', steps = [], stopOnError = true, initialInput = '' } = req.body;

    if (!steps.length) return res.json({ status: 'error', message: 'steps boş olamaz' });

    // Non-blocking
    const pipelineDef = { id: null, name, steps, stopOnError };
    res.json({ status: 'accepted', message: `"${name}" arka planda başlatıldı` });

    runPipeline(pipelineDef, { ...ctx, initialInput })
      .catch(e => console.error('[Pipeline] Fatal:', e.message));
  });

  // ── Pipeline kaydet ───────────────────────────────────
  app.post('/pipeline/save', (req, res) => {
    const { id, name, steps, stopOnError = true, schedule } = req.body;
    if (!name || !steps?.length) return res.json({ status: 'error', message: 'name ve steps gerekli' });

    const pId = id || `pl_${Date.now()}`;
    _pipelines[pId] = { id: pId, name, steps, stopOnError, schedule, createdAt: new Date().toISOString() };
    _savePipelines();

    // Cron zamanla (schedule: '0 9 * * 1' gibi)
    if (schedule && cron) {
      try {
        cron.schedule(schedule, async () => {
          console.log(`[Pipeline] ⏰ Cron tetiklendi: "${name}"`);
          runPipeline(_pipelines[pId], ctx).catch(e => console.error('[Pipeline] Cron hata:', e.message));
        }, { timezone: 'Europe/Istanbul' });
        console.log(`[Pipeline] ⏰ Zamanlandı: "${name}" → ${schedule}`);
      } catch (e) {
        console.warn('[Pipeline] ⚠️ Cron hatası:', e.message);
      }
    }

    res.json({ status: 'success', id: pId, message: `"${name}" kaydedildi` });
  });

  // ── Kayıtlı pipeline çalıştır ─────────────────────────
  app.post('/pipeline/run/:id', async (req, res) => {
    const pl = _pipelines[req.params.id];
    if (!pl) return res.json({ status: 'error', message: 'Pipeline bulunamadı' });

    const initialInput = req.body?.initialInput || '';
    res.json({ status: 'accepted', message: `"${pl.name}" başlatıldı` });
    runPipeline(pl, { ...ctx, initialInput }).catch(e => console.error('[Pipeline] Fatal:', e.message));
  });

  // ── Kayıtlı pipeline'ları listele ────────────────────
  app.get('/pipeline/list', (req, res) => {
    res.json({
      status: 'success',
      pipelines: Object.values(_pipelines).map(p => ({
        id:        p.id,
        name:      p.name,
        stepCount: p.steps.length,
        schedule:  p.schedule || null,
        createdAt: p.createdAt,
      }))
    });
  });

  // ── Çalıştırma geçmişi ────────────────────────────────
  app.get('/pipeline/runs', (req, res) => {
    const runs = Object.values(_runs)
      .sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt))
      .slice(0, 20)
      .map(r => ({
        runId:       r.runId,
        name:        r.name,
        status:      r.status,
        stepCount:   r.steps.length,
        startedAt:   r.startedAt,
        finishedAt:  r.finishedAt,
        finalOutput: (r.finalOutput || '').slice(0, 200),
      }));
    res.json({ status: 'success', runs });
  });

  // ── Çalıştırma detayı ─────────────────────────────────
  app.get('/pipeline/runs/:runId', (req, res) => {
    const run = _runs[req.params.runId];
    if (!run) return res.json({ status: 'error', message: 'Run bulunamadı' });
    res.json({ status: 'success', run });
  });

  // ── Pipeline sil ──────────────────────────────────────
  app.delete('/pipeline/:id', (req, res) => {
    const id = req.params.id;
    if (!_pipelines[id]) return res.json({ status: 'error', message: 'Bulunamadı' });
    const name = _pipelines[id].name;
    delete _pipelines[id];
    _savePipelines();
    res.json({ status: 'success', message: `"${name}" silindi` });
  });

  // ── WebSocket kayıt (server.js'te wss.on içine ekle) ──
  // Alternatif olarak registerWsClient kullanılabilir
  function registerWsClient(ws) {
    _wsClients.add(ws);
    ws.on('close', () => _wsClients.delete(ws));
  }

  // ── Desteklenen adım tipleri ──────────────────────────
  app.get('/pipeline/step-types', (req, res) => {
    res.json({
      status: 'success',
      types: {
        agent_goal: 'Otonom agent hedefi gönder {goal}',
        http_get:   'HTTP GET isteği {url}',
        http_post:  'HTTP POST isteği {url, body}',
        terminal:   'Terminal komutu {command, cwd}',
        ai_ask:     'Ollama AI sorusu {prompt, system}',
        remember:   'Brain hafızasına yaz {key, value}',
        notify:     'Bildirim gönder {message, types}',
        scrape:     'Web sayfası oku {url, selector}',
        wait:       'Bekle {ms}',
      },
      note: '{{prevOutput}} şablonu ile önceki adımın çıktısını alabilirsin'
    });
  });

  console.log('[Pipeline] 🔌 Mount tamamlandı.');
  console.log('  POST /pipeline/run            → anında pipeline çalıştır {name, steps}');
  console.log('  POST /pipeline/save           → kaydet + zamanla {name, steps, schedule}');
  console.log('  POST /pipeline/run/:id        → kayıtlı pipeline çalıştır');
  console.log('  GET  /pipeline/list           → kayıtlı pipeline\'lar');
  console.log('  GET  /pipeline/runs           → çalıştırma geçmişi');
  console.log('  GET  /pipeline/runs/:runId    → detay');
  console.log('  DELETE /pipeline/:id          → sil');
  console.log('  GET  /pipeline/step-types     → desteklenen adımlar');

  return { runPipeline, registerWsClient };
}

module.exports = { mountPipelineEngine, runPipeline };
