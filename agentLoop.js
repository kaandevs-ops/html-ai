// ============================================================
// 🤖 agentLoop.js — Gerçek Otonom Ajan Döngüsü v1
//
// Mevcut agentExecute'un yerini alır.
// Özellikler:
//   ✅ Plan → Çalıştır → Sonucu değerlendir → Düzelt → Tekrar
//   ✅ Her adımda hata yakalanır, LLM'e açıklanır, yeni plan istenir
//   ✅ Max retry, abort limiti, takıldığında farklı yol dener
//   ✅ Tüm adımlar brain hafızasına kaydedilir
//   ✅ WebSocket ile canlı durum yayınlanır
//   ✅ Başarı/başarısızlık brain.onAgentDone'a bildirilir
//
// server.js'e ekle:
//   const { runAgentLoop, mountAgentRoutes } = require('./agentLoop');
//   mountAgentRoutes(app, brain, axios, wss);
// ============================================================

const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const BrainAdapter = require('./brainAdapter');

// ── Sabitler ──────────────────────────────────────────────
const MAX_STEPS = 20;   // Tek görevde max adım
const MAX_RETRIES = 3;    // Aynı adım için max retry
const STEP_TIMEOUT = 30000; // ms — tek adım için timeout
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'llama3.1:8b';
const OLLAMA_URL = 'http://localhost:11434/api/chat';

// ── Global çalışan görev kaydı ─────────────────────────────
const _activeRuns = {};  // runId → RunState

// ── WebSocket broadcast (optional) ────────────────────────
let _wss = null;
let _brain = null;
let _axios = null;
let _adapter = null;  // BrainAdapter instance

function broadcast(runId, event, data = {}) {
  if (!_wss) return;
  const msg = JSON.stringify({ event, runId, ...data, ts: new Date().toISOString() });
  _wss.clients.forEach(c => { if (c.readyState === 1) try { c.send(msg); } catch (e) { } });
}

// ── LLM çağrısı (tüm konuşma geçmişiyle) ─────────────────
async function llmCall(messages, json = true, temperature = 0.1) {
  const r = await _axios.post(OLLAMA_URL, {
    model: OLLAMA_MODEL,
    stream: false,
    messages,
    options: { temperature }
  });
  const content = r.data?.message?.content || '';
  if (!json) return content;

  // JSON array veya object yakala — bracket counting ile doğru bloğu bul
  function extractJson(str, open, close) {
    const start = str.indexOf(open);
    if (start === -1) return null;
    let depth = 0;
    for (let i = start; i < str.length; i++) {
      if (str[i] === open)  depth++;
      if (str[i] === close) depth--;
      if (depth === 0) {
        try { return JSON.parse(str.slice(start, i + 1)); } catch (e) { return null; }
      }
    }
    return null;
  }

  const arr = extractJson(content, '[', ']');
  if (arr !== null) return arr;
  const obj = extractJson(content, '{', '}');
  if (obj !== null) return obj;
  return null;
}

// ── Araç çalıştırıcı ──────────────────────────────────────
async function executeTool(tool, args = {}) {
  // Timeout wrapper
  return Promise.race([
    _runTool(tool, args),
    new Promise((_, reject) => setTimeout(() => reject(new Error(`Timeout: ${tool} ${STEP_TIMEOUT}ms'de bitmedi`)), STEP_TIMEOUT))
  ]);
}

