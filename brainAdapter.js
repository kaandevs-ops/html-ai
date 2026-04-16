// ============================================================
// 🧠 brainAdapter.js — Brain → Davranış Köprüsü v1
//
// Brain modüllerinin (emotion, stress, learning, dream, goals)
// gerçek ajan davranışını etkilemesini sağlar.
//
// KURULUM (agentLoop.js'e ekle):
//   const BrainAdapter = require('./brainAdapter');
//   // mountAgentRoutes içinde:
//   const adapter = new BrainAdapter(brainInstance);
//
// KULLANIM (runAgentLoop içinde):
//   const config   = adapter.getRunConfig(goal);
//   const sysPrompt = adapter.buildSystemPrompt(goal, config);
//   const temp      = config.temperature;
//
// Orijinal dosyaların HİÇBİRİNE dokunulmaz.
// ============================================================

class BrainAdapter {
  constructor(brain) {
    this.brain = brain;
    this._lastConfig = null;
  }

  // ─────────────────────────────────────────────────────────
  // ANA METOT: Brain durumunu okuyup ajan konfigürasyonunu üret
  // ─────────────────────────────────────────────────────────
  getRunConfig(goal = '') {
    if (!this.brain) return this._defaultConfig();

    const emo      = this._safeGetEmotion();
    const stress   = this._safeGetStress(emo);
    const learning = this._safeGetLearning();
    const dreams   = this._safeGetDreams();
    const goals    = this._safeGetGoals(goal);
    const personality = this._safeGetPersonality();

    const config = {
      // ── LLM Parametreleri ────────────────────────────
      temperature:       this._calcTemperature(emo, stress, learning),
      maxSteps:          this._calcMaxSteps(emo, stress, learning),
      retryLimit:        this._calcRetryLimit(stress, learning),

      // ── Planlama Stili ───────────────────────────────
      planningStyle:     this._calcPlanningStyle(emo, stress, learning),

      // ── Prompt Ton Ayarları ──────────────────────────
      tone:              this._calcTone(emo, stress, personality),
      verbosity:         this._calcVerbosity(stress, emo),
      riskTolerance:     this._calcRiskTolerance(emo, stress, learning),

      // ── Hafıza ve Strateji ───────────────────────────
      dreamInsights:     dreams,
      goalAlignment:     goals,

      // ── Debug: Neden bu config? ──────────────────────
      _reasoning:        this._buildReasoning(emo, stress, learning)
    };

    this._lastConfig = config;
    this._logConfig(config);
    return config;
  }

  // ─────────────────────────────────────────────────────────
  // SİSTEM PROMPT OLUŞTUR — config'e göre LLM'e talimat ver
  // ─────────────────────────────────────────────────────────
  buildSystemPrompt(goal, config, basePrompt = '') {
    const blocks = [];

    // 1. Planlama tarzı talimatı
    switch (config.planningStyle) {
      case 'conservative':
        blocks.push(
          '⚠️ PLANLAMA TARZI: MUHAFAZAKAR\n' +
          'Son görevlerde hatalar yaşandı. Bunları dikkate al:\n' +
          '  - Her adımdan önce ön kontrol yap (dosya var mı? servis ayakta mı?)\n' +
          '  - Geri alınamaz işlemlerden (silme, üzerine yazma) kaçın\n' +
          '  - Emin olmadığın adımları verify aracıyla doğrula\n' +
          '  - Maksimum ' + config.maxSteps + ' adım kullan'
        );
        break;

      case 'aggressive':
        blocks.push(
          '🚀 PLANLAMA TARZI: AGRESIF\n' +
          'Başarı geçmişi yüksek. Bunları dikkate al:\n' +
          '  - Paralelleştirilebilecek adımları birleştir\n' +
          '  - Gereksiz doğrulama adımlarını atla\n' +
          '  - Daha az adımda hedefe ulaşmayı dene\n' +
          '  - Gerekirse farklı ve yaratıcı araç kombinasyonları kullan'
        );
        break;

      case 'experimental':
        blocks.push(
          '🔬 PLANLAMA TARZI: DENEYSEl\n' +
          'Rüya modülünden çıkarılan alternatif stratejiler mevcut.\n' +
          '  - Alışılmış yolun dışına çık\n' +
          '  - Daha önce denenmemiş araç kombinasyonları uygula\n' +
          '  - İlk adımı küçük tutup sonucu değerlendir'
        );
        break;

      case 'focused':
        blocks.push(
          '🎯 PLANLAMA TARZI: ODAKLI\n' +
          'Hedefle doğrudan ilgili adımlar üret.\n' +
          '  - Sadece görevi tamamlamak için gerekli minimum adımları planla\n' +
          '  - Yan görevlere girme'
        );
        break;

      default: // 'balanced'
        blocks.push(
          '⚖️ PLANLAMA TARZI: DENGELİ\n' +
          'Normal çalışma modu. Adımları dikkatli ama verimli planla.'
        );
    }

    // 2. Risk toleransı
    if (config.riskTolerance === 'low') {
      blocks.push(
        '🛡️ RİSK MOD: DÜŞÜK\n' +
        'Geri alınamaz işlemleri (silme, üzerine yazma, sistem değişikliği) ' +
        'önce remember aracıyla kaydet, sonra uygula.'
      );
    } else if (config.riskTolerance === 'high') {
      blocks.push(
        '⚡ RİSK MOD: YÜKSEK\n' +
        'Performans öncelikli. Gereksiz güvenlik kontrol adımlarını atla.'
      );
    }

    // 3. Rüya içgörüleri (varsa)
    if (config.dreamInsights && config.dreamInsights.length > 0) {
      const insights = config.dreamInsights
        .slice(0, 3)
        .map(d => `  • ${d.imagined}`)
        .join('\n');
      blocks.push(`💭 GEÇMİŞ DENEYİMLERDEN ÇIKARILAN DERSLER:\n${insights}`);
    }

    // 4. Hedef uyumu
    if (config.goalAlignment && config.goalAlignment.length > 0) {
      const goalList = config.goalAlignment
        .slice(0, 2)
        .map(g => `  • ${g.description || g}`)
        .join('\n');
      blocks.push(`🎯 AKTİF UZUN VADELİ HEDEFLER (bunlarla uyumlu ol):\n${goalList}`);
    }

    // 5. Verbosity
    if (config.verbosity === 'minimal') {
      blocks.push('📝 YANIT TARZI: Adım açıklamalarını kısa tut (1 cümle max). Zaman kritik.');
    } else if (config.verbosity === 'detailed') {
      blocks.push('📝 YANIT TARZI: Her adımın amacını ve beklenen sonucunu açıkla.');
    }

    // Blokları birleştir
    const brainPrefix = blocks.join('\n\n');

    if (!basePrompt) return brainPrefix;
    return `${brainPrefix}\n\n${'─'.repeat(60)}\n\n${basePrompt}`;
  }

