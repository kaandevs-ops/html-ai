// ============================================================
// 🧠 brain/userUnderstanding.js — Gerçek Kullanıcı Anlama v1
// Sadece ne söylediğini değil, kim olduğunu, ne bildiğini,
// nerede takıldığını ve nasıl öğrendiğini anlar.
// ============================================================
"use strict";

const fs   = require("fs");
const path = require("path");

const FILE = path.join(__dirname, "..", "user_understanding.json");

const DEFAULT = {
  // Çıkarılan inançlar: kullanıcının dünyası hakkındaki modeli
  // [{ id, claim, confidence, evidence[], firstSeen, lastUpdated }]
  beliefs: [],

  // Hangi konularda ne kadar çalışıyor, nerede takılıyor
  // { "docker": { count, struggling, understood, lastSeen } }
  workPatterns: {},

  // Mesajlardan çıkarılan iletişim tercihleri
  communicationStyle: {
    prefersExamples:   false,
    prefersStepByStep: false,
    prefersShort:      false,
    questionRate:      0,    // soru mesajı oranı
    codeUsageRate:     0,    // kod bloğu kullanım oranı
    totalMessages:     0,
  },

  // Bilmediği / anlamakta zorlandığı kavramlar
  knowledgeGaps: [],  // ["docker networking", "async/await", ...]

  // İyi bildiği, kendi kendine düzeltebildiği konular
  strengths: [],

  // Konu geçiş matrisi: A'dan sonra genelde B soruyor
  // { "frontend": { "backend": 3, "deploy": 2 } }
  topicTransitions: {},
  lastTopic: null,

  totalObservations: 0,
  firstSeen:   new Date().toISOString(),
  lastUpdated: new Date().toISOString(),
};

let _m     = _load();
let _timer = null;

function _load() {
  try {
    if (fs.existsSync(FILE)) return { ...DEFAULT, ...JSON.parse(fs.readFileSync(FILE, "utf-8")) };
  } catch(e) {}
  return JSON.parse(JSON.stringify(DEFAULT));
}

function _save() {
  _m.lastUpdated = new Date().toISOString();
  if (_timer) clearTimeout(_timer);
  _timer = setTimeout(() => {
    try { fs.writeFileSync(FILE, JSON.stringify(_m, null, 2)); } catch(e) {}
  }, 2000);
}

// ══════════════════════════════════════════════════════════
// KONU TESPİTİ
// ══════════════════════════════════════════════════════════
const _TOPICS = {
  "frontend":     ["react","vue","css","html","component","jsx","tailwind","dom","ui"],
  "backend":      ["node","express","api","endpoint","server","route","middleware","rest","fastapi"],
  "veritabanı":   ["mongodb","sql","postgres","redis","query","schema","aggregate","mongoose"],
  "deployment":   ["docker","deploy","nginx","pm2","cloud","vps","aws","heroku","container"],
  "hata-ayıklama":["hata","error","bug","çalışmıyor","sorun","fix","debug","undefined","null"],
  "öğrenme":      ["nasıl","nedir","anlat","açıkla","ne demek","ne işe","kavram","bilmiyorum"],
  "kod-yazma":    ["yaz","oluştur","implement","ekle","fonksiyon","class","method","return"],
  "planlama":     ["plan","mimari","tasarım","strateji","approach","nasıl yapabilirim","yapısı"],
};

function _detectTopic(text) {
  const l = text.toLowerCase();
  let best = null, bestScore = 0;
  Object.entries(_TOPICS).forEach(([topic, signals]) => {
    const score = signals.filter(s => l.includes(s)).length;
    if (score > bestScore) { bestScore = score; best = topic; }
  });
  return best; // null olabilir
}

// ══════════════════════════════════════════════════════════
// İNANÇ ÇIKARIMI
// "Her zaman X kullanıyorum" → kalıcı inanç kaydı
// ══════════════════════════════════════════════════════════
const _BELIEF_RULES = [
  { re: /her zaman (.{3,40}?) (kullanıyorum|yapıyorum|tercih ediyorum)/i,
    make: m => `Kullanıcı "${m[1].trim()}" kullanmayı tercih ediyor` },
  { re: /hiç (.{3,40}?) (kullanmadım|denemedim|bilmiyorum)/i,
    make: m => `Kullanıcı "${m[1].trim()}" konusunda deneyimsiz` },
  { re: /(.{3,30}?) (çok zor|anlamıyorum|kafam karışıyor|bayılıyorum)/i,
    make: m => `Kullanıcı "${m[1].trim()}" konusunu zor buluyor` },
  { re: /(.{3,30}?) (seviyorum|çok iyi|en iyi|harika)/i,
    make: m => `Kullanıcı "${m[1].trim()}" konusunda olumlu düşünüyor` },
  { re: /(\d{1,2}) (yıl|ay) (önce|dir) (.{3,30}?)(kullanıyorum|çalışıyorum)/i,
    make: m => `Kullanıcının "${m[4].trim()}" ile ${m[1]} ${m[2]} deneyimi var` },
  { re: /projemde?|kendi (projemde?|sistemimde?)/i,
    make: () => `Kullanıcının aktif bir projesi var` },
  { re: /deadline|teslim tarihi|yetişmem lazım/i,
    make: () => `Kullanıcı zaman baskısı altında çalışıyor` },
];

