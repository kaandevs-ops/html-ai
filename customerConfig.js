// ============================================================
// 🎯 customerConfig.js — Müşteri Yapılandırma Sistemi v1.0
//
// Mevcut HİÇBİR orijinal dosyaya dokunmaz.
// server.js'te sadece 2 satır eklenir (en başa, brain require'dan ÖNCE):
//
//   const customerConfig = require('./customerConfig');
//   customerConfig.load();   // ← customer_config.json'u okur, modülleri hazırlar
//
// Sonra mount'lar tamamlandıktan sonra (wss.on'dan SONRA) 1 satır daha:
//
//   customerConfig.applyPost(brain, { createMonitor, runPipeline, savePipeline });
//
// customer_config.json dosyasını proje klasörüne koy ve doldur.
// Örnek: customer_config.example.json
// ============================================================

'use strict';

const fs   = require('fs');
const path = require('path');

const CONFIG_FILE = path.join(process.cwd(), 'customer_config.json');

// ── Yüklenen config ───────────────────────────────────────
let _cfg = null;

// ── Config yükle ──────────────────────────────────────────
function load() {
  if (!fs.existsSync(CONFIG_FILE)) {
    console.log('[CustomerConfig] ℹ️ customer_config.json bulunamadı — varsayılan ayarlar kullanılıyor.');
    return;
  }

  try {
    _cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
    console.log(`[CustomerConfig] ✅ "${_cfg.customerName || 'Müşteri'}" yapılandırması yüklendi.`);
  } catch (e) {
    console.error('[CustomerConfig] ❌ customer_config.json okunamadı:', e.message);
    return;
  }

  // ── 1. dailyRoutine.js config'ini güncelle (mount öncesi) ─
  try {
    const { configure } = require('./dailyRoutine');
    if (_cfg.routine) {
      configure({
        morningHour:  _cfg.routine.morningHour,
        morningMin:   _cfg.routine.morningMin,
        eveningHour:  _cfg.routine.eveningHour,
        eveningMin:   _cfg.routine.eveningMin,
        weatherCity:  _cfg.routine.weatherCity,
        enabled:      _cfg.routine.enabled,
        timezone:     _cfg.timezone || 'Europe/Istanbul',
      });
      console.log('[CustomerConfig] 🌅 Rutin saatleri güncellendi.');
    }
  } catch (e) {
    console.warn('[CustomerConfig] ⚠️ dailyRoutine configure hatası:', e.message);
  }

  // ── 2. appProfiles custom profilleri yükle (mount öncesi) ─
  try {
    const { configure } = require('./appProfiles');
    if (_cfg.appProfiles && Object.keys(_cfg.appProfiles).length > 0) {
      configure(_cfg.appProfiles);
      console.log(`[CustomerConfig] 🧩 ${Object.keys(_cfg.appProfiles).length} özel uygulama profili yüklendi.`);
    }
  } catch (e) {
    console.warn('[CustomerConfig] ⚠️ appProfiles configure hatası:', e.message);
  }
}

// ── USER_MODEL'i güncelle (server.js'ten çağrılır) ────────
function applyUserModel(USER_MODEL) {
  if (!_cfg || !USER_MODEL) return;

  if (typeof _cfg.riskTolerance === 'number') {
    USER_MODEL.riskTolerance = _cfg.riskTolerance;
  }
  if (_cfg.experienceLevel) {
    USER_MODEL.experienceLevel = _cfg.experienceLevel;
  }
  if (Array.isArray(_cfg.approvalRequiredFor)) {
    USER_MODEL.approvalRequiredFor = _cfg.approvalRequiredFor;
  }
  if (_cfg.activeHours && Array.isArray(_cfg.activeHours)) {
    USER_MODEL.dailyRoutine.activeHours = _cfg.activeHours;
  }
  if (typeof _cfg.idleTasksAllowed === 'boolean') {
    USER_MODEL.dailyRoutine.idleTasksAllowed = _cfg.idleTasksAllowed;
  }

  console.log('[CustomerConfig] 👤 USER_MODEL güncellendi.');
}

