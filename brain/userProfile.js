// ============================================================
// 👤 brain/userProfile.js — Kullanıcı Profil Motoru v2
//
// v1'den farklar (orijinal her satır korundu, üstüne eklendi):
//   + Kişisel bilgi çıkarma (ad, şehir, meslek, aile, evcil hayvan)
//   + Somut olay tespiti (toplantı, geç kalma, randevu, başarı)
//   + Rutin öğrenme (kahve saati, öğle, gece planı)
//   + Güçlü örüntü sayacı (2+ kez → pattern olarak işaretle)
//   + Sabah özeti üretme
//   + getProactiveData() — proactive.js için veri sağlayıcı
//   + Batch disk yazma (her çağrıda değil, 3sn debounce)
//
// KURULUM — brain/index.js'e ekle (v1 ile AYNI, değişmedi):
//   const userProfile = require("./userProfile");
//   userProfile.tick(userPrompt);
//   userProfile.onInteraction(userMessage, answer, empathy.detectEmotion(userMessage));
//   userProfile: userProfile.getProfile(),
//
// proactive.js için server.js'e:
//   const proactive = require('./brain/proactive');
//   proactive.mount(app, userProfile, { axios, isMac, isWindows, exec, ElevenLabs: {...} });
//
// HİÇBİR MEVCUT DOSYAYA DOKUNMAZ.
// ============================================================

"use strict";

const fs   = require("fs");
const path = require("path");

const PROFILE_FILE = path.join(__dirname, "..", "user_profile.json");

// ── Lazy require — circular dependency'den kaçın ──────────
function _mod(name) {
  try { return require("./" + name); } catch(e) { return null; }
}

// ── Varsayılan profil şablonu ─────────────────────────────
const DEFAULT_PROFILE = {
  // ── v1: Zaman alışkanlıkları ──────────────────────────
  activeHours: {},
  activeDays:  {},
  peakHour:    null,
  peakDay:     null,

  // ── v1: İlgi alanları ─────────────────────────────────
  topInterests:    [],
  interestScores:  {},

  // ── v1: Duygu profili ─────────────────────────────────
  dominantEmotion: "neutral",
  emotionHistory:  [],
  stressFrequency: 0,

  // ── v1: Konuşma stili ─────────────────────────────────
  avgMessageLength: 0,
  prefersShort:     false,
  techLevel:        "intermediate",
  languageStyle:    "informal",

  // ── v1: Haftalık örüntü ───────────────────────────────
  weeklyPattern: {},

  // ── v1: Açık tercihler ────────────────────────────────
  explicitPrefs: [],

  // ── v2 YENİ: Kişisel kimlik ───────────────────────────
  identity: {
    // Kullanıcı konuşmalarından öğrenilir
    name:    null,   // "Adım Kaan" → "Kaan"
    city:    null,   // "İstanbul'dayım" → "İstanbul"
    job:     null,   // "yazılımcıyım" → "yazılımcı"
    hobbies: null,
    family:  null,
    pet:     null,
  },

  // ── v2 YENİ: Somut yaşanmış olaylar ──────────────────
  // [{ id, type, summary, day, hour, timeLabel, date, count }]
  events: [],

  // ── v2 YENİ: Davranış örüntüleri ─────────────────────
  // { 'gec_kalma': { count, strength, desc, lastSeen } }
  patterns: {},

  // ── v2 YENİ: Öğrenilen rutinler ──────────────────────
  // { 'sabah_kahve': { count, hours[], avgHour, label, lastSeen } }
  routines: {},

  // ── v2 YENİ: Günlük ruh hali geçmişi ─────────────────
  // [{ date, hour, mood, trigger }]
  moodLog: [],

  // ── Meta ──────────────────────────────────────────────
  totalInteractions: 0,
  firstSeen:   new Date().toISOString(),
  lastSeen:    new Date().toISOString(),
  lastUpdated: new Date().toISOString()
};

// ── Profil yükle ──────────────────────────────────────────
function _load() {
  try {
    if (fs.existsSync(PROFILE_FILE)) {
      const raw = JSON.parse(fs.readFileSync(PROFILE_FILE, "utf-8"));
      return {
        ...DEFAULT_PROFILE,
        ...raw,
        identity: { ...DEFAULT_PROFILE.identity, ...(raw.identity || {}) },
      };
    }
  } catch(e) {
    console.warn("[UserProfile] ⚠️ Profil yüklenemedi, sıfırlandı:", e.message);
  }
  return JSON.parse(JSON.stringify(DEFAULT_PROFILE));
}

