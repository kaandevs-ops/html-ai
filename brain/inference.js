// ============================================================
// 🔍 brain/inference.js — Gerçek Çıkarım Motoru v1
// Tüm konuşmalardan kalıp çıkarır:
//  • Hangi saatte stresli olunuyor
//  • Hangi kelime defalarca sorulmuş (açıklama yetmemiş)
//  • Aynı gün aynı konu → bir önceki cevap yetmedi
//  • Konuşma zinciri → A'dan sonra B geliyor
// ============================================================
"use strict";

const fs   = require("fs");
const path = require("path");

const FILE = path.join(__dirname, "..", "inferences.json");

const DEFAULT = {
  // { "Cuma-akşam": { stressSum, count, avgStress } }
  timeEmotionMap: {},
  // { "docker": { count, firstDate, lastDate, contexts[] } }
  repeatQuestions: {},
  // Aynı gün aynı konu tekrar soruldu → açıklama başarısız
  // { "docker": { count, lastSeen } }
  failedExplanations: {},
  // Konuşma zincirleri (son 100)
  // [{ from:[], to:[], date, timeKey }]
  contextChains: [],
  meta: { totalIngested: 0, lastUpdated: null }
};

let _d    = _load();
let _timer = null;
let _prevKw   = [];
let _prevDate = null;

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
const _DAYS = ["Pazar","Pazartesi","Salı","Çarşamba","Perşembe","Cuma","Cumartesi"];

function _kw(text) {
  return text.toLowerCase().replace(/[^a-züçğışöı\s]/g," ")
    .split(/\s+/).filter(w=>w.length>3 && !_STOP.has(w)).slice(0,6);
}

function _timeKey() {
  const now = new Date();
  const h   = now.getHours();
  const period = h<12?"sabah":h<17?"öğleden-sonra":h<21?"akşam":"gece";
  return `${_DAYS[now.getDay()]}-${period}`;
}

function _today() { return new Date().toISOString().split("T")[0]; }

function _jaccard(a, b) {
  const sa = new Set(a), sb = new Set(b);
  let inter = 0;
  sa.forEach(w=>{ if(sb.has(w)) inter++; });
  const union = sa.size + sb.size - inter;
  return union === 0 ? 0 : inter/union;
}

// ══════════════════════════════════════════════════════════
// VERİ YUTMA
// ══════════════════════════════════════════════════════════
function ingest(userMessage, answer, emotionState = {}) {
  if (!userMessage) return;
  _d.meta.totalIngested++;

  const timeKey = _timeKey();
  const today   = _today();
  const kw      = _kw(userMessage);

  // ── 1. Zaman-Duygu haritası ───────────────────────────
  const stress = (emotionState.fatigue||0)*0.4
               + (emotionState.frustration||0)*0.35
               + (emotionState.urgency||0)*0.25;
  if (!_d.timeEmotionMap[timeKey])
    _d.timeEmotionMap[timeKey] = { stressSum:0, count:0, avgStress:0 };
  const tem = _d.timeEmotionMap[timeKey];
  tem.stressSum += stress; tem.count++;
  tem.avgStress  = +( tem.stressSum / tem.count ).toFixed(2);

  // ── 2. Tekrar eden sorular ────────────────────────────
  kw.forEach(w => {
    if (!_d.repeatQuestions[w])
      _d.repeatQuestions[w] = { count:0, firstDate:today, lastDate:null, contexts:[] };
    const rq = _d.repeatQuestions[w];
    rq.count++;
    rq.lastDate = today;
    rq.contexts.unshift(userMessage.slice(0,60));
    if (rq.contexts.length > 5) rq.contexts.pop();
  });

  // ── 3. Başarısız açıklama (aynı gün aynı konu) ───────
  if (_prevKw.length > 0 && today === _prevDate) {
    const sim = _jaccard(kw, _prevKw);
    if (sim > 0.4) {
      const concept = _prevKw[0];
      if (!_d.failedExplanations[concept])
        _d.failedExplanations[concept] = { count:0, lastSeen:null };
      _d.failedExplanations[concept].count++;
      _d.failedExplanations[concept].lastSeen = today;
      console.log(`[Inference] ⚠️ Başarısız açıklama: "${concept}"`);
    }
  }

  // ── 4. Bağlam zinciri ─────────────────────────────────
  if (_prevKw.length > 0) {
    _d.contextChains.unshift({ from:_prevKw.slice(0,3), to:kw.slice(0,3), date:today, timeKey });
    if (_d.contextChains.length > 100) _d.contextChains.pop();
  }

  _prevKw   = kw;
  _prevDate = today;
  _save();
}

// ══════════════════════════════════════════════════════════
// ÇIKARIMLAR
// ══════════════════════════════════════════════════════════

