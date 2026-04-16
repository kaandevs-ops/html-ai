// ============================================================
// 📱 telegram.js — Telegram Bot Entegrasyonu
//
// KURULUM:
//   1. npm install node-telegram-bot-api axios
//   2. Telegram'da @BotFather'a git → /newbot → token al
//   3. .env dosyasına ekle:
//        TELEGRAM_BOT_TOKEN=123456:ABC-DEF...
//        TELEGRAM_ALLOWED_IDS=senin_telegram_id_in
//        SERVER_URL=http://localhost:3000
//        API_KEY=senin_api_key_in
//
//   4. Telegram ID'ni öğrenmek için @userinfobot'a yaz
//
// ÇALIŞTIRMA (server.js ile AYNI ANDA):
//   node telegram.js
//
// VEYA server.js'in en altına şunu ekle (opsiyonel):
//   require('./telegram');
//
// ORİJİNAL KODLARA HİÇBİR DOKUNUŞ YOK.
// ============================================================

"use strict";

require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");
const axios = require("axios");

// ── Konfigürasyon ──────────────────────────────────────────
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ALLOWED_IDS = (process.env.TELEGRAM_ALLOWED_IDS || "")
  .split(",").map(id => id.trim()).filter(Boolean);
const SERVER_URL = process.env.SERVER_URL || "http://localhost:3000";
const API_KEY = process.env.API_KEY || "";

if (!TOKEN) {
  console.error("[Telegram] ❌ TELEGRAM_BOT_TOKEN .env'de tanımlı değil!");
  process.exit(1);
}

// ── Bot oluştur ────────────────────────────────────────────
const bot = new TelegramBot(TOKEN, { polling: true });
console.log("[Telegram] 📱 Bot başlatıldı, mesaj bekleniyor...");

// ── Yetki kontrolü ────────────────────────────────────────
function _isAllowed(chatId) {
  if (ALLOWED_IDS.length === 0) return true; // liste boşsa herkese açık
  return ALLOWED_IDS.includes(String(chatId));
}

// ── Uzun mesajı parçala (Telegram max 4096 karakter) ───────
function _splitMessage(text, maxLen = 4000) {
  const parts = [];
  while (text.length > 0) {
    parts.push(text.slice(0, maxLen));
    text = text.slice(maxLen);
  }
  return parts;
}

async function _askServer(userMessage, sessionId) {
  const response = await axios.post(
    `${SERVER_URL}/ollama/ask`,
    {
      prompt: userMessage,
      sessionId: sessionId,
      stream: false
    },
    {
      headers: {
        "x-api-key": API_KEY,
        "Content-Type": "application/json"
      },
      timeout: 60000
    }
  );
  return response.data;
}

// ── Otonom agent başlat ───────────────────────────────────
async function _startAgent(goal, chatId) {
  const response = await axios.post(
    `${SERVER_URL}/auto/inject-goal`,
    { goal },
    {
      headers: { "x-api-key": API_KEY },
      timeout: 10000
    }
  );
  return response.data;
}

// ── Brain durumu al ────────────────────────────────────────
async function _getBrainStatus() {
  const response = await axios.get(
    `${SERVER_URL}/brain/status`,
    { headers: { "x-api-key": API_KEY }, timeout: 10000 }
  );
  return response.data;
}
if (text === '/doktor') {
  bot.sendMessage(chatId, '🏥 Sağlık asistanı aktif. Semptomlarını yaz, sana yardımcı olayım.');
}
if (text.startsWith('/ilac')) {
  const res = await axios.get('http://localhost:3000/health/medications');
  const list = res.data.map(m => `💊 ${m.name} — ${m.dose} (${m.times.join(', ')})`).join('\n');
  bot.sendMessage(chatId, list || 'Kayıtlı ilaç yok.');
}
if (text.startsWith('/randevu')) {
  const res = await axios.get('http://localhost:3000/health/appointments');
  const list = res.data.map(a => `📅 ${a.date} ${a.time} — ${a.doctor} (${a.specialty})`).join('\n');
  bot.sendMessage(chatId, list || 'Yaklaşan randevu yok.');
}
// ── Komutlar ──────────────────────────────────────────────
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  if (!_isAllowed(chatId)) return;

  await bot.sendMessage(chatId,
    `🤖 *KaanAI Jarvis* bağlandı!\n\n` +
    `Direkt mesaj yazabilirsin veya şu komutları kullanabilirsin:\n\n` +
    `/status — Brain durumu\n` +
    `/agent [hedef] — Otonom agent başlat\n` +
    `/auto — Otonom döngü durumu\n` +
    `/help — Yardım`,
    { parse_mode: "Markdown" }
  );
});

bot.onText(/\/help/, async (msg) => {
  const chatId = msg.chat.id;
  if (!_isAllowed(chatId)) return;

  await bot.sendMessage(chatId,
    `📚 *Komutlar:*\n\n` +
    `/start — Karşılama\n` +
    `/status — Brain & sistem durumu\n` +
    `/agent [hedef] — Otonom agent başlat\n` +
    `/auto — Otonom döngü aç/kapat\n` +
    `/help — Bu mesaj\n\n` +
    `Veya direkt mesaj yaz, Jarvis cevaplar.`,
    { parse_mode: "Markdown" }
  );
});

