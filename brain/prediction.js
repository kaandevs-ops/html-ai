// ============================================================
// 🔮 brain/prediction.js — Tahmin Motoru v1
// Kullanıcının bir sonraki sorusunu, duygusunu ve
// konunun ne kadar süreceğini tahmin eder.
// Her tahmin kaydedilir → gerçek çıktıyla karşılaştırılır
// → zamanla doğruluk artar.
// ============================================================
"use strict";

const fs   = require("fs");
const path = require("path");

const FILE = path.join(__dirname, "..", "predictions.json");

const DEFAULT = {
  // A sorusundan sonra ne geldi?
  // { "docker_deploy": [{ keywords[], nextMsg, count }] }
  followUpPatterns: {},

  // Hangi kelime hangi duyguyu tetikledi?
  // { "docker": { stressed:3, happy:1, neutral:5 } }
  emotionTriggers: {},

  // Bir konu kaç turda çözüldü?
  // { "docker": { totalTurns:20, samples:5, avgTurns:4.0 } }
  topicDifficulty: {},

  // Tahmin log'u (doğruluk takibi)
  log: [],  // [{ predicted, actual, correct, ts }]

  meta: { totalPredictions:0, correctPredictions:0, lastUpdated:null }
};

let _d            = _load();
let _timer        = null;
let _pending      = null;   // doğrulama bekleyen son tahmin
let _prevKw       = [];
let _prevEmotion  = "neutral";
let _topicTurns   = {};     // { topicKey: turSayısı } — aktif konu takibi

function _load() {
  try {
    if (fs.existsSync(FILE)) return { ...DEFAULT, ...JSON.parse(fs.readFileSync(FILE, "utf-8")) };
  } catch(e) {}
  return JSON.parse(JSON.stringify(DEFAULT));
}

function _save() {
  _d.meta.lastUpdated = new Date().toISOString();
  if (_timer) clearTimeout(_timer);
  _timer = setTimeout(()=>{
    try { fs.writeFileSync(FILE, JSON.stringify(_d, null, 2)); } catch(e) {}
  }, 2000);
}

// ── Yardımcılar ───────────────────────────────────────────
const _STOP = new Set(["bir","bu","şu","ve","ile","de","da","ki","ne","mi","nasıl","neden","için","ama","çok","the","is","are","that"]);
function _kw(text) {
  return text.toLowerCase().replace(/[^a-züçğışöı\s]/g," ")
    .split(/\s+/).filter(w=>w.length>3&&!_STOP.has(w)).slice(0,6);
}
function _topicKey(kw) { return kw.slice(0,2).join("_") || "genel"; }