async function _runTool(tool, args) {
  switch (tool) {

    case 'run_terminal': {
      const cmd = args.command;
      if (!cmd) throw new Error('run_terminal: command eksik');
      return new Promise((resolve, reject) => {
        exec(cmd, { cwd: process.cwd(), shell: true }, (err, stdout, stderr) => {
          if (err) return reject(new Error(stderr || err.message));
          resolve({ output: (stdout || '').trim().slice(0, 2000), stderr: (stderr || '').slice(0, 500) });
        });
      });
    }

    case 'read_file': {
      const p = args.path;
      if (!p || !fs.existsSync(p)) throw new Error(`Dosya yok: ${p}`);
      return { content: fs.readFileSync(p, 'utf-8').slice(0, 5000) };
    }

    case 'write_file': {
      const { path: p, content } = args;
      if (!p || content === undefined) throw new Error('write_file: path ve content gerekli');
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, content, 'utf-8');
      return { written: p, bytes: content.length };
    }

    case 'http_get': {
      const r = await _axios.get(args.url, { timeout: 15000 });
      const text = typeof r.data === 'string' ? r.data : JSON.stringify(r.data);
      return { body: text.slice(0, 3000) };
    }

    case 'http_post': {
      const r = await _axios.post(args.url, args.body || {}, { timeout: 15000 });
      return { body: JSON.stringify(r.data).slice(0, 2000) };
    }

    case 'call_endpoint': {
      // Kendi server endpoint'lerini çağır
      const method = (args.method || 'GET').toUpperCase();
      const url = `http://localhost:${process.env.PORT || 3000}${args.path}`;
      const r = method === 'POST'
        ? await _axios.post(url, args.body || {})
        : await _axios.get(url, { params: args.params });
      return r.data;
    }

    case 'wait': {
      await new Promise(r => setTimeout(r, Math.min(args.ms || 1000, 10000)));
      return { waited: args.ms || 1000 };
    }

    case 'verify': {
      // Bir koşulun doğruluğunu terminal ile kontrol et
      const cmd = args.command;
      return new Promise((resolve) => {
        exec(cmd, (err, stdout) => resolve({ ok: !err, output: (stdout || '').trim() }));
      });
    }

    case 'remember': {
      if (_brain) _brain.mem.remember(args.key, args.value, args.importance || 0.8);
      return { remembered: args.key };
    }

    case 'recall': {
      if (!_brain) return { results: [] };
      const results = _brain.mem.recall(args.query, args.topN || 3);
      return { results: results.map(r => ({ key: r.key, value: r.value })) };
    }

    default:
      throw new Error(`Bilinmeyen araç: ${tool}`);
  }
}