// ── Batch disk yazma (debounce 3sn) ───────────────────────
let _saveTimer = null;
function _save() {
  _profile.lastUpdated = new Date().toISOString();
  if (_saveTimer) clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => {
    try { fs.writeFileSync(PROFILE_FILE, JSON.stringify(_profile, null, 2), "utf-8"); }
    catch(e) { console.error("[UserProfile] ❌ Kaydetme hatası:", e.message); }
  }, 3000);
}

let _profile = _load();

// ── Zaman yardımcıları ─────────────────────────────────────
function _timePeriod(hour) {
  if (hour >= 6  && hour < 12) return "sabah";
  if (hour >= 12 && hour < 17) return "öğleden-sonra";
  if (hour >= 17 && hour < 21) return "akşam";
  return "gece";
}
const _DAYS = ["Pazar","Pazartesi","Salı","Çarşamba","Perşembe","Cuma","Cumartesi"];
function _dayName()  { return _DAYS[new Date().getDay()]; }
function _hour()     { return new Date().getHours(); }
function _dateStr()  { return new Date().toISOString().split("T")[0]; }
function _nowISO()   { return new Date().toISOString(); }

// ── v1: Keyword çıkarma ───────────────────────────────────
const _STOP_WORDS = new Set([
  "bir","bu","şu","o","ve","ile","de","da","ki","ne","mi","mu","mü","mı",
  "için","ama","çok","daha","en","gibi","var","yok","bana","beni","sen",
  "ben","biz","siz","onlar","olan","oldu","olur","nasıl","neden","niye",
  "acaba","evet","hayır","tamam","lütfen","teşekkür","merhaba","selam",
  "the","is","are","was","were","have","has","had","will","would","can",
  "could","should","that","this","with","from","they","their","what","how"
]);
function _extractKeywords(text) {
  return text
    .toLowerCase()
    .replace(/[^a-züçğışöı\s]/g, " ")
    .split(/\s+/)
    .filter(w => w.length > 3 && !_STOP_WORDS.has(w))
    .slice(0, 10);
}

// ── v1: Tech level ─────────────────────────────────────────
const _TECH_WORDS = [
  "async","await","promise","callback","endpoint","api","json","deploy",
  "docker","git","commit","branch","merge","refactor","typescript","webpack",
  "kubernetes","nginx","redis","mongodb","postgresql","graphql","rest","http",
  "function","class","import","export","module","require","node","npm","yarn"
];
const _BEGINNER_WORDS = ["nasıl","ne demek","anlat","öğren","bilmiyorum","yeni başlıyorum"];
function _detectTechLevel(text) {
  const low     = text.toLowerCase();
  const tech    = _TECH_WORDS.filter(w => low.includes(w)).length;
  const beginner = _BEGINNER_WORDS.filter(w => low.includes(w)).length;
  if (tech >= 3)    return "advanced";
  if (tech >= 1)    return "intermediate";
  if (beginner >= 2) return "beginner";
  return null;
}

// ── v1: Explicit tercih tespiti ───────────────────────────
const _PREF_PATTERNS = [
  { pattern: /kısa\s*(cevap|söyle|yaz|ver)/i,       pref: "kısa cevap ister" },
  { pattern: /detaylı\s*(anlat|açıkla|yaz)/i,        pref: "detaylı açıklama ister" },
  { pattern: /türkçe\s*(konuş|yaz|cevap)/i,          pref: "Türkçe yanıt ister" },
  { pattern: /madde\s*madde|liste\s*(halinde|yap)/i,  pref: "liste formatı ister" },
  { pattern: /kod\s*(yaz|göster|ver)/i,               pref: "kod örneği ister" },
  { pattern: /sadece\s*(cevab|sonuç|özet)/i,          pref: "sadece sonuç ister" },
];
function _detectExplicitPref(text) {
  for (const { pattern, pref } of _PREF_PATTERNS) {
    if (pattern.test(text) && !_profile.explicitPrefs.includes(pref)) return pref;
  }
  return null;
}

