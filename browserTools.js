// ============================================================
// 🌐 browserTools.js — Puppeteer Browser Automation v1.0
//
// server.js'e ekle (mountSystemTools'tan SONRA):
// ─────────────────────────────────────────────
//   const { mountBrowserTools } = require('./browserTools');
//   mountBrowserTools(app, autoAgent, brain, {
//     exec, axios, isMac, isWindows, isLinux, fs, path, PORT
//   });
//
// ÖZELLİKLER:
//   ✅ Headful / Headless mod (parametre ile)
//   ✅ Doğal dil komutu → Ollama AI sayfayı analiz eder ve adımlar çalışır
//   ✅ navigate, click, type, extract, scroll, wait araçları
//   ✅ Form doldurma (uçak, otel, alışveriş vb.)
//   ✅ Video indirme — sayfayı aç, yt-dlp ile indir
//   ✅ Web scraping — seçici veya AI tabanlı veri çıkarma
//   ✅ Session/cookie kaydet & yükle (login kalıcı)
//   ✅ Ekran görüntüsü (tam sayfa veya element)
//   ✅ Birden fazla sekme yönetimi
//   ✅ Brain entegrasyonu (öğrenme, hafıza)
//   ✅ autonomous_agent AUTO_TOOLS'a enjeksiyon
//
// API ENDPOINTLERİ:
//   POST  /browser/start          → Tarayıcı başlat {headless?}
//   POST  /browser/stop           → Tarayıcı kapat
//   POST  /browser/navigate       → URL'ye git {url, waitUntil?}
//   POST  /browser/click          → Elemente tıkla {selector, text?}
//   POST  /browser/type           → Metin yaz {selector, text, clear?}
//   POST  /browser/extract        → Veri çek {selector?, fields?}
//   POST  /browser/screenshot     → Ekran görüntüsü {fullPage?, outputPath?}
//   POST  /browser/scroll         → Kaydır {direction, amount?}
//   POST  /browser/wait           → Bekle {selector?, ms?}
//   POST  /browser/eval           → JS çalıştır {code}
//   POST  /browser/fill-form      → Form doldur {fields: [{selector,value}]}
//   POST  /browser/scrape         → Sayfa verisi çek {selector?, ai?}
//   POST  /browser/download-video → Video indir {url, quality?}
//   POST  /browser/session/save   → Cookie kaydet {name}
//   POST  /browser/session/load   → Cookie yükle {name}
//   GET   /browser/sessions       → Kayıtlı sessionlar
//   GET   /browser/status         → Tarayıcı durumu
//   POST  /browser/nl             → Doğal dil komutu {command, url?}
//   POST  /browser/tabs/new       → Yeni sekme aç {url?}
//   POST  /browser/tabs/switch    → Sekme değiştir {index}
//   GET   /browser/tabs           → Açık sekmeler
// ============================================================

'use strict';

const pathMod = require('path');
const { execSync } = require('child_process');