// ══════════════════════════════════════════════════════════
// KAYIT — Her konuşmadan öğren
// ══════════════════════════════════════════════════════════
function recordOutcome(userMessage, answer, emotionResult = {}) {
  if (!userMessage) return;

  const kw       = _kw(userMessage);
  const topicKey = _topicKey(kw);
  const emotion  = emotionResult?.emotion || "neutral";

  // ── 1. Takip kalıpları ────────────────────────────────
  if (_prevKw.length > 0) {
    const prevKey = _topicKey(_prevKw);
    if (!_d.followUpPatterns[prevKey]) _d.followUpPatterns[prevKey] = [];
    const patterns = _d.followUpPatterns[prevKey];
    const ex = patterns.find(p => {
      const overlap = p.keywords.filter(k=>kw.includes(k)).length;
      return overlap >= Math.max(1, kw.length * 0.4);
    });
    if (ex) { ex.count++; }
    else {
      patterns.push({ keywords:kw, nextMsg:userMessage.slice(0,60), count:1 });
      if (patterns.length > 20) patterns.shift();
    }
  }

  // ── 2. Duygu tetikleyicileri ──────────────────────────
  kw.forEach(w => {
    if (!_d.emotionTriggers[w])
      _d.emotionTriggers[w] = { stressed:0, angry:0, happy:0, confused:0, neutral:0, sad:0 };
    _d.emotionTriggers[w][emotion] = (_d.emotionTriggers[w][emotion]||0) + 1;
  });

  // ── 3. Konu zorluğu (kaç tur sürdü?) ─────────────────
  if (!_topicTurns[topicKey]) _topicTurns[topicKey] = 0;
  _topicTurns[topicKey]++;

  // Konu değiştiyse önceki konuyu kaydet
  const prevKey = _topicKey(_prevKw);
  if (_prevKw.length > 0 && prevKey !== topicKey && _topicTurns[prevKey] > 0) {
    const turns = _topicTurns[prevKey];
    if (!_d.topicDifficulty[prevKey])
      _d.topicDifficulty[prevKey] = { totalTurns:0, samples:0, avgTurns:0 };
    const td = _d.topicDifficulty[prevKey];
    td.totalTurns += turns; td.samples++;
    td.avgTurns = +(td.totalTurns / td.samples).toFixed(1);
    _topicTurns[prevKey] = 0;
  }

  // ── 4. Tahmin doğrulama ───────────────────────────────
  if (_pending) {
    const overlap = (_pending.predictedKeywords||[]).filter(k=>kw.includes(k)).length;
    const correct = overlap >= Math.max(1, (_pending.predictedKeywords||[]).length * 0.4);
    _d.meta.totalPredictions++;
    if (correct) _d.meta.correctPredictions++;
    _d.log.unshift({ predicted:_pending.text, actual:userMessage.slice(0,60), correct, ts:new Date().toISOString() });
    if (_d.log.length > 60) _d.log.pop();
    _pending = null;
  }

  _prevKw      = kw;
  _prevEmotion = emotion;
  _save();
}

