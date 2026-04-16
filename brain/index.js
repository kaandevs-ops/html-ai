// ============================================================
// 🧠 brain/index.js — Tam İnsan Beyni Orkestratörü v4
// server.js'e ekle (en üste): const brain = require('./brain');
// ============================================================

const mem            = require("./memory");
const emo            = require("./emotions");
const attention      = require("./attention");
const learning       = require("./learning");
const reflection     = require("./reflection");
const intuition      = require("./intuition");
const dream          = require("./dream");
const empathy        = require("./empathy");
const goals          = require("./goals");
const personality    = require("./personality");
const stress         = require("./stress");
const association    = require("./association");
const habit          = require("./habit");
const distraction    = require("./distraction");
const selfawareness  = require("./selfawareness");
const userProfile    = require("./userProfile");
// ── v5: Derin biliş modülleri ─────────────────────────────
const episodic          = require("./episodic");
const userUnderstanding = require("./userUnderstanding");
const inference         = require("./inference");
const prediction        = require("./prediction");

// ── Boot raporu ───────────────────────────────────────────
function boot() {
  const stats    = mem.getAll().stats;
  const emoState = emo.getState();
  const rate     = learning.getLifetimeSuccessRate();

  console.log("╔══════════════════════════════════════════╗");
  console.log("║         🧠 BRAIN BOOT v5                  ║");
  console.log(`║  Görev geçmişi: ${String(stats.totalTasks).padEnd(5)} (${stats.successCount}✅ ${stats.failCount}❌)  ║`);
  console.log(`║  Başarı oranı : %${(rate * 100).toFixed(0).padEnd(5)}                    ║`);
  console.log(`║  Duygusal mod : ${(emoState.mood || "NORMAL").padEnd(15)}            ║`);
  console.log(`║  Oturum       : #${stats.sessionCount}                          ║`);
  console.log(`║  Son aktif    : ${(stats.lastActive || "hiç").substring(0, 10).padEnd(10)}                ║`);
  console.log(`║  Episodik     : ${String(episodic.getStats().totalEpisodes).padEnd(5)} konuşma              ║`);
  console.log(`║  Anlama       : ${String(userUnderstanding.getSummary().totalObservations).padEnd(5)} gözlem               ║`);
  console.log("╚══════════════════════════════════════════╝");
}

// ── Prompt zenginleştirme (tüm modüller) ─────────────────
function enrichPrompt(userPrompt) {
  const emoState       = emo.getState();
  const learningStats  = {
    recentSuccessRate:   learning.getSuccessRate(),
    lifetimeSuccessRate: learning.getLifetimeSuccessRate()
  };

  const personalityCtx   = personality.getPersonalityPrompt();
  const stressCtx        = stress.getStressPrompt(emoState);
  const empathyCtx       = empathy.getTonePrompt(userPrompt);
  const moodCtx          = emo.getMoodPrompt();
  const goalCtx          = goals.getGoalPrompt();
  const contextCtx       = reflection.getContextPrompt();
  const dreamCtx         = dream.getDreamPrompt();
  const learningCtx      = learning.buildLearningContext(userPrompt);
  const associationCtx   = association.getAssociationPrompt(userPrompt);
  const habitCtx         = habit.getHabitPrompt();
  const distractionCtx   = distraction.getDistractionPrompt(userPrompt);
  const selfawarenessCtx = selfawareness.getSelfAwarenessPrompt(emoState, learningStats);

  let prefix = "";
  if (personalityCtx)   prefix += personalityCtx   + "\n\n";
  if (stressCtx)        prefix += stressCtx        + "\n\n";
  if (empathyCtx)       prefix += empathyCtx       + "\n\n";
  if (moodCtx)          prefix += moodCtx          + "\n\n";
  if (selfawarenessCtx) prefix += selfawarenessCtx + "\n\n";
  if (goalCtx)          prefix += goalCtx          + "\n\n";
  if (habitCtx)         prefix += habitCtx         + "\n\n";
  if (contextCtx)       prefix += contextCtx       + "\n\n";
  if (associationCtx)   prefix += associationCtx   + "\n\n";
  if (distractionCtx)   prefix += distractionCtx   + "\n\n";
  if (dreamCtx)         prefix += dreamCtx         + "\n\n";
  if (learningCtx)      prefix += learningCtx      + "\n\n";
userProfile.tick(userPrompt);
const userProfileCtx = userProfile.getProfilePrompt();
if (userProfileCtx) prefix += userProfileCtx + "\n\n";

  // ── v5: Episodik bellek — geçmiş konuşmalar ──────────────
  const episodicCtx = episodic.getEpisodicPrompt(userPrompt);
  if (episodicCtx) prefix += episodicCtx + "\n\n";

  // ── v5: Çıkarım motoru — kalıp tespiti ───────────────────
  const inferenceCtx = inference.getInferencePrompt(userPrompt);
  if (inferenceCtx) prefix += inferenceCtx + "\n\n";

  // ── v5: Kullanıcı anlama — inanç & boşluk modeli ─────────
  const understandingCtx = userUnderstanding.getUnderstandingPrompt(userPrompt);
  if (understandingCtx) prefix += understandingCtx + "\n\n";

  // ── v5: Tahmin — bir sonraki ihtiyaç ─────────────────────
  const predictionCtx = prediction.getPredictionPrompt(userPrompt);
  if (predictionCtx) prefix += predictionCtx + "\n\n";

  if (!prefix.trim()) return userPrompt;
  return `${prefix}=== KULLANICI İSTEĞİ ===\n${userPrompt}`;
}