  // ─────────────────────────────────────────────────────────
  // HESAPLAMA METOTları
  // ─────────────────────────────────────────────────────────

  _calcTemperature(emo, stress, learning) {
    let temp = 0.1; // varsayılan

    // Yüksek stres → daha belirleyici (düşük temp)
    if (stress.level === 'high' || stress.level === 'critical') {
      temp = 0.05;
    }
    // Başarı geçmişi yüksek → biraz daha yaratıcı
    else if (learning.recentSuccessRate > 0.8) {
      temp = 0.2;
    }
    // Çok fazla başarısızlık → çok belirleyici
    else if (learning.recentSuccessRate < 0.3) {
      temp = 0.05;
    }

    // Duygusal enerji yüksekse → biraz daha sıcak
    if (emo.confidence > 0.8) {
      temp = Math.min(temp + 0.05, 0.3);
    }
    // Düşük güven → soğuk
    if (emo.confidence < 0.3) {
      temp = Math.max(temp - 0.05, 0.01);
    }

    return parseFloat(temp.toFixed(2));
  }

  _calcMaxSteps(emo, stress, learning) {
    let steps = 20; // varsayılan

    // Yüksek stres → az adım, odaklan
    if (stress.level === 'critical') steps = 8;
    else if (stress.level === 'high')  steps = 12;
    else if (stress.level === 'medium') steps = 16;

    // Başarı geçmişi çok yüksekse → daha geniş çaplı görev alabilir
    if (learning.recentSuccessRate > 0.85) {
      steps = Math.min(steps + 5, 30);
    }

    // Çok başarısızlık → limitli adım
    if (learning.recentSuccessRate < 0.3) {
      steps = Math.min(steps, 10);
    }

    return steps;
  }

  _calcRetryLimit(stress, learning) {
    // Stres yüksekse daha az retry (takılıp kalma)
    if (stress.level === 'critical') return 1;
    if (stress.level === 'high')     return 2;
    // Başarı düşükse daha fazla retry (ısrarcı ol)
    if (learning.recentSuccessRate < 0.4) return 5;
    return 3; // varsayılan
  }

  _calcPlanningStyle(emo, stress, learning) {
    const successRate = learning.recentSuccessRate;
    const stressLevel = stress.level;

    // Kritik stres → muhafazakar
    if (stressLevel === 'critical') return 'conservative';

    // Çok başarısız → muhafazakar
    if (successRate < 0.3) return 'conservative';

    // Rüya modülünden yeni strateji var + orta başarı → deneysel
    if (learning.hasDreamInsights && successRate > 0.4 && successRate < 0.7) {
      return 'experimental';
    }

    // Yüksek başarı + düşük stres → agresif
    if (successRate > 0.8 && stressLevel === 'low') return 'aggressive';

    // Orta başarı + orta stres → odaklı
    if (successRate > 0.5 && stressLevel === 'medium') return 'focused';

    return 'balanced';
  }

