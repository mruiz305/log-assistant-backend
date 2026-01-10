function normalizeText(s = '') {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}


/** Detecta si el usuario YA pidió periodo explícito */
function hasExplicitPeriod(message = '', lang = 'es') {
  const q = normalizeText(message);

  // fechas tipo 2026-01-09, 01/09/2026, etc.
  if (/\b\d{4}-\d{2}-\d{2}\b/.test(q)) return true;
  if (/\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/.test(q)) return true;

  // palabras clave típicas (ES/EN)
  const periodWords = [
    'hoy', 'ayer', 'semana', 'semanal', 'ultimos 7', 'últimos 7', '7 dias', '7 días',
    'ultimos', 'últimos', 'dias', 'días', '90 dias', '90 días',
    'mes', 'mensual', 'este mes', 'mes pasado', 'mes anterior',
    'ano', 'año', 'anual', 'este año', 'este ano', 'ytd',
    'year', 'this month', 'last month', 'this year', 'today', 'yesterday',
    'week', 'last 7', 'last seven', 'last 90', 'days', 'month', 'year',
    'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto',
    'septiembre', 'octubre', 'noviembre', 'diciembre',
    'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august',
    'september', 'october', 'november', 'december',
  ];

  return periodWords.some((w) => q.includes(w));
}


function normalizePreset(preset) {
  const p = String(preset || '').trim();
  return p || null;
}

/** Si NO hay periodo, fuerza "este mes/this month" */
function ensureDefaultMonth(message = '', uiLang = 'es') {
  const msg = String(message || '').trim();
  if (!msg) return msg;
  if (hasExplicitPeriod(msg, uiLang)) return msg;
  return uiLang === 'es' ? `${msg} este mes` : `${msg} this month`;
}

module.exports = { normalizePreset, ensureDefaultMonth, normalizeText };
