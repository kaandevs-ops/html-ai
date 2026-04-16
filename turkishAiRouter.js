// ============================================================
// 🤖 turkishAiRouter.js — Turkish AI + Ollama Hibrit Router v1
//
// Hem Ollama hem de kendi Turkish AI'ını kullanabilmeni sağlar.
// Brain sistemiyle (enrichPrompt, learn, onError, checkReflex,
// onAgentDone, episodic, userUnderstanding) TAM entegre çalışır.
//
// KURULUM — server.js'in sonuna ekle (wss.on'dan önce):
//
//   const { mountTurkishAiRouter } = require('./turkishAiRouter');
//   mountTurkishAiRouter(app, brain, axios, conversations);
//
// KULLANIMLAR:
//   POST /ai/ask          → Akıllı yönlendirme (otomatik seçer)
//   POST /turkish-ai/ask  → Sadece Turkish AI
//   POST /ollama/ask      → Sadece Ollama (mevcut endpoint'i bozmaz)
//   GET  /ai/status       → Her iki motor durumu
//   POST /ai/switch       → Aktif motoru değiştir (ollama | turkish)
// ============================================================

'use strict';

// ── Sabitler ──────────────────────────────────────────────
const TURKISH_AI_URL  = 'http://localhost:5001';
const OLLAMA_URL      = 'http://localhost:11434/api/chat';
const OLLAMA_MODEL    = process.env.OLLAMA_MODEL || 'llama3.1:8b';

// ── Motor durumu ──────────────────────────────────────────
// 'auto'    → brain başarı oranına göre otomatik seçer
// 'ollama'  → hep Ollama
// 'turkish' → hep Turkish AI
let _activeEngine = 'auto';

// Turkish AI sağlık durumu cache (30 sn)
let _turkishAiHealthy   = null;
let _lastHealthCheck    = 0;
const HEALTH_CACHE_MS   = 30_000;

// ── Turkish AI sağlık kontrolü ────────────────────────────
async function _checkTurkishAiHealth(axios) {
  const now = Date.now();
  if (now - _lastHealthCheck < HEALTH_CACHE_MS && _turkishAiHealthy !== null) {
    return _turkishAiHealthy;
  }
  try {
    const r = await axios.get(`${TURKISH_AI_URL}/health`, { timeout: 3000 });
    _turkishAiHealthy = r.data?.status === 'ok';
  } catch {
    _turkishAiHealthy = false;
  }
  _lastHealthCheck = now;
  return _turkishAiHealthy;
}

// ── Hangi motor kullanılacak? ─────────────────────────────
// auto modunda: Turkish AI sağlıklıysa ve brain başarı oranı
// kritik değilse Turkish AI'ı da karıştırır.
// Stres yüksekse güvenilir olan Ollama'ya geçer.
async function _selectEngine(brain, axios, forceEngine = null) {
  if (forceEngine) return forceEngine;
  if (_activeEngine !== 'auto') return _activeEngine;

  const healthy = await _checkTurkishAiHealth(axios);
  if (!healthy) return 'ollama'; // Turkish AI kapalı → Ollama

  // Brain stres durumu
  try {
    const emoState   = brain?.emo?.getState?.() || {};
    const successRate = brain?.learning?.getSuccessRate?.() ?? 1.0;
    const stressRaw  = brain?.stress?.getStrategy?.(emoState) || '';
    const highStress = typeof stressRaw === 'string'
      ? stressRaw.includes('KRİTİK') || stressRaw.includes('YÜKSEK')
      : false;

    // Yüksek stres veya çok düşük başarı → Ollama (daha stabil)
    if (highStress || successRate < 0.3) return 'ollama';

    // Düşük başarı oranında Turkish AI'ı test amacıyla hâlâ kullanabiliriz
    // ama oran çok düşükse Ollama'ya git
    return 'turkish';
  } catch {
    return 'ollama';
  }
}

// ── Turkish AI'a istek at ─────────────────────────────────
async function _callTurkishAi(axios, message, sessionId, options = {}) {
  const r = await axios.post(
    `${TURKISH_AI_URL}/ask`,
    {
      message,
      temperature:      options.temperature  ?? 0.8,
      max_length:       options.maxLength    ?? 150,
      use_memory:       options.useMemory    ?? true,
      use_beam_search:  options.beamSearch   ?? false,
    },
    { timeout: 30_000 }
  );

  if (r.data?.status !== 'success') {
    throw new Error(r.data?.message || 'Turkish AI yanıt vermedi');
  }
  return r.data.response;
}

