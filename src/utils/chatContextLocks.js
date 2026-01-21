
/* =====================================================================================
   Chat context locks (person + office/pod/team) + SQL preflight
===================================================================================== */

function norm(s = '') {
  return String(s || '').trim().replace(/\s+/g, ' ');
}

function lc(s = '') {
  return norm(s).toLowerCase();
}

function includesAny(msg, needles) {
  const m = lc(msg);
  return needles.some((n) => m.includes(String(n).toLowerCase()));
}

// Detect user intent to change a locked thing (person/office/pod/team)
function wantsToChange(msg = '', key = '') {
  const m = lc(msg);
  const k = String(key || '').toLowerCase();

  // generic "change" verbs
  const changeWords = [
    'cambia', 'cambiar', 'cambialo', 'cámbialo', 'otra', 'otro', 'distinto', 'diferente',
    'switch', 'change', 'different', 'another',
  ];

  // when key is provided, require key context to reduce false positives
  if (k) {
    const keyWords = {
      person: ['rep', 'representante', 'submitter', 'agent', 'entered by', 'persona', 'usuario'],
      office: ['oficina', 'office'],
      team: ['equipo', 'team'],
      pod: ['pod'],
    };
    const kws = keyWords[k] || [k];
    const hasKey = kws.some((w) => m.includes(w));
    const hasChange = changeWords.some((w) => m.includes(w));

    // Also treat "no es X" as change when key is present in sentence
    const saysNot = /\bno\s+es\b/.test(m) || /\bnot\b/.test(m);

    return (hasKey && hasChange) || (hasKey && saysNot);
  }

  return changeWords.some((w) => m.includes(w));
}

function wantsToClear(msg = '', key = '') {
  const m = lc(msg);
  const k = String(key || '').toLowerCase();
  const clearWords = ['sin', 'quita', 'quitar', 'remueve', 'remover', 'elimina', 'eliminar', 'clear', 'remove', 'without'];

  const keyWords = {
    person: ['rep', 'representante', 'submitter', 'agent', 'entered by', 'persona', 'usuario'],
    office: ['oficina', 'office'],
    team: ['equipo', 'team'],
    pod: ['pod'],
  };

  const kws = keyWords[k] || [k];
  const hasKey = kws.some((w) => m.includes(w));
  const hasClear = clearWords.some((w) => m.includes(w));

  // examples: "sin oficina", "quita team", "remove pod"
  return hasKey && hasClear;
}

function dimKeyFromColumn(column = '') {
  const c = String(column || '').toLowerCase();
  if (c === 'officename') return 'office';
  if (c === 'teamname') return 'team';
  if (c === 'podename' || c === 'podname') return 'pod';
  if (c === 'regionname') return 'region';
  if (c === 'directorname') return 'director';
  return null;
}

function cloneFilters(ctx = {}) {
  const f = (ctx && ctx.filters) || {};
  return {
    person: f.person ? { ...f.person } : null,
    office: f.office ? { ...f.office } : null,
    team: f.team ? { ...f.team } : null,
    pod: f.pod ? { ...f.pod } : null,
    region: f.region ? { ...f.region } : null,
    director: f.director ? { ...f.director } : null,
  };
}

function applyLockedFiltersToSql(sql, injectLikeFilter, filters) {
  let s = String(sql || '');
  if (!filters) return s;

  const dims = [
    ['office', 'OfficeName'],
    ['team', 'TeamName'],
    ['pod', 'PODEName'],
    ['region', 'RegionName'],
    ['director', 'DirectorName'],
  ];

  for (const [k, col] of dims) {
    const lock = filters[k];
    if (lock && lock.locked && lock.value) {
      s = injectLikeFilter(s, col, String(lock.value));
    }
  }

  // person handled elsewhere (submitterName) because you already have special rewrite logic
  return s;
}

function buildSqlFixMessage(uiLang, originalQuestion, badSql, mysqlError) {
  const err = String(mysqlError || '').slice(0, 500);
  const q = String(originalQuestion || '');
  const s = String(badSql || '');

  if (uiLang === 'es') {
    return (
      q +
      "\n\n" +
      "IMPORTANTE: el SQL anterior falló al validar/explicar en MySQL. Corrige SOLO el SQL (misma tabla dmLogReportDashboard, sin JOIN, sin subqueries)." +
      "\n" +
      "Error MySQL: " + err +
      "\n" +
      "SQL que falló:\n" + s
    );
  }

  return (
    q +
    "\n\n" +
    "IMPORTANT: the previous SQL failed MySQL validation/EXPLAIN. Fix ONLY the SQL (same table dmLogReportDashboard, no JOIN, no subqueries)." +
    "\n" +
    "MySQL error: " + err +
    "\n" +
    "Failed SQL:\n" + s
  );
}

module.exports = {
  wantsToChange,
  wantsToClear,
  dimKeyFromColumn,
  cloneFilters,
  applyLockedFiltersToSql,
  buildSqlFixMessage,
  norm,
  lc,
  includesAny,
};
