const fs = require('fs');
const path = require('path');

const MEMORY_PATH = path.join(__dirname, '../health_memory.json');

function load() {
  try {
    return JSON.parse(fs.readFileSync(MEMORY_PATH, 'utf8'));
  } catch { return { medications: [] }; }
}

function save(data) {
  fs.writeFileSync(MEMORY_PATH, JSON.stringify(data, null, 2));
}

function addMedication({ name, dose, times, startDate, endDate, notes }) {
  const mem = load();
  mem.medications.push({
    id: Date.now().toString(),
    name, dose, times,
    startDate: startDate || new Date().toISOString().split('T')[0],
    endDate: endDate || null,
    notes: notes || '',
    active: true,
    createdAt: new Date().toISOString()
  });
  save(mem);
  return mem.medications[mem.medications.length - 1];
}

function removeMedication(id) {
  const mem = load();
  const med = mem.medications.find(m => m.id === id);
  if (med) { med.active = false; save(mem); }
  return med;
}

function getActiveMedications() {
  return load().medications.filter(m => m.active);
}

function getTodayReminders() {
  const today = new Date();
  const hour = today.getHours();
  const active = getActiveMedications();

  return active.filter(med => {
    return med.times.some(t => {
      const [h] = t.split(':').map(Number);
      return Math.abs(h - hour) <= 1;
    });
  }).map(med => ({
    name: med.name,
    dose: med.dose,
    times: med.times,
    message: `💊 İlaç hatırlatma: ${med.name} — ${med.dose}`
  }));
}

module.exports = { addMedication, removeMedication, getActiveMedications, getTodayReminders };