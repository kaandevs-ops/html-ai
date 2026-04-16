// ============================================================
// 🚀 projectLauncher.js — Proje Başlatıcı v1.0
//
// Mevcut hiçbir dosyaya dokunmaz.
// server.js'in EN SONUNA şunu ekle:
//
//   const { mountProjectLauncher } = require('./projectLauncher');
//   mountProjectLauncher(app, brain, axios, { exec, fs, path, isMac, isWindows, isLinux });
//
// Desteklenen proje türleri:
//   react       → Vite + React + Tailwind şablonu
//   node        → Express API şablonu
//   python      → Flask veya script şablonu
//   nextjs      → Next.js App Router şablonu
//   vanilla     → HTML + CSS + JS şablonu
//   custom      → Ollama ile LLM'den yapı üretir
//
// Her proje:
//   ✅ Klasör oluşturulur
//   ✅ Temel dosyalar yazılır
//   ✅ npm/pip install çalıştırılır
//   ✅ git init + ilk commit atılır
//   ✅ VS Code / Cursor ile açılır
//   ✅ Brain hafızasına kaydedilir
// ============================================================

'use strict';

// ── Proje şablonları ───────────────────────────────────────
const TEMPLATES = {

  react: (name, desc) => ({
    files: [
      {
        path: 'index.html',
        content: `<!DOCTYPE html>
<html lang="tr">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${name}</title>
</head>
<body>
  <div id="root"></div>
  <script type="module" src="/src/main.jsx"></script>
</body>
</html>`
      },
      {
        path: 'vite.config.js',
        content: `import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
export default defineConfig({ plugins: [react()] })`
      },
      {
        path: 'package.json',
        content: JSON.stringify({
          name: name.toLowerCase().replace(/\s+/g, '-'),
          version: '0.1.0',
          private: true,
          scripts: { dev: 'vite', build: 'vite build', preview: 'vite preview' },
          dependencies: { react: '^18.2.0', 'react-dom': '^18.2.0' },
          devDependencies: { '@vitejs/plugin-react': '^4.0.0', vite: '^5.0.0' }
        }, null, 2)
      },
      {
        path: 'src/main.jsx',
        content: `import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
ReactDOM.createRoot(document.getElementById('root')).render(<React.StrictMode><App /></React.StrictMode>)`
      },
      {
        path: 'src/App.jsx',
        content: `import React, { useState } from 'react'

export default function App() {
  const [count, setCount] = useState(0)
  return (
    <div style={{ padding: 40, fontFamily: 'sans-serif' }}>
      <h1>${name}</h1>
      <p>${desc || 'KaanAI tarafından oluşturuldu.'}</p>
      <button onClick={() => setCount(c => c + 1)}>Sayaç: {count}</button>
    </div>
  )
}`
      },
      {
        path: 'README.md',
        content: `# ${name}\n\n${desc || ''}\n\n## Başlat\n\n\`\`\`bash\nnpm install\nnpm run dev\n\`\`\`\n\n> KaanAI tarafından oluşturuldu.`
      }
    ],
    installCmd: 'npm install',
    devCmd:     'npm run dev',
  }),

  node: (name, desc) => ({
    files: [
      {
        path: 'package.json',
        content: JSON.stringify({
          name: name.toLowerCase().replace(/\s+/g, '-'),
          version: '1.0.0',
          main: 'index.js',
          scripts: { start: 'node index.js', dev: 'node --watch index.js' },
          dependencies: { express: '^4.18.0', dotenv: '^16.0.0' }
        }, null, 2)
      },
      {
        path: 'index.js',
        content: `require('dotenv').config();
const express = require('express');
const app     = express();
const PORT    = process.env.PORT || 3001;

app.use(express.json());

app.get('/', (req, res) => {
  res.json({ status: 'ok', app: '${name}', ts: new Date().toISOString() });
});

// Buraya route'larını ekle
// app.get('/api/...', ...);

app.listen(PORT, () => {
  console.log(\`🚀 ${name} http://localhost:\${PORT}\`);
});`
      },
      {
        path: '.env',
        content: `PORT=3001\n# Buraya ortam değişkenlerini ekle`
      },
      {
        path: '.gitignore',
        content: `node_modules/\n.env\n*.log`
      },
      {
        path: 'README.md',
        content: `# ${name}\n\n${desc || ''}\n\n## Başlat\n\n\`\`\`bash\nnpm install\nnpm start\n\`\`\`\n\n> KaanAI tarafından oluşturuldu.`
      }
    ],
    installCmd: 'npm install',
    devCmd:     'npm start',
  }),

  python: (name, desc) => ({
    files: [
      {
        path: 'app.py',
        content: `from flask import Flask, jsonify
import os

app = Flask(__name__)

@app.route('/')
def index():
    return jsonify({'status': 'ok', 'app': '${name}'})

# Buraya route'larını ekle
# @app.route('/api/...')

if __name__ == '__main__':
    port = int(os.getenv('PORT', 5000))
    print(f'🚀 ${name} http://localhost:{port}')
    app.run(debug=True, port=port)`
      },
      {
        path: 'requirements.txt',
        content: `flask==3.0.0\npython-dotenv==1.0.0`
      },
      {
        path: '.env',
        content: `PORT=5000\n# Buraya ortam değişkenlerini ekle`
      },
      {
        path: '.gitignore',
        content: `__pycache__/\n*.pyc\n.env\nvenv/\n.venv/`
      },
      {
        path: 'README.md',
        content: `# ${name}\n\n${desc || ''}\n\n## Başlat\n\n\`\`\`bash\npip install -r requirements.txt\npython app.py\n\`\`\`\n\n> KaanAI tarafından oluşturuldu.`
      }
    ],
    installCmd: 'pip3 install -r requirements.txt',
    devCmd:     'python3 app.py',
  }),

  nextjs: (name, desc) => ({
    files: [
      {
        path: 'package.json',
        content: JSON.stringify({
          name: name.toLowerCase().replace(/\s+/g, '-'),
          version: '0.1.0',
          private: true,
          scripts: { dev: 'next dev', build: 'next build', start: 'next start' },
          dependencies: { next: '^14.0.0', react: '^18.2.0', 'react-dom': '^18.2.0' }
        }, null, 2)
      },
      {
        path: 'app/page.js',
        content: `export default function Home() {
  return (
    <main style={{ padding: 40, fontFamily: 'sans-serif' }}>
      <h1>${name}</h1>
      <p>${desc || 'KaanAI tarafından oluşturuldu.'}</p>
    </main>
  )
}`
      },
      {
        path: 'app/layout.js',
        content: `export const metadata = { title: '${name}', description: '${desc || ''}' }
export default function RootLayout({ children }) {
  return (<html lang="tr"><body>{children}</body></html>)
}`
      },
      {
        path: '.gitignore',
        content: `node_modules/\n.next/\n.env*\n*.log`
      },
      {
        path: 'README.md',
        content: `# ${name}\n\n${desc || ''}\n\n## Başlat\n\n\`\`\`bash\nnpm install\nnpm run dev\n\`\`\`\n\n> KaanAI tarafından oluşturuldu.`
      }
    ],
    installCmd: 'npm install',
    devCmd:     'npm run dev',
  }),

  vanilla: (name, desc) => ({
    files: [
      {
        path: 'index.html',
        content: `<!DOCTYPE html>
<html lang="tr">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${name}</title>
  <link rel="stylesheet" href="style.css" />
</head>
<body>
  <div class="container">
    <h1>${name}</h1>
    <p>${desc || 'KaanAI tarafından oluşturuldu.'}</p>
  </div>
  <script src="app.js"></script>
</body>
</html>`
      },
      {
        path: 'style.css',
        content: `* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: 'Segoe UI', sans-serif; background: #0f0f1a; color: #e0e0e0; }
.container { max-width: 900px; margin: 60px auto; padding: 0 20px; }
h1 { color: #a78bfa; margin-bottom: 16px; }`
      },
      {
        path: 'app.js',
        content: `// ${name} — ${desc || 'Uygulama kodu'}
console.log('${name} başlatıldı');`
      },
      {
        path: 'README.md',
        content: `# ${name}\n\n${desc || ''}\n\n## Başlat\n\nindex.html dosyasını tarayıcıda aç.\n\n> KaanAI tarafından oluşturuldu.`
      }
    ],
    installCmd: null,
    devCmd:     null,
  }),
};