// ══════════════════════════════════════════════════════════
// v2 YENİ: KİŞİSEL BİLGİ ÇIKARMA
// ══════════════════════════════════════════════════════════
const _IDENTITY_PATTERNS = [
  { regex: /(?:adım|ismim|benim adım)\s+([A-ZÇĞİÖŞÜa-zçğışöşü]{2,20})/i,                      field: "name" },
  { regex: /(?:istanbul|ankara|izmir|bursa|antalya|adana|konya|şehrimde?|yaşıyorum)\s*[:]?\s*([A-ZÇĞİÖŞÜa-zçğışöşü]{3,20})?/i, field: "city" },
  { regex: /(?:işim|mesleğim|çalışıyorum|yazılımcıyım|mühendisim|doktorum|öğretmenim)\s*[:]?\s*(.{2,40}?)(?:\.|,|$)/i, field: "job" },
  { regex: /(?:hobim|hobilerim|seviyorum|ilgileniyorum)\s*[:]?\s*(.{3,60}?)(?:\.|,|$)/i,        field: "hobbies" },
  { regex: /(?:karım|kocam|çocuğum|kızım|oğlum|annem|babam)\s*(.{0,30}?)(?:\.|,|$)/i,         field: "family" },
  { regex: /(?:köpeğim|kedim|evcil hayvanım)\s*(?:adı\s*)?([A-ZÇĞİÖŞÜa-zçğışöşü]{2,20})/i,    field: "pet" },
];

// Şehir sabit listesi (regex'in yakalayamadığı durumlar için)
const _CITIES = ["istanbul","ankara","izmir","bursa","antalya","adana","konya","gaziantep","mersin","kayseri","eskişehir","diyarbakır","erzurum","samsun","trabzon"];