function _extractBeliefs(msg) {
  _BELIEF_RULES.forEach(({ re, make }) => {
    const m = msg.match(re);
    if (!m) return;
    const claim = make(m);
    if (!claim) return;

    const existing = _m.beliefs.find(b => b.claim === claim);
    if (existing) {
      // Güçlendir
      existing.confidence = Math.min(1.0, existing.confidence + 0.1);
      existing.lastUpdated = new Date().toISOString();
      if (!existing.evidence.includes(msg.slice(0,80)))
        existing.evidence.push(msg.slice(0, 80));
    } else {
      _m.beliefs.unshift({
        id:          `b_${Date.now()}`,
        claim,
        confidence:  0.6,
        evidence:    [msg.slice(0, 80)],
        firstSeen:   new Date().toISOString(),
        lastUpdated: new Date().toISOString(),
      });
      console.log(`[UserUnderstanding] 💡 Yeni inanç: "${claim}"`);
    }
  });
  if (_m.beliefs.length > 60) _m.beliefs = _m.beliefs.slice(0, 60);
}

// ══════════════════════════════════════════════════════════
// BİLGİ BOŞLUĞU TESPİTİ
// "X nedir / X nasıl çalışır" → bilgi boşluğu
// "Anladım / oldu" gelirse → boşluk kapandı
// ══════════════════════════════════════════════════════════
function _detectKnowledgeGap(msg) {
  const m = msg.match(/(.{3,40}?)\s+(nedir|ne demek|nasıl çalışır|ne işe yarar|açıklar mısın)/i);
  if (!m) return null;
  return m[1].trim().toLowerCase().slice(0, 50);
}

function _checkGapClosed(msg) {
  return /anladım|tamam|oldu|teşekkür|hallettim|çözdüm|şimdi anladım/i.test(msg);
}

// ══════════════════════════════════════════════════════════
// ANA GÖZLEM
// ══════════════════════════════════════════════════════════
function observe(userMessage, answer, emotionResult = {}) {
  if (!userMessage) return;

  _m.totalObservations++;
  const topic = _detectTopic(userMessage);
  const lower = userMessage.toLowerCase();

  // ── İletişim stili ──────────────────────────────────
  const cs = _m.communicationStyle;
  cs.totalMessages++;
  if (/örneğin|mesela|örnek ver/i.test(lower))      cs.prefersExamples   = true;
  if (/adım adım|sırayla|önce.*sonra/i.test(lower)) cs.prefersStepByStep = true;
  if (/kısa|özet|sadece sonuc/i.test(lower))        cs.prefersShort      = true;
  if (userMessage.trim().endsWith("?"))
    cs.questionRate = +((cs.questionRate * (cs.totalMessages-1) + 1) / cs.totalMessages).toFixed(2);
  if (/```|`/.test(userMessage))
    cs.codeUsageRate = +((cs.codeUsageRate * (cs.totalMessages-1) + 1) / cs.totalMessages).toFixed(2);

  // ── Çalışma kalıpları ───────────────────────────────
  if (topic) {
    if (!_m.workPatterns[topic])
      _m.workPatterns[topic] = { count:0, struggling:0, understood:0, lastSeen:null };
    const wp = _m.workPatterns[topic];
    wp.count++;
    wp.lastSeen = new Date().toISOString();
    if (/hâlâ|hala|tekrar|yine olmadı|anlamıyorum|neden/i.test(lower)) wp.struggling++;
    if (_checkGapClosed(lower)) wp.understood++;
  }

  // ── İnançlar ────────────────────────────────────────
  _extractBeliefs(userMessage);

  // ── Bilgi boşlukları ─────────────────────────────────
  const gap = _detectKnowledgeGap(userMessage);
  if (gap && !_m.knowledgeGaps.includes(gap)) {
    _m.knowledgeGaps.unshift(gap);
    if (_m.knowledgeGaps.length > 25) _m.knowledgeGaps.pop();
    console.log(`[UserUnderstanding] 📭 Bilgi boşluğu: "${gap}"`);
  }
  // Kapandıysa temizle
  if (_checkGapClosed(lower) && _m.lastDetectedGap) {
    _m.knowledgeGaps = _m.knowledgeGaps.filter(g => g !== _m.lastDetectedGap);
  }
  _m.lastDetectedGap = gap;

  // ── Güçlü yönler ─────────────────────────────────────
  if (topic && /bunu biliyorum|daha önce yaptım|tecrübem var|iyi biliyorum|aslında/i.test(lower)) {
    if (!_m.strengths.includes(topic)) {
      _m.strengths.unshift(topic);
      if (_m.strengths.length > 15) _m.strengths.pop();
      console.log(`[UserUnderstanding] 💪 Güçlü alan: "${topic}"`);
    }
  }

  // ── Konu geçiş matrisi ───────────────────────────────
  const lastTopic = _m.lastTopic;
  if (topic && lastTopic && topic !== lastTopic) {
    if (!_m.topicTransitions[lastTopic]) _m.topicTransitions[lastTopic] = {};
    _m.topicTransitions[lastTopic][topic] = (_m.topicTransitions[lastTopic][topic] || 0) + 1;
  }
  if (topic) _m.lastTopic = topic;

  _save();
}