// ── Ollama'ya istek at ────────────────────────────────────
async function _callOllama(axios, enrichedPrompt, sessionId, conversations, options = {}) {
  if (!conversations[sessionId]) conversations[sessionId] = [];

  conversations[sessionId].push({ role: 'user', content: enrichedPrompt });

  // Konuşma geçmişini kısalt (son 20 mesaj)
  if (conversations[sessionId].length > 20) {
    conversations[sessionId] = conversations[sessionId].slice(-20);
  }

  const r = await axios.post(
    OLLAMA_URL,
    {
      model:  options.model || OLLAMA_MODEL,
      stream: false,
      messages: conversations[sessionId],
      options: { temperature: options.temperature ?? 0.7 }
    },
    { timeout: 60_000 }
  );

  const answer = r.data?.message?.content || '';
  conversations[sessionId].push({ role: 'assistant', content: answer });
  return answer;
}

// ── Ana mount fonksiyonu ──────────────────────────────────
function mountTurkishAiRouter(app, brain, axios, conversations = {}) {

  // ────────────────────────────────────────────────────────
  // POST /ai/ask — Akıllı hibrit endpoint
  // Body: { message, sessionId?, engine?, temperature?,
  //         maxLength?, useMemory?, beamSearch?, model? }
  // ────────────────────────────────────────────────────────
  app.post('/ai/ask', async (req, res) => {
    const {
      message,
      sessionId    = 'default',
      engine       = null,       // 'ollama' | 'turkish' | null (auto)
      temperature,
      maxLength,
      useMemory    = true,
      beamSearch   = false,
      model,
    } = req.body;

    if (!message) {
      return res.json({ status: 'error', message: 'message gerekli' });
    }

    const startTime = Date.now();

    try {
      // 1. Refleks cache kontrolü (brain)
      const reflexAnswer = brain?.checkReflex?.(message);
      if (reflexAnswer) {
        console.log(`[AI Router] ⚡ Refleks cache hit: "${message.substring(0, 40)}"`);
        brain?.learn?.(message, reflexAnswer);
        return res.json({
          status:   'success',
          response: reflexAnswer,
          engine:   'reflex_cache',
          ms:       Date.now() - startTime,
        });
      }

      // 2. Hangi motor?
      const selectedEngine = await _selectEngine(brain, axios, engine);

      // 3. Brain ile prompt zenginleştirme
      // Turkish AI kendi hafızasını kullanır, biz sadece Ollama için zenginleştiririz
      let enrichedMessage = message;
      if (selectedEngine === 'ollama') {
        try {
          enrichedMessage = brain?.enrichPrompt?.(message) ?? message;
        } catch (e) {
          console.warn('[AI Router] enrichPrompt hatası:', e.message);
        }
      }

      // 4. Motor çağrısı
      let answer = '';
      let engineUsed = selectedEngine;

      if (selectedEngine === 'turkish') {
        try {
          answer = await _callTurkishAi(axios, message, sessionId, {
            temperature, maxLength, useMemory, beamSearch,
          });
          // Turkish AI yanıtını brain'e de öğret
          brain?.learn?.(message, answer);
        } catch (turkishErr) {
          console.warn(`[AI Router] Turkish AI hatası, Ollama'ya geçiliyor: ${turkishErr.message}`);
          brain?.onError?.('turkish_ai', message, turkishErr.message);
          // Fallback: Ollama
          enrichedMessage = brain?.enrichPrompt?.(message) ?? message;
          answer = await _callOllama(axios, enrichedMessage, sessionId, conversations, {
            temperature, model,
          });
          engineUsed = 'ollama_fallback';
          brain?.learn?.(message, answer);
        }
      } else {
        // Ollama
        answer = await _callOllama(axios, enrichedMessage, sessionId, conversations, {
          temperature, model,
        });
        brain?.learn?.(message, answer);
      }

      // 5. Brain episodik + kullanıcı anlama güncelle
      try {
        const emotionNow = brain?.empathy?.detectEmotion?.(message) || { emotion: 'neutral' };
        brain?.episodic?.saveEpisode?.(message, answer, brain?.emo?.getState?.());
        brain?.userUnderstanding?.observe?.(message, answer, emotionNow);
        brain?.prediction?.recordOutcome?.(message, answer, emotionNow);
        brain?.userProfile?.onInteraction?.(message, answer, emotionNow);
        brain?.reflection?.updateContext?.(message, answer);
      } catch (e) {
        // Kritik değil, sessizce geç
      }

      console.log(`[AI Router] ✅ ${engineUsed} | ${Date.now() - startTime}ms | "${message.substring(0, 40)}"`);

      return res.json({
        status:   'success',
        response: answer,
        engine:   engineUsed,
        ms:       Date.now() - startTime,
      });

    } catch (err) {
      console.error(`[AI Router] ❌ Kritik hata: ${err.message}`);
      brain?.onError?.('ai_router', message, err.message);
      return res.json({
        status:  'error',
        message: err.message,
        engine:  'none',
        ms:      Date.now() - startTime,
      });
    }
  });

  // ────────────────────────────────────────────────────────
  // POST /turkish-ai/ask — Sadece Turkish AI (direk, brain entegre)
  // Body: { message, sessionId?, temperature?, maxLength?,
  //         useMemory?, beamSearch? }
  // ────────────────────────────────────────────────────────
  app.post('/turkish-ai/ask', async (req, res) => {
    const {
      message,
      sessionId  = 'default',
      temperature,
      maxLength,
      useMemory  = true,
      beamSearch = false,
    } = req.body;

    if (!message) return res.json({ status: 'error', message: 'message gerekli' });

    const startTime = Date.now();

    // 1. Refleks cache
    const reflexAnswer = brain?.checkReflex?.(message);
    if (reflexAnswer) {
      return res.json({
        status: 'success', response: reflexAnswer,
        engine: 'reflex_cache', ms: Date.now() - startTime,
      });
    }

    // 2. Sağlık kontrolü
    const healthy = await _checkTurkishAiHealth(axios);
    if (!healthy) {
      return res.json({
        status:  'error',
        message: 'Turkish AI servisi çalışmıyor. python3 server_api.py ile başlatın.',
        engine:  'turkish',
      });
    }

    try {
      const answer = await _callTurkishAi(axios, message, sessionId, {
        temperature, maxLength, useMemory, beamSearch,
      });

      // Brain güncelle
      brain?.learn?.(message, answer);
      try {
        const emotionNow = brain?.empathy?.detectEmotion?.(message) || {};
        brain?.episodic?.saveEpisode?.(message, answer, brain?.emo?.getState?.());
        brain?.userUnderstanding?.observe?.(message, answer, emotionNow);
        brain?.reflection?.updateContext?.(message, answer);
      } catch (_) {}

      return res.json({
        status: 'success', response: answer,
        engine: 'turkish', ms: Date.now() - startTime,
      });
    } catch (err) {
      brain?.onError?.('turkish_ai', message, err.message);
      return res.json({
        status: 'error', message: err.message,
        engine: 'turkish', ms: Date.now() - startTime,
      });
    }
  });

  // ────────────────────────────────────────────────────────
  // POST /turkish-ai/reset — Turkish AI konuşmasını sıfırla
  // ────────────────────────────────────────────────────────
  app.post('/turkish-ai/reset', async (req, res) => {
    try {
      const r = await axios.post(`${TURKISH_AI_URL}/reset`, {}, { timeout: 5000 });
      res.json({ status: 'success', message: 'Turkish AI konuşması sıfırlandı', data: r.data });
    } catch (e) {
      res.json({ status: 'error', message: e.message });
    }
  });

  // ────────────────────────────────────────────────────────
  // POST /turkish-ai/learn — Geri bildirim ile öğret
  // Body: { correct_response, positive? }
  // ────────────────────────────────────────────────────────
  app.post('/turkish-ai/learn', async (req, res) => {
    const { correct_response = '', positive = true } = req.body;
    try {
      const r = await axios.post(
        `${TURKISH_AI_URL}/learn`,
        { correct_response, positive },
        { timeout: 5000 }
      );
      // Aynı bilgiyi brain'e de kaydet
      if (correct_response) {
        brain?.mem?.remember(`turkish_ai:feedback`, correct_response, 0.8);
      }
      res.json({ status: 'success', data: r.data });
    } catch (e) {
      res.json({ status: 'error', message: e.message });
    }
  });

  // ────────────────────────────────────────────────────────
  // GET /ai/status — Her iki motorun durumu + brain özeti
  // ────────────────────────────────────────────────────────
  app.get('/ai/status', async (req, res) => {
    const [turkishHealthy] = await Promise.allSettled([
      _checkTurkishAiHealth(axios)
    ]);

    // Turkish AI stats (sağlıklıysa)
    let turkishStats = null;
    if (_turkishAiHealthy) {
      try {
        const r = await axios.post(`${TURKISH_AI_URL}/stats`, {}, { timeout: 3000 });
        turkishStats = r.data?.stats || null;
      } catch (_) {}
    }

    const brainStatus = brain?.getStatus?.() || {};

    res.json({
      status:       'success',
      activeEngine: _activeEngine,
      engines: {
        turkish: {
          healthy:  _turkishAiHealthy,
          url:      TURKISH_AI_URL,
          stats:    turkishStats,
        },
        ollama: {
          healthy: true,  // varsa çalışıyor sayarız, agentLoop zaten kontrol eder
          url:     OLLAMA_URL,
          model:   OLLAMA_MODEL,
        },
      },
      brain: {
        successRate:      brain?.learning?.getSuccessRate?.() ?? null,
        emoMood:          brainStatus.emotions?.mood || 'NORMAL',
        sessionCount:     brainStatus.memory?.stats?.sessionCount || 0,
        episodicCount:    brainStatus.episodic?.totalEpisodes || 0,
      },
    });
  });

  // ────────────────────────────────────────────────────────
  // POST /ai/switch — Aktif motoru değiştir
  // Body: { engine: 'auto' | 'ollama' | 'turkish' }
  // ────────────────────────────────────────────────────────
  app.post('/ai/switch', (req, res) => {
    const { engine } = req.body;
    if (!['auto', 'ollama', 'turkish'].includes(engine)) {
      return res.json({
        status:  'error',
        message: "engine 'auto', 'ollama' veya 'turkish' olmalı",
      });
    }
    const prev = _activeEngine;
    _activeEngine = engine;
    brain?.mem?.remember?.('ai_router:active_engine', engine, 0.9);
    console.log(`[AI Router] 🔀 Motor değiştirildi: ${prev} → ${engine}`);
    res.json({
      status:       'success',
      prev,
      activeEngine: _activeEngine,
      message:      `Motor "${engine}" olarak ayarlandı.`,
    });
  });

  // ────────────────────────────────────────────────────────
  // GET /ai/compare — Aynı soruyu her iki motora sor, karşılaştır
  // Query: ?q=soru
  // ────────────────────────────────────────────────────────
  app.get('/ai/compare', async (req, res) => {
    const { q = 'Merhaba, nasılsın?' } = req.query;

    const results = { ollama: null, turkish: null };

    // Ollama
    try {
      const enriched = brain?.enrichPrompt?.(q) ?? q;
      const r = await _callOllama(axios, enriched, `compare_${Date.now()}`, {}, {});
      results.ollama = r;
    } catch (e) {
      results.ollama = `HATA: ${e.message}`;
    }

    // Turkish AI
    try {
      const healthy = await _checkTurkishAiHealth(axios);
      if (healthy) {
        results.turkish = await _callTurkishAi(axios, q, `compare_${Date.now()}`, {});
      } else {
        results.turkish = 'Turkish AI çalışmıyor.';
      }
    } catch (e) {
      results.turkish = `HATA: ${e.message}`;
    }

    res.json({ status: 'success', query: q, results });
  });

  // ── Yükleme logu ──────────────────────────────────────
  console.log('🤖 Turkish AI Router yüklendi. Endpoint\'ler:');
  console.log(`  POST /ai/ask          → Hibrit (otomatik seçer) [engine=auto|ollama|turkish]`);
  console.log(`  POST /turkish-ai/ask  → Sadece Turkish AI (port ${TURKISH_AI_URL})`);
  console.log(`  POST /turkish-ai/reset→ Turkish AI konuşmasını sıfırla`);
  console.log(`  POST /turkish-ai/learn→ Geri bildirimle öğret`);
  console.log(`  POST /ai/switch       → Motor seç (auto|ollama|turkish)`);
  console.log(`  GET  /ai/status       → Her iki motor + brain durumu`);
  console.log(`  GET  /ai/compare?q=   → Her iki motoru aynı soruyla karşılaştır`);
}

module.exports = { mountTurkishAiRouter };