// ── Yardımcılar ───────────────────────────────────────────
function _slugify(name) {
  return name.toLowerCase()
    .replace(/[ğ]/g, 'g').replace(/[ü]/g, 'u').replace(/[ş]/g, 's')
    .replace(/[ı]/g, 'i').replace(/[ö]/g, 'o').replace(/[ç]/g, 'c')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

// ── Proje oluştur ─────────────────────────────────────────
async function createProject(options, deps) {
  const { exec, fs, path, isMac, isWindows, isLinux, axios, brain } = deps;
  const {
    name,
    type       = 'node',
    description = '',
    outputDir  = process.cwd(),
    openEditor  = true,
    editor      = 'vscode',   // vscode | cursor
    gitInit     = true,
  } = options;

  if (!name) throw new Error('Proje adı gerekli');

  const slug      = _slugify(name);
  const projPath  = path.join(outputDir, slug);

  console.log(`[ProjectLauncher] 🚀 "${name}" (${type}) → ${projPath}`);

  // 1. Klasörü oluştur
  if (!fs.existsSync(projPath)) {
    fs.mkdirSync(projPath, { recursive: true });
  }

  // 2. Şablon seç — custom ise Ollama'dan üret
  let template;
  if (type === 'custom' && axios) {
    template = await _buildCustomTemplate(name, description, axios);
  } else {
    const tmplFn = TEMPLATES[type] || TEMPLATES.node;
    template = tmplFn(name, description);
  }

  // 3. Dosyaları yaz
  const log = [];
  for (const file of template.files) {
    const filePath = path.join(projPath, file.path);
    const dir      = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, file.content, 'utf8');
    log.push(`✅ ${file.path}`);
    console.log(`[ProjectLauncher]   ${file.path} yazıldı`);
  }

  // 4. npm / pip install
  if (template.installCmd) {
    console.log(`[ProjectLauncher] 📦 Bağımlılıklar yükleniyor: ${template.installCmd}`);
    await _runCmd(template.installCmd, projPath, exec);
    log.push(`📦 ${template.installCmd} tamamlandı`);
  }

  // 5. git init + ilk commit
  if (gitInit) {
    try {
      await _runCmd('git init && git add . && git commit -m "feat: KaanAI başlangıç commit"', projPath, exec);
      log.push('🔀 git init + ilk commit');
      console.log('[ProjectLauncher] 🔀 git init tamamlandı');
    } catch (e) {
      console.warn('[ProjectLauncher] ⚠️ git init hatası:', e.message.slice(0, 60));
    }
  }

  // 6. Editörde aç
  if (openEditor) {
    await _openInEditor(projPath, editor, isMac, isWindows, isLinux, exec);
    log.push(`💻 ${editor} açıldı`);
  }

  // 7. Brain'e kaydet
  if (brain) {
    try {
      brain.mem.remember(`project:${slug}`, `${type}: ${description}`, 0.85);
      brain.learn(`${name} projesi oluşturuldu`, `Proje: ${type}, yol: ${projPath}`);
    } catch (e) {}
  }

  const result = {
    name,
    slug,
    type,
    path: projPath,
    files: template.files.map(f => f.path),
    devCmd: template.devCmd,
    log,
    createdAt: new Date().toISOString(),
  };

  console.log(`[ProjectLauncher] ✅ "${name}" hazır → ${projPath}`);
  return result;
}