// ══════════════════════════════════════════════════════════
// TAHMİN: Bir sonraki konu
// ══════════════════════════════════════════════════════════
function predictNextTopic() {
  const last = _m.lastTopic;
  if (!last || !_m.topicTransitions[last]) return null;
  const transitions = _m.topicTransitions[last];
  const total  = Object.values(transitions).reduce((s,c)=>s+c, 0);
  const sorted = Object.entries(transitions).sort((a,b)=>b[1]-a[1]);
  if (sorted.length === 0 || sorted[0][1] / total < 0.3) return null;
  return { topic: sorted[0][0], confidence: +(sorted[0][1]/total).toFixed(2), from: last };
}

// ══════════════════════════════════════════════════════════
// LLM PROMPT
// ══════════════════════════════════════════════════════════
function getUnderstandingPrompt(currentMessage) {
  const parts = [];

  // Güçlü inançlar
  const strongBeliefs = _m.beliefs.filter(b => b.confidence >= 0.7).slice(0, 3);
  if (strongBeliefs.length > 0)
    parts.push(`Kullanıcı hakkında bilinen gerçekler:\n${strongBeliefs.map(b=>`  • ${b.claim}`).join("\n")}`);

  // İletişim stili
  const cs   = _m.communicationStyle;
  const style = [];
  if (cs.prefersExamples)   style.push("örneklerle açıklama sever");
  if (cs.prefersStepByStep) style.push("adım adım anlatımı tercih eder");
  if (cs.prefersShort)      style.push("kısa cevap ister");
  if (cs.questionRate > 0.6) style.push("çok soru soruyor, meraklı biri");
  if (style.length > 0)
    parts.push(`İletişim tarzı: ${style.join(", ")}`);

  // Bilgi boşlukları
  if (_m.knowledgeGaps.length > 0)
    parts.push(`Zayıf olduğu konular: ${_m.knowledgeGaps.slice(0,3).join(", ")} — dikkatli açıkla`);

  // Güçlü yönler
  if (_m.strengths.length > 0)
    parts.push(`İyi bildiği alanlar: ${_m.strengths.slice(0,3).join(", ")} — burada teknik kal`);

  // Takıldığı konular
  const struggling = Object.entries(_m.workPatterns)
    .filter(([,p]) => p.struggling > 1 && p.struggling > p.understood)
    .sort((a,b) => b[1].struggling - a[1].struggling)
    .slice(0, 2).map(([t])=>t);
  if (struggling.length > 0)
    parts.push(`Sürekli takıldığı konular: ${struggling.join(", ")} — farklı bir yöntem dene`);

  // Sonraki konu tahmini
  const next = predictNextTopic();
  if (next && next.confidence >= 0.5)
    parts.push(`Büyük ihtimalle sonra "${next.topic}" hakkında soru gelecek — hazırlıklı ol`);

  if (parts.length === 0) return "";
  return `=== KULLANICI ANLAMA ===\n${parts.join("\n")}`;
}

function getSummary() {
  return {
    totalObservations: _m.totalObservations,
    topTopics: Object.entries(_m.workPatterns)
      .sort((a,b)=>b[1].count-a[1].count).slice(0,5)
      .map(([t,p])=>`${t}(${p.count})`),
    beliefCount:   _m.beliefs.length,
    knowledgeGaps: _m.knowledgeGaps.slice(0, 5),
    strengths:     _m.strengths.slice(0, 5),
    nextPrediction: predictNextTopic(),
    communicationStyle: _m.communicationStyle,
  };
}

function getModel() { return { ..._m }; }

process.on("SIGINT",  ()=>{ try{fs.writeFileSync(FILE,JSON.stringify(_m,null,2));}catch(e){} });
process.on("SIGTERM", ()=>{ try{fs.writeFileSync(FILE,JSON.stringify(_m,null,2));}catch(e){} });

console.log(`[UserUnderstanding] 🧠 Yüklendi — ${_m.totalObservations} gözlem`);

module.exports = { observe, predictNextTopic, getUnderstandingPrompt, getSummary, getModel };
