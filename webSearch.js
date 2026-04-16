// ============================================================
// 🌐 webSearch.js — Ücretsiz Web Arama Servisi v1
//
// API key yok, tamamen scraping ile çalışır.
// DuckDuckGo + Google fallback.
//
// Brain ile TAM entegre:
//   - Arama sonuçları hafızaya kaydedilir
//   - enrichPrompt'a otomatik eklenir (ilgili sorularda)
//   - Ollama + Turkish AI için hazır bağlam üretir
//
// KURULUM — server.js'in sonuna ekle:
//   const { mountWebSearch } = require('./webSearch');
//   mountWebSearch(app, brain, axios);
//
// Mevcut hiçbir dosyaya dokunmaz.
// ============================================================

'use strict';

const { JSDOM } = (() => {
  try { return require('jsdom'); } catch { return {}; }
})();

// ── Sonuç cache (aynı sorguyu tekrar aramayı önle) ────────
const _cache = new Map();  // query → { results, ts }
const CACHE_TTL_MS = 10 * 60 * 1000;  // 10 dakika

// ── Arama geçmişi ──────────────────────────────────────────
const _history = [];  // son 20 arama

// ── HTML parse yardımcısı ──────────────────────────────────
function _parseHTML(html) {
  // JSDOM varsa kullan, yoksa regex ile
  if (JSDOM) {
    try {
      const dom = new JSDOM(html);
      return dom.window.document;
    } catch (_) {}
  }
  return null;
}

