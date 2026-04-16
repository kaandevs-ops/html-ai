// ============================================================
// 📖 brain/episodic.js — Episodik Bellek v1
// Her konuşmayı saklar, ilgili olanları bulur.
// "Geçen hafta deployment'tan bahsetmiştin" → gerçek hafıza
// ============================================================
"use strict";

const fs   = require("fs");
const path = require("path");

const FILE        = path.join(__dirname, "..", "episodes.json");
const MAX         = 200;  // max saklanacak episode sayısı

let _eps      = [];
let _session  = `s_${Date.now()}`;
let _turn     = 0;
let _timer    = null;

// ── Yükle ─────────────────────────────────────────────────
;(function _load() {
  try {
    if (fs.existsSync(FILE)) {
      const raw = JSON.parse(fs.readFileSync(FILE, "utf-8"));
      if (Array.isArray(raw)) { _eps = raw; }
      console.log(`[Episodic] 📖 ${_eps.length} episode yüklendi`);
    }
  } catch(e) { console.warn("[Episodic] ⚠️", e.message); }
})();

function _save() {
  if (_timer) clearTimeout(_timer);
  _timer = setTimeout(() => {
    try { fs.writeFileSync(FILE, JSON.stringify(_eps, null, 2)); } catch(e) {}
  }, 2000);
}

// ── Yardımcılar ───────────────────────────────────────────
const _STOP = new Set([
  "bir","bu","şu","ve","ile","de","da","ki","ne","mi","için","ama","çok",
  "daha","en","gibi","var","yok","bana","sen","ben","nasıl","neden","the",
  "is","are","was","have","that","this","with","from","what","how","you"
]);

function _topics(text) {
  return text.toLowerCase()
    .replace(/[^a-züçğışöı\s]/g," ")
    .split(/\s+/)
    .filter(w => w.length > 3 && !_STOP.has(w))
    .slice(0, 8);
}

function _entities(text) {
  const out = {};
  // Büyük harfle başlayan Türkçe/Latin kelimeler
  (text.match(/\b[A-ZÇĞİÖŞÜ][a-züçğışöı]{1,20}\b/g) || [])
    .forEach(e => { out[e] = (out[e] || 0) + 1; });
  // dosya uzantıları
  (text.match(/\b\w+\.(js|py|ts|json|md|css|html|env)\b/gi) || [])
    .forEach(e => { out[e.toLowerCase()] = (out[e.toLowerCase()] || 0) + 1; });
  return out;
}

function _sentiment(text) {
  const l = text.toLowerCase();
  const p = ["harika","mükemmel","teşekkür","güzel","süper","başardım","oldu","sevdim"].filter(w=>l.includes(w)).length;
  const n = ["hata","sorun","çalışmıyor","kötü","berbat","olmadı","yanlış","fail","error"].filter(w=>l.includes(w)).length;
  return p > n ? "positive" : n > p ? "negative" : "neutral";
}

function _importance(msg, answer, emo) {
  let s = 0.4;
  if (msg.length > 100)    s += 0.1;
  if (answer.length > 200) s += 0.1;
  if (/hata|error|sorun|çalışmıyor/i.test(msg + answer))         s += 0.15;
  if (/karar|sonuç|tamamlandı|hallettim|çözdüm/i.test(msg+answer)) s += 0.15;
  if ((emo?.frustration || 0) > 0.5 || (emo?.urgency || 0) > 0.7) s += 0.1;
  if (msg.includes("?"))   s += 0.05;
  return Math.min(1.0, s);
}

function _daysAgo(dateStr) {
  const d = Math.round((Date.now() - new Date(dateStr).getTime()) / 86400000);
  if (d === 0) return "bugün";
  if (d === 1) return "dün";
  if (d < 7)  return `${d} gün önce`;
  if (d < 30) return `${Math.round(d/7)} hafta önce`;
  return `${Math.round(d/30)} ay önce`;
}

