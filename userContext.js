// ============================================================
// 👤 userContext.js — Kullanıcı Bağlamı Köprüsü v1.0
//
// Orijinal hiçbir dosyaya dokunmaz.
// server.js'e sadece şunu ekle (EN SONA, autoAgent satırından SONRA):
//   const { mountUserContext } = require('./userContext');
//   mountUserContext(app, autoAgent, USER_MODEL, brain);
//
// Sağladığı özellikler:
//   ✅ USER_MODEL aktif saatleri döngüye bildirir
//   ✅ Onay gerektiren işlemler için approval queue
//   ✅ Risk toleransına göre araç filtresi
//   ✅ /user/context endpoint'i ile runtime güncelleme
// ============================================================

'use strict';

// ── Onay gerektirmeyen araçlar (her zaman izinli) ─────────
const ALWAYS_ALLOWED_TOOLS = [
  // ChatGPT / Gemini / Claude.ai tarayıcı araçları
  'chatgpt_ask', 'chatgpt_project',
  'gemini_ask', 'gemini_project',
  'claudeai_ask', 'claudeai_project',
  // Cursor / Antigravity
  'cursor_project', 'cursor_compose', 'open_in_cursor', 'collect_cursor_output',
  'antigravity_project', 'antigravity_compose', 'open_in_antigravity',
  // Kod yazma
  'write_code', 'write_and_test', 'run_and_test', 'analyze_code_file',
  'create_node_project', 'create_web_project',
  // Arama / okuma
  'search_web', 'read_url', 'summarize',
  // Uygulama araçları
  'open_vscode', 'vscode_ai_task', 'open_figma', 'figma_ai_spec',
  'word_ai_write', 'excel_ai_fill', 'ppt_ai_create', 'obsidian_ai_note',
  'screen_ai_analyze', 'app_content_ai', 'app_ai_task', 'terminal_ai',
  'spotlight_open', 'smart_open_app', 'app_type', 'app_hotkey',
  // Brain araçları
  'browser_open', 'screenshot',
];


const pendingApprovals = [];  // { id, goal, tool, args, resolve, ts }
let approvalIdCounter = 0;

// ── Aktif saat kontrolü ────────────────────────────────────
function isActiveHour(userModel) {
  const now = new Date();
  const hour = now.getHours();
  const [start, end] = userModel.dailyRoutine?.activeHours || [0, 24];
  return hour >= start && hour < end;
}

// ── Risk toleransına göre araç izni ───────────────────────
function isToolAllowed(toolName, args, userModel) {
  // Her zaman izinli araçlar — onay sorulmaz
  if (ALWAYS_ALLOWED_TOOLS.includes(toolName)) return 'allowed';

  const argsStr = JSON.stringify(args || '').toLowerCase();

  // Onay gerektiren kategoriler
  const requiresApproval = userModel.approvalRequiredFor || [];

  for (const category of requiresApproval) {
    switch (category) {
      case 'delete':
        if (/rm |rmdir|unlink|delete|sil/.test(argsStr)) return 'approval';
        break;
      case 'system_command':
        if (toolName === 'run_terminal' && /sudo|chmod|chown|systemctl|launchctl/.test(argsStr)) return 'approval';
        break;
      case 'purchase':
        if (/stripe|payment|odeme|satin/.test(argsStr)) return 'approval';
        break;
      case 'email_send':
        if (toolName === 'run_terminal' && /mail|smtp|send/.test(argsStr)) return 'approval';
        break;
    }
  }

  // Risk toleransı düşükse tehlikeli araçları engelle
  const riskTolerance = userModel.riskTolerance ?? 0.5;
  if (riskTolerance < 0.3) {
    const highRiskTools = ['run_terminal', 'create_web_project', 'create_node_project'];
    if (highRiskTools.includes(toolName) && /install|npm|pip|brew/.test(argsStr)) {
      return 'blocked';
    }
  }

  return 'allowed';
}

// ── Onay iste ─────────────────────────────────────────────
function requestApproval(goal, toolName, args) {
  return new Promise((resolve) => {
    const id = ++approvalIdCounter;
    const entry = {
      id,
      goal: (goal || '').slice(0, 100),
      tool: toolName,
      args,
      resolve,
      ts: Date.now(),
      status: 'pending'
    };
    pendingApprovals.push(entry);
    console.log(`[UserContext] ⏳ Onay bekleniyor #${id}: ${toolName} — ${goal?.slice(0, 50)}`);

    // 5 dakika timeout → otomatik reddet
    setTimeout(() => {
      const idx = pendingApprovals.findIndex(p => p.id === id && p.status === 'pending');
      if (idx !== -1) {
        pendingApprovals[idx].status = 'timeout';
        console.log(`[UserContext] ⏰ Onay zaman aşımı #${id}`);
        resolve({ approved: false, reason: 'timeout' });
      }
    }, 5 * 60 * 1000);
  });
}