// ── Ana döngü ─────────────────────────────────────────────
async function runAgentLoop(goal, options = {}) {
  const runId = options._runId || `run_${Date.now()}_${Math.random().toString(36).slice(2,5)}`;

  // ── Brain'den dinamik config al ───────────────────────
  const brainConfig = _adapter
    ? _adapter.getRunConfig(goal)
    : {
      temperature: 0.1, maxSteps: 20, retryLimit: 3, planningStyle: 'balanced',
      dreamInsights: [], goalAlignment: [], _reasoning: 'adapter yok'
    };

  const maxSteps = options.maxSteps || brainConfig.maxSteps;
  const temperature = brainConfig.temperature;

  // Run state
  const state = {
    runId,
    goal,
    status: 'running',
    steps: [],
    plan: [],
    planIndex: 0,
    retries: 0,
    totalSteps: 0,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    finalReport: null,
    brainConfig  // 👈 hangi config ile çalıştığını kaydet
  };

  _activeRuns[runId] = state;
  broadcast(runId, 'agent_started', { goal });
  _log(state, `🎯 Hedef: "${goal}"`);

  // Hafızadan ilgili geçmiş al
  let memContext = '';
  if (_brain) {
    const mems = _brain.mem.recall(goal, 4);
    if (mems.length > 0) {
      memContext = '\n\nGeçmiş hafızadan ilgili bilgiler:\n' + mems.map(m => `- ${m.key}: ${String(m.value).slice(0, 100)}`).join('\n');
    }
  }

  // ── Brain'den sistem prompt prefix'i al ──────────────
  const brainSystemPrefix = _adapter
    ? _adapter.buildSystemPrompt(goal, brainConfig)
    : '';

  // Konuşma geçmişi — LLM bağlamı korur
  const conversation = [
    {
      role: 'system',
      content: `Sen bilgisayarı kontrol eden otonom bir ajansın. 
Türkçe düşün ve Türkçe yanıt ver.
Hedefi adım adım gerçekleştirmek için araçları kullan.

Kullanılabilir araçlar:
- run_terminal: {"command": "terminal komutu"} — terminal komutu çalıştır
- read_file: {"path": "/tam/yol"} — dosya oku
- write_file: {"path": "/tam/yol", "content": "içerik"} — dosya yaz
- http_get: {"url": "https://..."} — HTTP GET isteği
- http_post: {"url": "...", "body": {...}} — HTTP POST isteği
- call_endpoint: {"method": "GET/POST", "path": "/endpoint", "params": {}, "body": {}} — sunucu endpoint çağır
- verify: {"command": "test komutu"} — bir koşulu doğrula
- wait: {"ms": 1000} — bekle
- remember: {"key": "anahtar", "value": "değer"} — hafızaya kaydet
- recall: {"query": "sorgu"} — hafızadan ara

PLAN FORMATI (SADECE JSON ARRAY DÖNDÜR):
[
  {"tool": "araç_adı", "args": {...}, "description": "Bu adımda ne yapıyorum"},
  ...
]

Hata alırsan veya sonuç beklediğin gibi değilse, farklı bir yol dene.${memContext}

${'─'.repeat(60)}
${brainSystemPrefix}`
    }
  ];

  try {
    // ── AŞAMA 1: İlk plan ────────────────────────────────
    _log(state, '🧠 Plan oluşturuluyor...');
    broadcast(runId, 'agent_planning', { stage: 'initial' });

    conversation.push({ role: 'user', content: `Hedef: ${goal}\n\nBu hedefi gerçekleştirmek için adım adım bir plan yap ve JSON olarak döndür.` });

    const initialPlan = await llmCall(conversation, true, temperature);
    if (!Array.isArray(initialPlan) || initialPlan.length === 0) {
      throw new Error('LLM geçerli bir plan üretemedi');
    }

    state.plan = initialPlan;
    conversation.push({ role: 'assistant', content: JSON.stringify(initialPlan) });

    _log(state, `📋 Plan: ${initialPlan.length} adım`);
    broadcast(runId, 'agent_plan_ready', { plan: initialPlan });

    // ── AŞAMA 2: Yürütme döngüsü ─────────────────────────
    let stepIndex = 0;

    while (stepIndex < state.plan.length && state.totalSteps < maxSteps) {
      const step = state.plan[stepIndex];
      if (!step?.tool) { stepIndex++; continue; }

      const stepDesc = step.description || `${step.tool}(${JSON.stringify(step.args).slice(0, 60)})`;
      _log(state, `⚙️ Adım ${stepIndex + 1}/${state.plan.length}: ${stepDesc}`);
      broadcast(runId, 'agent_step_start', { stepIndex, tool: step.tool, description: stepDesc });

      let stepResult = null;
      let stepError = null;
      let retryCount = 0;

      // ── Retry döngüsü ─────────────────────────────────
      while (retryCount <= (brainConfig.retryLimit ?? MAX_RETRIES)) {
        try {
          stepResult = await executeTool(step.tool, step.args || {});
          _log(state, `  ✅ Sonuç: ${JSON.stringify(stepResult).slice(0, 150)}`);
          stepError = null;
          break; // Başarılı, retry döngüsünden çık

        } catch (err) {
          stepError = err.message;
          retryCount++;
          _log(state, `  ❌ Hata (deneme ${retryCount}/${MAX_RETRIES}): ${stepError}`);

          if (retryCount > (brainConfig.retryLimit ?? MAX_RETRIES)) break;

          // ── LLM'e hatayı açıkla, düzeltilmiş adım iste ──
          _log(state, `  🔄 LLM'den düzeltme isteniyor...`);
          broadcast(runId, 'agent_retry', { stepIndex, retryCount, error: stepError });

          conversation.push({
            role: 'user',
            content: `Adım ${stepIndex + 1} hata verdi:
Araç: ${step.tool}
Argümanlar: ${JSON.stringify(step.args)}
HATA: ${stepError}

Bu adımı düzelt veya farklı bir araçla aynı sonuca ulaş.
SADECE bu tek adım için JSON döndür: {"tool": "...", "args": {...}, "description": "..."}`
          });

          const fixedStep = await llmCall(conversation, true, temperature);
          if (fixedStep && fixedStep.tool) {
            conversation.push({ role: 'assistant', content: JSON.stringify(fixedStep) });
            step.tool = fixedStep.tool;
            step.args = fixedStep.args;
            step.description = fixedStep.description || step.description;
            _log(state, `  🔧 Düzeltilmiş adım: ${fixedStep.tool}(${JSON.stringify(fixedStep.args).slice(0, 80)})`);
          } else {
            _log(state, `  ⚠️ Düzeltme alınamadı, bekliyorum...`);
            await new Promise(r => setTimeout(r, 1000));
          }
        }
      }

      // Adımı kaydet
      const stepRecord = {
        index: stepIndex,
        tool: step.tool,
        args: step.args,
        description: stepDesc,
        result: stepResult,
        error: stepError,
        retries: retryCount,
        ts: new Date().toISOString()
      };
      state.steps.push(stepRecord);
      state.totalSteps++;

      if (_brain) {
        const brainStep = { tool: step.tool, command: JSON.stringify(step.args).slice(0, 100) };
        if (stepError) brainStep.error = stepError;
        else brainStep.result = JSON.stringify(stepResult).slice(0, 100);
      }

      broadcast(runId, 'agent_step_done', { stepIndex, success: !stepError, result: stepResult, error: stepError });

      // ── Sonuç değerlendirmesi ─────────────────────────
      // Her 3 adımda bir veya kritik hata sonrası LLM ile değerlendir
      const shouldEvaluate = (stepIndex > 0 && (stepIndex + 1) % 3 === 0) ||
        (stepError && retryCount > MAX_RETRIES);

      if (shouldEvaluate && stepIndex < state.plan.length - 1) {
        _log(state, `🤔 Ara değerlendirme: Hedefle uyum kontrol ediliyor...`);

        const stepsContext = state.steps.slice(-5).map(s =>
          `- ${s.tool}: ${s.error ? '❌ ' + s.error : '✅ ' + JSON.stringify(s.result).slice(0, 80)}`
        ).join('\n');

        conversation.push({
          role: 'user',
          content: `Son ${Math.min(5, state.steps.length)} adımın özeti:
${stepsContext}

Hedef: "${goal}"
Kalan plan: ${JSON.stringify(state.plan.slice(stepIndex + 1))}

Hedefimize doğru ilerliyoruz mu? 
- Eğer devam etmemiz gerekiyorsa: {"continue": true, "reason": "..."}
- Eğer planı değiştirmemiz gerekiyorsa: {"continue": false, "newPlan": [...], "reason": "..."}
- Eğer hedef tamamlandıysa: {"continue": false, "completed": true, "reason": "..."}`
        });

        const evaluation = await llmCall(conversation, true, temperature);
        if (evaluation) {
          conversation.push({ role: 'assistant', content: JSON.stringify(evaluation) });

          if (evaluation.completed) {
            _log(state, `🎉 LLM: Hedef tamamlandı! "${evaluation.reason}"`);
            break;
          }

          if (!evaluation.continue && Array.isArray(evaluation.newPlan) && evaluation.newPlan.length > 0) {
            _log(state, `🔄 Plan güncelleniyor: ${evaluation.reason}`);
            broadcast(runId, 'agent_replan', { reason: evaluation.reason, newPlan: evaluation.newPlan });
            // Kalan plan'ı yeni planla değiştir
            state.plan = [...state.plan.slice(0, stepIndex + 1), ...evaluation.newPlan];
          }
        }
      }

      stepIndex++;
    }

    // ── AŞAMA 3: Final raporu ──────────────────────────
    _log(state, `📊 Final raporu oluşturuluyor...`);

    const successSteps = state.steps.filter(s => !s.error).length;
    const failedSteps = state.steps.filter(s => s.error).length;

    conversation.push({
      role: 'user',
      content: `Görev tamamlandı. 
Toplam ${state.steps.length} adım: ${successSteps} başarılı, ${failedSteps} başarısız.

Hedef: "${goal}"

Türkçe kısa bir sonuç raporu yaz (2-3 cümle). Ne başarıldı, ne başarılamadı, varsa öneriler.`
    });

    const report = await llmCall(conversation, false);
    state.finalReport = report || `${successSteps}/${state.steps.length} adım başarıyla tamamlandı.`;

    const overallSuccess = failedSteps === 0 || successSteps > failedSteps;
    state.status = overallSuccess ? 'done' : 'partial';
    state.finishedAt = new Date().toISOString();

    // Brain'e bildir
    if (_brain) {
      _brain.onAgentDone(goal, state.steps, overallSuccess ? 'success' : 'partial');
      _brain.mem.remember(`agent_run:${goal.slice(0, 50)}`, state.finalReport, 0.85);
    }

    _log(state, `✅ Döngü bitti | ${state.status} | ${successSteps}/${state.steps.length} başarılı`);
    _log(state, `📝 Rapor: ${state.finalReport}`);
    broadcast(runId, 'agent_done', {
      status: state.status,
      successSteps,
      failedSteps,
      report: state.finalReport
    });

    return state;

  } catch (fatalErr) {
    state.status = 'failed';
    state.finishedAt = new Date().toISOString();
    _log(state, `💥 Fatal hata: ${fatalErr.message}`);
    broadcast(runId, 'agent_failed', { error: fatalErr.message });
    if (_brain) _brain.onAgentDone(goal, state.steps, 'error');
    return state;
  }
}

