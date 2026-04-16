const fs   = require('fs');
const path = require('path');

const PROFILE_PATH = path.join(__dirname, '../health_profile.json');

function _load() {
  try {
    return JSON.parse(fs.readFileSync(PROFILE_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function _save(data) {
  data.lastUpdated = new Date().toISOString();
  fs.writeFileSync(PROFILE_PATH, JSON.stringify(data, null, 2));
  return data;
}

// ── Genel profil ──────────────────────────────────────────
function getProfile()         { return _load(); }
function saveProfile(data)    { return _save({ ..._load(), ...data }); }
function updateField(key, val){ const p = _load(); p[key] = val; return _save(p); }

// ── Hastalıklar ───────────────────────────────────────────
function addDisease({ name, diagnosedYear, severity, notes }) {
  const p = _load();
  p.chronicDiseases.push({
    id: Date.now().toString(), name,
    diagnosedYear: diagnosedYear || null,
    severity: severity || 'orta',
    notes: notes || '',
    addedAt: new Date().toISOString()
  });
  return _save(p);
}

function removeDisease(id) {
  const p = _load();
  p.chronicDiseases = p.chronicDiseases.filter(d => d.id !== id);
  return _save(p);
}

// ── Alerjiler ─────────────────────────────────────────────
function addAllergy({ substance, type, reaction, severity }) {
  const p = _load();
  p.allergies.push({
    id: Date.now().toString(), substance,
    type: type || 'diğer',
    reaction: reaction || '',
    severity: severity || 'orta',
    addedAt: new Date().toISOString()
  });
  return _save(p);
}

function removeAllergy(id) {
  const p = _load();
  p.allergies = p.allergies.filter(a => a.id !== id);
  return _save(p);
}

// ── Ameliyatlar ───────────────────────────────────────────
function addSurgery({ name, year, hospital, notes }) {
  const p = _load();
  p.surgeries.push({
    id: Date.now().toString(), name,
    year: year || null,
    hospital: hospital || '',
    notes: notes || '',
    addedAt: new Date().toISOString()
  });
  return _save(p);
}

function removeSurgery(id) {
  const p = _load();
  p.surgeries = p.surgeries.filter(s => s.id !== id);
  return _save(p);
}

// ── Aile geçmişi ──────────────────────────────────────────
function addFamilyHistory({ disease, relation }) {
  const p = _load();
  p.familyHistory.push({
    id: Date.now().toString(),
    disease, relation,
    addedAt: new Date().toISOString()
  });
  return _save(p);
}

function removeFamilyHistory(id) {
  const p = _load();
  p.familyHistory = p.familyHistory.filter(f => f.id !== id);
  return _save(p);
}

// ── Aşılar ───────────────────────────────────────────────
function addVaccine({ name, date, nextDose }) {
  const p = _load();
  p.vaccines.push({
    id: Date.now().toString(), name,
    date: date || null,
    nextDose: nextDose || null,
    addedAt: new Date().toISOString()
  });
  return _save(p);
}

function removeVaccine(id) {
  const p = _load();
  p.vaccines = p.vaccines.filter(v => v.id !== id);
  return _save(p);
}

// ── Hayati bulgular ───────────────────────────────────────
function updateVitals({ bloodPressure, heartRate, bloodSugar, cholesterol }) {
  const p = _load();
  p.vitalSigns = {
    bloodPressure:  bloodPressure  || p.vitalSigns.bloodPressure,
    heartRate:      heartRate      || p.vitalSigns.heartRate,
    bloodSugar:     bloodSugar     || p.vitalSigns.bloodSugar,
    cholesterol:    cholesterol    || p.vitalSigns.cholesterol,
    lastMeasured:   new Date().toISOString()
  };
  return _save(p);
}

// ── Acil kişiler ──────────────────────────────────────────
function addEmergencyContact({ name, relation, phone, priority }) {
  const p = _load();
  p.emergencyContacts.push({
    id: Date.now().toString(), name,
    relation: relation || '',
    phone: phone || '',
    priority: priority || p.emergencyContacts.length + 1,
    addedAt: new Date().toISOString()
  });
  p.emergencyContacts.sort((a, b) => a.priority - b.priority);
  return _save(p);
}

function removeEmergencyContact(id) {
  const p = _load();
  p.emergencyContacts = p.emergencyContacts.filter(c => c.id !== id);
  return _save(p);
}

// ── Doktorlar ─────────────────────────────────────────────
function addDoctor({ name, specialty, hospital, phone }) {
  const p = _load();
  p.doctors.push({
    id: Date.now().toString(), name,
    specialty: specialty || '',
    hospital:  hospital  || '',
    phone:     phone     || '',
    addedAt:   new Date().toISOString()
  });
  return _save(p);
}

function removeDoctor(id) {
  const p = _load();
  p.doctors = p.doctors.filter(d => d.id !== id);
  return _save(p);
}

// ── Sigorta ───────────────────────────────────────────────
function updateInsurance({ company, policyNumber, validUntil, type }) {
  const p = _load();
  p.insurance = { company, policyNumber, validUntil, type };
  return _save(p);
}

// ── Yaşam tarzı ───────────────────────────────────────────
function updateLifestyle({ smoking, alcohol, exercise, diet, sleepHours }) {
  const p = _load();
  p.lifestyle = { smoking, alcohol, exercise, diet, sleepHours };
  return _save(p);
}

// ── Alerji kontrolü (acil detector için) ─────────────────
function getAllergyWarning(text) {
  const p = _load();
  if (!p.allergies || !p.allergies.length) return null;
  const lower = text.toLowerCase();
  const hit = p.allergies.find(a =>
    lower.includes(a.substance.toLowerCase())
  );
  if (!hit) return null;
  return `⚠️ ALERJİ UYARISI: "${hit.substance}" alerjin var! Reaksiyon: ${hit.reaction} (${hit.severity})`;
}

module.exports = {
  getProfile, saveProfile, updateField,
  addDisease, removeDisease,
  addAllergy, removeAllergy,
  addSurgery, removeSurgery,
  addFamilyHistory, removeFamilyHistory,
  addVaccine, removeVaccine,
  updateVitals,
  addEmergencyContact, removeEmergencyContact,
  addDoctor, removeDoctor,
  updateInsurance,
  updateLifestyle,
  getAllergyWarning
};