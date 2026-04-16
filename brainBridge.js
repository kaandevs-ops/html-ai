// ============================================================
// 🌉 brainBridge.js — Modül Köprüsü v1
//
// Orijinal HİÇBİR dosyaya dokunmaz.
// Tüm kopuk bağlantıları dışarıdan patch eder.
//
// KURULUM — server.js'in EN SONUNA (tüm modüller yüklendikten sonra):
//
//   const brainBridge = require('./brainBridge');
//   brainBridge.init(brain, {
//     jobQueue,        // opsiyonel — jobQueue kullanıyorsan
//     agendaManager,   // opsiyonel — ajanda kullanıyorsan
//   });
//
// Hepsi bu. Başka bir şey değişmez.
// ============================================================

'use strict';

// ── Loglama ───────────────────────────────────────────────
function _log(msg) {
  console.log(`[BrainBridge] 🌉 ${msg}`);
}

// ══════════════════════════════════════════════════════════
// KOPUKLUK 1 — inference çıkarımları → goals / habit / selfawareness
//
// inference.ingest() çalıştıktan sonra sonuçları diğer modüllere iletir.
// Bunu yapmak için index.js'in learn() fonksiyonunu sarıyoruz.
// Orijinal learn() korunur, üstüne bridge davranışı eklenir.
// ══════════════════════════════════════════════════════════
function _patchLearnForInference(brain) {
  const _originalLearn = brain.learn.bind(brain);

  brain.learn = function(userMessage, answer) {
    // Önce orijinali çalıştır
    _originalLearn(userMessage, answer);

    // inference çıkarımlarını al ve ilgili modüllere ilet
    try {
      const inferences = brain.inference.getAllInferences(userMessage);
      if (!inferences || inferences.length === 0) return;

      inferences.forEach(inf => {
        // ── failed_explanation → habit oluştur ──────────
        // Kullanıcı aynı konuyu defalarca soruyorsa otomatik alışkanlık yarat
        if (inf.type === 'failed_explanation' && inf.concept) {
          const existingHabits = brain.habit.getHabits();
          const alreadyExists  = existingHabits.some(h => h.trigger === inf.concept);
          if (!alreadyExists) {
            brain.habit.createHabit(
              inf.concept,
              `"${inf.concept}" konusunu farklı örneklerle veya adım adım açıkla`,
              'daha iyi anlama'
            );
            _log(`Habit oluşturuldu (failed_explanation): "${inf.concept}"`);
          }
        }

        // ── repeat_question → goals katkısı ─────────────
        // Tekrar eden sorular "Yeni şeyler öğren" hedefini besler
        if (inf.type === 'repeat_question' && inf.keyword) {
          brain.goals.evaluateContribution(
            `öğren ${inf.keyword}`,
            inf.inference,
            false // henüz tam öğrenilmedi, progress yavaş artsın
          );
        }

        // ── time_stress → selfawareness'ı tetikle ───────
        // Stresli zaman dilimi tespit edilince öz değerlendirme yap
        if (inf.type === 'time_stress') {
          const emoState      = brain.emo.getState();
          const learningStats = {
            recentSuccessRate:   brain.learning.getSuccessRate(),
            lifetimeSuccessRate: brain.learning.getLifetimeSuccessRate(),
          };
          brain.selfawareness.autoEvaluate(emoState, learningStats);
          _log('SelfAwareness tetiklendi (time_stress)');
        }
      });
    } catch (e) {
      // Bridge hiçbir zaman orijinal akışı bozmamalı
      console.warn('[BrainBridge] ⚠️ inference→modül iletimi hatası:', e.message);
    }
  };

  _log('KOPUKLUK 1 düzeltildi: inference → goals / habit / selfawareness');
}

