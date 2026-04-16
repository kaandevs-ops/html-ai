// ============================================================
// 🎯 brain/attention.js — Dikkat & Görev Planlayıcı v2
// DÜZELTİLEN HATALAR:
//   - Görev tamamlandığında brain.learn() tetiklenmiyor → düzeltildi
//   - Görev başarısız olduğunda brain.onError() tetiklenmiyor → düzeltildi
//   - Idle döngüsü saate bakarken saat sınırı mantığı yanlıştı → düzeltildi
//   - Retry mekanizması eklendi (max 2 deneme)
//   - Görev geçmişi kaydı eklendi (son 50 görev)
//   - Aynı anda birden fazla immediate görev için sıra garantisi
// ============================================================

let taskQueue    = [];
let currentTask  = null;
let isProcessing = false;
const taskHistory = [];     // son 50 tamamlanan görev
const listeners  = [];

// Circular dependency'den kaçınmak için lazy require
let _brain = null;
function _getBrain() {
  if (!_brain) {
    try { _brain = require("./index"); } catch(e) { /* henüz yüklenmedi */ }
  }
  return _brain;
}

// ── Görev ekle ────────────────────────────────────────────
function addTask(taskName, handler, priority = 5, type = "immediate", maxRetry = 1) {
  const task = {
    id:        `task_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
    name:      taskName,
    handler,
    priority,
    type,
    maxRetry,
    retryCount: 0,
    addedAt:   new Date().toISOString(),
    status:    "pending"
  };

  taskQueue.push(task);
  taskQueue.sort((a, b) => b.priority - a.priority);

  console.log(`[Attention] 📥 Görev eklendi: "${taskName}" (p:${priority}, type:${type}, retry:${maxRetry}) | Kuyruk: ${taskQueue.length}`);

  if (!isProcessing && type !== "idle") {
    setTimeout(_processNext, 0); // mikrotask yerine macrotask — stack'i temizle
  }

  return task.id;
}

// ── İşlem döngüsü ─────────────────────────────────────────
async function _processNext() {
  if (isProcessing || taskQueue.length === 0) return;

  // Idle görev saate bakıyor
  const hour = new Date().getHours();
  const [startH, endH] = [10, 24];

  const nextTask = taskQueue[0];
  if (nextTask.type === "idle") {
    // ✅ DÜZELTİLDİ: endH=24 → 0'a kadar demek. Gece yarısı 0 olunca 24'ten büyük olamaz.
    const isActive = (endH === 24)
      ? hour >= startH  // 10:00 – 23:59 aktif
      : (hour >= startH && hour < endH);

    if (!isActive) {
      console.log(`[Attention] 😴 Idle bekleniyor (saat: ${hour}, aktif: ${startH}-${endH})`);
      return;
    }
  }

  isProcessing       = true;
  currentTask        = taskQueue.shift();
  currentTask.status = "running";
  currentTask.startedAt = new Date().toISOString();

  console.log(`[Attention] ▶️  Başladı: "${currentTask.name}" (deneme: ${currentTask.retryCount + 1})`);

  try {
    const result           = await currentTask.handler();
    currentTask.status     = "done";
    currentTask.result     = result;
    currentTask.finishedAt = new Date().toISOString();

    console.log(`[Attention] ✅ Bitti: "${currentTask.name}"`);

    // ✅ YENİ: Başarılı görevi brain'e bildir
    const brain = _getBrain();
    if (brain && typeof brain.learn === "function") {
      brain.learn(currentTask.name, String(result || "done"));
    }

    _addHistory(currentTask);
    _notifyListeners("done", currentTask);

  } catch (err) {
    currentTask.error = err.message;
    console.error(`[Attention] ❌ Hata: "${currentTask.name}" → ${err.message}`);

    // Retry mekanizması
    if (currentTask.retryCount < currentTask.maxRetry) {
      currentTask.retryCount++;
      currentTask.status = "pending";
      console.log(`[Attention] 🔄 Yeniden deneniyor (${currentTask.retryCount}/${currentTask.maxRetry}): "${currentTask.name}"`);
      taskQueue.unshift(currentTask); // kuyruğun başına ekle (yüksek öncelik)
    } else {
      currentTask.status     = "failed";
      currentTask.finishedAt = new Date().toISOString();

      // ✅ YENİ: Başarısız görevi brain'e bildir
      const brain = _getBrain();
      if (brain && typeof brain.onError === "function") {
        brain.onError("attention_task", currentTask.name, err.message);
      }

      _addHistory(currentTask);
      _notifyListeners("failed", currentTask);
    }

  } finally {
    isProcessing = false;
    currentTask  = null;
    if (taskQueue.length > 0) {
      setTimeout(_processNext, 100);
    }
  }
}

// ── Görev geçmişi ─────────────────────────────────────────
function _addHistory(task) {
  taskHistory.unshift({
    id:         task.id,
    name:       task.name,
    status:     task.status,
    addedAt:    task.addedAt,
    finishedAt: task.finishedAt,
    retryCount: task.retryCount,
    error:      task.error || null
  });
  if (taskHistory.length > 50) taskHistory.length = 50;
}

// ── Idle döngüsü ──────────────────────────────────────────
setInterval(() => {
  const idleCount = taskQueue.filter(t => t.type === "idle").length;
  if (idleCount > 0 && !isProcessing) {
    console.log(`[Attention] 💤 Idle döngüsü: ${idleCount} görev bekliyor`);
    _processNext();
  }
}, 5 * 60 * 1000);

// ── API ───────────────────────────────────────────────────
function cancelTask(taskId) {
  const idx = taskQueue.findIndex(t => t.id === taskId);
  if (idx !== -1) {
    taskQueue.splice(idx, 1);
    console.log(`[Attention] 🗑️ İptal: ${taskId}`);
    return true;
  }
  return false;
}

function clearQueue() {
  const count = taskQueue.length;
  taskQueue   = [];
  console.log(`[Attention] 🧹 Kuyruk temizlendi: ${count} görev`);
}

function getStatus() {
  return {
    isProcessing,
    currentTask:  currentTask
      ? { id: currentTask.id, name: currentTask.name, status: currentTask.status, startedAt: currentTask.startedAt }
      : null,
    queueLength:  taskQueue.length,
    queue:        taskQueue.map(t => ({
      id:       t.id,
      name:     t.name,
      priority: t.priority,
      type:     t.type,
      retry:    `${t.retryCount}/${t.maxRetry}`
    })),
    recentHistory: taskHistory.slice(0, 10)
  };
}

function onTaskEvent(callback) { listeners.push(callback); }

function _notifyListeners(event, task) {
  listeners.forEach(cb => { try { cb(event, task); } catch(e) {} });
}

function tick() {
  if (!isProcessing && taskQueue.length > 0) _processNext();
}

module.exports = {
  addTask,
  cancelTask,
  clearQueue,
  getStatus,
  onTaskEvent,
  tick
};