function _stripTags(html) {
  return (html || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// ── DuckDuckGo Instant Answer API (JSON, engel yok) ───────
async function _searchDuckDuckGoAPI(axios, query, maxResults = 5) {
  const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
  const r = await axios.get(url, {
    timeout: 8000,
    headers: { 'User-Agent': 'Mozilla/5.0 KaanAI/1.0' }
  });
  const data    = r.data || {};
  const results = [];

  if (data.AbstractText) {
    results.push({
      title:   data.Heading || query,
      url:     data.AbstractURL || '',
      snippet: data.AbstractText.substring(0, 300),
      source:  'duckduckgo_api'
    });
  }

  const topics = data.RelatedTopics || [];
  for (const topic of topics) {
    if (results.length >= maxResults) break;
    if (topic.Text && topic.FirstURL) {
      results.push({
        title:   topic.Text.substring(0, 100),
        url:     topic.FirstURL,
        snippet: topic.Text.substring(0, 200),
        source:  'duckduckgo_api'
      });
    }
    if (topic.Topics) {
      for (const sub of topic.Topics) {
        if (results.length >= maxResults) break;
        if (sub.Text && sub.FirstURL) {
          results.push({
            title:   sub.Text.substring(0, 100),
            url:     sub.FirstURL,
            snippet: sub.Text.substring(0, 200),
            source:  'duckduckgo_api'
          });
        }
      }
    }
  }
  return results;
}

// ── DuckDuckGo scraping ───────────────────────────────────
async function _searchDuckDuckGo(axios, query, maxResults = 5) {
  // Önce JSON API dene
  try {
    const apiResults = await _searchDuckDuckGoAPI(axios, query, maxResults);
    if (apiResults.length > 0) return apiResults;
  } catch (_) {}

  // Fallback: HTML scrape
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}&kl=tr-tr`;
  const r = await axios.get(url, {
    timeout: 8000,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0 Safari/537.36',
      'Accept-Language': 'tr-TR,tr;q=0.9,en;q=0.8',
    }
  });

  const results = [];
  const html    = r.data || '';
  const seen    = new Set();

  // DDG HTML'den link + başlık + snippet çek
  const linkRegex    = /href="(https?:\/\/(?!duckduckgo)[^"]+)"[^>]*>([^<]{5,120})</gi;
  const snippetRegex = /class="result__snippet"[^>]*>([\s\S]{10,300}?)<\/a>/gi;
  const snippets     = [...html.matchAll(snippetRegex)].map(m => _stripTags(m[1]));
  const links        = [...html.matchAll(linkRegex)];

  let si = 0;
  for (const link of links) {
    if (results.length >= maxResults) break;
    const rawUrl = link[1];
    const title  = _stripTags(link[2]).trim();
    if (!rawUrl || !title || seen.has(rawUrl) || title.length < 5) continue;
    seen.add(rawUrl);
    results.push({
      title:   title.substring(0, 100),
      url:     rawUrl,
      snippet: (snippets[si++] || '').substring(0, 200),
      source:  'duckduckgo'
    });
  }
  return results;
}

// ── Türkçe haber — RSS feed (en güvenilir yöntem) ────────
async function _searchTurkishNews(axios, query, maxResults = 5) {
  // RSS feed'leri — scraping engeli yok, XML parse edilebilir
  const RSS_FEEDS = [
    { url: 'https://www.sabah.com.tr/rss/anasayfa.xml',      name: 'Sabah' },
    { url: 'https://www.haberturk.com/rss/tk/anasayfa.xml',  name: 'Habertürk' },
    { url: 'https://www.milliyet.com.tr/rss/rssNew/gundemRss.xml', name: 'Milliyet' },
    { url: 'https://www.cumhuriyet.com.tr/rss/son_dakika.xml', name: 'Cumhuriyet' },
    { url: 'https://www.hurriyet.com.tr/rss/anasayfa',        name: 'Hürriyet' },
  ];

  const results = [];
  const queryWords = query.toLowerCase().split(/\s+/).filter(w => w.length > 2);

  for (const feed of RSS_FEEDS) {
    if (results.length >= maxResults) break;
    try {
      const r = await axios.get(feed.url, {
        timeout: 6000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
          'Accept': 'application/rss+xml, application/xml, text/xml, */*',
        }
      });
      const xml = r.data || '';

      // RSS item'larını çek
      const itemRegex = /<item>([\s\S]*?)<\/item>/gi;
      const items = [...xml.matchAll(itemRegex)];

      for (const item of items) {
        if (results.length >= maxResults) break;
        const body = item[1];

        // Başlık
        const titleMatch = body.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/i);
        const title = titleMatch ? _stripTags(titleMatch[1]).trim() : '';
        if (!title) continue;

        // Link
        const linkMatch = body.match(/<link>([\s\S]*?)<\/link>/i)
          || body.match(/<guid[^>]*>(https?[^<]+)<\/guid>/i);
        const url = linkMatch ? linkMatch[1].trim() : '';

        // Açıklama
        const descMatch = body.match(/<description>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/description>/i);
        const snippet = descMatch ? _stripTags(descMatch[1]).trim().substring(0, 200) : '';

        // Sorguyla ilgili mi? (genel haber sorgusu veya keyword eşleşmesi)
        const isGeneral = /son\s*dakika|gündem|haber|gelişme/i.test(query);
        const titleLower = title.toLowerCase();
        const relevant = isGeneral || queryWords.some(w => titleLower.includes(w));
        if (!relevant) continue;

        results.push({ title, url, snippet, source: feed.name });
      }
    } catch (e) {
      // Bu feed çalışmadıysa diğerine geç
    }
  }

  return results;
}

// ── Google scraping (fallback) ────────────────────────────
async function _searchGoogle(axios, query, maxResults = 5) {
  const url = `https://www.google.com/search?q=${encodeURIComponent(query)}&hl=tr&num=${maxResults}`;

  const r = await axios.get(url, {
    timeout: 8000,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0 Safari/537.36',
      'Accept-Language': 'tr-TR,tr;q=0.9',
    }
  });

  const results = [];
  const html    = r.data || '';

  // Google sonuç başlık + URL
  const titleRegex   = /<h3[^>]*>([\s\S]*?)<\/h3>/gi;
  const urlRegex     = /<a[^>]+href="\/url\?q=([^&"]+)[^"]*"[^>]*>/gi;
  const snippetRegex = /<div[^>]*class="[^"]*VwiC3b[^"]*"[^>]*>([\s\S]*?)<\/div>/gi;

  const titles   = [...html.matchAll(titleRegex)].map(m => _stripTags(m[1]));
  const urls     = [...html.matchAll(urlRegex)].map(m => {
    try { return decodeURIComponent(m[1]); } catch { return m[1]; }
  }).filter(u => u.startsWith('http') && !u.includes('google.com'));
  const snippets = [...html.matchAll(snippetRegex)].map(m => _stripTags(m[1]).substring(0, 200));

  for (let i = 0; i < Math.min(urls.length, maxResults, titles.length); i++) {
    if (urls[i] && titles[i]) {
      results.push({
        title:   titles[i].substring(0, 100),
        url:     urls[i],
        snippet: snippets[i] || '',
        source:  'google'
      });
    }
  }

  return results;
}