// ── Editörde aç ───────────────────────────────────────────
async function _openInEditor(projPath, editor, isMac, isWindows, isLinux, exec) {
  let cmd;
  const safeP = `"${projPath}"`;

  if (editor === 'cursor') {
    if (isMac)     cmd = `open -a Cursor ${safeP}`;
    else           cmd = `cursor ${safeP}`;
  } else {
    // VS Code
    cmd = `code ${safeP}`;
  }

  await _runCmd(cmd, process.cwd(), exec).catch(e => {
    console.warn(`[ProjectLauncher] ⚠️ Editör açılamadı: ${e.message.slice(0, 60)}`);
  });
}

// ── Terminalde komut çalıştır (promise) ───────────────────
function _runCmd(cmd, cwd, exec) {
  return new Promise((resolve, reject) => {
    exec(cmd, { cwd, timeout: 120000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error((stderr || err.message).slice(0, 200)));
      resolve((stdout || '').trim());
    });
  });
}

// ── Custom şablon — Ollama ile üret ──────────────────────
async function _buildCustomTemplate(name, description, axios) {
  try {
    const r = await axios.post('http://localhost:11434/api/generate', {
      model:  process.env.OLLAMA_MODEL || 'llama3.1:8b',
      stream: false,
      prompt: `"${name}" adlı proje için gerekli dosyaları JSON olarak üret.
Açıklama: ${description}

SADECE bu formatta JSON döndür:
{"files":[{"path":"dosyaadi.js","content":"..."}],"installCmd":"npm install","devCmd":"npm start"}

Makul bir Node.js veya web projesi şablonu oluştur.`,
    });

    const raw   = (r.data?.response || '').trim();
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('JSON bulunamadı');
    return JSON.parse(match[0]);
  } catch (e) {
    console.warn('[ProjectLauncher] ⚠️ Ollama şablon hatası, node şablona dönülüyor:', e.message.slice(0, 80));
    return TEMPLATES.node(name, description);
  }
}