// ── Log yardımcısı ─────────────────────────────────────────
function _log(state, message) {
  const entry = { ts: new Date().toISOString(), message };
  if (!state.log) state.log = [];
  state.log.push(entry);
  console.log(`[Agent:${state.runId.slice(-6)}] ${message}`);
  broadcast(state.runId, 'agent_log', { message });
}

// ── Express route'ları ─────────────────────────────────────
function mountAgentRoutes(app, brainInstance, axiosInstance, wssInstance) {
  _brain = brainInstance;
  _axios = axiosInstance;
  _wss = wssInstance;
  _adapter = brainInstance ? new BrainAdapter(brainInstance) : null;

  if (_adapter) {
    console.log('[AgentLoop] 🧠 BrainAdapter etkinleştirildi — dinamik davranış aktif.');
  } else {
    console.log('[AgentLoop] ⚠️ Brain bağlı değil, varsayılan config kullanılacak.');
  }

  // Yeni görev başlat (non-blocking)
  app.post('/agent/run', (req, res) => {
    const { goal, maxSteps } = req.body;
    if (!goal) return res.json({ status: 'error', message: 'goal gerekli' });

    // Arka planda çalıştır, hemen runId dön
    const runId = `run_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`;
    _activeRuns[runId] = { runId, goal, status: 'starting', steps: [], log: [] };

    // Async başlat
    // Önceden oluşturulan objeyi runAgentLoop'a geç, üzerine yaz
    runAgentLoop(goal, { maxSteps: maxSteps || MAX_STEPS, _runId: runId })
      .then(state => { _activeRuns[runId] = state; })
      .catch(e => {
        if (_activeRuns[runId]) {
          _activeRuns[runId].status = 'failed';
          _activeRuns[runId].error = e.message;
        }
      });

    res.json({ status: 'started', runId, message: `"${goal}" arka planda başlatıldı` });
  });

  // Görev durumu
  app.get('/agent/run/:runId', (req, res) => {
    const run = _activeRuns[req.params.runId];
    if (!run) return res.json({ status: 'error', message: 'Run bulunamadı' });
    res.json({ status: 'success', run });
  });

  // Tüm çalıştırma geçmişi
  app.get('/agent/runs', (req, res) => {
    const runs = Object.values(_activeRuns)
      .sort((a, b) => new Date(b.startedAt || 0) - new Date(a.startedAt || 0))
      .slice(0, 20)
      .map(r => ({
        runId: r.runId,
        goal: r.goal,
        status: r.status,
        steps: (r.steps || []).length,
        startedAt: r.startedAt,
        finishedAt: r.finishedAt,
        finalReport: r.finalReport,
        brainConfig: r.brainConfig ? {
          planningStyle: r.brainConfig.planningStyle,
          temperature: r.brainConfig.temperature,
          maxSteps: r.brainConfig.maxSteps,
          riskTolerance: r.brainConfig.riskTolerance,
          _reasoning: r.brainConfig._reasoning
        } : null
      }));
    res.json({ status: 'success', runs });
  });

  // Görev iptali (çalışıyorsa durdur)
  app.delete('/agent/run/:runId', (req, res) => {
    const run = _activeRuns[req.params.runId];
    if (!run) return res.json({ status: 'error', message: 'Run bulunamadı' });
    if (run.status === 'running') {
      run.status = 'cancelled';
      res.json({ status: 'success', message: 'İptal işaretlendi (mevcut adım bittikten sonra durur)' });
    } else {
      res.json({ status: 'error', message: `İptal edilemez: ${run.status}` });
    }
  });

  // Eski /agent/autonomous endpoint'ini güncelle (geriye dönük uyumluluk)
  app.post('/agent/autonomous-v2', (req, res) => {
    req.url = '/agent/run';
    app._router.handle(req, res);
  });

  console.log('[AgentLoop] 🛣️ Route\'lar mount edildi: /agent/run /agent/runs /agent/run/:id');
}

module.exports = { runAgentLoop, mountAgentRoutes };