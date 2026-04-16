// ============================================================
// 🛠️ systemTools.js — Sistem Araçları + AI Öz-Araç Yaratma v1.0
//
// Mevcut HİÇBİR dosyaya dokunmaz. Sadece şunu ekle:
//
//   server.js'e (autoAgent mount'undan SONRA):
//   ─────────────────────────────────────────
//   const { mountSystemTools } = require('./systemTools');
//   mountSystemTools(app, autoAgent, brain, {
//     exec, axios, isMac, isWindows, isLinux, fs, path, PORT
//   });
//
// ÖZELLİKLER:
//   ✅ Uygulama aç / kapat (Steam, Spotify, Chrome, VS Code vb.)
//   ✅ Açık uygulamaları listele
//   ✅ Steam — aç, oyun ara (AppID bul), indir/kur, çalıştır
//   ✅ Video indir (yt-dlp / youtube-dl — otomatik algılar)
//   ✅ Genel dosya indir (curl/PowerShell)
//   ✅ Dosya / URL aç (OS default)
//   ✅ Ses seviyesi ayarla
//   ✅ Ekran görüntüsü al
//   ✅ AI öz-araç yaratma (Ollama yeni araç kodu yazar → kaydedilir → aktif olur)
//   ✅ Otomatik araç geliştirme (evolve_tool)
//   ✅ Önceki oturumdan kaydedilmiş araçları yükle
//   ✅ Brain ile tam entegre (başarı/hata öğrenmesi, hafıza)
//   ✅ autonomous_agent AUTO_TOOLS'a otomatik enjeksiyon
//   ✅ brain.enrichPrompt'a araç listesi eklenir — Ollama araçları bilir
//   ✅ /ollama/ask yanıtlarında [SYSCALL:{...}] pattern'i yakalar ve çalıştırır
//   ✅ Mac / Windows / Linux tam uyumlu
//   ✅ appProfiles.js ile uyumlu (Steam profili eklenir)
//
// API ENDPOINTLERİ:
//   POST   /system/execute              → Araç direkt çalıştır {tool, args}
//   POST   /system/nl                  → Doğal dil komutu {command} → Ollama parse eder
//   GET    /system/tools               → Tüm araç listesi
//   POST   /system/tools/create        → Yeni araç yaz {name, description, code}
//   POST   /system/tools/evolve        → AI araç geliştir {task}
//   DELETE /system/tools/:name         → Oluşturulan aracı sil
//   POST   /system/steam/install       → Steam oyun kur {query} veya {appId}
//   POST   /system/steam/run           → Steam oyun başlat {query} veya {appId}
//   GET    /system/steam/search        → Steam oyun ara ?query=...
//   POST   /system/download/video      → Video indir {url, quality}
//   POST   /system/open/app            → Uygulama aç {appName}
//   POST   /system/open/url            → URL aç {url}
//   POST   /system/open/file           → Dosya aç {filePath}
// ============================================================

'use strict';

// ── Modül düzeyinde bağımlılıklar ──────────────────────────
const pathMod   = require('path');
const { execSync } = require('child_process');

