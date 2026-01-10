function normalizeText(s = '') {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
}

/**
 * ✅ COMPAT con sqlBuilder: retorna STRING como siempre
 */
function classifyIntent(question = '') {
  const q = normalizeText(question);

  const isCnv = /\b(cnv|convertid|converted|confirmad|case converted)\b/.test(q);
  const isHealth = /\b(dropped|drop|problem|ref out|aging|>30|>60|sin visitas|no visits|visits)\b/.test(q);
  const isClinical = /\b(clinical|cl[ií]nic|treatment|ldot|visitas cl[ií]nicas)\b/.test(q);
  const isDetail = /\b(detalle|lista|listado|top|casos|cases|ver)\b/.test(q);

  if (isCnv && (isHealth || isClinical)) return 'mix';
  if (isCnv) return 'cnv';
  if (isClinical) return 'clinical';
  if (isHealth) return 'health';
  if (isDetail) return 'detail';
  return 'general';
}

/**
 * ✅ Para el router: decide si consultar DB
 * Retorna { intent, needsSql }
 */
function classifyIntentInfo(question = '') {
  const q = normalizeText(question);

  // ✅ 0) PROFILE / NAME SETTING => NO SQL
  // Ej: "me llamo Ana", "mi nombre es Ana", "soy Ana", "my name is Ana", "I'm Ana"
  const isProfile =
    /\b(me\s+llamo|mi\s+nombre\s+es|soy)\b/.test(q) ||
    /\b(my\s+name\s+is|i\s+am|i'?m)\b/.test(q) ||
    /\b(recuerda\s+mi\s+nombre|remember\s+my\s+name|cual\s+es\s+mi\s+nombre|what\s+is\s+my\s+name)\b/.test(q);

  if (isProfile) {
    return { intent: 'profile', needsSql: false };
  }

  // 1) greeting / help => NO SQL
  const isGreeting =
    /^(hi|hello|hey|hola|buenas|buenos dias|buenas tardes|buenas noches)\b/.test(q) ||
    q.length <= 4;

  const isHelp =
    /(que puedes hacer|que info|que informacion|como me ayudas|ayuda|help|what can you do|what info|capabilities|menu)/.test(q);

  if (isGreeting || isHelp) {
    return { intent: 'help', needsSql: false };
  }

  // 2) analytics (SQL)
  return { intent: classifyIntent(question), needsSql: true };
}

/**
 * ✅ Ahora soporta nombre opcional
 * buildHelpAnswer(lang, { userName })
 */
function buildHelpAnswer(lang = 'en', opts = {}) {
  const userName = (opts?.userName || '').toString().trim();
  const hasName = userName.length >= 2;

  if (lang === 'es') {
    const greet = hasName ? `Hola ${userName}. ` : '';
    return `${greet}Puedo ayudarte con métricas y análisis de casos (confirmed/dropped), rendimiento por submitter/oficina, tendencias por semana/mes/año y links de logs/PDF.

Ejemplos:
• "Confirmados este mes"
• "Dropped últimos 7 días por oficina"
• "Casos por submitter Mariel"
• "Top submitters este mes"
• "Dame el log/pdf de Lalesca"

Tip: si quieres, dime tu nombre: "Me llamo Ana".`;
  }

  const greet = hasName ? `Hi ${userName}. ` : '';
  return `${greet}I can help with case analytics (confirmed/dropped), performance by submitter/office, trends by week/month/year, and log/PDF links.

Examples:
• "Confirmed this month"
• "Dropped last 7 days by office"
• "Cases by submitter Mariel"
• "Top submitters this month"
• "Give me the log/pdf for Lalesca"

Tip: tell me your name: "My name is Ana".`;
}

function wantsExpertAnalysis(q = '') {
  const s = String(q || '').toLowerCase();
  return /(analisis|análisis|insight|recomend|diagnostic|como experto|expert|interpret|que significa|por que|por qué|acciones|siguientes pasos)/i.test(s);
}

module.exports = { classifyIntent, classifyIntentInfo, buildHelpAnswer };