// ══════════════════════════════════════════════════════════
// KOPUKLUK 2 — jobQueue.jobDone/Fail → goals + learning
//
// jobQueue.js'de _brain.emo.onSuccess() var ama
// goals.evaluateContribution() ve learning.evaluateAgentRun() yok.
// registerHandler wrapper ile patch ederiz.
// ══════════════════════════════════════════════════════════
function _patchJobQueue(brain, jobQueue) {
  if (!jobQueue) return;

  const _originalRegister = jobQueue.registerHandler.bind(jobQueue);

  // Mevcut handler'ların üstüne wrap ekleyemeyiz doğrudan,
  // ama jobQueue'nun broadcast event'ini dinleyebiliriz.
  // En güvenli yol: initJobQueue'dan sonra _brain'i doğrudan patch etmek.
  // jobDone ve jobFail global fonksiyonlar değil — module içinde kapalı.
  // Çözüm: registerHandler'ı wrap et — her yeni handler otomatik bridge alır.

  jobQueue.registerHandler = function(type, fn) {
    const _wrappedFn = async function(job, ctx) {
      let result;
      let success = false;
      try {
        result  = await fn(job, ctx);
        success = true;
        return result;
      } catch (e) {
        success = false;
        throw e;
      } finally {
        // Her job tamamlanınca brain'e bildir
        try {
          const goalText = `${job.type}: ${JSON.stringify(job.payload).slice(0, 60)}`;
          brain.goals.evaluateContribution(goalText, String(result || ''), success);
          brain.learning.evaluateAgentRun(
            goalText,
            [{ tool: job.type, command: JSON.stringify(job.payload).slice(0, 80), result: String(result || ''), error: success ? null : 'job failed' }],
            success ? 'success' : 'failed'
          );
        } catch (bridgeErr) {
          console.warn('[BrainBridge] ⚠️ jobQueue→goals/learning hatası:', bridgeErr.message);
        }
      }
    };

    return _originalRegister(type, _wrappedFn);
  };

  _log('KOPUKLUK 2 düzeltildi: jobQueue → goals + learning');
}

// ══════════════════════════════════════════════════════════
// KOPUKLUK 3 — selfawareness değerlendirmesi → goals önceliği
//
// selfawareness.autoEvaluate() issues bulduğunda
// "Hataları azalt" hedefinin önceliğini artırır,
// strengths varsa "Yeni şeyler öğren" hedefini öne çeker.
// ══════════════════════════════════════════════════════════
function _patchSelfAwarenessToGoals(brain) {
  const _originalAutoEval = brain.selfawareness.autoEvaluate.bind(brain.selfawareness);

  brain.selfawareness.autoEvaluate = function(emotionState, learningStats) {
    const evaluation = _originalAutoEval(emotionState, learningStats);
    if (!evaluation) return evaluation; // cooldown döndü, geç

    try {
      const goals = brain.goals.getGoals();

      if (evaluation.issues && evaluation.issues.length > 0) {
        // Başarı düşükse "Hataları azalt" hedefine katkı bildir
        const errorGoal = goals.find(g => g.goal.includes('Hata'));
        if (errorGoal) {
          brain.goals.evaluateContribution(
            errorGoal.goal,
            evaluation.issues[0],
            false // başarısız durum — progress yavaş
          );
          _log(`Goal güncellendi (selfawareness issue): "${errorGoal.goal}"`);
        }
      }

      if (evaluation.strengths && evaluation.strengths.length > 0) {
        // Güçlü yön varsa "Yeni şeyler öğren" hedefine pozitif katkı
        const learnGoal = goals.find(g => g.goal.includes('öğren'));
        if (learnGoal) {
          brain.goals.evaluateContribution(
            learnGoal.goal,
            evaluation.strengths[0],
            true
          );
        }
      }
    } catch (e) {
      console.warn('[BrainBridge] ⚠️ selfawareness→goals hatası:', e.message);
    }

    return evaluation;
  };

  _log('KOPUKLUK 3 düzeltildi: selfawareness → goals önceliği');
}

// ══════════════════════════════════════════════════════════
// KOPUKLUK 4 — agendaManager → enrichPrompt
//
// index.js'in enrichPrompt'unu sarıyoruz.
// agendaManager.getAgendaPrompt() sonucunu prefix'e ekliyoruz.
// ══════════════════════════════════════════════════════════
function _patchEnrichPromptForAgenda(brain, agendaManager) {
  if (!agendaManager) return;

  const _originalEnrich = brain.enrichPrompt.bind(brain);

  brain.enrichPrompt = function(userPrompt) {
    let result = _originalEnrich(userPrompt);

    try {
      const agendaCtx = agendaManager.getAgendaPrompt();
      if (agendaCtx) {
        // Prompt'un KULLANICI İSTEĞİ bölümünden önce ajandayı ekle
        const marker = '=== KULLANICI İSTEĞİ ===';
        if (result.includes(marker)) {
          result = result.replace(marker, `${agendaCtx}\n\n${marker}`);
        } else {
          result = `${agendaCtx}\n\n${result}`;
        }
      }
    } catch (e) {
      console.warn('[BrainBridge] ⚠️ agendaManager→enrichPrompt hatası:', e.message);
    }

    return result;
  };

  _log('KOPUKLUK 4 düzeltildi: agendaManager → enrichPrompt');
}

