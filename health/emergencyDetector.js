const healthMemory  = require('./healthMemory');
const healthProfile = require('./healthProfile');

const EMERGENCY_KEYWORDS = [
  'göğüs ağrısı', 'nefes alamıyorum', 'bayılıyorum', 'kalp',
  'felç', 'inme', 'kan geliyor', 'bilinç', 'uyuyamıyorum ağrıdan',
  'çok şiddetli ağrı', 'acil', 'ambulans', 'bayıldım', 'titreme',
  'yüksek ateş', 'şuur', 'kasılma', 'sara', 'zehirlendim'
];

const URGENT_KEYWORDS = [
  'baş dönmesi', 'mide bulantısı', 'kusma', 'ateş', 'baş ağrısı',
  'halsizlik', 'yorgunluk', 'eklem ağrısı', 'sırt ağrısı', 'öksürük'
];

function detect(message) {
  const lower = message.toLowerCase();

  // Alerji kontrolü — profilden al
  const allergyWarning = healthProfile.getAllergyWarning(lower);

  const isEmergency = EMERGENCY_KEYWORDS.some(k => lower.includes(k));
  const isUrgent    = URGENT_KEYWORDS.some(k => lower.includes(k));

  // Acil kişileri al
  const profile    = healthProfile.getProfile();
  const contacts   = profile.emergencyContacts || [];
  const firstContact = contacts[0] || null;

  const contactText = firstContact
    ? `\n📞 Acil kişi: ${firstContact.name} (${firstContact.relation}) — ${firstContact.phone}`
    : '';

  if (isEmergency) {
    healthMemory.addEmergencyLog({ message, level: 'EMERGENCY' });
    return {
      level: 'EMERGENCY',
      message: `🚨 ACİL DURUM! Hemen 112'yi arayın veya en yakın acile gidin.${contactText}`,
      allergyWarning,
      action: 'CALL_112',
      emergencyContacts: contacts
    };
  }

  if (isUrgent) {
    return {
      level: 'URGENT',
      message: `⚠️ Belirtilerin dikkat gerektiriyor. Bir doktora danışmanı öneririm.${contactText}`,
      allergyWarning,
      action: 'SEE_DOCTOR',
      emergencyContacts: contacts
    };
  }

  return {
    level: 'NORMAL',
    message: null,
    allergyWarning,
    action: null,
    emergencyContacts: contacts
  };
}

module.exports = { detect };