// ══════════════════════════════════════════════════════════════
// 🔌 MOUNT FONKSİYONU
// ══════════════════════════════════════════════════════════════
function mountBrowserTools(app, autoAgent, brain, deps = {}) {
  const { exec, axios, isMac, isWindows, isLinux, fs, path, PORT } = deps;

  const MODEL  = process.env.OLLAMA_MODEL || 'llama3.1:8b';
  const OLLAMA = 'http://localhost:11434';

  // Session dizini
  const SESSIONS_DIR = pathMod.join(process.cwd(), 'browser_sessions');
  if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });

  // ── Log yardımcısı ─────────────────────────────────────────
  function bLog(msg, level = 'info') {
    const icons = { info: '🌐', success: '✅', error: '❌', warn: '⚠️', action: '🖱️' };
    console.log(`[BrowserTools] ${icons[level] || '•'} ${msg}`);
    if (brain) {
      try { brain.mem.remember('browser:log:' + Date.now(), msg.slice(0, 100), 0.2); } catch (_) {}
    }
  }

  // ── Puppeteer state ────────────────────────────────────────
  let _browser   = null;
  let _pages     = [];        // sekme listesi
  let _activePage = null;     // aktif sekme
  let _headless  = false;     // varsayılan: görünür

  // yt-dlp varlık kontrolü
  let _downloader = null;
  function _findDownloader() {
    if (_downloader) return _downloader;
    try { execSync('yt-dlp --version', { stdio: 'pipe' }); _downloader = 'yt-dlp'; return _downloader; } catch (_) {}
    try { execSync('youtube-dl --version', { stdio: 'pipe' }); _downloader = 'youtube-dl'; return _downloader; } catch (_) {}
    return null;
  }

  // ── Shell komutu (promise) ─────────────────────────────────
  function _exec(cmd, timeoutMs = 60000) {
    return new Promise((resolve, reject) => {
      exec(cmd, { timeout: timeoutMs }, (err, stdout, stderr) => {
        if (err) return reject(new Error((stderr || err.message).slice(0, 500)));
        resolve((stdout || 'ok').trim().slice(0, 5000));
      });
    });
  }

  // ── Tarayıcı başlat / al ───────────────────────────────────
  async function _getBrowser(headless = _headless) {
    if (_browser && _browser.isConnected()) return _browser;

    // Puppeteer + StealthPlugin (server.js'te zaten yüklü, tekrar yükle)
    const puppeteer    = require('puppeteer-extra');
    const StealthPlugin = require('puppeteer-extra-plugin-stealth');
    puppeteer.use(StealthPlugin());

    bLog(`Tarayıcı başlatılıyor (${headless ? 'headless' : 'görünür'})...`, 'info');

    _browser = await puppeteer.launch({
      headless: headless ? 'new' : false,
      defaultViewport: null,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--disable-infobars',
        '--window-size=1400,900',
        '--start-maximized',
      ],
      ignoreDefaultArgs: ['--enable-automation'],
    });

    // İlk sekmeyi al
    const pages = await _browser.pages();
    _activePage = pages[0] || await _browser.newPage();
    _pages = [_activePage];

    // Kapatılınca state temizle
    _browser.on('disconnected', () => {
      _browser    = null;
      _activePage = null;
      _pages      = [];
      bLog('Tarayıcı kapatıldı', 'warn');
    });

    bLog('Tarayıcı hazır ✅', 'success');
    return _browser;
  }

  // ── Aktif sayfayı al (yoksa hata) ─────────────────────────
  function _page() {
    if (!_activePage) throw new Error('Tarayıcı açık değil. Önce /browser/start çağır.');
    return _activePage;
  }

  // ── Sayfa HTML'ini kısalt (Ollama token limiti için) ───────
  async function _getPageContext(page, maxLen = 6000) {
    try {
      const url   = page.url();
      const title = await page.title();
      // Tüm interaktif element metinlerini al
      const elements = await page.evaluate(() => {
        const items = [];
        document.querySelectorAll('a, button, input, select, textarea, [role="button"], [role="link"]').forEach((el, i) => {
          if (i > 200) return;
          const text = (el.innerText || el.value || el.placeholder || el.getAttribute('aria-label') || '').trim().slice(0, 80);
          const tag  = el.tagName.toLowerCase();
          const type = el.type || '';
          const id   = el.id ? `#${el.id}` : '';
          const cls  = el.className ? `.${el.className.split(' ')[0]}` : '';
          const href = el.href ? ` href="${el.href.slice(0, 60)}"` : '';
          if (text || type) items.push(`<${tag}${id}${cls}${href} type="${type}">${text}</${tag}>`);
        });
        return items.join('\n');
      });
      return `URL: ${url}\nTitle: ${title}\n\nElements:\n${elements}`.slice(0, maxLen);
    } catch (e) {
      return `URL: ${page.url()} — Context alınamadı: ${e.message}`;
    }
  }

  // ══════════════════════════════════════════════════════════
  // 🛠️ BROWSER ARAÇ DEFİNİSYONLARI
  // ══════════════════════════════════════════════════════════
  const BROWSER_TOOLS = {

    // ────────────────────────────────────────────────────────
    // TEMEL KONTROL
    // ────────────────────────────────────────────────────────

    /** Tarayıcı başlat. args: { headless?: false } */
    browser_start: async (args = {}) => {
      const headless = args.headless === true || args.headless === 'true';
      _headless = headless;
      await _getBrowser(headless);
      return `✅ Tarayıcı başlatıldı (${headless ? 'arka plan' : 'görünür'} mod).`;
    },

    /** Tarayıcı kapat. args: {} */
    browser_stop: async (_args) => {
      if (!_browser) return '⚠️ Tarayıcı zaten kapalı.';
      await _browser.close();
      _browser = null; _activePage = null; _pages = [];
      return '✅ Tarayıcı kapatıldı.';
    },

    /**
     * URL'ye git. args: { url, waitUntil?: 'load'|'networkidle2'|'domcontentloaded' }
     * waitUntil varsayılan: 'networkidle2'
     */
    browser_navigate: async (args) => {
      const { url, waitUntil = 'networkidle2' } = args;
      if (!url) throw new Error('url gerekli');
      if (!_browser) await _getBrowser();
      const page = _page();
      bLog(`Gidiliyor: ${url.slice(0, 80)}`, 'action');
      await page.goto(url, { waitUntil, timeout: 30000 });
      const title = await page.title();
      if (brain) { try { brain.mem.remember(`browser:visit:${url.slice(0, 60)}`, title, 0.5); } catch (_) {} }
      return `✅ Açıldı: ${title}\nURL: ${page.url()}`;
    },

    /**
     * Elemente tıkla.
     * args: { selector?, text? }
     * selector: CSS seçici — VEYA — text: sayfa üzerinde görünen metin
     */
    browser_click: async (args) => {
      const { selector, text } = args;
      if (!selector && !text) throw new Error('selector veya text gerekli');
      const page = _page();

      if (text) {
        // XPath ile metin eşleştir
        bLog(`Metin ile tıklanıyor: "${text}"`, 'action');
        const [el] = await page.$x(`//*[normalize-space(text())="${text}"] | //input[@value="${text}"]`);
        if (!el) {
          // Kısmi eşleşme dene
          const [el2] = await page.$x(`//*[contains(normalize-space(text()),"${text}")]`);
          if (!el2) throw new Error(`"${text}" metni bulunamadı`);
          await el2.click();
        } else {
          await el.click();
        }
      } else {
        bLog(`Tıklanıyor: ${selector}`, 'action');
        await page.waitForSelector(selector, { timeout: 8000 });
        await page.click(selector);
      }

      await new Promise(r => setTimeout(r, 500));
      return `✅ Tıklandı: ${selector || text}`;
    },

    /**
     * Input alanına yaz.
     * args: { selector, text, clear?: true }
     */
    browser_type: async (args) => {
      const { selector, text, clear = true } = args;
      if (!selector || text === undefined) throw new Error('selector ve text gerekli');
      const page = _page();
      bLog(`Yazılıyor → ${selector}: "${String(text).slice(0, 40)}"`, 'action');
      await page.waitForSelector(selector, { timeout: 8000 });
      if (clear) await page.click(selector, { clickCount: 3 });
      await page.type(selector, String(text), { delay: 40 });
      return `✅ Yazıldı: "${String(text).slice(0, 60)}" → ${selector}`;
    },

    /**
     * Sayfadan veri çek.
     * args: { selector?: 'div.price', attribute?: 'href'|'src'|'text', multiple?: true }
     */
    browser_extract: async (args) => {
      const { selector, attribute = 'text', multiple = false } = args;
      const page = _page();

      if (!selector) {
        // Selector yoksa tüm sayfa metnini döndür
        const text = await page.evaluate(() => document.body.innerText);
        return text.trim().slice(0, 3000);
      }

      bLog(`Veri çekiliyor: ${selector} [${attribute}]`, 'action');

      const result = await page.evaluate(
        ({ sel, attr, multi }) => {
          const els = multi ? Array.from(document.querySelectorAll(sel)) : [document.querySelector(sel)];
          return els.filter(Boolean).map(el => {
            if (attr === 'text')    return el.innerText?.trim() || '';
            if (attr === 'html')    return el.innerHTML?.trim() || '';
            return el.getAttribute(attr) || '';
          });
        },
        { sel: selector, attr: attribute, multi: multiple }
      );

      if (!result || result.length === 0) return `"${selector}" için sonuç bulunamadı.`;
      return multiple ? JSON.stringify(result, null, 2) : result[0];
    },

    /**
     * Ekran görüntüsü al.
     * args: { fullPage?: true, outputPath?, selector? }
     */
    browser_screenshot: async (args = {}) => {
      const { fullPage = false, selector } = args;
      const outFile = args.outputPath || pathMod.join(
        process.env.HOME || process.cwd(),
        `browser_${Date.now()}.png`
      );
      const page = _page();
      bLog('Ekran görüntüsü alınıyor', 'action');

      if (selector) {
        const el = await page.$(selector);
        if (!el) throw new Error(`"${selector}" elementi bulunamadı`);
        await el.screenshot({ path: outFile });
      } else {
        await page.screenshot({ path: outFile, fullPage });
      }

      return `✅ Ekran görüntüsü: ${outFile}`;
    },

    /**
     * Kaydır.
     * args: { direction: 'down'|'up'|'bottom'|'top', amount?: 800 }
     */
    browser_scroll: async (args = {}) => {
      const { direction = 'down', amount = 800 } = args;
      const page = _page();
      bLog(`Kaydırılıyor: ${direction} (${amount}px)`, 'action');

      await page.evaluate(({ dir, amt }) => {
        if (dir === 'bottom') return window.scrollTo(0, document.body.scrollHeight);
        if (dir === 'top')    return window.scrollTo(0, 0);
        window.scrollBy(0, dir === 'down' ? amt : -amt);
      }, { dir: direction, amt: Number(amount) });

      await new Promise(r => setTimeout(r, 400));
      return `✅ Kaydırıldı: ${direction}`;
    },

    /**
     * Bekle.
     * args: { selector?: '.loaded', ms?: 2000 }
     */
    browser_wait: async (args = {}) => {
      const { selector, ms = 1500 } = args;
      const page = _page();

      if (selector) {
        bLog(`Bekleniyor: ${selector}`, 'action');
        await page.waitForSelector(selector, { timeout: 15000 });
        return `✅ Element göründü: ${selector}`;
      }

      bLog(`Bekleniyor: ${ms}ms`, 'action');
      await new Promise(r => setTimeout(r, Number(ms)));
      return `✅ ${ms}ms beklendi.`;
    },

    /**
     * Sayfada JavaScript çalıştır.
     * args: { code: "return document.title" }
     */
    browser_eval: async (args) => {
      const { code } = args;
      if (!code) throw new Error('code gerekli');
      const page = _page();
      bLog(`JS çalıştırılıyor: ${code.slice(0, 60)}`, 'action');
      const result = await page.evaluate(new Function(code));
      return String(result ?? 'undefined').slice(0, 2000);
    },

    // ────────────────────────────────────────────────────────
    // FORM DOLDURMA
    // ────────────────────────────────────────────────────────

    /**
     * Birden fazla form alanını doldur ve (isteğe bağlı) gönder.
     * args: {
     *   fields: [{ selector: "input[name='from']", value: "Istanbul" }, ...],
     *   submit?: "button[type='submit']" | "button.search-btn" | "text:Ara"
     * }
     */
    browser_fill_form: async (args) => {
      const { fields = [], submit } = args;
      if (!fields.length) throw new Error('fields dizisi gerekli');
      const page = _page();
      const log  = [];

      for (const field of fields) {
        try {
          await page.waitForSelector(field.selector, { timeout: 6000 });

          // Select elementi mi?
          const tagName = await page.$eval(field.selector, el => el.tagName.toLowerCase());

          if (tagName === 'select') {
            await page.select(field.selector, String(field.value));
            log.push(`✅ Seçildi: ${field.selector} = "${field.value}"`);
          } else if (tagName === 'input' || tagName === 'textarea') {
            await page.click(field.selector, { clickCount: 3 });
            await page.type(field.selector, String(field.value), { delay: 35 });
            log.push(`✅ Yazıldı: ${field.selector} = "${String(field.value).slice(0, 40)}"`);
          } else {
            await page.click(field.selector);
            log.push(`✅ Tıklandı: ${field.selector}`);
          }

          await new Promise(r => setTimeout(r, 200));
        } catch (e) {
          log.push(`⚠️ Alan atlandı: ${field.selector} — ${e.message}`);
        }
      }

      // Submit
      if (submit) {
        try {
          if (submit.startsWith('text:')) {
            const btnText = submit.replace('text:', '');
            const [btn] = await page.$x(`//button[contains(normalize-space(text()),"${btnText}")] | //input[@value="${btnText}"]`);
            if (btn) { await btn.click(); log.push(`✅ Form gönderildi (buton: "${btnText}")`); }
            else log.push(`⚠️ Gönder butonu bulunamadı: "${btnText}"`);
          } else {
            await page.click(submit);
            log.push(`✅ Form gönderildi (${submit})`);
          }
          await new Promise(r => setTimeout(r, 1500));
        } catch (e) {
          log.push(`⚠️ Submit hatası: ${e.message}`);
        }
      }

      return log.join('\n');
    },

    // ────────────────────────────────────────────────────────
    // WEB SCRAPING
    // ────────────────────────────────────────────────────────

    /**
     * Sayfadan yapılandırılmış veri çek.
     * args: {
     *   url?: "https://...",   // navigasyon yapar
     *   selector?: "div.item", // tekrarlayan elementler
     *   fields?: { title: "h2", price: ".price", link: { selector: "a", attr: "href" } },
     *   ai?: true              // AI ile veri çıkar (Ollama)
     * }
     */
    browser_scrape: async (args) => {
      const { url, selector, fields, ai = false } = args;
      const page = _page();

      // Navigasyon
      if (url) {
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
        await new Promise(r => setTimeout(r, 1000));
      }

      // AI ile scraping
      if (ai) {
        const context = await _getPageContext(page, 5000);
        const prompt  = `Bu sayfadan yapılandırılmış veriyi JSON olarak çıkar. Sadece JSON döndür:\n\n${context}`;
        const r = await axios.post(OLLAMA + '/api/generate', {
          model: MODEL, stream: false, prompt,
          options: { temperature: 0.1, num_predict: 1000 }
        });
        const match = (r.data.response || '').match(/\[[\s\S]*\]|\{[\s\S]*\}/);
        return match ? match[0] : r.data.response?.slice(0, 2000) || 'Sonuç alınamadı';
      }

      // Manuel scraping
      if (selector && fields) {
        const items = await page.evaluate(({ sel, flds }) => {
          return Array.from(document.querySelectorAll(sel)).map(el => {
            const obj = {};
            for (const [key, conf] of Object.entries(flds)) {
              const child = el.querySelector(typeof conf === 'string' ? conf : conf.selector);
              if (!child) { obj[key] = null; continue; }
              obj[key] = (typeof conf === 'string' || !conf.attr)
                ? child.innerText?.trim()
                : conf.attr === 'href' ? child.href : child.getAttribute(conf.attr);
            }
            return obj;
          }).filter(o => Object.values(o).some(Boolean));
        }, { sel: selector, flds: fields });

        return JSON.stringify(items, null, 2).slice(0, 5000);
      }

      // Sadece selector — liste döndür
      if (selector) {
        const texts = await page.$$eval(selector, els => els.map(e => e.innerText?.trim()).filter(Boolean));
        return JSON.stringify(texts, null, 2).slice(0, 3000);
      }

      // Hiçbir şey yoksa sayfanın başlık + metin özeti
      const title   = await page.title();
      const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 3000));
      return `# ${title}\n\n${bodyText}`;
    },

    // ────────────────────────────────────────────────────────
    // VİDEO İNDİRME (Puppeteer + yt-dlp)
    // ────────────────────────────────────────────────────────

    /**
     * Videoyu tarayıcıda aç, yt-dlp ile indir.
     * args: { url, quality?: 'best'|'1080p'|'720p'|'audio', outputDir?, openBrowser?: true }
     */
    browser_download_video: async (args) => {
      const { url, quality = 'best', outputDir, openBrowser = true } = args;
      if (!url) throw new Error('url gerekli');

      const dl = _findDownloader();
      if (!dl) {
        return [
          '⚠️ yt-dlp kurulu değil.',
          'Kurmak için: brew install yt-dlp',
          '',
          'Kurulduktan sonra tekrar dene.'
        ].join('\n');
      }

      // İsteğe bağlı: tarayıcıda göster
      if (openBrowser) {
        try {
          if (!_browser) await _getBrowser(false); // görünür
          await _page().goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
          bLog(`Sayfa açıldı: ${url.slice(0, 60)}`, 'info');
          await new Promise(r => setTimeout(r, 2000));
        } catch (e) {
          bLog(`Tarayıcı açma hatası: ${e.message}`, 'warn');
        }
      }

      // yt-dlp ile indir
      const outDir = outputDir || pathMod.join(process.env.HOME || process.cwd(), 'Downloads');
      let fmtFlag  = '';
      if (quality === '1080p') {
        fmtFlag = '-f "bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/best[height<=1080]"';
      } else if (quality === '720p') {
        fmtFlag = '-f "bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/best[height<=720]"';
      } else if (quality === 'audio' || quality === 'mp3') {
        fmtFlag = '-x --audio-format mp3';
      } else {
        fmtFlag = '-f "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best"';
      }

      const cmd = `${dl} ${fmtFlag} --no-playlist -o "${outDir}/%(title)s.%(ext)s" "${url.replace(/"/g, '\\"')}"`;
      bLog(`İndiriliyor: ${url.slice(0, 60)}`, 'info');

      try {
        const result = await _exec(cmd, 10 * 60 * 1000);
        if (brain) { try { brain.learn('browser_download_video', url.slice(0, 60)); } catch (_) {} }
        return `✅ İndirildi → ${outDir}\n\n${result.slice(-400)}`;
      } catch (e) {
        return `❌ İndirme hatası: ${e.message.slice(0, 300)}`;
      }
    },

    // ────────────────────────────────────────────────────────
    // SESSION / COOKIE YÖNETİMİ
    // ────────────────────────────────────────────────────────

    /** Cookie/session kaydet. args: { name: "google" } */
    browser_session_save: async (args) => {
      const { name } = args;
      if (!name) throw new Error('name gerekli');
      const page    = _page();
      const cookies = await page.cookies();
      const file    = pathMod.join(SESSIONS_DIR, `${name}.json`);
      fs.writeFileSync(file, JSON.stringify(cookies, null, 2));
      bLog(`Session kaydedildi: ${name} (${cookies.length} cookie)`, 'success');
      if (brain) { try { brain.mem.remember(`browser:session:${name}`, file, 0.9); } catch (_) {} }
      return `✅ Session kaydedildi: "${name}" (${cookies.length} cookie)\n📁 ${file}`;
    },

    /** Kayıtlı cookie/session yükle. args: { name: "google" } */
    browser_session_load: async (args) => {
      const { name } = args;
      if (!name) throw new Error('name gerekli');
      const file = pathMod.join(SESSIONS_DIR, `${name}.json`);
      if (!fs.existsSync(file)) throw new Error(`"${name}" session bulunamadı.`);
      const page    = _page();
      const cookies = JSON.parse(fs.readFileSync(file, 'utf8'));
      await page.setCookie(...cookies);
      bLog(`Session yüklendi: ${name} (${cookies.length} cookie)`, 'success');
      return `✅ Session yüklendi: "${name}" (${cookies.length} cookie)`;
    },

    // ────────────────────────────────────────────────────────
    // SEKME YÖNETİMİ
    // ────────────────────────────────────────────────────────

    /** Yeni sekme aç. args: { url? } */
    browser_new_tab: async (args = {}) => {
      if (!_browser) await _getBrowser();
      const page = await _browser.newPage();
      _pages.push(page);
      _activePage = page;
      if (args.url) {
        await page.goto(args.url, { waitUntil: 'networkidle2', timeout: 30000 });
        const title = await page.title();
        return `✅ Yeni sekme (${_pages.length - 1}): ${title}`;
      }
      return `✅ Yeni sekme açıldı (index: ${_pages.length - 1})`;
    },

    /** Sekme değiştir. args: { index: 0 } */
    browser_switch_tab: async (args) => {
      const index = parseInt(args.index ?? 0);
      if (!_pages[index]) throw new Error(`Sekme ${index} mevcut değil.`);
      _activePage = _pages[index];
      await _activePage.bringToFront();
      const title = await _activePage.title();
      return `✅ Aktif sekme → ${index}: ${title}`;
    },

    // ────────────────────────────────────────────────────────
    // DURUM
    // ────────────────────────────────────────────────────────

    /** Tarayıcı durumu. args: {} */
    browser_status: async (_args) => {
      if (!_browser || !_browser.isConnected()) return '🔴 Tarayıcı kapalı.';
      const page  = _page();
      const url   = page.url();
      const title = await page.title();
      return [
        `🟢 Tarayıcı açık (${_headless ? 'headless' : 'görünür'})`,
        `📄 Aktif sayfa: ${title}`,
        `🔗 URL: ${url}`,
        `📑 Sekme sayısı: ${_pages.length}`,
      ].join('\n');
    },

  }; // ── BROWSER_TOOLS sonu ────────────────────────────────

  // ══════════════════════════════════════════════════════════
  // autonomous_agent AUTO_TOOLS'a enjekte et
  // ══════════════════════════════════════════════════════════
  if (autoAgent && autoAgent.AUTO_TOOLS) {
    Object.assign(autoAgent.AUTO_TOOLS, BROWSER_TOOLS);
    bLog(`${Object.keys(BROWSER_TOOLS).length} browser aracı AUTO_TOOLS'a eklendi ✅`, 'success');
  }

  // ══════════════════════════════════════════════════════════
  // brain.enrichPrompt → araç listesini Ollama'ya bildir
  // ══════════════════════════════════════════════════════════
  if (brain && typeof brain.enrichPrompt === 'function') {
    const _orig = brain.enrichPrompt.bind(brain);
    brain.enrichPrompt = function (userPrompt) {
      const base      = _orig(userPrompt);
      const toolBlock = [
        `=== TARAYICI ARAÇLARI ===`,
        `• browser_start         : {"headless":false} → Tarayıcı başlat`,
        `• browser_navigate      : {"url":"..."} → URL aç`,
        `• browser_click         : {"selector":"..."} | {"text":"..."} → Tıkla`,
        `• browser_type          : {"selector":"...","text":"..."} → Yaz`,
        `• browser_extract       : {"selector":"...","attribute":"text|href"} → Veri çek`,
        `• browser_fill_form     : {"fields":[{"selector":"...","value":"..."}],"submit":"..."} → Form doldur`,
        `• browser_scrape        : {"url":"...","selector":"...","fields":{...}} → Scraping`,
        `• browser_download_video: {"url":"...","quality":"720p|1080p|audio"} → Video/müzik indir`,
        `• browser_screenshot    : {"fullPage":true} → Ekran görüntüsü`,
        `• browser_session_save  : {"name":"site_adi"} → Cookie kaydet`,
        `• browser_session_load  : {"name":"site_adi"} → Cookie yükle`,
        `• browser_status        : {} → Tarayıcı durumu`,
        `=== /TARAYICI ARAÇLARI ===`,
      ].join('\n');

      const marker = '=== KULLANICI İSTEĞİ ===';
      return base.includes(marker)
        ? base.replace(marker, toolBlock + '\n\n' + marker)
        : toolBlock + '\n\n' + base;
    };
    bLog('brain.enrichPrompt tarayıcı araçlarıyla genişletildi ✅');
  }

  // ══════════════════════════════════════════════════════════
  // EXPRESS API ENDPOINTLERİ
  // ══════════════════════════════════════════════════════════

  // ── Yardımcı: tool çalıştır ve yanıt döndür ───────────────
  async function _run(res, toolName, args) {
    try {
      const result = await BROWSER_TOOLS[toolName](args || {});
      if (brain) { try { brain.emo.onSuccess(); } catch (_) {} }
      res.json({ status: 'success', tool: toolName, result });
    } catch (e) {
      bLog(`${toolName} hatası: ${e.message}`, 'error');
      if (brain) { try { brain.onError('browser', toolName, e.message); } catch (_) {} }
      res.json({ status: 'error', tool: toolName, message: e.message });
    }
  }

  // POST /browser/start
  app.post('/browser/start', (req, res) => _run(res, 'browser_start', req.body));

  // POST /browser/stop
  app.post('/browser/stop', (req, res) => _run(res, 'browser_stop', req.body));

  // POST /browser/navigate
  app.post('/browser/navigate', (req, res) => {
    if (!req.body.url) return res.json({ status: 'error', message: 'url gerekli' });
    _run(res, 'browser_navigate', req.body);
  });

  // POST /browser/click
  app.post('/browser/click', (req, res) => {
    if (!req.body.selector && !req.body.text) return res.json({ status: 'error', message: 'selector veya text gerekli' });
    _run(res, 'browser_click', req.body);
  });

  // POST /browser/type
  app.post('/browser/type', (req, res) => {
    if (!req.body.selector || req.body.text === undefined) return res.json({ status: 'error', message: 'selector ve text gerekli' });
    _run(res, 'browser_type', req.body);
  });

  // POST /browser/extract
  app.post('/browser/extract', (req, res) => _run(res, 'browser_extract', req.body));

  // POST /browser/screenshot
  app.post('/browser/screenshot', (req, res) => _run(res, 'browser_screenshot', req.body));

  // POST /browser/scroll
  app.post('/browser/scroll', (req, res) => _run(res, 'browser_scroll', req.body));

  // POST /browser/wait
  app.post('/browser/wait', (req, res) => _run(res, 'browser_wait', req.body));

  // POST /browser/eval
  app.post('/browser/eval', (req, res) => {
    if (!req.body.code) return res.json({ status: 'error', message: 'code gerekli' });
    _run(res, 'browser_eval', req.body);
  });

  // POST /browser/fill-form
  app.post('/browser/fill-form', (req, res) => {
    if (!req.body.fields?.length) return res.json({ status: 'error', message: 'fields dizisi gerekli' });
    _run(res, 'browser_fill_form', req.body);
  });

  // POST /browser/scrape
  app.post('/browser/scrape', (req, res) => _run(res, 'browser_scrape', req.body));

  // POST /browser/download-video
  app.post('/browser/download-video', (req, res) => {
    if (!req.body.url) return res.json({ status: 'error', message: 'url gerekli' });
    _run(res, 'browser_download_video', req.body);
  });

  // POST /browser/session/save
  app.post('/browser/session/save', (req, res) => {
    if (!req.body.name) return res.json({ status: 'error', message: 'name gerekli' });
    _run(res, 'browser_session_save', req.body);
  });

  // POST /browser/session/load
  app.post('/browser/session/load', (req, res) => {
    if (!req.body.name) return res.json({ status: 'error', message: 'name gerekli' });
    _run(res, 'browser_session_load', req.body);
  });

  // GET /browser/sessions
  app.get('/browser/sessions', (req, res) => {
    try {
      const files = fs.readdirSync(SESSIONS_DIR).filter(f => f.endsWith('.json'));
      res.json({ status: 'success', sessions: files.map(f => f.replace('.json', '')), dir: SESSIONS_DIR });
    } catch (e) {
      res.json({ status: 'error', message: e.message });
    }
  });

  // GET /browser/status
  app.get('/browser/status', (req, res) => _run(res, 'browser_status', {}));

  // POST /browser/tabs/new
  app.post('/browser/tabs/new', (req, res) => _run(res, 'browser_new_tab', req.body));

  // POST /browser/tabs/switch
  app.post('/browser/tabs/switch', (req, res) => {
    if (req.body.index === undefined) return res.json({ status: 'error', message: 'index gerekli' });
    _run(res, 'browser_switch_tab', req.body);
  });

  // GET /browser/tabs
  app.get('/browser/tabs', async (req, res) => {
    if (!_browser || !_browser.isConnected()) return res.json({ status: 'success', tabs: [], open: false });
    try {
      const tabs = await Promise.all(_pages.map(async (p, i) => {
        try { return { index: i, title: await p.title(), url: p.url(), active: p === _activePage }; }
        catch (_) { return { index: i, title: '?', url: '?', active: false }; }
      }));
      res.json({ status: 'success', tabs, total: tabs.length });
    } catch (e) {
      res.json({ status: 'error', message: e.message });
    }
  });

  // ── NL — Doğal Dil Komutu ─────────────────────────────────
  // POST /browser/nl  { command: "youtube.com'da Daft Punk aç ve videoyu 720p indir" }
  app.post('/browser/nl', async (req, res) => {
    const { command, url } = req.body;
    if (!command) return res.json({ status: 'error', message: 'command gerekli' });

    // Tarayıcıyı aç (yoksa)
    if (!_browser) await _getBrowser(false);

    // Önce istek yapılan URL'ye git (varsa)
    let pageContext = '';
    if (url) {
      try {
        await _page().goto(url, { waitUntil: 'networkidle2', timeout: 25000 });
        await new Promise(r => setTimeout(r, 1500));
      } catch (e) { bLog(`NL navigasyon hatası: ${e.message}`, 'warn'); }
    }

    // Sayfanın bağlamını al
    try { pageContext = await _getPageContext(_page(), 5000); } catch (_) {}

    // Mevcut araç listesi
    const toolList = Object.keys(BROWSER_TOOLS).map(name => {
      const HINTS = {
        browser_start:          '{"headless":false}',
        browser_stop:           '{}',
        browser_navigate:       '{"url":"https://...","waitUntil":"networkidle2"}',
        browser_click:          '{"selector":"CSS_SELECTOR"} | {"text":"Görünen metin"}',
        browser_type:           '{"selector":"input#q","text":"aranacak şey"}',
        browser_extract:        '{"selector":".price","attribute":"text","multiple":true}',
        browser_screenshot:     '{"fullPage":false}',
        browser_scroll:         '{"direction":"down","amount":800}',
        browser_wait:           '{"selector":".loaded"} | {"ms":2000}',
        browser_eval:           '{"code":"return document.title"}',
        browser_fill_form:      '{"fields":[{"selector":"input[name=from]","value":"Istanbul"}],"submit":"button[type=submit]"}',
        browser_scrape:         '{"url":"https://...","selector":"div.item","fields":{"title":"h3","price":".price"}}',
        browser_download_video: '{"url":"https://youtube.com/...","quality":"720p"}',
        browser_session_save:   '{"name":"youtube"}',
        browser_session_load:   '{"name":"youtube"}',
        browser_new_tab:        '{"url":"https://..."}',
        browser_switch_tab:     '{"index":0}',
        browser_status:         '{}',
      };
      return `${name}: ${HINTS[name] || '{}'}`;
    }).join('\n');

    const prompt = [
      `SYSTEM: You output ONLY a valid JSON array. No explanation. No markdown. No text before or after. Just the JSON array.`,
      ``,
      `TASK: Convert the user command into browser automation steps.`,
      `USER COMMAND: "${command}"`,
      ``,
      `CURRENT PAGE:`,
      pageContext || '(no page open)',
      ``,
      `AVAILABLE TOOLS:`,
      toolList,
      ``,
      `STRICT RULES:`,
      `- Output ONLY a JSON array. First char must be [ last char must be ]`,
      `- NO explanation, NO markdown, NO text, NO comments whatsoever`,
      `- For scraping use browser_scrape with selector+fields`,
      `- For video: browser_navigate then browser_download_video`,
      `- For search: browser_navigate, browser_type, browser_click`,
      ``,
      `EXAMPLE 1:`,
      `Command: "go to google and search cats"`,
      `Output: [{"tool":"browser_navigate","args":{"url":"https://google.com"}},{"tool":"browser_type","args":{"selector":"input[name=q]","text":"cats"}},{"tool":"browser_click","args":{"selector":"input[type=submit]"}}]`,
      ``,
      `EXAMPLE 2:`,
      `Command: "get titles from hacker news"`,
      `Output: [{"tool":"browser_navigate","args":{"url":"https://news.ycombinator.com"}},{"tool":"browser_scrape","args":{"selector":".titleline","fields":{"title":"a"}}}]`,
      ``,
      `NOW OUTPUT THE JSON ARRAY ONLY:`,
    ].join('\n');

    try {
      bLog(`NL komutu: "${command.slice(0, 60)}"`, 'info');

      const r = await axios.post(OLLAMA + '/api/generate', {
        model: MODEL, stream: false, prompt,
        options: { temperature: 0.0, num_predict: 600 }
      });

      const text = (r.data.response || '').trim();

      // Modelin birden fazla JSON bloğu üretmesi ihtimaline karşı
      // tüm [...] bloklarını bul, parse edilebilenleri birleştir
      const allMatches = [...text.matchAll(/\[[\s\S]*?\]/g)];
      if (!allMatches.length) return res.json({ status: 'error', message: 'AI adımlar üretemedi', raw: text.slice(0, 300) });

      let steps = [];
      for (const m of allMatches) {
        try {
          const parsed = JSON.parse(m[0]);
          if (Array.isArray(parsed) && parsed.length > 0 && parsed[0].tool) {
            steps = steps.concat(parsed);
          }
        } catch (_) {
          // Bu blok parse edilemedi, atla
        }
      }

      // Hiç geçerli blok bulunamadıysa greedy match ile son bir deneme
      if (!steps.length) {
        const greedyMatch = text.match(/\[[\s\S]*\]/);
        if (greedyMatch) {
          const cleaned = greedyMatch[0]
            .replace(/```[\s\S]*?```/g, '')            // markdown kod bloklarını sil
            .replace(/[\u0000-\u001F\u007F]/g, ' ')    // kontrol karakterleri
            .replace(/,\s*([}\]])/g, '$1')              // trailing comma
            .replace(/([{,]\s*)(\w+)\s*:/g, '$1"$2":'); // unquoted key
          try {
            const parsed = JSON.parse(cleaned);
            if (Array.isArray(parsed)) steps = parsed;
          } catch (e) {
            return res.json({ status: 'error', message: `AI geçersiz JSON üretti: ${e.message}`, raw: text.slice(0, 400) });
          }
        }
      }

      if (!steps.length) {
        return res.json({ status: 'error', message: 'AI adımlar üretemedi', raw: text.slice(0, 300) });
      }
      const results = [];

      bLog(`${steps.length} adım çalıştırılıyor...`, 'info');

      for (const step of steps) {
        const fn = BROWSER_TOOLS[step.tool];
        if (!fn) {
          results.push({ tool: step.tool, status: 'error', message: 'Araç bulunamadı' });
          continue;
        }
        try {
          const result = await fn(step.args || {});
          results.push({ tool: step.tool, args: step.args, status: 'success', result });
          bLog(`✅ ${step.tool}`, 'success');
          // Adımlar arası kısa bekleme
          await new Promise(r => setTimeout(r, 300));
        } catch (e) {
          results.push({ tool: step.tool, args: step.args, status: 'error', message: e.message });
          bLog(`❌ ${step.tool}: ${e.message}`, 'error');
          // Kritik hata değilse devam et
        }
      }

      if (brain) { try { brain.learn('browser_nl', command.slice(0, 60)); brain.emo.onSuccess(); } catch (_) {} }

      const summary = results.map(r =>
        `${r.status === 'success' ? '✅' : '❌'} ${r.tool}: ${(r.result || r.message || '').slice(0, 100)}`
      ).join('\n');

      res.json({ status: 'success', command, steps: results, summary });

    } catch (e) {
      bLog(`NL hatası: ${e.message}`, 'error');
      res.json({ status: 'error', message: e.message });
    }
  });

  // ── Boot logu ──────────────────────────────────────────────
  console.log('\n🌐 TARAYICI ARAÇLARI YÜKLENDİ');
  console.log('══════════════════════════════════════════════════════');
  console.log('  POST   /browser/start           → Tarayıcı başlat {headless?}');
  console.log('  POST   /browser/stop            → Tarayıcı kapat');
  console.log('  POST   /browser/navigate        → URL aç {url}');
  console.log('  POST   /browser/click           → Tıkla {selector|text}');
  console.log('  POST   /browser/type            → Yaz {selector,text}');
  console.log('  POST   /browser/extract         → Veri çek {selector,attribute}');
  console.log('  POST   /browser/fill-form       → Form doldur {fields,submit?}');
  console.log('  POST   /browser/scrape          → Scraping {url?,selector?,fields?,ai?}');
  console.log('  POST   /browser/download-video  → Video indir {url,quality?}');
  console.log('  POST   /browser/screenshot      → Ekran görüntüsü {fullPage?}');
  console.log('  POST   /browser/scroll          → Kaydır {direction,amount?}');
  console.log('  POST   /browser/wait            → Bekle {selector?|ms?}');
  console.log('  POST   /browser/session/save    → Cookie kaydet {name}');
  console.log('  POST   /browser/session/load    → Cookie yükle {name}');
  console.log('  GET    /browser/sessions        → Kayıtlı sessionlar');
  console.log('  GET    /browser/status          → Durum');
  console.log('  POST   /browser/tabs/new        → Yeni sekme {url?}');
  console.log('  POST   /browser/tabs/switch     → Sekme değiştir {index}');
  console.log('  GET    /browser/tabs            → Sekmeler');
  console.log('  POST   /browser/nl              → 🤖 NL komutu {command, url?}');
  console.log('══════════════════════════════════════════════════════\n');

  return { BROWSER_TOOLS };
}

module.exports = { mountBrowserTools };