  _calcTone(emo, stress, personality) {
    if (stress.level === 'critical') return 'urgent';
    if (emo.mood === 'HAPPY' || emo.confidence > 0.8) return 'confident';
    if (emo.mood === 'SAD' || emo.confidence < 0.3) return 'cautious';
    return 'neutral';
  }

  _calcVerbosity(stress, emo) {
    // Yüksek stres → minimal açıklama
    if (stress.level === 'critical' || stress.level === 'high') return 'minimal';
    // Düşük güven → detaylı açıkla (hata ayıklamak için)
    if (emo.confidence < 0.3) return 'detailed';
    return 'normal';
  }

  _calcRiskTolerance(emo, stress, learning) {
    if (stress.level === 'critical') return 'low';
    if (learning.recentSuccessRate < 0.4) return 'low';
    if (learning.recentSuccessRate > 0.8 && stress.level === 'low') return 'high';
    return 'medium';
  }

  // ─────────────────────────────────────────────────────────
  // BRAIN'DEN GÜVENLİ VERİ OKUMA (hata olursa varsayılan dön)
  // ─────────────────────────────────────────────────────────

  _safeGetEmotion() {
    try {
      return this.brain.emo?.getState() || this._defaultEmo();
    } catch {
      return this._defaultEmo();
    }
  }

  _safeGetStress(emoState) {
    try {
      const raw = this.brain.stress?.getStrategy(emoState);
      // stress modülü string veya object dönebilir
      if (typeof raw === 'string') {
        // "YÜKSEK STRES: ..." gibi string'den seviye çıkar
        if (raw.includes('KRİTİK') || raw.includes('CRITICAL'))  return { level: 'critical', raw };
        if (raw.includes('YÜKSEK')  || raw.includes('HIGH'))      return { level: 'high', raw };
        if (raw.includes('ORTA')    || raw.includes('MEDIUM'))    return { level: 'medium', raw };
        return { level: 'low', raw };
      }
      if (raw && typeof raw === 'object') {
        return { level: raw.level || 'low', ...raw };
      }
      return { level: 'low' };
    } catch {
      return { level: 'low' };
    }
  }

  _safeGetLearning() {
    try {
      const recentSuccessRate   = this.brain.learning?.getSuccessRate()        ?? 1.0;
      const lifetimeSuccessRate = this.brain.learning?.getLifetimeSuccessRate() ?? 1.0;
      const dreams = this.brain.dream?.getRecentDreams(3) || [];
      return {
        recentSuccessRate,
        lifetimeSuccessRate,
        hasDreamInsights: dreams.length > 0
      };
    } catch {
      return { recentSuccessRate: 1.0, lifetimeSuccessRate: 1.0, hasDreamInsights: false };
    }
  }

  _safeGetDreams() {
    try {
      return this.brain.dream?.getRecentDreams(3) || [];
    } catch {
      return [];
    }
  }

  _safeGetGoals(currentGoal) {
    try {
      const allGoals = this.brain.goals?.getGoals() || [];
      // Aktif hedefler
      return allGoals
        .filter(g => g.active !== false)
        .slice(0, 3);
    } catch {
      return [];
    }
  }

  _safeGetPersonality() {
    try {
      return this.brain.personality?.getPersonality() || {};
    } catch {
      return {};
    }
  }

  // ─────────────────────────────────────────────────────────
  // YARDIMCI
  // ─────────────────────────────────────────────────────────

  _defaultConfig() {
    return {
      temperature:    0.1,
      maxSteps:       20,
      retryLimit:     3,
      planningStyle:  'balanced',
      tone:           'neutral',
      verbosity:      'normal',
      riskTolerance:  'medium',
      dreamInsights:  [],
      goalAlignment:  [],
      _reasoning:     'Brain bağlı değil, varsayılan config.'
    };
  }

  _defaultEmo() {
    return { confidence: 0.7, mood: 'NORMAL', urgency: 0 };
  }

  _buildReasoning(emo, stress, learning) {
    return [
      `Stres: ${stress.level}`,
      `Güven: ${(emo.confidence * 100).toFixed(0)}%`,
      `Son başarı oranı: %${(learning.recentSuccessRate * 100).toFixed(0)}`,
      `Mod: ${emo.mood}`
    ].join(' | ');
  }

  _logConfig(config) {
    console.log(
      `[BrainAdapter] 🧠 Config → ` +
      `style=${config.planningStyle} | ` +
      `temp=${config.temperature} | ` +
      `maxSteps=${config.maxSteps} | ` +
      `retry=${config.retryLimit} | ` +
      `risk=${config.riskTolerance} | ` +
      `(${config._reasoning})`
    );
  }

  // Son hesaplanan config'i dışarıya aç (debug için)
  getLastConfig() {
    return this._lastConfig;
  }
}

module.exports = BrainAdapter;