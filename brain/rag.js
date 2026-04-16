// ============================================================
// 📚 brain/rag.js — Retrieval Augmented Generation Sistemi v1
// PDF, TXT, DOCX, MD dosyalarını parçalara böler, brain hafızasına gömer
// /ollama/ask endpoint'i otomatik olarak RAG bağlamını ekler
//
// server.js'e ekle:
//   const rag = require('./brain/rag');
//   app.post('/rag/upload', rag.uploadEndpoint(upload));
//   app.post('/rag/ask', rag.askEndpoint);
//   app.get('/rag/docs', rag.listDocs);
//   app.delete('/rag/doc/:docId', rag.deleteDoc);
// ============================================================

const fs        = require('fs');
const path      = require('path');
const mem       = require('./memory');

// ── Opsiyonel PDF parser ───────────────────────────────────
let pdfParse;
try { pdfParse = require('pdf-parse'); } catch(e) { pdfParse = null; }

// ── Opsiyonel DOCX reader ──────────────────────────────────
let mammoth;
try { mammoth = require('mammoth'); } catch(e) { mammoth = null; }

// ── Doküman meta kayıt dosyası ─────────────────────────────
const DOC_INDEX_FILE = path.join(__dirname, '..', 'rag_docs.json');

function loadDocIndex() {
  try {
    if (fs.existsSync(DOC_INDEX_FILE)) {
      return JSON.parse(fs.readFileSync(DOC_INDEX_FILE, 'utf-8'));
    }
  } catch(e) {}
  return [];
}

function saveDocIndex(docs) {
  fs.writeFileSync(DOC_INDEX_FILE, JSON.stringify(docs, null, 2), 'utf-8');
}

// ── Metni parçalara böl (chunk) ────────────────────────────
// Overlap: her chunk sonraki chunk'ın başını da içeriyor → bağlam kopmuyor
function chunkText(text, chunkSize = 500, overlap = 80) {
  const chunks = [];
  let start = 0;
  const clean = text.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();

  while (start < clean.length) {
    let end = start + chunkSize;

    // Kelime ortasında kesmemek için boşluk/satır sonu ara
    if (end < clean.length) {
      const breakAt = clean.lastIndexOf('\n', end);
      if (breakAt > start + chunkSize * 0.5) {
        end = breakAt;
      } else {
        const spaceAt = clean.lastIndexOf(' ', end);
        if (spaceAt > start + chunkSize * 0.5) end = spaceAt;
      }
    }

    const chunk = clean.slice(start, end).trim();
    if (chunk.length > 20) chunks.push(chunk);
    start = end - overlap;
    if (start <= 0 || start >= clean.length - 10) break;
  }

  return chunks;
}

// ── Dosyadan metin çıkar ───────────────────────────────────
async function extractText(filePath, mimeType) {
  const ext = path.extname(filePath).toLowerCase();

  // PDF
  if (ext === '.pdf' || mimeType === 'application/pdf') {
    if (!pdfParse) throw new Error('pdf-parse kurulu değil. npm install pdf-parse yapın.');
    const buf = fs.readFileSync(filePath);
    const data = await pdfParse(buf);
    return data.text;
  }

  // DOCX
  if (ext === '.docx' || mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
    if (!mammoth) throw new Error('mammoth kurulu değil. npm install mammoth yapın.');
    const result = await mammoth.extractRawText({ path: filePath });
    return result.value;
  }

  // TXT / MD / CSV — düz metin
  if (['.txt', '.md', '.csv', '.js', '.ts', '.py', '.json'].includes(ext)) {
    return fs.readFileSync(filePath, 'utf-8');
  }

  throw new Error(`Desteklenmeyen dosya türü: ${ext}`);
}

// ── Dokümanı brain hafızasına göm ─────────────────────────
async function ingestDocument(filePath, originalName, mimeType = '') {
  const docs   = loadDocIndex();
  const docId  = `doc_${Date.now()}`;
  const text   = await extractText(filePath, mimeType);
  const chunks = chunkText(text);

  if (chunks.length === 0) throw new Error('Dosyadan metin çıkarılamadı veya dosya boş.');

  // Her chunk'ı brain hafızasına yaz
  const chunkKeys = [];
  chunks.forEach((chunk, i) => {
    const key = `rag:${docId}:chunk_${i}`;
    mem.remember(key, chunk, 0.85);
    chunkKeys.push(key);
  });

  // Doküman indexine ekle
  const docEntry = {
    docId,
    name:       originalName,
    filePath,
    chunkCount: chunks.length,
    chunkKeys,
    uploadedAt: new Date().toISOString(),
    textLength: text.length
  };
  docs.push(docEntry);
  saveDocIndex(docs);

  console.log(`[RAG] 📚 "${originalName}" yüklendi — ${chunks.length} parça hafızaya eklendi`);
  return docEntry;
}