// ── Episode kaydet ────────────────────────────────────────
function saveEpisode(userMessage, answer, emotionState = {}) {
  if (!userMessage || userMessage.length < 5) return null;
  _turn++;

  const ep = {
    id:        `ep_${Date.now()}`,
    date:      new Date().toISOString().split("T")[0],
    time:      new Date().toTimeString().slice(0, 5),
    sessionId: _session,
    turn:      _turn,
    userMessage: userMessage.slice(0, 300),
    answer:      answer.slice(0, 400),
    topics:      _topics(userMessage + " " + answer),
    entities:    _entities(userMessage + " " + answer),
    sentiment:   _sentiment(userMessage),
    emo: {
      mood:        emotionState.mood        || "NORMAL",
      confidence:  +(emotionState.confidence  || 0.7).toFixed(2),
      frustration: +(emotionState.frustration || 0).toFixed(2),
    },
    importance: _importance(userMessage, answer, emotionState),
  };

  _eps.unshift(ep);

  // Prune: en düşük önemi atsın
  if (_eps.length > MAX) {
    _eps.sort((a, b) => b.importance - a.importance);
    _eps = _eps.slice(0, MAX);
  }

  _save();
  return ep;
}

// ── İlgili episode'ları bul ───────────────────────────────
function searchEpisodes(query, topN = 4) {
  if (!query || _eps.length === 0) return [];

  const qt  = _topics(query);
  const ql  = query.toLowerCase();

  return _eps
    .map(ep => {
      let s = 0;
      // Konu örtüşmesi
      s += ep.topics.filter(t => qt.includes(t)).length * 0.3;
      // Kelime eşleşmesi
      qt.forEach(w => {
        if (ep.userMessage.toLowerCase().includes(w)) s += 0.2;
        if (ep.answer.toLowerCase().includes(w))      s += 0.1;
      });
      // Entity eşleşmesi
      Object.keys(ep.entities || {}).forEach(e => {
        if (ql.includes(e.toLowerCase())) s += 0.25;
      });
      // Önem ağırlığı
      s *= (0.5 + ep.importance * 0.5);
      // Tazelik
      const ageDays = (Date.now() - new Date(ep.date).getTime()) / 86400000;
      if (ageDays < 1) s *= 1.3;
      else if (ageDays < 7) s *= 1.1;

      return { ep, s };
    })
    .filter(x => x.s > 0.1)
    .sort((a, b) => b.s - a.s)
    .slice(0, topN)
    .map(x => x.ep);
}

// ── LLM Prompt ───────────────────────────────────────────
function getEpisodicPrompt(currentMessage) {
  const relevant = searchEpisodes(currentMessage, 3);
  if (relevant.length === 0) return "";

  const lines = relevant.map(ep => {
    const ago     = _daysAgo(ep.date);
    const topics  = ep.topics.slice(0, 3).join(", ");
    const preview = ep.userMessage.slice(0, 70);
    return `  • ${ago} [${topics}]: "${preview}..."`;
  });

  return `=== GEÇMİŞ KONUŞMALAR ===\nBu konuyla ilgili daha önce:\n${lines.join("\n")}\nBu bağlamı kullan, tekrar etme.`;
}

// ── İstatistik ────────────────────────────────────────────
function getStats() {
  const topicFreq = {};
  _eps.forEach(ep => ep.topics.forEach(t => { topicFreq[t] = (topicFreq[t]||0)+1; }));
  const topTopics = Object.entries(topicFreq)
    .sort((a,b)=>b[1]-a[1]).slice(0,8).map(([t,c])=>({topic:t,count:c}));
  return { totalEpisodes: _eps.length, topTopics };
}

function getAllEpisodes(n = 20) { return _eps.slice(0, n); }

process.on("SIGINT",  ()=>{ if(_timer){clearTimeout(_timer); try{fs.writeFileSync(FILE,JSON.stringify(_eps,null,2));}catch(e){}} });
process.on("SIGTERM", ()=>{ if(_timer){clearTimeout(_timer); try{fs.writeFileSync(FILE,JSON.stringify(_eps,null,2));}catch(e){}} });

module.exports = { saveEpisode, searchEpisodes, getEpisodicPrompt, getStats, getAllEpisodes };