// ══════════════════════════════════════════════════════════
// TAHMİN
// ══════════════════════════════════════════════════════════
function predictNext(currentMessage) {
  const kw       = _kw(currentMessage);
  const topicKey = _topicKey(kw);
  const preds    = [];

  // ── Episodik hafızadan bağlam çek (YENİ) ─────────────
  // Geçmiş konuşmalardan bu konuda ne oldu, tahmine ekle
  let episodicContext = [];
  try {
    const episodic = require("./episodic");
    episodicContext = episodic.searchEpisodes(currentMessage, 3);
  } catch(e) {}

  // Episodik geçmişten örüntü çıkar
  if (episodicContext.length > 0) {
    const positiveEps = episodicContext.filter(ep =>
      ep.sentiment === "positive" ||
      /teşekkür|harika|oldu|hallettim|çözdüm/i.test(ep.answer || "")
    );
    const negativeEps = episodicContext.filter(ep =>
      ep.sentiment === "negative" ||
      /hata|sorun|olmadı|çalışmıyor/i.test(ep.answer || "")
    );

    const successRate = episodicContext.length > 0
      ? positiveEps.length / episodicContext.length
      : 0.5;

    if (episodicContext.length >= 2) {
      preds.push({
        type:              "episodic_pattern",
        text:              `Bu konuyu ${episodicContext.length} kez konuştuk. Başarı oranı: %${Math.round(successRate * 100)}`,
        predictedKeywords: kw,
        confidence:        +Math.min(0.85, episodicContext.length * 0.15).toFixed(2),
        action:            successRate > 0.6
          ? "Geçmişte başarılı olduk, aynı yaklaşımı kullan"
          : "Geçmişte sorun yaşandı, farklı bir yol dene",
        episodicCount:     episodicContext.length,
        successRate,
      });
    }
  }

  // ── Takip kalıbı tahmini ─────────────────────────────
  const followUps = _d.followUpPatterns[topicKey];
  if (followUps && followUps.length > 0) {
    const best = followUps.sort((a,b)=>b.count-a.count)[0];
    if (best.count >= 2) {
      preds.push({
        type:               "follow_up",
        text:               `Kullanıcı muhtemelen şunu soracak: "${best.nextMsg}"`,
        predictedKeywords:  best.keywords,
        confidence:         +Math.min(0.9, best.count * 0.2).toFixed(2),
        action:             "Bu soruya da hazırlıklı ol, cevabında sezdir",
      });
    }
  }

  // ── Duygu tahmini ────────────────────────────────────
  const emotionScores = {};
  kw.forEach(w => {
    const triggers = _d.emotionTriggers[w];
    if (!triggers) return;
    Object.entries(triggers).forEach(([e,c])=>{
      emotionScores[e] = (emotionScores[e]||0) + c;
    });
  });
  const total = Object.values(emotionScores).reduce((s,c)=>s+c, 0);
  if (total >= 5) {
    const sorted  = Object.entries(emotionScores).sort((a,b)=>b[1]-a[1]);
    const [topEmo, topC] = sorted[0];
    const conf = topC / total;
    if (conf >= 0.45 && topEmo !== "neutral") {
      const tones = {
        stressed: "Sabırlı ve hızlı ol, uzun açıklamalar yapma",
        angry:    "Çok kısa, direkt ve çözüm odaklı cevap ver",
        confused: "Adım adım ve örneklerle açıkla",
        happy:    "Samimi ve detaylı olabilirsin",
        sad:      "Cesaretlendirici ol, küçük adımlar öner",
      };
      preds.push({
        type:               "emotion_prediction",
        text:               `Bu konuda kullanıcı genellikle "${topEmo}" hissediyor`,
        confidence:         +conf.toFixed(2),
        emotion:            topEmo,
        action:             tones[topEmo] || "Normal ton kullan",
        predictedKeywords:  [],
      });
    }
  }

  // ── Konu zorluğu tahmini ─────────────────────────────
  const td = _d.topicDifficulty[topicKey];
  if (td && td.samples >= 3 && td.avgTurns >= 4) {
    preds.push({
      type:               "difficulty",
      text:               `"${topicKey}" konusu ortalama ${td.avgTurns} tur alıyor`,
      confidence:         0.7,
      action:             "İlk cevapta kapsamlı açıkla, kullanıcıyı geri döndürme",
      predictedKeywords:  [],
    });
  }

  // İlk tahmini doğrulama için kaydet
  if (preds.length > 0) _pending = preds[0];

  return preds;
}

// ══════════════════════════════════════════════════════════
// LLM PROMPT
// ══════════════════════════════════════════════════════════
function getPredictionPrompt(currentMessage) {
  const preds  = predictNext(currentMessage);
  const strong = preds.filter(p => p.confidence >= 0.5);
  if (strong.length === 0) return "";
  const ICONS = { follow_up:"🔮", emotion_prediction:"💭", difficulty:"📊" };
  const lines = strong.map(p => `  ${ICONS[p.type]||"•"} ${p.text}\n     → ${p.action}`);
  return `=== TAHMİNLER ===\n${lines.join("\n")}`;
}

function getAccuracy() {
  const { totalPredictions:t, correctPredictions:c } = _d.meta;
  return { total:t, correct:c, rate: t===0 ? 0 : +(c/t).toFixed(2) };
}

function getStats() {
  const hardest = Object.entries(_d.topicDifficulty)
    .sort((a,b)=>b[1].avgTurns-a[1].avgTurns).slice(0,5)
    .map(([k,v])=>`${k}:${v.avgTurns}tur`);
  return { accuracy:getAccuracy(), hardestTopics:hardest };
}

process.on("SIGINT",  ()=>{ try{fs.writeFileSync(FILE,JSON.stringify(_d,null,2));}catch(e){} });
process.on("SIGTERM", ()=>{ try{fs.writeFileSync(FILE,JSON.stringify(_d,null,2));}catch(e){} });

console.log(`[Prediction] 🔮 Yüklendi — ${_d.meta.totalPredictions} tahmin`);

module.exports = { recordOutcome, predictNext, getPredictionPrompt, getAccuracy, getStats };