function _extractIdentity(msg) {
  const lower = msg.toLowerCase();

  // Sabit şehir listesinden kontrol
  if (!_profile.identity.city) {
    const found = _CITIES.find(c => lower.includes(c));
    if (found) {
      _profile.identity.city = found.charAt(0).toUpperCase() + found.slice(1);
      _profile.identity.city_updatedAt = _nowISO();
    }
  }

  // Regex tabanlı çıkarma
  _IDENTITY_PATTERNS.forEach(({ regex, field }) => {
    if (_profile.identity[field]) return; // zaten biliyorsa atla
    const m = msg.match(regex);
    if (m) {
      const val = (m[1] || m[0] || "").trim().replace(/['"]/g, "");
      if (val.length >= 2 && val.length <= 80) {
        _profile.identity[field] = val;
        _profile.identity[`${field}_updatedAt`] = _nowISO();
        console.log(`[UserProfile] 👤 Kimlik öğrenildi: ${field} = "${val}"`);
      }
    }
  });
}

// ══════════════════════════════════════════════════════════
// v2 YENİ: SOMUT OLAY TESPİTİ
// ══════════════════════════════════════════════════════════
const _EVENT_PATTERNS = [
  { regex: /(?:toplantım|toplantı|meeting)\s*(?:var|saat|de|da)?/i,  type: "toplanti",     summary: "Toplantı var" },
  { regex: /geç kaldım|geç kalacağım|gecikmeli/i,                     type: "gec_kalma",    summary: "Gecikme yaşandı" },
  { regex: /(?:randevum|randevu)\s*(?:var|saat)?/i,                   type: "randevu",      summary: "Randevu var" },
  { regex: /(?:harika|mükemmel|başardım|tamamladım|hallettim)/i,       type: "basari",       summary: "Başarı/tamamlama" },
  { regex: /(?:berbat|çöktü|mahvoldu|rezalet|berbat)/i,               type: "basarisizlik", summary: "Zorluk yaşandı" },
  { regex: /(?:uyuyamadım|uykusuz|uyku sorunu)/i,                     type: "uyku_sorunu",  summary: "Uyku sorunu" },
  { regex: /(?:bugün|bu hafta)\s*(?:çok yoğun|yoğunum)/i,            type: "yogun_gun",    summary: "Yoğun gün" },
];

function _extractEvents(msg) {
  const today = _dateStr();
  const hour  = _hour();
  const day   = _dayName();

  _EVENT_PATTERNS.forEach(({ regex, type, summary }) => {
    if (!regex.test(msg)) return;

    // Aynı gün aynı tip iki kez kaydetme — sadece count artır
    const existing = _profile.events.find(e => e.type === type && e.date === today);
    if (existing) { existing.count++; existing.lastSeen = _nowISO(); return; }

    const event = {
      id:        Date.now(),
      type,
      summary,
      day,
      hour,
      timeLabel: _timePeriod(hour),
      date:      today,
      count:     1,
      lastSeen:  _nowISO(),
    };
    _profile.events.push(event);
    if (_profile.events.length > 300) _profile.events = _profile.events.slice(-250);

    // Aynı tip olay tekrarlanıyorsa örüntü güncelle
    _updatePattern(type, summary);
    console.log(`[UserProfile] 📌 Olay: ${type} @ ${_timePeriod(hour)}`);
  });
}

// ══════════════════════════════════════════════════════════
// v2 YENİ: ÖRÜNTÜ SAYACI
// ══════════════════════════════════════════════════════════
function _updatePattern(id, desc) {
  if (!_profile.patterns[id]) {
    _profile.patterns[id] = { count: 0, strength: 0, desc, firstSeen: _nowISO(), lastSeen: _nowISO() };
  }
  _profile.patterns[id].count++;
  _profile.patterns[id].strength = Math.min(1.0, _profile.patterns[id].count / 10);
  _profile.patterns[id].lastSeen = _nowISO();
}

// ══════════════════════════════════════════════════════════
// v2 YENİ: RUTİN ÖĞRENME
// ══════════════════════════════════════════════════════════
const _ROUTINE_SIGNALS = [
  { key: "sabah_kahve",   words: ["kahve","sabah kahve"],                    hours: [6,7,8,9] },
  { key: "oglen_yemek",   words: ["yemek","öğle","öğlen"],                   hours: [11,12,13,14] },
  { key: "aksam_ozet",    words: ["bugün ne yaptım","gün özeti","nasıldı"],   hours: [17,18,19,20,21] },
  { key: "gece_plan",     words: ["yarın","plan","hazırlık","yatmadan"],      hours: [21,22,23] },
  { key: "sabah_haber",   words: ["haber","bugün ne var","gündem"],           hours: [6,7,8,9] },
];

function _learnRoutine(msg) {
  const lower = msg.toLowerCase();
  const hour  = _hour();

  _ROUTINE_SIGNALS.forEach(({ key, words, hours }) => {
    if (!words.some(w => lower.includes(w))) return;
    if (!hours.includes(hour)) return;

    if (!_profile.routines[key]) {
      _profile.routines[key] = { count: 0, hours: [], avgHour: null, label: key.replace(/_/g, " "), lastSeen: null };
    }
    _profile.routines[key].count++;
    _profile.routines[key].hours.push(hour);
    _profile.routines[key].lastSeen = _nowISO();

    // 3+ tekrar → avg saat hesapla
    if (_profile.routines[key].count >= 3) {
      const arr = _profile.routines[key].hours;
      _profile.routines[key].avgHour = Math.round(arr.reduce((a, b) => a + b, 0) / arr.length);
      if (_profile.routines[key].count === 3) {
        console.log(`[UserProfile] 🔁 Güçlü rutin: ${key} (ort. ${_profile.routines[key].avgHour}:00)`);
      }
    }
  });
}

// ══════════════════════════════════════════════════════════
// v2 YENİ: RUH HALİ GÜNLÜĞÜ
// ══════════════════════════════════════════════════════════
const _MOOD_KEYWORDS = {
  mutlu:    ["harika","mükemmel","süper","muhteşem","sevindim","mutluyum"],
  stresli:  ["stres","bunaldım","sıkıldım","yorgunum","yetişemiyorum"],
  sinirli:  ["sinir","kızgın","bıktım","yeter","saçma","berbat"],
  merakli:  ["acaba","merak","ilginç","keşke","nasıl olur"],
  odakli:   ["çalışıyorum","hazırlanıyorum","odaklanıyorum"],
};

function _logMood(msg) {
  const lower = msg.toLowerCase();
  let best = null, bestScore = 0;
  Object.entries(_MOOD_KEYWORDS).forEach(([mood, words]) => {
    const score = words.filter(w => lower.includes(w)).length;
    if (score > bestScore) { bestScore = score; best = mood; }
  });
  if (!best || bestScore === 0) return;

  _profile.moodLog.push({ date: _dateStr(), hour: _hour(), mood: best, trigger: msg.slice(0, 80) });
  if (_profile.moodLog.length > 200) _profile.moodLog = _profile.moodLog.slice(-150);
}

// ══════════════════════════════════════════════════════════
// ANA GÜNCELLEME — v1 ile AYNI imza, içine v2 eklendi
// ══════════════════════════════════════════════════════════
function onInteraction(userMessage, answer, emotionResult) {
  if (!userMessage) return;

  const now    = new Date();
  const hour   = String(now.getHours());
  const day    = _dayName();
  const period = _timePeriod(now.getHours());
  const key    = `${day}-${period}`;

  _profile.totalInteractions++;
  _profile.lastSeen    = now.toISOString();
  _profile.lastUpdated = now.toISOString();

  // ── v1: Zaman alışkanlıkları ──────────────────────────
  _profile.activeHours[hour] = (_profile.activeHours[hour] || 0) + 1;
  _profile.activeDays[day]   = (_profile.activeDays[day]   || 0) + 1;
  _profile.peakHour = _peakKey(_profile.activeHours);
  _profile.peakDay  = _peakKey(_profile.activeDays);

  // ── v1: İlgi alanları ─────────────────────────────────
  const keywords = _extractKeywords(userMessage);
  keywords.forEach(kw => {
    _profile.interestScores[kw] = (_profile.interestScores[kw] || 0) + 1;
  });
  if (!_profile.weeklyPattern[key]) _profile.weeklyPattern[key] = {};
  keywords.slice(0, 3).forEach(kw => {
    _profile.weeklyPattern[key][kw] = (_profile.weeklyPattern[key][kw] || 0) + 1;
  });
  _profile.topInterests = Object.entries(_profile.interestScores)
    .sort((a, b) => b[1] - a[1]).slice(0, 10).map(([k]) => k);

  // ── v1: Duygu profili ─────────────────────────────────
  const emotion = emotionResult?.emotion || "neutral";
  _profile.emotionHistory.unshift(emotion);
  if (_profile.emotionHistory.length > 30) _profile.emotionHistory.length = 30;
  const emotionCounts = {};
  _profile.emotionHistory.forEach(e => { emotionCounts[e] = (emotionCounts[e] || 0) + 1; });
  _profile.dominantEmotion = _peakKey(emotionCounts) || "neutral";
  const stressCount = _profile.emotionHistory.filter(e => e === "stressed" || e === "angry").length;
  _profile.stressFrequency = parseFloat((stressCount / _profile.emotionHistory.length).toFixed(2));

  // ── v1: Konuşma stili ─────────────────────────────────
  const msgLen = userMessage.length;
  const n      = _profile.totalInteractions;
  _profile.avgMessageLength = Math.round((_profile.avgMessageLength * (n - 1) + msgLen) / n);
  _profile.prefersShort = _profile.avgMessageLength < 60;
  const detectedLevel = _detectTechLevel(userMessage);
  if (detectedLevel) _profile.techLevel = detectedLevel;
  const hasEmoji   = /[\u{1F300}-\u{1FFFF}]/u.test(userMessage);
  const hasExclaim = (userMessage.match(/!/g) || []).length >= 2;
  if (hasEmoji || hasExclaim) _profile.languageStyle = "informal";

  // ── v1: Explicit tercihler ────────────────────────────
  const pref = _detectExplicitPref(userMessage);
  if (pref) {
    _profile.explicitPrefs.unshift(pref);
    if (_profile.explicitPrefs.length > 15) _profile.explicitPrefs.length = 15;
    console.log(`[UserProfile] 👤 Yeni tercih: "${pref}"`);
  }

  // ── v1: Modül senkronizasyonu ─────────────────────────
  _syncFromModules();

  // ── v2 YENİ: Kimlik çıkar ─────────────────────────────
  _extractIdentity(userMessage);

  // ── v2 YENİ: Olay tespit et ───────────────────────────
  _extractEvents(userMessage);

  // ── v2 YENİ: Rutin öğren ──────────────────────────────
  _learnRoutine(userMessage);

  // ── v2 YENİ: Ruh hali kaydet ──────────────────────────
  _logMood(userMessage);

  // Batch kaydet
  _save();

  if (_profile.totalInteractions % 10 === 0) {
    console.log(`[UserProfile] 📊 ${_profile.totalInteractions} etkileşim | Peak: ${_profile.peakHour}:00 | Top: ${_profile.topInterests.slice(0,3).join(", ")} | Kimlik: ${_profile.identity.name || "?"}`);
  }
}

// ── v1: Hafif tick ────────────────────────────────────────
function tick(userMessage) {
  if (!userMessage) return;
  const hour = String(new Date().getHours());
  _profile.activeHours[hour] = (_profile.activeHours[hour] || 0) + 0.1;
}

// ── v1: Modül senkronizasyonu (değişmedi) ─────────────────
function _syncFromModules() {
  try {
    const habitMod = _mod("habit");
    if (habitMod) {
      habitMod.getHabits().filter(h => h.strength >= 0.4).forEach(h => {
        if (!_profile.interestScores[h.trigger]) _profile.interestScores[h.trigger] = 1;
      });
    }
    const personalityMod = _mod("personality");
    if (personalityMod) {
      const p = personalityMod.getPersonality();
      if (p?.traits?.verbosity < 0.3 && !_profile.explicitPrefs.includes("kısa cevap ister")) {
        _profile.prefersShort = true;
      }
    }
    const goalsMod = _mod("goals");
    if (goalsMod) {
      goalsMod.getGoals().filter(g => g.priority >= 4).forEach(g => {
        _extractKeywords(g.goal).forEach(w => {
          _profile.interestScores[w] = (_profile.interestScores[w] || 0) + 0.5;
        });
      });
    }

    // ── v3: Yeni modüllerden senkronize et ─────────────────

    // userUnderstanding → iletişim tarzını profille birleştir
    const uuMod = _mod("userUnderstanding");
    if (uuMod) {
      const summary = uuMod.getSummary();
      // İletişim tercihleri
      const cs = summary.communicationStyle;
      if (cs) {
        if (cs.prefersShort && !_profile.explicitPrefs.includes("kısa cevap ister")) {
          _profile.prefersShort = true;
        }
        if (cs.prefersExamples && !_profile.explicitPrefs.includes("örneklerle açıklama ister")) {
          _profile.explicitPrefs.unshift("örneklerle açıklama ister");
        }
        if (cs.prefersStepByStep && !_profile.explicitPrefs.includes("adım adım anlatım ister")) {
          _profile.explicitPrefs.unshift("adım adım anlatım ister");
        }
      }
      // Güçlü konular → ilgi alanı skoru yükselt
      (summary.strengths || []).forEach(t => {
        _profile.interestScores[t] = (_profile.interestScores[t] || 0) + 2;
      });
      // Bilgi boşlukları → teknik seviyeye yansıt
      if ((summary.knowledgeGaps || []).length >= 3 && _profile.techLevel === "unknown") {
        _profile.techLevel = "beginner";
      }
    }

    // episodic → en çok konuşulan konuları ilgi alanı yap
    const epMod = _mod("episodic");
    if (epMod) {
      const stats = epMod.getStats();
      (stats.topTopics || []).slice(0, 5).forEach(({ topic, count }) => {
        _profile.interestScores[topic] = (_profile.interestScores[topic] || 0) + (count * 0.3);
      });
    }

    // inference → stres zamanlarını profil örüntüsüne ekle
    const infMod = _mod("inference");
    if (infMod) {
      const infStats = infMod.getStats();
      (infStats.stressfulTimes || []).forEach(entry => {
        const timeKey = entry.split(":")[0];
        if (!_profile.patterns[`stres_${timeKey}`]) {
          _profile.patterns[`stres_${timeKey}`] = {
            count: 1, strength: 0.3,
            desc: `${timeKey} saatlerinde stres eğilimi var`,
            firstSeen: new Date().toISOString(),
            lastSeen:  new Date().toISOString(),
          };
        }
      });
    }

    // prediction → doğru tahmin oranı yüksekse profil güvenilir işaretle
    const prMod = _mod("prediction");
    if (prMod) {
      const acc = prMod.getAccuracy();
      if (acc.total >= 20) {
        _profile.predictionAccuracy = acc.rate;
      }
    }

  } catch(e) { /* sessizce geç */ }
}

function _peakKey(obj) {
  if (!obj || Object.keys(obj).length === 0) return null;
  return Object.entries(obj).sort((a, b) => b[1] - a[1])[0][0];
}

// ══════════════════════════════════════════════════════════
// LLM PROMPT ÜRETİCİ — v1 korundu + v2 kimlik/örüntü eklendi
// ══════════════════════════════════════════════════════════
function getProfilePrompt() {
  if (_profile.totalInteractions < 3) return "";
  const parts = [];

  // ── v2: Kimlik bilgileri ──────────────────────────────
  const id = _profile.identity;
  const idLines = [];
  if (id.name)    idLines.push(`Kullanıcının adı: ${id.name}.`);
  if (id.city)    idLines.push(`Şehri: ${id.city}.`);
  if (id.job)     idLines.push(`Mesleği: ${id.job}.`);
  if (id.hobbies) idLines.push(`İlgileri: ${id.hobbies}.`);
  if (id.family)  idLines.push(`Aile: ${id.family}.`);
  if (id.pet)     idLines.push(`Evcil hayvanı: ${id.pet}.`);
  if (idLines.length > 0) parts.push(idLines.join(" "));

  // ── v1: Konuşma stili ─────────────────────────────────
  if (_profile.prefersShort) parts.push("Kullanıcı kısa ve öz cevaplar tercih ediyor.");
  if (_profile.techLevel === "advanced") {
    parts.push("Kullanıcı teknik konulara hakimdir, jargon kullanabilirsin.");
  } else if (_profile.techLevel === "beginner") {
    parts.push("Kullanıcı yeni başlayan biridir, basit açıkla.");
  }
  if (_profile.explicitPrefs.length > 0) {
    parts.push(`Kullanıcı tercihleri: ${_profile.explicitPrefs.slice(0, 3).join(", ")}.`);
  }
  if (_profile.stressFrequency > 0.4) {
    parts.push("Bu kullanıcı sık sık stresli mesajlar atıyor, anlayışlı ve doğrudan ol.");
  }
  if (_profile.topInterests.length > 0) {
    parts.push(`İlgi alanları: ${_profile.topInterests.slice(0, 5).join(", ")}.`);
  }
  if (_profile.peakHour) {
    parts.push(`Genellikle ${_timePeriod(parseInt(_profile.peakHour))} saatlerinde aktif.`);
  }

  // ── v1: Haftalık örüntü ───────────────────────────────
  const now    = new Date();
  const curKey = `${_dayName()}-${_timePeriod(now.getHours())}`;
  const curPat = _profile.weeklyPattern[curKey];
  if (curPat) {
    const topics = Object.entries(curPat).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k]) => k);
    if (topics.length > 0) parts.push(`Bu zaman diliminde genellikle: ${topics.join(", ")}.`);
  }

  // ── v2: Güçlü örüntüler ───────────────────────────────
  const strongPatterns = Object.entries(_profile.patterns)
    .filter(([, p]) => p.strength >= 0.3)
    .slice(0, 3);
  if (strongPatterns.length > 0) {
    const lines = strongPatterns.map(([, p]) => p.desc).join("; ");
    parts.push(`Gözlemlenen örüntüler: ${lines}.`);
  }

  // ── v2: Aktif rutin ───────────────────────────────────
  const hour = _hour();
  const activeRoutines = Object.entries(_profile.routines)
    .filter(([, r]) => r.count >= 3 && r.avgHour !== null && Math.abs(r.avgHour - hour) <= 1)
    .map(([, r]) => r.label);
  if (activeRoutines.length > 0) {
    parts.push(`Bu saatte rutin aktivite: ${activeRoutines.join(", ")}.`);
  }

  // ── v2: Geç kalma uyarısı (toplantı bağlamında) ───────
  const gecKalma = _profile.patterns["gec_kalma"];
  if (gecKalma && gecKalma.count >= 2) {
    parts.push(`Not: Kullanıcının ${gecKalma.count}x gecikme yaşadığı gözlemlendi.`);
  }

  // ── v2: Bugünkü ruh hali ──────────────────────────────
  const todayMood = _profile.moodLog.filter(m => m.date === _dateStr()).slice(-1)[0];
  if (todayMood) parts.push(`Bugün saat ${todayMood.hour}:00'da "${todayMood.mood}" ruh hali gözlemlendi.`);

  // ── v3: Tahmin doğruluğu yüksekse belirt ──────────────
  if (_profile.predictionAccuracy >= 0.6) {
    parts.push(`(Bu kullanıcı için tahmin motoru %${Math.round(_profile.predictionAccuracy*100)} doğrulukla çalışıyor.)`);
  }

  if (parts.length === 0) return "";
  return `=== KULLANICI PROFİLİ ===\n${parts.join("\n")}`;
}

