const express       = require('express');
const healthAgent   = require('./healthAgent');
const healthProfile = require('./healthProfile');
const healthMemory  = require('./healthMemory');
const medication    = require('./medicationReminder');
const appointment   = require('./appointmentTracker');
const emergency     = require('./emergencyDetector');

module.exports = function(brain) {
  const router = express.Router();

  // ── Brain'e sağlık özeti ekle (enrichPrompt) ──────────
  if (brain && typeof brain.enrichPrompt === 'function') {
    const _originalEnrich = brain.enrichPrompt.bind(brain);
    brain.enrichPrompt = function(userPrompt) {
      const base    = _originalEnrich(userPrompt);
      const profile = healthProfile.getProfile();
      const parts   = [];

      if (profile.name) {
        parts.push(`Kullanıcı adı: ${profile.name}`);
      }
      if (profile.chronicDiseases?.length) {
        parts.push(`Kronik hastalıklar: ${profile.chronicDiseases.map(d => d.name).join(', ')}`);
      }
      if (profile.allergies?.length) {
        parts.push(`Alerjiler: ${profile.allergies.map(a => `${a.substance}(${a.severity})`).join(', ')}`);
      }
      if (profile.currentMedications?.length) {
        parts.push(`Mevcut ilaçlar: ${profile.currentMedications.map(m => m.name).join(', ')}`);
      }
      if (profile.vitalSigns?.bloodPressure) {
        parts.push(`Son ölçümler: tansiyon ${profile.vitalSigns.bloodPressure}, nabız ${profile.vitalSigns.heartRate}`);
      }

      if (!parts.length) return base;

      const healthCtx = `=== SAĞLIK PROFİLİ ===\n${parts.join('\n')}`;
      const marker    = '=== KULLANICI İSTEĞİ ===';
      if (base.includes(marker)) {
        return base.replace(marker, healthCtx + '\n\n' + marker);
      }
      return healthCtx + '\n\n' + base;
    };
    console.log('[HealthRouter] 🧠 Brain.enrichPrompt sağlık bağlamıyla genişletildi.');
  }

  // ── Brain'e sağlık verisi öğret (yardımcı) ────────────
  function _teachBrain(key, value, importance = 0.9) {
    if (!brain) return;
    try {
      brain.mem.remember(key, value, importance);
      brain.learn(key, value);
    } catch(e) {}
  }

  // ── Semptom & Acil ────────────────────────────────────
  router.post('/ask', async (req, res) => {
    const { message } = req.body;
    if (!message) return res.status(400).json({ error: 'message gerekli' });
    const result = await healthAgent.analyzeSymptoms(message);

    _teachBrain(
      `Sağlık sorusu: ${message.slice(0, 60)}`,
      `Cevap tipi: ${result.type}`,
      0.7
    );

    res.json(result);
  });

  router.post('/emergency-check', (req, res) => {
    const { message } = req.body;
    const result = emergency.detect(message);

    if (result.level === 'EMERGENCY') {
      _teachBrain(
        `ACİL DURUM tespit edildi`,
        `Mesaj: ${message.slice(0, 100)}`,
        1.0
      );
    }

    res.json(result);
  });

  // ── Profil (genel) ────────────────────────────────────
  router.get('/profile', (req, res) => {
    res.json(healthProfile.getProfile());
  });

  router.post('/profile', (req, res) => {
    const result = healthProfile.saveProfile(req.body);
    _teachBrain(
      `Kullanıcı sağlık profili`,
      `İsim: ${req.body.name || ''}, Yaş: ${req.body.age || ''}, Kan grubu: ${req.body.bloodType || ''}`,
      0.95
    );
    res.json(result);
  });

  // ── Hastalıklar ───────────────────────────────────────
  router.post('/profile/diseases', (req, res) => {
    const result = healthProfile.addDisease(req.body);
    _teachBrain(
      `Kronik hastalık: ${req.body.name}`,
      `Teşhis yılı: ${req.body.diagnosedYear || 'bilinmiyor'}, Şiddet: ${req.body.severity || 'orta'}, Not: ${req.body.notes || ''}`,
      0.95
    );
    res.json(result);
  });

  router.delete('/profile/diseases/:id', (req, res) => {
    const result = healthProfile.removeDisease(req.params.id);
    _teachBrain(`Hastalık kaydı silindi`, `ID: ${req.params.id}`, 0.6);
    res.json(result);
  });

  // ── Alerjiler ─────────────────────────────────────────
  router.post('/profile/allergies', (req, res) => {
    const result = healthProfile.addAllergy(req.body);
    _teachBrain(
      `ALERJİ UYARISI — ${req.body.substance}`,
      `Tip: ${req.body.type}, Reaksiyon: ${req.body.reaction}, Şiddet: ${req.body.severity}`,
      1.0  // en yüksek önem — alerji hayati
    );
    res.json(result);
  });

  router.delete('/profile/allergies/:id', (req, res) => {
    const result = healthProfile.removeAllergy(req.params.id);
    _teachBrain(`Alerji kaydı silindi`, `ID: ${req.params.id}`, 0.6);
    res.json(result);
  });

  // ── Ameliyatlar ───────────────────────────────────────
  router.post('/profile/surgeries', (req, res) => {
    const result = healthProfile.addSurgery(req.body);
    _teachBrain(
      `Geçirilmiş ameliyat: ${req.body.name}`,
      `Yıl: ${req.body.year || 'bilinmiyor'}, Hastane: ${req.body.hospital || ''}, Not: ${req.body.notes || ''}`,
      0.85
    );
    res.json(result);
  });

  router.delete('/profile/surgeries/:id', (req, res) => {
    const result = healthProfile.removeSurgery(req.params.id);
    _teachBrain(`Ameliyat kaydı silindi`, `ID: ${req.params.id}`, 0.6);
    res.json(result);
  });

  // ── Aile geçmişi ──────────────────────────────────────
  router.post('/profile/family-history', (req, res) => {
    const result = healthProfile.addFamilyHistory(req.body);
    _teachBrain(
      `Aile hastalık geçmişi: ${req.body.disease}`,
      `Yakınlık: ${req.body.relation}`,
      0.85
    );
    res.json(result);
  });

  router.delete('/profile/family-history/:id', (req, res) => {
    const result = healthProfile.removeFamilyHistory(req.params.id);
    _teachBrain(`Aile geçmişi kaydı silindi`, `ID: ${req.params.id}`, 0.6);
    res.json(result);
  });

  // ── Aşılar ───────────────────────────────────────────
  router.post('/profile/vaccines', (req, res) => {
    const result = healthProfile.addVaccine(req.body);
    _teachBrain(
      `Aşı kaydı: ${req.body.name}`,
      `Tarih: ${req.body.date || 'bilinmiyor'}, Sonraki doz: ${req.body.nextDose || 'yok'}`,
      0.8
    );
    res.json(result);
  });

  router.delete('/profile/vaccines/:id', (req, res) => {
    const result = healthProfile.removeVaccine(req.params.id);
    _teachBrain(`Aşı kaydı silindi`, `ID: ${req.params.id}`, 0.6);
    res.json(result);
  });

  // ── Hayati bulgular ───────────────────────────────────
  router.put('/profile/vitals', (req, res) => {
    const result = healthProfile.updateVitals(req.body);
    _teachBrain(
      `Hayati bulgular güncellendi`,
      `Tansiyon: ${req.body.bloodPressure || '-'}, Nabız: ${req.body.heartRate || '-'}, Şeker: ${req.body.bloodSugar || '-'}, Kolesterol: ${req.body.cholesterol || '-'}`,
      0.9
    );
    res.json(result);
  });

  // ── Acil kişiler ──────────────────────────────────────
  router.post('/profile/emergency-contacts', (req, res) => {
    const result = healthProfile.addEmergencyContact(req.body);
    _teachBrain(
      `Acil iletişim kişisi: ${req.body.name}`,
      `Yakınlık: ${req.body.relation}, Telefon: ${req.body.phone}, Öncelik: ${req.body.priority || 1}`,
      0.95
    );
    res.json(result);
  });

  router.delete('/profile/emergency-contacts/:id', (req, res) => {
    const result = healthProfile.removeEmergencyContact(req.params.id);
    _teachBrain(`Acil kişi kaydı silindi`, `ID: ${req.params.id}`, 0.6);
    res.json(result);
  });

  // ── Doktorlar ─────────────────────────────────────────
  router.post('/profile/doctors', (req, res) => {
    const result = healthProfile.addDoctor(req.body);
    _teachBrain(
      `Doktor kaydı: ${req.body.name}`,
      `Uzmanlık: ${req.body.specialty}, Hastane: ${req.body.hospital}, Tel: ${req.body.phone}`,
      0.85
    );
    res.json(result);
  });

  router.delete('/profile/doctors/:id', (req, res) => {
    const result = healthProfile.removeDoctor(req.params.id);
    _teachBrain(`Doktor kaydı silindi`, `ID: ${req.params.id}`, 0.6);
    res.json(result);
  });

  // ── Sigorta ───────────────────────────────────────────
  router.put('/profile/insurance', (req, res) => {
    const result = healthProfile.updateInsurance(req.body);
    _teachBrain(
      `Sağlık sigortası`,
      `Şirket: ${req.body.company}, Poliçe: ${req.body.policyNumber}, Geçerlilik: ${req.body.validUntil}`,
      0.8
    );
    res.json(result);
  });

  // ── Yaşam tarzı ───────────────────────────────────────
  router.put('/profile/lifestyle', (req, res) => {
    const result = healthProfile.updateLifestyle(req.body);
    _teachBrain(
      `Yaşam tarzı bilgileri`,
      `Sigara: ${req.body.smoking ? 'var' : 'yok'}, Alkol: ${req.body.alcohol}, Egzersiz: ${req.body.exercise}, Uyku: ${req.body.sleepHours} saat`,
      0.8
    );
    res.json(result);
  });

  // ── İlaçlar ──────────────────────────────────────────
  router.get('/medications', (req, res) =>
    res.json(medication.getActiveMedications()));

  router.post('/medications', (req, res) => {
    const result = medication.addMedication(req.body);
    _teachBrain(
      `İlaç kullanımı: ${req.body.name}`,
      `Doz: ${req.body.dose}, Saatler: ${(req.body.times || []).join(', ')}, Not: ${req.body.notes || ''}`,
      0.95
    );
    res.json(result);
  });

  router.delete('/medications/:id', (req, res) => {
    const result = medication.removeMedication(req.params.id);
    _teachBrain(`İlaç bırakıldı`, `ID: ${req.params.id}`, 0.7);
    res.json(result);
  });

  router.get('/medications/today', (req, res) =>
    res.json(medication.getTodayReminders()));

  // ── Randevular ────────────────────────────────────────
  router.get('/appointments', (req, res) =>
    res.json(appointment.getUpcoming()));

  router.post('/appointments', (req, res) => {
    const result = appointment.addAppointment(req.body);
    _teachBrain(
      `Doktor randevusu: ${req.body.doctor}`,
      `Uzmanlık: ${req.body.specialty}, Tarih: ${req.body.date} ${req.body.time}, Hastane: ${req.body.hospital || ''}`,
      0.9
    );
    res.json(result);
  });

  router.delete('/appointments/:id', (req, res) => {
    const result = appointment.cancelAppointment(req.params.id);
    _teachBrain(`Randevu iptal edildi`, `ID: ${req.params.id}`, 0.7);
    res.json(result);
  });

  // ── Geçmiş ───────────────────────────────────────────
  router.get('/history', (req, res) =>
    res.json(healthMemory.getAll()));

  // ── Brain sağlık özeti ────────────────────────────────
  router.get('/brain-sync', (req, res) => {
    if (!brain) return res.json({ status: 'error', message: 'Brain bağlı değil' });

    const profile = healthProfile.getProfile();

    // Tüm sağlık verisini Brain'e tek seferde öğret
    if (profile.allergies?.length) {
      profile.allergies.forEach(a => {
        _teachBrain(
          `ALERJİ: ${a.substance}`,
          `Reaksiyon: ${a.reaction}, Şiddet: ${a.severity}`,
          1.0
        );
      });
    }

    if (profile.chronicDiseases?.length) {
      profile.chronicDiseases.forEach(d => {
        _teachBrain(
          `Kronik hastalık: ${d.name}`,
          `Şiddet: ${d.severity}, Not: ${d.notes}`,
          0.95
        );
      });
    }

    if (profile.emergencyContacts?.length) {
      profile.emergencyContacts.forEach(c => {
        _teachBrain(
          `Acil kişi: ${c.name}`,
          `Yakınlık: ${c.relation}, Tel: ${c.phone}`,
          0.95
        );
      });
    }

    if (profile.doctors?.length) {
      profile.doctors.forEach(d => {
        _teachBrain(
          `Doktor: ${d.name}`,
          `Uzmanlık: ${d.specialty}, Hastane: ${d.hospital}, Tel: ${d.phone}`,
          0.85
        );
      });
    }

    res.json({
      status: 'success',
      message: 'Tüm sağlık verileri Brain\'e öğretildi',
      synced: {
        allergies:       (profile.allergies || []).length,
        diseases:        (profile.chronicDiseases || []).length,
        emergencyContacts: (profile.emergencyContacts || []).length,
        doctors:         (profile.doctors || []).length,
        medications:     (profile.currentMedications || []).length
      }
    });
  });

  return router;
};