bot.onText(/\/status/, async (msg) => {
  const chatId = msg.chat.id;
  if (!_isAllowed(chatId)) return;

  const typing = bot.sendChatAction(chatId, "typing");

  try {
    const data = await _getBrainStatus();
    const emo = data.emotions || {};
    const mem = data.memory || {};

    const statusText =
      `🧠 *Brain Durumu*\n\n` +
      `Mod: ${emo.mood || "NORMAL"}\n` +
      `Özgüven: ${((emo.confidence || 0) * 100).toFixed(0)}%\n` +
      `Yorgunluk: ${((emo.fatigue || 0) * 100).toFixed(0)}%\n` +
      `Hayal Kırıklığı: ${((emo.frustration || 0) * 100).toFixed(0)}%\n\n` +
      `📊 *Hafıza*\n` +
      `Toplam görev: ${mem.stats?.totalTasks || 0}\n` +
      `Başarı: ${mem.stats?.successCount || 0}\n` +
      `Hata: ${mem.stats?.failCount || 0}\n` +
      `Semantik kayıt: ${mem.semanticCount || 0}`;

    await bot.sendMessage(chatId, statusText, { parse_mode: "Markdown" });
  } catch (e) {
    await bot.sendMessage(chatId, `❌ Durum alınamadı: ${e.message}`);
  }
});

bot.onText(/\/agent (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  if (!_isAllowed(chatId)) return;

  const goal = match[1].trim();
  if (!goal) {
    await bot.sendMessage(chatId, "⚠️ Hedef yaz. Örnek: /agent README dosyası oluştur");
    return;
  }

  await bot.sendChatAction(chatId, "typing");
  try {
    const data = await _startAgent(goal, chatId);
    await bot.sendMessage(chatId,
      `🚀 *Agent başlatıldı*\n\nHedef: ${goal}\n\nAjan çalışıyor, sonuç gelince bildiririm.`,
      { parse_mode: "Markdown" }
    );
  } catch (e) {
    await bot.sendMessage(chatId, `❌ Agent başlatılamadı: ${e.message}`);
  }
});

bot.onText(/\/auto/, async (msg) => {
  const chatId = msg.chat.id;
  if (!_isAllowed(chatId)) return;

  try {
    const response = await axios.get(
      `${SERVER_URL}/auto/status`,
      { headers: { "x-api-key": API_KEY }, timeout: 10000 }
    );
    const data = response.data;
    const status = data.running ? "🟢 Çalışıyor" : "🔴 Durdu";
    await bot.sendMessage(chatId,
      `🤖 *Otonom Döngü*\n\nDurum: ${status}\nToplam döngü: ${data.totalCycles || 0}`,
      { parse_mode: "Markdown" }
    );
  } catch (e) {
    await bot.sendMessage(chatId, `❌ Durum alınamadı: ${e.message}`);
  }
});

// ── Ana mesaj handler ─────────────────────────────────────
bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text || "";

  // Komutları skip et
  if (text.startsWith("/")) return;

  // Yetki kontrolü
  if (!_isAllowed(chatId)) {
    await bot.sendMessage(chatId, "⛔ Yetkisiz erişim.");
    return;
  }

  if (!text.trim()) return;

  // Yazıyor göstergesi
  await bot.sendChatAction(chatId, "typing");

  try {
    const sessionId = `telegram_${chatId}`;
    const data = await _askServer(text, sessionId);

    // Cevabı çıkar
    let answer = "";
    if (data.response) answer = data.response;
    else if (data.answer) answer = data.answer;
    else if (data.message) answer = data.message;
    else if (typeof data === "string") answer = data;
    else answer = JSON.stringify(data).slice(0, 500);

    if (!answer) {
      await bot.sendMessage(chatId, "🤔 Cevap üretilemedi.");
      return;
    }

    // Uzun cevapları parçala
    const parts = _splitMessage(answer);
    for (const part of parts) {
      await bot.sendMessage(chatId, part);
      if (parts.length > 1) await _sleep(300); // rate limit önlemi
    }

  } catch (e) {
    console.error("[Telegram] ❌ Hata:", e.message);

    if (e.code === "ECONNREFUSED") {
      await bot.sendMessage(chatId, "❌ Server bağlantısı yok. node server.js çalışıyor mu?");
    } else if (e.response?.status === 401) {
      await bot.sendMessage(chatId, "❌ API key hatalı.");
    } else {
      await bot.sendMessage(chatId, `❌ Hata: ${e.message.slice(0, 200)}`);
    }
  }
});

// ── Proactive bildirim gönder (proactive.js entegrasyonu) ──
// proactive.js registerWsClient yerine bu fonksiyonu çağırabilirsin
// server.js'te: proactiveEngine.setTelegramCallback(sendProactiveNotification)
function sendProactiveNotification(chatId, title, message) {
  if (!chatId) return;
  bot.sendMessage(chatId,
    `🔔 *${title}*\n\n${message}`,
    { parse_mode: "Markdown" }
  ).catch(e => console.error("[Telegram] Bildirim hatası:", e.message));
}

function _sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── Hata yönetimi ──────────────────────────────────────────
bot.on("polling_error", (err) => {
  console.error("[Telegram] Polling hatası:", err.message);
});

bot.on("error", (err) => {
  console.error("[Telegram] Bot hatası:", err.message);
});

process.on("SIGINT", () => {
  console.log("[Telegram] 📴 Bot kapatılıyor...");
  bot.stopPolling();
  process.exit(0);
});

module.exports = { sendProactiveNotification };