// ══════════════════════════════════════════════════════════
// v2 YENİ: PROAKTİF MOTOR İÇİN VERİ SAĞLAYICI
// ══════════════════════════════════════════════════════════
function getProactiveData() {
  return {
    identity:          _profile.identity,
    patterns:          _profile.patterns,
    routines:          _profile.routines,
    events:            _profile.events.slice(-20),
    moodLog:           _profile.moodLog.slice(-30),
    todayMood:         _profile.moodLog.filter(m => m.date === _dateStr()),
    topInterests:      _profile.topInterests,
    stressFrequency:   _profile.stressFrequency,
    peakHour:          _profile.peakHour,
    totalInteractions: _profile.totalInteractions,
    currentHour:       _hour(),
    currentDay:        _dayName(),
    currentTimeLabel:  _timePeriod(_hour()),
    dateStr:           _dateStr(),
  };
}

// ══════════════════════════════════════════════════════════
// v2 YENİ: SABAH ÖZETİ
// ══════════════════════════════════════════════════════════
function getMorningSummary() {
  const parts = [];
  const name  = _profile.identity.name;

  // Son 24 saatin olayları
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().split("T")[0];
  const recentEvents = _profile.events.filter(e => e.date >= yesterday && e.type !== "rutin_icecek");
  if (recentEvents.length > 0) {
    parts.push(`Son 24 saatte: ${recentEvents.map(e => e.summary).join(", ")}.`);
  }

  // Sabah rutinleri
  const morningR = Object.entries(_profile.routines)
    .filter(([k, r]) => r.count >= 3 && ["sabah_kahve","sabah_haber"].includes(k))
    .map(([, r]) => r.label);
  if (morningR.length > 0) parts.push(`Sabah rutinlerin: ${morningR.join(", ")}.`);

  // Geç kalma uyarısı
  const gec = _profile.patterns["gec_kalma"];
  if (gec && gec.count >= 2) {
    parts.push(`Hatırlatma: ${gec.count}x gecikme yaşandı, bugün erken hazırlan.`);
  }

  if (parts.length === 0) return null;
  return `☀️ Günaydın${name ? " " + name : ""}!\n${parts.join("\n")}`;
}

