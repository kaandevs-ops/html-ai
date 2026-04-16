const fs = require('fs');
const path = require('path');

const MEMORY_PATH = path.join(__dirname, '../health_memory.json');

function load() {
  try {
    return JSON.parse(fs.readFileSync(MEMORY_PATH, 'utf8'));
  } catch { return { appointments: [] }; }
}

function save(data) {
  fs.writeFileSync(MEMORY_PATH, JSON.stringify(data, null, 2));
}

function addAppointment({ doctor, specialty, date, time, hospital, notes }) {
  const mem = load();
  mem.appointments.push({
    id: Date.now().toString(),
    doctor, specialty, date, time,
    hospital: hospital || '',
    notes: notes || '',
    status: 'active',
    createdAt: new Date().toISOString()
  });
  save(mem);
  return mem.appointments[mem.appointments.length - 1];
}

function cancelAppointment(id) {
  const mem = load();
  const apt = mem.appointments.find(a => a.id === id);
  if (apt) { apt.status = 'cancelled'; save(mem); }
  return apt;
}

function getUpcoming() {
  const today = new Date().toISOString().split('T')[0];
  return load().appointments
    .filter(a => a.status === 'active' && a.date >= today)
    .sort((a, b) => a.date.localeCompare(b.date));
}

function getAll() {
  return load().appointments;
}

module.exports = { addAppointment, cancelAppointment, getUpcoming, getAll };