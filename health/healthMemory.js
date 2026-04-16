const fs = require('fs');
const path = require('path');

const MEMORY_PATH = path.join(__dirname, '../health_memory.json');

function load() {
  try {
    return JSON.parse(fs.readFileSync(MEMORY_PATH, 'utf8'));
  } catch {
    return { symptoms: [], diagnoses: [], medications: [],
             appointments: [], emergencyLogs: [], healthLogs: [] };
  }
}

function save(data) {
  fs.writeFileSync(MEMORY_PATH, JSON.stringify(data, null, 2));
}

function addSymptom(symptom) {
  const mem = load();
  mem.symptoms.push({ symptom, date: new Date().toISOString() });
  if (mem.symptoms.length > 200) mem.symptoms.shift();
  save(mem);
}

function addHealthLog(log) {
  const mem = load();
  mem.healthLogs.push({ ...log, date: new Date().toISOString() });
  if (mem.healthLogs.length > 500) mem.healthLogs.shift();
  save(mem);
}

function addEmergencyLog(log) {
  const mem = load();
  mem.emergencyLogs.push({ ...log, date: new Date().toISOString() });
  save(mem);
}

function getRecentSymptoms(limit = 10) {
  return load().symptoms.slice(-limit);
}

function getAll() {
  return load();
}

module.exports = {
  addSymptom, addHealthLog, addEmergencyLog,
  getRecentSymptoms, getAll
};