// ── v1: getProfile (değişmedi + v2 alanları eklendi) ──────
function getProfile() {
  return {
    // v1
    totalInteractions: _profile.totalInteractions,
    peakHour:          _profile.peakHour ? `${_profile.peakHour}:00` : null,
    peakDay:           _profile.peakDay,
    topInterests:      _profile.topInterests.slice(0, 8),
    dominantEmotion:   _profile.dominantEmotion,
    stressFrequency:   _profile.stressFrequency,
    prefersShort:      _profile.prefersShort,
    techLevel:         _profile.techLevel,
    languageStyle:     _profile.languageStyle,
    explicitPrefs:     _profile.explicitPrefs.slice(0, 5),
    weeklyPattern:     _profile.weeklyPattern,
    lastUpdated:       _profile.lastUpdated,
    // v2
    identity:          _profile.identity,
    patterns:          _profile.patterns,
    routines:          _profile.routines,
    eventCount:        _profile.events.length,
    moodToday:         _profile.moodLog.filter(m => m.date === _dateStr()).map(m => m.mood),
  };
}

// ── v1: Reset & forceSync (değişmedi) ─────────────────────
function resetProfile() {
  _profile = JSON.parse(JSON.stringify(DEFAULT_PROFILE));
  _save();
  console.log("[UserProfile] 🔄 Profil sıfırlandı.");
}

function forceSync() {
  _syncFromModules();
  _save();
  console.log("[UserProfile] 🔄 Zorla senkronize edildi.");
}

// ── Graceful shutdown ─────────────────────────────────────
process.on("SIGINT",  () => { if (_saveTimer) { clearTimeout(_saveTimer); fs.writeFileSync(PROFILE_FILE, JSON.stringify(_profile, null, 2)); } });
process.on("SIGTERM", () => { if (_saveTimer) { clearTimeout(_saveTimer); fs.writeFileSync(PROFILE_FILE, JSON.stringify(_profile, null, 2)); } });

console.log(`[UserProfile] 👤 v2 yüklendi — ${_profile.totalInteractions} etkileşim | Kimlik: ${_profile.identity?.name || "henüz öğrenilmedi"}`);

module.exports = {
  // v1 — hepsi korundu
  onInteraction,
  tick,
  getProfilePrompt,
  getProfile,
  resetProfile,
  forceSync,
  // v2 yeni
  getProactiveData,
  getMorningSummary,
};