// ══════════════════════════════════════════════════════════════
// 🔌 MOUNT FONKSİYONU
// ══════════════════════════════════════════════════════════════
function mountSystemTools(app, autoAgent, brain, deps = {}) {
  const { exec, axios, isMac, isWindows, isLinux, fs, path, PORT } = deps;

  // Model & Ollama adresi (server.js ile aynı env)
  const MODEL  = process.env.OLLAMA_MODEL || 'llama3.1:8b';
  const OLLAMA = 'http://localhost:11434';

  // Oluşturulan araçların dizini
  const TOOLS_DIR = pathMod.join(process.cwd(), 'tools_generated');
  if (!fs.existsSync(TOOLS_DIR)) fs.mkdirSync(TOOLS_DIR, { recursive: true });

  // ── Log yardımcısı ─────────────────────────────────────────
  function sysLog(msg, level = 'info') {
    const icons = { info: '🔵', success: '✅', error: '❌', warn: '⚠️', tool: '🛠️' };
    console.log(`[SystemTools] ${icons[level] || '•'} ${msg}`);
    if (brain) {
      try { brain.mem.remember('systool:log:' + Date.now(), msg.slice(0, 100), 0.3); } catch (_) {}
    }
  }

  // ── Shell komutu çalıştır (promise) ───────────────────────
  function _exec(cmd, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      exec(cmd, { timeout: timeoutMs }, (err, stdout, stderr) => {
        if (err) return reject(new Error((stderr || err.message).slice(0, 400)));
        resolve((stdout || 'ok').trim().slice(0, 3000));
      });
    });
  }

  // ── Cross-platform komut üreticiler ───────────────────────

  // Herhangi bir dosya / URL'yi varsayılan uygulamayla aç
  function _openCmd(target) {
    const safe = target.replace(/"/g, '\\"');
    if (isMac)     return `open "${safe}"`;
    if (isWindows) return `start "" "${safe}"`;
    return `xdg-open "${safe}"`;
  }

  // Uygulama adına göre aç
  function _openAppCmd(appName) {
    const safe = appName.replace(/"/g, '\\"');
    if (isMac)     return `open -a "${safe}"`;
    if (isWindows) return `powershell -NoProfile -Command "Start-Process '${safe}'"`;
    return `${safe} &`;        // Linux: binary adını direkt çalıştır
  }

  // Uygulama kapat
  function _killAppCmd(appName) {
    const safe = appName.replace(/"/g, '\\"');
    if (isMac)     return `osascript -e 'quit app "${safe}"' 2>/dev/null || pkill -f "${safe}"`;
    if (isWindows) return `powershell -NoProfile -Command "Stop-Process -Name '${safe}' -Force -ErrorAction SilentlyContinue"`;
    return `pkill -f "${safe}"`;
  }

  // Açık uygulamaları listele
  function _listAppsCmd() {
    if (isMac)     return `osascript -e 'tell application "System Events" to get name of every application process whose background only is false'`;
    if (isWindows) return `powershell -NoProfile -Command "Get-Process | Where-Object {$_.MainWindowHandle -ne 0} | Select-Object -ExpandProperty ProcessName | Sort-Object -Unique"`;
    return `wmctrl -l 2>/dev/null | awk '{print $NF}' | sort -u || ps ax -o comm | sort -u | head -30`;
  }

  // Ses komutu
  function _volumeCmd(level) {
    if (isMac)     return `osascript -e 'set volume output volume ${level}'`;
    if (isWindows) return `powershell -NoProfile -Command "(New-Object -ComObject WScript.Shell).SendKeys([char]173)"`;
    // Linux: PulseAudio
    return `pactl set-sink-volume @DEFAULT_SINK@ ${level}%`;
  }

  // yt-dlp / youtube-dl varlık kontrolü (sync, sadece bir kez)
  let _downloader = null;
  function _findDownloader() {
    if (_downloader) return _downloader;
    try { execSync('yt-dlp --version', { stdio: 'pipe' }); _downloader = 'yt-dlp'; return _downloader; } catch (_) {}
    try { execSync('youtube-dl --version', { stdio: 'pipe' }); _downloader = 'youtube-dl'; return _downloader; } catch (_) {}
    return null;
  }

  // ══════════════════════════════════════════════════════════
  // 🛠️ ARAÇ DEFİNİSYONLARI
  // ══════════════════════════════════════════════════════════
  const SYSTEM_TOOLS = {

    // ────────────────────────────────────────────────────────
    // UYGULAMA KONTROL
    // ────────────────────────────────────────────────────────

    /**
     * Herhangi bir uygulamayı aç
     * args: { appName: "Steam" | "Spotify" | "Chrome" | ... }
     */
    open_app: async (args) => {
      const { appName } = args;
      if (!appName) throw new Error('appName gerekli (örn: Steam, Spotify, Chrome)');
      sysLog(`Uygulama açılıyor: "${appName}"`, 'tool');
      await _exec(_openAppCmd(appName), 15000);
      if (brain) { try { brain.learn(`open_app:${appName}`, 'başarıyla açıldı'); } catch (_) {} }
      return `✅ "${appName}" açıldı. (Yüklenme birkaç saniye sürebilir.)`;
    },

    /**
     * Uygulamayı kapat
     * args: { appName: "Steam" }
     */
    close_app: async (args) => {
      const { appName } = args;
      if (!appName) throw new Error('appName gerekli');
      sysLog(`Uygulama kapatılıyor: "${appName}"`, 'tool');
      await _exec(_killAppCmd(appName), 10000);
      return `✅ "${appName}" kapatıldı.`;
    },

    /**
     * Şu an açık olan uygulamaları listele
     * args: {}
     */
    list_apps: async (_args) => {
      sysLog('Açık uygulamalar listeleniyor', 'tool');
      const result = await _exec(_listAppsCmd(), 10000);
      return `Açık uygulamalar:\n${result}`;
    },

    // ────────────────────────────────────────────────────────
    // STEAM
    // ────────────────────────────────────────────────────────

    /**
     * Steam'i aç
     * args: {}
     */
    steam_open: async (_args) => {
      sysLog('Steam açılıyor', 'tool');
      // Önce uygulama olarak dene, olmazsa steam:// protokolü
      try {
        await _exec(_openAppCmd('Steam'), 10000);
      } catch (_) {
        await _exec(_openCmd('steam://open/main'), 10000);
      }
      if (brain) { try { brain.mem.remember('steam:opened', new Date().toISOString(), 0.5); } catch (_) {} }
      return '✅ Steam açıldı.';
    },

    /**
     * Steam Store'da oyun ara → AppID döndür
     * args: { query: "Counter-Strike 2" }
     */
    steam_search: async (args) => {
      const { query } = args;
      if (!query) throw new Error('query gerekli (örn: {"query":"Counter-Strike 2"})');
      sysLog(`Steam\'de aranıyor: "${query}"`, 'tool');

      const r = await axios.get(
        `https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(query)}&l=turkish&cc=TR`,
        { timeout: 12000 }
      );

      const items = (r.data?.items || []).slice(0, 6);
      if (items.length === 0) return `"${query}" için Steam sonucu bulunamadı.`;

      // İlk sonucu brain'e önbellekle (steam_install / steam_run için)
      if (brain && items[0]) {
        try { brain.mem.remember(`steam:search:${query.toLowerCase()}`, `${items[0].name}|||${items[0].id}`, 0.8); } catch (_) {}
      }

      const list = items.map(i => `• ${i.name}  (AppID: ${i.id}  |  tür: ${i.type || 'game'})`).join('\n');
      return `Steam arama: "${query}"\n${list}`;
    },

    /**
     * Steam oyununu indir / kur
     * args: { query: "Counter-Strike 2" } VEYA { appId: 730 }
     * Steam açık olmalı; kurulum onay penceresi çıkabilir.
     */
    steam_install: async (args) => {
      const { appId, query } = args;
      let targetId = appId;

      if (!targetId && query) {
        // Önce brain önbelleğine bak
        if (brain) {
          try {
            const cached = brain.mem.recall(`steam:search:${query.toLowerCase()}`, 1);
            if (cached?.length > 0) {
              const parts = cached[0].value.split('|||');
              if (parts[1]) { targetId = parseInt(parts[1]); sysLog(`Önbellekten AppID: ${targetId}`); }
            }
          } catch (_) {}
        }

        // Önbellekte yoksa Steam API'ye sor
        if (!targetId) {
          sysLog(`AppID bulunamadı, Steam Store aranıyor: "${query}"`, 'tool');
          const r = await axios.get(
            `https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(query)}&l=turkish&cc=TR`,
            { timeout: 12000 }
          );
          const first = r.data?.items?.[0];
          if (!first) return `"${query}" oyunu Steam\'de bulunamadı.`;
          targetId = first.id;
          sysLog(`Bulunan: "${first.name}"  AppID: ${targetId}`);
          if (brain) {
            try { brain.mem.remember(`steam:search:${query.toLowerCase()}`, `${first.name}|||${first.id}`, 0.8); } catch (_) {}
          }
        }
      }

      if (!targetId) throw new Error('appId veya query gerekli');

      // Steam kurulum protokolü
      const steamUrl = `steam://install/${targetId}`;
      sysLog(`Steam kurulum URL: ${steamUrl}`, 'tool');
      await _exec(_openCmd(steamUrl), 15000);

      if (brain) {
        try {
          brain.mem.remember(`steam:install:${targetId}`, `kurulum başlatıldı ${new Date().toISOString()}`, 0.9);
          brain.emo.onSuccess();
        } catch (_) {}
      }

      return `✅ Steam kurulum başlatıldı (AppID: ${targetId}).\nSteam ekranında onay vermeni bekliyor olabilir.`;
    },

    /**
     * Kurulu Steam oyununu başlat
     * args: { query: "Counter-Strike 2" } VEYA { appId: 730 }
     */
    steam_run: async (args) => {
      const { appId, query } = args;
      let targetId = appId;

      if (!targetId && query) {
        // Önbellek
        if (brain) {
          try {
            const cached = brain.mem.recall(`steam:search:${query.toLowerCase()}`, 1);
            if (cached?.length > 0) {
              const parts = cached[0].value.split('|||');
              if (parts[1]) targetId = parseInt(parts[1]);
            }
          } catch (_) {}
        }

        if (!targetId) {
          const r = await axios.get(
            `https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(query)}&l=turkish&cc=TR`,
            { timeout: 12000 }
          );
          const first = r.data?.items?.[0];
          if (!first) return `"${query}" oyunu bulunamadı.`;
          targetId = first.id;
        }
      }

      if (!targetId) throw new Error('appId veya query gerekli');

      const steamUrl = `steam://run/${targetId}`;
      sysLog(`Oyun başlatılıyor: steam://run/${targetId}`, 'tool');
      await _exec(_openCmd(steamUrl), 15000);

      if (brain) { try { brain.emo.onSuccess(); } catch (_) {} }
      return `✅ Oyun başlatıldı (AppID: ${targetId}). Steam yüklüyorsa biraz bekle.`;
    },

    // ────────────────────────────────────────────────────────
    // VİDEO / DOSYA İNDİRME
    // ────────────────────────────────────────────────────────

    /**
     * YouTube veya herhangi bir video URL'sini indir (yt-dlp kullanır)
     * args: { url: "https://...", quality: "best|1080p|720p|audio", outputDir: "/path/" }
     * yt-dlp yoksa kurulum talimatı döner.
     */
    download_video: async (args) => {
      const { url, quality = 'best', outputDir } = args;
      if (!url) throw new Error('url gerekli');

      const dl = _findDownloader();
      if (!dl) {
        return [
          '⚠️ yt-dlp kurulu değil.',
          'Kurmak için:',
          '  Mac:     brew install yt-dlp',
          '  Windows: winget install yt-dlp  (veya pip install yt-dlp)',
          '  Linux:   pip install yt-dlp',
        ].join('\n');
      }

      const outDir = outputDir
        || (process.env.HOME ? pathMod.join(process.env.HOME, 'Downloads') : process.cwd());

      // Format seçici
      let fmtFlag = '';
      if (quality === '1080p') {
        fmtFlag = '-f "bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/best[height<=1080]"';
      } else if (quality === '720p') {
        fmtFlag = '-f "bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/best[height<=720]"';
      } else if (quality === 'audio') {
        fmtFlag = '-f "bestaudio[ext=m4a]/bestaudio" -x --audio-format mp3';
      } else {
        fmtFlag = '-f "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best"';
      }

      const cmd = `${dl} ${fmtFlag} --no-playlist -o "${outDir}/%(title)s.%(ext)s" "${url.replace(/"/g, '\\"')}"`;
      sysLog(`Video indiriliyor: ${url.slice(0, 70)}`, 'tool');

      try {
        const result = await _exec(cmd, 10 * 60 * 1000); // 10 dakika timeout
        if (brain) {
          try {
            brain.mem.remember(`download:video:${url.slice(0, 60)}`, outDir, 0.7);
            brain.learn('download_video', `${url.slice(0, 60)} → ${outDir}`);
          } catch (_) {}
        }
        return `✅ Video indirildi: ${outDir}\n\n${result.slice(-500)}`;
      } catch (e) {
        if (brain) { try { brain.onError('download_video', url, e.message); } catch (_) {} }
        throw e;
      }
    },

    /**
     * Genel dosya indir (curl / PowerShell Invoke-WebRequest)
     * args: { url: "https://...", outputPath: "/path/file.zip" }
     */
    download_file: async (args) => {
      const { url, outputPath } = args;
      if (!url) throw new Error('url gerekli');

      const fileName = (url.split('/').pop() || `file_${Date.now()}`).split('?')[0];
      const outFile  = outputPath
        || pathMod.join(process.env.HOME
          ? pathMod.join(process.env.HOME, 'Downloads')
          : process.cwd(), fileName);

      sysLog(`Dosya indiriliyor: ${url.slice(0, 70)} → ${outFile}`, 'tool');

      let cmd;
      if (isMac || isLinux) {
        cmd = `curl -L --progress-bar -o "${outFile}" "${url.replace(/"/g, '\\"')}"`;
      } else {
        cmd = `powershell -NoProfile -Command "Invoke-WebRequest -Uri '${url}' -OutFile '${outFile}'"`;
      }

      await _exec(cmd, 10 * 60 * 1000);

      if (brain) { try { brain.mem.remember(`download:file:${url.slice(0, 60)}`, outFile, 0.7); } catch (_) {} }
      return `✅ Dosya indirildi: ${outFile}`;
    },

    // ────────────────────────────────────────────────────────
    // AÇMA / GEZİNME
    // ────────────────────────────────────────────────────────

    /**
     * Dosyayı varsayılan uygulamayla aç
     * args: { filePath: "/path/to/file.mp4" }
     */
    open_file: async (args) => {
      const { filePath } = args;
      if (!filePath) throw new Error('filePath gerekli');
      if (!fs.existsSync(filePath)) return `Dosya bulunamadı: ${filePath}`;
      sysLog(`Dosya açılıyor: ${filePath}`, 'tool');
      await _exec(_openCmd(filePath), 10000);
      return `✅ Dosya açıldı: ${filePath}`;
    },

    /**
     * URL'yi varsayılan tarayıcıda aç
     * args: { url: "https://..." }
     */
    open_url: async (args) => {
      const { url } = args;
      if (!url) throw new Error('url gerekli');
      sysLog(`URL açılıyor: ${url.slice(0, 80)}`, 'tool');
      await _exec(_openCmd(url), 10000);
      return `✅ Açıldı: ${url}`;
    },

    // ────────────────────────────────────────────────────────
    // SİSTEM
    // ────────────────────────────────────────────────────────

    /**
     * Sistem ses seviyesini ayarla
     * args: { level: 50 }   (0–100)
     */
    set_volume: async (args) => {
      let level = Math.max(0, Math.min(100, parseInt(args.level) || 50));
      sysLog(`Ses: ${level}%`, 'tool');
      const cmd = _volumeCmd(level);
      const finalCmd = isWindows ? `powershell -NoProfile -Command "${cmd}"` : cmd;
      await _exec(finalCmd, 8000);
      return `✅ Ses seviyesi: ${level}%`;
    },

    /**
     * Ekran görüntüsü al
     * args: { outputPath: "/path/screen.png" }
     */
    take_screenshot: async (args) => {
      const outFile = args.outputPath || pathMod.join(
        process.env.HOME || process.cwd(),
        `screenshot_${Date.now()}.png`
      );
      sysLog('Ekran görüntüsü alınıyor', 'tool');

      let cmd;
      if (isMac)          cmd = `screencapture -x "${outFile}"`;
      else if (isWindows) cmd = `powershell -NoProfile -Command "Add-Type -AssemblyName System.Windows.Forms; $bmp = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds; $bitmap = New-Object System.Drawing.Bitmap($bmp.Width, $bmp.Height); $g = [System.Drawing.Graphics]::FromImage($bitmap); $g.CopyFromScreen(0,0,0,0,$bmp.Size); $bitmap.Save('${outFile}')"`;
      else                cmd = `scrot "${outFile}" 2>/dev/null || import -window root "${outFile}"`;

      try {
        await _exec(cmd, 15000);
        return `✅ Ekran görüntüsü: ${outFile}`;
      } catch (e) {
        return `⚠️ Ekran görüntüsü alınamadı: ${e.message}`;
      }
    },

    /**
     * Kayıtlı ve enjekte edilmiş araçları listele
     * args: {}
     */
    list_tools: async (_args) => {
      const builtIn  = Object.keys(SYSTEM_TOOLS);
      const agent    = autoAgent ? Object.keys(autoAgent.AUTO_TOOLS || {}) : [];
      const all      = [...new Set([...builtIn, ...agent])].sort();
      return `Mevcut araçlar (${all.length} adet):\n${all.map(t => `  • ${t}`).join('\n')}`;
    },

    // ────────────────────────────────────────────────────────
    // AI ÖZ-ARAÇ YARATMA
    // ────────────────────────────────────────────────────────

    /**
     * AI tarafından yazılan yeni aracı kaydet ve aktif et.
     * args: {
     *   name:        "araç_adı",          // sadece küçük harf + alt çizgi
     *   description: "ne yapar",
     *   code:        "const x = args.x; return x + ' yapıldı';"
     * }
     * Kod: async function gövdesi (return ile bitmeli, string döndürmeli)
     */
    self_create_tool: async (args) => {
      const { name, description = '', code } = args;
      if (!name || !code) throw new Error('name ve code gerekli');
      if (!/^[a-z_][a-z0-9_]*$/.test(name)) {
        throw new Error('Araç adı: sadece küçük harf, rakam, alt çizgi. Örn: "my_tool"');
      }

      const toolFile = pathMod.join(TOOLS_DIR, `${name}.js`);

      const fileContent = [
        `// Auto-generated tool: ${name}`,
        `// Description: ${description}`,
        `// Created: ${new Date().toISOString()}`,
        `'use strict';`,
        ``,
        `module.exports = {`,
        `  name: '${name}',`,
        `  description: ${JSON.stringify(description)},`,
        `  handler: async function(args) {`,
        // Her satırı 4 boşlukla girintile
        ...code.split('\n').map(l => '    ' + l),
        `  }`,
        `};`,
      ].join('\n');

      fs.writeFileSync(toolFile, fileContent, 'utf8');
      sysLog(`Araç dosyası yazıldı: ${toolFile}`, 'tool');

      // Dinamik yükle
      try {
        // Önce cache'i temizle (güncellenmiş olabilir)
        const resolved = require.resolve(toolFile);
        delete require.cache[resolved];
        const toolModule = require(toolFile);

        if (!toolModule.handler || typeof toolModule.handler !== 'function') {
          throw new Error('handler fonksiyon değil');
        }

        // AUTO_TOOLS'a ekle
        if (autoAgent && autoAgent.AUTO_TOOLS) {
          autoAgent.AUTO_TOOLS[name] = toolModule.handler;
        }
        // SYSTEM_TOOLS'a da ekle (bu oturumda çağrılabilsin)
        SYSTEM_TOOLS[name] = toolModule.handler;

        if (brain) {
          try {
            brain.mem.remember(`tool:created:${name}`, description.slice(0, 100), 0.9);
            brain.learn(`self_create_tool:${name}`, `${name} aracı oluşturuldu ve aktif edildi`);
          } catch (_) {}
        }

        sysLog(`Araç aktif: ${name}`, 'success');
        return `✅ Yeni araç oluşturuldu ve aktif edildi: "${name}"\n📁 Dosya: ${toolFile}\n📝 Açıklama: ${description || '-'}`;
      } catch (e) {
        // Hatalı dosyayı sil
        try { fs.unlinkSync(toolFile); } catch (_) {}
        sysLog(`Araç kodu geçersiz: ${e.message}`, 'error');
        throw new Error(`Araç kodu çalıştırılamadı: ${e.message}\n\nKod önizlemesi:\n${code.slice(0, 300)}`);
      }
    },

    /**
     * Ollama'dan yeni bir araç geliştirmesini iste.
     * args: { task: "Steam library'deki oyunları listele" }
     * Ollama araç kodunu yazar, self_create_tool ile kaydeder.
     */
    evolve_tool: async (args) => {
      const { task } = args;
      if (!task) throw new Error('task (görev açıklaması) gerekli');

      sysLog(`Araç geliştiriliyor: "${task}"`, 'tool');

      const existingList = Object.keys(autoAgent?.AUTO_TOOLS || {})
        .concat(Object.keys(SYSTEM_TOOLS))
        .filter((v, i, a) => a.indexOf(v) === i)
        .join(', ');

      const prompt = [
        `Sen bir Node.js araç yazarısın. Mevcut araçlar: ${existingList}`,
        ``,
        `Görev: "${task}"`,
        ``,
        `Bu görevi yapan YENİ bir Node.js aracı yaz.`,
        `Platform: ${isMac ? 'Mac' : isWindows ? 'Windows' : 'Linux'}`,
        ``,
        `SADECE şu formatta yanıt ver (başka hiçbir şey yazma):`,
        `TOOL_NAME: araç_adı_küçük_harf_alt_çizgi`,
        `DESCRIPTION: kısa açıklama (1 satır)`,
        `CODE:`,
        `\`\`\`javascript`,
        `// args: {paramAdı: tip, ...} şeklinde parametreler`,
        `// Bu async fonksiyonun gövdesi — return string döndürmeli`,
        `const result = 'örnek';`,
        `return result;`,
        `\`\`\``,
      ].join('\n');

      const r = await axios.post(OLLAMA + '/api/generate', {
        model: MODEL,
        stream: false,
        prompt,
        options: { temperature: 0.3, num_predict: 800 }
      });

      const response = r.data.response || '';

      const nameMatch = response.match(/TOOL_NAME:\s*([a-z_][a-z0-9_]*)/);
      const descMatch = response.match(/DESCRIPTION:\s*(.+)/);
      const codeMatch = response.match(/```javascript\n([\s\S]*?)```/);

      if (!nameMatch || !codeMatch) {
        return `⚠️ Araç geliştirilemedi. Ollama yanıtı beklenmedik formatta:\n${response.slice(0, 400)}`;
      }

      const toolName = nameMatch[1].trim();
      const toolDesc = descMatch ? descMatch[1].trim() : task;
      const toolCode = codeMatch[1].trim();

      return await SYSTEM_TOOLS.self_create_tool({
        name:        toolName,
        description: toolDesc,
        code:        toolCode
      });
    },

  }; // ── SYSTEM_TOOLS sonu ──────────────────────────────────

  // ══════════════════════════════════════════════════════════
  // autonomous_agent AUTO_TOOLS'a enjekte et
  // ══════════════════════════════════════════════════════════
  if (autoAgent && autoAgent.AUTO_TOOLS) {
    Object.assign(autoAgent.AUTO_TOOLS, SYSTEM_TOOLS);
    sysLog(`${Object.keys(SYSTEM_TOOLS).length} araç AUTO_TOOLS\'a eklendi ✅`, 'success');
  } else {
    sysLog('autoAgent.AUTO_TOOLS bulunamadı — araçlar sadece /system/* endpoint\'lerinde aktif', 'warn');
  }

  // ══════════════════════════════════════════════════════════
  // Kaydedilmiş araçları yükle (önceki oturumdan)
  // ══════════════════════════════════════════════════════════
  (() => {
    try {
      const files = fs.readdirSync(TOOLS_DIR).filter(f => f.endsWith('.js'));
      let loaded = 0;
      files.forEach(f => {
        try {
          const fullPath = pathMod.join(TOOLS_DIR, f);
          delete require.cache[require.resolve(fullPath)];
          const mod = require(fullPath);
          if (mod.name && typeof mod.handler === 'function') {
            SYSTEM_TOOLS[mod.name] = mod.handler;
            if (autoAgent?.AUTO_TOOLS) autoAgent.AUTO_TOOLS[mod.name] = mod.handler;
            loaded++;
          }
        } catch (e) {
          sysLog(`Kaydedilmiş araç yüklenemedi: ${f} — ${e.message}`, 'warn');
        }
      });
      if (loaded > 0) sysLog(`${loaded} kaydedilmiş araç yüklendi`);
    } catch (_) {}
  })();

  // ══════════════════════════════════════════════════════════
  // brain.enrichPrompt → araç listesini Ollama'ya bildir
  // Ollama yanıtında [SYSCALL:{...}] kullanırsa otomatik çalışır
  // ══════════════════════════════════════════════════════════
  if (brain && typeof brain.enrichPrompt === 'function') {
    const _origEnrich = brain.enrichPrompt.bind(brain);

    brain.enrichPrompt = function (userPrompt) {
      const base = _origEnrich(userPrompt);

      // Dinamik araç listesi (her çağrıda güncel)
      const toolLines = [
        `• open_app       : {"appName":"Steam|Spotify|Chrome|..."} → Uygulama aç`,
        `• close_app      : {"appName":"..."} → Uygulama kapat`,
        `• list_apps      : {} → Açık uygulamaları listele`,
        `• steam_open     : {} → Steam\'i aç`,
        `• steam_search   : {"query":"oyun adı"} → Steam\'de oyun ara`,
        `• steam_install  : {"query":"oyun adı"} | {"appId":730} → Oyunu indir/kur`,
        `• steam_run      : {"query":"oyun adı"} | {"appId":730} → Oyunu başlat`,
        `• download_video : {"url":"...","quality":"best|1080p|720p|audio"} → Video indir`,
        `• download_file  : {"url":"...","outputPath":"..."} → Dosya indir`,
        `• open_file      : {"filePath":"..."} → Dosya aç`,
        `• open_url       : {"url":"..."} → URL aç`,
        `• set_volume     : {"level":50} → Ses ayarla (0-100)`,
        `• take_screenshot: {} → Ekran görüntüsü al`,
        `• list_tools     : {} → Tüm araçları listele`,
        `• self_create_tool: {"name":"araç_adı","description":"...","code":"..."} → Yeni araç kaydet`,
        `• evolve_tool    : {"task":"ne yapmasını istiyorsun"} → AI yeni araç yazar`,
      ];

      const toolBlock = [
        `=== SİSTEM ARAÇLARI ===`,
        `Bir sistem eylemi yapmak istersen yanıtına SADECE şu tag'i ekle:`,
        `[SYSCALL:{"tool":"araç_adı","args":{...}}]`,
        ``,
        `Mevcut araçlar:`,
        ...toolLines,
        `=== /SİSTEM ARAÇLARI ===`,
      ].join('\n');

      // brain/index.js enrichPrompt'unun eklediği "=== KULLANICI İSTEĞİ ===" marker'ından önce ekle
      const marker = '=== KULLANICI İSTEĞİ ===';
      if (base.includes(marker)) {
        return base.replace(marker, toolBlock + '\n\n' + marker);
      }
      return toolBlock + '\n\n' + base;
    };

    sysLog('brain.enrichPrompt araç listesiyle genişletildi ✅');
  }

  // ══════════════════════════════════════════════════════════
  // RESPONSE INTERCEPTOR — [SYSCALL:{...}] yakala ve çalıştır
  // Express router stack'e /ollama/ask'tan ÖNCE enjekte edilir
  // ══════════════════════════════════════════════════════════

  /** Tek bir SYSCALL'u çalıştır */
  async function _runSysCall(toolCall) {
    const { tool, args } = toolCall;
    const fn = SYSTEM_TOOLS[tool] || autoAgent?.AUTO_TOOLS?.[tool];
    if (!fn) return `❌ Araç bulunamadı: "${tool}". /system/tools ile listeyi gör.`;
    try {
      const result = await fn(args || {});
      if (brain) { try { brain.emo.onSuccess(); } catch (_) {} }
      return result;
    } catch (e) {
      if (brain) { try { brain.onError('syscall', tool, e.message); } catch (_) {} }
      return `❌ "${tool}" hatası: ${e.message}`;
    }
  }

  /** JSON yanıtından [SYSCALL:{...}] etiketlerini bul, çalıştır, mesajı güncelle */
  async function _processSysCalls(data) {
    // Yanıtta mesajı tut olan alanları dene
    const MSG_FIELDS = ['message', 'answer', 'response', 'text', 'reply'];
    let fieldName = null;
    let rawMsg    = '';

    for (const f of MSG_FIELDS) {
      if (typeof data[f] === 'string') {
        fieldName = f;
        rawMsg    = data[f];
        break;
      }
    }

    if (!fieldName || !rawMsg.includes('[SYSCALL:')) return data;

    const syscallRe = /\[SYSCALL:([\s\S]*?)\]/g;
    let match;
    let processedMsg = rawMsg;
    const results   = [];

    while ((match = syscallRe.exec(rawMsg)) !== null) {
      try {
        const toolCall = JSON.parse(match[1]);
        sysLog(`SYSCALL yakalandı: "${toolCall.tool}" args=${JSON.stringify(toolCall.args || {}).slice(0, 80)}`);
        const result = await _runSysCall(toolCall);
        results.push(result);
        processedMsg = processedMsg.replace(match[0], '');
      } catch (parseErr) {
        sysLog(`SYSCALL JSON parse hatası: ${parseErr.message}`, 'warn');
        processedMsg = processedMsg.replace(match[0], '');
        results.push(`⚠️ SYSCALL parse hatası: ${parseErr.message}`);
      }
    }

    if (results.length === 0) return data;

    const cleanMsg  = processedMsg.trim();
    const toolOutput = results.join('\n\n');
    const newMsg    = (cleanMsg ? cleanMsg + '\n\n' : '') + toolOutput;

    return { ...data, [fieldName]: newMsg, _syscallExecuted: true };
  }

  // Interceptor middleware
  const _interceptorMiddleware = function (req, res, next) {
    // Sadece POST isteklerini ilgilendir
    if (req.method !== 'POST') return next();

    const _origJson = res.json.bind(res);

    res.json = async function (data) {
      // data object değilse dokunma
      if (!data || typeof data !== 'object') return _origJson(data);
      try {
        const processed = await _processSysCalls(data);
        return _origJson(processed);
      } catch (e) {
        sysLog(`Interceptor iç hatası: ${e.message}`, 'warn');
        return _origJson(data);
      }
    };

    next();
  };

  // Router stack'e /ollama/ask route'undan ÖNCE yerleştir
  try {
    const stack = app._router && app._router.stack;
    if (stack) {
      const askIdx = stack.findIndex(
        l => l.route && l.route.path === '/ollama/ask' &&
             l.route.methods && l.route.methods.post
      );

      // Express'in kullandığı Layer benzeri nesne
      const layerObj = {
        handle:  _interceptorMiddleware,
        name:    'systemToolsInterceptor',
        params:  undefined,
        path:    undefined,
        keys:    [],
        regexp:  { fast_slash: true, fast_star: false, test: () => true },
        route:   undefined,
      };

      if (askIdx > -1) {
        stack.splice(askIdx, 0, layerObj);
        sysLog(`Interceptor /ollama/ask route\'undan önce eklendi (stack[${askIdx}])`, 'success');
      } else {
        // Route bulunamadı — sonuna ekle, tüm POST yanıtlarını tarar
        stack.push(layerObj);
        sysLog('Interceptor router stack sonuna eklendi (genel POST)', 'warn');
      }
    }
  } catch (e) {
    sysLog(`Router injection hatası: ${e.message}`, 'warn');
  }

  // appProfiles.js varsa Steam profilini ekle
  try {
    const appProfilesModule = require('./appProfiles');
    if (typeof appProfilesModule.configure === 'function') {
      appProfilesModule.configure({
        steam: {
          name:        'Steam',
          apps:        ['Steam', 'steam', 'steamwebhelper'],
          context:     'Kullanıcı Steam\'de. Oyun tavsiyeleri, fiyat/indirim bilgisi, oyun kıyaslamaları konusunda yardımcı ol.',
          suggestions: ['Yeni çıkan oyunlara bakayım mı?', 'İndirimli oyunları listeleyelim mi?', 'Oyun tavsiyesi vermemi ister misin?'],
          mood:        'gaming',
          icon:        '🎮',
        },
      });
      sysLog('Steam profili appProfiles\'a eklendi');
    }
  } catch (_) {}

  // ══════════════════════════════════════════════════════════
  // EXPRESS API ENDPOINTLERİ
  // ══════════════════════════════════════════════════════════

  // POST /system/execute  → Aracı direkt çalıştır
  app.post('/system/execute', async (req, res) => {
    const { tool, args = {} } = req.body;
    if (!tool) return res.json({ status: 'error', message: 'tool alanı gerekli' });

    const fn = SYSTEM_TOOLS[tool] || autoAgent?.AUTO_TOOLS?.[tool];
    if (!fn) {
      return res.json({
        status:  'error',
        message: `"${tool}" aracı bulunamadı.`,
        available: Object.keys(SYSTEM_TOOLS).slice(0, 20)
      });
    }

    try {
      const result = await fn(args);
      if (brain) { try { brain.learn(`api:execute:${tool}`, result.slice(0, 80)); brain.emo.onSuccess(); } catch (_) {} }
      res.json({ status: 'success', tool, result });
    } catch (e) {
      if (brain) { try { brain.onError('system/execute', tool, e.message); } catch (_) {} }
      res.json({ status: 'error', tool, message: e.message });
    }
  });

  // POST /system/nl  → Doğal dil komutu — Ollama ile parse ederek çalıştır
  app.post('/system/nl', async (req, res) => {
    const { command } = req.body;
    if (!command) return res.json({ status: 'error', message: 'command alanı gerekli' });

    const toolSummary = Object.keys(SYSTEM_TOOLS).map(name => {
      const HINTS = {
        open_app:        '{"appName":"Steam|Chrome|Spotify|..."}',
        close_app:       '{"appName":"..."}',
        list_apps:       '{}',
        steam_open:      '{}',
        steam_search:    '{"query":"oyun adı"}',
        steam_install:   '{"query":"oyun adı"} veya {"appId":730}',
        steam_run:       '{"query":"oyun adı"} veya {"appId":730}',
        download_video:  '{"url":"...","quality":"best|720p|1080p|audio"}',
        download_file:   '{"url":"..."}',
        open_file:       '{"filePath":"..."}',
        open_url:        '{"url":"..."}',
        set_volume:      '{"level":50}',
        take_screenshot: '{}',
        list_tools:      '{}',
        self_create_tool:'{"name":"...","description":"...","code":"..."}',
        evolve_tool:     '{"task":"..."}',
      };
      return `${name}: ${HINTS[name] || '{}'}`;
    }).join('\n');

    try {
      const r = await axios.post(OLLAMA + '/api/generate', {
        model:   MODEL,
        stream:  false,
        prompt:  `Kullanıcı komutu: "${command}"\n\nMevcut araçlar:\n${toolSummary}\n\nSADECE JSON döndür (tek satır, başka hiçbir şey yazma):\n{"tool":"araç_adı","args":{...}}\n\nUygun araç yoksa: {"tool":"none","args":{}}`,
        options: { temperature: 0.1, num_predict: 200 }
      });

      const text       = (r.data.response || '').trim();
      const jsonMatch  = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return res.json({ status: 'error', message: 'Ollama yanıtı parse edilemedi', raw: text.slice(0, 200) });

      const parsed = JSON.parse(jsonMatch[0]);
      if (parsed.tool === 'none') return res.json({ status: 'no_tool', message: 'Uygun araç bulunamadı.', command });

      const fn = SYSTEM_TOOLS[parsed.tool] || autoAgent?.AUTO_TOOLS?.[parsed.tool];
      if (!fn) return res.json({ status: 'error', message: `Araç bulunamadı: "${parsed.tool}"` });

      const result = await fn(parsed.args || {});
      if (brain) { try { brain.learn(`nl:${parsed.tool}`, result.slice(0, 80)); brain.emo.onSuccess(); } catch (_) {} }
      res.json({ status: 'success', command, tool: parsed.tool, args: parsed.args, result });
    } catch (e) {
      if (brain) { try { brain.onError('system/nl', command.slice(0, 40), e.message); } catch (_) {} }
      res.json({ status: 'error', message: e.message });
    }
  });

  // GET /system/tools  → Tüm araç listesi
  app.get('/system/tools', (req, res) => {
    const builtIn = Object.keys(SYSTEM_TOOLS);
    const generated = [];
    try {
      const files = fs.readdirSync(TOOLS_DIR).filter(f => f.endsWith('.js'));
      files.forEach(f => generated.push(f.replace('.js', '')));
    } catch (_) {}

    const agentOnly = autoAgent
      ? Object.keys(autoAgent.AUTO_TOOLS || {}).filter(t => !builtIn.includes(t) && !generated.includes(t))
      : [];

    res.json({
      status:     'success',
      builtIn,
      generated,
      agentOnly,
      total:      builtIn.length + generated.length,
      toolsDir:   TOOLS_DIR,
    });
  });

  // POST /system/tools/create  → Yeni araç kaydet {name, description, code}
  app.post('/system/tools/create', async (req, res) => {
    const { name, description, code } = req.body;
    if (!name || !code) return res.json({ status: 'error', message: 'name ve code gerekli' });
    try {
      const result = await SYSTEM_TOOLS.self_create_tool({ name, description, code });
      res.json({ status: 'success', message: result });
    } catch (e) {
      res.json({ status: 'error', message: e.message });
    }
  });

  // POST /system/tools/evolve  → AI araç geliştir {task}
  app.post('/system/tools/evolve', async (req, res) => {
    const { task } = req.body;
    if (!task) return res.json({ status: 'error', message: 'task gerekli' });
    try {
      const result = await SYSTEM_TOOLS.evolve_tool({ task });
      res.json({ status: 'success', message: result });
    } catch (e) {
      res.json({ status: 'error', message: e.message });
    }
  });

  // DELETE /system/tools/:name  → Oluşturulan aracı sil
  app.delete('/system/tools/:name', (req, res) => {
    const { name } = req.params;
    const toolFile = pathMod.join(TOOLS_DIR, `${name}.js`);
    if (!fs.existsSync(toolFile)) return res.json({ status: 'error', message: `"${name}" bulunamadı (sadece generated araçlar silinebilir)` });
    fs.unlinkSync(toolFile);
    try { delete require.cache[require.resolve(toolFile)]; } catch (_) {}
    if (SYSTEM_TOOLS[name]) delete SYSTEM_TOOLS[name];
    if (autoAgent?.AUTO_TOOLS?.[name]) delete autoAgent.AUTO_TOOLS[name];
    res.json({ status: 'success', message: `"${name}" silindi.` });
  });

  // ── Steam kısayolları ──────────────────────────────────────

  app.post('/system/steam/install', async (req, res) => {
    const { query, appId } = req.body;
    if (!query && !appId) return res.json({ status: 'error', message: 'query veya appId gerekli' });
    try { res.json({ status: 'success', result: await SYSTEM_TOOLS.steam_install({ query, appId }) }); }
    catch (e) { res.json({ status: 'error', message: e.message }); }
  });

  app.post('/system/steam/run', async (req, res) => {
    const { query, appId } = req.body;
    if (!query && !appId) return res.json({ status: 'error', message: 'query veya appId gerekli' });
    try { res.json({ status: 'success', result: await SYSTEM_TOOLS.steam_run({ query, appId }) }); }
    catch (e) { res.json({ status: 'error', message: e.message }); }
  });

  app.get('/system/steam/search', async (req, res) => {
    const { query } = req.query;
    if (!query) return res.json({ status: 'error', message: '?query= gerekli' });
    try { res.json({ status: 'success', result: await SYSTEM_TOOLS.steam_search({ query }) }); }
    catch (e) { res.json({ status: 'error', message: e.message }); }
  });

  // ── Video / dosya indirme kısayolları ──────────────────────

  app.post('/system/download/video', async (req, res) => {
    const { url, quality, outputDir } = req.body;
    if (!url) return res.json({ status: 'error', message: 'url gerekli' });
    try { res.json({ status: 'success', result: await SYSTEM_TOOLS.download_video({ url, quality, outputDir }) }); }
    catch (e) { res.json({ status: 'error', message: e.message }); }
  });

  app.post('/system/download/file', async (req, res) => {
    const { url, outputPath } = req.body;
    if (!url) return res.json({ status: 'error', message: 'url gerekli' });
    try { res.json({ status: 'success', result: await SYSTEM_TOOLS.download_file({ url, outputPath }) }); }
    catch (e) { res.json({ status: 'error', message: e.message }); }
  });

  // ── Uygulama / dosya açma kısayolları ──────────────────────

  app.post('/system/open/app', async (req, res) => {
    const { appName } = req.body;
    if (!appName) return res.json({ status: 'error', message: 'appName gerekli' });
    try { res.json({ status: 'success', result: await SYSTEM_TOOLS.open_app({ appName }) }); }
    catch (e) { res.json({ status: 'error', message: e.message }); }
  });

  app.post('/system/open/url', async (req, res) => {
    const { url } = req.body;
    if (!url) return res.json({ status: 'error', message: 'url gerekli' });
    try { res.json({ status: 'success', result: await SYSTEM_TOOLS.open_url({ url }) }); }
    catch (e) { res.json({ status: 'error', message: e.message }); }
  });

  app.post('/system/open/file', async (req, res) => {
    const { filePath } = req.body;
    if (!filePath) return res.json({ status: 'error', message: 'filePath gerekli' });
    try { res.json({ status: 'success', result: await SYSTEM_TOOLS.open_file({ filePath }) }); }
    catch (e) { res.json({ status: 'error', message: e.message }); }
  });

  // ──────────────────────────────────────────────────────────
  // Boot logu
  // ──────────────────────────────────────────────────────────
  console.log('\n🛠️  SİSTEM ARAÇLARI YÜKLENDİ');
  console.log('══════════════════════════════════════════════════════');
  console.log('  POST   /system/execute               → Araç çalıştır {tool,args}');
  console.log('  POST   /system/nl                    → Doğal dil komutu {command}');
  console.log('  GET    /system/tools                 → Tüm araç listesi');
  console.log('  POST   /system/tools/create          → Yeni araç kaydet {name,code}');
  console.log('  POST   /system/tools/evolve          → AI araç geliştir {task}');
  console.log('  DELETE /system/tools/:name           → Aracı sil');
  console.log('  POST   /system/steam/install         → Oyun kur {query|appId}');
  console.log('  POST   /system/steam/run             → Oyun başlat {query|appId}');
  console.log('  GET    /system/steam/search          → Oyun ara ?query=...');
  console.log('  POST   /system/download/video        → Video indir {url,quality?}');
  console.log('  POST   /system/download/file         → Dosya indir {url}');
  console.log('  POST   /system/open/app              → Uygulama aç {appName}');
  console.log('  POST   /system/open/url              → URL aç {url}');
  console.log('  POST   /system/open/file             → Dosya aç {filePath}');
  console.log('══════════════════════════════════════════════════════');
  console.log('  🧠 brain.enrichPrompt: araç listesi Ollama\'ya eklendi');
  console.log('  🤖 AUTO_TOOLS: ' + Object.keys(SYSTEM_TOOLS).length + ' araç enjekte edildi');
  console.log('  📁 tools_generated: ' + TOOLS_DIR);
  console.log('══════════════════════════════════════════════════════\n');

  return { SYSTEM_TOOLS, processToolCall: _runSysCall };
}

module.exports = { mountSystemTools };