// ── Mount sonrası uygulamalar (brain, monitor, pipeline) ──
async function applyPost(brain, modules = {}) {
  if (!_cfg) return;

  const { createMonitor, mountedPipeline } = modules;

  // ── 3. Brain kişiliğini ayarla ─────────────────────────
  // NOT: personality.getPersonality() kopya döndürür, doğrudan değiştirilemez.
  // Güvenli yol: brain hafızasına kişilik yönergesi kaydetmek.
  // enrichPrompt() hafızayı okuyarak LLM'e bağlam ekler — bu yeterli.
  try {
    if (_cfg.personality && brain?.mem) {
      const t = _cfg.personality;
      const lines = [];
      if (t.name)                         lines.push(`Asistan adı: ${t.name}`);
      if (typeof t.verbosity   === 'number') lines.push(t.verbosity   < 0.4 ? 'Kısa ve öz cevaplar ver.' : t.verbosity > 0.7 ? 'Detaylı cevaplar ver.' : '');
      if (typeof t.formality   === 'number') lines.push(t.formality   > 0.7 ? 'Resmi ve profesyonel bir dil kullan.' : t.formality < 0.3 ? 'Samimi ve arkadaşça bir dil kullan.' : '');
      if (typeof t.directness  === 'number') lines.push(t.directness  > 0.7 ? 'Direkt ol, doğrudan konuya gir.' : '');
      if (typeof t.humor       === 'number') lines.push(t.humor       > 0.6 ? 'Uygun yerlerde hafif espri kullanabilirsin.' : '');
      if (typeof t.proactivity === 'number') lines.push(t.proactivity > 0.7 ? 'Kullanıcının sormadığı ama işine yarayacak şeyleri de belirt.' : '');

      const toneGuide = lines.filter(Boolean).join(' ');
      if (toneGuide) {
        brain.mem.remember('customer:personality_tone', toneGuide, 0.95);
        console.log('[CustomerConfig] 🎭 Kişilik tonu hafızaya kaydedildi.');
      }
    }
  } catch (e) {
    console.warn('[CustomerConfig] ⚠️ Kişilik ayar hatası:', e.message);
  }

  // ── 4. Özel hedefler ekle (duplicate kontrolü ile) ──────
  try {
    if (Array.isArray(_cfg.goals) && brain?.goals) {
      const existingGoals = brain.goals.getGoals();
      const existingTexts = existingGoals.map(g => (g.goal || '').toLowerCase().trim());
      let added = 0;
      _cfg.goals.forEach(g => {
        const goalText = (g.goal || g || '').toLowerCase().trim();
        // Aynı hedef zaten varsa ekleme
        if (!existingTexts.includes(goalText)) {
          brain.goals.addGoal(g.goal || g, g.priority || 3);
          existingTexts.push(goalText);
          added++;
        }
      });
      if (added > 0) console.log(`[CustomerConfig] 🎯 ${added} yeni hedef eklendi.`);
      else console.log(`[CustomerConfig] 🎯 Hedefler zaten mevcut, duplicate eklenmedi.`);
    }
  } catch (e) {
    console.warn('[CustomerConfig] ⚠️ Hedef ekleme hatası:', e.message);
  }

  // ── 5. Hafızaya müşteri bilgisi kaydet ─────────────────
  try {
    if (brain?.mem && _cfg.customerName) {
      brain.mem.remember('customer:name',     _cfg.customerName,          0.9);
      brain.mem.remember('customer:business', _cfg.businessType || '',    0.9);
      brain.mem.remember('customer:language', _cfg.language    || 'tr',   0.9);
      if (_cfg.customContext) {
        brain.mem.remember('customer:context', _cfg.customContext,         0.9);
      }
      console.log('[CustomerConfig] 🧠 Müşteri bilgisi hafızaya kaydedildi.');
    }
  } catch (e) {
    console.warn('[CustomerConfig] ⚠️ Hafıza kayıt hatası:', e.message);
  }

  // ── 6. Varsayılan monitor'ları kur ─────────────────────
  try {
    if (Array.isArray(_cfg.monitors) && createMonitor) {
      _cfg.monitors.forEach(m => {
        createMonitor(m);
        console.log(`[CustomerConfig] 🌐 Monitor eklendi: "${m.name}"`);
      });
    }
  } catch (e) {
    console.warn('[CustomerConfig] ⚠️ Monitor kurulum hatası:', e.message);
  }

  // ── 7. Varsayılan pipeline'ları kaydet ─────────────────
  try {
    if (Array.isArray(_cfg.pipelines) && mountedPipeline?.save) {
      _cfg.pipelines.forEach(pl => {
        mountedPipeline.save(pl);
        console.log(`[CustomerConfig] 🔁 Pipeline kaydedildi: "${pl.name}"`);
      });
    }
  } catch (e) {
    console.warn('[CustomerConfig] ⚠️ Pipeline kayıt hatası:', e.message);
  }

  console.log(`[CustomerConfig] ✅ "${_cfg.customerName || 'Müşteri'}" tam yapılandırması tamamlandı.`);
}

// ── Yüklü config'i döndür ─────────────────────────────────
function getConfig() { return _cfg; }

// ── Aktif mi? ─────────────────────────────────────────────
function isActive() { return _cfg !== null; }

module.exports = { load, applyUserModel, applyPost, getConfig, isActive };