// ── Soruya göre en ilgili chunk'ları getir ─────────────────
function retrieveChunks(query, topN = 5) {
  // brain.mem.recall zaten skor+decay hesaplıyor, rag: prefix ile filtrele
  const all      = mem.getAll().semanticMemory;
  const ragItems = all.filter(e => e.key.startsWith('rag:'));

  if (ragItems.length === 0) return [];

  const words = query.toLowerCase().split(/\s+/).filter(w => w.length > 2);

  const scored = ragItems.map(e => {
    const haystack = String(e.value).toLowerCase();
    let score = 0;
    words.forEach(w => { if (haystack.includes(w)) score += 1; });
    if (haystack.includes(query.toLowerCase())) score += 3;
    return { entry: e, score };
  })
  .filter(x => x.score > 0)
  .sort((a, b) => b.score - a.score)
  .slice(0, topN)
  .map(x => x.entry.value);

  return scored;
}

// ── Soru için RAG bağlamı oluştur ─────────────────────────
function buildRagContext(query) {
  const chunks = retrieveChunks(query, 4);
  if (chunks.length === 0) return null;

  const context = chunks.map((c, i) => `[Parça ${i+1}]\n${c}`).join('\n\n---\n\n');
  return `=== YÜKLENEN DOKÜMANLARDAN İLGİLİ BİLGİLER ===\n${context}\n\n` +
         `Yukarıdaki bilgileri kullanarak soruyu cevapla. Bilgi yetersizse bunu belirt.`;
}

// ── Doküman listesi ────────────────────────────────────────
function getDocList() {
  return loadDocIndex().map(d => ({
    docId:     d.docId,
    name:      d.name,
    chunkCount: d.chunkCount,
    uploadedAt: d.uploadedAt,
    textLength: d.textLength
  }));
}

// ── Doküman sil ───────────────────────────────────────────
function deleteDocument(docId) {
  let docs = loadDocIndex();
  const doc = docs.find(d => d.docId === docId);
  if (!doc) throw new Error('Doküman bulunamadı');

  // Hafızadan chunk'ları sil
  const all = mem.getAll();
  all.semanticMemory = all.semanticMemory.filter(e => !e.key.startsWith(`rag:${docId}:`));

  // Index'ten sil
  docs = docs.filter(d => d.docId !== docId);
  saveDocIndex(docs);

  console.log(`[RAG] 🗑️ "${doc.name}" silindi`);
  return doc.name;
}

// ── Express endpoint factory'leri ─────────────────────────
// multer instance server.js'ten gelecek
function uploadEndpoint(upload) {
  return async (req, res) => {
    try {
      if (!req.file) return res.json({ status: 'error', message: 'Dosya gönderilmedi' });
      const doc = await ingestDocument(req.file.path, req.file.originalname, req.file.mimetype);
      res.json({
        status:  'success',
        message: `"${doc.name}" başarıyla yüklendi — ${doc.chunkCount} parça işlendi`,
        doc
      });
    } catch(e) {
      res.json({ status: 'error', message: e.message });
    }
  };
}

// RAG destekli soru-cevap (Ollama'ya gönderir)
function askEndpoint(axios, ollamaModel) {
  return async (req, res) => {
    const { question, sessionId = 'rag-default' } = req.body;
    if (!question) return res.json({ status: 'error', message: 'question gerekli' });

    const ragContext = buildRagContext(question);
    if (!ragContext) {
      return res.json({
        status:  'success',
        answer:  'Yüklü dokümanlar arasında bu soruyla ilgili bir bilgi bulunamadı. Önce bir PDF veya metin yükleyin.',
        fromRag: false
      });
    }

    const fullPrompt = `${ragContext}\n\n=== SORU ===\n${question}`;
    try {
      const r = await axios.post('http://localhost:11434/api/chat', {
        model:  ollamaModel || 'llama3.1:8b',
        stream: false,
        messages: [
          { role: 'system', content: 'Sen yüklenen dokümanlara dayalı soru cevaplayan bir asistansın. Sadece Türkçe cevap ver.' },
          { role: 'user',   content: fullPrompt }
        ]
      });
      const answer = r.data.message.content;
      res.json({ status: 'success', answer, fromRag: true, chunksUsed: retrieveChunks(question, 4).length });
    } catch(e) {
      res.json({ status: 'error', message: 'Ollama bağlantısı kurulamadı: ' + e.message });
    }
  };
}

function listDocs(req, res) {
  res.json({ status: 'success', docs: getDocList() });
}

function deleteDocEndpoint(req, res) {
  try {
    const name = deleteDocument(req.params.docId);
    res.json({ status: 'success', message: `"${name}" silindi` });
  } catch(e) {
    res.json({ status: 'error', message: e.message });
  }
}

module.exports = {
  ingestDocument,
  retrieveChunks,
  buildRagContext,
  getDocList,
  deleteDocument,
  uploadEndpoint,
  askEndpoint,
  listDocs,
  deleteDoc: deleteDocEndpoint
};