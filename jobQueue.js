// ============================================================
// ⚡ jobQueue.js — Asenkron Görev Kuyruğu v1
// Brain sistemiyle tam entegre, WebSocket ile canlı güncelleme
//
// Kurulum:
//   npm install ws
//
// server.js'e ekle (app.listen'den ÖNCE):
//   const { initJobQueue, addJob, getJobStatus } = require('./jobQueue');
//   const { WebSocketServer } = require('ws');
//   const wss = new WebSocketServer({ server: httpServer });
//   initJobQueue(brain, axios, wss);
//
// Not: app.listen yerine şunu kullan:
//   const httpServer = app.listen(PORT, () => { ... });
// ============================================================

const { EventEmitter } = require('events');

// ── Job Store (in-memory + kalıcı dosya) ──────────────────
const fs   = require('fs');
const path = require('path');

const JOBS_FILE = path.join(__dirname, 'jobs.json');

function loadJobs() {
  try {
    if (fs.existsSync(JOBS_FILE)) return JSON.parse(fs.readFileSync(JOBS_FILE, 'utf-8'));
  } catch(e) {}
  return {};
}

function saveJobs(jobs) {
  // Sadece son 200 job sakla
  const keys   = Object.keys(jobs);
  const pruned = {};
  keys.slice(-200).forEach(k => pruned[k] = jobs[k]);
  fs.writeFileSync(JOBS_FILE, JSON.stringify(pruned, null, 2), 'utf-8');
}

// ── Global state ───────────────────────────────────────────
let _jobs    = loadJobs();
let _brain   = null;
let _axios   = null;
let _wss     = null;  // WebSocket Server
const _emitter = new EventEmitter();

// Aktif çalışan job sayısı (paralel limit)
let _running = 0;
const MAX_PARALLEL = 2;

// Job kuyrukları — öncelik sırasına göre
const _queue = [];

// ── WebSocket broadcast ────────────────────────────────────
function broadcast(event, data) {
  if (!_wss) return;
  const msg = JSON.stringify({ event, ...data, ts: new Date().toISOString() });
  _wss.clients.forEach(client => {
    if (client.readyState === 1) { // OPEN
      try { client.send(msg); } catch(e) {}
    }
  });
}