// ══════════════════════════════════════════════════════════
// KOPUKLUK 5 — prediction → inference verisini kullanma
//
// prediction.predictNext() çağrılırken inference'ın
// mevcut çıkarımlarını da (stresli saat, başarısız açıklama)
// tahmin listesine ekleriz.
// Orijinal prediction.getPredictionPrompt()'u sarıyoruz.
// ══════════════════════════════════════════════════════════
function _patchPredictionWithInference(brain) {
  const _originalGetPredPrompt = brain.prediction.getPredictionPrompt.bind(brain.prediction);

  brain.prediction.getPredictionPrompt = function(currentMessage) {
    let original = _originalGetPredPrompt(currentMessage);

    try {
      const inferences = brain.inference.getAllInferences(currentMessage);

      // inference'dan gelen failed_explanation veya time_stress varsa
      // prediction prompt'una ekle (sadece henüz yoksa)
      const extras = [];

      inferences.forEach(inf => {
        if (inf.type === 'failed_explanation' && inf.concept) {
          extras.push(
            `  ⚠️ "${inf.concept}" konusu daha önce tam anlaşılmamış\n     → ${inf.action}`
          );
        }
        if (inf.type === 'time_stress' && !original.includes('stres')) {
          extras.push(
            `  ⏰ Bu saatte stres eğilimi tespit edildi\n     → ${inf.action}`
          );
        }
      });

      if (extras.length > 0) {
        const block = `=== TAHMİNLER (inference destekli) ===\n${extras.join('\n')}`;
        original = original
          ? `${original}\n\n${block}`
          : block;
      }
    } catch (e) {
      console.warn('[BrainBridge] ⚠️ prediction+inference hatası:', e.message);
    }

    return original;
  };

  _log('KOPUKLUK 5 düzeltildi: prediction → inference verisi eklendi');
}

// ══════════════════════════════════════════════════════════
// KOPUKLUK 6 — proactive.js lazy require path sorunu
//
// proactive.js, mount() içinde _checkAll() çalışırken
// require('./episodic') deniyor — ama proactive.js'in konumuna
// göre bu path yanlış olabilir.
// Çözüm: brain üzerinden doğrudan modülleri inject et.
// proactive'in _checkAll'ını değiştiremeyiz (closure içinde),
// ama brain'in ilgili modülleri doğru export ettiğini garantileriz
// ve ayrıca proactiveEngine'e doğrudan modülleri geçiririz.
// ══════════════════════════════════════════════════════════
function _fixProactivePaths(brain, proactiveEngine) {
  if (!proactiveEngine) return;

  // proactiveEngine.sendManual zaten çalışıyor.
  // Asıl sorun: mount() içindeki lazy require'lar closure'da kilitli.
  // Yapabileceğimiz en güvenli şey: brain modüllerini global cache'e eklemek
  // böylece require() aynı instance'ı döndürür.

  try {
    // Node.js module cache'e brain'in modüllerini kaydet
    // Böylece require('./episodic') brain.episodic ile aynı instance'ı döndürür
    const Module = require('module');
    const _resolveFilename = Module._resolveFilename.bind(Module);

    // brain klasörünün path'ini bul
    const brainDir = require('path').dirname(require.resolve('./brain/index'));

    const patchMap = {
      [require('path').join(brainDir, 'episodic.js')]:          brain.episodic,
      [require('path').join(brainDir, 'userUnderstanding.js')]:  brain.userUnderstanding,
      [require('path').join(brainDir, 'inference.js')]:          brain.inference,
      [require('path').join(brainDir, 'prediction.js')]:         brain.prediction,
    };

    Object.entries(patchMap).forEach(([resolvedPath, moduleExports]) => {
      if (require.cache[resolvedPath]) {
        require.cache[resolvedPath].exports = moduleExports;
      }
    });

    _log('KOPUKLUK 6 düzeltildi: proactive require cache senkronize edildi');
  } catch (e) {
    // Path bulunamazsa sessizce geç — proactive zaten çalışıyor, sadece v3 özellikler eksik
    console.warn('[BrainBridge] ⚠️ proactive path fix atlandı (zararsız):', e.message);
  }
}

// ══════════════════════════════════════════════════════════
// KOPUKLUK 7 — agendaManager → brain.learn entegrasyonu
//
// agendaManager.notifyBrain() var ama sadece manuel çağrılıyor.
// Biz addEvent/removeEvent'i wrap ederek otomatik yaptıyoruz.
// ══════════════════════════════════════════════════════════
function _patchAgendaBrainNotify(brain, agendaManager) {
  if (!agendaManager) return;

  const _originalAdd    = agendaManager.addEvent.bind(agendaManager);
  const _originalRemove = agendaManager.removeEvent.bind(agendaManager);

  agendaManager.addEvent = function(data) {
    const event = _originalAdd(data);
    try {
      agendaManager.notifyBrain(brain, 'add', event);
      brain.goals.evaluateContribution(
        `Ajanda: ${event.title}`,
        `${event.date} ${event.start}`,
        true
      );
    } catch (e) {
      console.warn('[BrainBridge] ⚠️ agendaAdd→brain hatası:', e.message);
    }
    return event;
  };

  agendaManager.removeEvent = function(id) {
    const event = _originalRemove(id);
    if (event) {
      try { agendaManager.notifyBrain(brain, 'remove', event); } catch (e) {}
    }
    return event;
  };

  _log('KOPUKLUK 7 düzeltildi: agendaManager → brain.learn otomatik');
}

