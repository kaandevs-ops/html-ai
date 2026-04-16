// ╔══════════════════════════════════════════════════════════════════════╗
// ║         autonomous_agent.js  —  KaanAI Otonom Agent v3.0  FINAL    ║
// ║                                                                      ║
// ║  YENİ v3: Kod okuma/analiz + test çalıştırma + spesifik hedefler   ║
// ║  Döngü: düşün→planla→çalıştır→oku→test et→öğren→tekrar            ║
// ╚══════════════════════════════════════════════════════════════════════╝
// KURULUM — server.js EN SONUNA:
//   const { mountAutonomousAgent } = require('./autonomous_agent');
//   const autoAgent = mountAutonomousAgent(app, { brain, axios, exec, fs, path, PORT,
//     CLAW_TOOLS, OPENCLAW_TOOLS, MEMORY, saveMem, AGENT_STATE, WORLD_STATE,
//     agentPlan, normalizePlan, extractJsonFromLLM, toolPolicyFilter,
//     buildWebProjectPlanLLM, isMac, isWindows });
//   wss.on('connection', ws => autoAgent.registerWsClient(ws));
// BAŞLATMA: curl -X POST http://localhost:3000/auto/start

'use strict';

function mountAutonomousAgent(app, ctx) {
  const { brain, axios, exec, fs, path, PORT,
    CLAW_TOOLS, OPENCLAW_TOOLS, MEMORY, saveMem,
    AGENT_STATE, WORLD_STATE, agentPlan, normalizePlan,
    extractJsonFromLLM, toolPolicyFilter,
    buildWebProjectPlanLLM, isMac, isWindows } = ctx;

  const MODEL = process.env.OLLAMA_MODEL || 'llama3.1:8b';
  const OLLAMA = 'http://localhost:11434';

  // ── Runtime durumu ──────────────────────────────────────────────
  const AUTO = {
    running: false, paused: false,
    currentGoal: null, currentStep: null,
    cycleCount: 0, lastGoalAt: 0, cooldownMs: 35000,
    log: [], wsClients: new Set(),
    webAiCycle: 0,  // web AI araçları için ayrı döngü sayacı
  };

  // ── Öğrenme hafızası (kalıcı dosya) ────────────────────────────
  const LEARN_FILE = './auto_agent_memory.json';
  let LEARN = _loadLearn();

  function _loadLearn() {
    try { if (fs.existsSync(LEARN_FILE)) return JSON.parse(fs.readFileSync(LEARN_FILE, 'utf8')); } catch { }
    return {
      toolStats: {}, avoidGoals: [], successInsights: [], failInsights: [],
      totalCycles: 0, codeFiles: [], testedFiles: []
    };
  }
  function _saveLearn() {
    try { fs.writeFileSync(LEARN_FILE, JSON.stringify(LEARN, null, 2)); } catch { }
  }
  function _recordTool(name, ok, err) {
    if (!LEARN.toolStats[name]) LEARN.toolStats[name] = { ok: 0, fail: 0, lastFail: '' };
    if (ok) { LEARN.toolStats[name].ok++; }
    else { LEARN.toolStats[name].fail++; LEARN.toolStats[name].lastFail = (err || '').slice(0, 120); }
    _saveLearn();
  }
  function _reliable(name) {
    const s = LEARN.toolStats[name];
    if (!s) return true;
    const t = s.ok + s.fail;
    if (t < 3) return true;
    return (s.fail / t) < 0.6;
  }
  function _alternatives(bad) {
    const map = {
      browse_web: ['read_url', 'search_web'], read_url: ['browse_web', 'search_web'],
      run_terminal: ['write_file']
    };
    return (map[bad] || []).filter(t => _reliable(t) && AUTO_TOOLS[t]);
  }

  // ── Log ────────────────────────────────────────────────────────
  function autoLog(level, msg, data) {
    const entry = { ts: Date.now(), level, msg, data: data || null };
    AUTO.log.unshift(entry);
    if (AUTO.log.length > 100) AUTO.log.pop();
    const icons = { info: '🔵', success: '✅', warn: '⚠️', error: '❌', goal: '🎯', step: '🔧', think: '🧠', learn: '📚', test: '🧪' };
    console.log('[AutoAgent] ' + (icons[level] || '•') + ' ' + msg, data ? JSON.stringify(data).slice(0, 100) : '');
    _broadcast({ type: 'auto_agent_log', ...entry });
  }

  // ══════════════════════════════════════════════════════════════
  // 🛠️ ARAÇ SETİ — tüm araçlar burada
  // ══════════════════════════════════════════════════════════════
  const AUTO_TOOLS = {

    // Terminal çalıştır
    run_terminal: async function (args) {
      if (!args.command) throw new Error('command bos');
      // Mac'te google-chrome → open ile değiştir
      var cmd = args.command.replace(/google-chrome\s+(--new-tab\s+)?/gi, 'open ');
      autoLog('step', 'Terminal', { command: cmd.slice(0, 80) });
      return new Promise(function (resolve, reject) {
        exec(cmd, { cwd: process.cwd(), timeout: 30000 }, function (err, stdout, stderr) {
          if (err) return reject(new Error((stderr || err.message).slice(0, 300)));
          resolve((stdout || 'ok').slice(0, 3000));
        });
      });
    },

    // Web gezin
    browse_web: async function (args) {
      if (!args.url) throw new Error('url gerekli');
      autoLog('step', 'browse_web', { url: args.url });
      var r = await axios.post('http://localhost:' + PORT + '/assistant/browser/visit', { url: args.url });
      return (r.data.textSlice || r.data.title || 'icerik alinamadi').slice(0, 3000);
    },

    // Google ara
    search_web: async function (args) {
      if (!args.query) throw new Error('query gerekli');
      autoLog('step', 'search_web', { query: args.query });
      var r = await axios.post('http://localhost:' + PORT + '/assistant/google-search', { query: args.query, action: 'list' });
      return (r.data.results || []).slice(0, 6).map(function (x) { return x.title + ': ' + x.url; }).join('\n') || 'sonuc yok';
    },

    // URL oku
    read_url: async function (args) {
      if (!args.url) throw new Error('url gerekli');
      autoLog('step', 'read_url', { url: args.url });
      var r = await axios.post('http://localhost:' + PORT + '/assistant/browser/extract', { url: args.url, selector: 'body' });
      return (r.data.text || '').slice(0, 4000);
    },

    // Dosya yaz
    write_file: async function (args) {
      if (!args.filePath || args.content === undefined) throw new Error('filePath ve content gerekli');
      var dir = path.dirname(args.filePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(args.filePath, args.content, 'utf8');
      autoLog('step', 'write_file', { filePath: args.filePath, size: args.content.length });
      return 'yazildi: ' + args.filePath;
    },

    // ── YENİ: Dosya oku ve analiz et ─────────────────────────────
    read_file: async function (args) {
      if (!args.filePath) throw new Error('filePath gerekli');
      if (!fs.existsSync(args.filePath)) return 'dosya bulunamadi: ' + args.filePath;
      var content = fs.readFileSync(args.filePath, 'utf8');
      autoLog('step', 'read_file', { filePath: args.filePath, size: content.length });
      return content.slice(0, 5000);
    },

    // ── YENİ: Kod dosyasını oku + LLM ile hata analizi yap ───────
    analyze_code_file: async function (args) {
      if (!args.filePath) throw new Error('filePath gerekli');
      if (!fs.existsSync(args.filePath)) return 'dosya bulunamadi';
      var code = fs.readFileSync(args.filePath, 'utf8');
      autoLog('step', 'analyze_code_file', { filePath: args.filePath });
      var r = await axios.post(OLLAMA + '/api/generate', {
        model: MODEL, stream: false,
        prompt: 'Bu kodda hata veya iyilestirme noktasi var mi? Kisa Turkce analiz:\n\n' + code.slice(0, 4000)
      });
      var analysis = r.data.response.slice(0, 1000);
      brain.mem.remember('code_analysis:' + args.filePath, analysis.slice(0, 100), 0.7);
      return analysis;
    },

    // ── YENİ: Kodu çalıştır ve sonucu gözlemle ───────────────────
    run_and_test: async function (args) {
      if (!args.filePath) throw new Error('filePath gerekli');
      if (!fs.existsSync(args.filePath)) return 'dosya bulunamadi';

      var ext = path.extname(args.filePath);
      var cmd;
      if (ext === '.js') cmd = 'node "' + args.filePath + '"';
      else if (ext === '.py') cmd = 'python3 "' + args.filePath + '"';
      else if (ext === '.sh') cmd = 'bash "' + args.filePath + '"';
      else cmd = 'node "' + args.filePath + '"';

      autoLog('test', 'Kod test ediliyor', { filePath: args.filePath, cmd: cmd });

      return new Promise(function (resolve) {
        exec(cmd, { timeout: 15000, cwd: process.cwd() }, function (err, stdout, stderr) {
          var output = stdout || '';
          var errOut = stderr || (err ? err.message : '');
          var result = {
            success: !err,
            output: output.slice(0, 1000),
            error: errOut.slice(0, 500),
            summary: err ? 'HATA: ' + errOut.slice(0, 200) : 'BASARILI: ' + output.slice(0, 200)
          };
          // Sonucu brain'e kaydet
          brain.mem.remember('test:' + args.filePath, result.summary.slice(0, 100), 0.8);
          // Öğrenme hafızasına ekle
          LEARN.testedFiles = LEARN.testedFiles || [];
          LEARN.testedFiles.push({ file: args.filePath, success: result.success, ts: Date.now() });
          if (LEARN.testedFiles.length > 50) LEARN.testedFiles.shift();
          _saveLearn();
          autoLog(result.success ? 'test' : 'warn', 'Test sonucu: ' + (result.success ? 'GECTI' : 'KALDI'), { file: args.filePath });
          resolve(result.summary);
        });
      });
    },

    // ── YENİ: Kod yaz + otomatik test et ─────────────────────────
    write_and_test: async function (args) {
      if (!args.task || !args.filePath) throw new Error('task ve filePath gerekli');
      autoLog('step', 'write_and_test', { filePath: args.filePath });

      // 1. Kodu yaz
      var lang = args.language || (args.filePath.endsWith('.py') ? 'Python' : 'Node.js');
      var r = await axios.post(OLLAMA + '/api/generate', {
        model: MODEL, stream: false,
        prompt: lang + ' ile sunu yaz. SADECE KOD:\n\n' + args.task
      });
      var code = r.data.response.replace(/```[\w]*\n?/g, '').replace(/\n?```/g, '').trim();
      var dir = path.dirname(args.filePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(args.filePath, code, 'utf8');
      brain.mem.remember('code:' + args.task.slice(0, 40), args.filePath, 0.7);

      // 2. Otomatik test et
      var testResult = await AUTO_TOOLS.run_and_test({ filePath: args.filePath });

      // 3. Hata varsa LLM ile düzelt (1 kez)
      if (testResult.startsWith('HATA')) {
        autoLog('warn', 'Kod hatali, duzeltiliyor...');
        var fixR = await axios.post(OLLAMA + '/api/generate', {
          model: MODEL, stream: false,
          prompt: lang + ' kodu hata verdi.\nKod:\n' + code + '\nHata:\n' + testResult + '\nDuzeltilmis kodu yaz. SADECE KOD:'
        });
        var fixedCode = fixR.data.response.replace(/```[\w]*\n?/g, '').replace(/\n?```/g, '').trim();
        fs.writeFileSync(args.filePath, fixedCode, 'utf8');
        var retestResult = await AUTO_TOOLS.run_and_test({ filePath: args.filePath });
        return 'Yazildi+Duzeltildi+Test: ' + retestResult;
      }

      return 'Yazildi+Test: ' + testResult;
    },

    // Klasör listele
    list_files: async function (args) {
      var d = args.dirPath || process.cwd();
      if (!fs.existsSync(d)) return 'klasor bulunamadi';
      return fs.readdirSync(d, { withFileTypes: true })
        .filter(function (f) { return !f.name.startsWith('.') && f.name !== 'node_modules'; })
        .map(function (f) { return (f.isDirectory() ? '[K] ' : '[D] ') + f.name; }).join('\n');
    },

    // Kod yaz (dosyaya)
    write_code: async function (args) {
      // LLM bazen 'task' yerine direkt 'code' gönderiyor, ikisini destekle
      if (!args.task && args.code) {
        if (args.filePath) {
          var dir = path.dirname(args.filePath);
          if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(args.filePath, args.code, 'utf8');
          brain.mem.remember('code:' + args.code.slice(0, 40), args.filePath, 0.7);
          LEARN.codeFiles = LEARN.codeFiles || [];
          LEARN.codeFiles.push({ file: args.filePath, task: '[direkt kod]', ts: Date.now() });
          if (LEARN.codeFiles.length > 50) LEARN.codeFiles.shift();
          _saveLearn();
          return 'kod yazildi (direkt): ' + args.filePath + ' (' + args.code.length + ' karakter)';
        }
        return args.code.slice(0, 2000);
      }
      if (!args.task) throw new Error('task gerekli');
      autoLog('step', 'write_code', { task: args.task.slice(0, 60) });
      var r = await axios.post(OLLAMA + '/api/generate', {
        model: MODEL, stream: false,
        prompt: (args.language || 'JavaScript') + ' ile sunu yaz. SADECE KOD:\n\n' + args.task
      });
      var code = r.data.response.replace(/```[\w]*\n?/g, '').replace(/\n?```/g, '').trim();
      if (args.filePath) {
        var dir = path.dirname(args.filePath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(args.filePath, code, 'utf8');
        brain.mem.remember('code:' + args.task.slice(0, 40), args.filePath, 0.7);
        LEARN.codeFiles = LEARN.codeFiles || [];
        LEARN.codeFiles.push({ file: args.filePath, task: args.task.slice(0, 60), ts: Date.now() });
        if (LEARN.codeFiles.length > 50) LEARN.codeFiles.shift();
        _saveLearn();
        return 'kod yazildi: ' + args.filePath + ' (' + code.length + ' karakter)';
      }
      return code.slice(0, 2000);
    },

    // Web projesi oluştur
    create_web_project: async function (args) {
      if (!args.projectName) throw new Error('projectName gerekli');
      autoLog('step', 'create_web_project', { projectName: args.projectName });
      var plan = await buildWebProjectPlanLLM(args.projectName, args.description || args.projectName);
      for (var i = 0; i < plan.length; i++) {
        await new Promise(function (res, rej) {
          exec(plan[i].args.command, { cwd: process.cwd() }, function (err) { err ? rej(err) : res(); });
        });
      }
      brain.mem.remember('project:' + args.projectName, args.description || 'web projesi', 0.8);
      return 'web projesi: ./' + args.projectName + '/';
    },

    // Node projesi oluştur + test et
    create_node_project: async function (args) {
      if (!args.projectName) throw new Error('projectName gerekli');
      autoLog('step', 'create_node_project', { projectName: args.projectName });
      var dir = './' + args.projectName;
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      // index.js yaz
      var r = await axios.post(OLLAMA + '/api/generate', {
        model: MODEL, stream: false,
        prompt: 'Node.js ile sunu yaz. SADECE KOD:\n\n' + (args.description || args.projectName + ' uygulamasi')
      });
      var code = r.data.response.replace(/```[\w]*\n?/g, '').replace(/\n?```/g, '').trim();
      fs.writeFileSync(dir + '/index.js', code, 'utf8');
      fs.writeFileSync(dir + '/package.json', JSON.stringify({
        name: args.projectName, version: '1.0.0', main: 'index.js',
        scripts: { start: 'node index.js', test: 'node index.js' }
      }, null, 2));
      fs.writeFileSync(dir + '/README.md', '# ' + args.projectName + '\n\n' + (args.description || '') + '\n\nKaanAI tarafindan olusturuldu.');
      brain.mem.remember('project:' + args.projectName, 'node: ' + args.description, 0.8);
      // Bagımlılıkları kur
      await new Promise(function (res) {
        exec('npm install', { cwd: dir, timeout: 30000 }, function () { res(); });
      });
      // Otomatik test
      var testResult = await AUTO_TOOLS.run_and_test({ filePath: dir + '/index.js' });
      return 'node projesi: ' + dir + '/ | Test: ' + testResult.slice(0, 100);
    },

    // Python scripti
    create_python_script: async function (args) {
      if (!args.fileName || !args.task) throw new Error('fileName ve task gerekli');
      var code = await AUTO_TOOLS.write_code({ language: 'Python', task: args.task });
      fs.writeFileSync(args.fileName, code, 'utf8');
      var testResult = await AUTO_TOOLS.run_and_test({ filePath: args.fileName });
      return 'python: ' + args.fileName + ' | Test: ' + testResult.slice(0, 100);
    },

    // Metin analiz
    analyze_text: async function (args) {
      if (!args.text) throw new Error('text gerekli');
      var r = await axios.post(OLLAMA + '/api/generate', {
        model: MODEL, stream: false,
        prompt: (args.instruction || 'Sunu analiz et (Turkce):') + '\n\n' + args.text.slice(0, 4000)
      });
      return r.data.response.slice(0, 2000);
    },

    // Özetle
    summarize: async function (args) {
      if (!args.text) throw new Error('text gerekli');
      var r = await axios.post(OLLAMA + '/api/generate', {
        model: MODEL, stream: false,
        prompt: 'Sunu kisa ve net ozetle (Turkce):\n\n' + args.text.slice(0, 5000)
      });
      return r.data.response.slice(0, 1000);
    },

    // Brain hafızasına kaydet
    remember_fact: async function (args) {
      if (!args.key || !args.value) throw new Error('key ve value gerekli');
      brain.mem.remember(args.key, args.value, 0.75);
      return 'hatirlanda: ' + args.key;
    },

    // Brain hafızasından geri çağır
    recall_memory: async function (args) {
      if (!args.query) throw new Error('query gerekli');
      var results = brain.mem.recall(args.query, 5);
      return results.length ? results.map(function (r) { return r.key + ': ' + r.value; }).join('\n') : 'hafiza bulunamadi';
    },

    // Bekle
    wait: async function (args) {
      await _sleep(Math.min(args.ms || 1000, 10000));
      return (args.ms || 1000) + 'ms beklendi';
    },

    // CLAW_TOOLS köprüleri
    click: async function (a) { return CLAW_TOOLS.click ? CLAW_TOOLS.click(a) : 'click araci yok'; },
    screenshot: async function (a) { return CLAW_TOOLS.screenshot ? CLAW_TOOLS.screenshot(a) : 'screenshot araci yok'; },
    browser_open: async function (a) { return CLAW_TOOLS.browser_open ? CLAW_TOOLS.browser_open(a) : 'browser_open araci yok'; },

    // ══════════════════════════════════════════════════════
    // 🖥️ UYGULAMA KONTROL ARAÇLARI — Cursor + herhangi uygulama
    // ══════════════════════════════════════════════════════

    // Herhangi bir Mac uygulamasını aç ve odaklan
    open_app: async function (args) {
      if (!args.appName) throw new Error('appName gerekli');
      autoLog('step', 'Uygulama açılıyor: ' + args.appName);
      return new Promise(function (resolve, reject) {
        var cmd = args.projectPath
          ? 'open -a "' + args.appName + '" "' + args.projectPath + '"'
          : 'open -a "' + args.appName + '"';
        exec(cmd, { timeout: 10000 }, function (err) {
          if (err) return reject(new Error(args.appName + ' açılamadı: ' + err.message));
          // Uygulamanın açılması için bekle
          setTimeout(resolve, 2500, args.appName + ' açıldı');
        });
      });
    },

    // Açık uygulamaya AppleScript ile metin/komut gönder
    app_type: async function (args) {
      if (!args.text) throw new Error('text gerekli');
      autoLog('step', 'Uygulamaya yaziliyor', { text: args.text.slice(0, 60) });
      return new Promise(function (resolve, reject) {
        var safeText = args.text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ').slice(0, 200);
        var lines = [];
        if (args.appName) {
          lines.push('tell application "' + args.appName + '" to activate');
          lines.push('delay 0.5');
        }
        lines.push('tell application "System Events" to keystroke "' + safeText + '"');
        var script = lines.join('\n');
        exec('osascript << \'ASCRIPT\'\n' + script + '\nASCRIPT', { timeout: 10000 }, function (err, stdout) {
          if (err) return reject(new Error('app_type hatasi: ' + err.message));
          resolve('yazildi: ' + args.text.slice(0, 40));
        });
      });
    },

    // Uygulamaya klavye kisayolu gonder (cmd+shift+p gibi)
    app_hotkey: async function (args) {
      if (!args.keys) throw new Error('keys gerekli. Ornek: "command shift p"');
      autoLog('step', 'Kisayol gonderiliyor', { keys: args.keys });
      return new Promise(function (resolve, reject) {
        var parts = args.keys.split(' ');
        var key = parts[parts.length - 1];
        var modMap = { command: 'command key', cmd: 'command key', shift: 'shift key', option: 'option key', ctrl: 'control key' };
        var mods = parts.slice(0, -1).map(function (m) { return modMap[m] || (m + ' key'); });
        var modStr = mods.length ? ' using {' + mods.join(', ') + ' down}' : '';
        var lines = [];
        if (args.appName) {
          lines.push('tell application "' + args.appName + '" to activate');
          lines.push('delay 0.3');
        }
        lines.push('tell application "System Events" to keystroke "' + key + '"' + modStr);
        var script = lines.join('\n');
        exec('osascript << \'ASCRIPT\'\n' + script + '\nASCRIPT', { timeout: 8000 }, function (err) {
          if (err) return reject(new Error('hotkey hatasi: ' + err.message));
          setTimeout(resolve, 800, 'kisayol gonderildi: ' + args.keys);
        });
      });
    },

    // Cursor'u aç + proje klasörünü yükle
    open_in_cursor: async function (args) {
      if (!args.projectPath) throw new Error('projectPath gerekli');
      autoLog('step', 'Cursor açılıyor', { path: args.projectPath });

      // Klasör yoksa oluştur
      if (!fs.existsSync(args.projectPath)) {
        fs.mkdirSync(args.projectPath, { recursive: true });
        autoLog('step', 'Proje klasörü oluşturuldu: ' + args.projectPath);
      }

      return new Promise(function (resolve, reject) {
        // Önce cursor CLI dene, yoksa open -a dene
        exec('which cursor', function (err, stdout) {
          var hasCLI = !err && stdout.trim().length > 0;
          var cmd = hasCLI
            ? 'cursor "' + args.projectPath + '"'
            : 'open -a "Cursor" "' + args.projectPath + '"';

          exec(cmd, { timeout: 15000 }, function (err2) {
            if (err2) return reject(new Error('Cursor açılamadı: ' + err2.message + '. Cursor yüklü mü?'));
            brain.mem.remember('cursor:lastProject', args.projectPath, 0.8);
            setTimeout(resolve, 3000, 'Cursor açıldı: ' + args.projectPath);
          });
        });
      });
    },

    // Cursor Composera komut gonder (Cmd+I - komut yaz - Enter)
    cursor_compose: async function (args) {
      if (!args.prompt) throw new Error('prompt gerekli');
      autoLog('step', 'Cursor Composera komut gonderiliyor', { prompt: args.prompt.slice(0, 80) });
      return new Promise(function (resolve, reject) {
        var safePrompt = args.prompt.replace(/\\/g, '').replace(/"/g, '').replace(/'/g, '').replace(/\n/g, ' ').slice(0, 300);
        var scriptLines = [
          'tell application "Cursor" to activate',
          'delay 1.0',
          'tell application "System Events"',
          'keystroke "i" using {command down}',
          'delay 1.5',
          'keystroke "' + safePrompt + '"',
          'delay 0.5',
          'key code 36',
          'end tell'
        ];
        var scriptFile = '/tmp/cursor_compose_' + Date.now() + '.scpt';
        require('fs').writeFileSync(scriptFile, scriptLines.join('\n'));
        exec('osascript ' + scriptFile, { timeout: 20000 }, function (err) {
          try { require('fs').unlinkSync(scriptFile); } catch (e) { }
          if (err) return reject(new Error('Composer hatasi: ' + err.message));
          var waitMs = args.waitMs || 15000;
          autoLog('step', 'Cursor kod yaziyor, ' + (waitMs / 1000) + 'sn bekleniyor...');
          setTimeout(resolve, waitMs, 'Composer komutu gonderildi');
        });
      });
    },

    // Cursor'un yazdığı dosyaları oku ve brain'e kaydet
    collect_cursor_output: async function (args) {
      if (!args.projectPath) throw new Error('projectPath gerekli');
      autoLog('step', 'Cursor çıktıları toplanıyor', { path: args.projectPath });

      if (!fs.existsSync(args.projectPath)) return 'klasör bulunamadı: ' + args.projectPath;

      var extensions = ['.js', '.ts', '.py', '.html', '.css', '.json', '.md', '.jsx', '.tsx'];
      var files = [];

      function scanDir(dir, depth) {
        if (depth > 3) return;
        try {
          fs.readdirSync(dir, { withFileTypes: true }).forEach(function (f) {
            if (f.name.startsWith('.') || f.name === 'node_modules') return;
            var fullPath = path.join(dir, f.name);
            if (f.isDirectory()) {
              scanDir(fullPath, depth + 1);
            } else if (extensions.some(function (e) { return f.name.endsWith(e); })) {
              var content = fs.readFileSync(fullPath, 'utf8');
              files.push({ file: f.name, path: fullPath, size: content.length, preview: content.slice(0, 200) });
              brain.mem.remember('cursor:file:' + f.name, fullPath + ' (' + content.length + ' karakter)', 0.75);
            }
          });
        } catch (e) { }
      }

      scanDir(args.projectPath, 0);

      LEARN.codeFiles = LEARN.codeFiles || [];
      files.forEach(function (f) {
        LEARN.codeFiles.push({ file: f.path, task: 'cursor ile oluşturuldu', ts: Date.now() });
      });
      if (LEARN.codeFiles.length > 50) LEARN.codeFiles = LEARN.codeFiles.slice(-50);
      _saveLearn();

      var summary = files.length + ' dosya bulundu: ' + files.map(function (f) { return f.file + '(' + f.size + 'b)'; }).join(', ');
      autoLog('success', summary);
      return summary;
    },

    // Tam Cursor iş akışı: klasör oluştur → Cursor aç → compose → dosyaları topla
    cursor_project: async function (args) {
      if (!args.projectName || !args.task) throw new Error('projectName ve task gerekli');

      var projectPath = path.join(process.cwd(), 'projects', args.projectName);
      autoLog('goal', 'Cursor projesi başlatılıyor: ' + args.projectName);

      // 1. Klasörü oluştur
      if (!fs.existsSync(projectPath)) fs.mkdirSync(projectPath, { recursive: true });
      brain.mem.remember('cursor:project:' + args.projectName, args.task.slice(0, 100), 0.8);

      // 2. Cursor'u aç
      await AUTO_TOOLS.open_in_cursor({ projectPath });
      await new Promise(function (r) { setTimeout(r, 3000); });

      // 3. Composera gorevi gonder
      var fullPrompt = args.task + (args.details ? ' Detaylar: ' + args.details : '') + ' Lutfen tam calisan bir proje olustur. Gerekli tum dosyalari yaz.';
      await AUTO_TOOLS.cursor_compose({ prompt: fullPrompt, waitMs: args.waitMs || 20000 });

      // 4. Dosyaları topla
      var output = await AUTO_TOOLS.collect_cursor_output({ projectPath });

      // 5. Brain'e bildir
      brain.onAgentDone('cursor_project:' + args.projectName, [], 'success');

      var result = 'Cursor projesi tamamlandi: ' + projectPath + ' | ' + output;
      autoLog('success', result);
      return result;
    },

    // ── Antigravity araçları (Cursor ile aynı mantık) ─────────────
    // CLI: agy  |  Uygulama: "Google Antigravity"
    // Composer kısayolu: Cmd+I (Cursor ile aynı)

    open_in_antigravity: async function (args) {
      if (!args.projectPath) throw new Error('projectPath gerekli');
      autoLog('step', 'Antigravity aciliyor', { path: args.projectPath });
      if (!fs.existsSync(args.projectPath)) {
        fs.mkdirSync(args.projectPath, { recursive: true });
        autoLog('step', 'Proje klasoru olusturuldu: ' + args.projectPath);
      }
      return new Promise(function (resolve, reject) {
        // Önce agy CLI dene, yoksa open -a dene
        exec('which agy', function (err, stdout) {
          var hasCLI = !err && stdout.trim().length > 0;
          var cmd = hasCLI
            ? 'agy "' + args.projectPath + '"'
            : 'open -a "Antigravity" "' + args.projectPath + '"';
          exec(cmd, { timeout: 15000 }, function (err2) {
            if (err2) return reject(new Error('Antigravity acilamadi: ' + err2.message + '. Antigravity yuklu mu?'));
            brain.mem.remember('antigravity:lastProject', args.projectPath, 0.8);
            setTimeout(resolve, 3500, 'Antigravity acildi: ' + args.projectPath);
          });
        });
      });
    },

    antigravity_compose: async function (args) {
      if (!args.prompt) throw new Error('prompt gerekli');
      autoLog('step', 'Antigravity Composera komut gonderiliyor', { prompt: args.prompt.slice(0, 80) });
      return new Promise(function (resolve, reject) {
        var safePrompt = args.prompt.replace(/\\/g, '').replace(/"/g, '').replace(/'/g, '').replace(/\n/g, ' ').slice(0, 300);
        // Antigravity Composer kisayolu Cursor ile ayni: Cmd+I
        var scriptLines = [
          'tell application "Antigravity" to activate',
          'delay 1.0',
          'tell application "System Events"',
          'keystroke "i" using {command down}',
          'delay 1.5',
          'keystroke "' + safePrompt + '"',
          'delay 0.5',
          'key code 36',
          'end tell'
        ];
        var scriptFile = '/tmp/antigravity_compose_' + Date.now() + '.scpt';
        fs.writeFileSync(scriptFile, scriptLines.join('\n'));
        exec('osascript ' + scriptFile, { timeout: 20000 }, function (err) {
          try { fs.unlinkSync(scriptFile); } catch (e) { }
          if (err) return reject(new Error('Antigravity Composer hatasi: ' + err.message));
          var waitMs = args.waitMs || 20000;
          autoLog('step', 'Antigravity kod yaziyor, ' + (waitMs / 1000) + 'sn bekleniyor...');
          setTimeout(resolve, waitMs, 'Antigravity Composer komutu gonderildi');
        });
      });
    },

    // Tam Antigravity is akisi — Cursor ile birebir ayni mantik
    antigravity_project: async function (args) {
      if (!args.projectName || !args.task) throw new Error('projectName ve task gerekli');
      var projectPath = path.join(process.cwd(), 'projects', args.projectName);
      autoLog('goal', 'Antigravity projesi baslatiliyor: ' + args.projectName);

      // 1. Klasoru olustur
      if (!fs.existsSync(projectPath)) fs.mkdirSync(projectPath, { recursive: true });
      brain.mem.remember('antigravity:project:' + args.projectName, args.task.slice(0, 100), 0.8);

      // 2. Ollama ile gorevi detaylandir (Cursor ile ayni)
      var detailedTask = args.task;
      try {
        var planR = await axios.post(OLLAMA + '/api/generate', {
          model: MODEL, stream: false,
          prompt: 'Yazilim projesi plani yaz. Gorev: ' + args.task + ' Teknoloji stack, dosya yapisi, ozellikler. Antigravity AI icin prompt olarak yaz, Turkce, max 300 kelime:'
        });
        detailedTask = planR.data.response.trim().slice(0, 500);
        autoLog('think', 'Ollama plan urettl: ' + detailedTask.slice(0, 80));
      } catch (e) {
        autoLog('warn', 'Ollama plan uretemedi, orjinal task kullaniliyor');
      }

      // 3. Antigravity ac
      await AUTO_TOOLS.open_in_antigravity({ projectPath });
      await new Promise(function (r) { setTimeout(r, 3000); });

      // 4. Composera detayli gorevi gonder
      var fullPrompt = detailedTask + (args.details ? ' Ek detaylar: ' + args.details : '') + ' Tam calisan proje olustur, tum dosyalari yaz.';
      await AUTO_TOOLS.antigravity_compose({ prompt: fullPrompt, waitMs: args.waitMs || 25000 });

      // 5. Dosyalari topla (collect_cursor_output ile ayni mantik)
      var output = await AUTO_TOOLS.collect_cursor_output({ projectPath });

      // 6. Brain'e bildir
      brain.onAgentDone('antigravity_project:' + args.projectName, [], 'success');
      LEARN.codeFiles = LEARN.codeFiles || [];
      LEARN.codeFiles.push({ file: projectPath, task: args.task.slice(0, 60), ts: Date.now() });
      _saveLearn();

      var result = 'Antigravity projesi tamamlandi: ' + projectPath + ' | ' + output;
      autoLog('success', result);
      return result;
    },

    // ── ChatGPT Web araçları (API yok, puppeteer ile tarayıcı kontrolü) ──
    // Mantık: Ollama prompt hazırlar → ChatGPT.com açılır → prompt yazılır
    // → cevap beklenir → cevap alınır → dosyaya kaydedilir → brain'e bildirilir

    chatgpt_ask: async function (args) {
      if (!args.prompt) throw new Error('prompt gerekli');
      autoLog('step', 'ChatGPT web arayüzü açılıyor...', { prompt: args.prompt.slice(0, 80) });

      var puppeteer = require('puppeteer-extra');
      var StealthPlugin = require('puppeteer-extra-plugin-stealth');
      puppeteer.use(StealthPlugin());

      var browser = null;
      try {
        browser = await puppeteer.launch({
          headless: false,
          args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-blink-features=AutomationControlled',
            '--start-maximized'
          ],
          defaultViewport: null,
          ignoreHTTPSErrors: true
        });

        var page = await browser.newPage();
        await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');

        // Otomasyon tespitini engelle
        await page.evaluateOnNewDocument(function () {
          Object.defineProperty(navigator, 'webdriver', { get: function () { return false; } });
        });

        autoLog('step', 'chat.openai.com açılıyor...');
        await page.goto('https://chat.openai.com', { waitUntil: 'networkidle2', timeout: 45000 });

        // Sayfa tam yüklensin
        await new Promise(function (r) { setTimeout(r, 5000); });

        // Giriş gerekiyorsa kullanıcıya 45 saniye ver
        var currentUrl = page.url();
        autoLog('step', 'Mevcut URL: ' + currentUrl);
        if (currentUrl.includes('auth') || currentUrl.includes('login') || currentUrl.includes('account')) {
          autoLog('step', '⚠️ ChatGPT giriş sayfası — 45 saniye içinde manuel giriş yapın...');
          await new Promise(function (r) { setTimeout(r, 45000); });
          await new Promise(function (r) { setTimeout(r, 3000); }); // giriş sonrası yüklenme
        }

        // Prompt textarea'sını bul — ChatGPT 2024/2025 selector'ları (öncelik sırasıyla)
        autoLog('step', 'Prompt alanı aranıyor...');
        var promptBox = null;
        var selectors = [
          '#prompt-textarea',                          // ChatGPT klasik
          'div[contenteditable="true"]',               // ChatGPT yeni (2025) — contenteditable div
          'textarea[data-id="prompt-textarea"]',       // alternatif data-id
          'textarea[tabindex="0"]',                    // tab index ile
          'form textarea',                             // form içindeki textarea
          '[placeholder*="Message"]',                  // placeholder ile
          '[placeholder*="mesaj"]',                    // Türkçe placeholder
          'textarea'                                   // son çare — herhangi textarea
        ];

        for (var si = 0; si < selectors.length; si++) {
          try {
            promptBox = await page.waitForSelector(selectors[si], { timeout: 4000, visible: true });
            if (promptBox) {
              autoLog('step', 'Prompt alanı bulundu: ' + selectors[si]);
              break;
            }
          } catch (e) { /* bu selector çalışmadı, diğerini dene */ }
        }

        if (!promptBox) throw new Error('Prompt alanı bulunamadı — ChatGPT sayfası yüklenemedi veya giriş yapılmadı');

        // Click ile odaklan
        await promptBox.click({ clickCount: 3 });
        await new Promise(function (r) { setTimeout(r, 500); });

        // Prompt'u clipboard üzerinden yapıştır — keyboard.type newline'ları Enter'a çevirir!
        // Bu yöntemle tüm metin tek seferde, satır sonları korunarak girer.
        var safePrompt = args.prompt.slice(0, 3000);

        await page.evaluate(function (text) {
          // Clipboard API ile panoya yaz
          return navigator.clipboard.writeText(text).catch(function () {
            // Clipboard API yoksa execCommand dene
            var el = document.activeElement;
            if (el) {
              var nativeInputValueSetter = Object.getOwnPropertyDescriptor(
                window.HTMLTextAreaElement.prototype, 'value'
              ) || Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
              if (nativeInputValueSetter && nativeInputValueSetter.set) {
                nativeInputValueSetter.set.call(el, text);
                el.dispatchEvent(new Event('input', { bubbles: true }));
              }
            }
          });
        }, safePrompt);

        // Cmd+V ile yapıştır (Mac)
        await page.keyboard.down('Meta');
        await page.keyboard.press('v');
        await page.keyboard.up('Meta');
        await new Promise(function (r) { setTimeout(r, 1000); });

        // Eğer clipboard paste çalışmadıysa (içerik boşsa) fallback: execCommand
        var currentContent = await promptBox.evaluate(function (el) {
          return el.innerText || el.value || '';
        });

        if (!currentContent || currentContent.trim().length < 10) {
          autoLog('step', 'Clipboard paste çalışmadı, execCommand deniyor...');
          await page.evaluate(function (text) {
            var el = document.activeElement;
            if (!el) return;
            // React controlled input için
            var tagName = el.tagName.toLowerCase();
            if (tagName === 'textarea') {
              var nativeSet = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value');
              if (nativeSet && nativeSet.set) {
                nativeSet.set.call(el, text);
                el.dispatchEvent(new Event('input', { bubbles: true }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
              }
            } else if (el.contentEditable === 'true') {
              el.innerText = text;
              el.dispatchEvent(new InputEvent('input', { bubbles: true, data: text }));
            }
          }, safePrompt);
          await new Promise(function (r) { setTimeout(r, 500); });
        }

        await new Promise(function (r) { setTimeout(r, 800); });

        // Gönder — önce Enter dene, çalışmazsa gönder butonunu bul
        autoLog('step', 'Prompt gönderiliyor...');

        // Gönder butonu ara (Enter bazen yeni satır açar contenteditable'da)
        var sendBtn = null;
        var sendSelectors = [
          '[data-testid="send-button"]',
          'button[aria-label="Send message"]',
          'button[aria-label="Mesaj gönder"]',
          'button[type="submit"]',
          'form button:last-child'
        ];
        for (var bi = 0; bi < sendSelectors.length; bi++) {
          try {
            var btn = await page.$(sendSelectors[bi]);
            if (btn) { sendBtn = btn; break; }
          } catch (e) { }
        }

        if (sendBtn) {
          await sendBtn.click();
          autoLog('step', 'Gönder butonuna basıldı');
        } else {
          await page.keyboard.press('Enter');
          autoLog('step', 'Enter ile gönderildi');
        }

        autoLog('step', 'Cevap bekleniyor...');

        // Cevap gelene kadar bekle — "Stop" butonu görünürse üretim başlamış demektir
        // Önce üretim başlamasını bekle (max 10sn)
        try {
          await page.waitForSelector('[aria-label="Stop generating"], [data-testid="stop-button"]', { timeout: 10000 });
          autoLog('step', 'ChatGPT cevap üretiyor...');
          // Üretim bitene kadar bekle — "Stop" butonu kaybolunca bitti
          await page.waitForFunction(function () {
            return !document.querySelector('[aria-label="Stop generating"]') &&
              !document.querySelector('[data-testid="stop-button"]');
          }, { timeout: 120000 }); // max 2 dakika
          autoLog('step', 'ChatGPT cevap üretimini tamamladı');
        } catch (e) {
          // Stop butonu çıkmadıysa sabit bekle
          var waitMs = args.waitMs || 35000;
          autoLog('step', 'Stop butonu bulunamadı, ' + (waitMs / 1000) + 'sn bekleniyor...');
          await new Promise(function (r) { setTimeout(r, waitMs); });
        }

        // Cevabı oku — tüm yöntemleri dene, en uzun olanı al
        var answer = await page.evaluate(function () {
          var candidates = [];

          // Yöntem 1: 2025 ChatGPT — data-message-author-role
          var msgs = document.querySelectorAll('[data-message-author-role="assistant"]');
          if (msgs && msgs.length > 0) {
            candidates.push(msgs[msgs.length - 1].innerText || '');
          }

          // Yöntem 2: article içindeki son mesaj
          var articles = document.querySelectorAll('article');
          if (articles && articles.length > 0) {
            // Son article genellikle assistant cevabı
            var lastArticle = articles[articles.length - 1].innerText || '';
            if (lastArticle.length > 50) candidates.push(lastArticle);
          }

          // Yöntem 3: .markdown veya .prose
          var mdBlocks = document.querySelectorAll('.markdown, .prose, [class*="markdown"]');
          if (mdBlocks && mdBlocks.length > 0) {
            var combined = Array.from(mdBlocks).map(function (b) { return b.innerText; }).join('\n\n');
            if (combined.length > 50) candidates.push(combined);
          }

          // En uzun cevabı döndür (genellikle en doğrusu)
          if (candidates.length === 0) return '';
          return candidates.sort(function (a, b) { return b.length - a.length; })[0];
        });

        // Tarayıcıyı kapat
        await browser.close();
        browser = null;

        if (!answer || answer.length < 10) {
          throw new Error('ChatGPT cevabı alınamadı — sayfa yapısı değişmiş olabilir veya üretim tamamlanmadı');
        }

        brain.mem.remember('chatgpt:last_answer', answer.slice(0, 200), 0.8);
        autoLog('success', 'ChatGPT cevabı alındı (' + answer.length + ' karakter)');
        return answer;

      } catch (e) {
        if (browser) { try { await browser.close(); } catch (e2) { } }
        throw new Error('ChatGPT hatası: ' + e.message);
      }
    },

    // Tam ChatGPT iş akışı: Ollama prompt hazırlar → ChatGPT yazar → dosyaya kaydeder
    chatgpt_project: async function (args) {
      if (!args.projectName || !args.task) throw new Error('projectName ve task gerekli');

      var projectPath = path.join(process.cwd(), 'projects', args.projectName);
      autoLog('goal', 'ChatGPT projesi başlatılıyor: ' + args.projectName);

      // 1. Klasörü oluştur
      if (!fs.existsSync(projectPath)) fs.mkdirSync(projectPath, { recursive: true });
      brain.mem.remember('chatgpt:project:' + args.projectName, args.task.slice(0, 100), 0.8);

      // 2. Ollama ile detaylı teknik prompt hazırla
      autoLog('step', 'Ollama teknik spec hazırlıyor...');
      var ollamaRes = await axios.post('http://localhost:11434/api/chat', {
        model: process.env.OLLAMA_MODEL || 'llama3.1:8b',
        stream: false,
        messages: [
          {
            role: 'system',
            content: 'Sen bir yazılım mimarısın. Kullanıcının isteğini ChatGPT\'ye verilecek detaylı bir teknik prompt\'a çevir. Türkçe veya İngilizce olabilir. Şu formatı kullan: "Görev: ... Gereksinimler: ... Teknoloji: ... Dosya yapısı: ... Önemli notlar: ..."'
          },
          { role: 'user', content: args.task + (args.details ? ' Detaylar: ' + args.details : '') }
        ]
      });
      var technicalPrompt = ollamaRes.data.message.content;
      autoLog('step', 'Teknik prompt hazır: ' + technicalPrompt.slice(0, 100) + '...');

      // 3. ChatGPT'ye sor
      var chatGptAnswer = await AUTO_TOOLS.chatgpt_ask({
        prompt: technicalPrompt,
        waitMs: args.waitMs || 35000
      });

      // 4. Cevabı dosyaya kaydet
      var outputFile = path.join(projectPath, 'chatgpt_output.md');
      fs.writeFileSync(outputFile, '# ' + args.projectName + '\n\n## Görev\n' + args.task + '\n\n## ChatGPT Cevabı\n\n' + chatGptAnswer, 'utf8');
      autoLog('step', 'Cevap dosyaya kaydedildi: ' + outputFile);

      // 5. Eğer cevap kod içeriyorsa ayrı dosyalara çıkar
      // ChatGPT genellikle "# filename.py" veya "**filename.py**" şeklinde dosya adı belirtir
      var codeBlocks = chatGptAnswer.match(/```(\w+)?\n([\s\S]*?)```/g);
      var savedFiles = [];
      if (codeBlocks && codeBlocks.length > 0) {
        codeBlocks.forEach(function (block, i) {
          var langMatch = block.match(/```(\w+)?/);
          var lang = (langMatch && langMatch[1]) ? langMatch[1] : 'txt';
          var code = block.replace(/```\w*\n/, '').replace(/```\s*$/, '').trim();

          // Dosya adını ChatGPT cevabından çıkarmaya çalış
          // Örn: "### main.py" veya "**app.js**" veya "# index.html" gibi
          var extMap = { javascript: 'js', js: 'js', python: 'py', py: 'py', typescript: 'ts', ts: 'ts', html: 'html', css: 'css', json: 'json', bash: 'sh', sh: 'sh', sql: 'sql', yaml: 'yaml', yml: 'yml', go: 'go', rust: 'rs', cpp: 'cpp', c: 'c', java: 'java', php: 'php', ruby: 'rb', swift: 'swift', kotlin: 'kt' };
          var ext = extMap[lang.toLowerCase()] || lang || 'txt';

          // Kod bloğundan önce dosya adı var mı ara
          var blockIdx = chatGptAnswer.indexOf(block);
          var beforeBlock = chatGptAnswer.slice(Math.max(0, blockIdx - 200), blockIdx);
          var fnameMatch = beforeBlock.match(/(?:###?\s+|`{0,1}\*{0,2})([\w\-\.]+\.\w+)(?:`{0,1}\*{0,2})\s*$/m);
          var fileName = fnameMatch ? fnameMatch[1] : ('code_' + (i + 1) + '.' + ext);

          // Aynı isimde dosya varsa numara ekle
          var codeFile = path.join(projectPath, fileName);
          if (fs.existsSync(codeFile)) codeFile = path.join(projectPath, 'code_' + (i + 1) + '_' + fileName);

          fs.writeFileSync(codeFile, code, 'utf8');
          savedFiles.push(fileName);
          brain.mem.remember('chatgpt:file:' + args.projectName + ':' + fileName, codeFile, 0.75);
        });
        autoLog('step', codeBlocks.length + ' dosya kaydedildi: ' + savedFiles.join(', '));
      }

      // 6. Brain'e bildir
      brain.onAgentDone('chatgpt_project:' + args.projectName, [], 'success');
      LEARN.codeFiles = LEARN.codeFiles || [];
      LEARN.codeFiles.push({ file: projectPath, task: args.task.slice(0, 60), ts: Date.now() });
      _saveLearn();

      var result = 'ChatGPT projesi tamamlandı: ' + projectPath + ' | ' + (savedFiles.length > 0 ? savedFiles.join(', ') : 'kod bloğu bulunamadı — chatgpt_output.md içinde');
      autoLog('success', result);
      return result;
    },

    // ── Gemini Web araçları (API yok, puppeteer ile tarayıcı kontrolü) ──
    // Mantık: Ollama prompt hazırlar → gemini.google.com açılır → prompt yazılır
    // → cevap beklenir → cevap alınır → dosyaya kaydedilir → brain'e bildirilir

    gemini_ask: async function (args) {
      if (!args.prompt) throw new Error('prompt gerekli');
      autoLog('step', 'Gemini web arayüzü açılıyor...', { prompt: args.prompt.slice(0, 80) });

      var puppeteer = require('puppeteer-extra');
      var StealthPlugin = require('puppeteer-extra-plugin-stealth');
      puppeteer.use(StealthPlugin());

      // Oturum klasörü — bir kez giriş yap, sonraki çalıştırmalarda hatırlar
      var geminiProfileDir = path.join(require('os').homedir(), '.kaanai_browser_profiles', 'gemini');
      if (!fs.existsSync(geminiProfileDir)) fs.mkdirSync(geminiProfileDir, { recursive: true });

      var browser = null;
      try {
        browser = await puppeteer.launch({
          headless: false,
          userDataDir: geminiProfileDir,
          args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-blink-features=AutomationControlled',
            '--start-maximized'
          ],
          defaultViewport: null,
          ignoreHTTPSErrors: true
        });

        var page = await browser.newPage();
        await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');

        await page.evaluateOnNewDocument(function () {
          Object.defineProperty(navigator, 'webdriver', { get: function () { return false; } });
        });

        autoLog('step', 'gemini.google.com açılıyor...');
        await page.goto('https://gemini.google.com', { waitUntil: 'networkidle2', timeout: 45000 });
        await new Promise(function (r) { setTimeout(r, 5000); });

        // Giriş gerekiyorsa kullanıcıya 45 saniye ver
        var currentUrl = page.url();
        autoLog('step', 'Mevcut URL: ' + currentUrl);
        if (currentUrl.includes('accounts.google') || currentUrl.includes('signin') || currentUrl.includes('login')) {
          autoLog('step', '⚠️ Gemini giriş sayfası — 45 saniye içinde manuel giriş yapın...');
          await new Promise(function (r) { setTimeout(r, 45000); });
          await new Promise(function (r) { setTimeout(r, 3000); });
        }

        // Gemini prompt alanı selector'ları (öncelik sırasıyla)
        autoLog('step', 'Prompt alanı aranıyor...');
        var promptBox = null;
        var selectors = [
          'rich-textarea .ql-editor',               // Gemini ana input (Quill editor)
          'rich-textarea div[contenteditable="true"]', // Quill contenteditable
          'div[contenteditable="true"][data-placeholder]', // placeholder'lı
          'div[contenteditable="true"]',             // genel contenteditable
          'textarea[placeholder*="Gemini"]',         // textarea fallback
          'textarea'                                 // son çare
        ];

        for (var si = 0; si < selectors.length; si++) {
          try {
            promptBox = await page.waitForSelector(selectors[si], { timeout: 4000, visible: true });
            if (promptBox) {
              autoLog('step', 'Prompt alanı bulundu: ' + selectors[si]);
              break;
            }
          } catch (e) { /* bu selector çalışmadı, diğerini dene */ }
        }

        if (!promptBox) throw new Error('Prompt alanı bulunamadı — Gemini sayfası yüklenemedi veya giriş yapılmadı');

        await promptBox.click({ clickCount: 3 });
        await new Promise(function (r) { setTimeout(r, 500); });

        // Clipboard üzerinden yapıştır
        var safePrompt = args.prompt.slice(0, 3000);

        await page.evaluate(function (text) {
          return navigator.clipboard.writeText(text).catch(function () {
            var el = document.activeElement;
            if (el && el.contentEditable === 'true') {
              el.innerText = text;
              el.dispatchEvent(new InputEvent('input', { bubbles: true, data: text }));
            }
          });
        }, safePrompt);

        await page.keyboard.down('Meta');
        await page.keyboard.press('v');
        await page.keyboard.up('Meta');
        await new Promise(function (r) { setTimeout(r, 1000); });

        // Fallback: execCommand
        var currentContent = await promptBox.evaluate(function (el) {
          return el.innerText || el.value || '';
        });
        if (!currentContent || currentContent.trim().length < 10) {
          autoLog('step', 'Clipboard paste çalışmadı, execCommand deniyor...');
          await page.evaluate(function (text) {
            var el = document.activeElement;
            if (!el) return;
            if (el.contentEditable === 'true') {
              el.innerText = text;
              el.dispatchEvent(new InputEvent('input', { bubbles: true, data: text }));
            } else if (el.tagName && el.tagName.toLowerCase() === 'textarea') {
              var nativeSet = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value');
              if (nativeSet && nativeSet.set) {
                nativeSet.set.call(el, text);
                el.dispatchEvent(new Event('input', { bubbles: true }));
              }
            }
          }, safePrompt);
          await new Promise(function (r) { setTimeout(r, 500); });
        }

        await new Promise(function (r) { setTimeout(r, 800); });

        // Gönder butonunu bul — Gemini'de genellikle mat-icon-button veya send ikonu
        autoLog('step', 'Prompt gönderiliyor...');
        var sendBtn = null;
        var sendSelectors = [
          'button[aria-label="Send message"]',
          'button[aria-label="Mesaj gönder"]',
          'button.send-button',
          'button[data-mat-icon-name="send"]',
          'mat-icon[data-mat-icon-name="send"]',
          'button[type="submit"]',
          '.send-button'
        ];
        for (var bi = 0; bi < sendSelectors.length; bi++) {
          try {
            var btn = await page.$(sendSelectors[bi]);
            if (btn) { sendBtn = btn; break; }
          } catch (e) { }
        }

        if (sendBtn) {
          await sendBtn.click();
          autoLog('step', 'Gönder butonuna basıldı');
        } else {
          await page.keyboard.press('Enter');
          autoLog('step', 'Enter ile gönderildi');
        }

        autoLog('step', 'Cevap bekleniyor...');

        // Gemini üretim bitişini bekle
        // Bitiş sinyali: gönder butonu tekrar aktif olur (disabled kalkar)
        // veya input alanı tekrar yazılabilir hale gelir
        try {
          // Önce üretimin başladığını anla — input disabled olur veya model-response gelir
          await new Promise(function (r) { setTimeout(r, 3000); }); // kısa bekle, üretim başlasın
          autoLog('step', 'Gemini cevap üretiyor...');

          // Bitiş: send butonu enabled olunca VEYA input alanı tekrar aktif olunca
          await page.waitForFunction(function () {
            // Yöntem 1: gönder butonu artık disabled değil
            var sendBtns = document.querySelectorAll('button[aria-label="Send message"], button.send-button, button[data-mat-icon-name="send"]');
            for (var i = 0; i < sendBtns.length; i++) {
              if (!sendBtns[i].disabled) return true;
            }
            // Yöntem 2: "Stop generating" butonu YOK (üretim bitti)
            var stopBtn = document.querySelector('button[aria-label="Stop generating"], .stop-button, [class*="stop"]');
            if (!stopBtn) {
              // Yöntem 3: model-response içinde içerik var ve düzenleme ikonu görünüyor
              var responses = document.querySelectorAll('model-response');
              if (responses && responses.length > 0) {
                var lastResponse = responses[responses.length - 1];
                // Cevap container'ı dolu ve en az 20 karakter var
                if (lastResponse.innerText && lastResponse.innerText.trim().length > 20) return true;
              }
            }
            return false;
          }, { timeout: 120000, polling: 1500 });

          await new Promise(function (r) { setTimeout(r, 2000); }); // son render için bekle
          autoLog('step', 'Gemini cevap üretimini tamamladı');
        } catch (e) {
          var waitMs = args.waitMs || 40000;
          autoLog('step', 'Bitiş sinyali izlenemedi, ' + (waitMs / 1000) + 'sn bekleniyor...');
          await new Promise(function (r) { setTimeout(r, waitMs); });
        }

        // Cevabı oku
        var answer = await page.evaluate(function () {
          var candidates = [];

          // Yöntem 1: Gemini model-response elementi
          var responses = document.querySelectorAll('model-response');
          if (responses && responses.length > 0) {
            candidates.push(responses[responses.length - 1].innerText || '');
          }

          // Yöntem 2: message-content
          var msgs = document.querySelectorAll('.message-content, [class*="response-content"]');
          if (msgs && msgs.length > 0) {
            candidates.push(msgs[msgs.length - 1].innerText || '');
          }

          // Yöntem 3: markdown container
          var md = document.querySelectorAll('.markdown, [class*="markdown"], .response-text');
          if (md && md.length > 0) {
            var combined = Array.from(md).map(function (b) { return b.innerText; }).join('\n\n');
            if (combined.length > 50) candidates.push(combined);
          }

          if (candidates.length === 0) return '';
          return candidates.sort(function (a, b) { return b.length - a.length; })[0];
        });

        await browser.close();
        browser = null;

        if (!answer || answer.length < 10) {
          throw new Error('Gemini cevabı alınamadı — sayfa yapısı değişmiş olabilir veya üretim tamamlanmadı');
        }

        brain.mem.remember('gemini:last_answer', answer.slice(0, 200), 0.8);
        autoLog('success', 'Gemini cevabı alındı (' + answer.length + ' karakter)');
        return answer;

      } catch (e) {
        if (browser) { try { await browser.close(); } catch (e2) { } }
        throw new Error('Gemini hatası: ' + e.message);
      }
    },

    // Tam Gemini iş akışı: Ollama prompt hazırlar → Gemini yazar → dosyaya kaydeder
    gemini_project: async function (args) {
      if (!args.projectName || !args.task) throw new Error('projectName ve task gerekli');

      var projectPath = path.join(process.cwd(), 'projects', args.projectName);
      autoLog('goal', 'Gemini projesi başlatılıyor: ' + args.projectName);

      if (!fs.existsSync(projectPath)) fs.mkdirSync(projectPath, { recursive: true });
      brain.mem.remember('gemini:project:' + args.projectName, args.task.slice(0, 100), 0.8);

      // Ollama ile teknik prompt hazırla
      autoLog('step', 'Ollama teknik spec hazırlıyor...');
      var ollamaRes = await axios.post('http://localhost:11434/api/chat', {
        model: process.env.OLLAMA_MODEL || 'llama3.1:8b',
        stream: false,
        messages: [
          {
            role: 'system',
            content: 'Sen bir yazılım mimarısın. Kullanıcının isteğini Gemini\'ye verilecek detaylı bir teknik prompt\'a çevir. Türkçe veya İngilizce olabilir. Şu formatı kullan: \"Görev: ... Gereksinimler: ... Teknoloji: ... Dosya yapısı: ... Önemli notlar: ...\"'
          },
          { role: 'user', content: args.task + (args.details ? ' Detaylar: ' + args.details : '') }
        ]
      });
      var technicalPrompt = ollamaRes.data.message.content;
      autoLog('step', 'Teknik prompt hazır: ' + technicalPrompt.slice(0, 100) + '...');

      // Gemini'ye sor
      var geminiAnswer = await AUTO_TOOLS.gemini_ask({
        prompt: technicalPrompt,
        waitMs: args.waitMs || 35000
      });

      // Cevabı dosyaya kaydet
      var outputFile = path.join(projectPath, 'gemini_output.md');
      fs.writeFileSync(outputFile, '# ' + args.projectName + '\n\n## Görev\n' + args.task + '\n\n## Gemini Cevabı\n\n' + geminiAnswer, 'utf8');
      autoLog('step', 'Cevap dosyaya kaydedildi: ' + outputFile);

      // Kod bloklarını ayrı dosyalara çıkar
      var codeBlocks = geminiAnswer.match(/```(\w+)?\n([\s\S]*?)```/g);
      var savedFiles = [];
      if (codeBlocks && codeBlocks.length > 0) {
        codeBlocks.forEach(function (block, i) {
          var langMatch = block.match(/```(\w+)?/);
          var lang = (langMatch && langMatch[1]) ? langMatch[1] : 'txt';
          var code = block.replace(/```\w*\n/, '').replace(/```\s*$/, '').trim();
          var extMap = { javascript: 'js', js: 'js', python: 'py', py: 'py', typescript: 'ts', ts: 'ts', html: 'html', css: 'css', json: 'json', bash: 'sh', sh: 'sh', sql: 'sql', yaml: 'yaml', yml: 'yml', go: 'go', rust: 'rs', cpp: 'cpp', c: 'c', java: 'java', php: 'php', ruby: 'rb', swift: 'swift', kotlin: 'kt' };
          var ext = extMap[lang.toLowerCase()] || lang || 'txt';
          var blockIdx = geminiAnswer.indexOf(block);
          var beforeBlock = geminiAnswer.slice(Math.max(0, blockIdx - 200), blockIdx);
          var fnameMatch = beforeBlock.match(/(?:###?\s+|`{0,1}\*{0,2})([\w\-\.]+\.\w+)(?:`{0,1}\*{0,2})\s*$/m);
          var fileName = fnameMatch ? fnameMatch[1] : ('code_' + (i + 1) + '.' + ext);
          var codeFile = path.join(projectPath, fileName);
          if (fs.existsSync(codeFile)) codeFile = path.join(projectPath, 'code_' + (i + 1) + '_' + fileName);
          fs.writeFileSync(codeFile, code, 'utf8');
          savedFiles.push(fileName);
          brain.mem.remember('gemini:file:' + args.projectName + ':' + fileName, codeFile, 0.75);
        });
        autoLog('step', codeBlocks.length + ' dosya kaydedildi: ' + savedFiles.join(', '));
      }

      brain.onAgentDone('gemini_project:' + args.projectName, [], 'success');
      LEARN.codeFiles = LEARN.codeFiles || [];
      LEARN.codeFiles.push({ file: projectPath, task: args.task.slice(0, 60), ts: Date.now() });
      _saveLearn();

      var result = 'Gemini projesi tamamlandı: ' + projectPath + ' | ' + (savedFiles.length > 0 ? savedFiles.join(', ') : 'kod bloğu bulunamadı — gemini_output.md içinde');
      autoLog('success', result);
      return result;
    },

    // ── Claude AI Web araçları (API yok, puppeteer ile tarayıcı kontrolü) ──
    // Mantık: Ollama prompt hazırlar → claude.ai açılır → prompt yazılır
    // → cevap beklenir → cevap alınır → dosyaya kaydedilir → brain'e bildirilir

    claudeai_ask: async function (args) {
      if (!args.prompt) throw new Error('prompt gerekli');
      autoLog('step', 'Claude.ai web arayüzü açılıyor...', { prompt: args.prompt.slice(0, 80) });

      var puppeteer = require('puppeteer-extra');
      var StealthPlugin = require('puppeteer-extra-plugin-stealth');
      puppeteer.use(StealthPlugin());

      // Oturum klasörü — bir kez giriş yap, sonraki çalıştırmalarda hatırlar
      var claudeProfileDir = path.join(require('os').homedir(), '.kaanai_browser_profiles', 'claudeai');
      if (!fs.existsSync(claudeProfileDir)) fs.mkdirSync(claudeProfileDir, { recursive: true });

      var browser = null;
      try {
        browser = await puppeteer.launch({
          headless: false,
          userDataDir: claudeProfileDir,
          args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-blink-features=AutomationControlled',
            '--start-maximized'
          ],
          defaultViewport: null,
          ignoreHTTPSErrors: true
        });

        var page = await browser.newPage();
        await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');

        await page.evaluateOnNewDocument(function () {
          Object.defineProperty(navigator, 'webdriver', { get: function () { return false; } });
        });

        autoLog('step', 'claude.ai açılıyor...');
        await page.goto('https://claude.ai/new', { waitUntil: 'networkidle2', timeout: 45000 });
        await new Promise(function (r) { setTimeout(r, 5000); });

        // Giriş gerekiyorsa kullanıcıya 45 saniye ver
        var currentUrl = page.url();
        autoLog('step', 'Mevcut URL: ' + currentUrl);
        if (currentUrl.includes('login') || currentUrl.includes('auth') || currentUrl.includes('signin')) {
          autoLog('step', '⚠️ Claude.ai giriş sayfası — 45 saniye içinde manuel giriş yapın...');
          await new Promise(function (r) { setTimeout(r, 45000); });
          await new Promise(function (r) { setTimeout(r, 3000); });
        }

        // Claude.ai prompt alanı selector'ları
        autoLog('step', 'Prompt alanı aranıyor...');
        var promptBox = null;
        var selectors = [
          'div[contenteditable="true"].ProseMirror',   // Claude ProseMirror editörü
          '.ProseMirror',                               // ProseMirror genel
          'div[contenteditable="true"][data-placeholder]', // placeholder'lı
          'div[contenteditable="true"]',                // genel contenteditable
          'textarea[placeholder*="Claude"]',            // textarea fallback
          'textarea'                                    // son çare
        ];

        for (var si = 0; si < selectors.length; si++) {
          try {
            promptBox = await page.waitForSelector(selectors[si], { timeout: 4000, visible: true });
            if (promptBox) {
              autoLog('step', 'Prompt alanı bulundu: ' + selectors[si]);
              break;
            }
          } catch (e) { /* bu selector çalışmadı, diğerini dene */ }
        }

        if (!promptBox) throw new Error('Prompt alanı bulunamadı — Claude.ai sayfası yüklenemedi veya giriş yapılmadı');

        await promptBox.click({ clickCount: 3 });
        await new Promise(function (r) { setTimeout(r, 500); });

        // Clipboard üzerinden yapıştır
        var safePrompt = args.prompt.slice(0, 3000);

        await page.evaluate(function (text) {
          return navigator.clipboard.writeText(text).catch(function () {
            var el = document.activeElement;
            if (el && el.contentEditable === 'true') {
              el.innerText = text;
              el.dispatchEvent(new InputEvent('input', { bubbles: true, data: text }));
            }
          });
        }, safePrompt);

        await page.keyboard.down('Meta');
        await page.keyboard.press('v');
        await page.keyboard.up('Meta');
        await new Promise(function (r) { setTimeout(r, 1000); });

        // Fallback: execCommand
        var currentContent = await promptBox.evaluate(function (el) {
          return el.innerText || el.value || '';
        });
        if (!currentContent || currentContent.trim().length < 10) {
          autoLog('step', 'Clipboard paste çalışmadı, execCommand deniyor...');
          await page.evaluate(function (text) {
            var el = document.activeElement;
            if (!el) return;
            if (el.contentEditable === 'true') {
              el.innerText = text;
              el.dispatchEvent(new InputEvent('input', { bubbles: true, data: text }));
            }
          }, safePrompt);
          await new Promise(function (r) { setTimeout(r, 500); });
        }

        await new Promise(function (r) { setTimeout(r, 800); });

        // Gönder butonunu bul — Claude.ai'de genellikle aria-label="Send Message"
        autoLog('step', 'Prompt gönderiliyor...');
        var sendBtn = null;
        var sendSelectors = [
          'button[aria-label="Send Message"]',
          'button[aria-label="Send message"]',
          'button[aria-label="Mesaj gönder"]',
          'button[type="submit"]',
          'button.send-button',
          'form button:last-child'
        ];
        for (var bi = 0; bi < sendSelectors.length; bi++) {
          try {
            var btn = await page.$(sendSelectors[bi]);
            if (btn) { sendBtn = btn; break; }
          } catch (e) { }
        }

        if (sendBtn) {
          await sendBtn.click();
          autoLog('step', 'Gönder butonuna basıldı');
        } else {
          await page.keyboard.press('Enter');
          autoLog('step', 'Enter ile gönderildi');
        }

        autoLog('step', 'Cevap bekleniyor...');

        // Claude.ai üretim bitişini bekle
        // Strateji: önce üretim başlamasını bekle, sonra bitmesini
        await new Promise(function (r) { setTimeout(r, 3000); }); // üretim başlasın

        try {
          autoLog('step', 'Claude.ai cevap üretiyor...');

          // Bitiş sinyalleri (öncelik sırasıyla):
          // 1. data-is-streaming="false" veya attribute tamamen kalktı
          // 2. Stop butonu yok + içerik kararlı hale geldi (2 ölçümde aynı uzunluk)
          await page.waitForFunction(function () {
            // Yöntem 1: streaming attribute kontrolü
            var streamingEl = document.querySelector('[data-is-streaming]');
            if (streamingEl) {
              return streamingEl.getAttribute('data-is-streaming') === 'false';
            }

            // Yöntem 2: Stop / cancel butonu yok mu?
            var stopBtn = document.querySelector(
              'button[aria-label="Stop"], button[aria-label="Stop generating"], ' +
              '[data-testid="stop-button"], button.stop-button'
            );
            if (stopBtn) return false; // hâlâ üretiyor

            // Yöntem 3: İçerik var mı ve gönder butonu aktif mi?
            var sendBtn = document.querySelector(
              'button[aria-label="Send Message"], button[aria-label="Send message"], ' +
              'button[data-testid="send-button"]'
            );
            if (sendBtn && !sendBtn.disabled) {
              // Cevap container'ı dolu mu?
              var msgs = document.querySelectorAll(
                '[data-testid="assistant-message"], .assistant-message, ' +
                '[class*="assistant"][class*="message"]'
              );
              if (msgs && msgs.length > 0) {
                var txt = msgs[msgs.length - 1].innerText || '';
                return txt.trim().length > 50;
              }
            }
            return false;
          }, { timeout: 120000, polling: 1500 });

          // İçerik tamamen render olsun diye ekstra bekle
          await new Promise(function (r) { setTimeout(r, 3000); });
          autoLog('step', 'Claude.ai cevap üretimini tamamladı');

        } catch (e) {
          // Hiçbir sinyal çalışmadıysa sabit bekle — minimum 45sn
          var waitMs = Math.max(args.waitMs || 45000, 45000);
          autoLog('step', 'Bitiş sinyali izlenemedi, ' + (waitMs / 1000) + 'sn bekleniyor...');
          await new Promise(function (r) { setTimeout(r, waitMs); });
        }

        // Cevabı oku — kısa gelirse 2 kez daha dene
        var answer = '';
        for (var readAttempt = 0; readAttempt < 3; readAttempt++) {
          if (readAttempt > 0) {
            autoLog('step', 'Cevap kısa geldi, ' + (readAttempt * 5) + 'sn daha bekleniyor...');
            await new Promise(function (r) { setTimeout(r, 5000); });
          }

          answer = await page.evaluate(function () {
            var candidates = [];

            // Yöntem 1: Claude.ai assistant mesajları (data-testid)
            var msgs = document.querySelectorAll('[data-testid="assistant-message"], .assistant-message');
            if (msgs && msgs.length > 0) {
              candidates.push(msgs[msgs.length - 1].innerText || '');
            }

            // Yöntem 2: prose container (Claude markdown render)
            var prose = document.querySelectorAll('.prose, [class*="prose"]');
            if (prose && prose.length > 0) {
              var combined = Array.from(prose).map(function (b) { return b.innerText; }).join('\n\n');
              if (combined.length > 50) candidates.push(combined);
            }

            // Yöntem 3: genel mesaj container
            var divs = document.querySelectorAll('[class*="message"][class*="assistant"], [class*="claude"]');
            if (divs && divs.length > 0) {
              candidates.push(divs[divs.length - 1].innerText || '');
            }

            // Yöntem 4: tüm sayfa içeriğinden AI cevabını çıkar (son çare)
            var allContent = document.querySelectorAll('[class*="content"], [class*="response"], [class*="answer"]');
            if (allContent && allContent.length > 0) {
              var longest = Array.from(allContent)
                .map(function (el) { return el.innerText || ''; })
                .sort(function (a, b) { return b.length - a.length; })[0];
              if (longest && longest.length > 100) candidates.push(longest);
            }

            if (candidates.length === 0) return '';
            return candidates.sort(function (a, b) { return b.length - a.length; })[0];
          });

          // 200+ karakter geldi mi? Yeterliyse dur
          if (answer && answer.length >= 200) break;
        }

        await browser.close();
        browser = null;

        if (!answer || answer.length < 10) {
          throw new Error('Claude.ai cevabı alınamadı — sayfa yapısı değişmiş olabilir veya üretim tamamlanmadı');
        }

        brain.mem.remember('claudeai:last_answer', answer.slice(0, 200), 0.8);
        autoLog('success', 'Claude.ai cevabı alındı (' + answer.length + ' karakter)');
        return answer;

      } catch (e) {
        if (browser) { try { await browser.close(); } catch (e2) { } }
        throw new Error('Claude.ai hatası: ' + e.message);
      }
    },

    // Tam Claude.ai iş akışı: Ollama prompt hazırlar → Claude.ai yazar → dosyaya kaydeder
    claudeai_project: async function (args) {
      if (!args.projectName || !args.task) throw new Error('projectName ve task gerekli');

      var projectPath = path.join(process.cwd(), 'projects', args.projectName);
      autoLog('goal', 'Claude.ai projesi başlatılıyor: ' + args.projectName);

      if (!fs.existsSync(projectPath)) fs.mkdirSync(projectPath, { recursive: true });
      brain.mem.remember('claudeai:project:' + args.projectName, args.task.slice(0, 100), 0.8);

      // Ollama ile teknik prompt hazırla
      autoLog('step', 'Ollama teknik spec hazırlıyor...');
      var ollamaRes = await axios.post('http://localhost:11434/api/chat', {
        model: process.env.OLLAMA_MODEL || 'llama3.1:8b',
        stream: false,
        messages: [
          {
            role: 'system',
            content: 'Sen bir yazılım mimarısın. Kullanıcının isteğini Claude.ai\'ye verilecek detaylı bir teknik prompt\'a çevir. Türkçe veya İngilizce olabilir. Şu formatı kullan: \"Görev: ... Gereksinimler: ... Teknoloji: ... Dosya yapısı: ... Önemli notlar: ...\"'
          },
          { role: 'user', content: args.task + (args.details ? ' Detaylar: ' + args.details : '') }
        ]
      });
      var technicalPrompt = ollamaRes.data.message.content;
      autoLog('step', 'Teknik prompt hazır: ' + technicalPrompt.slice(0, 100) + '...');

      // Claude.ai'ye sor
      var claudeAnswer = await AUTO_TOOLS.claudeai_ask({
        prompt: technicalPrompt,
        waitMs: args.waitMs || 35000
      });

      // Cevabı dosyaya kaydet
      var outputFile = path.join(projectPath, 'claudeai_output.md');
      fs.writeFileSync(outputFile, '# ' + args.projectName + '\n\n## Görev\n' + args.task + '\n\n## Claude.ai Cevabı\n\n' + claudeAnswer, 'utf8');
      autoLog('step', 'Cevap dosyaya kaydedildi: ' + outputFile);

      // Kod bloklarını ayrı dosyalara çıkar
      var codeBlocks = claudeAnswer.match(/```(\w+)?\n([\s\S]*?)```/g);
      var savedFiles = [];
      if (codeBlocks && codeBlocks.length > 0) {
        codeBlocks.forEach(function (block, i) {
          var langMatch = block.match(/```(\w+)?/);
          var lang = (langMatch && langMatch[1]) ? langMatch[1] : 'txt';
          var code = block.replace(/```\w*\n/, '').replace(/```\s*$/, '').trim();
          var extMap = { javascript: 'js', js: 'js', python: 'py', py: 'py', typescript: 'ts', ts: 'ts', html: 'html', css: 'css', json: 'json', bash: 'sh', sh: 'sh', sql: 'sql', yaml: 'yaml', yml: 'yml', go: 'go', rust: 'rs', cpp: 'cpp', c: 'c', java: 'java', php: 'php', ruby: 'rb', swift: 'swift', kotlin: 'kt' };
          var ext = extMap[lang.toLowerCase()] || lang || 'txt';
          var blockIdx = claudeAnswer.indexOf(block);
          var beforeBlock = claudeAnswer.slice(Math.max(0, blockIdx - 200), blockIdx);
          var fnameMatch = beforeBlock.match(/(?:###?\s+|`{0,1}\*{0,2})([\w\-\.]+\.\w+)(?:`{0,1}\*{0,2})\s*$/m);
          var fileName = fnameMatch ? fnameMatch[1] : ('code_' + (i + 1) + '.' + ext);
          var codeFile = path.join(projectPath, fileName);
          if (fs.existsSync(codeFile)) codeFile = path.join(projectPath, 'code_' + (i + 1) + '_' + fileName);
          fs.writeFileSync(codeFile, code, 'utf8');
          savedFiles.push(fileName);
          brain.mem.remember('claudeai:file:' + args.projectName + ':' + fileName, codeFile, 0.75);
        });
        autoLog('step', codeBlocks.length + ' dosya kaydedildi: ' + savedFiles.join(', '));
      }

      brain.onAgentDone('claudeai_project:' + args.projectName, [], 'success');
      LEARN.codeFiles = LEARN.codeFiles || [];
      LEARN.codeFiles.push({ file: projectPath, task: args.task.slice(0, 60), ts: Date.now() });
      _saveLearn();

      var result = 'Claude.ai projesi tamamlandı: ' + projectPath + ' | ' + (savedFiles.length > 0 ? savedFiles.join(', ') : 'kod bloğu bulunamadı — claudeai_output.md içinde');
      autoLog('success', result);
      return result;
    },

    // ═══════════════════════════════════════════════════════════════
    // 🖥️  GENİŞ UYGULAMA KONTROL — VSCode, Unity, Xcode, Figma,
    //     Office (AI destekli), Obsidian, Terminal, Spotlight, genel
    //
    //  NOT: server.js'de zaten olan köprüler:
    //   /jarvis/vscode/open          → open_vscode burada sadece path desteği ekler
    //   /jarvis/office/word/open+type → word_ai_write burada AI içerik + köprü
    //   /jarvis/office/excel/write   → excel_ai_fill burada AI tablo + köprü
    //   /jarvis/office/ppt/add-slide → ppt_ai_create burada AI slayt + köprü
    //   /jarvis/obsidian/*           → obsidian_ai_note burada AI not + köprü
    //   /jarvis/control/keyboard/*   → app_type, app_hotkey zaten üstte var
    //   /jarvis/spotlight/open       → spotlight_open burada köprü
    //   /jarvis/screenshot           → screen_ai_analyze burada AI analiz + köprü
    // ═══════════════════════════════════════════════════════════════

    // ── VSCode ───────────────────────────────────────────────────
    // server.js /jarvis/vscode/open sadece 'code .' yapıyor
    // Burada: path desteği + AI extension önerisi
    open_vscode: async function (args) {
      autoLog('step', 'VSCode aciliyor', { path: args.projectPath || '.' });
      return new Promise(function (resolve, reject) {
        var cmd = args.projectPath ? 'code "' + args.projectPath + '"' : 'code .';
        exec(cmd, { timeout: 10000 }, function (err) {
          if (err) return reject(new Error('VSCode acilamadi: ' + err.message));
          brain.mem.remember('vscode:lastProject', args.projectPath || '.', 0.7);
          setTimeout(resolve, 2000, 'VSCode acildi: ' + (args.projectPath || '.'));
        });
      });
    },

    vscode_ai_task: async function (args) {
      if (!args.task) throw new Error('task gerekli');
      autoLog('step', 'VSCode AI gorevi', { task: args.task.slice(0, 60) });
      // Ollama ile komut paleti komutu uret
      var r = await axios.post(OLLAMA + '/api/generate', {
        model: MODEL, stream: false,
        prompt: 'VSCode Command Palette komutu onerisi. Gorev: ' + args.task + ' Sadece komut adini yaz, aciklama yapma:'
      });
      var cmd = r.data.response.trim().slice(0, 100);
      // VSCode'u ac, Cmd+Shift+P, komutu yaz
      return new Promise(function (resolve, reject) {
        var scriptLines = [
          'tell application "Visual Studio Code" to activate',
          'delay 0.8',
          'tell application "System Events"',
          'keystroke "p" using {command down, shift down}',
          'delay 0.6',
          'keystroke "' + cmd.replace(/"/g, '').slice(0, 80) + '"',
          'end tell'
        ];
        var sf = '/tmp/vscode_' + Date.now() + '.scpt';
        fs.writeFileSync(sf, scriptLines.join('\n'));
        exec('osascript ' + sf, { timeout: 10000 }, function (err) {
          try { fs.unlinkSync(sf); } catch (e) { }
          if (err) return reject(new Error('VSCode AI hatasi: ' + err.message));
          resolve('VSCode komutu: ' + cmd);
        });
      });
    },

    // ── Unity ────────────────────────────────────────────────────
    open_unity: async function (args) {
      autoLog('step', 'Unity aciliyor');
      return new Promise(function (resolve, reject) {
        var cmd = args.projectPath
          ? 'open -a "Unity" "' + args.projectPath + '"'
          : 'open -a "Unity Hub"';
        exec(cmd, { timeout: 15000 }, function (err) {
          if (err) return reject(new Error('Unity acilamadi: ' + err.message));
          setTimeout(resolve, 4000, 'Unity acildi');
        });
      });
    },

    unity_create_script: async function (args) {
      if (!args.scriptName || !args.task) throw new Error('scriptName ve task gerekli');
      autoLog('step', 'Unity C# scripti yaziliyor', { name: args.scriptName });
      var r = await axios.post(OLLAMA + '/api/generate', {
        model: MODEL, stream: false,
        prompt: 'Unity C# MonoBehaviour scripti yaz. Gorev: ' + args.task + ' SADECE KOD:'
      });
      var code = r.data.response.replace(/```[\w]*/g, '').replace(/```/g, '').trim();
      var dir = args.projectPath
        ? path.join(args.projectPath, 'Assets', 'Scripts')
        : path.join(process.cwd(), 'unity-scripts');
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      var filePath = path.join(dir, args.scriptName + '.cs');
      fs.writeFileSync(filePath, code, 'utf8');
      brain.mem.remember('unity:script:' + args.scriptName, filePath, 0.75);
      LEARN.codeFiles.push({ file: filePath, task: args.task.slice(0, 60), ts: Date.now() });
      _saveLearn();
      return 'Unity scripti yazildi: ' + filePath + ' (' + code.length + ' karakter)';
    },

    // ── Xcode ────────────────────────────────────────────────────
    open_xcode: async function (args) {
      autoLog('step', 'Xcode aciliyor');
      return new Promise(function (resolve, reject) {
        var cmd = args.projectPath ? 'open -a "Xcode" "' + args.projectPath + '"' : 'open -a "Xcode"';
        exec(cmd, { timeout: 15000 }, function (err) {
          if (err) return reject(new Error('Xcode acilamadi: ' + err.message));
          setTimeout(resolve, 4000, 'Xcode acildi');
        });
      });
    },

    xcode_write_swift: async function (args) {
      if (!args.fileName || !args.task) throw new Error('fileName ve task gerekli');
      autoLog('step', 'Swift dosyasi yaziliyor', { name: args.fileName });
      var r = await axios.post(OLLAMA + '/api/generate', {
        model: MODEL, stream: false,
        prompt: 'Swift/SwiftUI kodu yaz. Gorev: ' + args.task + ' SADECE KOD:'
      });
      var code = r.data.response.replace(/```[\w]*/g, '').replace(/```/g, '').trim();
      var dir = args.projectPath || path.join(process.cwd(), 'swift-files');
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      var filePath = path.join(dir, args.fileName + '.swift');
      fs.writeFileSync(filePath, code, 'utf8');
      brain.mem.remember('xcode:file:' + args.fileName, filePath, 0.75);
      LEARN.codeFiles.push({ file: filePath, task: args.task.slice(0, 60), ts: Date.now() });
      _saveLearn();
      return 'Swift dosyasi yazildi: ' + filePath;
    },

    // ── Figma ────────────────────────────────────────────────────
    open_figma: async function (args) {
      autoLog('step', 'Figma aciliyor');
      return new Promise(function (resolve, reject) {
        var cmd = args.fileUrl ? 'open "' + args.fileUrl + '"' : 'open -a "Figma"';
        exec(cmd, { timeout: 10000 }, function (err) {
          if (err) return reject(new Error('Figma acilamadi: ' + err.message));
          setTimeout(resolve, 3000, 'Figma acildi');
        });
      });
    },

    figma_ai_spec: async function (args) {
      if (!args.component) throw new Error('component gerekli');
      autoLog('step', 'Figma AI spec olusturuluyor', { component: args.component });
      var r = await axios.post(OLLAMA + '/api/generate', {
        model: MODEL, stream: false,
        prompt: 'Figma UI component tasarim spesifikasyonu yaz. Component: ' + args.component + ' Renkler, boyutlar, tipografi, spacing JSON formatinda:'
      });
      var spec = r.data.response.trim().slice(0, 1500);
      var dir = path.join(process.cwd(), 'design-specs');
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      var filePath = path.join(dir, args.component.replace(/\s/g, '-') + '-spec.json');
      fs.writeFileSync(filePath, spec, 'utf8');
      brain.mem.remember('figma:spec:' + args.component, filePath, 0.7);
      return 'Figma spec yazildi: ' + filePath;
    },

    // ── Office: Word (server.js /jarvis/office/word/* üzerine AI katmanı) ──
    word_ai_write: async function (args) {
      if (!args.topic) throw new Error('topic gerekli');
      autoLog('step', 'Word AI ile yaziliyor', { topic: args.topic });
      var r = await axios.post(OLLAMA + '/api/generate', {
        model: MODEL, stream: false,
        prompt: 'Turkce profesyonel belge icerik yaz. Konu: ' + args.topic + ' Sadece metin:'
      });
      var content = r.data.response.trim().slice(0, 2000);
      var dir = path.join(process.cwd(), 'documents');
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      var fileName = args.topic.replace(/[^\w\s]/g, '').trim().slice(0, 30).replace(/\s+/g, '-') + '.txt';
      var filePath = path.join(dir, fileName);
      fs.writeFileSync(filePath, content, 'utf8');
      // server.js /jarvis/office/word/open + /type köprüsü
      try {
        await axios.get('http://localhost:' + PORT + '/jarvis/office/word/open');
        await new Promise(function (r) { setTimeout(r, 1500); });
        await axios.get('http://localhost:' + PORT + '/jarvis/office/word/type?text=' + encodeURIComponent(content.slice(0, 500)));
      } catch (e) { autoLog('warn', 'Word acilamadi, dosyaya kaydedildi'); }
      brain.mem.remember('word:' + args.topic, filePath, 0.75);
      return 'Word belgesi: ' + filePath + ' (' + content.length + ' karakter)';
    },

    // ── Office: Excel (server.js /jarvis/office/excel/* üzerine AI katmanı) ─
    excel_ai_fill: async function (args) {
      if (!args.topic) throw new Error('topic gerekli');
      autoLog('step', 'Excel AI ile dolduruluyor', { topic: args.topic });
      var r = await axios.post(OLLAMA + '/api/generate', {
        model: MODEL, stream: false,
        prompt: 'JSON tablo verisi uret. Konu: ' + args.topic + ' Format sadece: {"headers":["A","B"],"rows":[["v1","v2"]]} SADECE JSON:'
      });
      var match = r.data.response.match(/\{[\s\S]*\}/);
      if (!match) return 'Tablo verisi uretilemedi';
      var tableData;
      try { tableData = JSON.parse(match[0]); } catch (e) { return 'JSON parse hatasi'; }
      var csv = [tableData.headers].concat(tableData.rows || []).map(function (row) { return row.join(','); }).join('\n');
      var dir = path.join(process.cwd(), 'documents');
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      var filePath = path.join(dir, args.topic.slice(0, 20).replace(/\s+/g, '-') + '.csv');
      fs.writeFileSync(filePath, csv, 'utf8');
      // server.js /jarvis/office/excel/* köprüsü
      try {
        await axios.get('http://localhost:' + PORT + '/jarvis/office/excel/open');
        await new Promise(function (r) { setTimeout(r, 1500); });
        for (var i = 0; i < Math.min((tableData.headers || []).length, 5); i++) {
          var col = String.fromCharCode(65 + i);
          await axios.get('http://localhost:' + PORT + '/jarvis/office/excel/write?cell=' + col + '1&text=' + encodeURIComponent(tableData.headers[i]));
        }
      } catch (e) { autoLog('warn', 'Excel acilamadi, CSV kaydedildi'); }
      brain.mem.remember('excel:' + args.topic, filePath, 0.75);
      return 'Excel: ' + filePath + ' (' + (tableData.rows || []).length + ' satir)';
    },

    // ── Office: PowerPoint (server.js /jarvis/office/ppt/* üzerine AI katmanı)
    ppt_ai_create: async function (args) {
      if (!args.topic) throw new Error('topic gerekli');
      autoLog('step', 'PowerPoint AI ile olusturuluyor', { topic: args.topic });
      var r = await axios.post(OLLAMA + '/api/generate', {
        model: MODEL, stream: false,
        prompt: 'PowerPoint slayt listesi uret. Konu: ' + args.topic + ' Format sadece: [{"title":"...","content":"..."}] SADECE JSON ARRAY:'
      });
      var match = r.data.response.match(/\[[\s\S]*\]/);
      if (!match) return 'Slayt icerigi uretilemedi';
      var slides;
      try { slides = JSON.parse(match[0]).slice(0, 8); } catch (e) { return 'JSON parse hatasi'; }
      try {
        await axios.get('http://localhost:' + PORT + '/jarvis/office/ppt/open');
        await new Promise(function (r) { setTimeout(r, 2000); });
        for (var i = 0; i < slides.length; i++) {
          var text = slides[i].title + ' - ' + (slides[i].content || '').slice(0, 100);
          await axios.get('http://localhost:' + PORT + '/jarvis/office/ppt/add-slide?text=' + encodeURIComponent(text));
          await new Promise(function (r) { setTimeout(r, 400); });
        }
      } catch (e) { autoLog('warn', 'PowerPoint acilamadi'); }
      brain.mem.remember('ppt:' + args.topic, args.topic, 0.75);
      return 'PowerPoint tamamlandi: ' + slides.length + ' slayt - konu: ' + args.topic;
    },

    // ── Obsidian (server.js /jarvis/obsidian/* üzerine AI katmanı) ──────────
    obsidian_ai_note: async function (args) {
      if (!args.topic) throw new Error('topic gerekli');
      autoLog('step', 'Obsidian AI notu', { topic: args.topic });
      // Ollama ile not içeriği üret
      var r = await axios.post(OLLAMA + '/api/generate', {
        model: MODEL, stream: false,
        prompt: 'Obsidian markdown notu yaz. Konu: ' + args.topic + ' Baslangic: # ile baslat, bullet listeler kullan, Turkce:'
      });
      var content = r.data.response.trim().slice(0, 2000);
      // server.js /jarvis/obsidian/ai-note köprüsü
      try {
        await axios.post('http://localhost:' + PORT + '/jarvis/obsidian/ai-note', { title: args.topic, content });
        brain.mem.remember('obsidian:' + args.topic, 'not olusturuldu', 0.7);
        return 'Obsidian notu olusturuldu: ' + args.topic;
      } catch (e) {
        autoLog('warn', 'Obsidian endpoint yok, dosyaya kaydediliyor');
        var dir = path.join(process.cwd(), 'obsidian-notes');
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        var filePath = path.join(dir, args.topic.replace(/\s+/g, '-') + '.md');
        fs.writeFileSync(filePath, content, 'utf8');
        return 'Obsidian notu dosyaya kaydedildi: ' + filePath;
      }
    },

    // ── Aktif ekrandaki içeriği Ollama ile analiz et ─────────────────────────
    // server.js /jarvis/screenshot mevcut, burada AI analiz katmanı ekliyoruz
    screen_ai_analyze: async function (args) {
      autoLog('step', 'Ekran AI analizi');
      try {
        var ss = await axios.get('http://localhost:' + PORT + '/jarvis/screenshot');
        var screenText = JSON.stringify(ss.data).slice(0, 3000);
        var instruction = args.instruction || 'Bu ekran icerigini analiz et ve Turkce ozetle';
        var r = await axios.post(OLLAMA + '/api/generate', {
          model: MODEL, stream: false,
          prompt: instruction + ': ' + screenText
        });
        var result = r.data.response.trim().slice(0, 1500);
        brain.mem.remember('screen:analysis:' + Date.now(), result.slice(0, 100), 0.6);
        autoLog('success', 'Ekran analizi tamamlandi');
        return result;
      } catch (e) { return 'Ekran analizi yapilamadi: ' + e.message; }
    },

    // ── Açık uygulamanın içeriğini kopyalayıp Ollama ile işle ────────────────
    // Uygulama ne gösteriyorsa → Cmd+A → Cmd+C → Ollama analiz
    app_content_ai: async function (args) {
      if (!args.appName) throw new Error('appName gerekli');
      autoLog('step', 'Uygulama icerigi AI ile isleniyor', { app: args.appName });
      var instruction = args.instruction || 'Bu icerigi analiz et ve Turkce ozetle';
      return new Promise(function (resolve) {
        var sf = '/tmp/appcontent_' + Date.now() + '.scpt';
        var script = [
          'tell application "' + args.appName + '" to activate',
          'delay 0.8',
          'tell application "System Events"',
          'keystroke "a" using {command down}',
          'delay 0.3',
          'keystroke "c" using {command down}',
          'end tell',
          'delay 0.4',
          'set clipContent to the clipboard',
          'return clipContent'
        ].join('\n');
        fs.writeFileSync(sf, script);
        exec('osascript ' + sf, { timeout: 12000 }, async function (err, stdout) {
          try { fs.unlinkSync(sf); } catch (e) { }
          var appContent = (stdout || '').trim().slice(0, 3000);
          if (!appContent) return resolve('Uygulama icerigi alinamadi');
          try {
            var r = await axios.post(OLLAMA + '/api/generate', {
              model: MODEL, stream: false,
              prompt: instruction + ': ' + appContent
            });
            var result = r.data.response.trim().slice(0, 1500);
            brain.mem.remember('app_content:' + args.appName + ':' + Date.now(), result.slice(0, 100), 0.65);
            resolve(result);
          } catch (e) { resolve('AI isleme hatasi: ' + e.message); }
        });
      });
    },

    // ── Herhangi bir uygulamada Ollama ile görev yap ──────────────────────────
    // "Notion'da yeni sayfa yaz", "Notes'a liste ekle", "Terminal'de komut çalıştır"
    app_ai_task: async function (args) {
      if (!args.appName || !args.task) throw new Error('appName ve task gerekli');
      autoLog('step', 'Uygulama AI gorevi', { app: args.appName, task: args.task.slice(0, 50) });
      // 1. Ollama ile o uygulamaya özgü içerik üret
      var r = await axios.post(OLLAMA + '/api/generate', {
        model: MODEL, stream: false,
        prompt: args.appName + ' uygulamasi icin gorev: ' + args.task + ' Sadece uygulamaya yazilacak metni ver:'
      });
      var aiContent = r.data.response.trim().replace(/['"]/g, '').slice(0, 300);
      // 2. Uygulamayı aç
      await AUTO_TOOLS.open_app({ appName: args.appName });
      await new Promise(function (r) { setTimeout(r, 2000); });
      // 3. Içeriği yaz (server.js /jarvis/control/keyboard/type köprüsü)
      try {
        await axios.get('http://localhost:' + PORT + '/jarvis/control/keyboard/type?text=' + encodeURIComponent(aiContent));
      } catch (e) {
        await AUTO_TOOLS.app_type({ appName: args.appName, text: aiContent });
      }
      brain.mem.remember('app_task:' + args.appName, args.task.slice(0, 60), 0.7);
      return args.appName + ' gorevi tamamlandi: ' + aiContent.slice(0, 80);
    },

    // ── Spotlight ile uygulama/dosya bul ve aç ──────────────────────────────
    // server.js /jarvis/spotlight/open + /jarvis/control/keyboard/type köprüsü
    spotlight_open: async function (args) {
      if (!args.query) throw new Error('query gerekli');
      autoLog('step', 'Spotlight aciliyor', { query: args.query });
      try {
        await axios.get('http://localhost:' + PORT + '/jarvis/spotlight/open');
        await new Promise(function (r) { setTimeout(r, 500); });
        await axios.get('http://localhost:' + PORT + '/jarvis/control/keyboard/type?text=' + encodeURIComponent(args.query));
        await new Promise(function (r) { setTimeout(r, 800); });
        await axios.get('http://localhost:' + PORT + '/jarvis/control/keyboard/key?key=return');
        brain.mem.remember('spotlight:' + args.query, 'acildi', 0.5);
        return 'Spotlight: ' + args.query + ' acildi';
      } catch (e) { return 'Spotlight hatasi: ' + e.message; }
    },

    // ── Terminal: AI ile komut üret ve çalıştır ──────────────────────────────
    // server.js run_terminal zaten var — burada AI önce komutu üretiyor
    terminal_ai: async function (args) {
      if (!args.goal) throw new Error('goal gerekli');
      autoLog('step', 'Terminal AI komutu', { goal: args.goal.slice(0, 60) });
      var r = await axios.post(OLLAMA + '/api/generate', {
        model: MODEL, stream: false,
        prompt: 'Mac terminal komutu yaz. Hedef: ' + args.goal + ' SADECE KOMUT, tek satir, tehlikeli komut yazma (rm -rf, sudo, format yasak):'
      });
      var cmd = r.data.response.trim().replace(/```[\w]*/g, '').replace(/```/g, '').split('\n')[0].trim();
      if (/rm -rf|sudo|format|passwd|mkfs|dd if/i.test(cmd)) return 'Guvenlik: tehlikeli komut reddedildi';
      autoLog('step', 'AI komutu: ' + cmd);
      return new Promise(function (resolve) {
        exec(cmd, { timeout: 15000, cwd: process.cwd() }, async function (err, stdout, stderr) {
          var output = (stdout || stderr || (err ? err.message : 'cikti yok')).slice(0, 800);
          try {
            var r2 = await axios.post(OLLAMA + '/api/generate', {
              model: MODEL, stream: false,
              prompt: 'Terminal ciktisini Turkce 1 cumlede ozetle. Komut: ' + cmd + ' Cikti: ' + output
            });
            var summary = r2.data.response.trim().slice(0, 200);
            brain.mem.remember('terminal:' + cmd.slice(0, 40), summary.slice(0, 80), 0.6);
            resolve('Komut: ' + cmd + ' | Sonuc: ' + summary);
          } catch (e) { resolve('Komut: ' + cmd + ' | Cikti: ' + output.slice(0, 200)); }
        });
      });
    },

    // ── Herhangi bir uygulamayı aç (Mac + Windows destekli) ─────────────────
    // server.js /jarvis/mac/open ve /win/* ile örtüşmemek için
    // Burada: AI ile uygulama adı tahmin et, sonra aç
    smart_open_app: async function (args) {
      if (!args.description) throw new Error('description gerekli. Ornek: "kod editoru", "not alma", "tasarim"');
      autoLog('step', 'Akilli uygulama acma', { desc: args.description });
      // Ollama ile uygun uygulama tahmin et
      var r = await axios.post(OLLAMA + '/api/generate', {
        model: MODEL, stream: false,
        prompt: 'Mac veya Windows uygulamasi adi onerisi. Aciklama: ' + args.description + ' SADECE uygulama adi, baska hicbir sey yazma. Ornek cevaplar: Cursor, VSCode, Figma, Unity, Xcode, Notes, Notion, Slack, Discord'
      });
      var appName = r.data.response.trim().replace(/['".,]/g, '').split('\n')[0].trim().slice(0, 40);
      autoLog('step', 'AI uygulama tahmini: ' + appName);
      // Mac ise open -a, Windows ise start komutu dene
      return new Promise(function (resolve, reject) {
        var macCmd = 'open -a "' + appName + '"';
        exec(macCmd, { timeout: 10000 }, function (err) {
          if (!err) {
            brain.mem.remember('smart_app:' + args.description, appName, 0.8);
            setTimeout(resolve, 2000, appName + ' acildi');
          } else {
            // Windows fallback
            exec('start "" "' + appName + '"', { timeout: 10000 }, function (err2) {
              if (err2) return reject(new Error(appName + ' acilamadi'));
              setTimeout(resolve, 2000, appName + ' acildi (win)');
            });
          }
        });
      });
    },

  };

  var TOOL_LIST = Object.keys(AUTO_TOOLS).join(', ');

  function buildContext() {
    var recentGoals = (MEMORY.goals || []).slice(-5).map(function (g) { return g.goal || ''; }).filter(Boolean).join(' | ');
    var recentFacts = (MEMORY.facts || []).slice(-3).map(function (f) { return f.insight || f.idea || ''; }).filter(Boolean).join('. ');
    var unreliable = Object.entries(LEARN.toolStats)
      .filter(function (e) { return e[1].fail > e[1].ok && (e[1].ok + e[1].fail) >= 3; })
      .map(function (e) { return e[0]; });
    var recentCode = (LEARN.codeFiles || []).slice(-3).map(function (f) { return f.file; });
    var untestedCode = recentCode.filter(function (f) {
      var tested = (LEARN.testedFiles || []).some(function (t) { return t.file === f; });
      return !tested && fs.existsSync(f);
    });
    var _profile = (function () {
      try {
        var p = path.join(process.cwd(), 'data', 'user-profile.json');
        if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
      } catch (e) { }
      return {};
    })();
    var userName = _profile.name || '';
    var userInterests = (_profile.interests || []).join(', ');
    var userCity = _profile.city || '';
    var userFacts = (_profile.learnedFacts || []).slice(-5).map(function (f) { return f.text || ''; }).filter(Boolean).join('. ');

    // ── YENİ: 4 modülden bağlam çek ──────────────────────────────
    var episodicCtx = '', uuCtx = '', inferenceCtx = '', predictionCtx = '';
    try {
      var epMod = require('./brain/episodic');
      var epStats = epMod.getStats();
      if (epStats.topTopics && epStats.topTopics.length > 0) {
        episodicCtx = 'En çok konuşulan konular: ' + epStats.topTopics.slice(0, 3).map(function (t) { return t.topic + '(' + t.count + 'x)'; }).join(', ');
      }
    } catch (e) { }
    try {
      var uuMod = require('./brain/userUnderstanding');
      var uuSum = uuMod.getSummary();
      if (uuSum.knowledgeGaps && uuSum.knowledgeGaps.length > 0)
        uuCtx = 'Kullanıcının bilgi boşlukları: ' + uuSum.knowledgeGaps.slice(0, 3).join(', ');
      if (uuSum.strengths && uuSum.strengths.length > 0)
        uuCtx += ' | Güçlü konular: ' + uuSum.strengths.slice(0, 3).join(', ');
    } catch (e) { }
    try {
      var infMod = require('./brain/inference');
      var infStats = infMod.getStats();
      if (infStats.mostRepeated && infStats.mostRepeated.length > 0)
        inferenceCtx = 'Tekrar eden konular: ' + infStats.mostRepeated.slice(0, 3).map(function (r) { return r.keyword + '(' + r.count + 'x)'; }).join(', ');
    } catch (e) { }
    try {
      var prMod = require('./brain/prediction');
      var prAcc = prMod.getAccuracy();
      if (prAcc.total > 5)
        predictionCtx = 'Tahmin doğruluğu: %' + Math.round(prAcc.rate * 100) + ' (' + prAcc.total + ' ölçüm)';
      var hardest = prMod.getStats ? prMod.getStats().hardestTopics : [];
      if (hardest && hardest.length > 0)
        predictionCtx += ' | Zor konular: ' + hardest.slice(0, 2).map(function (h) { return h.topic; }).join(', ');
    } catch (e) { }

    return {
      recentGoals, recentFacts, unreliable, untestedCode,
      confidence: WORLD_STATE.confidence, cycleCount: AUTO.cycleCount,
      userName, userInterests, userCity, userFacts,
      episodicCtx, uuCtx, inferenceCtx, predictionCtx
    };
  }

  // ── Hedef üretici ──────────────────────────────────────────────
  async function generateGoal(ctx) {

    // ── Web AI Rotasyonu ────────────────────────────────────────────
    // Her 7 döngüde bir ChatGPT / Gemini / Claude.ai sırayla devreye girer.
    // Agent tamamen kendi başına hedef üretir ve çalıştırır.
    // Kullanıcı profili varsa ona özel görev, yoksa genel yazılım görevi.
    var WEB_AI_EVERY_N_CYCLES = 7;
    if (AUTO.cycleCount > 0 && AUTO.cycleCount % WEB_AI_EVERY_N_CYCLES === 0) {
      var webAiServices = ['chatgpt', 'gemini', 'claudeai'];
      var serviceIdx = AUTO.webAiCycle % webAiServices.length;
      var service = webAiServices[serviceIdx];
      AUTO.webAiCycle++;

      // Görev konusu: kullanıcı ilgi alanlarından veya döngü bazlı genel konular
      var webAiTopics = [
        'Python ile veri analizi aracı',
        'Node.js REST API',
        'React dashboard bileşeni',
        'CLI araç JavaScript',
        'Python web scraper',
        'Express.js kullanıcı yönetimi',
        'TypeScript utility kütüphanesi',
        'Bash otomasyon scripti',
        'Python dosya organizasyon aracı',
        'Node.js cron job scheduler'
      ];

      var topicIdx = AUTO.cycleCount % webAiTopics.length;
      var task = webAiTopics[topicIdx];

      // Kullanıcı profili varsa göreve kişiselleştir
      if (ctx.userInterests) {
        var interests = ctx.userInterests.split(',').map(function (s) { return s.trim(); });
        var interest = interests[AUTO.cycleCount % interests.length];
        task = interest + ' alanı için ' + task.toLowerCase();
      }

      var projectName = service + '_auto_' + AUTO.cycleCount;
      var toolName = service + '_project';

      autoLog('think', '[Web AI Rotasyon] ' + service.toUpperCase() + ' seçildi → ' + task);

      return {
        goal: task + ' — ' + service + ' ile oluştur',
        reason: 'Web AI rotasyon döngüsü #' + AUTO.webAiCycle + ' (' + service + ')',
        expectedTool: toolName,
        // Doğrudan plan — generatePlan atlanır, bu araç direkt çalışır
        _directPlan: [{ tool: toolName, args: { projectName: projectName, task: task } }]
      };
    }
    // ── Web AI Rotasyonu sonu ────────────────────────────────────────
    var avoidTools = ctx.unreliable.length ? '\nKACINILAN ARACLAR: ' + ctx.unreliable.join(', ') : '';
    var avoidGoals = LEARN.avoidGoals.length ? '\nBASARISIZ ORUNTULAR: ' + LEARN.avoidGoals.slice(-5).join(', ') : '';
    var hints = LEARN.successInsights.length ? '\nBASARILI DERSLER: ' + LEARN.successInsights.slice(-3).join('. ') : '';
    // Test edilmemiş kod varsa önce onu test et
    var untestedHint = ctx.untestedCode.length
      ? '\nTEST EDILMEMİŞ KODLAR (bunları test et veya analiz et): ' + ctx.untestedCode.join(', ')
      : '';

    var userCtx = '';
    if (ctx.userName) userCtx += 'Kullanici adi: ' + ctx.userName + '\n';
    if (ctx.userInterests) userCtx += 'Ilgi alanlari: ' + ctx.userInterests + '\n';
    if (ctx.userCity) userCtx += 'Sehir: ' + ctx.userCity + '\n';
    if (ctx.userFacts) userCtx += 'Hakkinda bilinenler: ' + ctx.userFacts + '\n';

    var prompt = 'Sen KaanAI otonom asistanisin. Hicbir kullanici komutu yok.\n' +
      (userCtx ? userCtx : '') +
      'Son isler: ' + (ctx.recentGoals || 'yok') + '\n' +
      'Dersler: ' + (ctx.recentFacts || 'yok') + '\n' +
      'Dongu: ' + ctx.cycleCount + '\n' +
      avoidTools + avoidGoals + hints + untestedHint + '\n' +
      // ── YENİ: 4 modül bağlamı ──────────────────────────────────
      (ctx.episodicCtx ? '\nEPİSODİK: ' + ctx.episodicCtx : '') +
      (ctx.uuCtx ? '\nKULLANICI: ' + ctx.uuCtx : '') +
      (ctx.inferenceCtx ? '\nÇIKARIM: ' + ctx.inferenceCtx : '') +
      (ctx.predictionCtx ? '\nTAHMİN: ' + ctx.predictionCtx : '') +
      '\n\nARACLAR: ' + TOOL_LIST + '\n\n' +
      'KURAL: Kucuk somut hedef. Kategoriler:\n' +
      '- Kod yaz+test et (write_and_test)\n' +
      '- Mevcut kodu analiz et (analyze_code_file)\n' +
      '- Arastir+ozet (search_web+summarize)\n' +
      '- Proje olustur+test (create_node_project)\n' +
      '- Cursor ile proje olustur (cursor_project) — buyuk/kapsamli projeler icin\n' +
      '- Antigravity ile proje olustur (antigravity_project) — Google AI IDE, Gemini destekli\n' +
      '- ChatGPT web ile proje olustur (chatgpt_project) — tarayici uzerinden, API gerektirmez\n' +
      '- Gemini web ile proje olustur (gemini_project) — tarayici uzerinden, API gerektirmez\n' +
      '- Claude.ai web ile proje olustur (claudeai_project) — tarayici uzerinden, API gerektirmez\n' +
      '- VSCode ac ve AI gorev yap (open_vscode, vscode_ai_task)\n' +
      '- Unity C# scripti yaz (unity_create_script)\n' +
      '- Xcode Swift dosyasi yaz (xcode_write_swift)\n' +
      '- Word belgesi AI ile yaz (word_ai_write)\n' +
      '- Excel tablo AI ile doldur (excel_ai_fill)\n' +
      '- PowerPoint AI ile olustur (ppt_ai_create)\n' +
      '- Obsidian notu AI ile yaz (obsidian_ai_note)\n' +
      '- Ekrani analiz et (screen_ai_analyze)\n' +
      '- Acik uygulamanin icerigini isle (app_content_ai)\n' +
      '- Herhangi uygulamada AI gorevi (app_ai_task)\n' +
      '- Terminal AI komutu (terminal_ai)\n' +
      'YASAK: silme, tehlikeli, yasa disi, daha once yapilan, tekrar eden hedefler.\n' +
      'ZORUNLU: Her dongu farkli bir hedef olmali. Ayni hedefi tekrarlama!\n' +
      'SADECE JSON: {"goal":"...","reason":"...","expectedTool":"..."}';
    var r = await axios.post(OLLAMA + '/api/generate', { model: MODEL, stream: false, prompt, options: { temperature: 0.05, num_predict: 600 } });
    try {
      var match = r.data.response.match(/\{[\s\S]*\}/);
      if (!match) throw new Error('json yok');
      return JSON.parse(match[0]);
    } catch (e) {
      // Test edilmemiş kod varsa onu test et
      if (ctx.untestedCode.length) {
        return {
          goal: ctx.untestedCode[0] + ' dosyasini analiz et ve test et',
          reason: 'test edilmemis kod var', expectedTool: 'analyze_code_file'
        };
      }
      if (ctx.userName && ctx.userInterests) {
        var interests = ctx.userInterests.split(',').map(function (s) { return s.trim(); });
        var interest = interests[AUTO.cycleCount % interests.length];
        var templates = [
          interest + ' ile ilgili son haberleri ara ve ozet cikar',
          ctx.userName + ' icin ' + interest + ' konusunda Node.js scripti yaz ve test et',
          interest + ' alaninda GitHub trending projelerini ara',
          ctx.userName + ' icin ' + interest + ' ile ilgili yeni proje olustur',
          ctx.userCity + ' teknoloji haberlerini ara ve ozet cikar'
        ];
        return {
          goal: templates[AUTO.cycleCount % templates.length],
          reason: ctx.userName + ' profili - ' + interest,
          expectedTool: 'write_and_test'
        };
      }
      return {
        goal: 'yazilim trendlerini ara ve ozet cikar',
        reason: 'varsayilan', expectedTool: 'search_web'
      };
    }
  }

  // ── Plan üretici ───────────────────────────────────────────────
  async function generatePlan(goal, ctx) {
    var prompt =
      'Asagidaki JSON ARRAY formatinda plan uret. SADECE JSON yaz, baska hicbir sey yazma.\n' +
      'Hedef: ' + goal + '\n\n' +
      'KULLANILABILIR ARAC ISIMLERI (sadece bunlari kullan):\n' +
      '- search_web\n' +
      '- browse_web\n' +
      '- read_url\n' +
      '- write_file\n' +
      '- read_file\n' +
      '- write_code\n' +
      '- write_and_test\n' +
      '- analyze_code_file\n' +
      '- run_and_test\n' +
      '- create_web_project\n' +
      '- create_node_project\n' +
      '- run_terminal\n' +
      '- remember_fact\n' +
      '- summarize\n' +
      '- analyze_text\n' +
      '- recall_memory\n' +
      '- open_app\n' +
      '- open_in_cursor\n' +
      '- cursor_compose\n' +
      '- cursor_project\n' +
      '- open_in_antigravity\n' +
      '- antigravity_compose\n' +
      '- antigravity_project\n' +
      '- collect_cursor_output\n' +
      '- chatgpt_ask\n' +
      '- chatgpt_project\n' +
      '- gemini_ask\n' +
      '- gemini_project\n' +
      '- claudeai_ask\n' +
      '- claudeai_project\n' +
      '- app_hotkey\n' +
      '- open_vscode\n' +
      '- vscode_ai_task\n' +
      '- open_unity\n' +
      '- unity_create_script\n' +
      '- open_xcode\n' +
      '- xcode_write_swift\n' +
      '- open_figma\n' +
      '- figma_ai_spec\n' +
      '- word_ai_write\n' +
      '- excel_ai_fill\n' +
      '- ppt_ai_create\n' +
      '- obsidian_ai_note\n' +
      '- screen_ai_analyze\n' +
      '- app_content_ai\n' +
      '- app_ai_task\n' +
      '- terminal_ai\n' +
      '- spotlight_open\n' +
      '- smart_open_app\n\n' +
      'ORNEKLER:\n' +
      '[{"tool":"write_and_test","args":{"language":"javascript","task":"hesap makinesi","filePath":"./calc.js"}}]\n' +
      '[{"tool":"write_code","args":{"language":"javascript","task":"todo list","filePath":"./todo.js"}}]\n' +
      '[{"tool":"search_web","args":{"query":"nodejs best practices"}},{"tool":"summarize","args":{"text":"RESULT"}}]\n' +
      '[{"tool":"create_node_project","args":{"projectName":"myapp","description":"express api"}},{"tool":"run_and_test","args":{"filePath":"./myapp/index.js"}}]\n' +
      '[{"tool":"analyze_code_file","args":{"filePath":"./server.js"}}]\n' +
      '[{"tool":"cursor_project","args":{"projectName":"myproject","task":"express api yaz kullanici girisi olsun"}}]\n' +
      '[{"tool":"antigravity_project","args":{"projectName":"myapp","task":"React dashboard yaz grafik ve tablo olsun"}}]\n' +
      '[{"tool":"chatgpt_project","args":{"projectName":"myapp","task":"Python ile REST API yaz"}}]\n' +
      '[{"tool":"gemini_project","args":{"projectName":"myapp2","task":"React ile dashboard yaz"}}]\n' +
      '[{"tool":"claudeai_project","args":{"projectName":"myapp3","task":"Node.js ile API yaz"}}]\n' +
      '[{"tool":"word_ai_write","args":{"topic":"yapay zeka trendleri 2025"}}]\n' +
      '[{"tool":"unity_create_script","args":{"scriptName":"PlayerController","task":"oyuncu hareketi ve ziplama"}}]\n' +
      '[{"tool":"app_content_ai","args":{"appName":"Notes","instruction":"bu notlari ozetle"}}]\n' +
      '[{"tool":"ppt_ai_create","args":{"topic":"startup sunum"}}]\n' +
      '[{"tool":"terminal_ai","args":{"goal":"disk kullanimi goster"}}]\n\n' +
      'KURAL: Maksimum 4 adim. tool degeri mutlaka yukaridaki listeden olmali.\n' +
      'SADECE JSON ARRAY:';

    var r = await axios.post(OLLAMA + '/api/generate', {
      model: MODEL, stream: false, prompt,
      options: { temperature: 0.05, num_predict: 600 }
    });
    var raw = r.data.response || '';
    autoLog('info', 'Plan LLM cevabi', { preview: raw.slice(0, 150) });

    try {
      var cleaned = raw.replace(/```json\n?/gi, '').replace(/```\n?/g, '').trim();
      var s = cleaned.indexOf('['), e = cleaned.lastIndexOf(']');
      if (s === -1 || e === -1) throw new Error('array yok');
      var parsed = JSON.parse(cleaned.slice(s, e + 1));

      return parsed.filter(function (step) {
        if (!step.tool || !AUTO_TOOLS[step.tool]) return false;
        var a = JSON.stringify(step.args || '').toLowerCase();
        if (/rm -rf|rmdir|format c:|mkfs/i.test(a)) return false;
        if (/passwd|sudo |chmod 777/i.test(a)) return false;
        if (!_reliable(step.tool)) {
          var alts = _alternatives(step.tool);
          if (alts.length) { autoLog('learn', '"' + step.tool + '" -> "' + alts[0] + '"'); step.tool = alts[0]; }
          else return false;
        }
        return true;
      });
    } catch (e) {
      autoLog('warn', 'Plan parse HATA: ' + e.message + ' | raw: ' + raw.slice(0, 100));
      // ── YENİ: Parse hatası Brain'e hata olarak bildirilmesin ──
      // Varsayılan güvenli plan döndür, sessizce devam et
      if (goal && goal.length >= 5) {
        return [{ tool: 'search_web', args: { query: goal.slice(0, 80) } }];
      }
      return []; // Boş plan → döngü 'warn' ile devam eder, hata saymaz
    }
  }

  // ── Plan yürütücü (self-heal dahil) ────────────────────────────
  async function executePlan(goal, plan) {
    var results = [];
    autoLog('info', 'Plan yurutuluyor (' + plan.length + ' adim)', { goal: goal.slice(0, 60) });

    for (var i = 0; i < plan.length; i++) {
      var step = plan[i];
      AUTO.currentStep = step.tool + ' (' + (i + 1) + '/' + plan.length + ')';
      autoLog('step', 'Adim ' + (i + 1) + ': ' + step.tool, step.args);
      _broadcast({ type: 'auto_step', step: i + 1, total: plan.length, tool: step.tool, goal });

      try {
        var result = await AUTO_TOOLS[step.tool](step.args || {});
        results.push({ step, result, status: 'ok' });
        _recordTool(step.tool, true);
        brain.mem.recordSuccess(step.tool, JSON.stringify(step.args), String(result || '').slice(0, 100));
        if (typeof brain.emo.onSuccess === 'function') brain.emo.onSuccess();
        WORLD_STATE.confidence = Math.min(1, WORLD_STATE.confidence + 0.02);
        autoLog('success', 'Adim ' + (i + 1) + ' OK', { result: String(result || '').slice(0, 80) });
        if (typeof result === 'string' && result.length > 10)
          brain.mem.remember('step_out:' + Date.now(), result.slice(0, 200), 0.45);

      } catch (err) {
        autoLog('error', 'Adim ' + (i + 1) + ' basarisiz: ' + err.message, { tool: step.tool });
        _recordTool(step.tool, false, err.message);
        brain.onError(step.tool, JSON.stringify(step.args), err.message);
        WORLD_STATE.confidence = Math.max(0.1, WORLD_STATE.confidence - 0.05);
        results.push({ step, result: null, status: 'error', error: err.message });

        // Self-heal: önce bilinen alternatifleri dene
        var alts = _alternatives(step.tool);
        var healed = false;
        for (var j = 0; j < alts.length; j++) {
          try {
            autoLog('learn', 'Self-heal: "' + step.tool + '" -> "' + alts[j] + '"');
            var fixResult = await AUTO_TOOLS[alts[j]](step.args || {});
            results.push({ step: Object.assign({}, step, { tool: alts[j] }), result: fixResult, status: 'healed' });
            _recordTool(alts[j], true);
            autoLog('success', 'Self-heal OK: ' + alts[j]);
            healed = true; break;
          } catch (e2) { _recordTool(alts[j], false, e2.message); }
        }
        // Son çare: LLM'e sor
        if (!healed) {
          try {
            var fixR = await axios.post(OLLAMA + '/api/generate', {
              model: MODEL, stream: false,
              prompt: 'Arac "' + step.tool + '" basarisiz: "' + err.message + '"\nHedef: ' + goal + '\nSADECE JSON: {"tool":"...","args":{...}}\nKullanilabilir: ' + TOOL_LIST
            });
            var fm = fixR.data.response.match(/\{[\s\S]*\}/);
            if (fm) {
              var fix = JSON.parse(fm[0]);
              if (fix.tool && AUTO_TOOLS[fix.tool] && _reliable(fix.tool)) {
                var fr = await AUTO_TOOLS[fix.tool](fix.args || {});
                results.push({ step: fix, result: fr, status: 'llm_healed' });
                _recordTool(fix.tool, true);
                autoLog('learn', 'LLM self-heal OK: ' + fix.tool);
              }
            }
          } catch (e3) { }
        }
      }
    }
    return results;
  }

  // ── Yansıtıcı (gerçek öğrenme) ─────────────────────────────────
  async function reflect(goal, results) {
    var okCount = results.filter(function (r) { return ['ok', 'healed', 'llm_healed'].includes(r.status); }).length;
    var success = okCount > 0;
    var summary = results.map(function (r) {
      return r.step.tool + ': ' + (r.status === 'ok' ? String(r.result || '').slice(0, 80) : 'HATA: ' + (r.error || ''));
    }).join('\n');

    try {
      var r = await axios.post(OLLAMA + '/api/generate', {
        model: MODEL, stream: false,
        prompt: 'Gorev: "' + goal + '"\nSonuc: ' + (success ? 'BASARILI' : 'BASARISIZ') + '\nAdimlar:\n' + summary + '\n\nBu gorevden ne ogrenildi? SADECE 1 cumle Turkce:'
      });
      var insight = r.data.response.trim().slice(0, 200);
      brain.mem.remember('insight:' + Date.now(), insight, 0.7);
      MEMORY.facts = MEMORY.facts || [];
      MEMORY.facts.push({ goal, insight, success, ts: Date.now() });
      saveMem();
      if (success) {
        LEARN.successInsights.push(insight);
        if (LEARN.successInsights.length > 20) LEARN.successInsights.shift();
      } else {
        LEARN.failInsights.push(insight);
        if (LEARN.failInsights.length > 20) LEARN.failInsights.shift();
        var pattern = goal.split(' ').slice(0, 3).join(' ').toLowerCase();
        if (!LEARN.avoidGoals.includes(pattern)) {
          LEARN.avoidGoals.push(pattern);
          if (LEARN.avoidGoals.length > 30) LEARN.avoidGoals.shift();
        }
      }
      LEARN.totalCycles++;
      _saveLearn();
      autoLog('learn', 'Yansima [' + (success ? 'basarili' : 'basarisiz') + ']: ' + insight);
    } catch (e) { }
  }

  // ── Ana otonom döngü ───────────────────────────────────────────
  async function autonomousLoop() {
    autoLog('info', 'Otonom dongu basladi');
    while (AUTO.running) {
      if (AUTO.paused) { await _sleep(3000); continue; }
      if (AGENT_STATE.busy) { autoLog('info', 'Baska agent aktif, bekleniyor...'); await _sleep(8000); continue; }
      if (WORLD_STATE.confidence < 0.2) {
        autoLog('warn', 'Guven dusuk, 5 dk bekleniyor...');
        await _sleep(5 * 60 * 1000); WORLD_STATE.confidence = 0.5; continue;
      }
      var elapsed = Date.now() - AUTO.lastGoalAt;
      if (elapsed < AUTO.cooldownMs) { await _sleep(AUTO.cooldownMs - elapsed); continue; }

      AUTO.cycleCount++;
      autoLog('think', '=== Dongu #' + AUTO.cycleCount + ' ===');

      try {
        AGENT_STATE.busy = true;
        var ctx = buildContext();

        autoLog('think', 'Hedef uretiliyor...');
        var goalObj = await generateGoal(ctx);
        var goal = goalObj.goal;

        if (!goal || goal.length < 5) { autoLog('warn', 'Hedef uretilemedi'); continue; }
        if (/hack|illegal|phishing|steal|rm -rf|format c/i.test(goal)) { autoLog('warn', 'Tehlikeli hedef reddedildi'); continue; }

        AUTO.currentGoal = goal;
        WORLD_STATE.goal = goal;
        AUTO.lastGoalAt = Date.now();
        autoLog('goal', goal, { reason: goalObj.reason, expectedTool: goalObj.expectedTool });
        brain.attention.addTask('AutoAgent: ' + goal.slice(0, 40), async function () { }, 5, 'autonomous');

        // _directPlan varsa generatePlan atla — web AI rotasyonu direkt çalışır
        var plan;
        if (goalObj._directPlan) {
          plan = goalObj._directPlan;
          autoLog('info', '[Web AI] Direkt plan: ' + plan.map(function (s) { return s.tool; }).join(' -> '));
        } else {
          autoLog('think', 'Plan uretiliyor...');
          plan = await generatePlan(goal, ctx);
          if (!plan.length) { autoLog('warn', 'Plan uretilemedi'); continue; }
          autoLog('info', 'Plan: ' + plan.map(function (s) { return s.tool; }).join(' -> '));
        }

        var results = await executePlan(goal, plan);

        var okCount = results.filter(function (r) { return ['ok', 'healed', 'llm_healed'].includes(r.status); }).length;
        var status = okCount > 0 ? 'success' : 'fail';
        MEMORY.goals = MEMORY.goals || [];
        MEMORY.goals.push({ goal, reason: goalObj.reason, tools: plan.map(function (s) { return s.tool; }), status, ts: Date.now() });
        saveMem();
        brain.onAgentDone(goal, plan.map(function (s) { return { tool: s.tool, result: '' }; }), status);

        await reflect(goal, results);
        _broadcast({ type: 'auto_done', goal, status, cycle: AUTO.cycleCount });
        autoLog('success', 'Dongu #' + AUTO.cycleCount + ' bitti [' + status + ']');
        if (AUTO.cycleCount % 5 === 0) _logLearnSummary();

      } catch (e) {
        autoLog('error', 'Dongu hatasi: ' + e.message);
        WORLD_STATE.confidence = Math.max(0.1, WORLD_STATE.confidence - 0.1);
        brain.onError('autonomous_loop', AUTO.currentGoal || '', e.message);
        await _sleep(20000);
      } finally {
        AGENT_STATE.busy = false;
        AUTO.currentGoal = null;
        AUTO.currentStep = null;
      }
    }
    autoLog('info', 'Otonom dongu durdu.');
  }

  // ── API Endpointleri ───────────────────────────────────────────
  app.post('/auto/start', function (req, res) {
    if (AUTO.running) return res.json({ status: 'already_running', cycle: AUTO.cycleCount });
    AUTO.running = true; AUTO.paused = false;
    autonomousLoop().catch(function (e) {
      autoLog('error', 'Loop coktu, 30sn sonra yeniden: ' + e.message);
      AUTO.running = false;
      setTimeout(function () { if (!AUTO.running) { AUTO.running = true; autonomousLoop().catch(function () { AUTO.running = false; }); } }, 30000);
    });
    res.json({ status: 'started', message: 'Otonom dongu basladi. Kod yazar, test eder, arastirır, ogrenip gelisir.' });
  });

  app.post('/auto/stop', function (req, res) {
    AUTO.running = false; AUTO.paused = false; AGENT_STATE.busy = false;
    res.json({ status: 'stopped' });
  });

  app.post('/auto/pause', function (req, res) {
    AUTO.paused = !AUTO.paused;
    res.json({ status: AUTO.paused ? 'paused' : 'resumed' });
  });

  app.get('/auto/status', function (req, res) {
    res.json({
      status: 'success', running: AUTO.running, paused: AUTO.paused,
      currentGoal: AUTO.currentGoal, currentStep: AUTO.currentStep,
      cycleCount: AUTO.cycleCount, confidence: WORLD_STATE.confidence,
      agentBusy: AGENT_STATE.busy, cooldownMs: AUTO.cooldownMs,
      brainEmotions: brain.emo.getState(),
      learning: {
        totalCycles: LEARN.totalCycles, successInsights: LEARN.successInsights.slice(-3),
        avoidGoals: LEARN.avoidGoals.slice(-5), toolStats: LEARN.toolStats,
        codeFiles: (LEARN.codeFiles || []).slice(-5), testedFiles: (LEARN.testedFiles || []).slice(-5)
      },
      recentLog: AUTO.log.slice(0, 15)
    });
  });

  app.get('/auto/log', function (req, res) {
    res.json({ status: 'success', count: AUTO.log.length, log: AUTO.log.slice(0, 100) });
  });

  app.delete('/auto/log', function (req, res) { AUTO.log = []; res.json({ status: 'success' }); });

  app.post('/auto/config', function (req, res) {
    if (typeof req.body.cooldownMs === 'number') AUTO.cooldownMs = Math.max(10000, req.body.cooldownMs);
    if (typeof req.body.paused === 'boolean') AUTO.paused = req.body.paused;
    res.json({ status: 'success', cooldownMs: AUTO.cooldownMs, paused: AUTO.paused });
  });

  app.post('/auto/inject-goal', async function (req, res) {
    var goal = req.body.goal;
    var tool = req.body.tool;
    var args = req.body.args;
    if (!goal) return res.json({ status: 'error', message: 'goal gerekli' });

    if (goal.trim().length < 5) return res.json({ status: 'skipped', message: 'Hedef çok kısa' });
    if (/^https?:\/\//i.test(goal.trim())) return res.json({ status: 'skipped', message: 'Ham URL hedef olamaz' });
    if (/^curl |^git |^\$\s/i.test(goal.trim())) return res.json({ status: 'skipped', message: 'Terminal çıktısı hedef olamaz' });
    if (/Invalid URL|ECONNREFUSED|Cannot (GET|POST)/i.test(goal)) return res.json({ status: 'skipped', message: 'Hata mesajı hedef olamaz' });
    if (/localhost:\d+/i.test(goal)) return res.json({ status: 'skipped', message: 'Localhost URL içeren hedef atlandı' });
    if (/ana sayfa|adres.*yaz|sayfa.*git/i.test(goal)) return res.json({ status: 'skipped', message: 'Browser navigasyon hedefi atlandı' });

    if (AGENT_STATE.busy) return res.json({ status: 'busy', message: 'Agent mesgul' });
    AGENT_STATE.busy = true;
    res.json({ status: 'started', goal, tool: tool || null });
    try {
      autoLog('goal', 'Manuel hedef: ' + goal);
      var ctx = buildContext();

      // tool belirtildiyse direkt çalıştır — Ollama plan üretmeye çalışmaz
      var plan;
      if (tool && AUTO_TOOLS[tool]) {
        plan = [{ tool: tool, args: args || {} }];
        autoLog('info', '[inject-goal] Direkt araç: ' + tool);
      } else {
        plan = await generatePlan(goal, ctx);
      }

      var results = await executePlan(goal, plan);
      await reflect(goal, results);
      MEMORY.goals = MEMORY.goals || [];
      MEMORY.goals.push({ goal, injected: true, ts: Date.now() });
      saveMem();
      brain.onAgentDone(goal, plan.map(function (s) { return s.tool; }), 'success');
    } catch (e) {
      autoLog('error', 'Manuel hedef hatasi: ' + e.message);
      brain.onError('inject_goal', goal, e.message);
    } finally { AGENT_STATE.busy = false; }
  });

  app.get('/auto/tools', function (req, res) {
    res.json({
      status: 'success', tools: Object.keys(AUTO_TOOLS).map(function (name) {
        return { name, stats: LEARN.toolStats[name] || { ok: 0, fail: 0 }, reliable: _reliable(name) };
      })
    });
  });

  app.post('/auto/run-tool', async function (req, res) {
    var tool = req.body.tool, args = req.body.args;
    if (!tool || !AUTO_TOOLS[tool]) return res.json({ status: 'error', message: 'arac bulunamadi: ' + tool });
    try { res.json({ status: 'success', tool, result: await AUTO_TOOLS[tool](args || {}) }); }
    catch (e) { res.json({ status: 'error', tool, message: e.message }); }
  });

  // ── Antigravity endpoint'leri ─────────────────────────────────

  app.post('/auto/antigravity/project', async function (req, res) {
    var projectName = req.body.projectName;
    var task = req.body.task;
    var details = req.body.details;
    var waitMs = req.body.waitMs;
    if (!projectName || !task) return res.json({ status: 'error', message: 'projectName ve task gerekli' });
    if (AGENT_STATE.busy) return res.json({ status: 'busy', message: 'Agent mesgul, bekle' });
    AGENT_STATE.busy = true;
    res.json({ status: 'started', projectName: projectName, task: task, message: 'Antigravity aciliyor, Ollama plan hazirliyor...' });
    try {
      autoLog('goal', 'Antigravity projesi: ' + task);
      var result = await AUTO_TOOLS.antigravity_project({ projectName: projectName, task: task, details: details, waitMs: waitMs });
      brain.mem.remember('antigravity:done:' + projectName, task.slice(0, 80), 0.9);
      MEMORY.goals = MEMORY.goals || [];
      MEMORY.goals.push({ goal: 'antigravity:' + task, projectName: projectName, ts: Date.now() });
      saveMem();
      brain.onAgentDone('antigravity_project:' + projectName, [], 'success');
      autoLog('success', 'Antigravity projesi tamamlandi');
    } catch (e) {
      autoLog('error', 'Antigravity hatasi: ' + e.message);
      brain.onError('antigravity_project', task, e.message);
    } finally { AGENT_STATE.busy = false; }
  });

  app.get('/auto/antigravity/projects', function (req, res) {
    var projectsDir = path.join(process.cwd(), 'projects');
    if (!fs.existsSync(projectsDir)) return res.json({ status: 'success', projects: [] });
    var projects = fs.readdirSync(projectsDir, { withFileTypes: true })
      .filter(function (f) { return f.isDirectory(); })
      .map(function (f) {
        var p = path.join(projectsDir, f.name);
        var files = [];
        try { files = fs.readdirSync(p).filter(function (x) { return !x.startsWith('.') && x !== 'node_modules'; }); } catch (e) { }
        return { name: f.name, path: p, fileCount: files.length, files: files.slice(0, 10) };
      });
    res.json({ status: 'success', count: projects.length, projects: projects });
  });

  app.get('/auto/learning', function (req, res) { res.json({ status: 'success', learning: LEARN }); });

  // ── Cursor endpoint'leri ────────────────────────────────────────

  // Cursor ile proje oluştur — sen söyle, agent yapar
  app.post('/auto/cursor/project', async function (req, res) {
    var { projectName, task, details, waitMs } = req.body;
    if (!projectName || !task) return res.json({ status: 'error', message: 'projectName ve task gerekli' });
    if (AGENT_STATE.busy) return res.json({ status: 'busy', message: 'Agent meşgul, bekle' });

    AGENT_STATE.busy = true;
    res.json({ status: 'started', projectName, task, message: 'Cursor açılıyor, proje oluşturuluyor...' });

    try {
      autoLog('goal', 'Cursor projesi: ' + task);
      var result = await AUTO_TOOLS.cursor_project({ projectName, task, details, waitMs });
      var projectPath = path.join(process.cwd(), 'projects', projectName);
      brain.mem.remember('cursor:done:' + projectName, task.slice(0, 80), 0.9);
      MEMORY.goals = MEMORY.goals || [];
      MEMORY.goals.push({ goal: 'cursor:' + task, projectName, projectPath, ts: Date.now() });
      saveMem();
      autoLog('success', 'Cursor projesi tamamlandı: ' + result.slice(0, 100));
    } catch (e) {
      autoLog('error', 'Cursor projesi hatası: ' + e.message);
      brain.onError('cursor_project', task, e.message);
    } finally {
      AGENT_STATE.busy = false;
    }
  });

  // Cursor projelerini listele
  app.get('/auto/cursor/projects', function (req, res) {
    var projectsDir = path.join(process.cwd(), 'projects');
    if (!fs.existsSync(projectsDir)) return res.json({ status: 'success', projects: [] });
    var projects = fs.readdirSync(projectsDir, { withFileTypes: true })
      .filter(function (f) { return f.isDirectory(); })
      .map(function (f) {
        var p = path.join(projectsDir, f.name);
        var files = [];
        try {
          files = fs.readdirSync(p)
            .filter(function (x) { return !x.startsWith('.') && x !== 'node_modules'; });
        } catch (e) { }
        return { name: f.name, path: p, fileCount: files.length, files: files.slice(0, 10) };
      });
    res.json({ status: 'success', count: projects.length, projects });
  });

  // Cursor projesindeki dosyayı oku
  app.get('/auto/cursor/read', function (req, res) {
    var { projectName, fileName } = req.query;
    if (!projectName) return res.json({ status: 'error', message: 'projectName gerekli' });
    var projectPath = path.join(process.cwd(), 'projects', projectName);
    if (!fs.existsSync(projectPath)) return res.json({ status: 'error', message: 'proje bulunamadı' });
    if (fileName) {
      var filePath = path.join(projectPath, fileName);
      if (!fs.existsSync(filePath)) return res.json({ status: 'error', message: 'dosya bulunamadı' });
      return res.json({ status: 'success', file: fileName, content: fs.readFileSync(filePath, 'utf8') });
    }
    // Tüm dosyaları listele
    var files = [];
    function scan(dir, depth) {
      if (depth > 3) return;
      try {
        fs.readdirSync(dir, { withFileTypes: true }).forEach(function (f) {
          if (f.name.startsWith('.') || f.name === 'node_modules') return;
          var full = path.join(dir, f.name);
          if (f.isDirectory()) scan(full, depth + 1);
          else files.push({ name: f.name, path: full, size: fs.statSync(full).size });
        });
      } catch (e) { }
    }
    scan(projectPath, 0);
    res.json({ status: 'success', projectName, projectPath, fileCount: files.length, files });
  });


  // ── ChatGPT Web endpoints ─────────────────────────────────────────
  app.post('/auto/chatgpt/project', async function (req, res) {
    var { projectName, task, details, waitMs } = req.body;
    if (!projectName || !task) return res.json({ status: 'error', message: 'projectName ve task gerekli' });
    try {
      var result = await AUTO_TOOLS.chatgpt_project({ projectName, task, details, waitMs });
      brain.mem.remember('chatgpt:done:' + projectName, task.slice(0, 80), 0.9);
      MEMORY.goals.push({ goal: 'chatgpt:' + task, projectName, ts: Date.now() });
      saveMem();
      brain.onAgentDone('chatgpt_project:' + projectName, [], 'success');
      res.json({ status: 'success', projectName, result });
    } catch (e) {
      brain.onError('chatgpt_project', task, e.message);
      res.json({ status: 'error', message: e.message });
    }
  });

  app.get('/auto/chatgpt/projects', function (req, res) {
    var projectsDir = path.join(process.cwd(), 'projects');
    if (!fs.existsSync(projectsDir)) return res.json({ status: 'success', projects: [] });
    var projects = fs.readdirSync(projectsDir, { withFileTypes: true })
      .filter(function (f) { return f.isDirectory(); })
      .map(function (f) {
        var p = path.join(projectsDir, f.name);
        var files = [];
        try { files = fs.readdirSync(p).filter(function (x) { return !x.startsWith('.'); }); } catch (e) { }
        return { name: f.name, path: p, fileCount: files.length, hasChatGptOutput: files.includes('chatgpt_output.md') };
      })
      .filter(function (p) { return p.hasChatGptOutput; });
    res.json({ status: 'success', count: projects.length, projects });
  });

  app.get('/auto/chatgpt/projects', function (req, res) {
    var projectsDir = path.join(process.cwd(), 'projects');
    if (!fs.existsSync(projectsDir)) return res.json({ status: 'success', projects: [] });
    var projects = fs.readdirSync(projectsDir, { withFileTypes: true })
      .filter(function (f) { return f.isDirectory(); })
      .map(function (f) {
        var p = path.join(projectsDir, f.name);
        var files = [];
        try { files = fs.readdirSync(p).filter(function (x) { return !x.startsWith('.'); }); } catch (e) { }
        return { name: f.name, path: p, fileCount: files.length, hasChatGptOutput: files.includes('chatgpt_output.md') };
      })
      .filter(function (p) { return p.hasChatGptOutput; });
    res.json({ status: 'success', count: projects.length, projects });
  });


  // ── Gemini Web endpoints ─────────────────────────────────────────
  app.post('/auto/gemini/project', async function (req, res) {
    var { projectName, task, details, waitMs } = req.body;
    if (!projectName || !task) return res.json({ status: 'error', message: 'projectName ve task gerekli' });
    try {
      var result = await AUTO_TOOLS.gemini_project({ projectName, task, details, waitMs });
      brain.mem.remember('gemini:done:' + projectName, task.slice(0, 80), 0.9);
      MEMORY.goals.push({ goal: 'gemini:' + task, projectName, ts: Date.now() });
      saveMem();
      brain.onAgentDone('gemini_project:' + projectName, [], 'success');
      res.json({ status: 'success', projectName, result });
    } catch (e) {
      brain.onError('gemini_project', task, e.message);
      res.json({ status: 'error', message: e.message });
    }
  });

  app.get('/auto/gemini/projects', function (req, res) {
    var projectsDir = path.join(process.cwd(), 'projects');
    if (!fs.existsSync(projectsDir)) return res.json({ status: 'success', projects: [] });
    var projects = fs.readdirSync(projectsDir, { withFileTypes: true })
      .filter(function (f) { return f.isDirectory(); })
      .map(function (f) {
        var p = path.join(projectsDir, f.name);
        var files = [];
        try { files = fs.readdirSync(p).filter(function (x) { return !x.startsWith('.'); }); } catch (e) { }
        return { name: f.name, path: p, fileCount: files.length, hasGeminiOutput: files.includes('gemini_output.md') };
      })
      .filter(function (p) { return p.hasGeminiOutput; });
    res.json({ status: 'success', count: projects.length, projects });
  });


  // ── Claude.ai Web endpoints ──────────────────────────────────────
  app.post('/auto/claudeai/project', async function (req, res) {
    var { projectName, task, details, waitMs } = req.body;
    if (!projectName || !task) return res.json({ status: 'error', message: 'projectName ve task gerekli' });
    try {
      var result = await AUTO_TOOLS.claudeai_project({ projectName, task, details, waitMs });
      brain.mem.remember('claudeai:done:' + projectName, task.slice(0, 80), 0.9);
      MEMORY.goals.push({ goal: 'claudeai:' + task, projectName, ts: Date.now() });
      saveMem();
      brain.onAgentDone('claudeai_project:' + projectName, [], 'success');
      res.json({ status: 'success', projectName, result });
    } catch (e) {
      brain.onError('claudeai_project', task, e.message);
      res.json({ status: 'error', message: e.message });
    }
  });

  app.get('/auto/claudeai/projects', function (req, res) {
    var projectsDir = path.join(process.cwd(), 'projects');
    if (!fs.existsSync(projectsDir)) return res.json({ status: 'success', projects: [] });
    var projects = fs.readdirSync(projectsDir, { withFileTypes: true })
      .filter(function (f) { return f.isDirectory(); })
      .map(function (f) {
        var p = path.join(projectsDir, f.name);
        var files = [];
        try { files = fs.readdirSync(p).filter(function (x) { return !x.startsWith('.'); }); } catch (e) { }
        return { name: f.name, path: p, fileCount: files.length, hasClaudeOutput: files.includes('claudeai_output.md') };
      })
      .filter(function (p) { return p.hasClaudeOutput; });
    res.json({ status: 'success', count: projects.length, projects });
  });


  app.delete('/auto/learning', function (req, res) {
    LEARN = { toolStats: {}, avoidGoals: [], successInsights: [], failInsights: [], totalCycles: 0, codeFiles: [], testedFiles: [] };
    _saveLearn();
    res.json({ status: 'success' });
  });

  // ── Yardımcılar ────────────────────────────────────────────────
  function _sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function _broadcast(data) {
    var p = JSON.stringify(data);
    AUTO.wsClients.forEach(function (ws) { try { ws.send(p); } catch (e) { } });
  }
  function _logLearnSummary() {
    var stats = Object.entries(LEARN.toolStats).map(function (e) { return e[0] + ':OK=' + e[1].ok + '/FAIL=' + e[1].fail; }).join(', ');
    autoLog('learn', 'Ozet (' + AUTO.cycleCount + ' dongu): ' + (stats || 'veri yok'));
  }
  function registerWsClient(ws) {
    AUTO.wsClients.add(ws);
    ws.on('close', function () { AUTO.wsClients.delete(ws); });
    ws.send(JSON.stringify({ type: 'auto_hello', running: AUTO.running, cycle: AUTO.cycleCount }));
  }

  console.log('\n🤖 KaanAI Otonom Agent v3.0 FINAL yuklendi!');
  console.log('-------------------------------------------');
  console.log('  POST   /auto/start        -> baslat');
  console.log('  POST   /auto/stop         -> durdur');
  console.log('  POST   /auto/pause        -> duraklat/devam');
  console.log('  GET    /auto/status       -> durum + ogrenme');
  console.log('  GET    /auto/log          -> son 100 log');
  console.log('  POST   /auto/inject-goal  -> hedef ver');
  console.log('  GET    /auto/tools        -> araclar');
  console.log('  GET    /auto/learning     -> ogrenme hafizasi');
  console.log('  POST   /auto/run-tool     -> tek arac test');
  console.log('  POST   /auto/config       -> ayarlar');
  console.log('-------------------------------------------');
  console.log('  YENI: write_and_test, analyze_code_file, run_and_test');
  console.log('  POST   /auto/antigravity/project -> Antigravity ile proje');
  console.log('  GET    /auto/antigravity/projects -> Antigravity projeleri');
  console.log('  POST   /auto/chatgpt/project -> ChatGPT web ile proje (API yok)');
  console.log('  GET    /auto/chatgpt/projects -> ChatGPT projeleri');
  console.log('  POST   /auto/gemini/project -> Gemini web ile proje (API yok)');
  console.log('  GET    /auto/gemini/projects -> Gemini projeleri');
  console.log('  POST   /auto/claudeai/project -> Claude.ai web ile proje (API yok)');
  console.log('  GET    /auto/claudeai/projects -> Claude.ai projeleri');
  console.log('-------------------------------------------\n');

  return { AUTO, LEARN, AUTO_TOOLS, registerWsClient };
}

module.exports = { mountAutonomousAgent };