// ── Job oluştur ────────────────────────────────────────────
function createJob(type, payload = {}, priority = 5) {
  const jobId = `job_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const job = {
    jobId,
    type,
    payload,
    priority,
    status:    'queued',   // queued | running | done | failed | cancelled
    progress:  0,
    log:       [],
    result:    null,
    error:     null,
    createdAt: new Date().toISOString(),
    startedAt: null,
    finishedAt: null
  };

  _jobs[jobId] = job;
  saveJobs(_jobs);

  // Kuyruğa ekle (önceliğe göre sırala)
  _queue.push(jobId);
  _queue.sort((a, b) => (_jobs[b]?.priority || 0) - (_jobs[a]?.priority || 0));

  broadcast('job_created', { jobId, type, priority });
  console.log(`[JobQueue] 📥 Yeni job: ${jobId} (${type}) | öncelik: ${priority}`);

  // Kuyruğu işle
  _processQueue();

  return jobId;
}

// ── Job log ekle ──────────────────────────────────────────
function jobLog(jobId, message, level = 'info') {
  const job = _jobs[jobId];
  if (!job) return;
  const entry = { ts: new Date().toISOString(), level, message };
  job.log.push(entry);
  if (job.log.length > 500) job.log = job.log.slice(-500);
  broadcast('job_log', { jobId, entry });
  console.log(`[Job:${jobId.slice(-6)}] ${message}`);
}

// ── Job progress güncelle ──────────────────────────────────
function jobProgress(jobId, percent, message = '') {
  const job = _jobs[jobId];
  if (!job) return;
  job.progress = Math.min(100, percent);
  if (message) jobLog(jobId, message);
  broadcast('job_progress', { jobId, progress: job.progress, message });
}

// ── Job tamamla ───────────────────────────────────────────
function jobDone(jobId, result) {
  const job = _jobs[jobId];
  if (!job) return;
  job.status     = 'done';
  job.progress   = 100;
  job.result     = result;
  job.finishedAt = new Date().toISOString();
  saveJobs(_jobs);
  broadcast('job_done', { jobId, result });
  if (_brain) _brain.emo.onSuccess();
  console.log(`[JobQueue] ✅ ${jobId} tamamlandı`);
  _running--;
  _processQueue();
}

// ── Job hatalandır ─────────────────────────────────────────
function jobFail(jobId, error) {
  const job = _jobs[jobId];
  if (!job) return;
  job.status     = 'failed';
  job.error      = String(error);
  job.finishedAt = new Date().toISOString();
  saveJobs(_jobs);
  broadcast('job_failed', { jobId, error: String(error) });
  if (_brain) _brain.emo.onFailure(false);
  console.error(`[JobQueue] ❌ ${jobId} hata: ${error}`);
  _running--;
  _processQueue();
}

// ── Kuyruk işleyici ────────────────────────────────────────
async function _processQueue() {
  while (_running < MAX_PARALLEL && _queue.length > 0) {
    const jobId = _queue.shift();
    const job   = _jobs[jobId];
    if (!job || job.status !== 'queued') continue;

    job.status    = 'running';
    job.startedAt = new Date().toISOString();
    _running++;
    saveJobs(_jobs);
    broadcast('job_started', { jobId, type: job.type });

    // İşleyiciyi asenkron çalıştır (kuyruğu bloklamaz)
    _runJobHandler(jobId, job).catch(e => {
      jobLog(jobId, `Handler exception: ${e.message}`, 'error');
      jobFail(jobId, e.message);
    });
  }
}

// ── Job handler'ları ──────────────────────────────────────
// İstediğin kadar özel handler ekleyebilirsin
const _handlers = {};

function registerHandler(type, fn) {
  _handlers[type] = fn;
}

async function _runJobHandler(jobId, job) {
  const handler = _handlers[job.type];

  if (!handler) {
    jobLog(jobId, `Handler bulunamadı: ${job.type}`, 'error');
    return jobFail(jobId, `Bilinmeyen job tipi: ${job.type}`);
  }

  try {
    jobLog(jobId, `"${job.type}" görevi başladı`);
    const result = await handler(job, {
      log:      (msg, level) => jobLog(jobId, msg, level),
      progress: (pct, msg)  => jobProgress(jobId, pct, msg),
      brain:    _brain,
      axios:    _axios
    });
    jobDone(jobId, result);
  } catch(e) {
    jobLog(jobId, e.message, 'error');
    jobFail(jobId, e.message);
  }
}

// ── Hazır Handler'lar ─────────────────────────────────────

// 1. Ollama AI araştırma görevi (uzun süreli)
registerHandler('ai_research', async (job, ctx) => {
  const { question, depth = 3 } = job.payload;
  ctx.log('Araştırma başladı: ' + question);
  ctx.progress(5, 'Hafıza taranıyor...');

  let context = '';
  if (ctx.brain) {
    const memories = ctx.brain.mem.recall(question, 5);
    context = memories.map(m => m.value).join('\n');
  }

  ctx.progress(20, 'Ollama\'ya gönderiliyor...');

  const messages = [
    { role: 'system', content: 'Sen derin araştırma yapan bir asistansın. Türkçe, kapsamlı ve detaylı cevap ver.' },
    { role: 'user',   content: `Geçmiş bağlam:\n${context}\n\nAraştır: ${question}\n\nDerinlik seviyesi: ${depth}/5` }
  ];

  const r = await ctx.axios.post('http://localhost:11434/api/chat', {
    model: 'llama3.1:8b', stream: false, messages
  });

  ctx.progress(80, 'Sonuç brain hafızasına kaydediliyor...');
  const answer = r.data.message.content;

  if (ctx.brain) {
    ctx.brain.mem.remember(`research:${question.slice(0,60)}`, answer.slice(0,500), 0.9);
    ctx.brain.learn(question, answer);
  }

  ctx.progress(100, 'Araştırma tamamlandı');
  return { answer, question };
});

// 2. Web scraping görevi
registerHandler('web_scrape', async (job, ctx) => {
  const { urls = [], goal = '' } = job.payload;
  ctx.log(`${urls.length} URL taranacak`);
  const results = [];

  for (let i = 0; i < urls.length; i++) {
    ctx.progress(Math.round((i / urls.length) * 90), `Taranıyor: ${urls[i]}`);
    try {
      const r = await ctx.axios.get(urls[i], { timeout: 15000 });
      const text = String(r.data).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 2000);
      results.push({ url: urls[i], text });
      if (ctx.brain) ctx.brain.mem.remember(`scraped:${urls[i]}`, text.slice(0, 300), 0.7);
    } catch(e) {
      ctx.log(`${urls[i]} taranamadı: ${e.message}`, 'warn');
    }
  }

  ctx.progress(100, `${results.length} sayfa tarandı`);
  return { results, goal };
});

// 3. Toplu dosya işleme
registerHandler('batch_file', async (job, ctx) => {
  const { files = [], operation = 'summarize' } = job.payload;
  ctx.log(`${files.length} dosya işlenecek | işlem: ${operation}`);
  const results = [];

  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    ctx.progress(Math.round((i / files.length) * 100), `İşleniyor: ${f}`);
    results.push({ file: f, status: 'processed' });
    await new Promise(r => setTimeout(r, 100));
  }

  return { processed: results.length, operation };
});

// ── Genel API ─────────────────────────────────────────────
function addJob(type, payload, priority = 5) {
  return createJob(type, payload, priority);
}

function getJobStatus(jobId) {
  return _jobs[jobId] || null;
}

function getAllJobs(limit = 50) {
  return Object.values(_jobs)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .slice(0, limit);
}

function cancelJob(jobId) {
  const job = _jobs[jobId];
  if (!job || job.status !== 'queued') return false;
  job.status = 'cancelled';
  const idx = _queue.indexOf(jobId);
  if (idx > -1) _queue.splice(idx, 1);
  saveJobs(_jobs);
  broadcast('job_cancelled', { jobId });
  return true;
}

// ── Init ─────────────────────────────────────────────────
function initJobQueue(brainInstance, axiosInstance, wssInstance) {
  _brain = brainInstance;
  _axios = axiosInstance;
  _wss   = wssInstance;

  // WebSocket bağlantı log
  if (_wss) {
    _wss.on('connection', (ws) => {
      console.log('[JobQueue] 🔌 WebSocket istemci bağlandı');
      // Yeni bağlananı mevcut job durumlarıyla karşıla
      const recent = getAllJobs(20);
      ws.send(JSON.stringify({ event: 'init', jobs: recent, ts: new Date().toISOString() }));
    });
  }

  // Başlangıçta kuyruktaki işleri yeniden başlat
  const pending = Object.values(_jobs).filter(j => j.status === 'running');
  pending.forEach(j => {
    j.status = 'queued';  // Sunucu restart sonrası running kaldıysa resetle
    _queue.push(j.jobId);
    jobLog(j.jobId, 'Sunucu yeniden başlatıldı, görev yeniden kuyruğa alındı', 'warn');
  });
  if (pending.length > 0) _processQueue();

  console.log('[JobQueue] ✅ Asenkron job kuyruğu başlatıldı');
}

// ── Express endpoint'leri ─────────────────────────────────
function mountRoutes(app) {
  // Yeni job oluştur
  app.post('/jobs/create', (req, res) => {
    const { type, payload = {}, priority = 5 } = req.body;
    if (!type) return res.json({ status: 'error', message: 'type gerekli' });
    const jobId = addJob(type, payload, priority);
    res.json({ status: 'success', jobId, message: 'Görev kuyruğa alındı' });
  });

  // Job durumu
  app.get('/jobs/:jobId', (req, res) => {
    const job = getJobStatus(req.params.jobId);
    if (!job) return res.json({ status: 'error', message: 'Job bulunamadı' });
    res.json({ status: 'success', job });
  });

  // Tüm job'lar
  app.get('/jobs', (req, res) => {
    const limit = parseInt(req.query.limit) || 50;
    res.json({ status: 'success', jobs: getAllJobs(limit) });
  });

  // Job iptal
  app.delete('/jobs/:jobId', (req, res) => {
    const ok = cancelJob(req.params.jobId);
    res.json({ status: ok ? 'success' : 'error', message: ok ? 'İptal edildi' : 'İptal edilemedi' });
  });

  // AI araştırma kısayolu
  app.post('/jobs/research', (req, res) => {
    const { question, depth = 3 } = req.body;
    if (!question) return res.json({ status: 'error', message: 'question gerekli' });
    const jobId = addJob('ai_research', { question, depth }, 8);
    res.json({ status: 'success', jobId, message: `"${question}" araştırması arka planda başlatıldı` });
  });

  console.log('[JobQueue] 🛣️ Route\'lar mount edildi: /jobs /jobs/create /jobs/research');
}

module.exports = {
  initJobQueue,
  addJob,
  getJobStatus,
  getAllJobs,
  cancelJob,
  registerHandler,
  mountRoutes
};