function inferTimeStress() {
  const entry = _d.timeEmotionMap[_timeKey()];
  if (!entry || entry.count < 3 || entry.avgStress <= 0.45) return null;
  return {
    type:      "time_stress",
    inference: `Bu zaman diliminde (${_timeKey()}) kullanıcı genellikle stresli olur`,
    avgStress: entry.avgStress,
    action:    "Daha kısa ve net cevaplar ver, uzun açıklamalardan kaçın",
  };
}

function inferRepeatPattern(currentMessage) {
  const kw = _kw(currentMessage);
  let worst = null;
  kw.forEach(w => {
    const rq = _d.repeatQuestions[w];
    if (rq && rq.count >= 3) {
      if (!worst || rq.count > worst.count) worst = { keyword:w, ...rq };
    }
  });
  if (!worst) return null;
  const daysSpread = worst.lastDate && worst.firstDate
    ? Math.round((new Date(worst.lastDate)-new Date(worst.firstDate))/86400000) : 0;
  return {
    type:      "repeat_question",
    inference: `Kullanıcı "${worst.keyword}" konusunu ${worst.count} kez sordu (${daysSpread} günde)`,
    action:    "Farklı bir açıklama yöntemi dene — önceki yöntem yetmemiş olabilir. Örnek veya kod kullan.",
  };
}

function inferFailedExplanation(currentMessage) {
  const kw = _kw(currentMessage);
  for (const w of kw) {
    const fe = _d.failedExplanations[w];
    if (fe && fe.count >= 2) {
      return {
        type:      "failed_explanation",
        inference: `"${w}" konusunu daha önce ${fe.count} kez açıkladım ama tam anlaşılmadı`,
        action:    "Bu sefer gerçek dünya örneği, benzetme veya çalışan kod ver",
        concept:   w,
      };
    }
  }
  return null;
}

function inferNextContext(currentMessage) {
  const kw = _kw(currentMessage);
  if (kw.length === 0 || _d.contextChains.length < 5) return null;
  const succ = {};
  _d.contextChains.forEach(chain => {
    const ov = _jaccard(chain.from, kw);
    if (ov > 0.3) chain.to.forEach(w => { succ[w] = (succ[w]||0) + ov; });
  });
  const sorted = Object.entries(succ)
    .filter(([w])=>!kw.includes(w))
    .sort((a,b)=>b[1]-a[1]).slice(0,2);
  if (sorted.length === 0 || sorted[0][1] < 0.5) return null;
  return {
    type:       "next_context",
    inference:  `Bu konuşmadan sonra muhtemelen "${sorted[0][0]}" hakkında soru gelecek`,
    confidence: +Math.min(sorted[0][1],1.0).toFixed(2),
    action:     "İlk cevapta bağlantılı konuya da hafifçe değin",
  };
}

function getAllInferences(currentMessage) {
  return [
    inferTimeStress(),
    inferRepeatPattern(currentMessage),
    inferFailedExplanation(currentMessage),
    inferNextContext(currentMessage),
  ].filter(Boolean);
}

// ══════════════════════════════════════════════════════════
// LLM PROMPT
// ══════════════════════════════════════════════════════════
function getInferencePrompt(currentMessage) {
  const infs = getAllInferences(currentMessage);
  if (infs.length === 0) return "";
  const ICONS = { time_stress:"⏰", repeat_question:"🔁", failed_explanation:"⚠️", next_context:"🔮" };
  const lines = infs.map(i => `  ${ICONS[i.type]||"•"} ${i.inference}\n     → ${i.action||""}`);
  return `=== ÇIKARIMLAR ===\n${lines.join("\n")}`;
}

function getStats() {
  const stressful = Object.entries(_d.timeEmotionMap)
    .filter(([,v])=>v.avgStress>0.5 && v.count>=3)
    .sort((a,b)=>b[1].avgStress-a[1].avgStress).slice(0,3)
    .map(([k,v])=>`${k}:${v.avgStress}`);
  const repeated = Object.entries(_d.repeatQuestions)
    .sort((a,b)=>b[1].count-a[1].count).slice(0,5)
    .map(([k,v])=>`"${k}":${v.count}x`);
  return {
    totalIngested: _d.meta.totalIngested,
    stressfulTimes: stressful,
    mostRepeated:   repeated,
    failedCount:    Object.keys(_d.failedExplanations).length,
  };
}

process.on("SIGINT",  ()=>{ try{fs.writeFileSync(FILE,JSON.stringify(_d,null,2));}catch(e){} });
process.on("SIGTERM", ()=>{ try{fs.writeFileSync(FILE,JSON.stringify(_d,null,2));}catch(e){} });

console.log(`[Inference] 🔍 Yüklendi — ${_d.meta.totalIngested} gözlem`);

module.exports = { ingest, getAllInferences, getInferencePrompt, getStats };
