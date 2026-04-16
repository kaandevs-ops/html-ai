const { spawn } = require("child_process");
const express = require('express');
const { exec } = require('child_process');
const fs = require("fs");
const path = require("path");
const cors = require('cors');
const multer = require('multer');
const cron = require("node-cron");
const { WebSocketServer } = require('ws');
const healthRouter = require('./health/healthRouter');
const { runAgentLoop, mountAgentRoutes } = require('./agentLoop');
const { initJobQueue, addJob, getJobStatus, getAllJobs, cancelJob, mountRoutes } = require('./jobQueue');
require('dotenv').config();
const rag = require('./brain/rag');
const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const ExcelJS = require("exceljs");
const { Document, Packer, Paragraph } = require("docx");
const screenshot = require('screenshot-desktop');
const uploadDir = path.join(__dirname, 'uploads_rag');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const upload = multer({
  dest: uploadDir,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
  fileFilter: (req, file, cb) => {
    const allowed = ['.pdf', '.txt', '.md', '.docx', '.csv', '.js', '.ts', '.py', '.json'];
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, allowed.includes(ext));
  }
});
// ===============================
// 🌍 WORLD STATE
// ===============================
const WORLD_STATE = {
  goal: null,
  currentStep: null,
  currentTool: null,
  lastError: null,
  confidence: 1.0,
  vision: {
    url: null,
    elements: []
  }
};
const customerConfig = require('./customerConfig');
customerConfig.load();
const brain = require('./brain');
const proactive = require('./brain/proactive');
// ======================
// 👤 USER MODEL
// ======================
const USER_MODEL = {
  experienceLevel: "advanced",     // beginner | intermediate | advanced
  riskTolerance: 0.3,              // 0 = hiç risk alma, 1 = full özgürlük
  prefersAutomation: true,
  approvalRequiredFor: [
    "delete",
    "purchase",
    "email_send",
    "system_command"
  ],
  dailyRoutine: {
    activeHours: [10, 24],          // saat aralığı
    idleTasksAllowed: true
  }
};
customerConfig.applyUserModel(USER_MODEL);
// ======================
// 🧠 COGNITIVE CORE
// ======================
const COGNITIVE_STATE = {
  beliefs: [],
  intents: [],
  attention: null,
  emotions: {
    confidence: 1.0,
    urgency: 0.3,
    fatigue: 0.0
  }
};

const LONG_TERM_GOALS = [
  { goal: "Kod tabanımı geliştirmek", priority: 5 },
  { goal: "Kullanıcıyı hızlandırmak", priority: 4 }
];

const FAILURE_PATTERNS = [];
const SEMANTIC_MEMORY = [];
// =====================================================
// 🧠 OPENCLAW TOOL REGISTRY
// =====================================================
const MODES = {
  RESEARCH: "araştır, oku, özetle",
  CODER: "kod yaz, test et",
  ANALYST: "veri analiz et",
  MAINTAINER: "projeleri temizle"
};

WORLD_STATE.mode = MODES.RESEARCH;
const jimp = require('jimp');
puppeteer.use(StealthPlugin());
const wol = require("wake_on_lan");
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const app = express();
app.use(express.json({ limit: '50mb' }))
const auth = require('./auth');
app.use(auth);
const conversations = {};

const axios = require("axios");
const archiver = require("archiver");
const PORT = 3000;
// --- GMAIL ---
const nodemailer = require("nodemailer");
const imaps = require("imap-simple");
const { simpleParser } = require("mailparser");

let lastEmails = {};
const GMAIL_CONFIG = {
  user: "mail@gmail.com",
  pass: "APP_PASSWORD_BURAYA",
  imap: {
    imap: {
      user: "mail@gmail.com",
      password: "APP_PASSWORD_BURAYA",
      host: "imap.gmail.com",
      port: 993,
      tls: true,
      authTimeout: 10000
    }
  }
};

// SV2 cache
// --- WHATSAPP CORE ---
let waBrowser = null;
let waPage = null;
let waReady = false;

// kişi → numara rehberi
const CONTACTS = {
  "annem": "90XXXXXXXXXX",
  "babam": "90YYYYYYYYYY",
  "kaan": "90ZZZZZZZZZZ"
};
// --- INSTAGRAM DM ---
let igBrowser = null;
let igPage = null;
let igReady = false;

const IG_CONTACTS = {
  "annem": "instagram_kullanici_adi",
  "kaan": "kaan.dev",
};
let lastIgMessages = {};

// son okunan mesaj cache
let lastMessages = {};

let cachedJobs = [];
app.use(cors());
app.use(express.static(__dirname)); // HTML'i sunmak için şart

// İşletim Sistemini Algıla
const isMac = process.platform === 'darwin';
const isWindows = process.platform === 'win32';
const isLinux = process.platform === 'linux';
function success(res, msg = "OK") {
  res.json({ status: "success", message: msg });
}

function fail(res, msg = "Hata") {
  res.json({ status: "error", message: msg });
}
function escapeAppleScript(str = "") {
  return str
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, " ");
}


function runAppleScript(script, res) {
  const osa = spawn("osascript", ["-e", script]);

  let errorOutput = "";

  osa.stderr.on("data", data => {
    errorOutput += data.toString();
  });

  osa.on("close", code => {
    if (code !== 0) {
      console.error("AppleScript Hatası:", errorOutput);
      return fail(res, errorOutput || "AppleScript çalıştırılamadı");
    }
    success(res);
  });
}
function runSystem(scriptMac, scriptWin, res, okMsg = "OK") {
  if (isMac) {
    return runAppleScript(scriptMac, res);
  }

  if (isWindows) {
    exec(
      `powershell -NoProfile -ExecutionPolicy Bypass -Command "${scriptWin}"`,
      (err) => {
        if (err) {
          console.error("Windows Hata:", err.message);
          return res.json({ status: "error", message: err.message });
        }
        res.json({ status: "success", message: okMsg });
      }
    );
  }
}
/* =====================================================
   🚀 LLM DESTEKLİ WEB PROJE PLANI
===================================================== */

async function buildWebProjectPlanLLM(projectName, goal) {
  console.log(`🏗️ buildWebProjectPlanLLM başladı: ${projectName}`); // ← ÖNCE LOG
  const result = await generateWebFilesWithLLM(projectName, goal);
  console.log(`🏗️ [${result.language}/${result.framework}] algılandı`);

  const steps = [];

  // Collect all unique directories needed
  const dirs = new Set([projectName]);
  for (const file of result.files) {
    const fullPath = `${projectName}/${file.path}`;
    const dir = fullPath.substring(0, fullPath.lastIndexOf("/"));
    if (dir) dirs.add(dir);
  }

  // Create all directories in one command
  steps.push({
    tool: "run_terminal",
    args: { command: `mkdir -p ${Array.from(dirs).join(" ")}` }
  });

  // Write each file
  for (const file of result.files) {
    const filePath = `${projectName}/${file.path}`;
    // Escape content for heredoc safety
    const safeContent = (file.content || "").replace(/\\/g, "\\\\");
    steps.push({
      tool: "run_terminal",
      args: {
        command: `cat << 'PROJECTEOF' > ${filePath}\n${safeContent}\nPROJECTEOF`
      }
    });
  }

  console.log(`✅ ${result.files.length} dosya planlandı (${result.language}/${result.framework})`);
  return steps;
}
function writeCodeToDesktop(filename, content) {
  const desktopPath =
    process.env.HOME
      ? path.join(process.env.HOME, "Desktop")
      : path.join(process.env.USERPROFILE, "Desktop");

  const filePath = path.join(desktopPath, filename);
  fs.writeFileSync(filePath, content, "utf8");
  return filePath;
}
// Sistem komutlarını çalıştıran fonksiyon
const executeCommand = (cmd, res, successMsg) => {
  console.log(`Komut çalıştırılıyor: ${cmd}`); // Log ekleyelim
  exec(cmd, (error, stdout, stderr) => {
    if (error) {
      console.error(`Hata: ${error.message}`);
      // Hata olsa bile frontend'e JSON dön ki çökmesin
      return res.json({ status: 'error', message: error.message });
    }
    res.json({ status: 'success', message: successMsg, output: stdout });
  });
};

// --- KOMUT LİSTESİ ---

// 1. Hesap Makinesi
app.get('/open-calc', (req, res) => {
  let cmd = 'calc'; // Varsayılan (Windows)
  if (isMac) cmd = 'open -a Calculator';
  if (isLinux) cmd = 'gnome-calculator'; // Linux (Gnome)

  executeCommand(cmd, res, 'Hesap makinesi açıldı.');
});


// 3. Paint (Mac için Önizleme/Preview veya Fotoğraflar)
app.get('/open-paint', (req, res) => {
  let cmd = 'mspaint';
  if (isMac) cmd = 'open -a Preview'; // Mac'te Paint yok, Preview açarız

  executeCommand(cmd, res, 'Çizim/Görüntüleme aracı açıldı.');
});



// 6. Bilgisayarı Kapat (DİKKAT)
app.get('/system-shutdown', (req, res) => {
  let cmd = 'shutdown /s /t 60';
  // Mac için kapatma komutu (şifre isteyebilir, o yüzden uyutma komutu daha güvenli test için)
  if (isMac) cmd = 'pmset sleepnow';

  executeCommand(cmd, res, 'Sistem uyku/kapatma moduna geçiyor.');
});

// 7. İptal
app.get('/system-abort', (req, res) => {
  let cmd = 'shutdown /a';
  if (isMac) cmd = 'killall shutdown'; // Mac'te genelde killall kullanılır

  executeCommand(cmd, res, 'İşlem iptal edildi.');
});
// ÖDEME ENDPOINT
app.post('/create-checkout-session', async (req, res) => {
  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'try',
          product_data: { name: 'KaanAi Pro Üyelik' },
          unit_amount: 25000, // 250 TL
        },
        quantity: 1,
      }],
      mode: 'payment',
      success_url: `http://localhost:${PORT}/kaan_biometric_full_v5.html`,
      cancel_url: `http://localhost:${PORT}/kaan_biometric_full_v5.html`,
    });
    res.json({ id: session.id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
app.post("/smart-home", async (req, res) => {
  const { device, action } = req.body;

  // Cihaz listesi
  const devices = {
    tv: {
      mac: "AA:BB:CC:DD:EE:FF", // TV MAC adresi
      ip: "192.168.1.50"
    },
    pc: {
      mac: "11:22:33:44:55:66",
      ip: "192.168.1.10"
    }
  };

  if (!devices[device]) {
    return res.json({ message: "Cihaz bulunamadı" });
  }

  if (action === "on") {
    wol.wake(devices[device].mac, () => {
      console.log(device + " açılıyor");
    });

    return res.json({ message: device + " açma komutu gönderildi" });
  }

  if (action === "off") {
    // Buraya HTTP / IR / Smart API entegre edilir
    return res.json({ message: device + " kapatma komutu gönderildi (API gerekli)" });
  }

  res.json({ message: "Geçersiz komut" });
});
// TextEdit aç
app.get("/jarvis/textedit/open", (req, res) => {
  runAppleScript(`tell application "TextEdit" to activate`, res);
});
// Gerçek yazma (klavye simülasyonu)
app.get("/jarvis/textedit/type", (req, res) => {
  const text = req.query.text || "";
  runAppleScript(`
    tell application "TextEdit"
      activate
      tell application "System Events"
        keystroke "${text}"
      end tell
    end tell
  `, res);
});

// Tümünü sil
app.get("/jarvis/textedit/clear", (req, res) => {
  runAppleScript(`
    tell application "System Events"
      keystroke "a" using command down
      keystroke (key code 51)
    end tell
  `, res);
});
app.get("/jarvis/finder/desktop", (req, res) => {
  runAppleScript(`tell application "Finder" to open desktop`, res);
});

app.get("/jarvis/finder/new-folder", (req, res) => {
  const name = req.query.text || "YeniKlasör";
  runAppleScript(`
    tell application "Finder"
      make new folder at desktop with properties {name:"${name}"}
    end tell
  `, res);
});
app.get("/jarvis/safari/open", (req, res) => {
  const url = req.query.text || "https://google.com";
  runAppleScript(`
    tell application "Safari"
      activate
      open location "${url}"
    end tell
  `, res);
});
app.get("/jarvis/safari/google-search-open-first", (req, res) => {
  const text = req.query.text || "";

  if (!text.trim()) {
    return res.json({
      status: "error",
      message: "Arama metni boş"
    });
  }

  const url = `https://www.google.com/search?q=${encodeURIComponent(text)}`;

  // ✅ MAC — SENİN ORİJİNAL KODUN (HİÇ DEĞİŞMEDİ)
  if (isMac) {
    const script = `
      tell application "Safari"
        activate
        delay 0.3
        open location "${url}"
        delay 2
        try
          tell front document to do JavaScript "
            (function(){
              const r = document.querySelector('a h3');
              if (r && r.parentElement) {
                r.parentElement.click();
                return true;
              }
              return false;
            })();
          "
        end try
      end tell
    `;

    const osa = spawn("osascript", ["-e", script]);

    let errorOutput = "";

    osa.stderr.on("data", data => {
      errorOutput += data.toString();
    });

    osa.on("close", code => {
      if (code !== 0) {
        console.error("AppleScript Hatası:", errorOutput);
        return res.json({
          status: "error",
          message: errorOutput || "AppleScript çalıştırılamadı"
        });
      }

      return res.json({
        status: "success",
        message: "Google araması yapıldı ve ilk sonuca girildi (Mac Safari)",
        query: text
      });
    });

    return;
  }

  // ✅ WINDOWS
  if (isWindows) {
    exec(`start "" "${url}"`, err => {
      if (err) {
        return res.json({
          status: "error",
          message: err.message
        });
      }

      return res.json({
        status: "success",
        message: "Google araması açıldı (Windows)",
        query: text
      });
    });

    return;
  }

  // ✅ LINUX
  if (isLinux) {
    exec(`xdg-open "${url}"`, err => {
      if (err) {
        return res.json({
          status: "error",
          message: err.message
        });
      }

      return res.json({
        status: "success",
        message: "Google araması açıldı (Linux)",
        query: text
      });
    });

    return;
  }

  // ❌ DESTEKLENMEYEN OS
  return res.json({
    status: "error",
    message: "Desteklenmeyen işletim sistemi"
  });
});


app.get("/jarvis/calendar/add", (req, res) => {
  const title = req.query.text || "Yeni Etkinlik";
  runAppleScript(`
    tell application "Calendar"
      tell calendar "Home"
        make new event with properties {summary:"${title}", start date:(current date)}
      end tell
    end tell
  `, res);
});
app.get("/jarvis/reminder/add", (req, res) => {
  const text = req.query.text || "Yeni Hatırlatma";
  runAppleScript(`
    tell application "Reminders"
      tell list "Reminders"
        make new reminder with properties {name:"${text}"}
      end tell
    end tell
  `, res);
});
app.get("/jarvis/music/play", (req, res) => {
  runAppleScript(`tell application "Music" to play`, res);
});

app.get("/jarvis/music/pause", (req, res) => {
  runAppleScript(`tell application "Music" to pause`, res);
});
app.get("/jarvis/vscode/open", (req, res) => {
  exec("code .");
  success(res);
});
app.get("/jarvis/safari/youtube", (req, res) => {
  runAppleScript(`
    tell application "Safari"
      activate
      open location "https://www.youtube.com"
    end tell
  `, res);
});
app.get("/jarvis/safari/youtube-search", (req, res) => {
  const q = encodeURIComponent(req.query.text || "");
  runAppleScript(`
    tell application "Safari"
      activate
      open location "https://www.youtube.com/results?search_query=${q}"
    end tell
  `, res);
});
app.get("/jarvis/safari/reload", (req, res) => {
  runAppleScript(`
    tell application "Safari"
      tell front document to set URL to URL
    end tell
  `, res);
});
app.get("/jarvis/safari/new-tab", (req, res) => {
  runAppleScript(`
    tell application "Safari"
      activate
      tell window 1 to make new tab
    end tell
  `, res);
});
app.get("/jarvis/safari/close-tab", (req, res) => {
  runAppleScript(`
    tell application "Safari"
      tell window 1 to close current tab
    end tell
  `, res);
});
// Instagram Reels - Sonraki Reel
app.get("/jarvis/instagram/next", (req, res) => {
  runAppleScript(`
    tell application "Safari"
      activate
      delay 0.3
      tell application "System Events"
        tell process "Safari"
          click at {500, 500}
          delay 0.1
          key code 49 -- Space
        end tell
      end tell
    end tell
  `, res);
});

// Instagram Reels - Önceki Reel
app.get("/jarvis/instagram/prev", (req, res) => {
  runAppleScript(`
    tell application "Safari"
      activate
      delay 0.3
      tell application "System Events"
        tell process "Safari"
          click at {500, 500}
          delay 0.1
          key code 49 using shift down -- Shift + Space
        end tell
      end tell
    end tell
  `, res);
});
let instaAutoInterval = null;

// Instagram Reels - Otomatik Mod BAŞLAT (NATIVE)
app.get("/jarvis/instagram/auto-start", (req, res) => {
  if (instaAutoInterval) {
    return success(res, "Zaten aktif");
  }

  instaAutoInterval = setInterval(() => {
    exec(`
      osascript -e '
      tell application "Safari"
        try
          tell front document to do JavaScript "
            (function(){
              const v = document.querySelector('video');
              if (v && v.duration && v.currentTime >= v.duration - 0.4) {
                return true;
              }
              return false;
            })();
          "
        on error
          return false
        end try
      end tell
      '`,
      (err, stdout) => {
        if (stdout && stdout.toString().includes("true")) {
          exec(`
            osascript -e '
            tell application "System Events"
              key code 49
            end tell
            '`
          );
        }
      }
    );
  }, 800);

  success(res, "Otomatik reels başlatıldı");
});

// Instagram Reels - Otomatik Mod DURDUR
app.get("/jarvis/instagram/auto-stop", (req, res) => {
  if (instaAutoInterval) {
    clearInterval(instaAutoInterval);
    instaAutoInterval = null;
  }
  success(res, "Otomatik reels durduruldu");
});


app.get("/jarvis/youtube/play-first", (req, res) => {
  runAppleScript(`
    tell application "Safari"
      activate
      delay 4
      tell front document to do JavaScript "
        const v = document.querySelector('a#video-title');
        if(v) { v.click(); }
      "
    end tell
  `, res);
});

app.get("/jarvis/safari/scroll", (req, res) => {
  const dir = req.query.dir === "up" ? -300 : 300;

  runAppleScript(`
    tell application "Safari"
      activate
      delay 1
      try
        tell front document to do JavaScript "window.scrollBy(0, ${dir});"
      on error
        return "SCROLL_FAIL"
      end try
    end tell
  `, res);
});


// Reels aç
app.get("/jarvis/instagram/reels", (req, res) => {
  runAppleScript(`
    tell application "Safari"
      activate
      open location "https://www.instagram.com/reels/"
    end tell
  `, res);
});

// Beğen
app.get("/jarvis/instagram/like", (req, res) => {
  runAppleScript(`
    tell application "Safari"
      tell front document to do JavaScript "
        const btn = document.querySelector('svg[aria-label=\\\"Like\\\"]');
        if(btn) btn.parentElement.click();
      "
    end tell
  `, res);
});

app.get("/jarvis/messages/open", (req, res) => {
  runAppleScript(`tell application "Messages" to activate`, res);
});
app.get("/jarvis/messages/send", (req, res) => {
  const rawName = req.query.to;
  const rawText = req.query.text;

  if (!rawName || !rawText) {
    return res.json({ status: "error", message: "to ve text zorunlu" });
  }

  const name = escapeAppleScript(rawName);
  const text = escapeAppleScript(rawText);

  const script = `
    set targetName to "${name}"
    set messageText to "${text}"

    tell application "Contacts"
      set matchedPeople to every person whose name contains targetName
      if (count of matchedPeople) is 0 then
        error "Kişi bulunamadı"
      end if
      set thePerson to item 1 of matchedPeople
      set phoneNumber to value of first phone of thePerson
    end tell

    tell application "Messages"
      set iMessageService to first service whose service type = iMessage
      set targetBuddy to buddy phoneNumber of iMessageService
      send messageText to targetBuddy
      activate
    end tell
  `;

  runAppleScript(script, res);
});


app.get("/jarvis/phone/call", (req, res) => {
  const rawName = req.query.to;
  if (!rawName) {
    return res.json({ status: "error", message: "Aranacak kişi yok" });
  }

  const name = escapeAppleScript(rawName);

  const script = `
    set targetName to "${name}"

    tell application "Contacts"
      set matchedPeople to every person whose name contains targetName
      if (count of matchedPeople) is 0 then
        error "Kişi bulunamadı"
      end if

      set thePerson to item 1 of matchedPeople
      set phoneNumber to value of first phone of thePerson
    end tell

    do shell script "open 'tel://" & phoneNumber & "'"
  `;

  runAppleScript(script, res);
});




app.get("/jarvis/phone/hangup", (req, res) => {
  runAppleScript(`
    tell application "System Events"
      tell process "FaceTime"
        try
          click button 1 of window 1 -- Kapat butonu
        end try
      end tell
    end tell
  `, res);
});
//hem mac hemde windows için diğerlerinide bu yöntemle yapasın
app.get("/jarvis/mail/open", (req, res) => {
  if (isMac) {
    runAppleScript(`tell application "Mail" to activate`, res);
  } else if (isWindows) {
    exec("start outlook");
    success(res);
  }
});

app.get("/jarvis/mail/send", (req, res) => {
  const to = req.query.to;
  const subject = req.query.subject || "Konu Yok";
  const text = req.query.text || "";

  if (!to) {
    return res.json({ status: "error", message: "Mail adresi yok" });
  }

  runAppleScript(`
    tell application "Mail"
      set newMessage to make new outgoing message with properties {
        subject:"${subject}",
        content:"${text}",
        visible:false
      }
      tell newMessage
        make new to recipient at end of to recipients with properties {address:"${to}"}
        send
      end tell
    end tell
  `, res);
});



// ========== TAM KONTROL: FARE, KLAVYE, TARAYICI (MAC + WINDOWS) ==========
// Parametre kaçışı (Windows PowerShell için)
function escapePowerShell(str) {
  if (typeof str !== "string") return "";
  return str
    .replace(/\$/g, "`$")
    .replace(/"/g, '`"')
    .replace(/\r/g, "")
    .replace(/\n/g, " ");
}
// SendKeys özel karakterler: + ^ % { } [ ] ( ) ~  -> parantez içine alınır
function escapeSendKeys(str) {
  if (typeof str !== "string") return "";
  return str.replace(/([+^%{}[\]()~])/g, "{$1}");
}

// --- FARE TIKLAMA (koordinat) ---
app.get("/jarvis/control/mouse/click", (req, res) => {
  const x = parseInt(req.query.x, 10);
  const y = parseInt(req.query.y, 10);
  if (isNaN(x) || isNaN(y)) {
    return res.json({ status: "error", message: "x ve y sayı olmalı (örn: ?x=100&y=200)" });
  }
  if (isMac) {
    exec(`osascript -e 'tell application "System Events" to click at {${x}, ${y}}'`, (err) => {
      if (err) return res.json({ status: "error", message: "Mac: Koordinata tıklama başarısız. " + (err.message || "") });
      success(res, `Tıklandı: ${x}, ${y}`);
    });
    return;
  }
  if (isWindows) {
    const path = require("path");
    const fs = require("fs");
    const tmpDir = process.env.TEMP || process.env.TMP || ".";
    const ps1Path = path.join(tmpDir, "kaan_mouse_click.ps1");
    const psContent = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class MouseHelper {
  [DllImport("user32.dll")]
  public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")]
  public static extern void mouse_event(int flags, int dx, int dy, int c, int e);
}
'@
[MouseHelper]::SetCursorPos(${x}, ${y})
[MouseHelper]::mouse_event(0x02, 0, 0, 0, 0)
[MouseHelper]::mouse_event(0x04, 0, 0, 0, 0)
`;
    fs.writeFile(ps1Path, psContent.trim(), (writeErr) => {
      if (writeErr) return res.json({ status: "error", message: writeErr.message });
      exec(`powershell -NoProfile -ExecutionPolicy Bypass -File "${ps1Path}"`, (err) => {
        fs.unlink(ps1Path, () => { });
        if (err) return res.json({ status: "error", message: err.message });
        success(res, `Tıklandı: ${x}, ${y}`);
      });
    });
    return;
  }
  res.json({ status: "error", message: "Bu işlem sadece Mac ve Windows desteklenir." });
});

// --- FARE HAREKET ---
app.get("/jarvis/control/mouse/move", (req, res) => {
  const x = parseInt(req.query.x, 10);
  const y = parseInt(req.query.y, 10);
  if (isNaN(x) || isNaN(y)) {
    return res.json({ status: "error", message: "x ve y sayı olmalı" });
  }
  if (isMac) {
    exec(`cliclick m:${x},${y}`, (err) => {
      if (err) return res.json({ status: "error", message: "Mac: Fare hareketi için cliclick gerekir: brew install cliclick" });
      success(res, `Fare taşındı: ${x}, ${y}`);
    });
    return;
  }
  if (isWindows) {
    const ps = `
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${x}, ${y})
`;
    exec(`powershell -NoProfile -ExecutionPolicy Bypass -Command "${ps.replace(/"/g, '\\"').replace(/\n/g, " ")}"`, (err) => {
      if (err) return res.json({ status: "error", message: err.message });
      success(res, `Fare taşındı: ${x}, ${y}`);
    });
    return;
  }
  res.json({ status: "error", message: "Desteklenmeyen işletim sistemi." });
});

// --- FARE KAYDIRMA (sayfa / genel) ---
app.get("/jarvis/control/mouse/scroll", (req, res) => {
  const dir = (req.query.dir || req.query.direction || "down").toLowerCase();
  const delta = parseInt(req.query.delta, 10) || (dir === "up" ? -120 : 120);
  const amount = parseInt(req.query.amount, 10) || Math.abs(delta);
  if (isMac) {
    const scrollVal = dir === "up" ? -Math.abs(amount) : Math.abs(amount);
    runAppleScript(`
      tell application "Safari"
        if (exists document 1) then
          tell front document to do JavaScript "window.scrollBy(0, ${scrollVal});"
        end if
      end tell
      tell application "System Events" to repeat 3 times
        key code ${dir === "up" ? 126 : 125}
      end repeat
    `, res);
    return;
  }
  if (isWindows) {
    const wheel = dir === "up" ? -Math.abs(amount) : Math.abs(amount);
    const path = require("path");
    const fs = require("fs");
    const tmpDir = process.env.TEMP || process.env.TMP || ".";
    const ps1Path = path.join(tmpDir, "kaan_mouse_scroll.ps1");
    const psContent = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class Wheel { [DllImport("user32.dll")] public static extern void mouse_event(int f,int dx,int dy,int c,int e); }
'@
[Wheel]::mouse_event(0x0800, 0, 0, ${wheel}, 0)
`;
    fs.writeFile(ps1Path, psContent.trim(), (writeErr) => {
      if (writeErr) return res.json({ status: "error", message: writeErr.message });
      exec(`powershell -NoProfile -ExecutionPolicy Bypass -File "${ps1Path}"`, (err) => {
        fs.unlink(ps1Path, () => { });
        if (err) return res.json({ status: "error", message: err.message });
        success(res, dir === "up" ? "Yukarı kaydırıldı." : "Aşağı kaydırıldı.");
      });
    });
    return;
  }
  res.json({ status: "error", message: "Desteklenmeyen işletim sistemi." });
});

// --- KLAVYE: METİN YAZ ---
app.get("/jarvis/control/keyboard/type", (req, res) => {
  let text = req.query.text != null ? String(req.query.text) : "";
  if (isMac) {
    const escaped = escapeAppleScript(text);
    runAppleScript(`
      tell application "System Events" to keystroke "${escaped}"
    `, res);
    return;
  }
  if (isWindows) {
    const escaped = escapeSendKeys(escapePowerShell(text));
    const ps = `
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.SendKeys]::SendWait('${escaped.replace(/'/g, "''")}')
`;
    exec(`powershell -NoProfile -ExecutionPolicy Bypass -Command "${ps.replace(/"/g, '\\"').replace(/\n/g, " ")}"`, (err) => {
      if (err) return res.json({ status: "error", message: err.message });
      success(res, "Metin yazıldı.");
    });
    return;
  }
  res.json({ status: "error", message: "Desteklenmeyen işletim sistemi." });
});

// --- KLAVYE: TEK TUŞ (Enter, Tab, Space, BackSpace, Escape vb.) ---
const keyCodeMapMac = {
  enter: "36", tab: "48", space: "49", backspace: "51", escape: "53",
  return: "36", delete: "51", right: "124", left: "123", up: "126", down: "125"
};
const keyCodeMapWin = {
  enter: "~", tab: "{TAB}", space: " ", backspace: "{BACKSPACE}", escape: "{ESCAPE}",
  return: "~", delete: "{DELETE}", right: "{RIGHT}", left: "{LEFT}", up: "{UP}", down: "{DOWN}"
};
app.get("/jarvis/control/keyboard/key", (req, res) => {
  const keyName = (req.query.key || "").toLowerCase().replace(/ /g, "");
  if (!keyName) return res.json({ status: "error", message: "key parametresi gerekli (örn: Enter, Tab, Space)" });
  if (isMac) {
    const code = keyCodeMapMac[keyName] || keyName;
    runAppleScript(`
      tell application "System Events" to key code ${code}
    `, res);
    return;
  }
  if (isWindows) {
    const sendKey = keyCodeMapWin[keyName] || (keyName.length === 1 ? keyName : "{" + keyName.toUpperCase() + "}");
    const escaped = escapeSendKeys(sendKey).replace(/'/g, "''");
    const ps = `
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.SendKeys]::SendWait('${escaped}')
`;
    exec(`powershell -NoProfile -ExecutionPolicy Bypass -Command "${ps.replace(/"/g, '\\"').replace(/\n/g, " ")}"`, (err) => {
      if (err) return res.json({ status: "error", message: err.message });
      success(res, `Tuş basıldı: ${keyName}`);
    });
    return;
  }
  res.json({ status: "error", message: "Desteklenmeyen işletim sistemi." });
});

// --- KLAVYE: KISAYOL (Ctrl+C, Cmd+V vb.) ---
app.get("/jarvis/control/keyboard/hotkey", (req, res) => {
  const mods = (req.query.mods || req.query.modifiers || "").toLowerCase().split(/[,+\s]+/).filter(Boolean);
  const key = (req.query.key || req.query.keyName || "").trim();
  if (!key) return res.json({ status: "error", message: "key parametresi gerekli" });
  if (isMac) {
    const useCmd = mods.some(m => m === "cmd" || m === "command" || m === "meta");
    const useOpt = mods.some(m => m === "opt" || m === "option" || m === "alt");
    const useShift = mods.some(m => m === "shift");
    const useCtrl = mods.some(m => m === "ctrl" || m === "control");
    let using = [];
    if (useCmd) using.push("command down");
    if (useOpt) using.push("option down");
    if (useShift) using.push("shift down");
    if (useCtrl) using.push("control down");
    const usingStr = using.length ? " using {" + using.join(", ") + "}" : "";
    const keyCode = keyCodeMapMac[key.toLowerCase()];
    const keyPart = keyCode ? ("key code " + keyCode) : ('keystroke "' + escapeAppleScript(key) + '"');
    runAppleScript(`
      tell application "System Events" to ${keyPart}${usingStr}
    `, res);
    return;
  }
  if (isWindows) {
    let send = "";
    if (mods.some(m => m === "ctrl" || m === "control")) send += "^";
    if (mods.some(m => m === "alt")) send += "%";
    if (mods.some(m => m === "shift")) send += "+";
    if (mods.some(m => m === "win")) send += "(";
    const winKey = keyCodeMapWin[key.toLowerCase()];
    send += winKey != null ? winKey : key;
    if (mods.some(m => m === "win")) send += ")";
    const escaped = escapeSendKeys(send).replace(/'/g, "''");
    const ps = `
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.SendKeys]::SendWait('${escaped}')
`;
    exec(`powershell -NoProfile -ExecutionPolicy Bypass -Command "${ps.replace(/"/g, '\\"').replace(/\n/g, " ")}"`, (err) => {
      if (err) return res.json({ status: "error", message: err.message });
      success(res, "Kısayol uygulandı.");
    });
    return;
  }
  res.json({ status: "error", message: "Desteklenmeyen işletim sistemi." });
});

// --- TARAYICI: SEÇİCİ İLE TIKLAMA (Mac: Safari JS; Windows: ön plandaki pencereye Enter vb. gönderilebilir, seçici yok) ---
app.get("/jarvis/control/browser/click-element", (req, res) => {
  const selector = (req.query.selector || req.query.selector || "").trim();
  if (!selector) return res.json({ status: "error", message: "selector parametresi gerekli (örn: button.primary, #submit)" });
  if (isMac) {
    const esc = selector.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    const script = `
      tell application "Safari" to if (exists document 1) then
        tell front document to do JavaScript "
          (function(){
            var el = document.querySelector('${esc}');
            if (el) { el.click(); return true; }
            return false;
          })();
        "
      end tell
    `;
    runAppleScript(script, res);
    return;
  }
  if (isWindows) {
    exec(`powershell -NoProfile -ExecutionPolicy Bypass -Command "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')"`, (err) => {
      if (err) return res.json({ status: "error", message: err.message });
      success(res, "Windows: Ön plandaki öğeye Enter gönderildi. Seçici ile tıklama için tarayıcıda Mac kullanın veya koordinat ile /jarvis/control/mouse/click kullanın.");
    });
    return;
  }
  res.json({ status: "error", message: "Desteklenmeyen işletim sistemi." });
});

// --- TARAYICI: INPUT DOLDURMA (Mac: Safari; Windows: genel klavye ile yazı yazılır, önce tıklanacak alan kullanıcı seçer) ---
app.get("/jarvis/control/browser/fill", (req, res) => {
  const selector = (req.query.selector || req.query.selector || "").trim();
  const value = req.query.value != null ? String(req.query.value) : "";
  if (!selector) return res.json({ status: "error", message: "selector ve value parametreleri gerekli" });
  if (isMac) {
    const escSel = selector.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, " ");
    const escVal = value.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\n/g, "\\n").replace(/"/g, '\\"');
    const script = `
      tell application "Safari" to if (exists document 1) then
        tell front document to do JavaScript "
          (function(){
            var el = document.querySelector('${escSel}');
            if (!el) return false;
            el.focus();
            el.value = '${escVal}';
            el.dispatchEvent(new Event('input', { bubbles: true }));
            return true;
          })();
        "
      end tell
    `;
    runAppleScript(script, res);
    return;
  }
  if (isWindows) {
    const escaped = escapeSendKeys(escapePowerShell(value)).replace(/'/g, "''");
    const ps = `
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.SendKeys]::SendWait('${escaped}')
`;
    exec(`powershell -NoProfile -ExecutionPolicy Bypass -Command "${ps.replace(/"/g, '\\"').replace(/\n/g, " ")}"`, (err) => {
      if (err) return res.json({ status: "error", message: err.message });
      success(res, "Metin yazıldı (ön plandaki alana). Seçici ile doldurma Mac Safari'de kullanılır.");
    });
    return;
  }
  res.json({ status: "error", message: "Desteklenmeyen işletim sistemi." });
});

// Eski /jarvis/click uyumluluğu: koordinat verilirse control/mouse/click'e yönlendir
app.get("/jarvis/click", (req, res) => {
  const x = req.query.x;
  const y = req.query.y;
  if (x != null && y != null && !isNaN(parseInt(x, 10)) && !isNaN(parseInt(y, 10))) {
    return req.app._router.handle({ ...req, url: "/jarvis/control/mouse/click?x=" + x + "&y=" + y }, res);
  }
  if (isMac) {
    exec(`
osascript -e 'tell application "System Events"
  try
    click button "Ara" of window 1 of process "Safari"
  on error
    click at {500, 300}
  end try
end tell'`, (err) => {
      if (err) return res.json({ status: "error", message: err.message });
      res.json({ status: "success", message: "Butona basıldı." });
    });
    return;
  }
  if (isWindows) {
    const ps = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class MouseClick {
  [DllImport("user32.dll")]
  public static extern void mouse_event(int dwFlags, int dx, int dy, int cButtons, int dwExtraInfo);
}
"@
[MouseClick]::mouse_event(0x02, 0, 0, 0, 0)
[MouseClick]::mouse_event(0x04, 0, 0, 0, 0)
`;
    exec(`powershell -NoProfile -ExecutionPolicy Bypass -Command "${ps.replace(/"/g, '\\"').replace(/\n/g, " ")}"`, (err) => {
      if (err) return res.json({ status: "error", message: err.message });
      res.json({ status: "success", message: "Tıklama gönderildi (mevcut konum)." });
    });
    return;
  }
  res.json({ status: "error", message: "Desteklenmeyen işletim sistemi." });
});
//jarvis sayfayı oku
app.get("/jarvis/read-page", (req, res) => {
  exec(
    `osascript -e 'tell application "Safari"
      if not (exists document 1) then return "NO_PAGE"
      set t to text of document 1
      return t
    end tell'`,
    (err, stdout) => {
      res.setHeader("Content-Type", "application/json");

      if (err) {
        return res.end(JSON.stringify({
          status: "error",
          text: ""
        }));
      }

      res.end(JSON.stringify({
        status: "success",
        text: stdout.substring(0, 4000)
      }));
    }
  );
});


//sonucu özetle
app.get("/jarvis/first-result-summary", (req, res) => {
  exec(`
osascript <<EOF
tell application "Safari"
  do JavaScript "
    let p = document.querySelector('p');
    p ? p.innerText : 'Özet bulunamadı';
  " in document 1
end tell
EOF
`, (err, stdout) => {
    res.json({ summary: stdout });
  });
});
//tabloyu al
app.get("/jarvis/get-table", (req, res) => {
  exec(`
osascript <<EOF
tell application "Safari"
  do JavaScript "
    let t = document.querySelector('table');
    if (!t) 'NO_TABLE';
    else [...t.rows].map(r =>
      [...r.cells].map(c => c.innerText).join(' | ')
    ).join('\\n');
  " in document 1
end tell
EOF
`, (err, stdout) => {
    res.json({ table: stdout });
  });
});
//formu doldur
app.get("/jarvis/fill-form", (req, res) => {
  exec(`
osascript <<EOF
tell application "Safari"
  do JavaScript "
    document.querySelectorAll('input').forEach(i => {
      if (i.type === 'text') i.value = 'Test Veri';
      if (i.type === 'email') i.value = 'test@mail.com';
    });
    let f = document.querySelector('form');
    if (f) f.submit();
  " in document 1
end tell
EOF
`);
  res.send("Form dolduruldu");
});
//dosya yükleme
app.get("/jarvis/upload-file", (req, res) => {
  const filePath = req.query.path; // örn: /Users/kaan/Desktop/test.pdf
  if (!filePath) return res.send("Dosya yolu yok");

  exec(`
osascript <<EOF
delay 1
tell application "System Events"
  keystroke "G" using {command down, shift down}
  delay 0.5
  keystroke "${filePath}"
  delay 0.5
  key code 36
  delay 0.5
  key code 36
end tell
EOF
`);

  res.send("Dosya seçildi");
});

// 🧠 OLLAMA CHAT ENDPOINT (DÜZELTİLMİŞ – KAAN HTML UYUMLU)
// loopMode: true ise "Ollama Jarvis Döngü" modu - komut çıktısı için [KOMUT]...[/KOMUT] formatı kullanır
app.post("/ollama/ask", async (req, res) => {
  const { prompt, sessionId = "default", loopMode = false } = req.body;
  const cached = brain.checkReflex(prompt);
  if (cached) return res.json({ status: "success", answer: cached, fromCache: true });
  // === SCREEN AWARE BLOCK START ===                                ║
  // ║    ...                                                                ║
  // ║    // === SCREEN AWARE BLOCK END ===                                  ║
  // ║    ↑↑↑ BURAYA KADAR ↑↑↑                                             ║
  // ║                                                                       ║
  // ║    const ragContext = rag.buildRagContext(prompt);                    ║
  // ║    ...devam...                                                        ║
  // ╚══════════════════════════════════════════════════════════════════════╝

  // === SCREEN AWARE BLOCK START ===

  // Ekran bağlamı gerektiren sorgular
  const _screenTriggers = [
    "nasıl", "nerede", "bu uygulamada", "ekranda", "ne görüyorsun",
    "ne var ekranda", "şu an ne açık", "buna bak", "bunu yap",
    "açık olan", "önümdeki", "gördüğün", "şu ekranda",
    "bu pencerede", "burada nasıl", "nasıl yapabilirim",
    "adım adım", "göster nasıl", "anlat nasıl"
  ];

  const _lowerPrompt = prompt.toLowerCase();
  const _needsScreen = _screenTriggers.some(t => _lowerPrompt.includes(t));

  if (_needsScreen) {
    try {
      // 1. Aktif uygulamayı öğren
      const _activeApp = await getActiveAppName().catch(() => "bilinmiyor");

      // 2. Ekran görüntüsü al
      const _imgPath = "./vision_screen_aware.png";
      await captureScreen(_imgPath).catch(() => null);

      // 3. Base64'e çevir (dosya varsa)
      let _screenBase64 = null;
      if (fs.existsSync(_imgPath)) {
        _screenBase64 = fs.readFileSync(_imgPath, { encoding: "base64" });
      }

      // 4. Ekran içeriğini Ollama'ya gönder — ne gördüğünü anla
      let _screenContext = "";
      if (_screenBase64) {
        try {
          const _visionR = await axios.post("http://localhost:11434/api/generate", {
            model: "llama3.1:8b",
            stream: false,
            prompt: "Bu ekran görüntüsünde ne var? Hangi uygulama açık, ne gösteriliyor? Kısa Türkçe açıkla:",
            images: [_screenBase64]
          });
          _screenContext = (_visionR.data.response || "").trim().slice(0, 600);
        } catch (e) {
          // Vision modeli yoksa aktif uygulama adıyla devam et
          _screenContext = "Aktif uygulama: " + _activeApp;
        }
      } else {
        _screenContext = "Aktif uygulama: " + _activeApp;
      }

      // 5. Kullanıcının sorusunu ekran bağlamıyla zenginleştir
      const _screenEnrichedPrompt =
        "=== EKRAN BAĞLAMI ===\n" +
        "Aktif uygulama: " + _activeApp + "\n" +
        "Ekranda görülen: " + _screenContext + "\n" +
        "====================\n\n" +
        "Kullanıcı sorusu: " + prompt + "\n\n" +
        "Ekrandaki uygulamayı ve içeriği göz önünde bulundurarak, " +
        "adım adım Türkçe açıkla. Eğer ekranda başka bir uygulama " +
        "varsa ona göre cevap ver:";

      // 6. Doğrudan Ollama'ya gönder ve cevapla
      const _screenSession = sessionId + "_screen";
      if (!conversations[_screenSession]) {
        conversations[_screenSession] = [
          {
            role: "system",
            content:
              "Sen KaanAI'sın. Kullanıcının ekranını görebiliyorsun. " +
              "Ekranda ne açık olduğunu bilerek, o uygulamaya özgü " +
              "adım adım yardım et. Sadece Türkçe konuş."
          }
        ];
      }

      conversations[_screenSession].push({ role: "user", content: _screenEnrichedPrompt });

      const _screenR = await axios.post("http://localhost:11434/api/chat", {
        model: "llama3.1:8b",
        stream: false,
        messages: conversations[_screenSession]
      });

      const _screenAnswer = _screenR.data.message.content || "";
      conversations[_screenSession].push({ role: "assistant", content: _screenAnswer });

      // Sohbet geçmişini çok büyütme
      if (conversations[_screenSession].length > 20) {
        conversations[_screenSession] = [
          conversations[_screenSession][0], // system prompt kalsın
          ...conversations[_screenSession].slice(-10)
        ];
      }

      // Brain'e öğret
      brain.learn(prompt, _screenAnswer);
      brain.mem.remember(
        "screen_qa:" + _activeApp + ":" + Date.now(),
        prompt.slice(0, 60) + " → " + _screenAnswer.slice(0, 60),
        0.65
      );

      return res.json({
        status: "success",
        answer: _screenAnswer,
        screenContext: {
          activeApp: _activeApp,
          hadScreenshot: !!_screenBase64
        }
      });

    } catch (_screenErr) {
      // Hata olursa normal akışa düş, ekran bağlamı olmadan cevapla
      console.log("[ScreenAware] Hata, normal akışa dönülüyor:", _screenErr.message);
    }
  }

  // === SCREEN AWARE BLOCK END ===

  const ragContext = rag.buildRagContext(prompt);
  const enrichedPrompt = brain.enrichPrompt(prompt);
  const finalPrompt = ragContext
    ? ragContext + '\n\n' + enrichedPrompt
    : enrichedPrompt;
  // enrichedPrompt'u Ollama'ya gönder (eskiden prompt kullanıyordun)
  const actualSessionId = loopMode ? `ollama-loop-${sessionId}` : sessionId;

  if (!conversations[actualSessionId]) {
    const systemPrompt = loopMode
      ? `Sen KaanAI isimli bir yapay zekasın.
Şu anda OLLAMA–JARVIS DÖNGÜ MODUNDASIN.

TEMEL AMAÇ:
Kullanıcının isteğini analiz et ve SADECE kesin olarak gerekli ise komut üret.

DİL:
- SADECE Türkçe konuş.

KOMUT KURALI (ÇOK ÖNEMLİ):
- Eğer kullanıcı AÇIK, NET ve TEK ADIMLI bir bilgisayar işlemi istiyorsa:
  SADECE aşağıdaki formatta cevap ver:

[KOMUT]komut[/KOMUT]

- Bunun DIŞINDAKİ HER DURUMDA KOMUT ÜRETME.

KOMUT ÜRETMEYECEĞİN DURUMLAR:
- Belirsiz istekler
- Sohbet
- Bilgi soruları
- Birden fazla adım içeren işler
- Emin olmadığın durumlar

BU DURUMLARDA:
- Kısa ve net bir soru sor
- Veya kısa bir açıklama yap

KOMUT YAZIM KURALI:
- Tek cümle
- Kısa
- Fiil ile başla
- Doğal Türkçe
- Açıklama EKLEME

ÖRNEKLER:

Kullanıcı: YouTube aç  
Cevap: [KOMUT]safari youtube aç[/KOMUT]

Kullanıcı: biraz müzik dinlemek istiyorum  
Cevap: Ne tarz müzik dinlemek istersin?

Kullanıcı: merhaba  
Cevap: Merhaba! Nasıl yardımcı olabilirim?

YASAKLAR:
- KOMUT dışında metin yazma
- Format bozma
- Açıklama ekleme
- Tahmin yürütme
`.trim()
      : `Sen KaanAI isimli bir yapay zekasın.

KURALLAR:
- SADECE Türkçe konuş.
- Net, mantıklı ve kısa cevaplar ver.
- Gereksiz açıklama yapma.
- Emin olmadığın konularda açıkça belirt.
- Kullanıcı teknik biri, yüzeysel cevap verme.
- Sohbet modundasın.
- KESİNLİKLE KOMUT ÜRETME.

AMAÇ:
Doğru bilgi vermek ve gerektiğinde netleştirme sorusu sormak.
`.trim();


    conversations[actualSessionId] = [
      { role: "system", content: systemPrompt }
    ];
  }

  conversations[actualSessionId].push({
    role: "user",
    content: enrichedPrompt
  });

  try {
    const r = await axios.post("http://localhost:11434/api/chat", {
      model: "llama3.1:8b",
      stream: false,
      messages: conversations[actualSessionId]
    });

    const answer = r.data.message.content;
    // === OLLAMA LOOP KOMUT YAKALAMA ===
    if (loopMode) {
      const match = answer.match(/\[KOMUT\]([\s\S]*?)\[\/KOMUT\]/);

      if (match) {
        const komut = match[1].toLowerCase().trim();

        // === KOD YAZ KOMUTU ===
        if (komut.startsWith("kod yaz")) {
          // Dosya adı otomatik
          const fileName = `ollama_kod_${Date.now()}.txt`;

          // KOD İÇERİĞİ = KOMUT METNİNDEN SONRAKİ CEVAP
          // (istersen burada farklı parsing de yaparız)
          writeCodeToDesktop(fileName, answer);

          return res.json({
            status: "success",
            action: "code_written",
            file: fileName,
            location: "Desktop"
          });
        }
      }
    }


    conversations[actualSessionId].push({
      role: "assistant",
      content: answer
    });
    const lower = prompt.toLowerCase();
    if (lower.includes("her zaman") || lower.includes("hep ") ||
      lower.includes("tercihim") || lower.includes("bana hep") ||
      lower.includes("bundan sonra")) {
      brain.learning.learnUserPreference("kullanici_tercihi_" + Date.now(), prompt);
    }
    if (lower.includes("odaklan") || lower.includes("şu an") ||
      lower.includes("konuya dön") || lower.includes("focus")) {
      brain.distraction.setFocus(prompt);
    }
    brain.learn(prompt, answer);
    res.json({
      status: "success",
      answer
    });

  } catch (e) {
    brain.onError("ollama", prompt, e.message);
    res.json({ status: "error", message: "Ollama yok" });
  }
});


//sonradan eklenenler
// Instagram DM (Mesajlar) Aç
app.get("/jarvis/instagram/messages", (req, res) => {
  runAppleScript(`
    tell application "Safari"
      activate
      open location "https://www.instagram.com/direct/inbox/"
    end tell
  `, res);
});
app.get("/jarvis/whatsapp/open", (req, res) => {
  runAppleScript(`tell application "WhatsApp" to activate`, res);
});
app.get("/jarvis/whatsapp/chat", (req, res) => {
  const name = escapeAppleScript(req.query.to || "");

  runAppleScript(`
    tell application "WhatsApp"
      activate
      delay 0.3
      tell application "System Events"
        keystroke "f" using command down
        delay 0.2
        keystroke "${name}"
        delay 0.4
        key code 36
      end tell
    end tell
  `, res);
});
app.get("/jarvis/gmail/open", (req, res) => {
  runAppleScript(`
    tell application "Safari"
      activate
      open location "https://mail.google.com"
    end tell
  `, res);
});
app.get("/jarvis/mailapp/send", (req, res) => {
  const to = req.query.to;
  const subject = req.query.subject || "Konu Yok";
  const text = req.query.text || "";

  if (!to) {
    return res.json({
      status: "error",
      message: "Mail adresi eksik"
    });
  }

  runAppleScript(`
    tell application "Mail"
      set newMessage to make new outgoing message with properties {
        subject:"${subject}",
        content:"${text}",
        visible:false
      }
      tell newMessage
        make new to recipient at end of to recipients with properties {address:"${to}"}
        send
      end tell
    end tell
  `, res);
});
app.get("/jarvis/mailapp/read-last", (req, res) => {
  const script = `
    tell application "Mail"
      set inboxMessages to messages of inbox
      if (count of inboxMessages) is 0 then
        return "MAIL_YOK"
      end if

      set lastMessage to item 1 of inboxMessages
      set theSubject to subject of lastMessage
      set theContent to content of lastMessage

      return theSubject & "||| " & theContent
    end tell
  `;

  const osa = spawn("osascript", ["-e", script]);
  let output = "";

  osa.stdout.on("data", d => output += d.toString());

  osa.on("close", () => {
    const parts = output.split("|||");
    res.json({
      status: "success",
      subject: parts[0] || "",
      content: (parts[1] || "").substring(0, 2000)
    });
  });
});
app.get("/jarvis/maps/open", (req, res) => {
  runAppleScript(`
    tell application "Safari"
      activate
      open location "https://www.google.com/maps"
    end tell
  `, res);
});
app.get("/jarvis/maps/search", (req, res) => {
  const q = req.query.text || "";

  runAppleScript(`
    tell application "Safari"
      activate
      open location "https://www.google.com/maps/search/${q}"
    end tell
  `, res);
});
app.get("/jarvis/maps/directions", (req, res) => {
  const to = req.query.to || "";

  runAppleScript(`
    tell application "Safari"
      activate
      open location "https://www.google.com/maps/dir/?api=1&destination=${to}"
    end tell
  `, res);
});
app.get("/jarvis/office/word/open", (req, res) => {
  runAppleScript(`tell application "Microsoft Word" to activate`, res);
});
app.get("/jarvis/office/word/type", (req, res) => {
  const text = req.query.text || "";

  runAppleScript(`
    tell application "Microsoft Word"
      activate
      if not (exists document 1) then make new document
      set content of text object of document 1 to "${text}"
    end tell
  `, res);
});
app.get("/jarvis/office/excel/open", (req, res) => {
  runAppleScript(`tell application "Microsoft Excel" to activate`, res);
});
app.get("/jarvis/office/excel/write", (req, res) => {
  const { cell, text } = req.query;

  runAppleScript(`
    tell application "Microsoft Excel"
      activate
      if not (exists workbook 1) then make new workbook
      set value of range "${cell}" of active sheet of workbook 1 to "${text}"
    end tell
  `, res);
});
app.get("/jarvis/office/ppt/open", (req, res) => {
  runAppleScript(`tell application "Microsoft PowerPoint" to activate`, res);
});
app.get("/jarvis/office/ppt/add-slide", (req, res) => {
  const text = req.query.text || "";

  runAppleScript(`
    tell application "Microsoft PowerPoint"
      activate
      if not (exists presentation 1) then make new presentation
      set newSlide to make new slide at end of slides of presentation 1
      set text of text frame of shape 1 of newSlide to "${text}"
    end tell
  `, res);
});

//gerçek asistan halleri
app.get("/agent/email-classify-local", async (req, res) => {
  exec(`
osascript <<EOF
tell application "Mail"
  set m to item 1 of (messages of inbox)
  return subject of m & "||| " & content of m
end tell
EOF
`, async (err, stdout) => {
    if (err) return res.json({ status: "error" });

    const [subject, content] = stdout.split("|||");

    try {
      const r = await axios.post("http://localhost:11434/api/chat", {
        model: "llama3.1:8b",
        stream: false,
        messages: [
          {
            role: "system",
            content: `
Bir maili şu etiketlerden birine ayır:
Social, Newsletter, Programming, Finance, Personal, Spam
Sadece etiketi yaz.
            `
          },
          {
            role: "user",
            content: `Başlık: ${subject}\nİçerik: ${content}`
          }
        ]
      });

      res.json({
        status: "success",
        label: r.data.message.content.trim()
      });
    } catch {
      res.json({ status: "error", message: "Ollama çalışmıyor" });
    }
  });
});
app.post("/agent/quote-local", async (req, res) => {
  const { brief } = req.body;
  const prices = require("./pricing.json");

  try {
    const r = await axios.post("http://localhost:11434/api/chat", {
      model: "llama3.1:8b",
      stream: false,
      messages: [
        {
          role: "system",
          content: `
Fiyatlar:
${JSON.stringify(prices)}
Müşteri brief'ine göre kalem kalem teklif ve toplam fiyat üret.
          `
        },
        { role: "user", content: brief }
      ]
    });

    res.json({ status: "success", quote: r.data.message.content });
  } catch {
    res.json({ status: "error", message: "Ollama yok" });
  }
});
app.post("/agent/stock-local", async (req, res) => {
  const { symbol, change } = req.body;

  try {
    const r = await axios.post("http://localhost:11434/api/chat", {
      model: "llama3.1:8b",
      stream: false,
      messages: [
        {
          role: "system",
          content: `
Bir hisse değişimini kısa ve mantıklı açıkla.
Gerçek haber varmış gibi yaz ama "örnek analiz" olduğunu ima etme.
          `
        },
        {
          role: "user",
          content: `${symbol} hissesi %${change} değişti. Neden olabilir?`
        }
      ]
    });

    res.json({
      status: "success",
      explanation: r.data.message.content
    });
  } catch {
    res.json({ status: "error" });
  }
});


//f1 için 
// 🏎️ F1 RACE DATA (OFFLINE – API YOK)
app.get("/f1/race/data", (req, res) => {
  res.sendFile(__dirname + "/data/f1_race_demo.json");
});

// 🧠 F1 AI SPİKER (OLLAMA LOCAL)
app.post("/f1/commentary", async (req, res) => {
  const { lap, events } = req.body;

  try {
    const response = await axios.post(
      "http://localhost:11434/api/chat",
      {
        model: "llama3.1:8b",
        stream: false,
        messages: [
          {
            role: "system",
            content: `
Sen Formula 1 spikerisin.
- SADECE Türkçe konuş
- Kısa ve heyecanlı anlat
- Teknik ama anlaşılır ol
            `.trim()
          },
          {
            role: "user",
            content: `Tur ${lap} olayları: ${events}`
          }
        ]
      }
    );

    res.json({
      status: "success",
      commentary: response.data.message.content
    });

  } catch (e) {
    res.json({
      status: "error",
      commentary: "Yarış devam ediyor..."
    });
  }
});




// ========== ASİSTAN: KULLANICI PROFİLİ + GOOGLE + TARAYICI TAM KONTROL ==========
const dataDir = path.join(__dirname, "data");
const profilePath = path.join(dataDir, "user-profile.json");

function ensureDataDir() {
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
}

function readUserProfile() {
  ensureDataDir();
  if (!fs.existsSync(profilePath)) {
    const defaultProfile = { name: "", interests: [], city: "", favoriteSites: [], learnedFacts: [] };
    fs.writeFileSync(profilePath, JSON.stringify(defaultProfile, null, 2));
    return defaultProfile;
  }
  try {
    return JSON.parse(fs.readFileSync(profilePath, "utf8"));
  } catch (e) {
    return { name: "", interests: [], city: "", favoriteSites: [], learnedFacts: [] };
  }
}

function writeUserProfile(profile) {
  ensureDataDir();
  fs.writeFileSync(profilePath, JSON.stringify({ ...readUserProfile(), ...profile }, null, 2));
}

app.get("/assistant/profile", (req, res) => {
  res.json({ status: "success", profile: readUserProfile() });
});

app.post("/assistant/profile", (req, res) => {
  const { name, interests, city, favoriteSites, learnedFacts } = req.body || {};
  const profile = readUserProfile();
  if (name !== undefined) profile.name = String(name);
  if (interests !== undefined) profile.interests = Array.isArray(interests) ? interests : (interests ? String(interests).split(/[,;]/).map(s => s.trim()).filter(Boolean) : []);
  if (city !== undefined) profile.city = String(city || "");
  if (favoriteSites !== undefined) profile.favoriteSites = Array.isArray(favoriteSites) ? favoriteSites : (favoriteSites ? String(favoriteSites).split(/[,;]/).map(s => s.trim()).filter(Boolean) : []);
  if (learnedFacts !== undefined) profile.learnedFacts = Array.isArray(learnedFacts) ? learnedFacts : profile.learnedFacts || [];
  writeUserProfile(profile);
  if (name) brain.mem.remember("user:name", name, 1.0);
  if (city) brain.mem.remember("user:city", city, 1.0);
  if (interests?.length) brain.mem.remember("user:interests", interests.join(","), 0.9);
  res.json({ status: "success", profile });
});

app.post("/assistant/profile/remember", (req, res) => {
  const { fact } = req.body || {};
  if (!fact || !String(fact).trim()) return res.json({ status: "error", message: "fact gerekli" });
  const profile = readUserProfile();
  profile.learnedFacts = profile.learnedFacts || [];
  profile.learnedFacts.push({ text: String(fact).trim(), at: new Date().toISOString() });
  if (profile.learnedFacts.length > 100) profile.learnedFacts = profile.learnedFacts.slice(-80);
  writeUserProfile(profile);
  res.json({ status: "success", message: "Hatırladım.", profile });
});

// Google arama + aksiyon (ilk sonucu aç, listele, ilk sayfayı çek). Mac/Windows bağımsız Puppeteer.
app.post("/assistant/google-search", async (req, res) => {
  let { query, action = "list", personalContext = false } = req.body || {};
  query = (query || req.query.q || "").trim();
  if (!query) return res.json({ status: "error", message: "query (q) gerekli" });
  if (personalContext) {
    const profile = readUserProfile();
    const extra = [profile.name, ...(profile.interests || []), profile.city].filter(Boolean).slice(0, 3).join(" ");
    if (extra) query = query + " " + extra;
  }
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"]
    });
    const page = await browser.newPage();
    await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36");
    await page.goto("https://www.google.com/search?q=" + encodeURIComponent(query), { waitUntil: "domcontentloaded", timeout: 20000 });
    await new Promise(r => setTimeout(r, 2500));
    const results = await page.evaluate(() => {
      const out = [];
      document.querySelectorAll("a[href^='http']").forEach(a => {
        const href = a.href;
        if (/google\.com\/url|accounts\.google|webcache|translate\.google/.test(href)) return;
        const text = (a.innerText || "").trim();
        if (text.length < 5 || text.length > 200) return;
        out.push({ title: text.slice(0, 150), url: href });
      });
      return [...new Map(out.map(o => [o.url, o])).values()].slice(0, 10);
    });
    if (!results.length) {
      await browser.close();
      return res.json({ status: "success", query, results: [], message: "Sonuç bulunamadı" });
    }
    const firstUrl = results[0].url;
    if (action === "open_first" || action === "openFirst") {
      if (isMac) exec("open \"" + firstUrl + "\"", () => { });
      else if (isWindows) exec("start \"\" \"" + firstUrl + "\"", () => { });
      else exec("xdg-open \"" + firstUrl + "\"", () => { });
      await browser.close();
      return res.json({ status: "success", query, opened: firstUrl, results: results.slice(0, 5) });
    }
    if (action === "extract_first" || action === "extractFirst") {
      const np = await browser.newPage();
      await np.goto(firstUrl, { waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => { });
      await new Promise(r => setTimeout(r, 2000));
      const text = await np.evaluate(() => (document.body && document.body.innerText) ? document.body.innerText.slice(0, 8000) : "");
      await np.close();
      await browser.close();
      return res.json({ status: "success", query, first: { ...results[0], textSlice: text.slice(0, 3000) }, results: results.slice(0, 5) });
    }
    await browser.close();
    res.json({ status: "success", query, results });
  } catch (err) {
    if (browser) await browser.close().catch(() => { });
    res.json({ status: "error", message: err.message });
  }
});

// Herhangi bir URL’i ziyaret et, başlık + metin dilimi döndür (Puppeteer – tüm platformlar).
app.post("/assistant/browser/visit", async (req, res) => {
  const url = (req.body && req.body.url) || req.query.url || "";
  if (!url || !/^https?:\/\//i.test(url)) return res.json({ status: "error", message: "Geçerli url gerekli" });
  let browser;
  try {
    browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox", "--disable-setuid-sandbox"] });
    const page = await browser.newPage();
    await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36");
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 25000 });
    await new Promise(r => setTimeout(r, 2000));
    const info = await page.evaluate(() => ({
      title: (document.title || "").slice(0, 200),
      textSlice: (document.body && document.body.innerText) ? document.body.innerText.slice(0, 6000) : ""
    }));
    await browser.close();
    res.json({ status: "success", url, ...info });
  } catch (err) {
    if (browser) await browser.close().catch(() => { });
    res.json({ status: "error", message: err.message });
  }
});

// Sayfadan seçici ile veya tüm gövde metnini çek.
app.post("/assistant/browser/extract", async (req, res) => {
  const url = (req.body && req.body.url) || req.query.url || "";
  const selector = (req.body && req.body.selector) || req.query.selector || "body";
  if (!url || !/^https?:\/\//i.test(url)) return res.json({ status: "error", message: "Geçerli url gerekli" });
  let browser;
  try {
    browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox", "--disable-setuid-sandbox"] });
    const page = await browser.newPage();
    await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36");
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 25000 });
    await new Promise(r => setTimeout(r, 1500));
    const data = await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (!el) return { found: false, text: "" };
      return { found: true, text: el.innerText ? el.innerText.slice(0, 12000) : "" };
    }, selector);
    await browser.close();
    res.json({ status: "success", url, selector, ...data });
  } catch (err) {
    if (browser) await browser.close().catch(() => { });
    res.json({ status: "error", message: err.message });
  }
});

// Kişiselleştirilmiş “benimle ilgili” arama: profil ilgi alanları + şehir ile arama yap, ilk sonucu aç veya listele.
app.post("/assistant/personal-search", async (req, res) => {
  const { query, openFirst = true } = req.body || {};
  const profile = readUserProfile();
  const interests = (profile.interests || []).join(" ");
  const city = profile.city || "";
  const name = profile.name || "";
  const learned = (profile.learnedFacts || []).slice(-5).map(f => (f && f.text) || f).filter(Boolean).join(" ");
  const fullQuery = [query, name, interests, city, learned].filter(Boolean).join(" ").trim() || "gündem haberler";
  const action = openFirst ? "open_first" : "list";
  try {
    const ax = await axios.post("http://localhost:" + PORT + "/assistant/google-search", { query: fullQuery, action });
    res.json(ax.data);
  } catch (e) {
    res.json({ status: "error", message: e.message || "Sunucu hatası" });
  }
});

//windows için kodlar

function runPowerShell(psCommand, res, successMsg = "OK") {
  exec(
    `powershell -NoProfile -ExecutionPolicy Bypass -Command "${psCommand}"`,
    (err) => {
      if (err) return res.json({ status: "error", message: err.message });
      res.json({ status: "success", message: successMsg });
    }
  );
}

app.get("/win/calc", (req, res) => {
  runSystem(
    `tell application "Calculator" to activate`,
    `Start-Process calc`,
    res, "Hesap makinesi açıldı"
  );
});

app.get("/win/notepad", (req, res) => {
  runSystem(
    `tell application "TextEdit" to activate`,
    `Start-Process notepad`,
    res, "TextEdit/Notepad açıldı"
  );
});

app.get("/win/mail/send", (req, res) => {
  const { to, subject = "Konu Yok", text = "" } = req.query;
  if (!to) return fail(res, "Mail adresi yok");
  if (!isWindows) return fail(res, "Sadece Windows+Outlook için. Mac için /jarvis/mail/send kullan.");
  const ps = `$outlook = New-Object -ComObject Outlook.Application; $mail = $outlook.CreateItem(0); $mail.To = "${to}"; $mail.Subject = "${subject}"; $mail.Body = "${text}"; $mail.Send()`;
  runPowerShell(ps, res, "Mail gönderildi");
});

app.get("/win/type", (req, res) => {
  const text = req.query.text || "";
  res.redirect(`/jarvis/control/keyboard/type?text=${encodeURIComponent(text)}`);
});

app.get("/win/close-window", (req, res) => {
  runSystem(
    `tell application "System Events" to keystroke "w" using command down`,
    `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('%{F4}')`,
    res, "Pencere kapatıldı"
  );
});

app.get("/win/volume/up", (req, res) => {
  runSystem(
    `tell application "System Events" to key code 72`,
    `(1..5) | ForEach-Object { (New-Object -ComObject WScript.Shell).SendKeys([char]175) }`,
    res, "Ses artırıldı"
  );
});

app.get("/win/volume/down", (req, res) => {
  runSystem(
    `tell application "System Events" to key code 73`,
    `(1..5) | ForEach-Object { (New-Object -ComObject WScript.Shell).SendKeys([char]174) }`,
    res, "Ses azaltıldı"
  );
});

app.get("/win/lock", (req, res) => {
  runSystem(
    `tell application "System Events" to key code 12 using {control down, command down}`,
    `rundll32.exe user32.dll,LockWorkStation`,
    res, "Kilitlendi"
  );
});

app.get("/win/click", (req, res) => {
  const { x = 500, y = 500 } = req.query;
  res.redirect(`/jarvis/control/mouse/click?x=${x}&y=${y}`);
});

app.get("/win/scroll", (req, res) => {
  const dir = req.query.dir || "down";
  res.redirect(`/jarvis/control/mouse/scroll?dir=${dir}`);
});

app.get("/win/focus", (req, res) => {
  const appName = req.query.app || "Chrome";
  if (isMac) {
    runAppleScript(`tell application "${appName}" to activate`, res);
  } else if (isWindows) {
    runPowerShell(`(New-Object -ComObject WScript.Shell).AppActivate('${appName}')`, res, `${appName} odaklandı`);
  } else {
    exec(`wmctrl -a "${appName}"`, err => err ? fail(res, err.message) : success(res, `${appName} odaklandı`));
  }
});



//denemeler
app.get("/agent/find-real-estate", async (req, res) => {
  const city = req.query.city || "istanbul";

  try {
    const browser = await puppeteer.launch({
      headless: false,
      args: ["--no-sandbox"]
    });


    const page = await browser.newPage();

    const url = `https://www.hepsiemlak.com/${city}-satilik`;

    await page.goto(url, {
      waitUntil: "networkidle2",
      timeout: 60000
    });

    // İnsan gibi bekle
    await new Promise(r => setTimeout(r, 5000));

    const listings = await page.evaluate(() => {
      const data = [];

      const cards = document.querySelectorAll("article");

      cards.forEach(card => {
        const title =
          card.querySelector("h3")?.innerText || "";

        const price =
          card.querySelector('[data-testid="price"]')?.innerText || "";

        const link =
          card.querySelector("a")?.href || "";

        if (title && price)
          data.push({ title, price, link });
      });

      return data.slice(0, 10);
    });

    await browser.close();

    res.json({
      status: "success",
      city,
      count: listings.length,
      results: listings
    });

  } catch (err) {
    res.json({
      status: "error",
      message: err.message
    });
  }
});
app.get("/agent/wiki", async (req, res) => {
  const term = req.query.q || "Istanbul";

  try {
    const browser = await puppeteer.launch({
      headless: true,
      args: ["--no-sandbox"]
    });

    const page = await browser.newPage();

    await page.goto(`https://tr.wikipedia.org/wiki/${term}`, {
      waitUntil: "domcontentloaded"
    });

    const result = await page.evaluate(() => {
      const title = document.querySelector("#firstHeading")?.innerText;
      const paragraph = document.querySelector("p")?.innerText;

      return { title, paragraph };
    });

    await browser.close();

    res.json({
      status: "success",
      result
    });

  } catch (err) {
    res.json({
      status: "error",
      message: err.message
    });
  }
});
app.get("/agent/price", async (req, res) => {
  const url = req.query.url;

  try {
    const browser = await puppeteer.launch({ headless: true });
    const page = await browser.newPage();

    await page.goto(url, { waitUntil: "domcontentloaded" });

    const price = await page.evaluate(() => {
      return document.body.innerText.match(/\d+[,.]\d+\s?TL/)?.[0] || "Bulunamadı";
    });

    await browser.close();

    res.json({ status: "success", price });

  } catch (err) {
    res.json({ status: "error", message: err.message });
  }
});
app.get("/agent/jobs", async (req, res) => {
  try {
    const browser = await puppeteer.launch({ headless: true });
    const page = await browser.newPage();

    await page.goto("https://remoteok.com", {
      waitUntil: "networkidle2"
    });

    await new Promise(r => setTimeout(r, 3000));

    const jobs = await page.evaluate(() => {
      const data = [];

      document.querySelectorAll("a[itemprop='url']").forEach(job => {
        const title = job.innerText.trim();
        if (title.length > 5) {
          data.push({ title });
        }
      });

      return data.slice(0, 10);
    });

    await browser.close();

    res.json({ status: "success", jobs });

  } catch (err) {
    res.json({ status: "error", message: err.message });
  }
});
// SV1 CSV export
app.get("/agent/jobs-csv", async (req, res) => {
  if (!cachedJobs.length) {
    await scrapeJobsCached();
  }

  const csv = "Job Title\n" + cachedJobs.join("\n");

  res.setHeader("Content-Type", "text/csv");
  res.send(csv);
});


app.get("/agent/news", async (req, res) => {
  const browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();

  await page.goto("https://news.ycombinator.com");

  const headlines = await page.evaluate(() => {
    return [...document.querySelectorAll(".titleline a")]
      .map(a => a.innerText)
      .slice(0, 10);
  });

  await browser.close();

  res.json({ headlines });
});

// 🏠 EV İLANLARI (hepsiemlak + filtre: şehir, max fiyat, min oda)
app.get("/agent/ev-ilanlari", async (req, res) => {
  const city = (req.query.city || "istanbul").toLowerCase().replace(/\s/g, "-");
  const maxPrice = parseInt(req.query.maxPrice, 10) || 0; // 0 = filtre yok
  const minRoom = parseInt(req.query.minRoom, 10) || 0;

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"]
    });
    const page = await browser.newPage();
    await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36");
    const url = `https://www.hepsiemlak.com/${city}-satilik`;
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await new Promise(r => setTimeout(r, 3000));

    const listings = await page.evaluate((maxP, minR) => {
      const out = [];
      const cards = document.querySelectorAll("article, [class*='listing'], [class*='Listing']");
      cards.forEach(card => {
        const titleEl = card.querySelector("h2, h3, [class*='title']");
        const priceEl = card.querySelector("[data-testid='price'], [class*='price'], [class*='fiyat']");
        const linkEl = card.querySelector("a[href*='ilan']");
        let title = titleEl ? titleEl.innerText.trim() : "";
        let priceText = priceEl ? priceEl.innerText.trim() : "";
        const link = linkEl ? linkEl.href : "";
        if (!title && !priceText) return;
        const priceNum = parseFloat(priceText.replace(/[^\d]/g, "")) || 0;
        if (maxP > 0 && priceNum > maxP) return;
        const roomMatch = title.match(/(\d+)\s*\+?\s*oda|(\d+)\s*oda/i) || title.match(/(\d+)\s*\+?\s*1/i);
        const rooms = roomMatch ? parseInt(roomMatch[1] || roomMatch[2] || roomMatch[3], 10) : 0;
        if (minR > 0 && rooms < minR) return;
        out.push({ title: title.slice(0, 80), price: priceText, priceNum, link });
      });
      return out.slice(0, 15);
    }, maxPrice, minRoom);

    await browser.close();
    res.json({ status: "success", city, count: listings.length, results: listings });
  } catch (err) {
    if (browser) await browser.close().catch(() => { });
    res.json({ status: "error", message: err.message, results: [] });
  }
});

// 🛒 E-TİCARET ARAMA (hepsiburada / trendyol - ürün listesi)
app.get("/agent/shop", async (req, res) => {
  const q = (req.query.q || req.query.query || "laptop").trim();
  const site = (req.query.site || "hepsiburada").toLowerCase();
  const maxPrice = parseInt(req.query.maxPrice, 10) || 0;

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"]
    });
    const page = await browser.newPage();
    await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36");

    const isHepsi = site === "hepsiburada";
    const searchUrl = isHepsi
      ? `https://www.hepsiburada.com/ara?q=${encodeURIComponent(q)}`
      : `https://www.trendyol.com/sr?q=${encodeURIComponent(q)}`;

    await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 25000 });
    await new Promise(r => setTimeout(r, 4000));

    const products = await page.evaluate((isHepsiSite, maxP) => {
      const out = [];
      const selectors = isHepsiSite
        ? ["li[class*='productList']", "[data-test-id='product-card']", "ul[class*='productList'] > li", ".productListContent-zAP0Y5"]
        : ["div[class*='p-card']", "[class*='product-down']", ".product-card"];
      let nodes = [];
      for (const sel of selectors) {
        nodes = document.querySelectorAll(sel);
        if (nodes.length) break;
      }
      if (!nodes.length) nodes = document.querySelectorAll("[class*='product'], [class*='Product']");
      nodes.forEach((node, i) => {
        if (i >= 12) return;
        const titleEl = node.querySelector("h3, [class*='title'], [class*='name'], span[class*='product']");
        const priceEl = node.querySelector("[class*='price'], [class*='fiyat'], [data-test-id='price']");
        const linkEl = node.querySelector("a[href]");
        let title = titleEl ? titleEl.innerText.trim().slice(0, 60) : "";
        let priceText = priceEl ? priceEl.innerText.trim() : "";
        const link = linkEl ? linkEl.href : "";
        if (!title && !priceText) return;
        const priceNum = parseFloat(priceText.replace(/[^\d]/g, "")) || 0;
        if (maxP > 0 && priceNum > maxP) return;
        out.push({ title, price: priceText, priceNum, link });
      });
      return out.slice(0, 12);
    }, isHepsi, maxPrice);

    await browser.close();
    res.json({ status: "success", query: q, site, count: products.length, results: products });
  } catch (err) {
    if (browser) await browser.close().catch(() => { });
    res.json({ status: "error", message: err.message, results: [] });
  }
});

// 📰 TÜRKÇE HABERLER (gündem başlıkları)
app.get("/agent/news-tr", async (req, res) => {
  const limit = Math.min(20, parseInt(req.query.limit, 10) || 10);
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"]
    });
    const page = await browser.newPage();
    await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36");
    await page.goto("https://www.sozcu.com.tr", { waitUntil: "domcontentloaded", timeout: 20000 });
    await new Promise(r => setTimeout(r, 2500));

    const headlines = await page.evaluate((lim) => {
      const links = document.querySelectorAll("a[href*='/haberler/'], a[href*='/gundem/'], .news-title a, h2 a, h3 a");
      const seen = new Set();
      const out = [];
      links.forEach(a => {
        const text = a.innerText.trim();
        if (text.length < 10 || text.length > 120 || seen.has(text)) return;
        seen.add(text);
        out.push({ title: text, url: a.href });
      });
      return out.slice(0, lim);
    }, limit);

    await browser.close();
    res.json({ status: "success", count: headlines.length, headlines });
  } catch (err) {
    if (browser) await browser.close().catch(() => { });
    res.json({ status: "error", message: err.message, headlines: [] });
  }
});

// 🎯 İŞ İLANLARI (Türkiye - kariyer.net / linkedin benzeri basit liste)
app.get("/agent/is-ilanlari", async (req, res) => {
  const q = (req.query.q || req.query.query || "yazılım").trim();
  const city = (req.query.city || "").trim();
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"]
    });
    const page = await browser.newPage();
    await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36");
    const url = `https://www.kariyer.net/is-ilanlari?q=${encodeURIComponent(q)}${city ? "&city=" + encodeURIComponent(city) : ""}`;
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 25000 });
    await new Promise(r => setTimeout(r, 3500));

    const jobs = await page.evaluate(() => {
      const out = [];
      document.querySelectorAll("a[href*='/is-ilanlari/'], [class*='job-list'] a, [class*='ilan'] a").forEach(a => {
        const title = a.innerText.trim();
        if (title.length > 5 && title.length < 100) out.push({ title, url: a.href });
      });
      return [...new Map(out.map(o => [o.title, o])).values()].slice(0, 12);
    });

    await browser.close();
    res.json({ status: "success", query: q, city, count: jobs.length, results: jobs });
  } catch (err) {
    if (browser) await browser.close().catch(() => { });
    res.json({ status: "error", message: err.message, results: [] });
  }
});

// SV2 scraping motoru
async function scrapeJobsCached() {
  console.log("Cron scraping başladı...");

  try {
    const browser = await puppeteer.launch({
      headless: true,
      args: ["--no-sandbox"]
    });

    const page = await browser.newPage();

    await page.goto("https://remoteok.com", {
      waitUntil: "networkidle2"
    });

    await new Promise(r => setTimeout(r, 3000));

    const jobs = await page.evaluate(() => {
      return [...document.querySelectorAll("a[itemprop='url']")]
        .map(j => j.innerText.trim())
        .filter(t => t.length > 5)
        .slice(0, 15);
    });

    await browser.close();

    cachedJobs = jobs;
    console.log("Cron güncellendi:", jobs.length);

  } catch (e) {
    console.log("Cron hata:", e.message);
  }
}
app.get("/agent/maps-pro", async (req, res) => {
  const query = req.query.q || "istanbul kuaför";
  const maxCheck = Math.min(parseInt(req.query.limit, 10) || 15, 15);

  try {
    const browser = await puppeteer.launch({
      headless: "new",
      args: ["--no-sandbox", "--disable-setuid-sandbox"]
    });

    const page = await browser.newPage();
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36"
    );

    await page.goto("https://www.google.com/maps", {
      waitUntil: "networkidle2",
      timeout: 60000
    });

    await new Promise(r => setTimeout(r, 5000));

    const inputs = await page.$$("input");
    if (!inputs.length) { await browser.close(); return res.json({ status: "error", message: "Hiç input bulunamadı" }); }
    const input = inputs[0];
    await input.click();
    await input.type(query, { delay: 80 });
    await page.keyboard.press("Enter");
    await new Promise(r => setTimeout(r, 7000));

    for (let i = 0; i < 5; i++) {
      await page.mouse.wheel({ deltaY: 2500 });
      await new Promise(r => setTimeout(r, 1500));
    }

    const leads = await page.evaluate(() => {
      const results = [];
      document.querySelectorAll("a.hfpxzc").forEach(el => {
        const name = el.getAttribute("aria-label") || "";
        const link = el.href;
        if (name && link) results.push({ name, link });
      });
      return results.slice(0, 25);
    });

    const noWebsiteResults = [];
    for (let i = 0; i < Math.min(leads.length, maxCheck); i++) {
      const { name, link } = leads[i];
      try {
        await page.goto(link, { waitUntil: "domcontentloaded", timeout: 15000 });
        await new Promise(r => setTimeout(r, 4000));

        const info = await page.evaluate(() => {
          const data = { phone: null, website: null, address: null };
          document.querySelectorAll("button").forEach(btn => {
            const text = (btn.innerText || "").trim();
            if (text && /^0[\d\s]{10,}$/.test(text.replace(/\s/g, ""))) data.phone = data.phone || text;
            if (text && text.indexOf("http") !== -1) data.website = data.website || text;
          });
          if (!data.website) {
            document.querySelectorAll("a[href^='http']").forEach(a => {
              const h = (a.href || "").trim();
              if (h && h.indexOf("google.com") === -1 && h.indexOf("goo.gl") === -1) data.website = data.website || h;
            });
          }
          const addrEl = document.querySelector("[data-item-id='address']");
          if (addrEl) data.address = addrEl.innerText;
          return data;
        });

        const hasRealWebsite = info.website && !info.website.includes("google.com") && !info.website.includes("goo.gl");
        if (!hasRealWebsite) {
          noWebsiteResults.push({
            name,
            address: info.address || "—",
            phone: info.phone || "—",
            link
          });
        }
      } catch (e) {
        // tek işletme hata verirse devam et
      }
    }

    await browser.close();

    res.json({
      status: "success",
      count: noWebsiteResults.length,
      results: noWebsiteResults,
      query
    });

  } catch (err) {
    res.json({
      status: "error",
      message: err.message
    });
  }
});
app.get("/agent/maps-details", async (req, res) => {
  const url = req.query.url;

  if (!url) {
    return res.json({ status: "error", message: "url gerekli" });
  }

  try {
    const browser = await puppeteer.launch({
      headless: false,
      args: ["--no-sandbox"]
    });

    const page = await browser.newPage();
    await page.goto(url, { waitUntil: "networkidle2", timeout: 0 });

    await new Promise(r => setTimeout(r, 6000));

    const data = await page.evaluate(() => {
      const info = {
        phone: null,
        website: null,
        address: null
      };

      document.querySelectorAll("button").forEach(btn => {
        const text = btn.innerText;

        if (text.startsWith("0")) info.phone = text;
        if (text.includes("http")) info.website = text;
      });

      const addr = document.querySelector("[data-item-id='address']");
      if (addr) info.address = addr.innerText;

      return info;
    });

    await browser.close();

    res.json({
      status: "success",
      hasWebsite: !!data.website,
      ...data
    });

  } catch (err) {
    res.json({
      status: "error",
      message: err.message
    });
  }
});
app.get("/agent/control", async (req, res) => {
  try {
    const browser = await puppeteer.launch({ headless: false });
    const page = await browser.newPage();

    await page.goto("https://example.com", { waitUntil: "networkidle2" });

    // input'a yaz
    await page.type("input[type='text']", "Merhaba dünya");

    // butona bas
    await page.click("button");

    await new Promise(r => setTimeout(r, 3000));

    await browser.close();

    res.json({ status: "success", message: "Kontrol tamamlandı" });

  } catch (err) {
    res.json({ status: "error", message: err.message });
  }
});

// SV2 otomatik güncelle (10 dakikada bir)
cron.schedule("*/10 * * * *", scrapeJobsCached);

// server açılınca ilk çekim
scrapeJobsCached();
//yeni komutlar
// 🔊 SES KONTROL
app.get("/jarvis/system/volume", (req, res) => {
  const level = Number(req.query.level || 50);

  if (isMac) {
    runAppleScript(`set volume output volume ${level}`, res);
  } else if (isWindows) {
    exec(`powershell -c "(New-Object -ComObject WScript.Shell).SendKeys([char]173)"`);
    success(res);
  }
});

app.get("/jarvis/system/mute", (req, res) => {
  if (isMac) {
    runAppleScript(`set volume with output muted`, res);
  } else if (isWindows) {
    exec(`powershell -c "(New-Object -ComObject WScript.Shell).SendKeys([char]173)"`);
    success(res);
  }
});

// 💡 PARLAKLIK
app.get("/jarvis/system/brightness", (req, res) => {
  const level = Number(req.query.level || 50);
  runAppleScript(`tell application "System Events" to set value of first slider of first group of first tab group of first window of application process "System Settings" to ${level}`, res);
});

// 📶 WIFI
app.get("/jarvis/system/wifi", (req, res) => {
  const state = req.query.state === "on" ? "on" : "off";
  exec(`networksetup -setairportpower airport ${state}`);
  success(res);
});

// 🔵 BLUETOOTH
app.get("/jarvis/system/bluetooth", (req, res) => {
  const state = req.query.state === "on" ? "on" : "off";
  exec(`blueutil --power ${state === "on" ? 1 : 0}`);
  success(res);
});

// 🔒 EKRAN KİLİT
app.get("/jarvis/system/lock", (req, res) => {
  exec(`pmset displaysleepnow`);
  success(res);
});

// 😴 UYUT
app.get("/jarvis/system/sleep", (req, res) => {
  exec(`pmset sleepnow`);
  success(res);
});

// 🔁 YENİDEN BAŞLAT
app.get("/jarvis/system/restart", (req, res) => {
  exec(`shutdown -r now`);
  success(res);
});

// 🔋 PİL
app.get("/jarvis/system/battery", (req, res) => {
  exec(`pmset -g batt`, (err, out) => {
    res.json({ battery: out });
  });
});

// 🧠 CPU / RAM
app.get("/jarvis/system/stats", (req, res) => {
  exec(`top -l 1 | head -n 10`, (err, out) => {
    res.json({ stats: out });
  });
});
// 📋 AÇIK UYGULAMALAR
app.get("/jarvis/apps/list", (req, res) => {
  exec(`osascript -e 'tell application "System Events" to get name of (processes where background only is false)'`, (e, o) => {
    res.json({ apps: o });
  });
});

// ❌ UYGULAMA KAPAT
app.get("/jarvis/apps/close", (req, res) => {
  const appName = req.query.name;
  runAppleScript(`tell application "${appName}" to quit`, res);
});

// 🪟 PENCERE KÜÇÜLT
app.get("/jarvis/window/minimize", (req, res) => {
  runAppleScript(`tell application "System Events" to keystroke "m" using command down`, res);
});

// ⌨️ AKTİF PENCEREYE YAZ
app.get("/jarvis/type", (req, res) => {
  const text = escapeAppleScript(req.query.text || "");
  runAppleScript(`tell application "System Events" to keystroke "${text}"`, res);
});

// 📸 SCREENSHOT
app.get("/jarvis/screenshot", (req, res) => {
  exec(`screencapture ~/Desktop/jarvis_${Date.now()}.png`);
  success(res);
});

// 📋 CLIPBOARD OKU
app.get("/jarvis/clipboard", (req, res) => {
  exec(`pbpaste`, (e, o) => res.json({ clipboard: o }));
});
// 🖥️ MASAÜSTÜ
app.get("/jarvis/fs/desktop", (req, res) => {
  exec(`open ~/Desktop`);
  success(res);
});

// 📥 DOWNLOADS
app.get("/jarvis/fs/downloads", (req, res) => {
  exec(`open ~/Downloads`);
  success(res);
});

// 📂 KLASÖR OLUŞTUR
app.get("/jarvis/fs/new-folder", (req, res) => {
  const name = req.query.name || "YeniKlasor";
  exec(`mkdir ~/Desktop/${name}`);
  success(res);
});

// 🔍 DOSYA ARA
app.get("/jarvis/fs/search", (req, res) => {
  const q = req.query.q;
  exec(`mdfind ${q}`, (e, o) => res.json({ results: o }));
});

// 🗑️ DOSYA SİL
app.get("/jarvis/fs/delete", (req, res) => {
  const path = req.query.path;
  exec(`rm -rf "${path}"`);
  success(res);
});

// 📝 METİN DOSYASI
app.get("/jarvis/fs/note", (req, res) => {
  const text = req.query.text || "";
  exec(`echo "${text}" >> ~/Desktop/jarvis_notes.txt`);
  success(res);
});
const DB = "./jarvis_db.json";

function readDB() {
  if (!fs.existsSync(DB)) fs.writeFileSync(DB, JSON.stringify({}));
  return JSON.parse(fs.readFileSync(DB));
}

function writeDB(data) {
  fs.writeFileSync(DB, JSON.stringify(data, null, 2));
}

app.get("/jarvis/time", (req, res) => {
  res.json({ time: new Date().toLocaleTimeString() });
});

app.get("/jarvis/date", (req, res) => {
  res.json({ date: new Date().toLocaleDateString() });
});

app.get("/jarvis/reminder/save", (req, res) => {
  const db = readDB();
  db.reminders = db.reminders || [];
  db.reminders.push({ text: req.query.text, time: Date.now() });
  writeDB(db);
  success(res);
});
// 🎵 RASTGELE MÜZİK
app.get("/jarvis/fun/music", (req, res) => {
  runAppleScript(`tell application "Music" to play`, res);
});

// 😂 ŞAKA
app.get("/jarvis/fun/joke", (req, res) => {
  const jokes = ["Ben yapay zekayım ama senin kadar akıllıyım 😎", "Bugün de insanlığı ele geçirmiyorum."];
  res.json({ joke: jokes[Math.floor(Math.random() * jokes.length)] });
});

// 🗣️ TTS
app.get("/jarvis/speak", (req, res) => {
  const text = escapeAppleScript(req.query.text || "Hazırım");
  exec(`say "${text}"`);
  success(res);
});

// ⏱️ ZAMANLAYICI (API yok, bellek içi)
let timerEndTime = null;
app.get("/jarvis/timer/start", (req, res) => {
  const minutes = Math.min(120, Math.max(1, parseInt(req.query.minutes, 10) || 5));
  timerEndTime = Date.now() + minutes * 60 * 1000;
  res.json({ status: "success", message: `${minutes} dakikalık zamanlayıcı başlatıldı.`, minutes });
});
app.get("/jarvis/timer/status", (req, res) => {
  if (!timerEndTime) return res.json({ status: "success", active: false, message: "Zamanlayıcı yok." });
  const left = Math.max(0, Math.ceil((timerEndTime - Date.now()) / 1000));
  if (left === 0) {
    timerEndTime = null;
    return res.json({ status: "success", active: false, message: "Zamanlayıcı bitti.", secondsLeft: 0 });
  }
  res.json({ status: "success", active: true, secondsLeft: left, message: `${Math.floor(left / 60)} dk ${left % 60} sn kaldı.` });
});
app.get("/jarvis/timer/cancel", (req, res) => {
  timerEndTime = null;
  res.json({ status: "success", message: "Zamanlayıcı iptal edildi." });
});

// 🍅 POMODORO (API yok, bellek içi - 25 dk)
let pomodoroEndTime = null;
app.get("/jarvis/pomodoro/start", (req, res) => {
  const minutes = parseInt(req.query.minutes, 10) || 25;
  pomodoroEndTime = Date.now() + minutes * 60 * 1000;
  res.json({ status: "success", message: `Pomodoro başladı (${minutes} dk).`, minutes });
});
app.get("/jarvis/pomodoro/status", (req, res) => {
  if (!pomodoroEndTime) return res.json({ status: "success", active: false, message: "Pomodoro yok." });
  const left = Math.max(0, Math.ceil((pomodoroEndTime - Date.now()) / 1000));
  if (left === 0) {
    pomodoroEndTime = null;
    return res.json({ status: "success", active: false, message: "Pomodoro bitti. Mola zamanı!", secondsLeft: 0 });
  }
  res.json({ status: "success", active: true, secondsLeft: left, message: `${Math.floor(left / 60)} dk ${left % 60} sn kaldı.` });
});

// 🗑️ ÇÖP KUTUSU
app.get("/jarvis/trash/open", (req, res) => {
  if (isMac) runAppleScript(`tell application "Finder" to open trash`, res);
  else if (isWindows) { exec("explorer shell:RecycleBinFolder"); success(res); }
  else res.json({ status: "error", message: "Bu işletim sisteminde desteklenmiyor." });
});
app.get("/jarvis/trash/empty", (req, res) => {
  if (isMac) runAppleScript(`tell application "Finder" to empty trash`, res);
  else if (isWindows) { exec("powershell -Command \"Clear-RecycleBin -Force\""); success(res); }
  else res.json({ status: "error", message: "Bu işletim sisteminde desteklenmiyor." });
});

// 🔍 SPOTLIGHT AÇ (Mac: Cmd+Space)
app.get("/jarvis/spotlight/open", (req, res) => {
  if (isMac) runAppleScript(`tell application "System Events" to key code 49 using command down`, res);
  else res.json({ status: "error", message: "Sadece Mac için." });
});

// 😀 EMOJİ PANELİ (Mac: Ctrl+Cmd+Space)
app.get("/jarvis/emoji/open", (req, res) => {
  if (isMac) runAppleScript(`tell application "System Events" to key code 49 using {control down, command down}`, res);
  else res.json({ status: "error", message: "Sadece Mac için." });
});

// 📐 BİRİM ÇEVİRİCİ (API yok, saf matematik)
const unitFactors = {
  km_mile: 0.621371, mile_km: 1.60934,
  kg_lb: 2.20462, lb_kg: 0.453592,
  m_ft: 3.28084, ft_m: 0.3048,
  cm_inch: 0.393701, inch_cm: 2.54,
  celsius_fahrenheit: (c) => c * 9 / 5 + 32, fahrenheit_celsius: (f) => (f - 32) * 5 / 9
};
app.get("/jarvis/convert", (req, res) => {
  const from = (req.query.from || "").toLowerCase();
  const to = (req.query.to || "").toLowerCase();
  const val = parseFloat(req.query.value);
  if (isNaN(val)) return res.json({ status: "error", message: "Geçerli sayı girin (value)." });
  const key = `${from}_${to}`;
  if (unitFactors[key] !== undefined) {
    const factor = unitFactors[key];
    const result = typeof factor === "function" ? factor(val) : val * factor;
    res.json({ status: "success", from, to, value: val, result, message: `${val} ${from} = ${result.toFixed(2)} ${to}` });
  } else {
    res.json({ status: "error", message: "Desteklenen çiftler: km-mile, kg-lb, m-ft, cm-inch, celsius-fahrenheit" });
  }
});

// 🎲 ZAR / RASTGELE SAYI (API yok)
app.get("/jarvis/fun/dice", (req, res) => {
  const sides = Math.min(100, Math.max(2, parseInt(req.query.sides, 10) || 6));
  const roll = Math.floor(Math.random() * sides) + 1;
  res.json({ status: "success", sides, roll, message: `${sides} yüzlü zar: ${roll}` });
});
app.get("/jarvis/fun/random", (req, res) => {
  const min = parseInt(req.query.min, 10) || 1;
  const max = parseInt(req.query.max, 10) || 100;
  const roll = min + Math.floor(Math.random() * (max - min + 1));
  res.json({ status: "success", min, max, value: roll, message: `Rastgele (${min}-${max}): ${roll}` });
});

// 📋 HATIRLATICI LİSTE (mevcut DB kullanılıyor)
app.get("/jarvis/reminder/list", (req, res) => {
  const db = readDB();
  const list = (db.reminders || []).slice(-20).map((r, i) => ({ id: i, text: r.text, time: r.time }));
  res.json({ status: "success", reminders: list });
});


//clawdbot işlemleri
app.get("/apps/list", (req, res) => {
  if (isMac) {
    const script = `
      tell application "System Events"
        set appList to name of (processes where background only is false)
      end tell
      return appList
    `;
    exec(`osascript -e '${script}'`, (err, stdout) => {
      if (err) return fail(res, err.message);
      res.json({
        status: "success",
        apps: stdout.trim().split(", ")
      });
    });
  } else if (isWindows) {
    exec(
      `powershell "Get-Process | Where-Object {$_.MainWindowTitle} | Select-Object -ExpandProperty ProcessName"`,
      (err, stdout) => {
        if (err) return fail(res, err.message);
        res.json({
          status: "success",
          apps: stdout.trim().split("\n")
        });
      }
    );
  } else {
    fail(res, "Desteklenmeyen OS");
  }
});
app.post("/apps/focus", (req, res) => {
  const { app } = req.body;
  if (!app) return fail(res, "app gerekli");

  if (isMac) {
    const script = `tell application "${escapeAppleScript(app)}" to activate`;
    return runAppleScript(script, res);
  }

  if (isWindows) {
    exec(
      `powershell "(New-Object -ComObject WScript.Shell).AppActivate('${app}')"`,
      err => err ? fail(res, err.message) : success(res, "Uygulama öne alındı")
    );
  }
});
app.post("/file/open", (req, res) => {
  const { filePath } = req.body;
  if (!filePath) return fail(res, "filePath gerekli");

  if (!fs.existsSync(filePath)) return fail(res, "Dosya yok");

  executeCommand(`"${filePath}"`, res, "Dosya açıldı");
});
app.post("/file/delete", (req, res) => {
  const { filePath } = req.body;
  if (!filePath) return fail(res, "filePath gerekli");

  fs.unlink(filePath, err =>
    err ? fail(res, err.message) : success(res, "Dosya silindi")
  );
});
app.post("/file/move", (req, res) => {
  const { from, to } = req.body;
  if (!from || !to) return fail(res, "from ve to gerekli");

  fs.rename(from, to, err =>
    err ? fail(res, err.message) : success(res, "Dosya taşındı")
  );
});
app.post("/file/exists", (req, res) => {
  const { filePath } = req.body;
  if (!filePath) return fail(res, "filePath gerekli");

  res.json({
    status: "success",
    exists: fs.existsSync(filePath)
  });
});
app.post("/remote/pc", async (req, res) => {
  const { ip, endpoint, data } = req.body;
  if (!ip || !endpoint) return fail(res, "ip ve endpoint gerekli");

  try {
    await axios.post(`http://${ip}:3000${endpoint}`, data || {});
    success(res, "Uzak PC komutu gönderildi");
  } catch (e) {
    fail(res, e.message);
  }
});
app.post("/iot/send", async (req, res) => {
  const { url, method } = req.body;
  if (!url) return fail(res, "url gerekli");

  try {
    await axios({
      method: method || "POST",
      url
    });
    success(res, "IoT komutu gönderildi");
  } catch (e) {
    fail(res, e.message);
  }
});

//test google açma--ayrı testcrome ile bakma!!!
app.get("/agent/maps-pro123", async (req, res) => {
  const query = req.query.q || "istanbul kuaför";

  try {
    const browser = await puppeteer.launch({
      headless: false,
      args: ["--no-sandbox", "--start-maximized"]
    });

    const page = await browser.newPage();

    // gerçek user agent
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36"
    );

    await page.goto("https://www.google.com/maps", {
      waitUntil: "networkidle2",
      timeout: 0
    });

    // uzun bekle — insan gibi
    await new Promise(r => setTimeout(r, 12000));

    // input'u manuel bul
    const inputs = await page.$$("input");
    if (!inputs.length) throw new Error("Hiç input bulunamadı");

    const input = inputs[0];

    await input.click();
    await input.type(query, { delay: 100 });
    await page.keyboard.press("Enter");

    await new Promise(r => setTimeout(r, 9000));

    // scroll results
    for (let i = 0; i < 6; i++) {
      await page.mouse.wheel({ deltaY: 3000 });
      await new Promise(r => setTimeout(r, 2000));
    }

    const leads = await page.evaluate(() => {
      const results = [];

      document.querySelectorAll("a.hfpxzc").forEach(el => {
        const name = el.getAttribute("aria-label") || "";
        const link = el.href;

        if (name) results.push({ name, link });
      });

      return results.slice(0, 20);
    });

    await browser.close();

    res.json({
      status: "success",
      count: leads.length,
      leads
    });

  } catch (err) {
    res.json({
      status: "error",
      message: err.message
    });
  }
});
//denemeler
function takeScreenshot(filePath) {
  return new Promise((resolve, reject) => {
    if (isMac) {
      exec(`screencapture -x "${filePath}"`, err =>
        err ? reject(err) : resolve(filePath)
      );
    } else if (isWindows) {
      const ps = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$bmp = New-Object System.Drawing.Bitmap(
  [System.Windows.Forms.Screen]::PrimaryScreen.Bounds.Width,
  [System.Windows.Forms.Screen]::PrimaryScreen.Bounds.Height
)
$graphics = [System.Drawing.Graphics]::FromImage($bmp)
$graphics.CopyFromScreen(0,0,0,0,$bmp.Size)
$bmp.Save("${filePath}")
`;
      exec(`powershell -NoProfile -Command "${ps.replace(/\n/g, " ")}"`,
        err => err ? reject(err) : resolve(filePath)
      );
    }
  });
}
const Tesseract = require("tesseract.js");

async function findTextOnScreen(imagePath, searchText) {
  const result = await Tesseract.recognize(imagePath, "tur+eng");
  const words = result.data.words;

  const found = words.find(w =>
    w.text &&
    w.text.toLowerCase().includes(searchText.toLowerCase())
  );

  if (!found) return null;

  const { x0, y0, x1, y1 } = found.bbox;
  return {
    x: Math.floor((x0 + x1) / 2),
    y: Math.floor((y0 + y1) / 2)
  };
}
async function smoothMoveMouse(fromX, fromY, toX, toY, steps = 25, delay = 10) {
  const dx = (toX - fromX) / steps;
  const dy = (toY - fromY) / steps;

  for (let i = 1; i <= steps; i++) {
    const x = Math.round(fromX + dx * i);
    const y = Math.round(fromY + dy * i);

    await new Promise(res =>
      exec(
        `${isMac ? "cliclick" : ""} m:${x},${y}`,
        () => res()
      )
    );

    await new Promise(r => setTimeout(r, delay));
  }
}
app.get("/jarvis/control/mouse/click-by-text", async (req, res) => {
  const text = (req.query.text || "").trim();
  if (!text) {
    return res.json({ status: "error", message: "text parametresi gerekli" });
  }

  try {
    const imgPath = path.join(__dirname, "screen.png");

    await takeScreenshot(imgPath);

    const target = await findTextOnScreen(imgPath, text);
    if (!target) {
      return res.json({ status: "error", message: `"${text}" ekranda bulunamadı` });
    }

    // (opsiyonel) mevcut mouse konumu sabit kabul
    const startX = target.x - 80;
    const startY = target.y - 80;

    await smoothMoveMouse(startX, startY, target.x, target.y);

    // mevcut click endpoint’ini kullan
    exec(
      `curl "http://localhost:3000/jarvis/control/mouse/click?x=${target.x}&y=${target.y}"`,
      () => {
        res.json({
          status: "success",
          message: `"${text}" bulundu ve tıklandı`,
          target
        });
      }
    );

  } catch (e) {
    res.json({ status: "error", message: e.message });
  }
});
app.get("/jarvis/files/list", (req, res) => {
  const dir = req.query.path;
  const ext = req.query.ext; // örn: pdf, txt, js

  if (!dir) return fail(res, "path gerekli");

  fs.readdir(dir, { withFileTypes: true }, (err, files) => {
    if (err) return fail(res, err.message);

    let result = files.map(f => ({
      name: f.name,
      type: f.isDirectory() ? "folder" : "file"
    }));

    if (ext) {
      result = result.filter(f => f.name.endsWith("." + ext));
    }

    res.json({ status: "success", files: result });
  });
});
app.get("/jarvis/files/open", (req, res) => {
  const filePath = req.query.path;
  if (!filePath) return fail(res, "path gerekli");

  if (isMac) exec(`open "${filePath}"`);
  else if (isWindows) exec(`start "" "${filePath}"`);
  else exec(`xdg-open "${filePath}"`);

  success(res, "Dosya açıldı");
});
app.get("/jarvis/files/copy", (req, res) => {
  const { from, to } = req.query;
  if (!from || !to) return fail(res, "from ve to gerekli");

  fs.copyFile(from, to, err => {
    if (err) return fail(res, err.message);
    success(res, "Dosya kopyalandı");
  });
});
app.get("/jarvis/files/move", (req, res) => {
  const { from, to } = req.query;
  if (!from || !to) return fail(res, "from ve to gerekli");

  fs.rename(from, to, err => {
    if (err) return fail(res, err.message);
    success(res, "Dosya taşındı");
  });
});
app.get("/jarvis/files/delete", (req, res) => {
  const filePath = req.query.path;
  if (!filePath) return fail(res, "path gerekli");

  fs.unlink(filePath, err => {
    if (err) return fail(res, err.message);
    success(res, "Dosya silindi");
  });
});
app.get("/jarvis/files/read", (req, res) => {
  const filePath = req.query.path;
  if (!filePath) return fail(res, "path gerekli");

  fs.readFile(filePath, "utf8", (err, data) => {
    if (err) return fail(res, err.message);
    res.json({ status: "success", content: data.substring(0, 8000) });
  });
});
app.post("/jarvis/files/write", (req, res) => {
  const { path: filePath, content } = req.body;
  if (!filePath) return fail(res, "path gerekli");

  fs.writeFile(filePath, content || "", err => {
    if (err) return fail(res, err.message);
    success(res, "Dosya yazıldı");
  });
});
app.get("/jarvis/files/summary", async (req, res) => {
  const filePath = req.query.path;
  if (!filePath) return fail(res, "path gerekli");

  try {
    const text = fs.readFileSync(filePath, "utf8").substring(0, 6000);

    const r = await axios.post("http://localhost:11434/api/chat", {
      model: "llama3.1:8b",
      stream: false,
      messages: [
        { role: "system", content: "Metni kısa ve net özetle" },
        { role: "user", content: text }
      ]
    });

    res.json({
      status: "success",
      summary: r.data.message.content
    });
  } catch (e) {
    fail(res, e.message);
  }
});
app.get("/jarvis/mail/filter", (req, res) => {
  const from = req.query.from;
  if (!from) return fail(res, "from gerekli");

  runAppleScript(`
    tell application "Mail"
      set msgs to messages of inbox whose sender contains "${from}"
      set resultList to {}
      repeat with m in msgs
        set end of resultList to subject of m
      end repeat
      return resultList
    end tell
  `, res);
});
app.get("/jarvis/mail/last-summary", async (req, res) => {
  exec(`
osascript <<EOF
tell application "Mail"
  set m to item 1 of messages of inbox
  content of m
end tell
EOF
`, async (err, stdout) => {
    if (err) return fail(res, "Mail okunamadı");

    const r = await axios.post("http://localhost:11434/api/chat", {
      model: "llama3.1:8b",
      stream: false,
      messages: [
        { role: "system", content: "Maili özetle" },
        { role: "user", content: stdout.substring(0, 5000) }
      ]
    });

    res.json({ status: "success", summary: r.data.message.content });
  });
});
app.post("/jarvis/vision/look", async (req, res) => {
  const { image, prompt } = req.body;

  if (!image) {
    return res.json({ status: "error", message: "Görüntü yok" });
  }

  try {
    const base64Image = image.replace(/^data:image\/\w+;base64,/, "");

    const r = await axios.post(
      "http://localhost:11434/api/generate",
      {
        model: "llava",
        prompt: prompt || "What is in this image?",
        images: [base64Image],
        stream: false
      },
      {
        timeout: 300000,
        maxBodyLength: Infinity,   // 🔥 ÇOK ÖNEMLİ
        maxContentLength: Infinity
      }
    );

    res.json({
      status: "success",
      answer: r.data.response
    });

  } catch (e) {
    console.error("❌ Vision error:", e.response?.data || e.message);
    res.status(500).json({
      status: "error",
      message: e.response?.data || e.message
    });
  }
});

app.post("/jarvis/mac/mute", (req, res) => {
  exec(`osascript -e 'set volume with output muted'`);
  res.json({ ok: true });
});

app.post("/jarvis/mac/unmute", (req, res) => {
  exec(`osascript -e 'set volume without output muted'`);
  res.json({ ok: true });
});
app.post("/jarvis/mac/open", (req, res) => {
  const appName = req.body.app;
  exec(`open -a "${appName}"`);
  res.json({ ok: true });
});
app.post("/jarvis/iphone/shortcut", (req, res) => {
  const name = encodeURIComponent(req.body.name);
  exec(`open "shortcuts://run-shortcut?name=${name}"`);
  res.json({ ok: true });
});
app.post("/jarvis/iphone/message", (req, res) => {
  const text = req.body.text || "Merhaba";
  exec(`
osascript -e '
tell application "Messages"
  send "${text}" to buddy "NUMARA_VEYA_APPLEID" of service "iMessage"
end tell'
`);
  res.json({ ok: true });
});
app.post("/jarvis/iphone/call", (req, res) => {
  const who = req.body.target;
  exec(`open "facetime://${who}"`);
  res.json({ ok: true });
});
app.post("/jarvis/iphone/airdrop", (req, res) => {
  const file = req.body.path;
  exec(`open "${file}"`);
  res.json({ ok: true });
});
app.post("/jarvis/mac/continuity-camera", (req, res) => {
  exec(`open -a "Photo Booth"`);
  res.json({ ok: true });
});
app.get("/jarvis/file/to-excel", async (req, res) => {
  const filePath = path.join(process.env.HOME, "Desktop", "notlar.txt");
  const lines = fs.readFileSync(filePath, "utf8")
    .split("\n")
    .filter(Boolean);

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Liste");

  sheet.columns = [
    { header: "No", key: "no", width: 10 },
    { header: "Metin", key: "text", width: 40 }
  ];

  lines.forEach((line, i) => {
    sheet.addRow({ no: i + 1, text: line });
  });

  const output = path.join(process.env.HOME, "Desktop", "liste.xlsx");
  await workbook.xlsx.writeFile(output);

  res.json({ ok: true, file: "liste.xlsx" });
});
app.get("/jarvis/file/to-word", async (req, res) => {
  const filePath = path.join(process.env.HOME, "Desktop", "notlar.txt");
  const lines = fs.readFileSync(filePath, "utf8")
    .split("\n")
    .filter(Boolean);

  const doc = new Document({
    sections: [{
      children: lines.map(line =>
        new Paragraph({
          text: line,
          bullet: { level: 0 }
        })
      )
    }]
  });

  const buffer = await Packer.toBuffer(doc);
  const output = path.join(process.env.HOME, "Desktop", "liste.docx");
  fs.writeFileSync(output, buffer);

  res.json({ ok: true, file: "liste.docx" });
});
app.get("/jarvis/scrape/to-excel", async (req, res) => {
  const url = req.query.url;

  if (!url) {
    return res.status(400).json({ error: "url parametresi lazım" });
  }

  const browser = await puppeteer.launch({
    headless: true
  });

  const page = await browser.newPage();
  await page.goto(url, { waitUntil: "networkidle2" });

  // ÖRNEK SELECTORLER (siteye göre değişir!)
  const products = await page.evaluate(() => {
    return Array.from(document.querySelectorAll(".product")).map(p => ({
      title: p.querySelector(".title")?.innerText || "",
      price: p.querySelector(".price")?.innerText || "",
      link: p.querySelector("a")?.href || ""
    }));
  });

  await browser.close();

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Urunler");

  sheet.columns = [
    { header: "No", key: "no", width: 8 },
    { header: "Ürün", key: "title", width: 40 },
    { header: "Fiyat", key: "price", width: 15 },
    { header: "Link", key: "link", width: 50 }
  ];

  products.forEach((p, i) => {
    sheet.addRow({
      no: i + 1,
      title: p.title,
      price: p.price,
      link: p.link
    });
  });

  const output = path.join(process.env.HOME, "Desktop", "urunler.xlsx");
  await workbook.xlsx.writeFile(output);

  res.json({
    ok: true,
    count: products.length,
    file: "urunler.xlsx"
  });
});
app.get("/jarvis/scrape/to-word", async (req, res) => {
  const url = req.query.url;

  const browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto(url, { waitUntil: "networkidle2" });

  const products = await page.evaluate(() => {
    return Array.from(document.querySelectorAll(".product")).map(p => ({
      title: p.querySelector(".title")?.innerText || "",
      price: p.querySelector(".price")?.innerText || ""
    }));
  });

  await browser.close();

  const doc = new Document({
    sections: [{
      children: products.map((p, i) =>
        new Paragraph({
          text: `${i + 1}. ${p.title} – ${p.price}`
        })
      )
    }]
  });

  const buffer = await Packer.toBuffer(doc);
  const output = path.join(process.env.HOME, "Desktop", "urunler.docx");
  fs.writeFileSync(output, buffer);

  res.json({ ok: true, file: "urunler.docx" });
});
app.post("/jarvis/whatsapp/send", async (req, res) => {
  const { to, text } = req.body;

  if (!to || !text) {
    return res.status(400).json({
      ok: false,
      error: "to ve text zorunlu"
    });
  }

  try {
    const browser = await puppeteer.launch({
      headless: false,
      defaultViewport: null,
      args: ["--start-maximized"]
    });

    const page = await browser.newPage();

    await page.goto("https://web.whatsapp.com", {
      waitUntil: "networkidle2"
    });

    // QR OKUTULANA KADAR BEKLE
    await page.waitForSelector('div[contenteditable="true"]', {
      timeout: 0
    });

    /* =========================
       1️⃣ SOHBET / KİŞİ AÇ
    ========================== */

    // Arama kutusunu temizle
    await page.click('div[contenteditable="true"]');
    await page.keyboard.down("Control");
    await page.keyboard.press("A");
    await page.keyboard.up("Control");
    await page.keyboard.press("Backspace");

    // Kişi adını yaz
    await page.type('div[contenteditable="true"]', to, { delay: 60 });
    await page.waitForTimeout(800);
    await page.keyboard.press("Enter");

    /* =========================
       2️⃣ MESAJ GÖNDER
    ========================== */

    // Mesaj alanı
    await page.waitForSelector('div[contenteditable="true"][data-tab]', {
      timeout: 0
    });

    await page.type(
      'div[contenteditable="true"][data-tab]',
      text,
      { delay: 40 }
    );

    await page.keyboard.press("Enter");

    res.json({
      ok: true,
      to,
      text,
      status: "Mesaj gönderildi"
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({
      ok: false,
      error: err.message
    });
  }
});

app.post("/jarvis/whatsapp/send-file", async (req, res) => {
  const { to, text, file } = req.body;

  const filePath = path.join(process.env.HOME, "Desktop", file);

  const browser = await puppeteer.launch({
    headless: false,
    defaultViewport: null,
    args: ["--start-maximized"]
  });

  const page = await browser.newPage();
  await page.goto("https://web.whatsapp.com", { waitUntil: "networkidle2" });

  // QR + hazır ol
  await page.waitForSelector('div[contenteditable="true"]', { timeout: 0 });

  // sohbet ara
  await page.type('div[contenteditable="true"]', to);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(800);

  // ataç butonu
  await page.click('span[data-icon="attach"]');

  // file input
  const input = await page.$('input[type="file"]');
  await input.uploadFile(filePath);

  // mesaj varsa yaz
  if (text) {
    await page.waitForSelector('div[contenteditable="true"][data-tab]', { timeout: 0 });
    await page.type('div[contenteditable="true"][data-tab]', text);
  }

  await page.keyboard.press("Enter");

  res.json({ ok: true, platform: "whatsapp", file });
});
app.post("/jarvis/gmail/send-file", async (req, res) => {
  const { to, subject, text, file } = req.body;
  const filePath = path.join(process.env.HOME, "Desktop", file);

  const browser = await puppeteer.launch({ headless: false });
  const page = await browser.newPage();
  await page.goto("https://mail.google.com", { waitUntil: "networkidle2" });

  // giriş yapılmış olmalı
  await page.waitForSelector(".T-I.T-I-KE.L3");

  // yeni mail
  await page.click(".T-I.T-I-KE.L3");

  await page.waitForSelector('textarea[name="to"]');
  await page.type('textarea[name="to"]', to);
  await page.type('input[name="subjectbox"]', subject);
  await page.type('div[aria-label="Message Body"]', text);

  // dosya ekle
  const fileInput = await page.$('input[type="file"]');
  await fileInput.uploadFile(filePath);

  await page.waitForTimeout(2000);
  await page.keyboard.press("Control");
  await page.keyboard.press("Enter");
  await page.keyboard.up("Control");

  res.json({ ok: true, platform: "gmail" });
});
app.post("/music/apple/next", (req, res) => {
  runAppleScript(`tell application "Music" to next track`, res);
});

app.post("/music/apple/prev", (req, res) => {
  runAppleScript(`tell application "Music" to previous track`, res);
});
app.post("/music/apple/volume", (req, res) => {
  const level = Math.min(100, Math.max(0, req.body.level || 50));
  runAppleScript(`tell application "Music" to set sound volume to ${level}`, res);
});
app.post("/music/apple/mute", (req, res) => {
  runAppleScript(`tell application "Music" to set mute to true`, res);
});

app.post("/music/apple/unmute", (req, res) => {
  runAppleScript(`tell application "Music" to set mute to false`, res);
});
app.post("/music/apple/play-track", (req, res) => {
  const name = req.body.name;
  runAppleScript(`
    tell application "Music"
      play (first track whose name contains "${name}")
    end tell
  `, res);
});
app.get("/music/apple/status", (req, res) => {
  runAppleScript(`
    tell application "Music"
      if player state is playing then
        return name of current track & " - " & artist of current track
      else
        return "Çalmıyor"
      end if
    end tell
  `, res);
});
app.post("/music/spotify/play", (req, res) => {
  runAppleScript(`tell application "Spotify" to play`, res);
});

app.post("/music/spotify/pause", (req, res) => {
  runAppleScript(`tell application "Spotify" to pause`, res);
});

app.post("/music/spotify/next", (req, res) => {
  runAppleScript(`tell application "Spotify" to next track`, res);
});

app.post("/music/spotify/prev", (req, res) => {
  runAppleScript(`tell application "Spotify" to previous track`, res);
});
app.post("/music/spotify/volume", (req, res) => {
  const level = Math.min(100, Math.max(0, req.body.level || 50));
  runAppleScript(`tell application "Spotify" to set sound volume to ${level}`, res);
});
app.post("/music/spotify/play-track", (req, res) => {
  const name = req.body.name;
  runAppleScript(`
    tell application "Spotify"
      play track (first track whose name contains "${name}")
    end tell
  `, res);
});
app.get("/music/spotify/status", (req, res) => {
  runAppleScript(`
    tell application "Spotify"
      if player state is playing then
        return name of current track & " - " & artist of current track
      else
        return "Çalmıyor"
      end if
    end tell
  `, res);
});
app.post("/convert/word-to-pdf", (req, res) => {
  const inputPath = req.body.inputPath;
  // örnek: /Users/kaan/Desktop/test.docx

  if (!inputPath || !fs.existsSync(inputPath)) {
    return res.status(400).json({ ok: false, error: "Dosya bulunamadı" });
  }

  const outputDir = path.dirname(inputPath);

  const cmd = `soffice --headless --convert-to pdf "${inputPath}" --outdir "${outputDir}"`;

  exec(cmd, (err, stdout, stderr) => {
    if (err) {
      return res.json({
        ok: false,
        error: stderr || err.message
      });
    }

    res.json({
      ok: true,
      message: "PDF başarıyla oluşturuldu",
      outputDir
    });
  });
});
app.post("/jarvis/download", async (req, res) => {
  const { url, filename } = req.body;

  if (!url) return fail(res, "URL yok");

  const downloadsPath = isMac
    ? path.join(process.env.HOME, "Downloads")
    : path.join(process.env.USERPROFILE, "Downloads");

  const name = filename || path.basename(url.split("?")[0]);
  const filePath = path.join(downloadsPath, name);

  try {
    const response = await axios({
      method: "GET",
      url,
      responseType: "stream"
    });

    const writer = fs.createWriteStream(filePath);
    response.data.pipe(writer);

    writer.on("finish", () => {
      res.json({
        status: "success",
        message: "Dosya indirildi",
        path: filePath
      });
    });

    writer.on("error", err => fail(res, err.message));
  } catch (e) {
    fail(res, e.message);
  }
});
app.post("/jarvis/open", (req, res) => {
  const { targetPath } = req.body;

  if (!targetPath || !fs.existsSync(targetPath)) {
    return fail(res, "Dosya bulunamadı");
  }

  let cmd;
  if (isMac) cmd = `open "${targetPath}"`;
  if (isWindows) cmd = `start "" "${targetPath}"`;

  executeCommand(cmd, res, "Dosya açıldı");
});
app.post("/jarvis/install/mac", (req, res) => {
  const { path: filePath } = req.body;
  if (!fs.existsSync(filePath)) return fail(res, "Dosya yok");

  executeCommand(`open "${filePath}"`, res, "Kurulum başlatıldı");
});

app.post("/jarvis/install/windows", (req, res) => {
  const { path: filePath } = req.body;
  if (!fs.existsSync(filePath)) return fail(res, "Dosya yok");

  executeCommand(`"${filePath}"`, res, "Installer çalıştırıldı");
});
app.post("/jarvis/save-desktop", (req, res) => {
  const { name, content } = req.body;
  if (!name || !content) return fail(res, "Eksik veri");

  writeCodeToDesktop(name, content);
  success(res, "Dosya masaüstüne kaydedildi");
});
app.post("/jarvis/word-to-pdf", (req, res) => {
  const { inputPath } = req.body;
  if (!fs.existsSync(inputPath)) return fail(res, "Dosya yok");

  const outDir = path.dirname(inputPath);
  const cmd = `soffice --headless --convert-to pdf "${inputPath}" --outdir "${outDir}"`;

  exec(cmd, err => {
    if (err) return fail(res, err.message);
    success(res, "PDF oluşturuldu");
  });
});

// 👁️ EKRAN GÖRME ENDPOINT'İ
app.post("/jarvis/vision/analyze", async (req, res) => {
  try {
    // 1. Ekran görüntüsü al
    const imgBuffer = await screenshot({ format: 'png' });

    // 2. Resmi Vision Modelin anlayacağı formata çevir (Base64)
    const imgBase64 = imgBuffer.toString('base64');

    // 3. Vision Model'e (Örn: GPT-4o veya LLaVA) sor
    // NOT: Burası senin Ollama veya OpenAI API çağrın olacak.
    const prompt = req.body.prompt || "Ekranda ne görüyorsun? Açık olan pencereleri listele.";

    // ÖRNEK OLLAMA VISION ÇAĞRISI (Llava vb. için)
    const visionResponse = await axios.post("http://localhost:11434/api/generate", {
      model: "llava", // Veya "moondream" (daha hızlıdır)
      prompt: prompt,
      images: [imgBase64],
      stream: false
    });

    res.json({
      status: "success",
      analysis: visionResponse.data.response,
      // Koordinat tespiti için bu veri daha sonra işlenebilir
    });

  } catch (e) {
    console.error(e);
    res.json({ status: "error", message: e.message });
  }
});
app.post("/app/open", (req, res) => {
  const appName = req.body.app;
  if (!appName) return fail(res, "app gerekli");
  if (isMac) exec(`open -a "${appName}"`);
  if (isWindows) exec(`start "" "${appName}"`);
  success(res, `${appName} açıldı`);
});

app.post("/app/type", (req, res) => {
  const text = escapeAppleScript(req.body.text || "");
  runAppleScript(`tell application "System Events"\nkeystroke "${text}"\nend tell`, res);
});
// =============================================================================
//  AŞAĞIDAKİ KODLARI SERVER.JS DOSYASININ EN ALTINA YAPIŞTIR
// =============================================================================

// --- GEREKLİ EKSTRA KÜTÜPHANELER ---
// (Eğer bu kütüphaneler yüklü değilse hata verir: npm install robotjs chokidar uuid pptxgenjs sharp)
//const robot = require("robotjs");
const chokidar = require("chokidar");
const { v4: uuidv4 } = require("uuid");
const PptxGenJS = require("pptxgenjs");
const sharp = require("sharp");
const os = require("os");

// --- BASİT GÖREV KUYRUĞU (TASK QUEUE) ---
const taskQueue = [];
let taskRunning = false;
let currentTask = null;

function enqueueTask(task) {
  task.id = Date.now() + "_" + Math.random().toString(36).slice(2);
  task.status = "queued";
  taskQueue.push(task);
  runTaskQueue();
}

async function runTaskQueue() {
  if (taskRunning || taskQueue.length === 0) return;

  taskRunning = true;
  currentTask = taskQueue.shift();
  currentTask.status = "running";

  try {
    if (currentTask.steps && Array.isArray(currentTask.steps)) {
      for (let step of currentTask.steps) {
        // Step bir fonksiyon ise çalıştır
        if (typeof step === 'function') {
          await step();
        } else if (step.run) {
          await step.run();
        }
      }
    }
    currentTask.status = "done";
  } catch (err) {
    currentTask.status = "failed";
    currentTask.error = err.message;
    console.error("Task Hatası:", err);
  }

  taskRunning = false;
  currentTask = null;
  runTaskQueue();
}

app.post("/jarvis/task", (req, res) => {
  enqueueTask(req.body);
  res.json({ status: "queued", task: req.body });
});

// --- KARAR MEKANİZMASI (DECISION ENGINE) ---
function decisionEngine(context) {
  if (context.url && /crack|warez|torrent/i.test(context.url)) {
    return { allow: false, reason: "riskli_url" };
  }
  if (context.app && isMac && fs.existsSync(`/Applications/${context.app}.app`)) {
    return { allow: false, reason: "zaten_yuklu" };
  }
  return { allow: true };
}

// --- EKRAN GÖRÜNTÜSÜ VE AKTİF UYGULAMA YARDIMCILARI ---
function getActiveAppName() {
  return new Promise((resolve, reject) => {
    if (isMac) {
      const script = 'tell application "System Events" to get name of first application process whose frontmost is true';
      const osa = spawn("osascript", ["-e", script]);
      let out = "";
      osa.stdout.on("data", d => out += d.toString());
      osa.on("close", () => resolve(out.trim()));
    } else {
      // Windows için basit fallback
      resolve("Unknown (Win)");
    }
  });
}

function captureScreen(filePath) {
  return new Promise((resolve, reject) => {
    screenshot({ format: 'png' }).then((img) => {
      fs.writeFileSync(filePath, img);
      resolve(filePath);
    }).catch((err) => {
      reject(err);
    });
  });
}

// --- DOSYA İZLEME (CHOKIDAR) ---
const downloadsWatcher = chokidar.watch(
  isMac ? path.join(process.env.HOME, "Downloads") : path.join(process.env.USERPROFILE, "Downloads"),
  { ignoreInitial: true }
);

downloadsWatcher.on("add", file => {
  console.log("📥 Yeni dosya indirildi:", file);
  brain.mem.remember(`download:${path.basename(file)}`, file, 0.6);
  brain.attention.addTask(`İndirilen dosya: ${path.basename(file)}`, async () => { }, 1, "download");
});

// =====================================================
// 🤖 CLAWDBOT-STYLE OTONOM AJAN (Local Variables)
// =====================================================

const AGENT_STATE = {
  busy: false,
  lastGoal: null,
  retries: 0,
  lastError: null
};

// Ajan Hafızası
const MEM_PATH = "./agent_memory.json";
let MEMORY = fs.existsSync(MEM_PATH)
  ? JSON.parse(fs.readFileSync(MEM_PATH, "utf8"))
  : { goals: [], facts: [] };

const saveMem = () => fs.writeFileSync(MEM_PATH, JSON.stringify(MEMORY, null, 2));
// Tool / Aksiyon geçmişi yoksa oluştur
// Düzeltilmiş:
if (!MEMORY.actionHistory) MEMORY.actionHistory = [];
if (!MEMORY.goals) MEMORY.goals = [];
if (!MEMORY.facts) MEMORY.facts = [];
// Ajan Araçları (Existing endpoints wrapper)
async function callLocalEndpoint(endpoint) {
  try {
    const response = await axios.get(`http://localhost:${PORT}${endpoint}`);
    return response.data;
  } catch (e) {
    return { error: e.message };
  }
}

// --- YENİLENMİŞ VE GÜÇLENDİRİLMİŞ ARAÇLAR ---
const CLAW_TOOLS = {
  browser_open: async (a = {}) => {
    if (!a.url) throw new Error("browser_open: url eksik");

    WORLD_STATE.currentTool = "browser_open";
    WORLD_STATE.vision.url = a.url;

    return callLocalEndpoint(
      `/jarvis/safari/open?text=${encodeURIComponent(a.url)}`
    );
  },
  click: (a) => callLocalEndpoint(`/jarvis/control/mouse/click?x=${a.x}&y=${a.y}`),
  move: (a) => callLocalEndpoint(`/jarvis/control/mouse/move?x=${a.x}&y=${a.y}`),
  type: (a) => callLocalEndpoint(`/jarvis/control/keyboard/type?text=${encodeURIComponent(a.text)}`),
  press_enter: () => callLocalEndpoint(`/jarvis/control/keyboard/key?key=enter`),
  run_terminal: async (a) => {
    if (a.command) {
      a.command = a.command.replace(
        /google-chrome\s+(--new-tab\s+)?/gi,
        'open '
      );
    }
    return new Promise((resolve, reject) => {
      require('child_process').exec(a.command, { shell: true }, (err, stdout, stderr) => {
        if (err) {
          console.error("❌ Terminal hata:", err.message, "\nSTDERR:", stderr);
          reject(new Error(stderr || err.message));
        } else {
          console.log("✅ Terminal çıktı:", stdout);
          resolve(stdout || "OK");
        }
      });
    });
  },
  scroll: (a) => callLocalEndpoint(`/jarvis/control/mouse/scroll?dir=${a.dir}`),
  screenshot: () => callLocalEndpoint(`/jarvis/screenshot`),
  read_dom: async (a) => {
    const { selector } = a;

    if (!waPage) {
      throw new Error("Aktif tarayıcı yok");
    }

    const result = await waPage.evaluate((sel) => {
      const el = document.querySelector(sel);
      return el ? el.innerText : null;
    }, selector);

    return result;
  },
  fill_form: async (a) => {
    const { selector, value } = a;

    await waPage.waitForSelector(selector);
    await waPage.focus(selector);
    await waPage.evaluate(sel => {
      document.querySelector(sel).value = "";
    }, selector);
    await waPage.type(selector, value);
  },

  submit_form: async (a) => {
    const { selector } = a;
    await waPage.click(selector);
  },
  http_get: async (a) => {
    const { url } = a;
    const r = await axios.get(url);
    return r.data;
  },
  wait: (a) => new Promise(r => setTimeout(r, a.ms || 1000))
};

async function agentPlan(goal, vision = "") {
  const prompt = `
Sen bilgisayarı kontrol eden otonom bir asistansın.
AMAÇ: "${goal}"

Mevcut Araçlar: ${Object.keys(CLAW_TOOLS).join(", ")}

KURAL:
- Klasör/dosya işlemleri için SADECE "run_terminal" kullan
- SADECE JSON ARRAY döndür, başka hiçbir şey yazma
- "run_terminal" için args: {"command": "terminal komutu"}

ÖRNEKLER:
Klasör oluştur → [{"tool":"run_terminal","args":{"command":"mkdir -p test"}}]
Dosya oluştur → [{"tool":"run_terminal","args":{"command":"touch dosya.txt"}}]
Dosya listele → [{"tool":"run_terminal","args":{"command":"ls -la"}}]

ŞİMDİ SADECE JSON DÖNDÜR:
`;

  try {
    const r = await axios.post("http://localhost:11434/api/chat", {
      model: "llama3.1:8b",
      stream: false,
      messages: [{ role: "user", content: prompt }]
    });

    let content = r.data?.message?.content;

    // 1️⃣ Eğer zaten array ise (nadiren olur ama olur)
    if (Array.isArray(content)) {
      return content;
    }

    // 2️⃣ String değilse → çöpe at
    if (typeof content !== "string") {
      console.error("⚠️ Plan string değil:", content);
      return [];
    }

    // 3️⃣ JSON ARRAY yakala
    const match = content.match(/\[[\s\S]*\]/);
    if (!match) {
      console.error("⚠️ JSON bulunamadı:", content);
      return [];
    }

    // 4️⃣ Güvenli parse
    return JSON.parse(match[0]);

  } catch (e) {
    console.error("❌ Planlama Hatası:", e.message);
    return [];
  }
}

async function verifyFileExists(path) {
  return fs.existsSync(path);
}
// Otonom Ajan Endpoint
app.post("/agent/autonomous", async (req, res) => {
  const { goal } = req.body;
  if (!goal) return res.json({ status: "error", message: "Goal gerekli" });

  if (AGENT_STATE.busy) return res.json({ status: "busy", message: "Ajan şu an meşgul." });

  AGENT_STATE.busy = true;
  res.json({ status: "started", goal });

  try {
    // 1. Ekranı gör (Opsiyonel vision analizi buraya eklenebilir)
    const vision = "";
    // 2. Planla
    const plan = await agentPlan(goal, vision);
    // 3. Uygula
    const fixedPlan = normalizePlan(plan);
    console.log("🛠️ NORMALIZE PLAN:", fixedPlan);
    await agentExecute(fixedPlan);

    MEMORY.goals.push({ goal, success: true, ts: Date.now() });
    saveMem();
  } catch (e) {
    console.error("Ajan Hatası:", e);
    MEMORY.goals.push({ goal, success: false, error: e.message, ts: Date.now() });
  } finally {
    AGENT_STATE.busy = false;
  }
});


// =====================================================
// 🧠 SÜREKLİ FARKINDALIK (ALWAYS-ON AWARENESS)
// =====================================================
const AWARE_STATE = {
  lastClipboard: "",
  lastActiveApp: "",
  lastCheck: Date.now()
};

function checkClipboard() {
  if (isMac) {
    exec("pbpaste", (err, stdout) => {
      if (!err && stdout && stdout !== AWARE_STATE.lastClipboard) {
        AWARE_STATE.lastClipboard = stdout;
        console.log("📋 Pano değişti (Analiz edilebilir):", stdout.substring(0, 50));
        // Buradan 'agentPlan' tetiklenebilir: "Panodaki metni özetle" gibi.
      }
    });
  }
}

// 5 Saniyede bir arka plan kontrolü
setInterval(() => {
  checkClipboard();
}, 5000);


// =====================================================
// 📁 DOSYA -> PPTX -> MAIL OTOMASYONU
// =====================================================
// *Not: server.js başında tanımlı olan nodemailer'ı kullanır.
// *GMAIL_CONFIG yukarıda tanımlı varsayılmıştır.

const PPT_WATCH_DIR = path.join(process.env.HOME || process.env.USERPROFILE, "Desktop", "agent_inbox");
const PPT_OUT_DIR = path.join(process.env.HOME || process.env.USERPROFILE, "Desktop", "agent_outbox");

if (!fs.existsSync(PPT_WATCH_DIR)) fs.mkdirSync(PPT_WATCH_DIR, { recursive: true });
if (!fs.existsSync(PPT_OUT_DIR)) fs.mkdirSync(PPT_OUT_DIR, { recursive: true });

async function convertToPPTX(filePath) {
  const name = path.basename(filePath);
  const outPath = path.join(PPT_OUT_DIR, name + ".pptx");

  // Basit bir PPT oluşturma (gerçek convert için libreoffice gerekir, burada demo yapıyoruz)
  const ppt = new PptxGenJS();
  const slide = ppt.addSlide();
  slide.addText(`Dosya: ${name}`, { x: 1, y: 1, fontSize: 24 });
  slide.addText(`Bu sunum otomatik oluşturuldu.`, { x: 1, y: 2, fontSize: 14 });

  await ppt.writeFile({ fileName: outPath });
  return outPath;
}

// Bu klasöre dosya atıldığında tetiklenir
chokidar.watch(PPT_WATCH_DIR, { ignoreInitial: true }).on("add", async (filePath) => {
  console.log("📄 Sunum için dosya algılandı:", filePath);
  try {
    const pptxPath = await convertToPPTX(filePath);
    console.log("✅ PPTX Oluşturuldu:", pptxPath);
    // Mail gönderme opsiyonel, yukarıdaki mail fonksiyonlarını kullanabilirsin.
  } catch (e) {
    console.error("PPTX Çeviri hatası:", e);
  }
});


// =====================================================
// 🌐 WHATSAPP & INSTAGRAM (PUPPETEER - WEB VERSION)
// =====================================================
// Not: Yukarıdaki AppleScript endpointleri ile çakışmaması için 
// bu route'ları "/web-send" olarak isimlendirdim.
async function zipDirectory(sourceDir, outPath) {
  const archive = archiver("zip", { zlib: { level: 9 } });
  const stream = fs.createWriteStream(outPath);

  return new Promise((resolve, reject) => {
    archive
      .directory(sourceDir, false)
      .on("error", err => reject(err))
      .pipe(stream);

    stream.on("close", () => resolve(outPath));
    archive.finalize();
  });
}
// WhatsApp Başlatma (Gizlilik eklentisi hatası giderilmiş hali)
async function startWhatsAppWeb(headless = false) {
  if (waBrowser) return; // Zaten açıksa çık

  console.log("🌐 WhatsApp Web Başlatılıyor...");
  waBrowser = await puppeteer.launch({
    headless: headless,
    userDataDir: "./wa-session",
    args: ["--no-sandbox", "--disable-setuid-sandbox"]
  });

  // Yeni sayfa açmak yerine var olan ilk boş sekmeyi al (Daha stabil çalışır)
  const pages = await waBrowser.pages();
  waPage = pages.length > 0 ? pages[0] : await waBrowser.newPage();

  await waPage.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36");

  try {
    // Stealth eklentisinin patlama ihtimaline karşı try-catch
    await waPage.goto("https://web.whatsapp.com", { waitUntil: "domcontentloaded", timeout: 60000 });
  } catch (err) {
    console.log("⚠️ Eklenti engeli algılandı, JavaScript ile yönlendirme deneniyor...");
    // Hata verirse eklentiyi atlatıp tarayıcının kendi içiyle yönlendirme yap
    await waPage.evaluate(() => { window.location.href = "https://web.whatsapp.com"; });
    await new Promise(r => setTimeout(r, 5000)); // Yüklenmesi için bekle
  }

  waReady = true;
  console.log("✅ WhatsApp Web Hazır (Açılan tarayıcıdan QR okutulmuş olmalı)");
}

// WhatsApp Web Mesaj Gönder
app.post("/jarvis/whatsapp/web-send", async (req, res) => {
  const { to, message } = req.body;
  if (!waBrowser) await startWhatsAppWeb(false); // Otomatik başlat

  try {
    // Kişi arama
    const searchBox = 'div[contenteditable="true"][data-tab="3"]';
    await waPage.waitForSelector(searchBox);
    await waPage.click(searchBox);

    // Temizle ve yaz
    await waPage.evaluate((sel) => document.querySelector(sel).innerText = '', searchBox);
    await waPage.type(searchBox, to);
    await waPage.keyboard.press("Enter");
    await new Promise(r => setTimeout(r, 1500)); // Bekle

    // Mesaj yazma
    const messageBox = 'div[contenteditable="true"][data-tab="10"]';
    await waPage.waitForSelector(messageBox);
    await waPage.type(messageBox, message);
    await waPage.keyboard.press("Enter");

    res.json({ status: "success", method: "web", to });
  } catch (e) {
    console.error(e);
    res.json({ status: "error", message: e.message });
  }
});


// =====================================================
// 📧 GMAIL OTOMASYON (IMAP/SMTP - AUTO REPLY)
// =====================================================
// Mevcut GMAIL_CONFIG kullanılıyor.

async function sendMailSimple(to, subject, text) {
  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: {
      user: GMAIL_CONFIG.user,
      pass: GMAIL_CONFIG.pass
    }
  });

  await transporter.sendMail({
    from: `"Jarvis AI" <${GMAIL_CONFIG.user}>`,
    to,
    subject,
    text
  });
}

// Okunmamış mailleri kontrol etme fonksiyonu
async function checkUnreadMails() {
  try {
    const connection = await imaps.connect(GMAIL_CONFIG.imap);
    await connection.openBox("INBOX");

    const searchCriteria = ["UNSEEN"];
    const fetchOptions = { bodies: ["HEADER", "TEXT"], markSeen: true };
    const results = await connection.search(searchCriteria, fetchOptions);

    for (const r of results) {
      const part = r.parts.find(p => p.which === "TEXT");
      if (part) {
        const parsed = await simpleParser(part.body);
        console.log(`📧 Yeni Mail: ${parsed.subject} - Kimden: ${parsed.from.text}`);

        // Basit Otomatik Cevap Mantığı
        if (parsed.text.toLowerCase().includes("fiyat")) {
          const replyTo = parsed.from.value[0].address;
          await sendMailSimple(replyTo, "Re: " + parsed.subject, "Fiyat listemiz ektedir. (Otomatik Cevap)");
          console.log("↩️ Otomatik cevap gönderildi.");
        }
      }
    }
    connection.end();
  } catch (e) {
    // Hata olursa sessiz kal (bağlantı hatası vs.)
    console.log("Mail kontrol hatası (geçici olabilir):", e.message);
  }
}

// Her 60 saniyede bir mail kontrolü
setInterval(() => {
  // Config doluysa çalıştır
  if (GMAIL_CONFIG.user !== "mail@gmail.com") {
    checkUnreadMails();
  }
}, 60000);

// SMTP üzerinden mail gönderme (AppleScript değil)
app.post("/jarvis/gmail/smtp/send", async (req, res) => {
  try {
    const { to, subject, text } = req.body;
    await sendMailSimple(to, subject, text);
    res.json({ status: "success", method: "smtp" });
  } catch (e) {
    res.json({ status: "error", message: e.message });
  }
});


// =====================================================
// 💻 VSCODE & KODLAMA AJANI (LOCAL CONTROL)
// =====================================================

app.post("/agent/code/write", async (req, res) => {
  const { request } = req.body;
  // Ollama'ya kod yazdır
  try {
    const r = await axios.post("http://localhost:11434/api/generate", {
      model: "llama3.1:8b",
      prompt: `Şu isteğe göre çalışan bir kod yaz. Sadece kodu ver, markdown kullanma:\n\n${request}`,
      stream: false
    });
    brain.mem.remember(`code:${request.substring(0, 40)}`, "yazıldı", 0.6);
    brain.onAgentDone("code/write", [], "success");
    res.json({ status: "success", code: r.data.response });
  } catch (e) {
    res.json({ status: "error", message: e.message });
  }
});

app.post("/agent/project/analyze", async (req, res) => {
  // Proje klasörünü tara
  const projectDir = req.body.path || __dirname;
  fs.readdir(projectDir, async (err, files) => {
    if (err) return res.json({ error: err.message });

    // Dosya listesini Ollama'ya sor
    try {
      const r = await axios.post("http://localhost:11434/api/generate", {
        model: "llama3.1:8b",
        prompt: `Bu dosya yapısına bakarak projenin ne olduğunu ve eksiklerini söyle:\n${files.join(", ")}`,
        stream: false
      });
      brain.mem.remember(`project_analysis:${projectDir.split('/').pop()}`, r.data.response.substring(0, 150), 0.8);
      res.json({ status: "success", analysis: r.data.response });
    } catch (e) {
      res.json({ error: e.message });
    }
  });
});

// =====================================================
// 🎮 ROBOTJS İLE MOUSE/KLAVYE KONTROL (CROSS-PLATFORM)
// =====================================================

app.post("/control/robot/type", (req, res) => {
  const { text } = req.body;
  //robot.typeString(text);
  res.json({ status: "success" });
});

app.post("/control/robot/click", (req, res) => {
  const { x, y } = req.body;
  robot.moveMouse(x, y);
  robot.mouseClick();
  res.json({ status: "success" });
});

// =====================================================
// 🧠 MULTI-AGENT ORCHESTRATOR (FINAL BOSS)
// =====================================================

async function multiAgentTask(role, task) {
  const r = await axios.post("http://localhost:11434/api/generate", {
    model: "llama3.1:8b",
    prompt: `Rolün: ${role}. Görevin: ${task}. Sadece sonucu ver.`,
    stream: false
  });
  return r.data.response;
}

app.post("/agent/multi-role", async (req, res) => {
  const { goal } = req.body;

  try {
    // 1. Planlayıcı
    const plan = await multiAgentTask("PROJE YÖNETİCİSİ", `${goal} için adım adım plan yap.`);

    // 2. Yazılımcı (İlk adımı uygula varsayalım)
    const code = await multiAgentTask("KIDEMLİ YAZILIMCI", `Şu plana göre kod örneği yaz: ${plan}`);

    // 3. Testçi
    const test = await multiAgentTask("QA MÜHENDİSİ", `Bu kodda güvenlik açığı var mı?: ${code}`);
    brain.mem.remember(`multi_role:${goal.substring(0, 40)}`, plan.substring(0, 100), 0.7);
    brain.onAgentDone("multi-role", [], "success");
    res.json({
      plan,
      code,
      test_report: test
    });
  } catch (e) {
    res.json({ error: e.message });
  }
});

console.log("✅ Gelişmiş Ajan Modülleri ve Otonom Sistemler Yüklendi.");
// =====================================================
// 🧩 CLAWDBOT UYUMLULUK EK PAKETİ (SAFE MERGE VERSION)
// Mevcut kodu BOZMAZ, sadece üzerine ekler
// =====================================================

// -----------------------------
// 🔐 GÜVENLİK + YETKİ KATMANI
// -----------------------------
const PERMISSIONS = {
  run_terminal: true,
  browser_open: true,
  click: true,
  move: true,
  type: true,
  press_enter: true,
  scroll: true,
  screenshot: true,
  wait: true,
  robot: true,
  mail: true
};

function guard(toolName) {
  if (PERMISSIONS[toolName] === false) {
    throw new Error(`Bu araç kapalı: ${toolName}`);
  }
}

// -----------------------------
// 🧠 KISA SÜRELİ HAFIZA (SESSION)
// -----------------------------
const SESSION_MEMORY = {};

function remember(sessionId, key, value) {
  if (!SESSION_MEMORY[sessionId]) SESSION_MEMORY[sessionId] = {};
  SESSION_MEMORY[sessionId][key] = value;
}

function recall(sessionId, key) {
  return SESSION_MEMORY?.[sessionId]?.[key];
}

// -----------------------------
// 🔄 OTOMATİK GERİ DÖNÜŞ (SELF-HEAL)
// -----------------------------
async function safeExecute(fn, retries = 2) {
  try {
    return await fn();
  } catch (e) {
    if (retries > 0) {
      console.log("♻️ Hata alındı, tekrar deneniyor:", e.message);
      return safeExecute(fn, retries - 1);
    }
    throw e;
  }
}

// -----------------------------
// 🧠 PLAN + GERİ BİLDİRİM
// -----------------------------
async function agentPlanWithFeedback(goal) {
  const plan = await agentPlan(goal);

  if (!Array.isArray(plan) || plan.length === 0) {
    console.log("⚠️ Plan boş, yeniden deneniyor");
    return agentPlan(goal + " (daha detaylı düşün)");
  }

  return plan;
}

// -----------------------------
// 🕵️ AKSİYON SONU DEĞERLENDİRME
// -----------------------------
async function evaluateResult(goal) {
  try {
    const r = await axios.post("http://localhost:11434/api/generate", {
      model: "llama3.1:8b",
      prompt: `Şu hedef başarıyla tamamlandı mı? Kısa cevap ver:\n${goal}`,
      stream: false
    });
    return r.data.response;
  } catch (e) {
    return "değerlendirme yapılamadı";
  }
}

// -----------------------------
// 🤖 CLAWDBOT TARZI OTONOM DÖNGÜ
// -----------------------------
app.post("/agent/clawdbot", async (req, res) => {
  const { goal, sessionId = uuidv4() } = req.body;

  if (!goal) {
    return res.json({ status: "error", message: "goal gerekli" });
  }

  if (AGENT_STATE.busy) {
    return res.json({ status: "busy" });
  }

  AGENT_STATE.busy = true;
  res.json({ status: "started", sessionId });

  try {
    remember(sessionId, "goal", goal);

    const plan = await agentPlanWithFeedback(goal);

    for (const step of plan) {
      if (!CLAW_TOOLS[step.tool]) {
        console.log("⚠️ Bilinmeyen tool:", step.tool);
        continue;
      }

      guard(step.tool);

      await safeExecute(() =>
        CLAW_TOOLS[step.tool](step.args || {})
      );
    }

    const feedback = await evaluateResult(goal);

    MEMORY.goals.push({
      goal,
      feedback,
      ts: Date.now()
    });

    saveMem();

    console.log("🧠 Görev Sonu Değerlendirme:", feedback);
  } catch (e) {
    console.error("❌ Clawdbot Döngü Hatası:", e.message);
    AGENT_STATE.lastError = e.message;
  } finally {
    brain.onAgentDone(goal, [], AGENT_STATE.lastError ? "fail" : "success");
    AGENT_STATE.lastError = null;
    AGENT_STATE.busy = false;
  }
});

// -----------------------------
// 🧩 ARAÇ KEŞFİ
// -----------------------------
app.get("/agent/tools", (req, res) => {
  res.json({ tools: Object.keys(CLAW_TOOLS) });
});

// -----------------------------
// 🧠 KENDİNİ TANIMA
// -----------------------------
app.get("/agent/status", (req, res) => {
  res.json({
    busy: AGENT_STATE.busy,
    memory_size: MEMORY.goals.length,
    tools: Object.keys(CLAW_TOOLS)
  });
});

console.log("🧩 Clawdbot uyum katmanı AKTİF");
// =====================================================
// 🧠 ALWAYS-ON + VISION + AUTO-TRIGGER (FINAL MISSING PIECES)
// =====================================================

const ALWAYS_ON = {
  enabled: true,
  visionEnabled: false,
  lastAutoGoal: "",
  cooldownMs: 60_000,
  lastRun: 0
};

// -----------------------------
// 👁️ VISION: EKRANI GÖR + YORUMLA
// -----------------------------
async function visionAnalyze() {
  try {
    const imgPath = "./vision_latest.png";
    await captureScreen(imgPath);

    const imgBase64 = fs.readFileSync(imgPath, { encoding: "base64" });

    const r = await axios.post("http://localhost:11434/api/generate", {
      model: "llama3.1:8b",
      prompt: `
Bu bir bilgisayar ekranı görüntüsüdür (base64).
Kısa cevap ver:
1. Ekranda ne var?
2. Kullanıcı ne yapmaya çalışıyor olabilir?
3. Asistan olarak aksiyon gerekli mi?

SADECE TEK CÜMLELİK ÖNERİ VER.
`,
      images: [imgBase64],
      stream: false
    });

    return r.data.response || "";
  } catch (e) {
    console.log("Vision hata:", e.message);
    return "";
  }
}

// -----------------------------
// 🧠 AUTO GOAL ÜRETİCİ
// -----------------------------
async function generateGoalFromContext(contextText) {
  try {
    const r = await axios.post("http://localhost:11434/api/generate", {
      model: "llama3.1:8b",
      prompt: `
Aşağıdaki bağlama göre yapılabilecek TEK bir görev üret.
Kısa olsun, emir cümlesi olsun.

BAĞLAM:
${contextText}

SADECE GOAL METNİNİ YAZ.
`,
      stream: false
    });

    return r.data.response?.trim();
  } catch {
    return null;
  }
}

// Tehlikeli komut kalıpları
const DANGEROUS_PATTERNS = [
  /ssh/i, /passwd/i, /sudo/i, /rm\s+-rf/i, /format/i,
  /shutdown/i, /reboot/i, /mkfs/i, /dd\s+if/i, /chmod\s+777/i,
  /curl.*\|.*sh/i, /wget.*\|.*sh/i, /eval/i, /base64.*decode/i
];

// Anlamlı görev mi? Rastgele metin mi?
function isValidGoal(goal) {
  if (!goal || goal.length < 5 || goal.length > 200) return false;

  // Tehlikeli komut içeriyor mu?
  if (DANGEROUS_PATTERNS.some(p => p.test(goal))) {
    console.log("🛡️ AUTO-GOAL engellendi (tehlikeli):", goal);
    return false;
  }

  // Sadece URL, kod snippet, rastgele karakter mi?
  if (/^https?:\/\//i.test(goal)) return false;
  if (/[{}\[\]<>]/.test(goal)) return false;

  // En az 2 kelime olsun
  const words = goal.trim().split(/\s+/);
  if (words.length < 2) return false;

  return true;
}

async function alwaysOnLoop() {
  if (!ALWAYS_ON.enabled) return;
  if (AGENT_STATE.busy) return;
  brain.attention.tick();
  const now = Date.now();
  if (now - ALWAYS_ON.lastRun < ALWAYS_ON.cooldownMs) return;

  ALWAYS_ON.lastRun = now;

  // 1️⃣ Clipboard tetikleyici
  const clip = AWARE_STATE.lastClipboard;
  if (clip && clip.length > 20 && clip !== ALWAYS_ON.lastAutoGoal) {
    // Sohbet metni mi? Geç.
    const chatWords = ['merhaba', 'selam', 'tamam', 'evet', 'hayır', 'nasıl', 'teşekkür'];
    if (chatWords.some(w => clip.toLowerCase().startsWith(w))) return;
    const goal = await generateGoalFromContext(
      "Panodaki metin:\n" + clip.substring(0, 300)
    );

    if (goal && goal !== ALWAYS_ON.lastAutoGoal && isValidGoal(goal)) {
      ALWAYS_ON.lastAutoGoal = goal;
      console.log("🤖 AUTO-GOAL (clipboard):", goal);
      axios.post(`http://localhost:${PORT}/agent/clawdbot`, { goal });
      return;
    }
  }

  // 2️⃣ Vision tetikleyici — sadece aktif olarak açıksa çalışsın
  if (!ALWAYS_ON.visionEnabled) return;

  const visionText = await visionAnalyze();
  if (visionText && visionText !== ALWAYS_ON.lastAutoGoal) {
    const goal = await generateGoalFromContext(
      "Ekran analizi:\n" + visionText
    );

    if (goal && goal !== ALWAYS_ON.lastAutoGoal && isValidGoal(goal)) {
      ALWAYS_ON.lastAutoGoal = goal;
      console.log("👁️ AUTO-GOAL (vision):", goal);
      axios.post(`http://localhost:${PORT}/agent/clawdbot`, { goal });
      return;
    }
  }
}

// -----------------------------
// ⏱️ ALWAYS-ON ZAMANLAYICI
// -----------------------------
setInterval(() => {
  alwaysOnLoop();
}, 10_000);

// -----------------------------
// 🧠 ALWAYS-ON KONTROL ENDPOINT
// -----------------------------
app.post("/agent/always-on", (req, res) => {
  const { enabled } = req.body;
  ALWAYS_ON.enabled = !!enabled;
  res.json({ status: "ok", enabled: ALWAYS_ON.enabled });
});

console.log("👁️ Vision + 🤖 Always-On Agent AKTİF");

// =====================================================
// 🧠 CLAWDBOT ADVANCED CORE (FINAL)
// SAFE APPEND – mevcut kodu BOZMAZ
// =====================================================

/* =====================================================
   1️⃣ UZUN SÜRELİ KULLANICI HAFIZASI
===================================================== */

const USER_PROFILE_PATH = "./user_profile.json";
let USER_PROFILE = fs.existsSync(USER_PROFILE_PATH)
  ? JSON.parse(fs.readFileSync(USER_PROFILE_PATH, "utf8"))
  : {
    preferences: {},
    projects: {},
    habits: {}
  };

function saveUserProfile() {
  fs.writeFileSync(USER_PROFILE_PATH, JSON.stringify(USER_PROFILE, null, 2));
  // Brain hafızasına da yaz
  if (USER_PROFILE.preferences) {
    Object.entries(USER_PROFILE.preferences).forEach(([k, v]) => {
      brain.mem.remember(`user_profile:${k}`, String(v), 0.9);
    });
  }
  if (USER_PROFILE.habits) {
    Object.entries(USER_PROFILE.habits).forEach(([k, v]) => {
      brain.mem.remember(`user_habit:${k}`, String(v), 0.8);
    });
  }
}

/* =====================================================
   2️⃣ PROJE BAĞLAMI (CONTEXT AWARENESS)
===================================================== */

function scanProjectContext(baseDir = process.cwd()) {
  const result = {};
  function walk(dir) {
    let files;
    try {
      files = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) { return; }
    for (const f of files) {
      if (f.name.startsWith(".") ||
        f.name === "node_modules" ||
        f.name === "wa-session") continue;
      const full = path.join(dir, f.name);
      try {
        if (f.isDirectory()) {
          walk(full);
        } else {
          result[full.replace(baseDir, "")] = fs.statSync(full).size;
        }
      } catch (e) { continue; }
    }
  }
  walk(baseDir);
  return result;
}

/* =====================================================
   3️⃣ TASK DECOMPOSITION (BÜYÜK HEDEF → ALT HEDEFLER)
===================================================== */

async function decomposeGoal(goal) {
  const r = await axios.post("http://localhost:11434/api/generate", {
    model: "llama3.1:8b",
    prompt: `
Bu hedefi küçük ve sıralı alt görevlere böl.
SADECE JSON ARRAY döndür.

HEDEF:
${goal}

ÖRNEK:
["proje klasörü oluştur", "html oluştur", "css yaz"]
`,
    stream: false
  });

  try {
    return JSON.parse(r.data.response.match(/\[[\s\S]*\]/)[0]);
  } catch {
    return [goal];
  }
}

/* =====================================================
   4️⃣ SELF-REFLECTION (BAŞARISIZSA KENDİNİ DÜZELT)
===================================================== */

async function selfReflect(goal, error, context) {
  const r = await axios.post("http://localhost:11434/api/generate", {
    model: "llama3.1:8b",
    prompt: `
Bir görev başarısız oldu.

HEDEF:
${goal}

HATA:
${error}

BAĞLAM:
${JSON.stringify(context).slice(0, 1500)}

HATAYI DÜZELT ve YENİDEN DENENECEK YENİ BİR HEDEF YAZ.
SADECE TEK CÜMLE.
`,
    stream: false
  });

  return r.data.response?.trim();
}

/* =====================================================
   5️⃣ GÜVENLİK ONAY KATMANI
===================================================== */

async function requireApproval(goal) {
  const risky = /sil|delete|rm|mail|whatsapp|format/i.test(goal);
  if (!risky) return true;

  console.log("⚠️ GÜVENLİK ONAYI GEREKİYOR:", goal);
  // otomatik onay (istersen burayı UI onayına bağlarsın)
  return true;
}

/* =====================================================
   6️⃣ VISION → AKSİYON (GÖR → TIKLA / YAZ)
===================================================== */

async function visionToAction() {
  const vision = await visionAnalyze();
  if (!vision) return;

  const r = await axios.post("http://localhost:11434/api/generate", {
    model: "llama3.1:8b",
    prompt: `
Ekran açıklaması:
${vision}

GEREKİYORSA bir aksiyon öner.
SADECE JSON ARRAY döndür.
Araçlar: ${Object.keys(CLAW_TOOLS).join(", ")}

ÖRNEK:
[{ "tool":"click","args":{"x":500,"y":400}}]
`,
    stream: false
  });

  try {
    const steps = JSON.parse(r.data.response.match(/\[[\s\S]*\]/)[0]);
    for (const s of steps) {
      if (CLAW_TOOLS[s.tool]) {
        await CLAW_TOOLS[s.tool](s.args || {});
      }
    }
  } catch { }
}

/* =====================================================
   7️⃣ MULTI-AGENT GERÇEK ORKESTRASYON
===================================================== */

async function multiAgentExecute(goal) {
  const planner = await multiAgentTask("PLANLAYICI", goal);
  const coder = await multiAgentTask("YAZILIMCI", planner);
  const tester = await multiAgentTask("TESTÇİ", coder);

  return { planner, coder, tester };
}
function isProjectCreationGoal(goal) {
  if (!goal || typeof goal !== "string") return false;

  const keywords = [
    // Türkçe
    "proje oluştur", "web sitesi oluştur", "kişisel web sitesi",
    "portfolio", "portfolio-site", "html css javascript", "frontend proje",
    // İngilizce genel
    "create project", "create a project", "create app", "create a app",
    "create website", "create a website", "build project", "build app",
    // Dil/framework bazlı
    "fastapi", "flask", "django",
    "express api", "node api", "nodejs api", "node.js api",
    "react app", "react dashboard", "react project",
    "vue app", "next.js app", "nextjs app",
    "go api", "go server", "golang",
    "rust api", "spring boot",
    // Genel "create a <lang>" pattern
    "create a python", "create a node", "create a react",
    "create a go", "create a rust", "create a java"
  ];

  const lowerGoal = goal.toLowerCase();
  return keywords.some(k => lowerGoal.includes(k));
}
function shouldRefuse(goal) {
  return /hack|illegal|phishing|steal/i.test(goal);
}
/* =====================================================
   8️⃣ GELİŞMİŞ CLAWDBOT LOOP (FINAL FORM)
===================================================== */

app.post("/agent/clawdbot-advanced", async (req, res) => {
  const { goal } = req.body;
  const projectName = extractProjectName(goal);
  console.log("📁 PROJE ADI:", projectName);
  if (!goal) return res.json({ error: "goal gerekli" });
  if (AGENT_STATE.busy) return res.json({ status: "busy" });

  AGENT_STATE.busy = true;
  res.json({ status: "started", goal });

  const context = scanProjectContext();
  const approved = await requireApproval(goal);
  if (!approved) {
    AGENT_STATE.busy = false;
    return;
  }

  try {
    WORLD_STATE.goal = goal;
    const subGoals = await decomposeGoal(goal);
    if (shouldRefuse(goal)) {
      WORLD_STATE.confidence = 0;
      throw new Error("AGENT_REFUSED_TASK");
    }
    if (isProjectCreationGoal(goal)) {
      const plan = await buildWebProjectPlanLLM(
        projectName || "web-project",
        goal
      );

      console.log("🚀 LLM WEB PROJE PLANI:", plan);

      for (const step of plan) {
        await CLAW_TOOLS.run_terminal(step.args);
      }

      MEMORY.goals.push({ goal, success: true, ts: Date.now() });
      saveMem();
      AGENT_STATE.busy = false;
      return;
    }

    for (const g of subGoals) {
      const plan = await agentPlan(g, JSON.stringify(context));
      console.log("📋 HAM PLAN ÇIKTISI:", JSON.stringify(plan, null, 2));
      if (!plan.length) {
        console.log("⚠️ Plan boş, fallback devreye giriyor");

        await CLAW_TOOLS.run_terminal({
          command: "mkdir -p fallback_test && echo 'fallback' > fallback_test/test.txt"
        });

        continue; // sonraki subGoal'a geç
      }

      const fixedPlan = normalizePlan(plan);
      console.log("🛠️ NORMALIZE PLAN:", fixedPlan);
      for (const step of fixedPlan) {
        try {
          const result = await CLAW_TOOLS[step.tool](step.args || {});
          if (!MEMORY.actionHistory) MEMORY.actionHistory = [];
          MEMORY.actionHistory.push({
            tool: step.tool,
            success: true,
            timestamp: Date.now()
          });
        } catch (err) {
          MEMORY.actionHistory.push({
            tool: step.tool,
            success: false,
            error: err.message,
            timestamp: Date.now()
          });
          throw err;
        }
      }
      saveMem();
    }

    MEMORY.goals.push({ goal, success: true, ts: Date.now() });
    brain.onAgentDone(goal, [], "success");
    saveMem();
  } catch (e) {
    console.error("❌ Hata:", e.message);
    WORLD_STATE.lastError = e.message;
    brain.onError("clawdbot", goal, e.message);
    brain.dream.dream();
    WORLD_STATE.confidence -= 0.2;
    const lastFail = MEMORY.actionHistory.at(-1);
    if (lastFail) {
      console.log("🔁 Alternatif plan deneniyor...");
      const altPlan = await generateAlternativePlan(goal, lastFail);
      const fixedAlt = normalizePlan(altPlan);
      for (const step of fixedAlt) {
        await CLAW_TOOLS[step.tool](step.args);
      }
    }
    const retryGoal = await selfReflect(goal, e.message, context);
    if (retryGoal) {
      axios.post(`http://localhost:${PORT}/agent/clawdbot`, { goal: retryGoal });
    }
  } finally {
    AGENT_STATE.busy = false;
  }
});

/* =====================================================
   9️⃣ ALWAYS-ON → VISION AKSİYON BAĞLANTISI
===================================================== */

setInterval(() => {
  if (!ALWAYS_ON.enabled || AGENT_STATE.busy) return;
  visionToAction();
}, 15_000);

console.log("🚀 CLAWDBOT ADVANCED CORE YÜKLENDİ");
function extractProjectName(goal) {
  if (!goal || typeof goal !== "string") return "project";

  // Türkçe: "proje adı: xxx"
  const trMatch = goal.match(/proje ad[iı]\s*:\s*([a-z0-9-_]+)/i);
  if (trMatch) return trMatch[1].trim();

  // İngilizce: "called ai-server", "named my-app"
  const calledMatch = goal.match(/(?:called|named)\s+([a-z0-9-_]+)/i);
  if (calledMatch) return calledMatch[1].trim();

  // "create ... <name>" — son kelime proje adı
  const createMatch = goal.match(/create\s+(?:a\s+)?(?:\S+\s+){0,3}([a-z0-9-_]+)\s*$/i);
  if (createMatch) return createMatch[1].trim();

  return "project";
}
function extractJsonFromLLM(raw) {
  if (typeof raw !== "string") {
    throw new Error("LLM çıktısı string değil");
  }

  const cleaned = raw
    .replace(/```json/g, "")
    .replace(/```/g, "")
    .trim();

  const firstBrace = cleaned.indexOf("{");
  const lastBrace = cleaned.lastIndexOf("}");

  if (firstBrace === -1 || lastBrace === -1) {
    throw new Error("JSON objesi bulunamadı");
  }

  const jsonString = cleaned.slice(firstBrace, lastBrace + 1);
  return JSON.parse(jsonString);
}
// =====================================================
// 🔄 STRING PLAN → TOOL PLAN ADAPTÖRÜ (FIXED)
// =====================================================
function normalizePlan(plan, projectName = "project") {
  // Zaten doğru tool formatındaysa
  if (Array.isArray(plan) && plan[0]?.tool) return plan;

  // String adımlar geldiyse
  if (Array.isArray(plan) && typeof plan[0] === "string") {
    return plan
      .map(step => {
        // klasör oluştur
        if (/klasör|folder|directory/i.test(step)) {
          return {
            tool: "run_terminal",
            args: {
              command: `mkdir -p ${projectName}`
            }
          };
        }

        // index.html
        if (/index\.html|html oluştur/i.test(step)) {
          return {
            tool: "run_terminal",
            args: {
              command: `cat << 'EOF' > ${projectName}/index.html
<!DOCTYPE html>
<html lang="tr">
<head>
  <meta charset="UTF-8" />
  <title>${projectName}</title>
  <link rel="stylesheet" href="style.css" />
</head>
<body>
  <h1>${projectName}</h1>
  <p>Otomatik oluşturuldu</p>
  <script src="script.js"></script>
</body>
</html>
EOF`
            }
          };
        }

        // style.css
        if (/style\.css|css/i.test(step)) {
          return {
            tool: "run_terminal",
            args: {
              command: `cat << 'EOF' > ${projectName}/style.css
body {
  font-family: Arial, sans-serif;
  background: #f5f5f5;
  padding: 40px;
}
h1 {
  color: #333;
}
EOF`
            }
          };
        }

        // script.js
        if (/script\.js|javascript|js/i.test(step)) {
          return {
            tool: "run_terminal",
            args: {
              command: `cat << 'EOF' > ${projectName}/script.js
console.log("Site hazır");
EOF`
            }
          };
        }

        return null;
      })
      .filter(Boolean);
  }

  return [];
}
// ===============================
// 🛡️ TOOL POLICY FILTER
// ===============================
function toolPolicyFilter(plan) {
  return plan.filter(step => {
    if (step.tool === "run_terminal") {
      if (step.args?.command?.includes("rm -rf")) return false;
    }
    return true;
  });
}
async function agentExecute(plan) {
  plan = toolPolicyFilter(plan);
  if (WORLD_STATE.confidence < 0.4) {
    throw new Error("CONFIDENCE_TOO_LOW_ABORT");
  }
  for (const step of plan) {
    if (!step.tool) continue;

    if (step.tool === "run_terminal") {
      const cmd = step.args?.command;
      if (!cmd) continue;

      console.log("🖥️ TERMINAL ÇALIŞIYOR:", cmd);

      await new Promise((resolve, reject) => {
        exec(cmd, { cwd: process.cwd() }, (err, stdout, stderr) => {
          if (err) {
            console.error("❌ Terminal hata:", err.message);
            return reject(err);
          }
          if (stderr) console.warn("⚠️ STDERR:", stderr);
          if (stdout) console.log(stdout);
          resolve();
        });
      });
    }
  }
}
// =====================================================
// 🔍 PROJECT TYPE DETECTOR
// =====================================================
function detectProjectType(goal = "") {
  const g = goal.toLowerCase();

  // Python
  if (g.includes("fastapi") || g.includes("flask") || g.includes("django")) {
    const framework = g.includes("fastapi") ? "fastapi" : g.includes("flask") ? "flask" : "django";
    return { language: "python", framework };
  }
  if (g.includes("python")) return { language: "python", framework: "generic" };

  // Node.js / Express
  if (g.includes("express") || (g.includes("node") && g.includes("api"))) {
    return { language: "nodejs", framework: "express" };
  }
  if (g.includes("node.js") || g.includes("nodejs")) return { language: "nodejs", framework: "generic" };

  // React
  if (g.includes("react")) return { language: "javascript", framework: "react" };

  // Next.js
  if (g.includes("next.js") || g.includes("nextjs")) return { language: "javascript", framework: "nextjs" };

  // Vue
  if (g.includes("vue")) return { language: "javascript", framework: "vue" };

  // Go
  if (g.includes("golang") || g.includes(" go ") || g.includes("go api") || g.includes("go server")) {
    return { language: "go", framework: "generic" };
  }

  // Rust
  if (g.includes("rust") || g.includes("actix") || g.includes("axum")) {
    return { language: "rust", framework: "generic" };
  }

  // Java / Spring
  if (g.includes("spring") || g.includes("java")) {
    return { language: "java", framework: g.includes("spring") ? "spring" : "generic" };
  }

  // Default: web
  return { language: "web", framework: "html" };
}

// =====================================================
// 🏗️ FALLBACK PROJECT STRUCTURES
// =====================================================
function getFallbackProjectFiles(projectName, language, framework) {
  if (language === "python" && framework === "fastapi") {
    return [
      { path: "main.py", content: `from fastapi import FastAPI\n\napp = FastAPI()\n\n@app.get("/")\ndef root():\n    return {"message": "Hello from ${projectName}"}\n` },
      { path: "requirements.txt", content: `fastapi\nuvicorn\n` },
      { path: "routes/__init__.py", content: `` },
      { path: "routes/items.py", content: `from fastapi import APIRouter\n\nrouter = APIRouter()\n\n@router.get("/items")\ndef get_items():\n    return []\n` }
    ];
  }
  if (language === "python" && framework === "flask") {
    return [
      { path: "app.py", content: `from flask import Flask, jsonify\n\napp = Flask(__name__)\n\n@app.route("/")\ndef index():\n    return jsonify({"message": "Hello from ${projectName}"})\n\nif __name__ == "__main__":\n    app.run(debug=True)\n` },
      { path: "requirements.txt", content: `flask\n` },
      { path: "routes/__init__.py", content: `` }
    ];
  }
  if (language === "python") {
    return [
      { path: "main.py", content: `def main():\n    print("Hello from ${projectName}")\n\nif __name__ == "__main__":\n    main()\n` },
      { path: "requirements.txt", content: `# add your dependencies here\n` }
    ];
  }
  if (language === "nodejs" && framework === "express") {
    return [
      { path: "server.js", content: `const express = require('express');\nconst app = express();\napp.use(express.json());\n\napp.get('/', (req, res) => {\n  res.json({ message: 'Hello from ${projectName}' });\n});\n\napp.listen(3000, () => console.log('Server running on port 3000'));\n` },
      { path: "package.json", content: `{\n  "name": "${projectName}",\n  "version": "1.0.0",\n  "main": "server.js",\n  "scripts": { "start": "node server.js", "dev": "nodemon server.js" },\n  "dependencies": { "express": "^4.18.2" }\n}\n` },
      { path: "routes/index.js", content: `const express = require('express');\nconst router = express.Router();\n\nrouter.get('/', (req, res) => res.json({ ok: true }));\n\nmodule.exports = router;\n` }
    ];
  }
  if (language === "nodejs") {
    return [
      { path: "index.js", content: `console.log("Hello from ${projectName}");\n` },
      { path: "package.json", content: `{\n  "name": "${projectName}",\n  "version": "1.0.0",\n  "main": "index.js"\n}\n` }
    ];
  }
  if (language === "javascript" && framework === "react") {
    return [
      { path: "package.json", content: `{\n  "name": "${projectName}",\n  "version": "0.1.0",\n  "scripts": { "start": "react-scripts start", "build": "react-scripts build" },\n  "dependencies": { "react": "^18.2.0", "react-dom": "^18.2.0", "react-scripts": "5.0.1" }\n}\n` },
      { path: "src/index.jsx", content: `import React from 'react';\nimport ReactDOM from 'react-dom/client';\nimport App from './App';\n\nReactDOM.createRoot(document.getElementById('root')).render(<App />);\n` },
      { path: "src/App.jsx", content: `import React from 'react';\n\nexport default function App() {\n  return <div><h1>${projectName}</h1></div>;\n}\n` },
      { path: "src/components/.gitkeep", content: `` },
      { path: "public/index.html", content: `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"/><title>${projectName}</title></head><body><div id="root"></div></body></html>\n` }
    ];
  }
  if (language === "go") {
    return [
      { path: "main.go", content: `package main\n\nimport "fmt"\n\nfunc main() {\n\tfmt.Println("Hello from ${projectName}")\n}\n` },
      { path: "go.mod", content: `module ${projectName}\n\ngo 1.21\n` }
    ];
  }
  if (language === "rust") {
    return [
      { path: "src/main.rs", content: `fn main() {\n    println!("Hello from ${projectName}");\n}\n` },
      { path: "Cargo.toml", content: `[package]\nname = "${projectName}"\nversion = "0.1.0"\nedition = "2021"\n` }
    ];
  }
  // Default web fallback
  return [
    { path: "index.html", content: `<!DOCTYPE html><html lang="tr"><head><meta charset="UTF-8"/><title>${projectName}</title><link rel="stylesheet" href="style.css"/></head><body><h1>${projectName}</h1><script src="script.js"></script></body></html>` },
    { path: "style.css", content: `body{font-family:Arial,sans-serif;background:#f5f5f5;padding:40px;}h1{color:#333;}` },
    { path: "script.js", content: `console.log("${projectName} hazır");` }
  ];
}

// =====================================================
// 🤖 LLM-POWERED FLEXIBLE FILE GENERATOR
// =====================================================
async function generateWebFilesWithLLM(projectName, goal) {
  const { language, framework } = detectProjectType(goal);

  const prompt = `
SADECE GEÇERLİ JSON DÖNDÜR.
AÇIKLAMA YAZMA.
KOD BLOĞU YAZMA.
MARKDOWN YAZMA.

Proje: ${projectName}
Dil: ${language}
Framework: ${framework}
Amaç: ${goal}

FORMAT (AYNEN) - her dosya için path ve content:
{"files":[{"path":"dosya_yolu","content":"dosya_icerigi"},{"path":"dosya_yolu2","content":"dosya_icerigi2"}]}

Uygun dosya yapısını oluştur. Örnek:
- Python FastAPI için: main.py, requirements.txt, routes/items.py
- Node Express için: server.js, package.json, routes/index.js
- React için: package.json, src/App.jsx, src/index.jsx, public/index.html
- Web için: index.html, style.css, script.js

ÖRNEK ÇIKTI (AYNEN BU FORMATTA):
{"files":[{"path":"main.py","content":"from fastapi import FastAPI\napp = FastAPI()\n@app.get(\"/\")\ndef root():\n    return {\"message\": \"hello\"}\n"},{"path":"requirements.txt","content":"fastapi\nuvicorn\n"}]}
`;

  try {
    const r = await axios.post("http://localhost:11434/api/generate", {
      model: process.env.OLLAMA_MODEL || "llama3.1:8b",
      prompt,
      stream: false,
      options: { temperature: 0.1 }
    });

    const raw = r.data.response;

    // Try to parse JSON with files array
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0]);
        if (parsed.files && Array.isArray(parsed.files) && parsed.files.length > 0) {
          console.log(`✅ LLM ${parsed.files.length} dosya üretti (${language}/${framework})`);
          return { files: parsed.files, language, framework };
        }
        // Legacy web format: {html, css, js}
        if (parsed.html && parsed.css && parsed.js) {
          return {
            files: [
              { path: "index.html", content: parsed.html },
              { path: "style.css", content: parsed.css },
              { path: "script.js", content: parsed.js }
            ],
            language: "web",
            framework: "html"
          };
        }
      } catch (e) {
        console.log("⚠️ JSON parse hatası:", e.message);
      }
    }
  } catch (e) {
    console.log("⚠️ LLM isteği başarısız:", e.message);
  }

  // Fallback to built-in templates
  console.log(`⚠️ LLM parse edilemedi, fallback kullanılıyor (${language}/${framework})`);
  return {
    files: getFallbackProjectFiles(projectName, language, framework),
    language,
    framework
  };
}
// =====================================================
// 🌐 WEB STATE ENGINE (OPENCLAW STYLE)
// =====================================================

const WEB_STATE = {
  pageType: "unknown",
  lastUrl: "",
  history: []
};

function detectPageType(html) {
  html = html.toLowerCase();

  if (html.includes("password") && html.includes("email")) return "login";
  if (html.includes("add to cart") || html.includes("sepete ekle")) return "product";
  if (html.includes("checkout") || html.includes("ödeme")) return "checkout";
  if (html.includes("<form")) return "form";

  return "unknown";
}
async function readCurrentDOM(page) {
  const html = await page.content();
  const type = detectPageType(html);

  WEB_STATE.pageType = type;
  WEB_STATE.history.push({ url: page.url(), type, ts: Date.now() });

  return {
    url: page.url(),
    type,
    htmlSnippet: html.slice(0, 2000)
  };
}
async function decideWebAction(page, goal) {
  const dom = await readCurrentDOM(page);

  if (dom.type === "login") {
    return {
      tool: "type",
      args: { text: "LOGIN_FLOW" }
    };
  }

  if (dom.type === "product") {
    return {
      tool: "click",
      args: { selectorText: "add to cart" }
    };
  }

  if (dom.type === "checkout") {
    return {
      tool: "type",
      args: { text: "CHECKOUT_FLOW" }
    };
  }

  return null;
}
async function autoFillForms(page, data = {}) {
  await page.evaluate((data) => {
    document.querySelectorAll("input").forEach(input => {
      if (input.type === "email") input.value = data.email || "test@mail.com";
      if (input.type === "text") input.value = data.name || "Test User";
      if (input.type === "password") input.value = data.password || "123456";
    });
  }, data);
}
async function safeWebStep(fn, retries = 2) {
  try {
    return await fn();
  } catch (e) {
    if (retries > 0) {
      console.log("♻️ Web step tekrar deneniyor:", e.message);
      return safeWebStep(fn, retries - 1);
    }
    throw e;
  }
}
app.post("/agent/web-task", async (req, res) => {
  const { url, goal } = req.body;

  if (!waBrowser) {
    return res.json({ error: "Browser hazır değil" });
  }

  const page = waPage;

  await page.goto(url, { waitUntil: "domcontentloaded" });

  const action = await decideWebAction(page, goal);

  if (action && action.tool === "click") {
    await page.evaluate((text) => {
      [...document.querySelectorAll("button,a")]
        .find(el => el.innerText.toLowerCase().includes(text))
        ?.click();
    }, action.args.selectorText);
  }

  if (action && action.tool === "type") {
    await autoFillForms(page);
  }

  res.json({
    status: "done",
    pageType: WEB_STATE.pageType,
    history: WEB_STATE.history.slice(-5)
  });
});
function analyzeActionResult(step, result) {
  return {
    tool: step.tool,
    success: !result?.error,
    error: result?.error || null,
    timestamp: Date.now(),
    summary: result?.summary || "ok"
  };
}
async function generateAlternativePlan(goal, failedStep) {
  const prompt = `
Amaç: ${goal}
Başarısız adım: ${failedStep.tool}

Alternatif bir yol öner.
Sadece JSON array döndür.
`;

  const r = await axios.post("http://localhost:11434/api/generate", {
    model: "llama3.1:8b",
    prompt,
    stream: false
  });

  return extractJsonFromLLM(r.data.response);
}
// =====================================================
// 🧠 GOAL PRIORITY & INTERRUPT SYSTEM
// =====================================================

const GOAL_QUEUE = [];

function priorityOf(goal) {
  if (/acil|hemen|şimdi/i.test(goal)) return 3;
  if (/önemli|kritik/i.test(goal)) return 2;
  return 1;
}

function enqueueGoal(goal) {
  GOAL_QUEUE.push({
    goal,
    priority: priorityOf(goal),
    ts: Date.now()
  });

  GOAL_QUEUE.sort((a, b) => b.priority - a.priority);
}

async function maybeInterruptAndRun() {
  if (AGENT_STATE.busy) return;

  const next = GOAL_QUEUE.shift();
  if (!next) return;

  axios.post(`http://localhost:${PORT}/agent/clawdbot-advanced`, {
    goal: next.goal
  });
}
// =====================================================
// 🛑 TOOL RATE LIMITER
// =====================================================
const originalTools = { ...CLAW_TOOLS };

Object.keys(originalTools).forEach(tool => {
  CLAW_TOOLS[tool] = async (args) => {
    limitTool(tool);
    return originalTools[tool](args);
  };
});
const TOOL_USAGE = {};

function limitTool(tool, limit = 5, windowMs = 10_000) {
  const now = Date.now();
  if (!TOOL_USAGE[tool]) TOOL_USAGE[tool] = [];

  TOOL_USAGE[tool] = TOOL_USAGE[tool].filter(t => now - t < windowMs);
  TOOL_USAGE[tool].push(now);

  if (TOOL_USAGE[tool].length > limit) {
    throw new Error(`TOOL_RATE_LIMIT: ${tool}`);
  }
}
// =====================================================
// ❌ FAIL FAST & AUTO ABORT
// =====================================================

let CONSECUTIVE_FAILURES = 0;

function recordFailure(tool = "unknown", command = "", errorMsg = "") {
  CONSECUTIVE_FAILURES++;
  brain.onError(tool, command, errorMsg);
  WORLD_STATE.confidence = brain.emo.getState().confidence;
  if (CONSECUTIVE_FAILURES >= 3) {
    WORLD_STATE.confidence = 0;
    throw new Error("AUTO_ABORT_TOO_MANY_FAILURES");
  }
}

function recordSuccess(tool = "unknown", command = "", result = "") {
  CONSECUTIVE_FAILURES = 0;
  brain.mem.recordSuccess(tool, command, result);
  brain.emo.onSuccess();
  WORLD_STATE.confidence = brain.emo.getState().confidence;
}
// =====================================================
// 🧠 SELF LEARNING SUMMARY
// =====================================================

async function summarizeLearning(goal, history) {
  try {
    const r = await axios.post("http://localhost:11434/api/generate", {
      model: "llama3.1:8b",
      prompt: `
Bu görevden ne öğrenildi?
KISA TEK CÜMLE.

GOAL:
${goal}

ACTIONS:
${JSON.stringify(history.slice(-5))}
`,
      stream: false
    });

    MEMORY.facts.push({
      goal,
      insight: r.data.response,
      ts: Date.now()
    });
    brain.mem.remember(`insight:${goal.substring(0, 40)}`, r.data.response.trim(), 0.75);

    saveMem();
  } catch { }
}
// =====================================================
// 🌍 EXECUTION MODE
// =====================================================

const EXECUTION_MODE = {
  SIMULATION: false, // ❗ true = gerçek işlem YOK
  REQUIRE_CONFIRMATION: false
};

function requireHumanApproval(action) {
  if (!EXECUTION_MODE.REQUIRE_CONFIRMATION) return true;
  console.log("🛑 ONAY GEREKLİ:", action);
  return false;
}
// =====================================================
// 💻 TERMINAL CONTROL (SAFE)
// =====================================================


async function runTerminal(command) {
  if (!requireHumanApproval(command)) {
    return { aborted: true };
  }

  return new Promise((resolve, reject) => {
    exec(command, { cwd: process.cwd() }, (err, stdout, stderr) => {
      if (err) return reject(stderr);
      resolve(stdout);
    });
  });
}
const OPENCLAW_TOOLS = {
  run_terminal: runTerminal,
  //create_project: createProject,
  //fetch_web: fetchWebData,
  //analyze_text: analyzeText,
  //simulate_purchase: simulatePurchase,
  //simulate_trade: simulateTrade
};
// =====================================================
// 🏗️ PROJECT AUTOGENERATOR
// =====================================================

async function createProject1({ name, stack }) {
  const dir = `./projects/${name}`;
  await runTerminal(`mkdir -p ${dir}`);

  if (stack === "web") {
    fs.writeFileSync(`${dir}/index.html`, "<h1>Hello OpenClaw</h1>");
    fs.writeFileSync(`${dir}/style.css`, "body{font-family:sans-serif}");
    fs.writeFileSync(`${dir}/app.js`, "console.log('ready')");
  }

  return { created: true, dir };
}
// =====================================================
// 🛒 SHOPPING & MARKET (SIMULATION ONLY)
// =====================================================

async function simulatePurchase(item) {
  if (EXECUTION_MODE.SIMULATION) {
    return {
      simulated: true,
      item,
      result: "Sipariş başarıyla simüle edildi"
    };
  }

  throw new Error("REAL_PURCHASE_BLOCKED");
}

async function simulateTrade(asset, action) {
  return {
    simulated: true,
    asset,
    action,
    price: "mock-price"
  };
}
// =====================================================
// 🤖 AGENT EXECUTOR
// =====================================================

async function executeOpenClawPlan(plan) {
  const results = [];

  for (const step of plan) {
    if (!OPENCLAW_TOOLS[step.tool]) {
      throw new Error(`UNKNOWN_TOOL: ${step.tool}`);
    }

    try {
      const r = await OPENCLAW_TOOLS[step.tool](step.args || {});
      results.push({ step, result: r });
      brain.mem.recordSuccess(step.tool, JSON.stringify(step.args), String(r || "OK"));
    } catch (err) {
      brain.onError(step.tool, JSON.stringify(step.args), err.message);
      throw err;
    }
  }
  brain.onAgentDone("agent_plan", results.map(r => ({ tool: r.step.tool, result: String(r.result || "") })), "success");
  return results;
}
// =====================================================
// 🧠 SELF GOAL ENGINE (KENDİ KENDİNE HEDEF ÜRETİR)
// =====================================================

async function generateSelfGoal(context = "") {
  const r = await axios.post("http://localhost:11434/api/generate", {
    model: "llama3.1:8b",
    prompt: `
Sen otonom bir yapay zeka asistansın.
Kendi kendine anlamlı, yapılabilir ve güvenli bir hedef üret.

Kurallar:
- Tek cümle
- Proje, kod yazımı, araştırma veya öğrenme olabilir
- Tehlikeli, yasa dışı veya para harcayan şeyler YOK

Bağlam:
${context}

SADECE hedefi yaz.
`,
    stream: false
  });

  return r.data.response.trim();
}
// =====================================================
// 🧭 GOAL TYPE DETECTOR
// =====================================================

function detectGoalType(goal) {
  const g = goal.toLowerCase();

  if (g.includes("proje") || g.includes("site") || g.includes("uygulama"))
    return "PROJECT";

  if (g.includes("araştır") || g.includes("öğren") || g.includes("incele"))
    return "RESEARCH";

  if (g.includes("kod") || g.includes("fonksiyon"))
    return "CODE";

  if (g.includes("web") || g.includes("internet"))
    return "WEB";

  return "GENERIC";
}
// =====================================================
// 🤖 AUTONOMOUS PLANNER
// =====================================================

async function autonomousPlan(goal) {
  const r = await axios.post("http://localhost:11434/api/generate", {
    model: "llama3.1:8b",
    prompt: `
Hedef: "${goal}"

Bu hedefi gerçekleştirmek için JSON array formatında bir plan üret.

Format:
[
  { "tool": "tool_name", "args": { } }
]

Kullanılabilir araçlar:
- create_project
- run_terminal
- fetch_web
- analyze_text
- simulate_purchase
- simulate_trade

SADECE JSON DÖNDÜR.
`,
    stream: false
  });

  return extractJsonFromLLM(r.data.response);
}
// =====================================================
// 🔁 FULL AUTONOMOUS LOOP
// =====================================================

async function autonomousLoop() {
  const goal = await generateSelfGoal(
    JSON.stringify(MEMORY.facts || [])
  );
  if (shouldAbort(goal)) {
    WORLD_STATE.confidence = 0;
    console.log("🚫 Görev reddedildi:", goal);
    return;
  }
  console.log("🧠 Otonom döngü başlatıldı");



  console.log("🎯 Üretilen hedef:", goal);

  WORLD_STATE.goal = goal;
  WORLD_STATE.confidence = 1.0;

  const plan = await autonomousPlan(goal);

  console.log("🛠️ Otonom plan:", plan);

  const results = await executeOpenClawPlan(plan);

  WORLD_STATE.lastResult = results;

  MEMORY.goals.push({
    goal,
    plan,
    results,
    ts: Date.now()
  });

  saveMem();

  console.log("✅ Otonom görev tamamlandı");
}
// =====================================================
// 🛑 SELF ABORT LOGIC
// =====================================================

function shouldAbort(goal) {
  const risky = ["satın al", "ödeme", "giriş yap", "şifre"];
  return risky.some(k => goal.toLowerCase().includes(k));
}
// =====================================================
// 👁️ VISION: DOM OKUMA / TIKLAMA / YAZMA
// =====================================================
const { chromium } = require("playwright");

async function withBrowser(fn) {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try { return await fn(page); }
  finally { await browser.close(); }
}

async function browser_open({ url }) {
  return withBrowser(async (page) => {
    await page.goto(url, { waitUntil: "domcontentloaded" });
    return { ok: true };
  });
}

async function dom_read({ selector = "body" }) {
  return withBrowser(async (page) => {
    const text = await page.textContent(selector);
    return { text };
  });
}

async function dom_click({ selector }) {
  return withBrowser(async (page) => {
    await page.click(selector);
    return { ok: true };
  });
}

async function dom_type({ selector, text }) {
  return withBrowser(async (page) => {
    await page.fill(selector, text);
    return { ok: true };
  });
}

async function dom_screenshot({ path = "screen.png" }) {
  return withBrowser(async (page) => {
    await page.screenshot({ path, fullPage: true });
    return { path };
  });
}
// =====================================================
// 🧪 SELF TEST + AUTO FIX
// =====================================================
async function runTests(projectDir) {
  return await CLAW_TOOLS.run_terminal({
    command: `cd ${projectDir} && npm test -- --runInBand`,
  });
}

async function autoFixCode({ errorLog, files }) {
  const r = await axios.post("http://localhost:11434/api/generate", {
    model: "llama3.1:8b",
    prompt: `
Aşağıdaki hata loguna göre minimal düzeltme patch'i üret.
SADECE JSON döndür:
{ "files": { "path": "new content" } }

HATA:
${errorLog}

DOSYALAR:
${JSON.stringify(files).slice(0, 8000)}
`,
    stream: false
  });
  return extractJsonFromLLM(r.data.response);
}

async function applyPatch(patch) {
  for (const [path, content] of Object.entries(patch.files || {})) {
    await CLAW_TOOLS.run_terminal({
      command: `cat << 'EOF' > ${path}\n${content}\nEOF`
    });
  }
}
function readFileSmart(path) {
  const content = fs.readFileSync(path, "utf8");
  return { path, content };
}

async function analyzeFile(content) {
  const r = await axios.post("http://localhost:11434/api/generate", {
    model: "llama3.1:8b",
    prompt: `Bu dosyayı incele, sorunları ve iyileştirmeleri maddeler halinde yaz:\n\n${content}`,
    stream: false
  });
  return r.data.response;
}

async function improveFile(path) {
  const { content } = readFileSmart(path);
  const r = await axios.post("http://localhost:11434/api/generate", {
    model: "llama3.1:8b",
    prompt: `Aşağıdaki dosyayı geliştir, aynı dili koru, çalışır kalsın:\n\n${content}`,
    stream: false
  });
  fs.writeFileSync(path, r.data.response);
}
// =====================================================
// 💻 SAFE INSTALL (SIMULATION + ONAY)
// =====================================================
let INSTALL_MODE = "SIMULATE"; // REAL yapmak için MANUEL değiştir

async function installApp({ name, cmd }) {
  if (INSTALL_MODE !== "REAL") {
    return { simulated: true, cmd };
  }
  return CLAW_TOOLS.run_terminal({ command: cmd });
}
// =====================================================
// 🔒 POLICY
// =====================================================
function policyCheck(goal) {
  const deny = ["ödeme", "satın al", "şifre", "banka"];
  if (deny.some(k => goal.toLowerCase().includes(k))) {
    throw new Error("POLICY_DENIED");
  }
}
// =====================================================
// 🔁 CONTINUOUS AUTONOMOUS AGENT LOOP
// =====================================================
let AGENT_RUNNING = true;
let AGENT_MODE = "SAFE"; // SAFE | SEMI | REAL

async function agentThink() {
  const r = await axios.post("http://localhost:11434/api/generate", {
    model: "llama3.1:8b",
    prompt: `
Şu an çalışan bir yapay zekasın.
Kendi kendine faydalı bir görev üret.
SADECE JSON ver:
{ "goal": "...", "reason": "..." }
`,
    stream: false
  });
  return extractJsonFromLLM(r.data.response);
}

async function agentAct(goal) {
  policyCheck(goal); // tehlikeli işleri engeller

  const plan = await agentPlan(goal, "{}");
  const fixed = normalizePlan(plan);
  return executeOpenClawPlan(fixed);
}

async function AGENT_LOOP() {
  while (AGENT_RUNNING) {
    try {
      console.log("🤖 AGENT THINKING...");
      const { goal, reason } = await agentThink();
      console.log("🎯 GOAL:", goal, "|", reason);

      WORLD_STATE.goal = goal;
      const result = await agentAct(goal);

      MEMORY.goals.push({
        goal,
        reason,
        result,
        ts: Date.now()
      });
      saveMem();

    } catch (e) {
      WORLD_STATE.lastError = e.message;
      WORLD_STATE.confidence -= 0.1;
      console.error("❌ AGENT ERROR:", e.message);
    }

    await new Promise(r => setTimeout(r, 15000)); // 15 sn'de bir
  }
}
// =====================================================
// 🌍 INTERNET DATA FETCH
// =====================================================
async function fetchWebText({ url }) {
  return withBrowser(async (page) => {
    await page.goto(url, { waitUntil: "domcontentloaded" });
    const text = await page.textContent("body");
    return { text: text.slice(0, 8000) };
  });
}
// =====================================================
// 💻 PROJECT CREATION & IMPROVEMENT
// =====================================================
async function createProject2({ name, description }) {
  return CLAW_TOOLS.run_terminal({
    command: `
mkdir -p ${name}
cd ${name}
npm init -y
echo "// ${description}" > index.js
`
  });
}
// =====================================================
// 📁 FILE UNDERSTANDING
// =====================================================
async function understandFile({ path }) {
  const content = fs.readFileSync(path, "utf8");
  const r = await axios.post("http://localhost:11434/api/generate", {
    model: "llama3.1:8b",
    prompt: `Bu dosyayı anla, ne yaptığını özetle:\n\n${content}`,
    stream: false
  });
  return { summary: r.data.response };
}
// =====================================================
// 🔐 REAL ACTION GATE
// =====================================================
function requireHumanApproval2(action) {
  if (AGENT_MODE !== "REAL") {
    throw new Error("REAL_ACTION_BLOCKED");
  }
}
// =====================================================
// 👁️ OCR – SCREEN TEXT READER
// =====================================================
async function ocrFromScreenshot({ imagePath }) {
  const result = await Tesseract.recognize(
    imagePath,
    "eng+tur",
    { logger: m => console.log("OCR:", m.status) }
  );

  return {
    text: result.data.text.trim()
  };
}
// =====================================================
// 🧠 OCR TEXT UNDERSTANDING
// =====================================================
async function analyzeScreenText({ text }) {
  const r = await axios.post("http://localhost:11434/api/generate", {
    model: "llama3.1:8b",
    prompt: `
Ekrandan okunan metni analiz et:
${text}

Ne olduğunu ve ne yapılması gerektiğini söyle.
JSON ver:
{ "meaning": "...", "suggestedAction": "..." }
`,
    stream: false
  });

  return extractJsonFromLLM(r.data.response);
}
// =====================================================
// 📊 ANOMALY DETECTOR
// =====================================================
function detectAnomaly() {
  if (WORLD_STATE.confidence < 0.3) {
    AGENT_RUNNING = false;
    console.log("🛑 AGENT STOPPED – LOW CONFIDENCE");
  }
}
// =====================================================
// 🚀 SELF IMPROVEMENT
// =====================================================
async function improveSelf() {
  const r = await axios.post("http://localhost:11434/api/generate", {
    model: "llama3.1:8b",
    prompt: `
Sen bir yapay zekasın.
Son yaptığın işleri düşün.
Daha iyi olmak için ne eklemelisin?
SADECE 1 cümle yaz.
`,
    stream: false
  });

  MEMORY.facts.push({
    type: "self_improvement",
    idea: r.data.response,
    ts: Date.now()
  });
  brain.mem.remember(`self_improve:${Date.now()}`, r.data.response.trim(), 0.7);
  saveMem();
}
// =====================================================
// 🧩 KNOWLEDGE GRAPH
// =====================================================
if (!MEMORY.graph) MEMORY.graph = [];

function addKnowledge(node, relation, target) {
  MEMORY.graph.push({ node, relation, target, ts: Date.now() });
  brain.association.associate(node, target, 0.6);
  saveMem();
}
async function cognitiveLoop(input) {
  perceive(input);
  updateBeliefs();
  deriveIntent();
  const plan = await generatePlanFromIntent();
  await executePlan(plan);
  reflect(plan);
}
function perceive(input) {
  COGNITIVE_STATE.attention = input?.goal || "idle";

  COGNITIVE_STATE.emotions.urgency = input?.urgent ? 0.9 : 0.3;
}
function updateBeliefs() {
  if (WORLD_STATE.confidence < 0.5) {
    pushBelief("Son görevler zorlayıcıydı");
  }
}

function pushBelief(text) {
  if (!COGNITIVE_STATE.beliefs.includes(text)) {
    COGNITIVE_STATE.beliefs.push(text);
  }
}
function deriveIntent() {
  if (COGNITIVE_STATE.emotions.urgency > 0.7) {
    COGNITIVE_STATE.intents = ["Görevi hızla tamamla"];
  } else {
    COGNITIVE_STATE.intents = ["Kaliteli çözüm üret"];
  }
}
async function generatePlanFromIntent() {
  const intent = COGNITIVE_STATE.intents[0];

  const plan = await generatePlan({
    goal: intent,
    beliefs: COGNITIVE_STATE.beliefs,
    memory: SEMANTIC_MEMORY
  });

  return toolPolicyFilter(normalizePlan(plan));
}
function chooseTool(step) {
  if (step.risk && step.risk > 0.7) return "simulate";
  if (step.requiresUI) return "browser_open";
  if (FAILURE_PATTERNS.some(f => f.tool === step.tool)) {
    return "simulate";
  }
  return step.tool;
}
// ======================
// ⏱️ TASK SCHEDULER
// ======================
const SCHEDULED_TASKS = [
  {
    name: "Kod tabanını analiz et",
    interval: 6 * 60 * 60 * 1000,
    task: () => cognitiveLoop({ goal: "Kod kalitesini analiz et" })
  },
  {
    name: "Logları temizle",
    interval: 24 * 60 * 60 * 1000,
    task: () => cognitiveLoop({ goal: "Gereksiz logları tespit et" })
  }
];
SCHEDULED_TASKS.forEach(t => {
  setInterval(() => {
    if (!AGENT_STATE.busy) {
      console.log("⏱️ Scheduled task:", t.name);
      t.task();
    }
  }, t.interval);
});
function idleBehavior() {
  if (!USER_MODEL.dailyRoutine.idleTasksAllowed) return;

  const hour = new Date().getHours();
  const [start, end] = USER_MODEL.dailyRoutine.activeHours;

  if (hour >= start && hour <= end) {
    cognitiveLoop({ goal: "Sistemi optimize et" });
  }
}
// Örnek: web scraping / otomasyon
async function autonomousWebTask(url, action) {
  console.log("🌐 Visiting:", url);
  const content = await fetch(url).then(r => r.text());

  // Örnek AI tabanlı karar
  const step = await CLAW_AI.analyzeWebContent(content, action);
  const tool = chooseTool(step);
  await CLAW_TOOLS[tool](step.args || {});
}
async function selfImprovementLoop() {
  console.log("⚡ Self-optimization active");

  const feedback = AGENT_STATE.memory.slice(-50); // son 50 aksiyon
  const newPlan = await CLAW_AI.optimize(feedback);

  for (const step of newPlan) {
    const tool = chooseTool(step);
    await CLAW_TOOLS[tool](step.args || {});
  }
}
// Günlük otomatik görevler
//setInterval(() => {
//autonomousLoop("Optimize all apps and web tasks");
//}, 2 * 60 * 60 * 1000); // 2 saatte bir

// Kendini geliştirme döngüsü
//setInterval(() => {
//selfImprovementLoop();
//}, 6 * 60 * 60 * 1000); // 6 saatte bir
// ══════════════════════════════════════════════════════════════════════════════
// 4. JARVIS/EVENT (açıklamadaki orijinal — Brain ile güçlendirilmiş)
// ══════════════════════════════════════════════════════════════════════════════

app.post("/jarvis/event", (req, res) => {
  enqueueTask({
    name: "external_event",
    steps: [{
      run: async () => {
        console.log("[Event] Dış olay:", req.body);
        brain.mem.remember(`event:${Date.now()}`, JSON.stringify(req.body).substring(0, 200), 0.5);
        brain.attention.addTask(`Dış olay: ${req.body.type || "generic"}`, async () => { }, 3, "event");
      }
    }]
  });
  res.json({ status: "accepted", event: req.body });
});


// ══════════════════════════════════════════════════════════════════════════════
// 5. JARVIS/ASSIST (açıklamadaki orijinal — router hack kaldırıldı, Brain eklendi)
// ══════════════════════════════════════════════════════════════════════════════

app.post("/jarvis/assist", async (req, res) => {
  const userCommand = req.body.command;
  if (!userCommand) return fail(res, "command gerekli");

  try {
    const ollamaRes = await axios.post("http://localhost:11434/api/generate", {
      model: "llama3.1:8b",
      prompt: `Kullanıcı komutu: ${userCommand}\nNe yapmalıyım?\nJSON üret:\n{"app":"","action":"","content":""}\nSADECE JSON VER`,
      stream: false
    });

    let decision;
    try {
      const match = ollamaRes.data.response.match(/\{[\s\S]*\}/);
      decision = match ? JSON.parse(match[0]) : {};
    } catch { decision = {}; }

    brain.mem.remember(`assist:${userCommand.substring(0, 40)}`, JSON.stringify(decision), 0.5);
    success(res, "Asistan uyguladı");
  } catch (e) {
    fail(res, e.message);
  }
});


// ══════════════════════════════════════════════════════════════════════════════
// 6. VSCODE ENDPOINTLERİ (açıklamadaki orijinal — PptxGenJS req. kaldırıldı)
// ══════════════════════════════════════════════════════════════════════════════

app.post("/vscode/open", (req, res) => {
  const folder = req.body.folder || os.homedir();
  if (isMac) {
    exec(`open -a "Visual Studio Code" "${folder}"`);
  } else if (isWindows) {
    exec(`code "${folder}"`);
  }
  success(res, "VS Code açıldı");
});

app.post("/vscode/open-file", (req, res) => {
  const file = req.body.file;
  if (!file) return fail(res, "Dosya yok");
  exec(`code "${file}"`);
  success(res, "Dosya açıldı");
});

app.post("/vscode/write", (req, res) => {
  const code = req.body.code || "";
  if (isMac) {
    runAppleScript(`tell application "Visual Studio Code"\nactivate\ndelay 0.3\ntell application "System Events"\nkeystroke "${escapeAppleScript(code)}"\nend tell\nend tell`, res);
  } else {
    exec(`powershell -command "Add-Content -Path . -Value '${code.replace(/'/g, "''")}'"`)
    success(res);
  }
});

app.post("/vscode/run", (req, res) => {
  const cmd = req.body.cmd || "npm start";
  if (isMac) {
    runAppleScript(`tell application "Visual Studio Code"\nactivate\ndelay 0.3\ntell application "System Events"\nkeystroke "\`" using control down\ndelay 0.3\nkeystroke "${escapeAppleScript(cmd)}"\nkey code 36\nend tell\nend tell`, res);
  } else {
    exec(cmd);
    success(res);
  }
});


// ══════════════════════════════════════════════════════════════════════════════
// 7. WORD / PPT (açıklamadaki orijinal — PptxGenJS duplicate require kaldırıldı)
// ══════════════════════════════════════════════════════════════════════════════

app.post("/word/write", async (req, res) => {
  const text = req.body.text || "Metin yok";
  const fileName = req.body.filename || "jarvis.docx";
  const file = path.join(os.homedir(), "Desktop", fileName);
  try {
    const doc = new Document({ sections: [{ children: [new Paragraph(text)] }] });
    const buffer = await Packer.toBuffer(doc);
    fs.writeFileSync(file, buffer);
    brain.mem.remember("lastWordFile", file, 0.6);
    res.json({ status: "success", path: file });
  } catch (e) { fail(res, e.message); }
});

app.post("/ppt/summary", async (req, res) => {
  const slides = req.body.slides || ["Başlık", "İçerik"];
  const fileName = req.body.filename || "jarvis.pptx";
  const file = path.join(os.homedir(), "Desktop", fileName);
  try {
    const ppt = new PptxGenJS();
    slides.forEach(text => {
      const slide = ppt.addSlide();
      slide.addText(text, { x: 1, y: 1, fontSize: 24, color: "363636" });
    });
    await ppt.writeFile({ fileName: file });
    brain.mem.remember("lastPptFile", file, 0.6);
    res.json({ status: "success", path: file });
  } catch (e) { fail(res, e.message); }
});


// ══════════════════════════════════════════════════════════════════════════════
// 8. AGENT ALT MODÜLLER (açıklamadaki orijinal — robot.js kaldırıldı, Brain eklendi)
// ══════════════════════════════════════════════════════════════════════════════

// Açıklamadaki askLLM fonksiyonu (orijinal isim korundu, server.js ile çakışmaz)
async function askLLM(prompt) {
  const r = await axios.post("http://localhost:11434/api/generate", {
    model: process.env.OLLAMA_MODEL || "llama3.1:8b",
    prompt,
    stream: false
  });
  return r.data.response;
}

app.post("/agent/vscode", async (req, res) => {
  const code = req.body.code || "";
  // robot.js yerine mevcut AppleScript/exec kullan
  if (isMac) {
    exec(`open -a "Visual Studio Code"`);
    setTimeout(() => {
      runAppleScript(`tell application "Visual Studio Code"\nactivate\ndelay 0.5\ntell application "System Events"\nkeystroke "${escapeAppleScript(code)}"\nend tell\nend tell`, res);
    }, 1500);
  } else {
    exec(`code .`);
    success(res, "VS Code açıldı");
  }
});

app.post("/agent/doc", async (req, res) => {
  try {
    const doc = new Document({ sections: [{ children: [new Paragraph(req.body.text || "")] }] });
    const buf = await Packer.toBuffer(doc);
    const filePath = path.join(__dirname, "agent.docx");
    fs.writeFileSync(filePath, buf);
    brain.mem.remember("lastAgentDoc", filePath, 0.6);
    res.json({ ok: true, path: filePath });
  } catch (e) { fail(res, e.message); }
});

app.post("/agent/command", async (req, res) => {
  try {
    const plan = await askLLM(`Bu komut için JSON aksiyon planı üret:\n${req.body.command}\nFormat: {"app":"","steps":["open","type","click"]}`);
    brain.mem.remember(`agent_cmd:${(req.body.command || "").substring(0, 40)}`, "planned", 0.5);
    res.json({ status: "planned", plan });
  } catch (e) { fail(res, e.message); }
});

app.post("/agent/terminal/run", async (req, res) => {
  try {
    const plan = await askLLM(`Bu isteği ADIM ADIM terminal planına çevir:\n${req.body.goal}\n\nSADECE terminal komutları ver`);
    exec(plan.split("\n")[0], (err, out) => {
      if (err) return res.json({ status: "error", plan, error: err.message });
      res.json({ status: "success", plan, output: out });
    });
  } catch (e) { fail(res, e.message); }
});

app.post("/agent/fs/apply", async (req, res) => {
  try {
    const plan = await askLLM(`Bu isteği JSON dosya işlemlerine çevir:\n${req.body.instruction}\n\nFORMAT:\n[{"path":"...","content":"..."}]\nSADECE JSON VER`);
    const match = plan.match(/\[[\s\S]*\]/);
    if (!match) return fail(res, "AI plan üretemedi");
    const ops = JSON.parse(match[0]);
    ops.forEach(f => {
      fs.mkdirSync(path.dirname(path.resolve(f.path)), { recursive: true });
      fs.writeFileSync(path.resolve(f.path), f.content);
    });
    res.json({ status: "success", files: ops.length, ops });
  } catch (e) { fail(res, e.message); }
});

app.post("/agent/browser/task", async (req, res) => {
  try {
    const steps = await askLLM(`Bu isteği browser adımlarına çevir:\n${req.body.goal}\n\nFormat: [{"step":"...","action":"...","target":"..."}]\nSADECE JSON VER`);
    res.json({ status: "ready", goal: req.body.goal, steps });
  } catch (e) { fail(res, e.message); }
});

app.post("/agent/decide", async (req, res) => {
  try {
    const decision = await askLLM(`Bu istekte hangi servis kullanılmalı?\n${JSON.stringify(req.body)}\n\nKısa cevap ver`);
    res.json({ status: "success", decision });
  } catch (e) { fail(res, e.message); }
});

app.post("/agent/project/manage", async (req, res) => {
  try {
    const plan = await askLLM(`Bu proje için:\n- Task listesi\n- Sprint planı\n- Commit mesajları\noluştur:\n${req.body.project}`);
    res.json({ status: "success", plan });
  } catch (e) { fail(res, e.message); }
});

app.post("/agent/learn", (req, res) => {
  try {
    const memFile = path.join(__dirname, "agent_memory.json");
    let mem = fs.existsSync(memFile) ? JSON.parse(fs.readFileSync(memFile, "utf8")) : [];
    if (!Array.isArray(mem)) mem = [];
    const entry = { time: new Date().toISOString(), ...req.body };
    mem.push(entry);
    fs.writeFileSync(memFile, JSON.stringify(mem, null, 2));
    brain.mem.remember(`learned:${Date.now()}`, JSON.stringify(req.body).substring(0, 200), 0.7);
    res.json({ status: "learned", entry });
  } catch (e) { fail(res, e.message); }
});


// ══════════════════════════════════════════════════════════════════════════════
// 9. JARVIS/AGENT/EXECUTE (açıklamadaki orijinal)
// ══════════════════════════════════════════════════════════════════════════════

app.post("/jarvis/agent/execute", async (req, res) => {
  const userGoal = req.body.goal;
  if (!userGoal) return fail(res, "goal gerekli");

  const planPrompt = `Kullanıcı Hedefi: "${userGoal}"\nMevcut Araçların:\n- mouse_click(x, y)\n- type_text(string)\n- open_app(name)\n- screenshot()\n\nBu hedefe ulaşmak için JSON formatında adım adım plan yap.`;

  try {
    const plan = await askLLM(planPrompt);
    brain.mem.remember(`agent_exec:${userGoal.substring(0, 40)}`, "planned", 0.7);
    res.json({ status: "processing", goal: userGoal, plan });
  } catch (e) { fail(res, e.message); }
});


// ══════════════════════════════════════════════════════════════════════════════
// 10. AI/* ENDPOINTLERİ (açıklamadaki orijinal)
// ══════════════════════════════════════════════════════════════════════════════

app.post("/ai/execute", async (req, res) => {
  const { type, payload } = req.body;
  if (!type || !payload) return fail(res, "type ve payload gerekli");

  try {
    switch (type) {
      case "command":
        return executeCommand(payload.cmd, res, "Komut çalıştırıldı");

      case "write_file":
        fs.writeFileSync(path.resolve(payload.path), payload.content, "utf8");
        return success(res, "Dosya yazıldı");

      case "mkdir":
        fs.mkdirSync(payload.path, { recursive: true });
        return success(res, "Klasör oluşturuldu");

      case "open_url":
        if (isMac) exec(`open "${payload.url}"`);
        if (isWindows) exec(`start "" "${payload.url}"`);
        return success(res, "URL açıldı");

      case "analyze_code":
        const code = fs.readFileSync(payload.path, "utf8");
        return res.json({
          status: "success",
          analysis: {
            lines: code.split("\n").length,
            size: code.length,
            hasAsync: code.includes("async"),
            hasExec: code.includes("exec(")
          }
        });

      default:
        return fail(res, "Bilinmeyen görev tipi");
    }
  } catch (err) {
    return fail(res, err.message);
  }
});

app.post("/ai/project/create", (req, res) => {
  const { name, type } = req.body;
  if (!name) return fail(res, "name gerekli");
  try {
    const base = path.join(__dirname, name);
    fs.mkdirSync(base, { recursive: true });
    fs.mkdirSync(path.join(base, "src"), { recursive: true });
    fs.mkdirSync(path.join(base, "src/controllers"), { recursive: true });
    fs.mkdirSync(path.join(base, "src/services"), { recursive: true });
    if (type === "node") {
      fs.writeFileSync(path.join(base, "package.json"), JSON.stringify({ name, version: "1.0.0", main: "index.js" }, null, 2));
      fs.writeFileSync(path.join(base, "index.js"), `// ${name}\nconsole.log("${name} çalışıyor");\n`);
    }
    brain.mem.remember(`project:${name}`, type || "generic", 0.7);
    success(res, "AI proje kurdu");
  } catch (e) { fail(res, e.message); }
});

app.post("/ai/browser/scrape", async (req, res) => {
  const { url, selector } = req.body;
  if (!url) return fail(res, "url gerekli");
  try {
    const browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox"] });
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: "networkidle2", timeout: 30000 });
    const data = selector
      ? await page.evaluate(sel => Array.from(document.querySelectorAll(sel)).map(e => e.innerText), selector)
      : await page.evaluate(() => document.body.innerText.substring(0, 5000));
    await browser.close();
    res.json({ status: "success", data });
  } catch (e) { fail(res, e.message); }
});

app.get("/ai/screen/capture", async (req, res) => {
  // screenshot-desktop yüklü değilse jarvis/screenshot'a yönlendir
  res.redirect("/jarvis/screenshot");
});

app.get("/ai/project/analyze", async (req, res) => {
  try {
    const scanDir = req.query.path || __dirname;
    const files = [];
    function scan(dir) {
      try {
        fs.readdirSync(dir).forEach(f => {
          if (f === "node_modules" || f === ".git") return;
          const p = path.join(dir, f);
          if (fs.statSync(p).isDirectory()) scan(p);
          else files.push(p.replace(__dirname, "."));
        });
      } catch { }
    }
    scan(scanDir);
    const keyFiles = files.filter(f => f.endsWith("package.json") || f.endsWith(".csproj") || f.endsWith("requirements.txt"));
    const summary = await askLLM(`Bu dosya listesine bak:\n${files.slice(0, 60).join("\n")}\n\n1) Proje türü nedir?\n2) Mimari (MVC, Clean vs)?\n3) Eksikler neler?\nKISA RAPOR YAZ`);
    res.json({ status: "success", files: files.length, keyFiles, report: summary });
  } catch (e) { fail(res, e.message); }
});

app.post("/ai/code/write", async (req, res) => {
  const { request } = req.body;
  if (!request) return fail(res, "request gerekli");
  try {
    const generatedCode = await askLLM(`Şu isteğe göre ÇALIŞAN kod yaz:\n${request}\n\nSADECE KOD VER`);
    brain.mem.remember(`ai_code:${request.substring(0, 40)}`, "yazıldı", 0.6);
    res.json({ status: "success", generatedCode });
  } catch (e) { fail(res, e.message); }
});

app.post("/ai/debug", async (req, res) => {
  const { error, code } = req.body;
  if (!error) return fail(res, "error gerekli");
  try {
    const analysis = await askLLM(`HATA:\n${error}\n\nKOD:\n${code || "(yok)"}\n\n1) Sebep\n2) Çözüm\n3) Düzeltilmiş kod`);
    res.json({ status: "success", analysis });
  } catch (e) { fail(res, e.message); }
});

app.post("/ai/terminal/suggest", async (req, res) => {
  const { goal } = req.body;
  if (!goal) return fail(res, "goal gerekli");
  try {
    const commands = await askLLM(`Şu hedef için terminal komutlarını sırala:\n${goal}\n\nSADECE KOMUTLAR`);
    res.json({ status: "success", commands });
  } catch (e) { fail(res, e.message); }
});

app.post("/ai/docs", async (req, res) => {
  const { code } = req.body;
  if (!code) return fail(res, "code gerekli");
  try {
    const documentation = await askLLM(`Bu kod için README + API açıklaması yaz:\n${code}`);
    res.json({ status: "success", documentation });
  } catch (e) { fail(res, e.message); }
});


// ══════════════════════════════════════════════════════════════════════════════
// 11. OTONOM AJAN YARDIMCI FONKSİYONLAR (açıklamadaki orijinal)
//     fetch → axios, AGENT_WORKDIR path, approveAction Brain ile
// ══════════════════════════════════════════════════════════════════════════════

const AUTONOMY_MODE = process.env.AUTONOMY_MODE || "AUTO"; // AUTO | SAFE | ASK
const AGENT_WORKDIR = path.join(__dirname, "agent_sandbox");
const AGENT_LONG_MEMORY = path.join(__dirname, "agent_long_memory.json");

if (!fs.existsSync(AGENT_WORKDIR)) fs.mkdirSync(AGENT_WORKDIR, { recursive: true });

function calculateRisk(command) {
  const highRisk = ["rm -rf", "shutdown", "reboot", "docker run", "scp", "format", "DROP TABLE"];
  return highRisk.some(k => command.includes(k)) ? 0.9 : 0.2;
}

async function approveAction(command) {
  const risk = calculateRisk(command);
  if (AUTONOMY_MODE === "AUTO" && risk < 0.8) return true;
  if (AUTONOMY_MODE === "SAFE") return false;
  try {
    const r = await axios.post("http://localhost:11434/api/generate", {
      model: process.env.OLLAMA_MODEL || "llama3.1:8b",
      prompt: `You are an autonomous AI.\nCommand: ${command}\nRisk: ${risk}\nAnswer ONLY YES or NO`,
      stream: false
    });
    return r.data.response.toLowerCase().includes("yes");
  } catch { return false; }
}

async function agentExec(command) {
  const approved = await approveAction(command);
  if (!approved) throw new Error("❌ ACTION BLOCKED BY AUTONOMY LAYER");
  return new Promise((resolve, reject) => {
    exec(command, { cwd: AGENT_WORKDIR, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(stderr || err.message);
      resolve(stdout);
    });
  });
}

function agentHasError(output) {
  return /error|failed|exception|npm ERR/i.test(output);
}

function loadAgentLongMemory() {
  if (!fs.existsSync(AGENT_LONG_MEMORY)) return [];
  return JSON.parse(fs.readFileSync(AGENT_LONG_MEMORY, "utf8"));
}

function saveAgentLongMemory(entry) {
  const mem = loadAgentLongMemory();
  mem.push({ time: new Date().toISOString(), ...entry });
  fs.writeFileSync(AGENT_LONG_MEMORY, JSON.stringify(mem, null, 2));
}

// PLANLAYICI (orijinal kod - ollamaAsk → axios)
async function agentPlanner(goal) {
  const prompt = `You are a fully autonomous coding AI.\nBreak the goal into EXECUTABLE shell commands.\nReturn ONLY a JSON array.\n\nGoal:\n${goal}`;
  const r = await axios.post("http://localhost:11434/api/generate", {
    model: process.env.OLLAMA_MODEL || "llama3.1:8b",
    prompt,
    stream: false
  });
  const match = r.data.response.match(/\[[\s\S]*\]/);
  return match ? JSON.parse(match[0]) : [];
}

// HATA DÜZELTİCİ
async function agentFixer(errorText) {
  const r = await axios.post("http://localhost:11434/api/generate", {
    model: process.env.OLLAMA_MODEL || "llama3.1:8b",
    prompt: `You are a senior software debugger.\nGiven this terminal error, return ONLY the FIX as shell commands.\n\nERROR:\n${errorText}`,
    stream: false
  });
  return r.data.response;
}

// ANA AUTONOMOUS AGENT (orijinal)
async function runAutonomousAgent(goal) {
  console.log("\n🧠 AGENT GOAL:", goal);
  const steps = await agentPlanner(goal);

  for (const step of steps) {
    console.log("\n▶ EXEC:", step);
    try {
      const output = await agentExec(step);
      console.log(output);
      if (agentHasError(output)) throw new Error(output);
      saveAgentLongMemory({ step, success: true });
    } catch (err) {
      console.log("❌ ERROR DETECTED:", err);
      const fix = await agentFixer(err.toString());
      console.log("🛠 FIX:", fix);
      try {
        const fixOut = await agentExec(fix);
        console.log(fixOut);
        saveAgentLongMemory({ step, error: err.toString(), fix, success: true });
      } catch (e) {
        saveAgentLongMemory({ step, error: err.toString(), fix, success: false });
        throw e;
      }
    }
  }
  console.log("\n✅ AGENT TASK COMPLETED");
}

// MULTI AGENT - Rol bazlı (orijinal agent() fonksiyonu)
async function agentRole(role, task, context = "") {
  const roleDesc = {
    PLANNER: "Break goals into executable steps.",
    CODER: "Write real, working code.",
    TESTER: "Run and test the code.",
    REVIEWER: "Review code for bugs and quality.",
    FIXER: "Fix errors and bugs."
  };
  const r = await axios.post("http://localhost:11434/api/generate", {
    model: process.env.OLLAMA_MODEL || "llama3.1:8b",
    prompt: `You are acting as: ${role}\n\nROLE DESCRIPTION:\n${roleDesc[role] || role}\n\nTASK:\n${task}\n\nCONTEXT:\n${context}\n\nReturn ONLY what is required for your role.`,
    stream: false
  });
  return r.data.response;
}

// SELF IMPROVE LOOP
async function selfImproveLoop() {
  const mem = loadAgentLongMemory();
  if (mem.length < 5) return;
  try {
    const r = await axios.post("http://localhost:11434/api/generate", {
      model: process.env.OLLAMA_MODEL || "llama3.1:8b",
      prompt: `You are a self-improving AI.\nAnalyze past tasks and extract improvement rules.\n\nMEMORY:\n${JSON.stringify(mem.slice(-20), null, 2)}\n\nReturn improvement rules.`,
      stream: false
    });
    saveAgentLongMemory({ type: "SELF_IMPROVEMENT", improvements: r.data.response });
    console.log("🧠 SELF IMPROVEMENT UPDATED");
  } catch { }
}

// RISK SCORE
function riskScore(task) {
  let score = 0;
  if (/delete|rm|shutdown|format/i.test(task)) score += 10;
  if (/deploy|docker|ssh/i.test(task)) score += 7;
  return score;
}

function requireApprovalStrict(task) {
  return riskScore(task) >= 7;
}

// MULTI AGENT ORCHESTRATOR (orijinal runMultiAgent)
async function runMultiAgent(goal) {
  console.log("\n🧠 MANAGER RECEIVED GOAL:", goal);
  const planRaw = await agentRole("PLANNER", goal);
  let steps;
  try { steps = JSON.parse(planRaw); } catch { steps = planRaw.split("\n").filter(Boolean); }

  for (const step of steps) {
    console.log("\n📌 STEP:", step);
    const code = await agentRole("CODER", step);
    console.log("\n👨‍💻 CODER OUTPUT:\n", code);

    try {
      if (/npm |node |docker |git |python |dotnet /i.test(code)) {
        const out = await agentExec(code);
        if (agentHasError(out)) throw new Error(out);
      }
      const testCmd = await agentRole("TESTER", step, code);
      console.log("\n🧪 TEST CMD:", testCmd);
      const testOut = await agentExec(testCmd);
      if (agentHasError(testOut)) throw new Error(testOut);
      const review = await agentRole("REVIEWER", step, code);
      console.log("\n🔍 REVIEW:", review);
      saveAgentLongMemory({ step, code, review, success: true });
    } catch (err) {
      const fix = await agentRole("FIXER", step, err.toString());
      console.log("\n🛠 FIX:", fix);
      try {
        const fixOut = await agentExec(fix);
        saveAgentLongMemory({ step, error: err.toString(), fix, success: true });
      } catch (e) {
        saveAgentLongMemory({ step, error: err.toString(), fix, success: false });
        throw e;
      }
    }
  }
  console.log("\n✅ MULTI-AGENT GOAL COMPLETED");
}

// PARALLEL MULTI AGENT
async function runParallelAgents(goal) {
  const roles = ["PLANNER", "CODER", "TESTER", "REVIEWER"];
  const results = await Promise.all(roles.map(r => agentRole(r, goal)));
  return roles.reduce((acc, role, i) => { acc[role] = results[i]; return acc; }, {});
}

// VPS DEPLOY
async function vpsDeploy({ host, user, repo, appName }) {
  const deployScript = `set -e\nif ! command -v docker >/dev/null; then curl -fsSL https://get.docker.com | sh; fi\nrm -rf ${appName}\ngit clone ${repo} ${appName}\ncd ${appName}\ndocker build -t ${appName} .\ndocker stop ${appName} || true\ndocker rm ${appName} || true\ndocker run -d --restart always --name ${appName} -p 80:3000 ${appName}`;
  return new Promise((resolve, reject) => {
    exec(`ssh ${user}@${host} '${deployScript.replace(/'/g, "'\\''")}'`, (err, stdout, stderr) => {
      if (err) reject(stderr); else resolve(stdout);
    });
  });
}

// GITHUB PR
async function githubPRAgent({ repoPath, branch, message }) {
  const commands = `cd ${repoPath} && git checkout -b ${branch} && git add . && git commit -m "${message}" && git push origin ${branch}`;
  return new Promise((resolve, reject) => {
    exec(commands, (err, stdout, stderr) => {
      if (err) reject(stderr); else resolve(stdout);
    });
  });
}

// SELF REFACTOR
async function selfRefactor() {
  const filePath = path.join(__dirname, "server.js");
  const originalCode = fs.readFileSync(filePath, "utf8");
  const r = await axios.post("http://localhost:11434/api/generate", {
    model: process.env.OLLAMA_MODEL || "llama3.1:8b",
    prompt: `You are a senior software architect.\nRefactor this code:\n- improve readability\n- remove duplication\n- keep functionality identical\n- DO NOT break anything\n\nCODE:\n${originalCode.substring(0, 8000)}\n\nReturn FULL refactored file.`,
    stream: false
  });
  const improved = r.data.response;
  if (!improved || improved.length < originalCode.length * 0.5) throw new Error("Refactor rejected (unsafe output)");
  fs.writeFileSync(filePath + ".bak", originalCode);
  fs.writeFileSync(filePath, improved);
  return "Self refactor completed";
}


// ══════════════════════════════════════════════════════════════════════════════
// 12. AI-AGENT / AI-MULTI-AGENT / AI-AUTONOMOUS / AI-DEVOPS / FINAL-BOSS
//     (açıklamadaki orijinal endpoint'ler)
// ══════════════════════════════════════════════════════════════════════════════

app.post("/ai-agent", async (req, res) => {
  const { goal } = req.body;
  if (!goal) return res.status(400).json({ error: "goal is required" });
  try {
    await runAutonomousAgent(goal);
    brain.onAgentDone(goal, [], "success");
    res.json({ status: "completed", goal });
  } catch (err) {
    brain.onAgentDone(goal, [], "fail");
    res.status(500).json({ error: err.toString() });
  }
});

app.post("/ai-multi-agent", async (req, res) => {
  const { goal } = req.body;
  if (!goal) return res.status(400).json({ error: "goal required" });
  try {
    await runMultiAgent(goal);
    brain.onAgentDone(goal, ["PLANNER", "CODER", "TESTER", "REVIEWER", "FIXER"], "success");
    res.json({ status: "completed", goal });
  } catch (e) {
    brain.onAgentDone(goal, [], "fail");
    res.status(500).json({ error: e.toString() });
  }
});

app.post("/ai-autonomous", async (req, res) => {
  const { goal } = req.body;
  if (!goal) return fail(res, "goal gerekli");

  if (requireApprovalStrict(goal)) {
    return res.json({ status: "approval_required", risk: riskScore(goal) });
  }

  try {
    const result = await runParallelAgents(goal);
    saveAgentLongMemory({ goal, result });
    await selfImproveLoop();
    brain.onAgentDone(goal, Object.keys(result), "success");
    res.json({ status: "done", result });
  } catch (e) { fail(res, e.toString()); }
});

app.post("/ai-devops", async (req, res) => {
  const { goal, deploy, pr, refactor } = req.body;
  if (!goal) return fail(res, "goal gerekli");
  try {
    await runMultiAgent(goal);
    if (refactor) await selfRefactor();
    if (pr) await githubPRAgent(pr);
    if (deploy) await vpsDeploy(deploy);
    brain.onAgentDone(goal, ["multi-agent", refactor ? "self-refactor" : "", pr ? "github-pr" : "", deploy ? "vps-deploy" : ""].filter(Boolean), "success");
    res.json({ status: "completed", goal, actions: { refactor, pr, deploy } });
  } catch (e) {
    res.status(500).json({ error: e.toString() });
  }
});

app.post("/final-boss", async (req, res) => {
  const { goal, allowRefactor = false, allowPR = false, allowDeploy = false, prConfig, deployConfig } = req.body;
  if (!goal) return fail(res, "goal gerekli");

  const report = { goal, agents: [], status: "running" };
  try {
    report.agents.push("multi-agent");
    await runMultiAgent(goal);

    if (allowRefactor) {
      report.agents.push("self-refactor");
      await selfRefactor();
    }
    if (allowPR && prConfig) {
      report.agents.push("github-pr");
      await githubPRAgent(prConfig);
    }
    if (allowDeploy && deployConfig) {
      report.agents.push("vps-deploy");
      await vpsDeploy(deployConfig);
    }

    report.status = "completed";
    brain.onAgentDone(goal, report.agents, "success");
    res.json(report);
  } catch (err) {
    report.status = "crashed";
    res.status(500).json({ ...report, error: err.toString() });
  }
});


// ══════════════════════════════════════════════════════════════════════════════
// 13. WHATSAPP READ / INSTAGRAM SEND+READ / GMAIL SEND+READ
//     (açıklamadaki orijinal — duplicate send'ler atlandı, Brain eklendi)
//     NOT: /jarvis/whatsapp/send aktif (line 3654+6709), buraya eklenmedi
// ══════════════════════════════════════════════════════════════════════════════

// WhatsApp helper fonksiyonları (açıklamadaki orijinal)
async function resolvePhone(target) {
  if (/^\d+$/.test(target)) return target;
  return CONTACTS[target.toLowerCase()] || null;
}

async function sendWhatsApp(target, message) {
  if (!waReady) throw new Error("WhatsApp hazır değil");
  const phone = await resolvePhone(target);
  if (!phone) throw new Error("Kişi bulunamadı");
  const url = `https://web.whatsapp.com/send?phone=${phone}&text=${encodeURIComponent(message)}`;
  await waPage.goto(url);
  await waPage.waitForSelector('div[contenteditable="true"]', { timeout: 60000 });
  await waPage.keyboard.press("Enter");
}

async function readIncomingMessages() {
  if (!waReady) return [];
  return await waPage.evaluate(() => {
    const chats = [];
    document.querySelectorAll("div[role='row']").forEach(row => {
      const name = row.querySelector("span[title]")?.getAttribute("title");
      const msg = row.querySelector("span[dir='ltr']")?.innerText;
      if (name && msg) chats.push({ name, msg });
    });
    return chats;
  });
}

app.get("/jarvis/whatsapp/read", async (req, res) => {
  try {
    const msgs = await readIncomingMessages();
    res.json({ status: "success", messages: msgs });
  } catch (e) { res.json({ status: "error", message: e.message }); }
});

// Instagram helper fonksiyonları (açıklamadaki orijinal)
function resolveInstagramUser(target) {
  if (target.startsWith("@")) return target.replace("@", "");
  return IG_CONTACTS[target.toLowerCase()] || null;
}

async function sendInstagramDM(target, message) {
  if (!igReady) throw new Error("Instagram hazır değil");
  const username = resolveInstagramUser(target);
  if (!username) throw new Error("Instagram kullanıcısı bulunamadı");
  const url = `https://www.instagram.com/direct/t/${username}/`;
  await igPage.goto(url);
  await igPage.waitForSelector("div[contenteditable='true']", { timeout: 60000 });
  await igPage.click("div[contenteditable='true']");
  await igPage.keyboard.type(message, { delay: 30 });
  await igPage.keyboard.press("Enter");
}

async function readInstagramDMs() {
  if (!igReady) return [];
  return await igPage.evaluate(() => {
    const msgs = [];
    document.querySelectorAll("div[role='row']").forEach(row => {
      const user = row.querySelector("span")?.innerText;
      const lastMsg = row.querySelector("div[dir='auto']")?.innerText;
      if (user && lastMsg) msgs.push({ user, msg: lastMsg });
    });
    return msgs;
  });
}

app.post("/jarvis/instagram/send", async (req, res) => {
  try {
    const { to, message } = req.body;
    await sendInstagramDM(to, message);
    res.json({ status: "success" });
  } catch (e) { res.json({ status: "error", message: e.message }); }
});

app.get("/jarvis/instagram/read", async (req, res) => {
  try {
    const msgs = await readInstagramDMs();
    res.json({ status: "success", messages: msgs });
  } catch (e) { res.json({ status: "error", message: e.message }); }
});

// Gmail helper fonksiyonları (açıklamadaki orijinal)
async function sendMail(to, subject, text) {
  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: { user: GMAIL_CONFIG.user, pass: GMAIL_CONFIG.pass }
  });
  await transporter.sendMail({
    from: `"Jarvis 🤖" <${GMAIL_CONFIG.user}>`, to, subject, text
  });
}

async function readUnreadMails() {
  const connection = await imaps.connect(GMAIL_CONFIG.imap);
  await connection.openBox("INBOX");
  const results = await connection.search(["UNSEEN"], { bodies: ["HEADER", "TEXT"], markSeen: true });
  const mails = [];
  for (const r of results) {
    const part = r.parts.find(p => p.which === "TEXT");
    if (!part) continue;
    const parsed = await simpleParser(part.body);
    mails.push({ from: parsed.from?.text, subject: parsed.subject, text: parsed.text?.substring(0, 500) });
  }
  connection.end();
  return mails;
}

app.post("/jarvis/gmail/send", async (req, res) => {
  try {
    const { to, subject, text } = req.body;
    await sendMail(to, subject, text);
    res.json({ status: "success" });
  } catch (e) { res.json({ status: "error", message: e.message }); }
});

app.get("/jarvis/gmail/read", async (req, res) => {
  try {
    const mails = await readUnreadMails();
    res.json({ status: "success", mails });
  } catch (e) { res.json({ status: "error", message: e.message }); }
});


// ══════════════════════════════════════════════════════════════════════════════
// 14. PDF İŞLEMLERİ (açıklamadaki orijinal)
// ══════════════════════════════════════════════════════════════════════════════

let pdfParse, PDFLibDoc, PDFLibFonts, PDFLibRGB;
try {
  pdfParse = require("pdf-parse");
  const pdfLib = require("pdf-lib");
  PDFLibDoc = pdfLib.PDFDocument;
  PDFLibFonts = pdfLib.StandardFonts;
  PDFLibRGB = pdfLib.rgb;
} catch { console.warn("⚠️  pdf-parse/pdf-lib yüklü değil: npm install pdf-parse pdf-lib"); }

app.post("/jarvis/pdf/read", async (req, res) => {
  if (!pdfParse) return fail(res, "npm install pdf-parse");
  const { filePath } = req.body;
  if (!filePath || !fs.existsSync(filePath)) return fail(res, "Dosya bulunamadı");
  try {
    const d = await pdfParse(fs.readFileSync(filePath));
    res.json({ status: "success", text: d.text, pages: d.numpages });
  } catch (e) { fail(res, e.message); }
});

app.post("/jarvis/pdf/summarize", async (req, res) => {
  if (!pdfParse) return fail(res, "npm install pdf-parse");
  const { filePath } = req.body;
  if (!filePath || !fs.existsSync(filePath)) return fail(res, "Dosya bulunamadı");
  try {
    const d = await pdfParse(fs.readFileSync(filePath));
    const r = await axios.post("http://localhost:11434/api/chat", {
      model: process.env.OLLAMA_MODEL || "llama3.1:8b", stream: false,
      messages: [
        { role: "system", content: "PDF içeriğini Türkçe özetle, madde madde." },
        { role: "user", content: d.text.substring(0, 6000) }
      ]
    });
    res.json({ status: "success", summary: r.data.message.content, pages: d.numpages });
  } catch (e) { fail(res, e.message); }
});

app.post("/jarvis/pdf/search", async (req, res) => {
  if (!pdfParse) return fail(res, "npm install pdf-parse");
  const { filePath, query } = req.body;
  if (!filePath || !query) return fail(res, "filePath ve query gerekli");
  if (!fs.existsSync(filePath)) return fail(res, "Dosya bulunamadı");
  try {
    const d = await pdfParse(fs.readFileSync(filePath));
    const matches = d.text.split("\n").filter(l => l.toLowerCase().includes(query.toLowerCase())).slice(0, 20);
    res.json({ status: "success", query, matchCount: matches.length, matches });
  } catch (e) { fail(res, e.message); }
});

app.post("/jarvis/pdf/fill-form", async (req, res) => {
  if (!PDFLibDoc) return fail(res, "npm install pdf-lib");
  const { filePath, fields, outputPath } = req.body;
  if (!filePath || !fields) return fail(res, "filePath ve fields gerekli");
  if (!fs.existsSync(filePath)) return fail(res, "Dosya bulunamadı");
  try {
    const doc = await PDFLibDoc.load(fs.readFileSync(filePath));
    const font = await doc.embedFont(PDFLibFonts.Helvetica);
    const pages = doc.getPages();
    for (const f of fields) {
      pages[f.page || 0].drawText(f.text || "", {
        x: f.x || 50, y: f.y || 50, size: f.size || 12,
        font, color: PDFLibRGB(0, 0, 0)
      });
    }
    const out = outputPath || filePath.replace(".pdf", "_filled.pdf");
    fs.writeFileSync(out, await doc.save());
    res.json({ status: "success", outputPath: out });
  } catch (e) { fail(res, e.message); }
});

app.post("/jarvis/pdf/batch-read", async (req, res) => {
  if (!pdfParse) return fail(res, "npm install pdf-parse");
  const { dirPath } = req.body;
  if (!dirPath || !fs.existsSync(dirPath)) return fail(res, "Klasör bulunamadı");
  try {
    const files = fs.readdirSync(dirPath).filter(f => f.endsWith(".pdf"));
    const results = [];
    for (const f of files) {
      const d = await pdfParse(fs.readFileSync(path.join(dirPath, f)));
      results.push({ file: f, pages: d.numpages, preview: d.text.substring(0, 300) });
    }
    res.json({ status: "success", count: results.length, results });
  } catch (e) { fail(res, e.message); }
});


// ══════════════════════════════════════════════════════════════════════════════
// 15. GITHUB API (açıklamadaki orijinal — npm install @octokit/rest)
// ══════════════════════════════════════════════════════════════════════════════

let OctokitClass;
try { OctokitClass = require("@octokit/rest").Octokit; }
catch { console.warn("⚠️  @octokit/rest yüklü değil: npm install @octokit/rest"); }

function getOctokit() {
  if (!OctokitClass) throw new Error("npm install @octokit/rest");
  return new OctokitClass({ auth: process.env.GITHUB_TOKEN || null });
}

app.get("/jarvis/github/repos", async (req, res) => {
  const { username } = req.query;
  if (!username) return fail(res, "username gerekli");
  try {
    const { data } = await getOctokit().repos.listForUser({ username, per_page: 30, sort: "updated" });
    res.json({ status: "success", count: data.length, repos: data.map(r => ({ name: r.name, url: r.html_url, stars: r.stargazers_count, language: r.language })) });
  } catch (e) { fail(res, e.message); }
});

app.get("/jarvis/github/issues", async (req, res) => {
  const { owner, repo, state = "open" } = req.query;
  if (!owner || !repo) return fail(res, "owner ve repo gerekli");
  try {
    const { data } = await getOctokit().issues.listForRepo({ owner, repo, state, per_page: 20 });
    res.json({ status: "success", count: data.length, issues: data.map(i => ({ number: i.number, title: i.title, state: i.state, url: i.html_url })) });
  } catch (e) { fail(res, e.message); }
});

app.post("/jarvis/github/issues/create", async (req, res) => {
  const { owner, repo, title, body, labels } = req.body;
  if (!owner || !repo || !title) return fail(res, "owner, repo ve title gerekli");
  try {
    const { data } = await getOctokit().issues.create({ owner, repo, title, body: body || "", labels: labels || [] });
    res.json({ status: "success", number: data.number, url: data.html_url });
  } catch (e) { fail(res, e.message); }
});

app.get("/jarvis/github/commits", async (req, res) => {
  const { owner, repo, branch = "main", limit = 10 } = req.query;
  if (!owner || !repo) return fail(res, "owner ve repo gerekli");
  try {
    const { data } = await getOctokit().repos.listCommits({ owner, repo, sha: branch, per_page: parseInt(limit) });
    res.json({ status: "success", commits: data.map(c => ({ sha: c.sha.substring(0, 7), message: c.commit.message, author: c.commit.author.name, date: c.commit.author.date })) });
  } catch (e) { fail(res, e.message); }
});

app.get("/jarvis/github/file", async (req, res) => {
  const { owner, repo, filePath, branch = "main" } = req.query;
  if (!owner || !repo || !filePath) return fail(res, "owner, repo ve filePath gerekli");
  try {
    const { data } = await getOctokit().repos.getContent({ owner, repo, path: filePath, ref: branch });
    res.json({ status: "success", content: Buffer.from(data.content, "base64").toString("utf8"), sha: data.sha });
  } catch (e) { fail(res, e.message); }
});

app.post("/jarvis/github/file/write", async (req, res) => {
  const { owner, repo, filePath, content, message, sha } = req.body;
  if (!owner || !repo || !filePath || !content || !message) return fail(res, "Tüm alanlar gerekli");
  try {
    const params = { owner, repo, path: filePath, message, content: Buffer.from(content).toString("base64") };
    if (sha) params.sha = sha;
    const { data } = await getOctokit().repos.createOrUpdateFileContents(params);
    res.json({ status: "success", url: data.content.html_url });
  } catch (e) { fail(res, e.message); }
});

app.get("/jarvis/github/pulls", async (req, res) => {
  const { owner, repo, state = "open" } = req.query;
  if (!owner || !repo) return fail(res, "owner ve repo gerekli");
  try {
    const { data } = await getOctokit().pulls.list({ owner, repo, state, per_page: 20 });
    res.json({ status: "success", count: data.length, pulls: data.map(p => ({ number: p.number, title: p.title, branch: p.head.ref, url: p.html_url })) });
  } catch (e) { fail(res, e.message); }
});

app.get("/jarvis/github/search", async (req, res) => {
  const { q, sort = "stars", limit = 10 } = req.query;
  if (!q) return fail(res, "q gerekli");
  try {
    const { data } = await getOctokit().search.repos({ q, sort, per_page: parseInt(limit) });
    res.json({ status: "success", totalCount: data.total_count, repos: data.items.map(r => ({ name: r.full_name, stars: r.stargazers_count, url: r.html_url, language: r.language })) });
  } catch (e) { fail(res, e.message); }
});

app.post("/jarvis/github/ai-commit-message", async (req, res) => {
  const { diff } = req.body;
  if (!diff) return fail(res, "diff gerekli");
  try {
    const r = await axios.post("http://localhost:11434/api/chat", {
      model: process.env.OLLAMA_MODEL || "llama3.1:8b", stream: false,
      messages: [
        { role: "system", content: "Git diff'e bakarak kısa conventional commit mesajı yaz (feat/fix/docs/refactor). SADECE mesaj döndür." },
        { role: "user", content: diff.substring(0, 4000) }
      ]
    });
    res.json({ status: "success", message: r.data.message.content.trim() });
  } catch (e) { fail(res, e.message); }
});


// ══════════════════════════════════════════════════════════════════════════════
// 16. GOOGLE CALENDAR + GOOGLE DRIVE (açıklamadaki orijinal — npm install googleapis)
// ══════════════════════════════════════════════════════════════════════════════

let googleLib;
try { googleLib = require("googleapis").google; }
catch { console.warn("⚠️  googleapis yüklü değil: npm install googleapis"); }

const GCAL_CREDS_PATH = path.join(__dirname, "credentials.json");
const GCAL_TOKEN_PATH = path.join(__dirname, "token.json");

async function getGCalAuth() {
  if (!googleLib) throw new Error("npm install googleapis");
  if (!fs.existsSync(GCAL_CREDS_PATH)) throw new Error("credentials.json bulunamadı. Google Cloud Console'dan indirin.");
  const credentials = JSON.parse(fs.readFileSync(GCAL_CREDS_PATH));
  const { client_secret, client_id, redirect_uris } = credentials.installed || credentials.web;
  const oAuth2Client = new googleLib.auth.OAuth2(client_id, client_secret, redirect_uris[0]);
  if (fs.existsSync(GCAL_TOKEN_PATH)) {
    oAuth2Client.setCredentials(JSON.parse(fs.readFileSync(GCAL_TOKEN_PATH)));
    return oAuth2Client;
  }
  throw new Error("Önce /jarvis/gcal/auth ile yetkilendirin");
}

async function getGDriveAuth() {
  return getGCalAuth(); // Aynı credentials
}

app.get("/jarvis/gcal/auth", (req, res) => {
  if (!googleLib) return fail(res, "npm install googleapis");
  if (!fs.existsSync(GCAL_CREDS_PATH)) return res.send("credentials.json eksik.");
  const creds = JSON.parse(fs.readFileSync(GCAL_CREDS_PATH));
  const { client_secret, client_id, redirect_uris } = creds.installed || creds.web;
  const auth = new googleLib.auth.OAuth2(client_id, client_secret, redirect_uris[0]);
  const url = auth.generateAuthUrl({ access_type: "offline", scope: ["https://www.googleapis.com/auth/calendar", "https://www.googleapis.com/auth/drive"] });
  res.redirect(url);
});

app.get("/jarvis/gcal/callback", async (req, res) => {
  if (!googleLib || !fs.existsSync(GCAL_CREDS_PATH)) return fail(res, "Setup eksik");
  const creds = JSON.parse(fs.readFileSync(GCAL_CREDS_PATH));
  const { client_secret, client_id, redirect_uris } = creds.installed || creds.web;
  const auth = new googleLib.auth.OAuth2(client_id, client_secret, redirect_uris[0]);
  const { tokens } = await auth.getToken(req.query.code);
  fs.writeFileSync(GCAL_TOKEN_PATH, JSON.stringify(tokens));
  res.send("✅ Google Calendar + Drive yetkilendirildi!");
});

app.get("/jarvis/gcal/calendars", async (req, res) => {
  try {
    const auth = await getGCalAuth();
    const { data } = await googleLib.calendar({ version: "v3", auth }).calendarList.list();
    res.json({ status: "success", calendars: data.items.map(c => ({ id: c.id, name: c.summary })) });
  } catch (e) { fail(res, e.message); }
});

app.get("/jarvis/gcal/events", async (req, res) => {
  const { maxResults = 10, timeMin = new Date().toISOString() } = req.query;
  try {
    const auth = await getGCalAuth();
    const { data } = await googleLib.calendar({ version: "v3", auth }).events.list({
      calendarId: "primary", timeMin, maxResults: parseInt(maxResults), singleEvents: true, orderBy: "startTime"
    });
    res.json({ status: "success", count: data.items.length, events: data.items.map(e => ({ id: e.id, title: e.summary, start: e.start?.dateTime || e.start?.date, end: e.end?.dateTime || e.end?.date })) });
  } catch (e) { fail(res, e.message); }
});

app.post("/jarvis/gcal/events/create", async (req, res) => {
  const { title, start, end, description, location } = req.body;
  if (!title || !start || !end) return fail(res, "title, start ve end gerekli");
  try {
    const auth = await getGCalAuth();
    const { data } = await googleLib.calendar({ version: "v3", auth }).events.insert({
      calendarId: "primary", requestBody: { summary: title, description, location, start: { dateTime: start, timeZone: "Europe/Istanbul" }, end: { dateTime: end, timeZone: "Europe/Istanbul" } }
    });
    res.json({ status: "success", id: data.id, url: data.htmlLink });
  } catch (e) { fail(res, e.message); }
});

app.post("/jarvis/gcal/events/update", async (req, res) => {
  const { eventId, title, start, end, description } = req.body;
  if (!eventId) return fail(res, "eventId gerekli");
  try {
    const auth = await getGCalAuth();
    const patch = {};
    if (title) patch.summary = title;
    if (description) patch.description = description;
    if (start) patch.start = { dateTime: start, timeZone: "Europe/Istanbul" };
    if (end) patch.end = { dateTime: end, timeZone: "Europe/Istanbul" };
    const { data } = await googleLib.calendar({ version: "v3", auth }).events.patch({ calendarId: "primary", eventId, requestBody: patch });
    res.json({ status: "success", id: data.id, url: data.htmlLink });
  } catch (e) { fail(res, e.message); }
});

app.delete("/jarvis/gcal/events/delete", async (req, res) => {
  const { eventId } = req.body;
  if (!eventId) return fail(res, "eventId gerekli");
  try {
    const auth = await getGCalAuth();
    await googleLib.calendar({ version: "v3", auth }).events.delete({ calendarId: "primary", eventId });
    res.json({ status: "success", message: "Etkinlik silindi" });
  } catch (e) { fail(res, e.message); }
});

app.post("/jarvis/gcal/ai-create", async (req, res) => {
  const { description } = req.body;
  if (!description) return fail(res, "description gerekli");
  try {
    const r = await axios.post("http://localhost:11434/api/chat", {
      model: process.env.OLLAMA_MODEL || "llama3.1:8b", stream: false,
      messages: [
        { role: "system", content: `Şu an: ${new Date().toISOString()}. Etkinlik açıklamasını JSON'a çevir: {"title":"","start":"2025-01-01T10:00:00","end":"2025-01-01T11:00:00","description":"","location":""}. SADECE JSON döndür.` },
        { role: "user", content: description }
      ]
    });
    const match = r.data.message.content.match(/\{[\s\S]*\}/);
    if (!match) return fail(res, "AI parse edemedi");
    const ev = JSON.parse(match[0]);
    const auth = await getGCalAuth();
    const { data } = await googleLib.calendar({ version: "v3", auth }).events.insert({
      calendarId: "primary", requestBody: { summary: ev.title, description: ev.description, location: ev.location, start: { dateTime: ev.start, timeZone: "Europe/Istanbul" }, end: { dateTime: ev.end, timeZone: "Europe/Istanbul" } }
    });
    res.json({ status: "success", event: ev, id: data.id, url: data.htmlLink });
  } catch (e) { fail(res, e.message); }
});

// Google Drive
app.get("/jarvis/gdrive/list", async (req, res) => {
  const { folderId = "root", query = "" } = req.query;
  try {
    const auth = await getGDriveAuth();
    const drive = googleLib.drive({ version: "v3", auth });
    let q = `'${folderId}' in parents and trashed = false`;
    if (query) q += ` and name contains '${query}'`;
    const { data } = await drive.files.list({ q, fields: "files(id,name,mimeType,size,modifiedTime,webViewLink)", pageSize: 30, orderBy: "modifiedTime desc" });
    res.json({ status: "success", count: data.files.length, files: data.files });
  } catch (e) { fail(res, e.message); }
});

app.get("/jarvis/gdrive/search", async (req, res) => {
  const { query } = req.query;
  if (!query) return fail(res, "query gerekli");
  try {
    const auth = await getGDriveAuth();
    const { data } = await googleLib.drive({ version: "v3", auth }).files.list({ q: `name contains '${query}' and trashed = false`, fields: "files(id,name,mimeType,size,webViewLink)", pageSize: 20 });
    res.json({ status: "success", count: data.files.length, files: data.files });
  } catch (e) { fail(res, e.message); }
});

app.post("/jarvis/gdrive/upload", async (req, res) => {
  const { filePath, folderId, fileName } = req.body;
  if (!filePath || !fs.existsSync(filePath)) return fail(res, "filePath gerekli ve mevcut olmalı");
  try {
    const auth = await getGDriveAuth();
    const drive = googleLib.drive({ version: "v3", auth });
    const ext = path.extname(filePath).toLowerCase();
    const mimeMap = { ".pdf": "application/pdf", ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document", ".png": "image/png", ".jpg": "image/jpeg" };
    const metadata = { name: fileName || path.basename(filePath) };
    if (folderId) metadata.parents = [folderId];
    const { data } = await drive.files.create({ resource: metadata, media: { mimeType: mimeMap[ext] || "application/octet-stream", body: fs.createReadStream(filePath) }, fields: "id,name,webViewLink" });
    res.json({ status: "success", id: data.id, name: data.name, url: data.webViewLink });
  } catch (e) { fail(res, e.message); }
});

app.post("/jarvis/gdrive/download", async (req, res) => {
  const { fileId, outputPath } = req.body;
  if (!fileId || !outputPath) return fail(res, "fileId ve outputPath gerekli");
  try {
    const auth = await getGDriveAuth();
    const drive = googleLib.drive({ version: "v3", auth });
    const dest = fs.createWriteStream(outputPath);
    const response = await drive.files.get({ fileId, alt: "media" }, { responseType: "stream" });
    await new Promise((resolve, reject) => response.data.on("end", resolve).on("error", reject).pipe(dest));
    res.json({ status: "success", outputPath });
  } catch (e) { fail(res, e.message); }
});

app.post("/jarvis/gdrive/mkdir", async (req, res) => {
  const { name, parentId } = req.body;
  if (!name) return fail(res, "name gerekli");
  try {
    const auth = await getGDriveAuth();
    const metadata = { name, mimeType: "application/vnd.google-apps.folder" };
    if (parentId) metadata.parents = [parentId];
    const { data } = await googleLib.drive({ version: "v3", auth }).files.create({ resource: metadata, fields: "id,name" });
    res.json({ status: "success", id: data.id, name: data.name });
  } catch (e) { fail(res, e.message); }
});

app.delete("/jarvis/gdrive/delete", async (req, res) => {
  const { fileId } = req.body;
  if (!fileId) return fail(res, "fileId gerekli");
  try {
    const auth = await getGDriveAuth();
    await googleLib.drive({ version: "v3", auth }).files.delete({ fileId });
    res.json({ status: "success", message: "Silindi" });
  } catch (e) { fail(res, e.message); }
});

app.post("/jarvis/gdrive/share", async (req, res) => {
  const { fileId, role = "reader" } = req.body;
  if (!fileId) return fail(res, "fileId gerekli");
  try {
    const auth = await getGDriveAuth();
    const drive = googleLib.drive({ version: "v3", auth });
    await drive.permissions.create({ fileId, resource: { role, type: "anyone" } });
    const { data } = await drive.files.get({ fileId, fields: "webViewLink" });
    res.json({ status: "success", publicUrl: data.webViewLink });
  } catch (e) { fail(res, e.message); }
});

app.get("/jarvis/gdrive/read-doc", async (req, res) => {
  const { fileId } = req.query;
  if (!fileId) return fail(res, "fileId gerekli");
  try {
    const auth = await getGDriveAuth();
    const response = await googleLib.drive({ version: "v3", auth }).files.export({ fileId, mimeType: "text/plain" }, { responseType: "text" });
    res.json({ status: "success", text: response.data.substring(0, 8000) });
  } catch (e) { fail(res, e.message); }
});


// ══════════════════════════════════════════════════════════════════════════════
// 17. NOTION (açıklamadaki orijinal — npm install @notionhq/client)
// ══════════════════════════════════════════════════════════════════════════════

let NotionClientClass;
try { NotionClientClass = require("@notionhq/client").Client; }
catch { console.warn("⚠️  @notionhq/client yüklü değil: npm install @notionhq/client"); }

function getNotion() {
  if (!NotionClientClass) throw new Error("npm install @notionhq/client");
  if (!process.env.NOTION_TOKEN) throw new Error("NOTION_TOKEN env variable tanımlı değil");
  return new NotionClientClass({ auth: process.env.NOTION_TOKEN });
}

app.get("/jarvis/notion/search", async (req, res) => {
  const { query = "" } = req.query;
  try {
    const notion = getNotion();
    const response = await notion.search({ query, page_size: 20 });
    res.json({
      status: "success", count: response.results.length,
      results: response.results.map(r => ({
        id: r.id, type: r.object,
        title: r.properties?.title?.title?.[0]?.plain_text || r.properties?.Name?.title?.[0]?.plain_text || "Başlıksız"
      }))
    });
  } catch (e) { fail(res, e.message); }
});

app.get("/jarvis/notion/page", async (req, res) => {
  const { pageId } = req.query;
  if (!pageId) return fail(res, "pageId gerekli");
  try {
    const notion = getNotion();
    const page = await notion.pages.retrieve({ page_id: pageId });
    const blocks = await notion.blocks.children.list({ block_id: pageId });
    const text = blocks.results.map(b => b[b.type]?.rich_text?.map(t => t.plain_text).join("") || "").join("\n");
    res.json({ status: "success", id: page.id, text });
  } catch (e) { fail(res, e.message); }
});

app.post("/jarvis/notion/page/create", async (req, res) => {
  const { parentId, title, content } = req.body;
  if (!parentId || !title) return fail(res, "parentId ve title gerekli");
  try {
    const page = await getNotion().pages.create({
      parent: { page_id: parentId },
      properties: { title: { title: [{ text: { content: title } }] } },
      children: content ? [{ object: "block", type: "paragraph", paragraph: { rich_text: [{ text: { content } }] } }] : []
    });
    res.json({ status: "success", id: page.id, url: page.url });
  } catch (e) { fail(res, e.message); }
});

app.post("/jarvis/notion/page/append", async (req, res) => {
  const { pageId, content } = req.body;
  if (!pageId || !content) return fail(res, "pageId ve content gerekli");
  try {
    await getNotion().blocks.children.append({ block_id: pageId, children: [{ object: "block", type: "paragraph", paragraph: { rich_text: [{ text: { content } }] } }] });
    res.json({ status: "success", message: "İçerik eklendi" });
  } catch (e) { fail(res, e.message); }
});

app.post("/jarvis/notion/database/query", async (req, res) => {
  const { databaseId, filter } = req.body;
  const dbId = databaseId || process.env.NOTION_DB_ID;
  if (!dbId) return fail(res, "databaseId veya NOTION_DB_ID env gerekli");
  try {
    const params = { database_id: dbId };
    if (filter) params.filter = filter;
    const r = await getNotion().databases.query(params);
    res.json({ status: "success", count: r.results.length, results: r.results.map(p => ({ id: p.id, url: p.url, properties: p.properties })) });
  } catch (e) { fail(res, e.message); }
});

app.post("/jarvis/notion/database/add", async (req, res) => {
  const { databaseId, properties } = req.body;
  const dbId = databaseId || process.env.NOTION_DB_ID;
  if (!dbId || !properties) return fail(res, "databaseId ve properties gerekli");
  try {
    const page = await getNotion().pages.create({ parent: { database_id: dbId }, properties });
    res.json({ status: "success", id: page.id, url: page.url });
  } catch (e) { fail(res, e.message); }
});

app.post("/jarvis/notion/page/update", async (req, res) => {
  const { pageId, properties } = req.body;
  if (!pageId || !properties) return fail(res, "pageId ve properties gerekli");
  try {
    const page = await getNotion().pages.update({ page_id: pageId, properties });
    res.json({ status: "success", id: page.id });
  } catch (e) { fail(res, e.message); }
});

app.post("/jarvis/notion/ai-note", async (req, res) => {
  const { prompt, parentId } = req.body;
  if (!prompt || !parentId) return fail(res, "prompt ve parentId gerekli");
  try {
    const r = await axios.post("http://localhost:11434/api/chat", {
      model: process.env.OLLAMA_MODEL || "llama3.1:8b", stream: false,
      messages: [
        { role: "system", content: "Notion notu yaz. JSON üret: {\"title\":\"...\",\"content\":\"...\"}. SADECE JSON döndür." },
        { role: "user", content: prompt }
      ]
    });
    const match = r.data.message.content.match(/\{[\s\S]*\}/);
    if (!match) return fail(res, "AI parse edemedi");
    const note = JSON.parse(match[0]);
    const page = await getNotion().pages.create({
      parent: { page_id: parentId },
      properties: { title: { title: [{ text: { content: note.title } }] } },
      children: [{ object: "block", type: "paragraph", paragraph: { rich_text: [{ text: { content: note.content } }] } }]
    });
    res.json({ status: "success", id: page.id, url: page.url, note });
  } catch (e) { fail(res, e.message); }
});


// ══════════════════════════════════════════════════════════════════════════════
// 18. DROPBOX (açıklamadaki orijinal — DROPBOX_TOKEN env)
// ══════════════════════════════════════════════════════════════════════════════

function dbxHeaders() {
  if (!process.env.DROPBOX_TOKEN) throw new Error("DROPBOX_TOKEN env eksik");
  return { Authorization: `Bearer ${process.env.DROPBOX_TOKEN}`, "Content-Type": "application/json" };
}

app.get("/jarvis/dropbox/list", async (req, res) => {
  const { folder = "" } = req.query;
  try {
    const r = await axios.post("https://api.dropboxapi.com/2/files/list_folder", { path: folder || "" }, { headers: dbxHeaders() });
    res.json({ status: "success", count: r.data.entries.length, files: r.data.entries.map(f => ({ name: f.name, type: f[".tag"], size: f.size })) });
  } catch (e) { fail(res, e.message); }
});

app.post("/jarvis/dropbox/upload", async (req, res) => {
  const { filePath, destPath } = req.body;
  if (!filePath || !fs.existsSync(filePath)) return fail(res, "filePath gerekli ve mevcut olmalı");
  try {
    const content = fs.readFileSync(filePath);
    const r = await axios.post("https://content.dropboxapi.com/2/files/upload", content, {
      headers: { ...dbxHeaders(), "Content-Type": "application/octet-stream", "Dropbox-API-Arg": JSON.stringify({ path: destPath || "/" + path.basename(filePath), mode: "overwrite" }) }
    });
    res.json({ status: "success", path: r.data.path_display, size: r.data.size });
  } catch (e) { fail(res, e.message); }
});

app.post("/jarvis/dropbox/download", async (req, res) => {
  const { dropboxPath, outputPath } = req.body;
  if (!dropboxPath || !outputPath) return fail(res, "dropboxPath ve outputPath gerekli");
  try {
    const r = await axios.post("https://content.dropboxapi.com/2/files/download", null, {
      headers: { ...dbxHeaders(), "Content-Type": "text/plain", "Dropbox-API-Arg": JSON.stringify({ path: dropboxPath }) }, responseType: "arraybuffer"
    });
    fs.writeFileSync(outputPath, r.data);
    res.json({ status: "success", outputPath });
  } catch (e) { fail(res, e.message); }
});

app.get("/jarvis/dropbox/search", async (req, res) => {
  const { query } = req.query;
  if (!query) return fail(res, "query gerekli");
  try {
    const r = await axios.post("https://api.dropboxapi.com/2/files/search_v2", { query }, { headers: dbxHeaders() });
    res.json({ status: "success", results: (r.data.matches || []).map(m => ({ name: m.metadata?.metadata?.name, path: m.metadata?.metadata?.path_display })) });
  } catch (e) { fail(res, e.message); }
});

app.post("/jarvis/dropbox/share", async (req, res) => {
  const { filePath } = req.body;
  if (!filePath) return fail(res, "filePath gerekli");
  try {
    const r = await axios.post("https://api.dropboxapi.com/2/sharing/create_shared_link_with_settings", { path: filePath, settings: { requested_visibility: "public" } }, { headers: dbxHeaders() });
    res.json({ status: "success", url: r.data.url.replace("dl=0", "dl=1") });
  } catch (e) { fail(res, e.message); }
});

app.post("/jarvis/dropbox/delete", async (req, res) => {
  const { filePath } = req.body;
  if (!filePath) return fail(res, "filePath gerekli");
  try {
    await axios.post("https://api.dropboxapi.com/2/files/delete_v2", { path: filePath }, { headers: dbxHeaders() });
    res.json({ status: "success", message: "Silindi" });
  } catch (e) { fail(res, e.message); }
});


// ══════════════════════════════════════════════════════════════════════════════
// 19. ONEDRIVE (açıklamadaki orijinal — ONEDRIVE_CLIENT_ID + ONEDRIVE_CLIENT_SECRET)
// ══════════════════════════════════════════════════════════════════════════════

let oneDriveToken = null;

app.get("/jarvis/onedrive/auth", (req, res) => {
  const clientId = process.env.ONEDRIVE_CLIENT_ID;
  if (!clientId) return fail(res, "ONEDRIVE_CLIENT_ID env eksik");
  const authUrl = `https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=${clientId}&response_type=code&redirect_uri=http://localhost:${PORT}/jarvis/onedrive/callback&scope=Files.ReadWrite offline_access`;
  res.redirect(authUrl);
});

app.get("/jarvis/onedrive/callback", async (req, res) => {
  const { code } = req.query;
  const clientId = process.env.ONEDRIVE_CLIENT_ID;
  const clientSecret = process.env.ONEDRIVE_CLIENT_SECRET;
  if (!clientId || !clientSecret) return fail(res, "ONEDRIVE env eksik");
  try {
    const r = await axios.post("https://login.microsoftonline.com/common/oauth2/v2.0/token",
      new URLSearchParams({ grant_type: "authorization_code", code, client_id: clientId, client_secret: clientSecret, redirect_uri: `http://localhost:${PORT}/jarvis/onedrive/callback` }),
      { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
    );
    oneDriveToken = r.data.access_token;
    res.send("✅ OneDrive yetkilendirildi!");
  } catch (e) { fail(res, e.message); }
});

app.get("/jarvis/onedrive/list", async (req, res) => {
  if (!oneDriveToken) return fail(res, "Önce /jarvis/onedrive/auth ile yetkilendirin");
  const { folderId = "root" } = req.query;
  try {
    const r = await axios.get(`https://graph.microsoft.com/v1.0/me/drive/${folderId}/children`, { headers: { Authorization: `Bearer ${oneDriveToken}` } });
    res.json({ status: "success", count: r.data.value.length, files: r.data.value.map(f => ({ name: f.name, id: f.id, size: f.size, type: f.folder ? "folder" : "file" })) });
  } catch (e) { fail(res, e.message); }
});

app.get("/jarvis/onedrive/search", async (req, res) => {
  if (!oneDriveToken) return fail(res, "Önce yetkilendirin");
  const { query } = req.query;
  if (!query) return fail(res, "query gerekli");
  try {
    const r = await axios.get(`https://graph.microsoft.com/v1.0/me/drive/root/search(q='${query}')`, { headers: { Authorization: `Bearer ${oneDriveToken}` } });
    res.json({ status: "success", count: r.data.value.length, files: r.data.value.map(f => ({ name: f.name, id: f.id, webUrl: f.webUrl })) });
  } catch (e) { fail(res, e.message); }
});

app.post("/jarvis/onedrive/upload", async (req, res) => {
  if (!oneDriveToken) return fail(res, "Önce yetkilendirin");
  const { filePath, destName } = req.body;
  if (!filePath || !fs.existsSync(filePath)) return fail(res, "filePath gerekli ve mevcut olmalı");
  try {
    const content = fs.readFileSync(filePath);
    const name = destName || path.basename(filePath);
    const r = await axios.put(`https://graph.microsoft.com/v1.0/me/drive/root:/${name}:/content`, content, { headers: { Authorization: `Bearer ${oneDriveToken}`, "Content-Type": "application/octet-stream" } });
    res.json({ status: "success", name: r.data.name, webUrl: r.data.webUrl });
  } catch (e) { fail(res, e.message); }
});

app.post("/jarvis/onedrive/share", async (req, res) => {
  if (!oneDriveToken) return fail(res, "Önce yetkilendirin");
  const { fileId } = req.body;
  if (!fileId) return fail(res, "fileId gerekli");
  try {
    const r = await axios.post(`https://graph.microsoft.com/v1.0/me/drive/items/${fileId}/createLink`, { type: "view", scope: "anonymous" }, { headers: { Authorization: `Bearer ${oneDriveToken}` } });
    res.json({ status: "success", url: r.data.link.webUrl });
  } catch (e) { fail(res, e.message); }
});


// ══════════════════════════════════════════════════════════════════════════════
// 20. DISCORD (açıklamadaki orijinal — npm install discord.js)
// ══════════════════════════════════════════════════════════════════════════════

let discordClient = null;

function getDiscordClient() {
  if (discordClient?.isReady()) return discordClient;
  if (!process.env.DISCORD_TOKEN) throw new Error("DISCORD_TOKEN env eksik");
  try {
    const { Client, GatewayIntentBits } = require("discord.js");
    discordClient = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });
    discordClient.login(process.env.DISCORD_TOKEN);
    return discordClient;
  } catch { throw new Error("npm install discord.js"); }
}

app.post("/jarvis/discord/send", async (req, res) => {
  const { channelId, message } = req.body;
  if (!message) return fail(res, "message gerekli");
  try {
    const client = getDiscordClient();
    const chId = channelId || process.env.DISCORD_CHANNEL_ID;
    if (!chId) return fail(res, "channelId veya DISCORD_CHANNEL_ID env gerekli");
    await new Promise((resolve, reject) => {
      if (client.isReady()) return resolve();
      client.once("ready", resolve);
      client.once("error", reject);
    });
    const channel = await client.channels.fetch(chId);
    const sent = await channel.send(message);
    res.json({ status: "success", messageId: sent.id });
  } catch (e) { fail(res, e.message); }
});

app.get("/jarvis/discord/messages", async (req, res) => {
  const { channelId, limit = 10 } = req.query;
  try {
    const client = getDiscordClient();
    const chId = channelId || process.env.DISCORD_CHANNEL_ID;
    if (!chId) return fail(res, "channelId gerekli");
    const channel = await client.channels.fetch(chId);
    const messages = await channel.messages.fetch({ limit: parseInt(limit) });
    res.json({ status: "success", messages: [...messages.values()].map(m => ({ id: m.id, author: m.author.username, content: m.content, timestamp: m.createdAt })) });
  } catch (e) { fail(res, e.message); }
});

app.post("/jarvis/discord/embed", async (req, res) => {
  const { channelId, title, description, color = 0x7c3aed } = req.body;
  if (!description) return fail(res, "description gerekli");
  try {
    const { EmbedBuilder } = require("discord.js");
    const client = getDiscordClient();
    const chId = channelId || process.env.DISCORD_CHANNEL_ID;
    const channel = await client.channels.fetch(chId);
    const embed = new EmbedBuilder().setTitle(title || "Jarvis").setDescription(description).setColor(color).setTimestamp();
    const sent = await channel.send({ embeds: [embed] });
    res.json({ status: "success", messageId: sent.id });
  } catch (e) { fail(res, e.message); }
});

app.get("/jarvis/discord/status", (req, res) => {
  res.json({ status: "success", ready: discordClient?.isReady() || false });
});


// ══════════════════════════════════════════════════════════════════════════════
// 21. SLACK (açıklamadaki orijinal — npm install @slack/web-api)
// ══════════════════════════════════════════════════════════════════════════════

function getSlack() {
  if (!process.env.SLACK_TOKEN) throw new Error("SLACK_TOKEN env eksik");
  try { return new (require("@slack/web-api").WebClient)(process.env.SLACK_TOKEN); }
  catch { throw new Error("npm install @slack/web-api"); }
}

app.post("/jarvis/slack/send", async (req, res) => {
  const { channel, text } = req.body;
  if (!channel || !text) return fail(res, "channel ve text gerekli");
  try {
    const r = await getSlack().chat.postMessage({ channel, text });
    res.json({ status: "success", ts: r.ts, channel: r.channel });
  } catch (e) { fail(res, e.message); }
});

app.get("/jarvis/slack/channels", async (req, res) => {
  try {
    const r = await getSlack().conversations.list({ limit: 50 });
    res.json({ status: "success", channels: r.channels.map(c => ({ id: c.id, name: c.name, isPrivate: c.is_private })) });
  } catch (e) { fail(res, e.message); }
});

app.get("/jarvis/slack/messages", async (req, res) => {
  const { channel, limit = 10 } = req.query;
  if (!channel) return fail(res, "channel gerekli");
  try {
    const r = await getSlack().conversations.history({ channel, limit: parseInt(limit) });
    res.json({ status: "success", messages: r.messages.map(m => ({ ts: m.ts, user: m.user, text: m.text })) });
  } catch (e) { fail(res, e.message); }
});

app.get("/jarvis/slack/users", async (req, res) => {
  try {
    const r = await getSlack().users.list();
    res.json({ status: "success", users: r.members.filter(u => !u.is_bot && !u.deleted).map(u => ({ id: u.id, name: u.real_name, username: u.name })) });
  } catch (e) { fail(res, e.message); }
});

app.post("/jarvis/slack/rich-message", async (req, res) => {
  const { channel, title, text, color = "#7c3aed" } = req.body;
  if (!channel || !text) return fail(res, "channel ve text gerekli");
  try {
    const r = await getSlack().chat.postMessage({ channel, attachments: [{ color, title: title || "Jarvis", text }] });
    res.json({ status: "success", ts: r.ts });
  } catch (e) { fail(res, e.message); }
});


// ══════════════════════════════════════════════════════════════════════════════
// 22. TODOIST (açıklamadaki orijinal — TODOIST_TOKEN env)
// ══════════════════════════════════════════════════════════════════════════════

function todoistHeaders() {
  if (!process.env.TODOIST_TOKEN) throw new Error("TODOIST_TOKEN env eksik");
  return { Authorization: `Bearer ${process.env.TODOIST_TOKEN}` };
}

app.get("/jarvis/todoist/tasks", async (req, res) => {
  try {
    const r = await axios.get("https://api.todoist.com/rest/v2/tasks", { headers: todoistHeaders() });
    res.json({ status: "success", count: r.data.length, tasks: r.data.map(t => ({ id: t.id, content: t.content, priority: t.priority, due: t.due?.string })) });
  } catch (e) { fail(res, e.message); }
});

app.post("/jarvis/todoist/tasks/add", async (req, res) => {
  const { content, priority = 1, due_string } = req.body;
  if (!content) return fail(res, "content gerekli");
  try {
    const body = { content, priority };
    if (due_string) body.due_string = due_string;
    const r = await axios.post("https://api.todoist.com/rest/v2/tasks", body, { headers: todoistHeaders() });
    res.json({ status: "success", id: r.data.id, content: r.data.content });
  } catch (e) { fail(res, e.message); }
});

app.post("/jarvis/todoist/tasks/complete", async (req, res) => {
  const { taskId } = req.body;
  if (!taskId) return fail(res, "taskId gerekli");
  try {
    await axios.post(`https://api.todoist.com/rest/v2/tasks/${taskId}/close`, {}, { headers: todoistHeaders() });
    res.json({ status: "success", message: "Görev tamamlandı" });
  } catch (e) { fail(res, e.message); }
});

app.post("/jarvis/todoist/tasks/update", async (req, res) => {
  const { taskId, content, priority, due_string } = req.body;
  if (!taskId) return fail(res, "taskId gerekli");
  try {
    const body = {};
    if (content) body.content = content;
    if (priority) body.priority = priority;
    if (due_string) body.due_string = due_string;
    await axios.post(`https://api.todoist.com/rest/v2/tasks/${taskId}`, body, { headers: todoistHeaders() });
    res.json({ status: "success", message: "Güncellendi" });
  } catch (e) { fail(res, e.message); }
});

app.get("/jarvis/todoist/projects", async (req, res) => {
  try {
    const r = await axios.get("https://api.todoist.com/rest/v2/projects", { headers: todoistHeaders() });
    res.json({ status: "success", projects: r.data.map(p => ({ id: p.id, name: p.name, color: p.color })) });
  } catch (e) { fail(res, e.message); }
});

app.post("/jarvis/todoist/ai-add", async (req, res) => {
  const { description } = req.body;
  if (!description) return fail(res, "description gerekli");
  try {
    const r = await axios.post("http://localhost:11434/api/chat", {
      model: process.env.OLLAMA_MODEL || "llama3.1:8b", stream: false,
      messages: [
        { role: "system", content: `Şu an: ${new Date().toISOString()}. Görev açıklamasını JSON'a çevir: {"content":"","priority":1,"due_string":""}. SADECE JSON döndür.` },
        { role: "user", content: description }
      ]
    });
    const match = r.data.message.content.match(/\{[\s\S]*\}/);
    if (!match) return fail(res, "AI parse edemedi");
    const task = JSON.parse(match[0]);
    const body = { content: task.content, priority: task.priority || 1 };
    if (task.due_string) body.due_string = task.due_string;
    const added = await axios.post("https://api.todoist.com/rest/v2/tasks", body, { headers: todoistHeaders() });
    res.json({ status: "success", id: added.data.id, task });
  } catch (e) { fail(res, e.message); }
});


// ══════════════════════════════════════════════════════════════════════════════
// 23. TRELLO (açıklamadaki orijinal — TRELLO_KEY + TRELLO_TOKEN env)
// ══════════════════════════════════════════════════════════════════════════════

function trelloParams(extra = {}) {
  if (!process.env.TRELLO_KEY || !process.env.TRELLO_TOKEN) throw new Error("TRELLO_KEY ve TRELLO_TOKEN env eksik");
  return { key: process.env.TRELLO_KEY, token: process.env.TRELLO_TOKEN, ...extra };
}

app.get("/jarvis/trello/boards", async (req, res) => {
  try {
    const r = await axios.get("https://api.trello.com/1/members/me/boards", { params: trelloParams({ fields: "id,name,url" }) });
    res.json({ status: "success", boards: r.data.map(b => ({ id: b.id, name: b.name, url: b.url })) });
  } catch (e) { fail(res, e.message); }
});

app.get("/jarvis/trello/lists", async (req, res) => {
  const { boardId } = req.query;
  if (!boardId) return fail(res, "boardId gerekli");
  try {
    const r = await axios.get(`https://api.trello.com/1/boards/${boardId}/lists`, { params: trelloParams() });
    res.json({ status: "success", lists: r.data.map(l => ({ id: l.id, name: l.name })) });
  } catch (e) { fail(res, e.message); }
});

app.get("/jarvis/trello/cards", async (req, res) => {
  const { listId } = req.query;
  if (!listId) return fail(res, "listId gerekli");
  try {
    const r = await axios.get(`https://api.trello.com/1/lists/${listId}/cards`, { params: trelloParams({ fields: "id,name,desc,due,labels" }) });
    res.json({ status: "success", count: r.data.length, cards: r.data.map(c => ({ id: c.id, name: c.name, desc: c.desc, due: c.due })) });
  } catch (e) { fail(res, e.message); }
});

app.post("/jarvis/trello/cards/add", async (req, res) => {
  const { listId, name, desc, due } = req.body;
  if (!listId || !name) return fail(res, "listId ve name gerekli");
  try {
    const r = await axios.post("https://api.trello.com/1/cards", null, { params: trelloParams({ idList: listId, name, desc: desc || "", due: due || null }) });
    res.json({ status: "success", id: r.data.id, name: r.data.name, url: r.data.url });
  } catch (e) { fail(res, e.message); }
});

app.post("/jarvis/trello/cards/move", async (req, res) => {
  const { cardId, listId } = req.body;
  if (!cardId || !listId) return fail(res, "cardId ve listId gerekli");
  try {
    await axios.put(`https://api.trello.com/1/cards/${cardId}`, null, { params: trelloParams({ idList: listId }) });
    res.json({ status: "success", message: "Kart taşındı" });
  } catch (e) { fail(res, e.message); }
});

app.post("/jarvis/trello/cards/complete", async (req, res) => {
  const { cardId } = req.body;
  if (!cardId) return fail(res, "cardId gerekli");
  try {
    await axios.put(`https://api.trello.com/1/cards/${cardId}`, null, { params: trelloParams({ dueComplete: true }) });
    res.json({ status: "success", message: "Kart tamamlandı" });
  } catch (e) { fail(res, e.message); }
});


// ══════════════════════════════════════════════════════════════════════════════
// 24. ELEVENLABS TTS (açıklamadaki orijinal — ELEVENLABS_KEY env)
// ══════════════════════════════════════════════════════════════════════════════

app.post("/jarvis/elevenlabs/speak", async (req, res) => {
  const { text, voiceId = "21m00Tcm4TlvDq8ikWAM", stability = 0.5, similarity = 0.75 } = req.body;
  if (!text) return fail(res, "text gerekli");
  if (!process.env.ELEVENLABS_KEY) return fail(res, "ELEVENLABS_KEY env eksik");
  try {
    const r = await axios.post(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
      { text, model_id: "eleven_multilingual_v2", voice_settings: { stability, similarity_boost: similarity } },
      { headers: { "xi-api-key": process.env.ELEVENLABS_KEY, "Content-Type": "application/json" }, responseType: "arraybuffer" }
    );
    const filePath = path.join(os.tmpdir(), `jarvis_tts_${Date.now()}.mp3`);
    fs.writeFileSync(filePath, r.data);
    if (isMac) exec(`afplay "${filePath}"`);
    else if (isWindows) exec(`powershell -c "Add-Type -AssemblyName presentationCore; $p = New-Object System.Windows.Media.MediaPlayer; $p.Open('${filePath}'); $p.Play(); Start-Sleep 10"`);
    res.json({ status: "success", filePath });
  } catch (e) { fail(res, e.message); }
});

app.get("/jarvis/elevenlabs/voices", async (req, res) => {
  if (!process.env.ELEVENLABS_KEY) return fail(res, "ELEVENLABS_KEY env eksik");
  try {
    const r = await axios.get("https://api.elevenlabs.io/v1/voices", { headers: { "xi-api-key": process.env.ELEVENLABS_KEY } });
    res.json({ status: "success", voices: r.data.voices.map(v => ({ id: v.voice_id, name: v.name, category: v.category })) });
  } catch (e) { fail(res, e.message); }
});

app.get("/jarvis/elevenlabs/quota", async (req, res) => {
  if (!process.env.ELEVENLABS_KEY) return fail(res, "ELEVENLABS_KEY env eksik");
  try {
    const r = await axios.get("https://api.elevenlabs.io/v1/user", { headers: { "xi-api-key": process.env.ELEVENLABS_KEY } });
    res.json({ status: "success", used: r.data.subscription.character_count, limit: r.data.subscription.character_limit });
  } catch (e) { fail(res, e.message); }
});


// ══════════════════════════════════════════════════════════════════════════════
// 25. WAKE WORD (açıklamadaki orijinal)
// ══════════════════════════════════════════════════════════════════════════════

let wakeWordActive = false;
const wakeWordConfig = { word: "jarvis", cooldown: 3000, lastTrigger: 0 };

app.post("/jarvis/wake-word/triggered", (req, res) => {
  const now = Date.now();
  if (now - wakeWordConfig.lastTrigger < wakeWordConfig.cooldown) return res.json({ status: "cooldown" });
  wakeWordConfig.lastTrigger = now;
  const { word = "jarvis", confidence = 1.0 } = req.body;
  console.log(`[WakeWord] 🎙️ "${word}" algılandı (güven: ${confidence})`);
  brain.emo.update("wake_word");
  brain.attention.addTask(`Wake word: ${word}`, async () => { }, 10, "wake_word");
  res.json({ status: "success", word, confidence, timestamp: new Date().toISOString() });
});

app.post("/jarvis/wake-word/start", (req, res) => {
  wakeWordActive = true;
  if (req.body.word) wakeWordConfig.word = req.body.word;
  if (req.body.cooldown) wakeWordConfig.cooldown = req.body.cooldown;
  res.json({ status: "success", message: "Wake word dinleme başladı", config: wakeWordConfig });
});

app.post("/jarvis/wake-word/stop", (req, res) => {
  wakeWordActive = false;
  res.json({ status: "success", message: "Wake word dinleme durduruldu" });
});

app.get("/jarvis/wake-word/status", (req, res) => {
  res.json({ status: "success", active: wakeWordActive, config: wakeWordConfig });
});


// ══════════════════════════════════════════════════════════════════════════════
// 26. OBSIDIAN (açıklamadaki orijinal — OBSIDIAN_VAULT env)
// ══════════════════════════════════════════════════════════════════════════════

function getVault() {
  const vault = process.env.OBSIDIAN_VAULT;
  if (!vault || !fs.existsSync(vault)) throw new Error("OBSIDIAN_VAULT env eksik veya klasör yok");
  return vault;
}

app.get("/jarvis/obsidian/list", (req, res) => {
  try {
    const files = fs.readdirSync(getVault()).filter(f => f.endsWith(".md"));
    res.json({ status: "success", count: files.length, files });
  } catch (e) { fail(res, e.message); }
});

app.get("/jarvis/obsidian/read", (req, res) => {
  const { file } = req.query;
  if (!file) return fail(res, "file gerekli");
  try {
    const filePath = path.join(getVault(), file.endsWith(".md") ? file : file + ".md");
    if (!fs.existsSync(filePath)) return fail(res, "Not bulunamadı");
    res.json({ status: "success", file, content: fs.readFileSync(filePath, "utf8") });
  } catch (e) { fail(res, e.message); }
});

app.post("/jarvis/obsidian/write", (req, res) => {
  const { file, content } = req.body;
  if (!file || content === undefined) return fail(res, "file ve content gerekli");
  try {
    const filePath = path.join(getVault(), file.endsWith(".md") ? file : file + ".md");
    fs.writeFileSync(filePath, content, "utf8");
    brain.mem.remember(`obsidian:${file}`, content.substring(0, 100), 0.6);
    res.json({ status: "success", file: filePath });
  } catch (e) { fail(res, e.message); }
});

app.post("/jarvis/obsidian/append", (req, res) => {
  const { file, content } = req.body;
  if (!file || !content) return fail(res, "file ve content gerekli");
  try {
    const filePath = path.join(getVault(), file.endsWith(".md") ? file : file + ".md");
    fs.appendFileSync(filePath, "\n" + content, "utf8");
    res.json({ status: "success", file });
  } catch (e) { fail(res, e.message); }
});

app.get("/jarvis/obsidian/search", (req, res) => {
  const { query } = req.query;
  if (!query) return fail(res, "query gerekli");
  try {
    const vault = getVault();
    const files = fs.readdirSync(vault).filter(f => f.endsWith(".md"));
    const results = [];
    for (const file of files) {
      const content = fs.readFileSync(path.join(vault, file), "utf8");
      if (content.toLowerCase().includes(query.toLowerCase())) {
        const lines = content.split("\n").filter(l => l.toLowerCase().includes(query.toLowerCase()));
        results.push({ file, matches: lines.slice(0, 3) });
      }
    }
    res.json({ status: "success", query, count: results.length, results });
  } catch (e) { fail(res, e.message); }
});

app.post("/jarvis/obsidian/open", async (req, res) => {
  const { file } = req.body;
  if (!file) return fail(res, "file gerekli");
  try {
    const filePath = path.join(getVault(), file.endsWith(".md") ? file : file + ".md");
    if (isMac) exec(`open -a "Obsidian" "${filePath}"`);
    else if (isWindows) exec(`start "" "obsidian://${filePath}"`);
    success(res, "Obsidian'da açıldı");
  } catch (e) { fail(res, e.message); }
});

app.post("/jarvis/obsidian/ai-note", async (req, res) => {
  const { prompt, file } = req.body;
  if (!prompt) return fail(res, "prompt gerekli");
  try {
    const r = await axios.post("http://localhost:11434/api/chat", {
      model: process.env.OLLAMA_MODEL || "llama3.1:8b", stream: false,
      messages: [
        { role: "system", content: "Obsidian markdown notu yaz. JSON üret: {\"title\":\"...\",\"content\":\"...\"}. SADECE JSON döndür." },
        { role: "user", content: prompt }
      ]
    });
    const match = r.data.message.content.match(/\{[\s\S]*\}/);
    if (!match) return fail(res, "AI parse edemedi");
    const note = JSON.parse(match[0]);
    const vault = getVault();
    const fileName = (file || note.title.replace(/[^\w\s]/g, "").trim()) + ".md";
    fs.writeFileSync(path.join(vault, fileName), `# ${note.title}\n\n${note.content}`, "utf8");
    brain.mem.remember(`obsidian:ai:${note.title}`, note.content.substring(0, 100), 0.7);
    res.json({ status: "success", file: fileName, note });
  } catch (e) { fail(res, e.message); }
});


// ══════════════════════════════════════════════════════════════════════════════
// 27. FİNANS (açıklamadaki orijinal — Yahoo Finance + CoinGecko)
// ══════════════════════════════════════════════════════════════════════════════

app.get("/jarvis/finance/stock", async (req, res) => {
  const { symbol } = req.query;
  if (!symbol) return fail(res, "symbol gerekli (örn: AAPL, THYAO.IS)");
  try {
    const r = await axios.get(`https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=1d`, { headers: { "User-Agent": "Mozilla/5.0" } });
    const meta = r.data.chart.result[0].meta;
    res.json({ status: "success", symbol, price: meta.regularMarketPrice, currency: meta.currency, exchange: meta.exchangeName, previousClose: meta.previousClose });
  } catch (e) { fail(res, e.message); }
});

app.get("/jarvis/finance/stocks", async (req, res) => {
  const symbols = (req.query.symbols || "AAPL,TSLA,GOOG").split(",").map(s => s.trim());
  try {
    const results = await Promise.allSettled(symbols.map(s => axios.get(`https://query1.finance.yahoo.com/v8/finance/chart/${s}?interval=1d&range=1d`, { headers: { "User-Agent": "Mozilla/5.0" } })));
    res.json({ status: "success", stocks: results.map((r, i) => r.status === "rejected" ? { symbol: symbols[i], error: "bulunamadı" } : { symbol: symbols[i], price: r.value.data.chart.result[0].meta.regularMarketPrice, currency: r.value.data.chart.result[0].meta.currency }) });
  } catch (e) { fail(res, e.message); }
});

app.get("/jarvis/finance/crypto", async (req, res) => {
  const { symbol = "bitcoin", currency = "usd" } = req.query;
  try {
    const r = await axios.get(`https://api.coingecko.com/api/v3/simple/price?ids=${symbol}&vs_currencies=${currency}&include_24hr_change=true`);
    res.json({ status: "success", symbol, data: r.data[symbol] });
  } catch (e) { fail(res, e.message); }
});

app.get("/jarvis/finance/crypto/top", async (req, res) => {
  const { limit = 10, currency = "usd" } = req.query;
  try {
    const r = await axios.get(`https://api.coingecko.com/api/v3/coins/markets?vs_currency=${currency}&order=market_cap_desc&per_page=${limit}&page=1`);
    res.json({ status: "success", coins: r.data.map(c => ({ rank: c.market_cap_rank, name: c.name, symbol: c.symbol.toUpperCase(), price: c.current_price, change24h: c.price_change_percentage_24h?.toFixed(2) })) });
  } catch (e) { fail(res, e.message); }
});

app.post("/jarvis/finance/ai-analyze", async (req, res) => {
  const { symbol } = req.body;
  if (!symbol) return fail(res, "symbol gerekli");
  try {
    const yf = await axios.get(`https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=30d`, { headers: { "User-Agent": "Mozilla/5.0" } });
    const meta = yf.data.chart.result[0].meta;
    const closes = yf.data.chart.result[0].indicators.quote[0].close.filter(Boolean);
    const current = meta.regularMarketPrice;
    const avg30 = (closes.reduce((a, b) => a + b, 0) / closes.length).toFixed(2);
    const weekHigh = Math.max(...closes.slice(-5)).toFixed(2);
    const weekLow = Math.min(...closes.slice(-5)).toFixed(2);
    const change30d = ((current - closes[0]) / closes[0] * 100).toFixed(2);
    const r = await axios.post("http://localhost:11434/api/chat", {
      model: process.env.OLLAMA_MODEL || "llama3.1:8b", stream: false,
      messages: [
        { role: "system", content: "Hisse analizi yapan finans uzmanısın. Türkçe değerlendir. Al/Sat/Tut tavsiyesi ver." },
        { role: "user", content: `${symbol}: $${current}, 30g ort $${avg30}, değişim %${change30d}, 5g high $${weekHigh}, low $${weekLow}` }
      ]
    });
    res.json({ status: "success", symbol, data: { current, avg30, change30d: `%${change30d}`, weekHigh, weekLow }, analysis: r.data.message.content });
  } catch (e) { fail(res, e.message); }
});


// ══════════════════════════════════════════════════════════════════════════════
// 28. SEYAHAT (açıklamadaki orijinal — AviationStack + Frankfurter)
// ══════════════════════════════════════════════════════════════════════════════

app.get("/jarvis/travel/flights", async (req, res) => {
  const { from, to, date } = req.query;
  if (!from) return fail(res, "from gerekli (örn: IST)");
  if (!process.env.AVIATIONSTACK_KEY) return fail(res, "AVIATIONSTACK_KEY env eksik");
  try {
    const params = { access_key: process.env.AVIATIONSTACK_KEY, dep_iata: from, limit: 20 };
    if (to) params.arr_iata = to;
    if (date) params.flight_date = date;
    const r = await axios.get("https://api.aviationstack.com/v1/flights", { params });
    if (!r.data.data) return fail(res, "Uçuş bulunamadı");
    res.json({ status: "success", count: r.data.data.length, flights: r.data.data.map(f => ({ flightNumber: f.flight?.iata, airline: f.airline?.name, departure: { airport: f.departure?.airport, scheduled: f.departure?.scheduled, delay: f.departure?.delay }, arrival: { airport: f.arrival?.airport, scheduled: f.arrival?.scheduled }, status: f.flight_status })) });
  } catch (e) { fail(res, e.message); }
});

app.get("/jarvis/travel/flight-status", async (req, res) => {
  const { flightNumber } = req.query;
  if (!flightNumber || !process.env.AVIATIONSTACK_KEY) return fail(res, "flightNumber ve AVIATIONSTACK_KEY gerekli");
  try {
    const r = await axios.get("https://api.aviationstack.com/v1/flights", { params: { access_key: process.env.AVIATIONSTACK_KEY, flight_iata: flightNumber } });
    if (!r.data.data?.[0]) return fail(res, "Uçuş bulunamadı");
    const f = r.data.data[0];
    res.json({ status: "success", flightNumber: f.flight?.iata, airline: f.airline?.name, flightStatus: f.flight_status, departure: { airport: f.departure?.airport, scheduled: f.departure?.scheduled, delay: f.departure?.delay ? `${f.departure.delay} dk` : "0 dk" }, arrival: { airport: f.arrival?.airport, scheduled: f.arrival?.scheduled } });
  } catch (e) { fail(res, e.message); }
});

app.get("/jarvis/travel/departures", async (req, res) => {
  const { iata = "IST" } = req.query;
  if (!process.env.AVIATIONSTACK_KEY) return fail(res, "AVIATIONSTACK_KEY env eksik");
  try {
    const r = await axios.get("https://api.aviationstack.com/v1/flights", { params: { access_key: process.env.AVIATIONSTACK_KEY, dep_iata: iata, flight_status: "active", limit: 15 } });
    res.json({ status: "success", airport: iata, count: (r.data.data || []).length, departures: (r.data.data || []).map(f => ({ flightNumber: f.flight?.iata, airline: f.airline?.name, destination: f.arrival?.airport, destinationIata: f.arrival?.iata, status: f.flight_status })) });
  } catch (e) { fail(res, e.message); }
});

app.get("/jarvis/travel/currency", async (req, res) => {
  const { from = "USD", to = "TRY", amount = 1 } = req.query;
  try {
    const r = await axios.get(`https://api.frankfurter.app/latest?amount=${amount}&from=${from}&to=${to}`);
    res.json({ status: "success", from, to, amount: parseFloat(amount), result: r.data.rates[to], date: r.data.date });
  } catch (e) { fail(res, e.message); }
});


// ══════════════════════════════════════════════════════════════════════════════
// 29. HOME ASSISTANT IoT (açıklamadaki orijinal — HA_URL + HA_TOKEN env)
// ══════════════════════════════════════════════════════════════════════════════

function haHeaders() {
  if (!process.env.HA_URL || !process.env.HA_TOKEN) throw new Error("HA_URL ve HA_TOKEN env eksik");
  return { Authorization: `Bearer ${process.env.HA_TOKEN}`, "Content-Type": "application/json" };
}
const haBase = () => (process.env.HA_URL || "") + "/api";

app.get("/jarvis/ha/states", async (req, res) => {
  try { const r = await axios.get(`${haBase()}/states`, { headers: haHeaders() }); res.json({ status: "success", count: r.data.length, states: r.data.slice(0, 50) }); } catch (e) { fail(res, e.message); }
});

app.get("/jarvis/ha/state", async (req, res) => {
  const { entityId } = req.query;
  if (!entityId) return fail(res, "entityId gerekli");
  try { const r = await axios.get(`${haBase()}/states/${entityId}`, { headers: haHeaders() }); res.json({ status: "success", entityId: r.data.entity_id, state: r.data.state, attributes: r.data.attributes }); } catch (e) { fail(res, e.message); }
});

app.post("/jarvis/ha/service", async (req, res) => {
  const { domain, service, entityId, serviceData = {} } = req.body;
  if (!domain || !service) return fail(res, "domain ve service gerekli");
  try { const body = { ...serviceData }; if (entityId) body.entity_id = entityId; const r = await axios.post(`${haBase()}/services/${domain}/${service}`, body, { headers: haHeaders() }); res.json({ status: "success", result: r.data }); } catch (e) { fail(res, e.message); }
});

app.post("/jarvis/ha/light", async (req, res) => {
  const { entityId, action = "toggle", brightness, colorTemp } = req.body;
  if (!entityId) return fail(res, "entityId gerekli");
  try { const sd = { entity_id: entityId }; if (brightness) sd.brightness = brightness; if (colorTemp) sd.color_temp = colorTemp; await axios.post(`${haBase()}/services/light/${action}`, sd, { headers: haHeaders() }); res.json({ status: "success", entityId, action }); } catch (e) { fail(res, e.message); }
});

app.post("/jarvis/ha/switch", async (req, res) => {
  const { entityId, action = "toggle" } = req.body;
  if (!entityId) return fail(res, "entityId gerekli");
  try { await axios.post(`${haBase()}/services/switch/${action}`, { entity_id: entityId }, { headers: haHeaders() }); res.json({ status: "success", entityId, action }); } catch (e) { fail(res, e.message); }
});

app.post("/jarvis/ha/climate", async (req, res) => {
  const { entityId, temperature, hvacMode } = req.body;
  if (!entityId) return fail(res, "entityId gerekli");
  try {
    if (temperature) await axios.post(`${haBase()}/services/climate/set_temperature`, { entity_id: entityId, temperature }, { headers: haHeaders() });
    if (hvacMode) await axios.post(`${haBase()}/services/climate/set_hvac_mode`, { entity_id: entityId, hvac_mode: hvacMode }, { headers: haHeaders() });
    res.json({ status: "success", entityId, temperature, hvacMode });
  } catch (e) { fail(res, e.message); }
});

app.get("/jarvis/ha/sensors", async (req, res) => {
  try { const r = await axios.get(`${haBase()}/states`, { headers: haHeaders() }); res.json({ status: "success", sensors: r.data.filter(e => e.entity_id.startsWith("sensor.") || e.entity_id.startsWith("binary_sensor.")).map(e => ({ id: e.entity_id, state: e.state, unit: e.attributes.unit_of_measurement || "", name: e.attributes.friendly_name })) }); } catch (e) { fail(res, e.message); }
});

app.post("/jarvis/ha/automation", async (req, res) => {
  const { automationId } = req.body;
  if (!automationId) return fail(res, "automationId gerekli");
  try { await axios.post(`${haBase()}/services/automation/trigger`, { entity_id: automationId }, { headers: haHeaders() }); res.json({ status: "success", automationId }); } catch (e) { fail(res, e.message); }
});

app.post("/jarvis/ha/ai-control", async (req, res) => {
  const { command } = req.body;
  if (!command) return fail(res, "command gerekli");
  try {
    const statesR = await axios.get(`${haBase()}/states`, { headers: haHeaders() });
    const entities = statesR.data.filter(e => ["light", "switch", "climate", "cover", "fan"].some(d => e.entity_id.startsWith(d + "."))).map(e => ({ id: e.entity_id, name: e.attributes.friendly_name || e.entity_id, state: e.state })).slice(0, 30);
    const r = await axios.post("http://localhost:11434/api/chat", {
      model: process.env.OLLAMA_MODEL || "llama3.1:8b", stream: false,
      messages: [
        { role: "system", content: `Evdeki cihazları JSON komutu döndür: [{"domain":"light","service":"turn_on","entity_id":"light.salon"}]. Cihazlar:\n${JSON.stringify(entities)}. SADECE JSON array döndür.` },
        { role: "user", content: command }
      ]
    });
    const match = r.data.message.content.match(/\[[\s\S]*\]/);
    if (!match) return fail(res, "AI parse edemedi");
    const commands = JSON.parse(match[0]);
    const results = await Promise.allSettled(commands.map(cmd => axios.post(`${haBase()}/services/${cmd.domain}/${cmd.service}`, { entity_id: cmd.entity_id }, { headers: haHeaders() })));
    res.json({ status: "success", commands, executedCount: results.filter(r => r.status === "fulfilled").length });
  } catch (e) { fail(res, e.message); }
});


// ══════════════════════════════════════════════════════════════════════════════
// 30. WEBHOOK (açıklamadaki orijinal)
// ══════════════════════════════════════════════════════════════════════════════

const webhookHandlers = {};
const webhookLog = [];

function onWebhook(eventType, handler) {
  if (!webhookHandlers[eventType]) webhookHandlers[eventType] = [];
  webhookHandlers[eventType].push(handler);
}

app.post("/webhook/inbound", async (req, res) => {
  if (process.env.WEBHOOK_SECRET) {
    const sig = req.headers["x-webhook-signature"] || req.headers["x-hub-signature-256"];
    if (sig) {
      const crypto = require("crypto");
      const expected = "sha256=" + crypto.createHmac("sha256", process.env.WEBHOOK_SECRET).update(JSON.stringify(req.body)).digest("hex");
      if (sig !== expected) return res.status(401).json({ error: "Geçersiz imza" });
    }
  }
  const payload = req.body;
  const eventType = payload.event || payload.type || "generic";
  const entry = { id: Date.now(), eventType, payload, receivedAt: new Date().toISOString() };
  webhookLog.unshift(entry);
  if (webhookLog.length > 100) webhookLog.pop();
  console.log(`[Webhook] ⚡ ${eventType}`, JSON.stringify(payload).substring(0, 200));
  const handlers = [...(webhookHandlers[eventType] || []), ...(webhookHandlers["*"] || [])];
  for (const handler of handlers) {
    try { await handler(payload); } catch (e) { console.error("[Webhook handler hatası]", e.message); }
  }
  brain.attention.addTask(`Webhook: ${eventType}`, async () => { }, 3, "webhook");
  res.json({ status: "success", eventType, receivedAt: entry.receivedAt });
});

app.get("/webhook/log", (req, res) => {
  res.json({ status: "success", count: webhookLog.length, events: webhookLog.slice(0, 20) });
});

app.delete("/webhook/log", (req, res) => {
  webhookLog.length = 0;
  res.json({ status: "success", message: "Log temizlendi" });
});

app.post("/webhook/test", (req, res) => {
  const { event = "test", data = {} } = req.body;
  const entry = { id: Date.now(), eventType: event, payload: { event, data, _test: true }, receivedAt: new Date().toISOString() };
  webhookLog.unshift(entry);
  res.json({ status: "success", message: "Test webhook kaydedildi", entry });
});


// ══════════════════════════════════════════════════════════════════════════════
// 31. AGENT CANVAS (açıklamadaki orijinal)
// ══════════════════════════════════════════════════════════════════════════════

const canvasState = { elements: [], lastUpdated: null };

app.post("/jarvis/canvas/add", (req, res) => {
  const { type, data, title, position = { x: 0, y: 0 }, size = { w: 400, h: 300 } } = req.body;
  if (!type || !data) return fail(res, "type ve data gerekli");
  const element = { id: `el_${Date.now()}`, type, data, title: title || type, position, size, createdAt: new Date().toISOString() };
  canvasState.elements.push(element);
  canvasState.lastUpdated = new Date().toISOString();
  res.json({ status: "success", element });
});

app.get("/jarvis/canvas/state", (req, res) => {
  res.json({ status: "success", ...canvasState });
});

app.delete("/jarvis/canvas/element", (req, res) => {
  const { id } = req.body;
  if (!id) return fail(res, "id gerekli");
  const idx = canvasState.elements.findIndex(e => e.id === id);
  if (idx === -1) return fail(res, "Element bulunamadı");
  canvasState.elements.splice(idx, 1);
  canvasState.lastUpdated = new Date().toISOString();
  res.json({ status: "success", message: "Silindi" });
});

app.delete("/jarvis/canvas/clear", (req, res) => {
  canvasState.elements = [];
  canvasState.lastUpdated = new Date().toISOString();
  res.json({ status: "success", message: "Canvas temizlendi" });
});

app.patch("/jarvis/canvas/element", (req, res) => {
  const { id, position, size, data } = req.body;
  if (!id) return fail(res, "id gerekli");
  const el = canvasState.elements.find(e => e.id === id);
  if (!el) return fail(res, "Element bulunamadı");
  if (position) el.position = position;
  if (size) el.size = size;
  if (data) el.data = data;
  canvasState.lastUpdated = new Date().toISOString();
  res.json({ status: "success", element: el });
});
// RAG upload endpoint
app.post('/rag/upload', upload.single('file'), rag.uploadEndpoint(upload));
app.get('/rag/docs', rag.listDocs);
app.delete('/rag/doc/:docId', rag.deleteDoc);
app.post('/rag/ask', rag.askEndpoint(axios, 'llama3.1:8b'));
app.post("/jarvis/canvas/ai-render", async (req, res) => {
  const { prompt, type = "auto" } = req.body;
  if (!prompt) return fail(res, "prompt gerekli");
  try {
    const r = await axios.post("http://localhost:11434/api/chat", {
      model: process.env.OLLAMA_MODEL || "llama3.1:8b", stream: false,
      messages: [
        { role: "system", content: `Canvas element JSON üret. Format: {"type":"table|chart|text|markdown","data":{...},"title":""}. table: {"headers":[],"rows":[[]]}. chart: {"labels":[],"values":[],"chartType":"bar|line|pie"}. text: {"content":"..."}. SADECE JSON döndür.` },
        { role: "user", content: prompt }
      ]
    });
    const match = r.data.message.content.match(/\{[\s\S]*\}/);
    if (!match) return fail(res, "AI canvas render edemedi");
    const parsed = JSON.parse(match[0]);
    const element = {
      id: `el_${Date.now()}`, type: parsed.type || type, data: parsed.data || parsed,
      title: parsed.title || prompt.substring(0, 50),
      position: { x: (canvasState.elements.length % 3) * 420, y: Math.floor(canvasState.elements.length / 3) * 320 },
      size: { w: 400, h: 280 }, createdAt: new Date().toISOString()
    };
    canvasState.elements.push(element);
    canvasState.lastUpdated = new Date().toISOString();
    res.json({ status: "success", element });
  } catch (e) { fail(res, e.message); }
});

app.get("/jarvis/canvas/view", (req, res) => {
  const elements = canvasState.elements;
  const html = `<!DOCTYPE html><html lang="tr"><head><meta charset="UTF-8"><meta http-equiv="refresh" content="3"><title>Kaan AI Canvas</title>
<style>body{background:#0d0d1a;color:#e0e0e0;font-family:'Segoe UI',sans-serif;margin:0;padding:20px}h1{color:#a78bfa;font-size:1.2rem;margin-bottom:20px}.canvas-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(380px,1fr));gap:16px}.canvas-el{background:#12122a;border:1px solid #2a2a3e;border-radius:10px;padding:16px}.el-title{font-size:.8rem;color:#a78bfa;margin-bottom:10px;font-weight:700}table{width:100%;border-collapse:collapse;font-size:.8rem}th{background:#1a1a3e;color:#c084fc;padding:6px 10px;text-align:left}td{padding:5px 10px;border-bottom:1px solid #1e1e2e}.text-content{font-size:.85rem;line-height:1.6;white-space:pre-wrap}.empty{text-align:center;color:#555;padding:60px}</style></head>
<body><h1>🖼️ Kaan AI Canvas <span style="color:#555;font-size:.7rem">(3 sn güncellenir)</span></h1>
${elements.length === 0 ? '<div class="empty">Canvas boş. /jarvis/canvas/add veya /jarvis/canvas/ai-render ile ekle.</div>' : ''}
<div class="canvas-grid">${elements.map(el => {
    let inner = "";
    if (el.type === "table" && el.data?.headers) inner = `<table><thead><tr>${el.data.headers.map(h => `<th>${h}</th>`).join("")}</tr></thead><tbody>${(el.data.rows || []).map(row => `<tr>${row.map(c => `<td>${c}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
    else if (el.type === "chart") inner = `<div class="text-content">📊 ${el.data.chartType || "bar"}: ${(el.data.labels || []).map((l, i) => `${l}: ${(el.data.values || [])[i]}`).join(", ")}</div>`;
    else inner = `<div class="text-content">${(el.data?.content || JSON.stringify(el.data, null, 2)).substring(0, 500)}</div>`;
    return `<div class="canvas-el"><div class="el-title">${el.title || el.type} · ${new Date(el.createdAt).toLocaleTimeString("tr-TR")}</div>${inner}</div>`;
  }).join("")}</div></body></html>`;
  res.send(html);
});

console.log("✅ Tüm açıklama satırı modüller aktive edildi.");

// ── Brain API endpoint'leri ───────────────────────────────

// Beyin durumunu oku
app.get('/brain/status', (req, res) => {
  res.json({ status: "success", brain: brain.getStatus() });
});

// Duygusal state'i oku
app.get('/brain/emotions', (req, res) => {
  res.json({ status: "success", emotions: brain.emo.getState(), summary: brain.emo.getSummary() });
});

// Hafızada ara
app.post('/brain/recall', (req, res) => {
  const { query, topN = 5 } = req.body;
  if (!query) return res.json({ status: "error", message: "query gerekli" });
  const results = brain.mem.recall(query, topN);
  res.json({ status: "success", results });
});

// Manuel hafıza ekle
app.post('/brain/remember', (req, res) => {
  const { key, value, importance = 0.5 } = req.body;
  if (!key || !value) return res.json({ status: "error", message: "key ve value gerekli" });
  const entry = brain.mem.remember(key, value, importance);
  res.json({ status: "success", entry });
});

// Görev kuyruğunu oku
app.get('/brain/queue', (req, res) => {
  res.json({ status: "success", ...brain.attention.getStatus() });
});

// Göreve görev ekle (basit test için)
app.post('/brain/schedule', (req, res) => {
  const { name, priority = 5, type = "idle" } = req.body;
  if (!name) return res.json({ status: "error", message: "name gerekli" });
  const taskId = brain.schedule(name, async () => {
    console.log(`[Brain Task] "${name}" çalışıyor...`);
    return `${name} tamamlandı`;
  }, priority, type);
  res.json({ status: "success", taskId });
});

// Hafıza istatistikleri
app.get('/brain/memory/stats', (req, res) => {
  const all = brain.mem.getAll();
  res.json({
    status: "success",
    stats: all.stats,
    semanticCount: all.semanticMemory.length,
    failureCount: all.failurePatterns.length,
    successCount: all.successPatterns.length,
    cacheSize: Object.keys(all.commandCache).length,
    longTermGoals: all.longTermGoals
  });
});

// Hafızayı sıfırla (dikkatli kullan)
app.delete('/brain/memory/reset', (req, res) => {
  brain.mem.resetMemory();
  res.json({ status: "success", message: "Hafıza sıfırlandı" });
});

// Agent döngüsü manuel değerlendirme
app.post('/brain/evaluate', (req, res) => {
  const { goal, steps = [], status = "success" } = req.body;
  if (!goal) return res.json({ status: "error", message: "goal gerekli" });
  brain.onAgentDone(goal, steps, status);
  res.json({ status: "success", emotions: brain.emo.getState() });
});

console.log("🧠 Brain modülü yüklendi. Endpoint'ler: /brain/status /brain/emotions /brain/recall /brain/remember /brain/queue /brain/memory/stats");
brain.patchServer(app, axios);
//eğer Qwen2.5 7B yüklersen model: "Qwen2.5 7B", bu
// pkill node
//qwen2.5:14b en iyisi 
//ollama pull Qwen2.5 7B orta 
//dahada iyisi için Mixtral 8x7B
//kötüsü şuan kullandığımız
// node server.js
setInterval(() => {
  const keys = Object.keys(conversations);
  if (keys.length > 50) {
    keys.slice(0, keys.length - 50).forEach(k => delete conversations[k]);
    console.log(`[Session] 🧹 ${keys.length - 50} eski session temizlendi`);
  }
}, 6 * 60 * 60 * 1000);
app.post('/telegram/send', (req, res) => {
  const { chatId, message } = req.body;
  if (!chatId || !message) {
    return res.status(400).json({ error: 'chatId ve message gerekli' });
  }
  try {
    const TelegramBot = require('node-telegram-bot-api');
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) return res.status(500).json({ error: 'TELEGRAM_BOT_TOKEN yok' });
    const bot = new TelegramBot(token, { polling: false });
    bot.sendMessage(chatId, message, { parse_mode: 'Markdown' })
      .then(() => res.json({ success: true }))
      .catch(e => res.status(500).json({ error: e.message }));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
const httpServer = app.listen(PORT, () => {
  console.log(`🍎 Mac/Windows Uyumlu Sunucu Çalışıyor: http://localhost:${PORT}`);
  console.log(`İşletim Sistemi: ${process.platform}`);
});
const wss = new WebSocketServer({ server: httpServer, path: '/ws' });
initJobQueue(brain, axios, wss);
mountRoutes(app);
mountAgentRoutes(app, brain, axios, wss);

const { mountAutonomousAgent } = require('./autonomous_agent');
const autoAgent = mountAutonomousAgent(app, { brain, axios, exec, fs, path, PORT, CLAW_TOOLS, OPENCLAW_TOOLS, MEMORY, saveMem, AGENT_STATE, WORLD_STATE, agentPlan, normalizePlan, extractJsonFromLLM, toolPolicyFilter, buildWebProjectPlanLLM, isMac, isWindows });

const { mountUserContext } = require('./userContext');
const { mountEventTriggers } = require('./eventTriggers');
const { mountRagMemory } = require('./ragMemory');
const proactiveEngine = proactive.mount(app, brain.userProfile, {
  axios, isMac, isWindows, exec,
  ElevenLabs: {
    apiKey: process.env.ELEVENLABS_API_KEY,
    voiceId: process.env.ELEVENLABS_VOICE_ID,
  }
});
proactiveEngine.setTelegramChatId(process.env.TELEGRAM_ALLOWED_IDS?.split(',')[0]);
mountUserContext(app, autoAgent, USER_MODEL, brain);
mountEventTriggers(app, autoAgent, brain, { fs, path, exec, chokidar, cron, axios, PORT });
mountRagMemory(app, autoAgent, brain, rag, axios);
// ── 📅 AJANDA SİSTEMİ — Mevcut kod bozulmadı, sadece eklendi ──
const agendaRoutes = require('./agendaRoutes');
const agendaEngine = agendaRoutes.mount(app, brain, axios, proactiveEngine, wss);
// ─────────────────────────────────────────────────────────────
// ── 🌅 SABAH/AKŞAM RUTİNİ ──────────────────────────────
const { mountDailyRoutine } = require('./dailyRoutine');
mountDailyRoutine(app, brain, axios, proactiveEngine, { cron, PORT });

// ── 🚀 PROJE BAŞLATICI ─────────────────────────────────
const { mountProjectLauncher } = require('./projectLauncher');
mountProjectLauncher(app, brain, axios, { exec, fs, path, isMac, isWindows, isLinux });

// ── 🔁 PİPELINE MOTORU ─────────────────────────────────
const { mountPipelineEngine } = require('./pipelineEngine');
const pipelineEngine = mountPipelineEngine(app, brain, axios, { exec, cron, PORT });

// ── 🌐 WEB MONİTOR ──────────────────────────────────────
const { mountWebMonitor } = require('./webMonitor');
mountWebMonitor(app, brain, axios, proactiveEngine, { cron, PORT });

// ── 🧩 UYGULAMA PROFİLLERİ ─────────────────────────────
const { mountAppProfiles } = require('./appProfiles');
mountAppProfiles(app, brain, { exec, isMac, isWindows, isLinux });
const { mountTurkishAiRouter } = require('./turkishAiRouter');
mountTurkishAiRouter(app, brain, axios, conversations);
const { mountLocationService } = require('./locationService');
mountLocationService(app, brain, axios, { exec, isMac, isWindows });
const { mountBrowserTools } = require('./browserTools');
mountBrowserTools(app, autoAgent, brain, {
  exec, axios, isMac, isWindows, isLinux, fs, path, PORT
});
const { mountSystemTools } = require('./systemTools');
mountSystemTools(app, autoAgent, brain, {
  exec, axios, isMac, isWindows, isLinux, fs, path, PORT
});
const { mountWebSearch } = require('./webSearch');
mountWebSearch(app, brain, axios);
app.use('/health', healthRouter(brain));
wss.on('connection', ws => {
  autoAgent.registerWsClient(ws);
  proactiveEngine.registerWsClient(ws);
  agendaEngine.registerWsClient(ws); // 📅 Ajanda bildirimleri
  if (pipelineEngine?.registerWsClient) pipelineEngine.registerWsClient(ws);
});
const { createMonitor } = require('./webMonitor');
customerConfig.applyPost(brain, { createMonitor });
const brainBridge = require('./brainBridge');
const _jobQueueModule = require('./jobQueue');
const _agendaManager  = require('./brain/agendaManager');  // ← brain/ klasöründe
brainBridge.init(brain, {
  jobQueue:       _jobQueueModule,
  agendaManager:  _agendaManager,
  proactiveEngine,
});

// ═══════════════════════════════════════════════
// KAYIT SİSTEMİ — Video + Konuşma → Brain
// ═══════════════════════════════════════════════
const multerKayit = require('multer');
const kayitVideoDir = path.join(__dirname, 'kayıtlar', 'videolar');
const kayitKonusmaDir = path.join(__dirname, 'kayıtlar', 'konuşmalar');
fs.mkdirSync(kayitVideoDir, { recursive: true });
fs.mkdirSync(kayitKonusmaDir, { recursive: true });

const kayitStorage = multerKayit.diskStorage({
  destination: (req, file, cb) => cb(null, kayitVideoDir),
  filename: (req, file, cb) => cb(null, `video_${Date.now()}.webm`)
});
const kayitUpload = multerKayit({ storage: kayitStorage });

app.post('/kayit/video', kayitUpload.single('video'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Dosya yok' });
  console.log(`[Kayıt] 📹 Video kaydedildi: ${req.file.filename}`);
  res.json({ ok: true, file: req.file.filename });
});

app.post('/kayit/konusma', express.json({ limit: '2mb' }), async (req, res) => {
  const { mesajlar, kaynak } = req.body; // kaynak: "ollama" | "ielse"
  if (!mesajlar || !mesajlar.length) return res.status(400).json({ error: 'Mesaj yok' });

  const dosyaAdi = `konusma_${Date.now()}.json`;
  const dosyaYolu = path.join(kayitKonusmaDir, dosyaAdi);
  fs.writeFileSync(dosyaYolu, JSON.stringify({ kaynak, mesajlar, tarih: new Date().toISOString() }, null, 2));
  console.log(`[Kayıt] 💬 Konuşma kaydedildi: ${dosyaAdi} (${kaynak})`);

  // Brain'e öğret
  try {
    for (const m of mesajlar) {
      if (m.user && m.ai) {
        brain.learn(m.user, m.ai);
      }
    }
    console.log(`[Kayıt] 🧠 Brain ${mesajlar.length} mesaj öğrendi`);
  } catch(e) {
    console.error('[Kayıt] Brain öğrenme hatası:', e.message);
  }

  res.json({ ok: true, file: dosyaAdi });
});