// ══════════════════════════════════════════════════════════
// 🔌 MOUNT
// ══════════════════════════════════════════════════════════
function mountProjectLauncher(app, brain, axios, deps = {}) {
  if (!app) {
    console.warn('[ProjectLauncher] ⚠️ app eksik, mount atlandı.');
    return;
  }

  const fullDeps = { ...deps, axios, brain };

  // ── Proje oluştur ───────────────────────────────────────
  app.post('/launcher/create', async (req, res) => {
    const {
      name,
      type        = 'node',
      description = '',
      outputDir,
      openEditor  = true,
      editor      = 'vscode',
      gitInit     = true,
    } = req.body;

    if (!name) return res.json({ status: 'error', message: 'name gerekli' });

    try {
      const result = await createProject(
        { name, type, description, outputDir, openEditor, editor, gitInit },
        fullDeps
      );
      res.json({ status: 'success', ...result });
    } catch (e) {
      res.json({ status: 'error', message: e.message });
    }
  });

  // ── Desteklenen şablonlar ──────────────────────────────
  app.get('/launcher/templates', (req, res) => {
    res.json({
      status: 'success',
      templates: Object.keys(TEMPLATES).concat('custom'),
      descriptions: {
        react:   'Vite + React 18',
        node:    'Express.js API',
        python:  'Flask API',
        nextjs:  'Next.js 14 App Router',
        vanilla: 'HTML + CSS + JS',
        custom:  'Ollama ile yapay zeka tarafından üretilir',
      }
    });
  });

  // ── Son projeleri listele (brain hafızasından) ─────────
  app.get('/launcher/projects', (req, res) => {
    try {
      const results = brain.mem.recall('project:', 10);
      const projects = results.map(r => ({
        slug:  r.key.replace('project:', ''),
        info:  r.value,
        seenAt: r.updatedAt || r.createdAt,
      }));
      res.json({ status: 'success', projects });
    } catch (e) {
      res.json({ status: 'error', message: e.message });
    }
  });

  // ── Mevcut klasörü editörde aç ────────────────────────
  app.post('/launcher/open', async (req, res) => {
    const { folderPath, editor = 'vscode' } = req.body;
    if (!folderPath) return res.json({ status: 'error', message: 'folderPath gerekli' });
    try {
      await _openInEditor(folderPath, editor, deps.isMac, deps.isWindows, deps.isLinux, deps.exec);
      res.json({ status: 'success', message: `${editor} açıldı: ${folderPath}` });
    } catch (e) {
      res.json({ status: 'error', message: e.message });
    }
  });

  console.log('[ProjectLauncher] 🔌 Mount tamamlandı.');
  console.log('  POST /launcher/create     → proje oluştur {name, type, description, openEditor}');
  console.log('  GET  /launcher/templates  → desteklenen şablonlar');
  console.log('  GET  /launcher/projects   → son projeler');
  console.log('  POST /launcher/open       → klasörü editörde aç {folderPath, editor}');

  return { createProject };
}

module.exports = { mountProjectLauncher, createProject };
