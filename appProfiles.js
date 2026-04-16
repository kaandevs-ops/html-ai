// ============================================================
// 🧩 appProfiles.js — Uygulama Profil Motoru v1.0
//
// Mevcut hiçbir dosyaya dokunmaz.
// server.js'in EN SONUNA şunu ekle:
//
//   const { mountAppProfiles } = require('./appProfiles');
//   mountAppProfiles(app, brain, { exec, isMac, isWindows, isLinux });
//
// Özellikler:
//   ✅ Aktif uygulamayı Mac/Windows/Linux'ta tespit eder
//   ✅ Her uygulama için ayrı AI davranış profili tanımlanır
//   ✅ Brain prompt'una "şu an VS Code açık, kod yazıyorsun" bağlamı eklenir
//   ✅ Proaktif öneriler (VS Code → "bu fonksiyonu test etmemi ister misin?")
//   ✅ Otomatik periyodik tarama veya manuel tetikleme
//   ✅ Kendi profilini de ekleyebilirsin (/appprofile/custom)
// ============================================================

'use strict';

// ── Uygulama profilleri ────────────────────────────────────
// Her profil:
//   apps[]       → bu uygulama adlarından biri açıksa eşleş
//   context      → brain prompt'una eklenecek bağlam metni
//   suggestions  → proaktif öneri havuzu (rastgele birini göster)
//   mood         → emo modülüne söylenecek "şu an X yapıyoruz"
const DEFAULT_PROFILES = {
  vscode: {
    id:   'vscode',
    name: 'VS Code',
    apps: ['Code', 'code', 'Visual Studio Code'],
    context: 'Kullanıcı şu an VS Code\'da kod yazıyor. Teknik, doğrudan ve kısa cevaplar ver. Kod örnekleri kullan.',
    suggestions: [
      'Şu an yazdığın dosyayı analiz etmemi ister misin?',
      'Fonksiyonu test etmemi ister misin?',
      'Kod kalitesini inceleyeyim mi?',
      'Bir sonraki adımı planlayalım mı?',
    ],
    mood:   'focused',
    icon:   '💻',
  },

  cursor: {
    id:   'cursor',
    name: 'Cursor',
    apps: ['Cursor'],
    context: 'Kullanıcı Cursor AI editöründe çalışıyor. Proaktif kod önerileri ve refactoring fikirleri sun.',
    suggestions: [
      'Cursor\'daki kodunu gözden geçireyim mi?',
      'Seni takıldığın yerden çıkarayım mı?',
    ],
    mood:   'focused',
    icon:   '🖱️',
  },

  browser_work: {
    id:   'browser_work',
    name: 'Tarayıcı (İş)',
    apps: ['Safari', 'Google Chrome', 'Firefox', 'Chrome'],
    context: 'Kullanıcı tarayıcıda çalışıyor. Araştırma yapıyor veya bir şey öğreniyor olabilir.',
    suggestions: [
      'Baktığın sayfayı özetleyeyim mi?',
      'Bu konuda daha fazla kaynak bulayım mı?',
    ],
    mood:   'curious',
    icon:   '🌐',
  },

  spotify: {
    id:   'spotify',
    name: 'Spotify',
    apps: ['Spotify'],
    context: 'Kullanıcı müzik dinliyor. Gevşeme modunda, teknik sorulardan uzak olabilir.',
    suggestions: [
      'Odaklanma müziği önereceğim ister misin?',
      'Dinlerken yapmak istediğin bir şey var mı?',
    ],
    mood:   'relaxed',
    icon:   '🎵',
  },

  terminal: {
    id:   'terminal',
    name: 'Terminal',
    apps: ['Terminal', 'iTerm2', 'iTerm', 'Hyper', 'kitty', 'Warp'],
    context: 'Kullanıcı terminalde çalışıyor. Komut satırı yardımı ve sistem işlemleri konusunda proaktif ol.',
    suggestions: [
      'Hangi komutu çalıştırmak istiyorsun?',
      'Hata mesajı varsa yapıştır, çözeyim.',
    ],
    mood:   'focused',
    icon:   '⌨️',
  },

  figma: {
    id:   'figma',
    name: 'Figma',
    apps: ['Figma'],
    context: 'Kullanıcı Figma\'da tasarım yapıyor. UI/UX konularında yardımcı ol, teknik kod odağını azalt.',
    suggestions: [
      'Tasarım için renk paleti önereyim mi?',
      'Component yapısını planlamamı ister misin?',
    ],
    mood:   'creative',
    icon:   '🎨',
  },

  slack: {
    id:   'slack',
    name: 'Slack',
    apps: ['Slack'],
    context: 'Kullanıcı Slack\'te takım iletişimi yapıyor. Kısa ve net mesaj taslakları konusunda yardımcı ol.',
    suggestions: [
      'Mesaj taslağı yazmamı ister misin?',
      'Toplantı özeti hazırlayayım mı?',
    ],
    mood:   'communicative',
    icon:   '💬',
  },

  zoom: {
    id:   'zoom',
    name: 'Zoom / Teams',
    apps: ['zoom', 'Zoom', 'Microsoft Teams', 'Teams'],
    context: 'Kullanıcı şu an toplantıda. Rahatsız etmekten kaçın, bildirimler gönderme.',
    suggestions: [], // toplantıda öneri gönderme
    mood:   'meeting',
    icon:   '📹',
  },

  notes: {
    id:   'notes',
    name: 'Not Uygulaması',
    apps: ['Notes', 'Obsidian', 'Notion', 'Bear', 'Typora'],
    context: 'Kullanıcı not alıyor veya yazı yazıyor. Yazma akışını destekle, alternatif ifadeler veya özetler öner.',
    suggestions: [
      'Yazdıklarını düzenlememi ister misin?',
      'Bu konuda ek bilgi ekleyeyim mi?',
    ],
    mood:   'creative',
    icon:   '📝',
  },
};

