const axios = require('axios');
const healthMemory = require('./healthMemory');
const healthProfile = require('./healthProfile');
const emergencyDetector = require('./emergencyDetector');

const OLLAMA_URL = 'http://localhost:11434/api/generate';
const MODEL = 'llama3.1:8b';

async function analyzeSymptoms(userMessage) {
  // Önce acil durum kontrolü
  const emergency = emergencyDetector.detect(userMessage);
  if (emergency.level === 'EMERGENCY') {
    return { type: 'emergency', response: emergency.message };
  }

  const profile = healthProfile.getProfile();
  const recentSymptoms = healthMemory.getRecentSymptoms(5);

  const systemPrompt = `Sen Nova Mind'ın dahili sağlık asistanısın. 
Türkçe konuşuyorsun. Sadece genel sağlık bilgisi veriyorsun, kesin teşhis koymuyorsun.
Her zaman "bir doktora danışın" uyarısını ekle.
Hasta profili: ${JSON.stringify(profile)}
Son semptomlar: ${JSON.stringify(recentSymptoms)}
ÖNEMLİ: Sen bir doktor değilsin, yönlendirme yapıyorsun.`;

  try {
    const res = await axios.post(OLLAMA_URL, {
      model: MODEL,
      prompt: `${systemPrompt}\n\nKullanıcı: ${userMessage}\nSağlık Asistanı:`,
      stream: false,
      options: { temperature: 0.3 }
    });

    const response = res.data.response;
    healthMemory.addSymptom(userMessage);
    healthMemory.addHealthLog({ type: 'symptom_analysis', input: userMessage, output: response });

    return {
      type: emergency.level === 'URGENT' ? 'urgent' : 'normal',
      response: emergency.message
        ? `${emergency.message}\n\n${response}`
        : response
    };
  } catch (err) {
    return {
      type: 'error',
      response: 'Sağlık asistanı şu an yanıt veremiyor. Acil durumda 112\'yi arayın.'
    };
  }
}

module.exports = { analyzeSymptoms };