// ── Sayfa içeriği çek (tek URL) ───────────────────────────
async function _fetchPageContent(axios, url, maxChars = 2000) {
  try {
    const r = await axios.get(url, {
      timeout: 6000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept-Language': 'tr-TR,tr;q=0.9',
      }
    });

    const html = r.data || '';
    // Script/style/nav temizle
    const clean = html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<nav[\s\S]*?<\/nav>/gi, '')
      .replace(/<footer[\s\S]*?<\/footer>/gi, '')
      .replace(/<header[\s\S]*?<\/header>/gi, '');

    return _stripTags(clean).substring(0, maxChars);
  } catch (_) {
    return null;
  }
}

// ── Ana arama fonksiyonu ──────────────────────────────────
async function search(axios, query, options = {}) {
  const {
    maxResults   = 5,
    fetchContent = false,   // ilk sonucun içeriğini çek
    forceRefresh = false,
  } = options;

  if (!query) return [];

  // Cache kontrolü
  const cacheKey = `${query}:${maxResults}`;
  if (!forceRefresh && _cache.has(cacheKey)) {
    const cached = _cache.get(cacheKey);
    if (Date.now() - cached.ts < CACHE_TTL_MS) {
      console.log(`[WebSearch] 💾 Cache hit: "${query.substring(0, 40)}"`);
      return cached.results;
    }
  }

  let results = [];

  // 1. DuckDuckGo JSON API + HTML
  try {
    results = await _searchDuckDuckGo(axios, query, maxResults);
    console.log(`[WebSearch] 🦆 DuckDuckGo: ${results.length} sonuç — "${query.substring(0, 40)}"`);
  } catch (e) {
    console.warn(`[WebSearch] DuckDuckGo başarısız: ${e.message}`);
  }

  // 2. Türkçe haber sorgusu + sonuç yok → haber sitelerini dene
  const isNewsQuery = /haber|son dakika|gündem|bugün|gelişme/i.test(query);
  if (results.length === 0 && isNewsQuery) {
    try {
      results = await _searchTurkishNews(axios, query, maxResults);
      console.log(`[WebSearch] 📰 Haber scraping: ${results.length} sonuç — "${query.substring(0, 40)}"`);
    } catch (e) {
      console.warn(`[WebSearch] Haber scraping başarısız: ${e.message}`);
    }
  }

  // 3. Hâlâ sonuç yok → Google dene
  if (results.length === 0) {
    try {
      results = await _searchGoogle(axios, query, maxResults);
      console.log(`[WebSearch] 🔍 Google: ${results.length} sonuç — "${query.substring(0, 40)}"`);
    } catch (e) {
      console.warn(`[WebSearch] Google başarısız: ${e.message}`);
    }
  }

  // İlk sonucun içeriğini çek (istenirse)
  if (fetchContent && results.length > 0) {
    const content = await _fetchPageContent(axios, results[0].url);
    if (content) results[0].content = content;
  }

  // Cache'e kaydet
  if (results.length > 0) {
    _cache.set(cacheKey, { results, ts: Date.now() });
  }

  // Geçmişe ekle
  _history.unshift({ query, resultCount: results.length, ts: new Date().toISOString() });
  if (_history.length > 20) _history.pop();

  return results;
}

// ── LLM için arama bağlamı ────────────────────────────────
function buildSearchContext(results, query) {
  if (!results || results.length === 0) return null;

  const lines = results.slice(0, 4).map((r, i) =>
    `[${i + 1}] ${r.title}\n    ${r.snippet || 'snippet yok'}\n    URL: ${r.url}`
  ).join('\n\n');

  return `=== WEB ARAŞTIRMASI: "${query}" ===\n${lines}\n\nYukarıdaki güncel web sonuçlarını dikkate alarak cevap ver.`;
}

// ── Sorgu konuyla ilgili mi? (basit keyword check) ────────
function _needsWebSearch(message) {
  const triggers = [
    'bugün', 'şu an', 'şimdi', 'son dakika', 'haberler', 'haber',
    'güncel', 'son', 'yeni', 'kaç', 'fiyat', 'dolar', 'euro',
    'hava durumu', 'nerede', 'kim', 'ne zaman', 'nasıl yapılır',
    'tarif', 'film', 'dizi', 'sonuç', 'maç', 'skor', 'nüfus',
    'başkent', 'başkan', 'cumhurbaşkanı', 'bakan'
  ];
  const lower = message.toLowerCase();
  return triggers.some(t => lower.includes(t));
}