// ── Durum ─────────────────────────────────────────────────
const APP_STATE = {
  currentApp:     null,   // { name, profile, detectedAt }
  previousApp:    null,
  customProfiles: {},     // kullanıcının eklediği profiller
  scanInterval:   null,
  scanIntervalMs: 30 * 1000,  // 30 saniye
  enabled:        true,
  lastScan:       null,
  appHistory:     [],     // [{ app, profile, ts, durationMs }]
};

// ── Aktif uygulamayı algıla ───────────────────────────────
async function detectActiveApp(exec, isMac, isWindows, isLinux) {
  if (isMac) {
    return new Promise(resolve => {
      exec(
        `osascript -e 'tell application "System Events" to get name of first application process whose frontmost is true'`,
        { timeout: 5000 },
        (err, stdout) => {
          if (err) return resolve(null);
          resolve((stdout || '').trim().replace(/\n/g, ''));
        }
      );
    });
  }

  if (isWindows) {
    return new Promise(resolve => {
      exec(
        `powershell -NoProfile -Command "Get-Process | Where-Object {$_.MainWindowHandle -ne 0} | Sort-Object CPU -Descending | Select-Object -First 1 -ExpandProperty ProcessName"`,
        { timeout: 5000 },
        (err, stdout) => {
          if (err) return resolve(null);
          resolve((stdout || '').trim());
        }
      );
    });
  }

  if (isLinux) {
    return new Promise(resolve => {
      exec(
        `xdotool getactivewindow getwindowname 2>/dev/null || echo ""`,
        { timeout: 5000 },
        (err, stdout) => {
          if (err) return resolve(null);
          resolve((stdout || '').trim().split('\n')[0]);
        }
      );
    });
  }

  return null;
}

// ── Uygulama adından profil bul ───────────────────────────
function _findProfile(appName) {
  if (!appName) return null;
  const all = { ...DEFAULT_PROFILES, ...APP_STATE.customProfiles };

  for (const profile of Object.values(all)) {
    if ((profile.apps || []).some(a => appName.toLowerCase().includes(a.toLowerCase()))) {
      return profile;
    }
  }
  return null;
}

// ── Uygulama değişti mi? ──────────────────────────────────
function _hasChanged(newApp) {
  return newApp !== APP_STATE.currentApp?.name;
}

// ── Uygulama bağlamını brain prompt'una ekle ─────────────
function getAppContextPrompt() {
  if (!APP_STATE.currentApp?.profile) return '';
  const { profile } = APP_STATE.currentApp;
  return `=== AKTİF UYGULAMA: ${profile.icon || ''} ${profile.name} ===\n${profile.context}`;
}