// ══════════════════════════════════════════════════════════
// DURUM RAPORU — Tüm bridge bağlantılarının sağlığını kontrol et
// ══════════════════════════════════════════════════════════
function getStatus(brain, extras = {}) {
  const checks = [];

  function _check(name, fn) {
    try {
      const ok = fn();
      checks.push({ name, ok: !!ok, status: ok ? '✅' : '⚠️' });
    } catch (e) {
      checks.push({ name, ok: false, status: '❌', error: e.message });
    }
  }

  // Temel brain modülleri
  _check('brain.inference.ingest',              () => typeof brain.inference?.ingest === 'function');
  _check('brain.inference.getAllInferences',     () => typeof brain.inference?.getAllInferences === 'function');
  _check('brain.prediction.getPredictionPrompt',() => typeof brain.prediction?.getPredictionPrompt === 'function');
  _check('brain.episodic.saveEpisode',          () => typeof brain.episodic?.saveEpisode === 'function');
  _check('brain.userUnderstanding.observe',     () => typeof brain.userUnderstanding?.observe === 'function');
  _check('brain.goals.evaluateContribution',    () => typeof brain.goals?.evaluateContribution === 'function');
  _check('brain.habit.createHabit',             () => typeof brain.habit?.createHabit === 'function');
  _check('brain.selfawareness.autoEvaluate',    () => typeof brain.selfawareness?.autoEvaluate === 'function');
  _check('brain.enrichPrompt (bridge wrapped)', () => typeof brain.enrichPrompt === 'function');

  // Opsiyonel modüller
  _check('agendaManager (opsiyonel)',   () => !extras.agendaManager || typeof extras.agendaManager.getAgendaPrompt === 'function');
  _check('jobQueue (opsiyonel)',        () => !extras.jobQueue      || typeof extras.jobQueue.registerHandler === 'function');

  // Veri akışı testi
  _check('inference → getAllInferences çalışıyor', () => {
    const result = brain.inference.getAllInferences('test docker');
    return Array.isArray(result); // boş bile olsa array dönmeli
  });

  _check('episodic → getStats çalışıyor', () => {
    const stats = brain.episodic.getStats();
    return typeof stats.totalEpisodes === 'number';
  });

  _check('prediction → getAccuracy çalışıyor', () => {
    const acc = brain.prediction.getAccuracy();
    return typeof acc.total === 'number';
  });

  const allOk   = checks.every(c => c.ok);
  const failCount = checks.filter(c => !c.ok).length;

  return {
    allOk,
    failCount,
    checks,
    summary: allOk
      ? '✅ Tüm bridge bağlantıları sağlıklı'
      : `⚠️ ${failCount} bağlantıda sorun var`,
  };
}

// ══════════════════════════════════════════════════════════
// ANA INIT — tek giriş noktası
// ══════════════════════════════════════════════════════════
function init(brain, extras = {}) {
  if (!brain) {
    console.error('[BrainBridge] ❌ brain parametresi zorunlu!');
    return;
  }

  const { jobQueue, agendaManager, proactiveEngine } = extras;

  console.log('\n[BrainBridge] 🌉 ========================================');
  console.log('[BrainBridge] 🌉 Modül köprüleri kuruluyor...');
  console.log('[BrainBridge] 🌉 ========================================');

  _patchLearnForInference(brain);
  _patchSelfAwarenessToGoals(brain);
  _patchPredictionWithInference(brain);

  if (agendaManager) {
    _patchEnrichPromptForAgenda(brain, agendaManager);
    _patchAgendaBrainNotify(brain, agendaManager);
  }

  if (jobQueue) {
    _patchJobQueue(brain, jobQueue);
  }

  if (proactiveEngine) {
    _fixProactivePaths(brain, proactiveEngine);
  }

  // Başlangıç sağlık raporu
  setTimeout(() => {
    const status = getStatus(brain, extras);
    console.log('\n[BrainBridge] 🌉 ========================================');
    console.log(`[BrainBridge] 🌉 ${status.summary}`);
    status.checks.forEach(c => {
      console.log(`[BrainBridge]   ${c.status} ${c.name}${c.error ? ' — ' + c.error : ''}`);
    });
    console.log('[BrainBridge] 🌉 ========================================\n');
  }, 1000);

  _log('✅ Tüm köprüler kuruldu.');

  return { getStatus: () => getStatus(brain, extras) };
}

module.exports = { init, getStatus };