// ── Agent döngüsü tamamlandı ──────────────────────────────
function onAgentDone(goal, steps = [], status = "success") {
  const success = (status === "success" || status === "done");

  if (success) {
    emo.onSuccess();
  } else {
    const hasCritical = steps.some(s =>
      s.error && (
        s.error.includes("PERMISSION") ||
        s.error.includes("EACCES") ||
        s.error.includes("FATAL")
      )
    );
    emo.onFailure(hasCritical);
  }

  learning.evaluateAgentRun(goal, steps, status);
  goals.evaluateContribution(goal, "", success);
  attention.tick();

  // Öz farkındalık otomatik değerlendirme
  const emoState = emo.getState();
  selfawareness.autoEvaluate(emoState, {
    recentSuccessRate:   learning.getSuccessRate(),
    lifetimeSuccessRate: learning.getLifetimeSuccessRate()
  });

  console.log(`[Brain] 🔄 onAgentDone | "${goal.substring(0, 40)}" | ${success ? "✅" : "❌"} | ${emo.getSummary()}`);
}

// ── Başarılı cevabı öğren ─────────────────────────────────
function learn(userMessage, answer) {
  learning.learnResponse(userMessage, answer);
  mem.recordSuccess("ollama", userMessage.substring(0, 80), answer.substring(0, 80));
  reflection.updateContext(userMessage, answer);
  empathy.trackUserEmotion(userMessage);
  goals.evaluateContribution(userMessage, answer, true);
  personality.evolve(userMessage, answer, empathy.detectEmotion(userMessage).emotion);
  association.extractAndAssociate(userMessage);
  association.extractAndAssociate(answer);
  habit.checkTrigger(userMessage);
  userProfile.onInteraction(userMessage, answer, empathy.detectEmotion(userMessage));
  // ── v5: Derin biliş güncelle ─────────────────────────────
  const emotionNow = empathy.detectEmotion(userMessage);
  episodic.saveEpisode(userMessage, answer, emo.getState());
  userUnderstanding.observe(userMessage, answer, emotionNow);
  inference.ingest(userMessage, answer, emo.getState());
  prediction.recordOutcome(userMessage, answer, emotionNow);
  // ─────────────────────────────────────────────────────────
  emo.onSuccess();
}

// ── Hata bildirimi ────────────────────────────────────────
function onError(tool, command, errorMsg) {
  mem.recordFailure(tool, command, errorMsg);
  distraction.noteAside(`${tool} hatası: ${errorMsg.substring(0, 60)}`, 0.7);
  emo.onFailure(false);
}

// ── Refleks kontrolü ──────────────────────────────────────
function checkReflex(userMessage) {
  return learning.checkReflex(userMessage);
}

// ── Sezgi ─────────────────────────────────────────────────
function predict(userMessage) {
  return intuition.predict(userMessage);
}

// ── Görev planla ──────────────────────────────────────────
function schedule(name, handler, priority = 5, type = "immediate") {
  emo.onNewTask();
  return attention.addTask(name, handler, priority, type);
}

// ── Tam durum ─────────────────────────────────────────────
function getStatus() {
  const stats    = mem.getAll().stats;
  const emoState = emo.getState();
  const learningStats = {
    recentSuccessRate:   learning.getSuccessRate(),
    lifetimeSuccessRate: learning.getLifetimeSuccessRate()
  };

  return {
    emotions:      emoState,
    stress:        stress.getStrategy(emoState),
    attention:     attention.getStatus(),
    memory: {
      stats,
      semanticCount:  mem.getAll().semanticMemory.length,
      failureCount:   mem.getAll().failurePatterns.length,
      successCount:   mem.getAll().successPatterns.length,
      cacheSize:      Object.keys(mem.getAll().commandCache).length
    },
    learning:      learningStats,
    goals:         goals.getGoals(),
    personality:   personality.getPersonality(),
    context:       reflection.getContext(),
    intuition:     intuition.getSummary(),
    dreams:        dream.getRecentDreams(3),
    userEmotion:   empathy.getUserEmotionProfile(),
    habits:        habit.getHabits(),
    distraction:   distraction.getStatus(),
    selfawareness: selfawareness.getLastEvaluation(),
    userProfile: userProfile.getProfile(),
    // ── v5 ────────────────────────────────────────────────
    episodic:          episodic.getStats(),
    userUnderstanding: userUnderstanding.getSummary(),
    inference:         inference.getStats(),
    prediction:        prediction.getStats(),
  };
}