// ── Mount ──────────────────────────────────────────────────
function mountWebSearch(app, brain, axios) {
  if (!app || !axios) {
    console.warn('[WebSearch] ⚠️ Eksik parametre, mount atlandı.');
    return;
  }

  // ── Brain enrichPrompt'una web arama entegre et ───────
  // Sadece "güncel bilgi" gerektiren sorularda otomatik arama yapar
  const _originalEnrich = brain?.enrichPrompt?.bind(brain);
  if (_originalEnrich) {
    brain.enrichPrompt = function (userPrompt) {
      // Bu fonksiyon sync olması gerekiyor,
      // web arama async — bu yüzden enrichPrompt'u değil
      // /ollama/ask içinde ayrıca çağırıyoruz.
      // Burası sadece orijinali çağırır.
      return _originalEnrich(userPrompt);
    };
  }

  // ────────────────────────────────────────────────────────
  // POST /search — Doğrudan web arama
  // Body: { query, maxResults?, fetchContent? }
  // ────────────────────────────────────────────────────────
  app.post('/search', async (req, res) => {
    const { query, maxResults = 5, fetchContent = false } = req.body;
    if (!query) return res.json({ status: 'error', message: 'query gerekli' });

    try {
      const results = await search(axios, query, { maxResults, fetchContent });
      // Brain hafızasına kaydet
      if (results.length > 0) {
        brain?.mem?.remember?.(
          `web_search:${query.substring(0, 50)}`,
          results.map(r => r.title).join(' | ').substring(0, 200),
          0.6
        );
      }
      res.json({ status: 'success', query, results, count: results.length });
    } catch (e) {
      res.json({ status: 'error', message: e.message });
    }
  });

  // ────────────────────────────────────────────────────────
  // POST /search/ask — Ara + Ollama ile cevapla
  // Body: { question, model?, sessionId? }
  // ────────────────────────────────────────────────────────
  app.post('/search/ask', async (req, res) => {
    const {
      question,
      model      = process.env.OLLAMA_MODEL || 'llama3.1:8b',
      sessionId  = 'search_default',
    } = req.body;

    if (!question) return res.json({ status: 'error', message: 'question gerekli' });

    try {
      // 0. Hava durumu sorusu mu? Özel handle
      const weatherMatch = question.match(/hava\s*durumu\s*([a-zA-ZçğışöüÇĞİŞÖÜ\s]+)/i)
        || question.match(/([a-zA-ZçğışöüÇĞİŞÖÜ\s]+)\s*hava/i);
      if (weatherMatch) {
        const city = (weatherMatch[1] || 'Istanbul').trim();
        try {
          const weather = await _getWeather(axios, city);
          if (weather) {
            const weatherCtx = `=== GÜNCEL HAVA DURUMU: ${city} ===\n` +
              `Sıcaklık: ${weather.temp_c}°C (Hissedilen: ${weather.feels_like}°C)\n` +
              `Durum: ${weather.description}\n` +
              `Nem: ${weather.humidity}% | Rüzgar: ${weather.wind_kmph} km/s | Görüş: ${weather.visibility} km`;
            const brainCtx = brain?.enrichPrompt?.(question) ?? question;
            const r2 = await axios.post('http://localhost:11434/api/chat', {
              model, stream: false,
              messages: [
                { role: 'system', content: 'Sen güncel hava durumu verilerine erişimi olan bir asistansın. Türkçe cevap ver.' },
                { role: 'user',   content: weatherCtx + '\n\n' + question }
              ]
            }, { timeout: 30000 });
            const ans = r2.data?.message?.content || '';
            brain?.learn?.(question, ans);
            return res.json({ status: 'success', question, answer: ans, sources: [{ title: `wttr.in - ${city}`, url: `https://wttr.in/${city}` }], searched: true, weather });
          }
        } catch (_) {}
      }

      // 1. Ara
      const results = await search(axios, question, { maxResults: 4, fetchContent: false });

      // 2. Bağlam oluştur
      const searchCtx = buildSearchContext(results, question);

      // 3. Brain enrichPrompt
      const brainCtx = brain?.enrichPrompt?.(question) ?? question;

      // 4. Tam prompt
      const fullPrompt = searchCtx
        ? `${searchCtx}\n\n${brainCtx}`
        : brainCtx;

      // 5. Ollama'ya gönder
      const r = await axios.post('http://localhost:11434/api/chat', {
        model,
        stream: false,
        messages: [
          { role: 'system', content: 'Sen güncel web verilerine erişimi olan, yardımcı bir Türkçe asistansın.' },
          { role: 'user',   content: fullPrompt }
        ]
      }, { timeout: 60000 });

      const answer = r.data?.message?.content || '';

      // 6. Brain'e öğret
      brain?.learn?.(question, answer);

      res.json({
        status:   'success',
        question,
        answer,
        sources:  results.map(r => ({ title: r.title, url: r.url })),
        searched: results.length > 0,
      });

    } catch (e) {
      res.json({ status: 'error', message: e.message });
    }
  });

  // ────────────────────────────────────────────────────────
  // POST /search/auto — Otomatik arama kararı
  // Soruya bakıp "güncel bilgi lazım mı?" karar verir
  // Body: { message, sessionId? }
  // ────────────────────────────────────────────────────────
  app.post('/search/auto', async (req, res) => {
    const { message, sessionId = 'auto_search' } = req.body;
    if (!message) return res.json({ status: 'error', message: 'message gerekli' });

    const needsSearch = _needsWebSearch(message);

    if (!needsSearch) {
      // Arama gerekmez, direkt Ollama
      try {
        const enriched = brain?.enrichPrompt?.(message) ?? message;
        const r = await axios.post('http://localhost:11434/api/chat', {
          model:  process.env.OLLAMA_MODEL || 'llama3.1:8b',
          stream: false,
          messages: [{ role: 'user', content: enriched }]
        }, { timeout: 60000 });
        const answer = r.data?.message?.content || '';
        brain?.learn?.(message, answer);
        return res.json({ status: 'success', answer, searched: false });
      } catch (e) {
        return res.json({ status: 'error', message: e.message });
      }
    }

    // Arama gerekiyor
    req.body.question = message;
    return app._router.handle(
      { ...req, url: '/search/ask', path: '/search/ask' },
      res,
      () => {}
    );
  });

  // ────────────────────────────────────────────────────────
  // GET /weather/:city — Hava durumu (wttr.in, ücretsiz)
  // ────────────────────────────────────────────────────────
  app.get('/weather/:city', async (req, res) => {
    const city = req.params.city || _state?.current?.city || 'Istanbul';
    try {
      const weather = await _getWeather(axios, city);
      if (!weather) return res.json({ status: 'error', message: 'Hava durumu alınamadı' });

      // Brain'e kaydet
      brain?.mem?.remember?.(`weather:${city}`, JSON.stringify(weather), 0.6);

      const desc = `${city}: ${weather.temp_c}°C, ${weather.description}, Nem: ${weather.humidity}%, Rüzgar: ${weather.wind_kmph}km/s`;
      res.json({ status: 'success', weather, description: desc });
    } catch (e) {
      res.json({ status: 'error', message: e.message });
    }
  });

  // ────────────────────────────────────────────────────────
  // POST /search/ask içinde hava durumu özel handling
  // ────────────────────────────────────────────────────────

  // ────────────────────────────────────────────────────────
  // GET /search/history — Arama geçmişi
  // ────────────────────────────────────────────────────────
  app.get('/search/history', (req, res) => {
    res.json({ status: 'success', history: _history });
  });

  // ────────────────────────────────────────────────────────
  // DELETE /search/cache — Cache temizle
  // ────────────────────────────────────────────────────────
  app.delete('/search/cache', (req, res) => {
    const count = _cache.size;
    _cache.clear();
    res.json({ status: 'success', cleared: count });
  });

  // ────────────────────────────────────────────────────────
  // GET /search/status
  // ────────────────────────────────────────────────────────
  app.get('/search/status', (req, res) => {
    res.json({
      status:       'success',
      cacheSize:    _cache.size,
      historyCount: _history.length,
      recentSearches: _history.slice(0, 5),
    });
  });

  console.log('[WebSearch] 🌐 v1 yüklendi. Endpoint\'ler:');
  console.log('  POST /search          → web ara {query}');
  console.log('  POST /search/ask      → ara + Ollama cevapla {question}');
  console.log('  POST /search/auto     → otomatik karar {message}');
  console.log('  GET  /search/history  → arama geçmişi');
  console.log('  GET  /search/status   → durum');

  return { search, buildSearchContext };
}

module.exports = { mountWebSearch, search, buildSearchContext };

// ── Hava durumu (wttr.in — ücretsiz, key yok) ─────────────
// Bu fonksiyon mountWebSearch içine otomatik eklenir
async function _getWeather(axios, city) {
  const url = `https://wttr.in/${encodeURIComponent(city)}?format=j1&lang=tr`;
  const r   = await axios.get(url, { timeout: 6000, headers: { 'User-Agent': 'KaanAI/1.0' } });
  const d   = r.data?.current_condition?.[0];
  if (!d) return null;
  return {
    city,
    temp_c:      d.temp_C,
    feels_like:  d.FeelsLikeC,
    humidity:    d.humidity,
    wind_kmph:   d.windspeedKmph,
    description: d.weatherDesc?.[0]?.value || '',
    visibility:  d.visibility,
  };
}