// ── autonomous_agent'ı wrap et ────────────────────────────
function patchAutoAgent(autoAgent, userModel, brain) {
  if (!autoAgent || !autoAgent.AUTO_TOOLS) {
    console.warn('[UserContext] ⚠️ autoAgent.AUTO_TOOLS bulunamadı, patch atlandı.');
    return;
  }

  const tools = autoAgent.AUTO_TOOLS;

  // Her araç için wrapper ekle
  Object.keys(tools).forEach(toolName => {
    const original = tools[toolName];
    if (typeof original !== 'function') return;

    tools[toolName] = async function(args) {
      // 1. Aktif saat kontrolü
      if (!isActiveHour(userModel)) {
        if (!userModel.dailyRoutine?.idleTasksAllowed) {
          console.log(`[UserContext] 🌙 Aktif saat dışı, araç engellendi: ${toolName}`);
          return `[UserContext] Aktif saat dışında çalışma engellendi (saat: ${new Date().getHours()})`;
        }
        // idleTasksAllowed true ise sadece log
        console.log(`[UserContext] 🌙 Aktif saat dışı ama idle task izni var: ${toolName}`);
      }

      // 2. Araç izin kontrolü
      const permission = isToolAllowed(toolName, args, userModel);

      if (permission === 'blocked') {
        const msg = `[UserContext] 🚫 Araç engellendi (risk toleransı): ${toolName}`;
        console.log(msg);
        if (brain) brain.onError(toolName, JSON.stringify(args), 'risk_tolerance_blocked');
        return msg;
      }

      if (permission === 'approval') {
        const currentGoal = autoAgent.AUTO?.currentGoal || 'bilinmiyor';
        console.log(`[UserContext] 🔔 Onay gerekiyor: ${toolName}`);
        const result = await requestApproval(currentGoal, toolName, args);
        if (!result.approved) {
          const msg = `[UserContext] ❌ Onay reddedildi (${result.reason}): ${toolName}`;
          console.log(msg);
          return msg;
        }
        console.log(`[UserContext] ✅ Onay verildi: ${toolName}`);
      }

      // 3. Orijinal aracı çalıştır
      return original.call(tools, args);
    };
  });

  console.log(`[UserContext] ✅ ${Object.keys(tools).length} araç USER_MODEL ile wrap edildi.`);
}

// ── Ana mount fonksiyonu ──────────────────────────────────
function mountUserContext(app, autoAgent, userModel, brain) {
  if (!app || !autoAgent || !userModel) {
    console.warn('[UserContext] ⚠️ Eksik parametre, mount atlandı.');
    return;
  }

  // Araçları patch et
  patchAutoAgent(autoAgent, userModel, brain);

  // ── Mevcut bağlamı göster ────────────────────────────────
  app.get('/user/context', (req, res) => {
    const hour = new Date().getHours();
    const active = isActiveHour(userModel);
    res.json({
      status: 'success',
      userModel,
      currentHour: hour,
      isActiveHour: active,
      idleTasksAllowed: userModel.dailyRoutine?.idleTasksAllowed,
      pendingApprovals: pendingApprovals
        .filter(p => p.status === 'pending')
        .map(p => ({ id: p.id, goal: p.goal, tool: p.tool, ts: p.ts }))
    });
  });

  // ── Aktif saatleri güncelle ──────────────────────────────
  app.post('/user/context/hours', (req, res) => {
    const { start, end } = req.body;
    if (typeof start !== 'number' || typeof end !== 'number') {
      return res.json({ status: 'error', message: 'start ve end (saat) gerekli' });
    }
    userModel.dailyRoutine.activeHours = [start, end];
    console.log(`[UserContext] 🕐 Aktif saatler güncellendi: ${start}-${end}`);
    res.json({ status: 'success', activeHours: [start, end] });
  });

  // ── Risk toleransını güncelle ────────────────────────────
  app.post('/user/context/risk', (req, res) => {
    const { riskTolerance } = req.body;
    if (typeof riskTolerance !== 'number' || riskTolerance < 0 || riskTolerance > 1) {
      return res.json({ status: 'error', message: '0-1 arası bir değer gir' });
    }
    userModel.riskTolerance = riskTolerance;
    console.log(`[UserContext] ⚖️ Risk toleransı güncellendi: ${riskTolerance}`);
    res.json({ status: 'success', riskTolerance });
  });

  // ── Onay ver / reddet ────────────────────────────────────
  app.post('/user/context/approve/:id', (req, res) => {
    const id = parseInt(req.params.id);
    const entry = pendingApprovals.find(p => p.id === id && p.status === 'pending');
    if (!entry) return res.json({ status: 'error', message: 'Onay bulunamadı veya zaman aşımı' });
    entry.status = 'approved';
    entry.resolve({ approved: true });
    console.log(`[UserContext] ✅ Onay verildi #${id}`);
    res.json({ status: 'success', message: `#${id} onaylandı` });
  });

  app.post('/user/context/reject/:id', (req, res) => {
    const id = parseInt(req.params.id);
    const entry = pendingApprovals.find(p => p.id === id && p.status === 'pending');
    if (!entry) return res.json({ status: 'error', message: 'Onay bulunamadı' });
    entry.status = 'rejected';
    entry.resolve({ approved: false, reason: 'user_rejected' });
    console.log(`[UserContext] ❌ Reddedildi #${id}`);
    res.json({ status: 'success', message: `#${id} reddedildi` });
  });

  // ── Onay gerektiren kategorileri güncelle ────────────────
  app.post('/user/context/approval-list', (req, res) => {
    const { list } = req.body;
    if (!Array.isArray(list)) return res.json({ status: 'error', message: 'list array olmalı' });
    userModel.approvalRequiredFor = list;
    res.json({ status: 'success', approvalRequiredFor: list });
  });

  console.log('[UserContext] 🔌 Mount tamamlandı.');
  console.log('  GET  /user/context               → mevcut durum');
  console.log('  POST /user/context/hours          → aktif saat güncelle {start, end}');
  console.log('  POST /user/context/risk           → risk toleransı {riskTolerance: 0-1}');
  console.log('  POST /user/context/approve/:id    → onay ver');
  console.log('  POST /user/context/reject/:id     → reddet');
  console.log('  POST /user/context/approval-list  → onay listesi güncelle');
}

module.exports = { mountUserContext, isActiveHour, isToolAllowed };