// ── Proaktif öneri seç ────────────────────────────────────
function getRandomSuggestion(profile) {
  if (!profile?.suggestions?.length) return null;
  const idx = Math.floor(Math.random() * profile.suggestions.length);
  return profile.suggestions[idx];
}

// ══════════════════════════════════════════════════════════
// 🔌 MOUNT
// ══════════════════════════════════════════════════════════
function mountAppProfiles(app, brain, deps = {}) {
  const { exec, isMac, isWindows, isLinux } = deps;

  if (!app || !exec) {
    console.warn('[AppProfiles] ⚠️ Eksik parametre, mount atlandı.');
    return;
  }

  // ── Brain enrichPrompt'unu bağlam ile zenginleştir ────
  // Orijinal enrichPrompt'u sarmalıyoruz — dikkat: sadece EKLE, değiştirme
  const _originalEnrich = brain.enrichPrompt?.bind(brain);
  if (_originalEnrich) {
    brain.enrichPrompt = function (userPrompt) {
      const base   = _originalEnrich(userPrompt);
      const appCtx = getAppContextPrompt();
      if (!appCtx) return base;

      // Prompt içinde zaten bir KULLANICI İSTEĞİ bölümü var, ondan önce ekle
      const marker = '=== KULLANICI İSTEĞİ ===';
      if (base.includes(marker)) {
        return base.replace(marker, appCtx + '\n\n' + marker);
      }
      return appCtx + '\n\n' + base;
    };
    console.log('[AppProfiles] 🧠 brain.enrichPrompt uygulama bağlamıyla genişletildi.');
  }

  // ── Periyodik tarama ──────────────────────────────────
  async function _scan() {
    if (!APP_STATE.enabled) return;

    const appName = await detectActiveApp(exec, isMac, isWindows, isLinux);
    APP_STATE.lastScan = new Date().toISOString();

    if (!appName) return;

    const profile = _findProfile(appName);

    if (_hasChanged(appName)) {
      const previous = APP_STATE.currentApp;

      // Öncekinin süresini hesapla ve geçmişe ekle
      if (previous) {
        const dur = Date.now() - new Date(previous.detectedAt).getTime();
        APP_STATE.appHistory.unshift({
          app:        previous.name,
          profile:    previous.profile?.id || 'unknown',
          detectedAt: previous.detectedAt,
          durationMs: dur,
        });
        if (APP_STATE.appHistory.length > 50) APP_STATE.appHistory.pop();
      }

      APP_STATE.previousApp = previous;
      APP_STATE.currentApp  = {
        name:        appName,
        profile,
        detectedAt:  new Date().toISOString(),
      };

      const profileName = profile?.name || 'Bilinmeyen';
      console.log(`[AppProfiles] 🔄 Uygulama değişti: "${appName}" → profil: ${profileName}`);

      // Brain'e bildir
      try {
        brain.mem.remember(`active_app:current`, appName, 0.5);
        if (profile?.mood) {
          brain.mem.remember('active_app:mood', profile.mood, 0.4);
        }
      } catch (e) {}
    }
  }

  // Taramayı başlat
  APP_STATE.scanInterval = setInterval(_scan, APP_STATE.scanIntervalMs);
  setTimeout(_scan, 3000); // 3 saniye sonra ilk tarama

  // ── Aktif uygulama ────────────────────────────────────
  app.get('/appprofile/current', async (req, res) => {
    const appName = await detectActiveApp(exec, isMac, isWindows, isLinux);
    const profile  = appName ? _findProfile(appName) : null;
    res.json({
      status:    'success',
      appName:   appName || 'Tespit edilemedi',
      profile:   profile ? { id: profile.id, name: profile.name, mood: profile.mood, icon: profile.icon } : null,
      context:   getAppContextPrompt() || null,
      suggestion: profile ? getRandomSuggestion(profile) : null,
    });
  });

  // ── Tüm profiller ─────────────────────────────────────
  app.get('/appprofile/list', (req, res) => {
    const all = { ...DEFAULT_PROFILES, ...APP_STATE.customProfiles };
    const list = Object.values(all).map(p => ({
      id:      p.id,
      name:    p.name,
      icon:    p.icon || '',
      apps:    p.apps,
      mood:    p.mood,
    }));
    res.json({ status: 'success', profiles: list });
  });

  // ── Özel profil ekle ──────────────────────────────────
  app.post('/appprofile/custom', (req, res) => {
    const { id, name, apps, context, suggestions, mood, icon } = req.body;
    if (!id || !name || !apps?.length) {
      return res.json({ status: 'error', message: 'id, name ve apps[] gerekli' });
    }
    APP_STATE.customProfiles[id] = { id, name, apps, context: context || '', suggestions: suggestions || [], mood: mood || 'neutral', icon: icon || '🔲' };
    res.json({ status: 'success', profile: APP_STATE.customProfiles[id] });
  });

  // ── Uygulama geçmişi ──────────────────────────────────
  app.get('/appprofile/history', (req, res) => {
    res.json({ status: 'success', history: APP_STATE.appHistory.slice(0, 20) });
  });

  // ── Manuel tarama tetikle ─────────────────────────────
  app.post('/appprofile/scan', async (req, res) => {
    await _scan();
    res.json({
      status:    'success',
      appName:   APP_STATE.currentApp?.name || null,
      profile:   APP_STATE.currentApp?.profile?.name || null,
      lastScan:  APP_STATE.lastScan,
    });
  });

  // ── Durum ─────────────────────────────────────────────
  app.get('/appprofile/status', (req, res) => {
    res.json({
      status:        'success',
      enabled:       APP_STATE.enabled,
      scanIntervalMs: APP_STATE.scanIntervalMs,
      lastScan:      APP_STATE.lastScan,
      currentApp:    APP_STATE.currentApp
        ? { name: APP_STATE.currentApp.name, profile: APP_STATE.currentApp.profile?.name, since: APP_STATE.currentApp.detectedAt }
        : null,
      customProfileCount: Object.keys(APP_STATE.customProfiles).length,
    });
  });

  // ── Tarama aralığını güncelle ─────────────────────────
  app.post('/appprofile/config', (req, res) => {
    const { scanIntervalMs, enabled } = req.body;
    if (typeof scanIntervalMs === 'number' && scanIntervalMs >= 5000) {
      APP_STATE.scanIntervalMs = scanIntervalMs;
      if (APP_STATE.scanInterval) clearInterval(APP_STATE.scanInterval);
      APP_STATE.scanInterval = setInterval(_scan, scanIntervalMs);
    }
    if (typeof enabled === 'boolean') APP_STATE.enabled = enabled;
    res.json({ status: 'success', scanIntervalMs: APP_STATE.scanIntervalMs, enabled: APP_STATE.enabled });
  });

  // ── Profili sil (sadece custom) ───────────────────────
  app.delete('/appprofile/custom/:id', (req, res) => {
    const id = req.params.id;
    if (!APP_STATE.customProfiles[id]) return res.json({ status: 'error', message: 'Özel profil bulunamadı' });
    delete APP_STATE.customProfiles[id];
    res.json({ status: 'success', message: `"${id}" silindi` });
  });

  console.log('[AppProfiles] 🔌 Mount tamamlandı.');
  console.log('  GET  /appprofile/current       → aktif uygulama + öneri');
  console.log('  GET  /appprofile/list          → tüm profiller');
  console.log('  POST /appprofile/custom        → özel profil ekle');
  console.log('  GET  /appprofile/history       → uygulama geçmişi');
  console.log('  POST /appprofile/scan          → manuel tarama');
  console.log('  GET  /appprofile/status        → durum');
  console.log('  POST /appprofile/config        → tarama aralığı {scanIntervalMs}');
  console.log('  DELETE /appprofile/custom/:id  → özel profili sil');

  return { detectActiveApp, getAppContextPrompt, getRandomSuggestion };
}

// ── Dışarıdan custom profil ekle (customerConfig.js mount öncesi çağırır) ─
function configure(customProfiles = {}) {
  Object.entries(customProfiles).forEach(([id, profile]) => {
    APP_STATE.customProfiles[id] = { id, ...profile };
  });
}

module.exports = { mountAppProfiles, detectActiveApp, getAppContextPrompt, configure };