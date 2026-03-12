/* =====================================================================================
   Chat context locks (person + office/pod/team) + SQL preflight
===================================================================================== */
const { listDimensions } = require("../domain/dimensions/dimensionRegistry");

function norm(s = "") {
  return String(s || "").trim().replace(/\s+/g, " ");
}

function lc(s = "") {
  return norm(s).toLowerCase();
}

function includesAny(msg, needles) {
  const m = lc(msg);
  return needles.some((n) => m.includes(String(n).toLowerCase()));
}

// Detect user intent to change a locked thing (person/office/pod/team)
function wantsToChange(msg = "", key = "") {
  const m = lc(msg);
  const k = String(key || "").toLowerCase();

  const changeWords = [
    "cambia",
    "cambiar",
    "cambialo",
    "cámbialo",
    "otra",
    "otro",
    "distinto",
    "diferente",
    "switch",
    "change",
    "different",
    "another",
  ];

  if (k) {
    const keyWords = {
      person: ["rep", "representante", "submitter", "agent", "entered by", "persona", "usuario"],
      office: ["oficina", "office"],
      team: ["equipo", "team"],
      pod: ["pod"],
    };

    const kws = keyWords[k] || [k];
    const hasKey = kws.some((w) => m.includes(w));
    const hasChange = changeWords.some((w) => m.includes(w));
    const saysNot = /\bno\s+es\b/.test(m) || /\bnot\b/.test(m);

    return (hasKey && hasChange) || (hasKey && saysNot);
  }

  return changeWords.some((w) => m.includes(w));
}

function wantsToClear(msg = "", key = "") {
  const m = lc(msg);
  const k = String(key || "").toLowerCase();

  const clearWords = [
    "sin",
    "quita",
    "quitar",
    "remueve",
    "remover",
    "elimina",
    "eliminar",
    "clear",
    "remove",
    "without",
  ];

  const keyWords = {
    person: ["rep", "representante", "submitter", "agent", "entered by", "persona", "usuario"],
    office: ["oficina", "office"],
    team: ["equipo", "team"],
    pod: ["pod"],
  };

  const kws = keyWords[k] || [k];
  const hasKey = kws.some((w) => m.includes(w));
  const hasClear = clearWords.some((w) => m.includes(w));

  return hasKey && hasClear;
}

function dimKeyFromColumn(column = "") {
  const c = String(column || "").toLowerCase();
  if (c === "officename") return "office";
  if (c === "teamname") return "team";
  if (c === "podename" || c === "podname") return "pod";
  if (c === "regionname") return "region";
  if (c === "directorname") return "director";
  return null;
}

/** Mapeo focus type -> dimension key (para merge) */
const FOCUS_TO_DIM_KEY = {
  submitter: "person",
  office: "office",
  pod: "pod",
  team: "team",
  region: "region",
  director: "director",
  intake: "intake",
  attorney: "attorney",
};

/** Dimensiones que son "scope" (al cambiar scope, se limpian las demás) */
const SCOPE_DIM_KEYS = new Set(["person", "office", "pod", "team", "region", "director", "intake", "attorney"]);

/**
 * Merge focus (scope wizard) en filters para que se aplique el filtro correspondiente.
 * Cuando scopeMode=focus, SOLO se usa el filtro del focus actual (se limpian los de scope previo).
 * Si focus.value es null (usuario eligió tipo pero aún no el valor), limpia scope previo para evitar office cuando eligió attorney.
 */
function mergeFocusIntoFilters(filters = {}, ctx = {}) {
  if (ctx.scopeMode !== "focus" || !ctx.focus?.type) {
    return filters;
  }
  const dimKey = FOCUS_TO_DIM_KEY[ctx.focus.type] || ctx.focus.type;
  if (!dimKey) return filters;

  const next = { ...filters };
  for (const k of SCOPE_DIM_KEYS) {
    if (k === dimKey && ctx.focus?.value) {
      next[k] = { value: String(ctx.focus.value).trim(), locked: true, exact: true };
    } else {
      delete next[k];
    }
  }
  return next;
}

/**
 * ✅ Clona filtros dinámicamente desde el registry
 * - Evita perder locks cuando agregas nuevas dimensiones
 * - Copia shallow del lock (value/locked/exact/etc)
 */
function cloneFilters(ctx = {}) {
  const f = (ctx && ctx.filters) || {};
  const out = {};

  for (const d of listDimensions()) {
    out[d.key] = f[d.key] ? { ...f[d.key] } : null;
  }

  // por si "person" no estuviera en listDimensions() en algún momento:
  if (!Object.prototype.hasOwnProperty.call(out, "person")) {
    out.person = f.person ? { ...f.person } : null;
  }

  return out;
}

function applyLockedFiltersToSql(sql, injectLikeFilterSmart, filters) {
  let s = String(sql || "");
  if (!filters) return s;

  // todas las dims del registry menos person
  const dims = listDimensions().filter((d) => d.key !== "person");

  for (const d of dims) {
    const lock = filters[d.key];
    if (lock?.locked && lock?.value) {
      s = injectLikeFilterSmart(s, d.column, String(lock.value));
    }
  }

  return s;
}

function buildSqlFixMessage(uiLang, originalQuestion, badSql, mysqlError) {
  const err = String(mysqlError || "").slice(0, 500);
  const q = String(originalQuestion || "");
  const s = String(badSql || "");

  if (uiLang === "es") {
    return (
      q +
      "\n\n" +
      "IMPORTANTE: el SQL anterior falló al validar/explicar en MySQL. Corrige SOLO el SQL (misma tabla dmLogReportDashboard, sin JOIN, sin subqueries)." +
      "\n" +
      "Error MySQL: " +
      err +
      "\n" +
      "SQL que falló:\n" +
      s
    );
  }

  return (
    q +
    "\n\n" +
    "IMPORTANT: the previous SQL failed MySQL validation/EXPLAIN. Fix ONLY the SQL (same table dmLogReportDashboard, no JOIN, no subqueries)." +
    "\n" +
    "MySQL error: " +
    err +
    "\n" +
    "Failed SQL:\n" +
    s
  );
}

/** Mapeo dimKey -> focusType (para pick_dimension_candidate) */
const DIM_KEY_TO_FOCUS_TYPE = Object.fromEntries(
  Object.entries(FOCUS_TO_DIM_KEY).map(([ft, dk]) => [dk, ft])
);

module.exports = {
  wantsToChange,
  wantsToClear,
  dimKeyFromColumn,
  cloneFilters,
  mergeFocusIntoFilters,
  applyLockedFiltersToSql,
  buildSqlFixMessage,
  SCOPE_DIM_KEYS,
  FOCUS_TO_DIM_KEY,
  DIM_KEY_TO_FOCUS_TYPE,
  norm,
  lc,
  includesAny,
};