// ── Server.js entegrasyon patchi ──────────────────────────
function patchServer(app, axiosInstance) {
  if (!app || !axiosInstance) {
    console.warn("[Brain] ⚠️ patchServer: app veya axios eksik, patch atlandı.");
    return;
  }

  const _originalStack = app._router?.stack || [];
  let ollamaRoute = null;

  _originalStack.forEach(layer => {
    if (layer.route?.path === "/ollama/ask" && layer.route.methods.post) {
      ollamaRoute = layer.route;
    }
  });

  if (ollamaRoute) {
    console.log("[Brain] ✅ /ollama/ask endpoint'i bulundu — server.js zaten brain fonksiyonlarını kullanıyor.");
  } else {
    console.log("[Brain] ℹ️ /ollama/ask direkt server.js içinde tanımlı — brain entegrasyonu aktif.");
  }

  app.get("/brain/ask-debug", (req, res) => {
    const { q = "" } = req.query;
    const reflex  = checkReflex(q);
    const context = learning.buildLearningContext(q);
    const mood    = emo.getMoodPrompt();
    res.json({
      status:       "success",
      query:        q,
      reflexHit:    !!reflex,
      reflexAnswer: reflex || null,
      moodPrompt:   mood,
      learningCtx:  context.substring(0, 500) + (context.length > 500 ? "..." : ""),
      emotions:     emo.getState()
    });
  });

  console.log("[Brain] 🔌 patchServer tamamlandı. Yeni endpoint: GET /brain/ask-debug?q=...");

  // ── v5: Yeni debug/introspect endpoint'leri ───────────────
  app.get("/brain/episodes", (req, res) => {
    const { q = "", n = "10" } = req.query;
    if (q) {
      res.json({ status: "success", results: episodic.searchEpisodes(q, parseInt(n)) });
    } else {
      res.json({ status: "success", stats: episodic.getStats(), recent: episodic.getAllEpisodes(parseInt(n)) });
    }
  });

  app.get("/brain/understanding", (req, res) => {
    res.json({ status: "success", model: userUnderstanding.getSummary() });
  });

  app.get("/brain/inferences", (req, res) => {
    const { q = "" } = req.query;
    res.json({ status: "success", inferences: inference.getAllInferences(q), stats: inference.getStats() });
  });

  app.get("/brain/predictions", (req, res) => {
    const { q = "" } = req.query;
    res.json({ status: "success", predictions: prediction.predictNext(q), accuracy: prediction.getAccuracy() });
  });
}

// ── Boot ──────────────────────────────────────────────────
boot();

// ── Selfawareness başlangıç değerlendirmesi ──────────────
// Server başladığında bir kez çalıştır, sonra onAgentDone ile devam eder
setTimeout(() => {
  try {
    const emoState = emo.getState();
    const learningStats = {
      recentSuccessRate:   learning.getSuccessRate(),
      lifetimeSuccessRate: learning.getLifetimeSuccessRate()
    };
    selfawareness.evaluate(emoState, learningStats);
    console.log("[Brain] 🪞 Başlangıç öz değerlendirmesi tamamlandı");
  } catch(e) {}
}, 3000);

// Her 10 dakikada bir otomatik öz değerlendirme
setInterval(() => {
  try {
    const emoState = emo.getState();
    const learningStats = {
      recentSuccessRate:   learning.getSuccessRate(),
      lifetimeSuccessRate: learning.getLifetimeSuccessRate()
    };
    selfawareness.autoEvaluate(emoState, learningStats);
  } catch(e) {}
}, 10 * 60 * 1000);

// ── Export ────────────────────────────────────────────────
module.exports = {
  enrichPrompt,
  onAgentDone,
  checkReflex,
  learn,
  onError,
  schedule,
  getStatus,
  predict,
  patchServer,

  mem,
  emo,
  attention,
  learning,
  reflection,
  intuition,
  dream,
  empathy,
  goals,
  personality,
  stress,
  association,
  habit,
  distraction,
  selfawareness,
  userProfile,
  // ── v5 ────────────────────────────────────────────────
  episodic,
  userUnderstanding,
  inference,
  prediction,
};