// src/controllers/chat.controller.js

/* Infra / Guard */
const pool = require("../infra/db.pool");
const { validateAnalyticsSql } = require("../../sqlGuard");
const { stripSubmitterFilters, injectLikeFilterSmart } = require("../utils/dimension");

/* Services */
const { buildSqlFromQuestion } = require("../services/sqlBuilder.service");
const { buildOwnerAnswer } = require("../services/ownerAnswer.service");
const { enforceOnlyFullGroupBy } = require("../services/sqlRules.service");
const { normalizeAnalyticsSql } = require("../services/sqlNormalize.service");
const { buildKpiPackSql } = require("../services/kpiPack.service");
const { classifyIntentInfo, buildHelpAnswer } = require("../services/intent");
const {
  extractUserNameFromMessage,
  setUserName,
  getUserName,
} = require("../services/userProfile.service");
const {
  getPending,
  setPending,
  clearPending,
  getContext,
  setContext,
} = require("../services/conversationState.service");
const { tryResolvePick } = require("../services/pendingResolvers");
const { getUserMemory } = require("../services/aiMemory.service");
const {
  wantsPdfLinks,
  findUserPdfCandidates,
} = require("../services/pdfLinks.service");

const {
  wantsPerformance,
  resolvePerformanceGroupBy,
  buildPerformanceKpiSql,
} = require("../services/performanceKpi.service");

/* Utils */
const { ensureDefaultMonth } = require("../utils/text");
const {
  rewritePersonEqualsToLike,
  extractPersonFilterFromSql,
  extractPersonNameFromMessage,
} = require("../utils/personRewrite");
const { buildMiniChart } = require("../utils/miniChart");
const {
  wantsToChange,
  wantsToClear,
  cloneFilters,
  buildSqlFixMessage,
} = require("../utils/chatContextLocks");

/* ✅ DIMENSIONS */
const { extractDimensionAndValue } = require("../utils/dimensionExtractor");
const { resolveDimension } = require("../utils/dimensionResolver");
const { getDimension, listDimensions } = require("../domain/dimensions/dimensionRegistry");

/* ✅ Helpers */
const {
  makeReqId,
  shouldLogSql,
  logSql,
  tokenizePersonName,
  sanitizeSqlTypos,
  ensurePeriodFilterStable,
  ensureYearMonthGroupBy,
  isGreeting,
  greetingAnswer,
  isFollowUpQuestion,
  injectPersonFromContext,
  mentionsPersonExplicitly,
} = require("../utils/chatRoute.helpers");

/* =========================
   PERF: small in-memory cache + timers
========================= */
const __cache = {
  userMemory: new Map(),
  sqlFromQ: new Map(),
};

function cacheGet(map, key) {
  const hit = map.get(key);
  if (!hit) return null;
  if (hit.exp && hit.exp < Date.now()) {
    map.delete(key);
    return null;
  }
  return hit.v;
}
function cacheSet(map, key, value, ttlMs) {
  map.set(key, { v: value, exp: Date.now() + (ttlMs || 0) });
  if (map.size > 300) {
    const firstKey = map.keys().next().value;
    map.delete(firstKey);
  }
}

function nowMs() {
  return Date.now();
}
function makeTimers(reqId) {
  const t0 = nowMs();
  const marks = [];
  return {
    mark(label) {
      marks.push({ label, ms: nowMs() - t0 });
    },
    done() {
      const total = nowMs() - t0;
      return { reqId, totalMs: total, marks };
    },
  };
}

/* =========================
   Friendly error messages
========================= */
function friendlyError(uiLang, reqId) {
  const base =
    uiLang === "es"
      ? "Ups 😅 no pude completar eso ahora mismo. ¿Puedes intentar de nuevo? Si quieres, dime el nombre completo y el período (por ejemplo: “este mes”)."
      : "Oops 😅 I couldn’t complete that right now. Can you try again? If you want, tell me the full name and the time window (e.g., “this month”).";
  return base + ` (ref: ${reqId})`;
}

/* =========================
   Suggestions (TOP BAR)
   IMPORTANTE: Estos labels deben matchear lo que tu UI manda.
========================= */
function buildSuggestions(message = "", uiLang = "en") {
  return uiLang === "es"
    ? ["Últimos 7 días", "Este mes", "Top reps", "Ver dropped"]
    : ["Last 7 days", "This month", "Top reps", "See dropped"];
}

/* =========================
   KPI row detector (para evitar query extra)
========================= */
function looksLikeKpiPackRow(r) {
  if (!r || typeof r !== "object") return false;
  return (
    "gross_cases" in r ||
    "confirmed_cases" in r ||
    "confirmed_rate" in r ||
    "dropped_cases" in r ||
    "problem_cases" in r
  );
}

/* =========================
   Mini-chart gating: cuándo tiene sentido graficar
   (y evitar chart=null siempre)
========================= */
function hasChartableShape(rows = []) {
  if (!Array.isArray(rows) || rows.length < 2) return false;

  // Busca una columna tipo "label/x/date/y/m/submitter/office"
  const sample = rows[0] || {};
  const keys = Object.keys(sample);

  const hasLabelish =
    keys.some((k) =>
      ["label", "x", "date", "day", "m", "month", "submitter", "office"].includes(
        String(k).toLowerCase()
      )
    ) ||
    keys.some((k) => /date|day|month|submitter|office|label|name/i.test(k));

  // Busca una métrica numérica
  const hasNumeric = keys.some((k) => typeof sample[k] === "number");

  return Boolean(hasLabelish && hasNumeric);
}

function shouldShowChartPayload({ topQuickAction, rows }) {
  // Quick actions: intentan chart siempre (si buildMiniChart puede)
  if (topQuickAction) return true;

  // Normal: solo si rows parece serie/tabla graficable
  return hasChartableShape(rows);
}

/* =========================
   Pretty Cards (UI-ready)
   Backward compatible: seguimos enviando "answer"
========================= */
function buildInsightCards(uiLang, { windowLabel, kpiPack, mode }) {
  const es = uiLang === "es";

  const num = (v) => {
    const n = Number(v || 0);
    if (Number.isNaN(n)) return 0;
    return n;
  };

  const gross = num(kpiPack?.gross_cases);
  const dropped = num(kpiPack?.dropped_cases);
  const droppedRate = num(kpiPack?.dropped_rate);
  const confirmed = num(kpiPack?.confirmed_cases);
  const confirmedRate = num(kpiPack?.confirmed_rate);
  const cv = num(kpiPack?.case_converted_value);

  const cards = [];

  // KPI card
  cards.push({
    type: "kpi",
    icon: "📊",
    title: windowLabel || (es ? "Resumen" : "Summary"),
    lines: [
      es ? `Casos (gross): ${gross}` : `Gross cases: ${gross}`,
      es
        ? `Dropped: ${dropped} (${droppedRate.toFixed(2)}%)`
        : `Dropped: ${dropped} (${droppedRate.toFixed(2)}%)`,
      es ? `Confirmados: ${confirmed} (${confirmedRate.toFixed(2)}%)` : `Confirmed: ${confirmed} (${confirmedRate.toFixed(2)}%)`,
      es ? `Conversion value: ${cv}` : `Conversion value: ${cv}`,
    ],
  });

  // Insight
  if (gross > 0) {
    const insightText =
      droppedRate <= 2
        ? (es
            ? `La tasa de dropped es baja (${droppedRate.toFixed(2)}%).`
            : `Dropped rate is low (${droppedRate.toFixed(2)}%).`)
        : (es
            ? `La tasa de dropped es notable (${droppedRate.toFixed(2)}%).`
            : `Dropped rate is notable (${droppedRate.toFixed(2)}%).`);

    cards.push({
      type: "insight",
      icon: "💡",
      title: es ? "Insight" : "Insight",
      text: insightText,
    });
  }

  // Risk (solo si amerita)
  const risk = droppedRate >= 5;
  if (risk) {
    cards.push({
      type: "risk",
      icon: "🔴",
      title: es ? "Riesgo" : "Risk",
      text: es
        ? "La tasa de dropped está alta; podría indicar un problema operativo o de calidad en intake."
        : "Dropped rate is high; it may signal an operational/quality issue in intake.",
    });
  }

  // Action
  cards.push({
    type: "action",
    icon: "✅",
    title: es ? "Acción sugerida" : "Recommended action",
    text: es
      ? "Revisa los dropped recientes y clasifícalos por causa (falta de contacto, documentos, seguro, ubicación, etc.)."
      : "Audit recent dropped cases and classify root causes (contact, docs, insurance, location, etc.).",
  });

  // Next step
  cards.push({
    type: "next",
    icon: "➡️",
    title: es ? "Siguiente paso" : "Next step",
    text: es
      ? "¿Quieres que lo desglosemos por región, team u oficina?"
      : "Should we break this down by region, team, or office?",
  });

  return cards;
}

/* =========================
   Fallback: nombre en texto (cuando el detector falla en inglés)
========================= */
function fallbackNameFromText(msg = "") {
  const m = String(msg || "").trim();
  const hit =
    m.match(/\bhas\s+([a-z]+)\s+([a-z]+)\b/i) ||
    m.match(/\bfor\s+([a-z]+)\s+([a-z]+)\b/i) ||
    m.match(/\bof\s+([a-z]+)\s+([a-z]+)\b/i);
  if (!hit) return null;

  const full = `${hit[1]} ${hit[2]}`.trim();
  if (full.length < 3) return null;

  const bad = new Set([
    "give","show","get","see","list","logs","cases","case","this","last","month","week","today","yesterday",
    "dame","muestrame","mostrar","ver","lista","casos","este","esta","mes","semana","hoy","ayer",
  ]);
  if (bad.has(full.toLowerCase())) return null;
  return full;
}

/* =========================
   Performance Cards (submitter leaderboard / single rep)
========================= */
function buildPerformanceCards(uiLang, { windowLabel, name, kpi }) {
  const es = uiLang === "es";

  const num = (v) => {
    const n = Number(v || 0);
    return Number.isNaN(n) ? 0 : n;
  };

  const ttd = num(kpi?.ttd);
  const confirmed = num(kpi?.confirmed);
  const confirmationRate = num(kpi?.confirmationRate);
  const dropped = num(kpi?.dropped_cases);
  const droppedRate = num(kpi?.dropped_rate);
  const cv = num(kpi?.convertedValue);

  const who = String(name || "").trim() || (es ? "Este submitter" : "This submitter");

  const cards = [];

  // KPI card (los datos que tú pediste)
  cards.push({
    type: "kpi",
    icon: "📊",
    title: windowLabel || (es ? "Resumen" : "Summary"),
    lines: [
      es ? `${who}: ${ttd} casos (TTD)` : `${who}: ${ttd} cases (TTD)`,
      es
        ? `Confirmados: ${confirmed} (${confirmationRate.toFixed(2)}%)`
        : `Confirmed: ${confirmed} (${confirmationRate.toFixed(2)}%)`,
      es
        ? `Dropped: ${dropped} (${droppedRate.toFixed(2)}%)`
        : `Dropped: ${dropped} (${droppedRate.toFixed(2)}%)`,
      es ? `Conversion value: ${cv}` : `Conversion value: ${cv}`,
    ],
  });

  // Insight simple
  let insightText = "";
  if (ttd === 0) {
    insightText = es
      ? "No hay casos registrados en este período para este submitter."
      : "No cases recorded in this window for this submitter.";
  } else if (droppedRate <= 2) {
    insightText = es
      ? `La tasa de dropped es baja (${droppedRate.toFixed(2)}%).`
      : `Dropped rate is low (${droppedRate.toFixed(2)}%).`;
  } else if (droppedRate >= 5) {
    insightText = es
      ? `La tasa de dropped está alta (${droppedRate.toFixed(2)}%).`
      : `Dropped rate is high (${droppedRate.toFixed(2)}%).`;
  } else {
    insightText = es
      ? `La tasa de dropped es moderada (${droppedRate.toFixed(2)}%).`
      : `Dropped rate is moderate (${droppedRate.toFixed(2)}%).`;
  }

  cards.push({
    type: "insight",
    icon: "💡",
    title: "Insight",
    text: insightText,
  });

  cards.push({
    type: "action",
    icon: "✅",
    title: es ? "Acción sugerida" : "Recommended action",
    text:
      dropped > 0
        ? (es
            ? "Revisa los dropped recientes y clasifícalos por causa (contacto, docs, seguro, etc.)."
            : "Audit recent dropped cases and classify root causes (contact, docs, insurance, etc.).")
        : (es
            ? "Mantén monitoreo; si sube dropped, revisa la causa de inmediato."
            : "Keep monitoring; if dropped rises, investigate root cause quickly."),
  });

  cards.push({
    type: "next",
    icon: "➡️",
    title: es ? "Siguiente paso" : "Next step",
    text: es
      ? "¿Quieres verlo por día, o compararlo vs otros reps este mes?"
      : "Want it by day, or compare vs other reps this month?",
  });

  return cards;
}

/* =========================
   TOP QUICK ACTIONS
   ✅ AHORA reconoce los labels que tu UI manda
========================= */
function isTopQuickAction(msg = "") {
  const m = String(msg || "").trim();

  // UI buttons (según tu screenshot)
  if (/^last\s+7\s+days$/i.test(m)) return true;
  if (/^this\s+month$/i.test(m)) return true;
  if (/^top\s+reps$/i.test(m)) return true;
  if (/^see\s+dropped$/i.test(m)) return true;

  // Mantén compatibilidad con labels viejos
  return (
    /^confirmed\s*\(\s*month\s*\)$/i.test(m) ||
    /^credit\s*\(\s*month\s*\)$/i.test(m) ||
    /^best\s+confirmation\s*\(\s*year\s*\)$/i.test(m) ||
    /^dropped\s+last\s+3\s+months$/i.test(m) ||
    /^summary\s*\(\s*week\s*\)$/i.test(m) ||
    /^dropped\s+today\s*\(\s*office\s*\)$/i.test(m)
  );
}

function clearContextForQuickAction(cid) {
  if (!cid) return;
  const ctxNow = getContext(cid) || {};
  const next = { ...ctxNow };
  const f = { ...(next.filters || {}) };
  for (const d of listDimensions()) f[d.key] = null;
  next.filters = f;
  next.lastPerson = null;
  next.pdfUser = null;
  setContext(cid, next);
}

/**
 * ✅ Quick actions devuelven SERIES (rows >= 2) para que el chart salga.
 * También devuelve un kpiPack derivado cuando aplica.
 */
function buildTopQuickActionSql(actionMsg, uiLang) {
  const m = String(actionMsg || "").trim();

  const monthStart = `DATE_FORMAT(CURDATE(), '%Y-%m-01')`;
  const monthEnd = `DATE_ADD(DATE_FORMAT(CURDATE(), '%Y-%m-01'), INTERVAL 1 MONTH)`;

  const last7Start = `DATE_SUB(CURDATE(), INTERVAL 6 DAY)`; // 7 días incluyendo hoy
  const tomorrow = `DATE_ADD(CURDATE(), INTERVAL 1 DAY)`;

  // ✅ UI: Last 7 days -> serie por día
  if (/^last\s+7\s+days$/i.test(m)) {
    const sql = `
      SELECT
        DATE(dateCameIn) AS day,
        COUNT(*) AS gross_cases,
        SUM(CASE WHEN UPPER(Status) LIKE '%DROP%' THEN 1 ELSE 0 END) AS dropped_cases,
        SUM(CASE WHEN Confirmed=1 THEN 1 ELSE 0 END) AS confirmed_cases,
        ROUND(SUM(COALESCE(convertedValue,0)), 2) AS case_converted_value
      FROM performance_data.dmLogReportDashboard
      WHERE dateCameIn >= ${last7Start} AND dateCameIn < ${tomorrow}
      GROUP BY DATE(dateCameIn)
      ORDER BY day ASC
    `.trim();

    return {
      sql,
      params: [],
      windowLabel: uiLang === "es" ? "Últimos 7 días" : "Last 7 days",
      mode: "series_last7",
    };
  }

  // ✅ UI: This month -> serie por día
  if (/^this\s+month$/i.test(m)) {
    const sql = `
      SELECT
        DATE(dateCameIn) AS day,
        COUNT(*) AS gross_cases,
        SUM(CASE WHEN UPPER(Status) LIKE '%DROP%' THEN 1 ELSE 0 END) AS dropped_cases,
        SUM(CASE WHEN Confirmed=1 THEN 1 ELSE 0 END) AS confirmed_cases,
        ROUND(SUM(COALESCE(convertedValue,0)), 2) AS case_converted_value
      FROM performance_data.dmLogReportDashboard
      WHERE dateCameIn >= ${monthStart} AND dateCameIn < ${monthEnd}
      GROUP BY DATE(dateCameIn)
      ORDER BY day ASC
    `.trim();

    return {
      sql,
      params: [],
      windowLabel: uiLang === "es" ? "Mes en curso" : "This month",
      mode: "series_month_daily",
    };
  }

  // ✅ UI: See dropped -> últimos 3 meses por mes
  if (/^see\s+dropped$/i.test(m)) {
    const sql = `
      SELECT
        YEAR(dateCameIn) AS y,
        MONTH(dateCameIn) AS m,
        COUNT(*) AS gross_cases,
        SUM(CASE WHEN UPPER(Status) LIKE '%DROP%' THEN 1 ELSE 0 END) AS dropped_cases,
        ROUND(100 * SUM(CASE WHEN UPPER(Status) LIKE '%DROP%' THEN 1 ELSE 0 END) / NULLIF(COUNT(*),0), 2) AS dropped_rate
      FROM performance_data.dmLogReportDashboard
      WHERE dateCameIn >= DATE_SUB(DATE_FORMAT(CURDATE(), '%Y-%m-01'), INTERVAL 2 MONTH)
        AND dateCameIn < DATE_ADD(DATE_FORMAT(CURDATE(), '%Y-%m-01'), INTERVAL 1 MONTH)
      GROUP BY YEAR(dateCameIn), MONTH(dateCameIn)
      ORDER BY y DESC, m DESC
      LIMIT 3
    `.trim();

    return {
      sql,
      params: [],
      windowLabel: uiLang === "es" ? "Últimos 3 meses" : "Last 3 months",
      mode: "dropped_3m",
    };
  }

  // ✅ UI: Top reps -> top 10 submitters (serie)
  if (/^top\s+reps$/i.test(m)) {
    const sql = `
      SELECT
        TRIM(submitterName) AS submitter,
        COUNT(*) AS gross_cases,
        SUM(CASE WHEN Confirmed=1 THEN 1 ELSE 0 END) AS confirmed_cases,
        ROUND(100 * SUM(CASE WHEN Confirmed=1 THEN 1 ELSE 0 END) / NULLIF(COUNT(*),0), 2) AS confirmed_rate,
        ROUND(SUM(COALESCE(convertedValue,0)), 2) AS case_converted_value
      FROM performance_data.dmLogReportDashboard
      WHERE dateCameIn >= ${monthStart} AND dateCameIn < ${monthEnd}
        AND TRIM(submitterName) <> ''
      GROUP BY TRIM(submitterName)
      ORDER BY gross_cases DESC, case_converted_value DESC
      LIMIT 10
    `.trim();

    return {
      sql,
      params: [],
      windowLabel: uiLang === "es" ? "Mes en curso (Top reps)" : "This month (Top reps)",
      mode: "top_reps_month",
    };
  }

  // --- compat viejo (tu código original) ---
  if (/^confirmed\s*\(\s*month\s*\)$/i.test(m)) {
    const sql = `
      SELECT
        COUNT(*) AS gross_cases,
        SUM(CASE WHEN Confirmed=1 THEN 1 ELSE 0 END) AS confirmed_cases,
        ROUND(100 * SUM(CASE WHEN Confirmed=1 THEN 1 ELSE 0 END) / NULLIF(COUNT(*),0), 2) AS confirmed_rate,
        ROUND(SUM(COALESCE(convertedValue,0)), 2) AS case_converted_value,
        SUM(CASE WHEN UPPER(Status) LIKE '%DROP%' THEN 1 ELSE 0 END) AS dropped_cases,
        ROUND(100 * SUM(CASE WHEN UPPER(Status) LIKE '%DROP%' THEN 1 ELSE 0 END) / NULLIF(COUNT(*),0), 2) AS dropped_rate,
        SUM(CASE WHEN UPPER(Status) LIKE '%PROBLEM%' THEN 1 ELSE 0 END) AS problem_cases,
        ROUND(100 * SUM(CASE WHEN UPPER(Status) LIKE '%PROBLEM%' THEN 1 ELSE 0 END) / NULLIF(COUNT(*),0), 2) AS problem_rate,
        SUM(CASE WHEN Confirmed=0 AND UPPER(Status) LIKE '%ACTI%' THEN 1 ELSE 0 END) AS active_cases,
        SUM(CASE WHEN Confirmed=0 AND UPPER(Status) LIKE '%REF%' THEN 1 ELSE 0 END) AS referout_cases
      FROM performance_data.dmLogReportDashboard
      WHERE dateCameIn >= ${monthStart} AND dateCameIn < ${monthEnd}
    `.trim();

    return {
      sql,
      params: [],
      windowLabel: uiLang === "es" ? "Mes en curso" : "This month",
      mode: "kpi_pack",
    };
  }

  if (/^summary\s*\(\s*week\s*\)$/i.test(m)) {
    const sql = `
      SELECT
        COUNT(*) AS gross_cases,
        SUM(CASE WHEN Confirmed=1 THEN 1 ELSE 0 END) AS confirmed_cases,
        ROUND(100 * SUM(CASE WHEN Confirmed=1 THEN 1 ELSE 0 END) / NULLIF(COUNT(*),0), 2) AS confirmed_rate,
        ROUND(SUM(COALESCE(convertedValue,0)), 2) AS case_converted_value,
        SUM(CASE WHEN UPPER(Status) LIKE '%DROP%' THEN 1 ELSE 0 END) AS dropped_cases,
        ROUND(100 * SUM(CASE WHEN UPPER(Status) LIKE '%DROP%' THEN 1 ELSE 0 END) / NULLIF(COUNT(*),0), 2) AS dropped_rate,
        SUM(CASE WHEN UPPER(Status) LIKE '%PROBLEM%' THEN 1 ELSE 0 END) AS problem_cases,
        ROUND(100 * SUM(CASE WHEN UPPER(Status) LIKE '%PROBLEM%' THEN 1 ELSE 0 END) / NULLIF(COUNT(*),0), 2) AS problem_rate
      FROM performance_data.dmLogReportDashboard
      WHERE dateCameIn >= DATE_SUB(CURDATE(), INTERVAL 7 DAY) AND dateCameIn < CURDATE()
    `.trim();

    return {
      sql,
      params: [],
      windowLabel: uiLang === "es" ? "Últimos 7 días" : "Last 7 days",
      mode: "kpi_pack",
    };
  }

  if (/^dropped\s+last\s+3\s+months$/i.test(m)) {
    const sql = `
      SELECT
        YEAR(dateCameIn) AS y,
        MONTH(dateCameIn) AS m,
        COUNT(*) AS gross_cases,
        SUM(CASE WHEN UPPER(Status) LIKE '%DROP%' THEN 1 ELSE 0 END) AS dropped_cases,
        ROUND(100 * SUM(CASE WHEN UPPER(Status) LIKE '%DROP%' THEN 1 ELSE 0 END) / NULLIF(COUNT(*),0), 2) AS dropped_rate
      FROM performance_data.dmLogReportDashboard
      WHERE dateCameIn >= DATE_SUB(DATE_FORMAT(CURDATE(), '%Y-%m-01'), INTERVAL 2 MONTH)
        AND dateCameIn < DATE_ADD(DATE_FORMAT(CURDATE(), '%Y-%m-01'), INTERVAL 1 MONTH)
      GROUP BY YEAR(dateCameIn), MONTH(dateCameIn)
      ORDER BY y DESC, m DESC
      LIMIT 3
    `.trim();

    return {
      sql,
      params: [],
      windowLabel: uiLang === "es" ? "Últimos 3 meses" : "Last 3 months",
      mode: "dropped_3m",
    };
  }

  if (/^best\s+confirmation\s*\(\s*year\s*\)$/i.test(m)) {
    const sql = `
      SELECT
        TRIM(submitterName) AS submitter,
        COUNT(*) AS gross_cases,
        SUM(CASE WHEN Confirmed=1 THEN 1 ELSE 0 END) AS confirmed_cases,
        ROUND(100 * SUM(CASE WHEN Confirmed=1 THEN 1 ELSE 0 END) / NULLIF(COUNT(*),0), 2) AS confirmed_rate
      FROM performance_data.dmLogReportDashboard
      WHERE YEAR(dateCameIn) = YEAR(CURDATE())
        AND TRIM(submitterName) <> ''
      GROUP BY TRIM(submitterName)
      HAVING gross_cases >= 10
      ORDER BY confirmed_rate DESC, confirmed_cases DESC, gross_cases DESC
      LIMIT 10
    `.trim();

    return {
      sql,
      params: [],
      windowLabel: uiLang === "es" ? "Año en curso" : "This year",
      mode: "best_confirmation_year",
    };
  }

  if (/^dropped\s+today\s*\(\s*office\s*\)$/i.test(m)) {
    const sql = `
      SELECT
        OfficeName AS office,
        COUNT(*) AS gross_cases,
        SUM(CASE WHEN UPPER(Status) LIKE '%DROP%' THEN 1 ELSE 0 END) AS dropped_cases,
        ROUND(
          100 * SUM(CASE WHEN UPPER(Status) LIKE '%DROP%' THEN 1 ELSE 0 END)
          / NULLIF(COUNT(*),0),
          2
        ) AS dropped_rate
      FROM performance_data.dmLogReportDashboard
      WHERE DATE(dateCameIn) = CURDATE()
      GROUP BY OfficeName
      ORDER BY dropped_cases DESC, gross_cases DESC
    `.trim();

    return {
      sql,
      params: [],
      windowLabel: uiLang === "es" ? "Hoy (por oficina)" : "Today (by office)",
      mode: "dropped_today_office",
    };
  }

  return null;
}

function safeExtractExplicitPerson(msg = "", uiLang = "en") {
  const m = String(msg || "").trim();
  if (!m) return null;
  if (!mentionsPersonExplicitly(m, uiLang)) return null;

  const p = extractPersonNameFromMessage(m);
  if (!p) return null;

  const v = String(p).trim();
  if (!v) return null;

  const bad = new Set([
    "give","show","get","see","list","logs","cases","case","dame","muestrame","mostrar","ver","lista","casos",
    "this","last","month","week","today","yesterday","este","esta","mes","semana","hoy","ayer",
  ]);

  if (bad.has(v.toLowerCase())) return null;
  if (v.length < 3) return null;

  return v;
}

/* =========================
   KPI-only intent
========================= */
function isKpiOnlyQuestion(msg = "") {
  const m = String(msg || "").toLowerCase();

  const asksKpi =
    /(confirmed|confirmados|tasa|rate|dropped|problem|leakage|active|referout|valor\s+de\s+conversi[oó]n|conversion\s+value|kpi)/i.test(
      m
    );

  const asksListOrBreakdown =
    /(logs|lista|list|detalle|show me|dame|por\s+(oficina|team|equipo|pod|region|director|abogado|intake)|by\s+(office|team|pod|region|director|attorney|intake)|top\s+\d+|ranking)/i.test(
      m
    );

  return asksKpi && !asksListOrBreakdown;
}

function setContextMerge(cid, patch = {}) {
  if (!cid) return;
  const current = getContext(cid) || {};
  setContext(cid, { ...current, ...patch });
}

/* =========================
   PDF helpers
========================= */
function buildPdfActions(uiLang, pdfUserName = "") {
  const name = String(pdfUserName || "").trim();
  const suffixEs = name ? ` de ${name}` : "";
  const suffixEn = name ? ` for ${name}` : "";

  return uiLang === "es"
    ? [
        { id: "analyze_perf", label: "Analizar rendimiento", message: `Analiza el rendimiento${suffixEs} (confirmados, dropped, valor de conversión) este mes` },
        { id: "compare_similar", label: "Comparar con similares", message: `Compara${suffixEs} con casos similares este mes` },
        { id: "visual_summary", label: "Resumen visual", message: `Muéstrame un resumen visual del comportamiento reciente${suffixEs}` },
      ]
    : [
        { id: "analyze_perf", label: "Analyze performance", message: `Analyze performance${suffixEn} (confirmed, dropped, conversion value) this month` },
        { id: "compare_similar", label: "Compare to similar", message: `Compare${suffixEn} to similar cases this month` },
        { id: "visual_summary", label: "Visual summary", message: `Show a visual summary of recent behavior${suffixEn}` },
      ];
}

function buildPdfAnswer(uiLang, user, userName) {
  const items = [];
  const logsPdf = user?.logsIndividualFile ? String(user.logsIndividualFile).trim() : "";
  const rosterPdf = user?.rosterIndividualFile ? String(user.rosterIndividualFile).trim() : "";

  if (logsPdf) items.push({ id: "logs", label: uiLang === "es" ? "Log completo (PDF)" : "Full log (PDF)", url: logsPdf });
  if (rosterPdf) items.push({ id: "roster", label: "Roster (PDF)", url: rosterPdf });

  const who = user?.name || user?.nick || user?.email || "user";
  const header =
    uiLang === "es"
      ? `${userName ? `${userName}, ` : ""}Aquí tienes los PDFs de ${who}:`
      : `${userName ? `${userName}, ` : ""}Here are the PDFs for ${who}:`;

  if (!items.length) {
    return {
      answer:
        uiLang === "es"
          ? `Encontré a ${who}, pero no tiene links de PDF configurados.`
          : `I found ${who}, but they don’t have PDF links configured.`,
      pdfLinks: null,
      pdfItems: [],
    };
  }

  const lines =
    uiLang === "es"
      ? [header, "", "• Log completo (PDF)", "• Roster (PDF)"]
      : [header, "", "• Full log (PDF)", "• Roster (PDF)"];

  return {
    answer: lines.join("\n"),
    pdfLinks: { logsPdf: logsPdf || null, rosterPdf: rosterPdf || null, items },
    pdfItems: items,
  };
}

/* =========================
   SQL normalizer (WHERE/AND)
========================= */
function normalizeBrokenWhere(sql) {
  if (!sql) return sql;
  let s = String(sql).trim();

  s = s.replace(/\bFROM\s+([a-zA-Z0-9_.`]+)\s+AND\b/gi, "FROM $1 WHERE");
  s = s.replace(/\bWHERE\s+AND\b/gi, "WHERE");

  const firstWhereIdx = s.search(/\bWHERE\b/i);
  if (firstWhereIdx >= 0) {
    const head = s.slice(0, firstWhereIdx + 5);
    let tail = s.slice(firstWhereIdx + 5);
    tail = tail.replace(/\bWHERE\b/gi, "AND");
    s = head + tail;
  }

  return s.replace(/\s+/g, " ").trim();
}

/* =========================
   SQL filter helpers
========================= */
function stripFiltersForColumn(sql, column) {
  if (!sql) return sql;
  const col = String(column || "").trim();
  if (!col) return sql;

  let out = String(sql);
  const re = new RegExp(
    String.raw`(\s+\bWHERE\b|\s+\bAND\b)\s+[^;]*?\b(?:LOWER\s*\(\s*TRIM\s*\(\s*)?${col}\b[^;]*?\b(LIKE|=)\b[^;]*?(?=\s+\bAND\b|\s+\bGROUP\s+BY\b|\s+\bORDER\s+BY\b|\s+\bLIMIT\b|$)`,
    "gis"
  );

  out = out.replace(re, " ");
  out = out
    .replace(/\bWHERE\s+AND\b/gi, "WHERE")
    .replace(/\bWHERE\s+(GROUP\s+BY|ORDER\s+BY|LIMIT)\b/gi, "$1")
    .replace(/\bWHERE\s*$/i, "")
    .replace(/\s+/g, " ")
    .trim();

  return out;
}

function isHowManyCasesQuestion(msg = "", uiLang = "en") {
  const m = String(msg || "").toLowerCase().trim();
  const looksLikeListOrBreakdown =
    /(logs|list|lista|detalle|details|show me|dame|ver|breakdown|by\s+(office|team|pod|region|attorney|intake)|por\s+(oficina|equipo|pod|regi[oó]n|abogado|intake)|top\s+\d+)/i.test(
      m
    );
  if (looksLikeListOrBreakdown) return false;

  const countSignals = [
    /\bhow\s+many\b/,
    /\bcount\b/,
    /\btotal\b/,
    /\bnumber\s+of\b/,
    /\bcu[aá]ntos?\b/,
    /\bn[uú]mero\s+de\b/,
  ];
  const hasCountSignal = countSignals.some((rx) => rx.test(m));
  const hasCasesWord = /\b(cases|case|casos|caso|leads|lead)\b/i.test(m);

  const patterns = [
    /\bhow\s+many\s+(cases|leads)\b/i,
    /\b(cases|leads)\s+has\b/i,
    /\bcu[aá]ntos?\s+(casos|leads)\b/i,
    /\btotal\s+(cases|casos|leads)\b/i,
    /\bnumber\s+of\s+(cases|leads)\b/i,
  ];
  const matchesPattern = patterns.some((rx) => rx.test(m));

  const hasMonthHint =
    /(january|february|march|april|may|june|july|august|september|october|november|december|enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre)/i.test(
      m
    ) || /\b(20\d{2})\b/.test(m);

  if (hasCountSignal && hasCasesWord) return true;
  if (matchesPattern) return true;
  if (hasMonthHint && (hasCountSignal || hasCasesWord)) return true;

  return false;
}

function injectColumnTokensLike(sql, column, rawValue, opts = {}) {
  const s0 = String(sql || "").trim().replace(/;\s*$/g, "");
  const col = String(column || "").trim();
  const value = String(rawValue || "").trim();
  const exact = Boolean(opts.exact);

  if (!s0 || !col || !value) return { sql: s0, params: [] };

  const tokens = exact
    ? [value]
    : tokenizePersonName(value)
        .filter((t) => !/(accident|accidente|case|caso|lead|cliente|client|paciente)/i.test(t))
        .slice(0, 6);

  if (!tokens.length) return { sql: s0, params: [] };

  const likeConds = tokens
    .map(() => `LOWER(TRIM(${col})) LIKE CONCAT('%', LOWER(TRIM(?)), '%')`)
    .join(" AND ");

  const cutRx = /\b(group\s+by|order\s+by|limit)\b/i;
  const mm = s0.match(cutRx);
  const cutAt = mm ? mm.index : -1;

  const head = cutAt >= 0 ? s0.slice(0, cutAt).trimEnd() : s0;
  const tail = cutAt >= 0 ? s0.slice(cutAt) : "";

  const withWhere = /\bwhere\b/i.test(head)
    ? `${head} AND (${likeConds}) ${tail}`.trim()
    : `${head} WHERE (${likeConds}) ${tail}`.trim();

  return { sql: withWhere, params: tokens };
}

function injectWhere(baseSql, condition, params) {
  const cutRx = /\b(group\s+by|order\s+by|limit)\b/i;
  const mm = baseSql.match(cutRx);
  const cutAt = mm ? mm.index : -1;

  const head = cutAt >= 0 ? baseSql.slice(0, cutAt).trimEnd() : baseSql;
  const tail = cutAt >= 0 ? baseSql.slice(cutAt) : "";

  const withWhere = /\bwhere\b/i.test(head)
    ? `${head} AND ${condition} ${tail}`.trim()
    : `${head} WHERE ${condition} ${tail}`.trim();

  return { sql: withWhere, params };
}

function injectSubmitterTokensLike(sql, personValue, opts = {}) {
  const s0 = String(sql || "").trim().replace(/;\s*$/g, "");
  const name = String(personValue || "").trim();
  if (!s0 || !name) return { sql: s0, params: [] };

  const expr = "LOWER(TRIM(submitterName))";
  const exact = Boolean(opts.exact);

  if (exact) {
    const cond = `${expr} LIKE CONCAT('%', LOWER(TRIM(?)), '%')`;
    return injectWhere(s0, cond, [name]);
  }

  const tokens = tokenizePersonName(name)
    .map((t) => t.toLowerCase().trim())
    .filter((t) => t && t.length >= 2)
    .slice(0, 2);

  if (tokens.length < 2) {
    const cond = `${expr} LIKE CONCAT('%', LOWER(TRIM(?)), '%')`;
    return injectWhere(s0, cond, [name]);
  }

  const [a, b] = tokens;

  const cond =
    `((${expr} LIKE CONCAT('%', LOWER(TRIM(?)), '%') AND ${expr} LIKE CONCAT('%', LOWER(TRIM(?)), '%')) ` +
    `OR (${expr} LIKE CONCAT('%', LOWER(TRIM(?)), '%') AND ${expr} LIKE CONCAT('%', LOWER(TRIM(?)), '%')))`; // invertido

  return injectWhere(s0, cond, [a, b, b, a]);
}

/* =========================
   Candidate finders
========================= */
async function findDimensionCandidates(poolConn, dimKey, rawValue, limit = 8) {
  const def = getDimension(dimKey);
  if (!def?.lookupColumn) return [];

  const col = def.lookupColumn;
  const q = String(rawValue || "").trim();
  if (!q) return [];

  const tokens = tokenizePersonName(q).slice(0, 6);
  const params = tokens.length ? tokens : [q];

  const whereLike =
    params.length === 1
      ? `LOWER(TRIM(${col})) LIKE CONCAT('%', LOWER(TRIM(?)), '%')`
      : params
          .map(() => `LOWER(TRIM(${col})) LIKE CONCAT('%', LOWER(TRIM(?)), '%')`)
          .join(" AND ");

  const sql = `
SELECT TRIM(${col}) AS value, COUNT(*) AS cnt
FROM performance_data.dmLogReportDashboard
WHERE
  dateCameIn >= DATE_SUB(CURDATE(), INTERVAL 180 DAY)
  AND TRIM(${col}) <> ''
  AND (${whereLike})
GROUP BY TRIM(${col})
ORDER BY cnt DESC, value ASC
LIMIT ${Number(limit) || 8}
`.trim();

  const [rows] = await poolConn.query(sql, params);
  return Array.isArray(rows) ? rows : [];
}

async function findPersonCandidates(poolConn, rawPerson, limit = 8) {
  const name = String(rawPerson || "").trim();
  if (!name) return [];

  const parts = tokenizePersonName(name).slice(0, 6);
  if (!parts.length) return [];

  const expr = "LOWER(TRIM(submitterName))";
  const likeConds = parts
    .map(() => `${expr} LIKE CONCAT('%', LOWER(TRIM(?)), '%')`)
    .join(" AND ");

  const sql = `
SELECT
  TRIM(submitterName) AS submitter,
  COUNT(*) AS cnt
FROM performance_data.dmLogReportDashboard
WHERE
  dateCameIn >= DATE_SUB(CURDATE(), INTERVAL 180 DAY)
  AND TRIM(submitterName) <> ''
  AND (${likeConds})
GROUP BY TRIM(submitterName)
ORDER BY cnt DESC, submitter ASC
LIMIT ${Number(limit) || 8}
`.trim();

  const [rows] = await poolConn.query(sql, parts);
  return Array.isArray(rows) ? rows : [];
}

function buildPickPrompt(uiLang, dimKey, rawValue) {
  const def = getDimension(dimKey);
  const label = uiLang === "es" ? def?.labelEs || dimKey : def?.labelEn || dimKey;
  return uiLang === "es"
    ? `Encontré varias coincidencias para ${label} "${rawValue}". ¿Cuál es la correcta?`
    : `I found multiple matches for ${label} "${rawValue}". Which one is correct?`;
}

function looksLikeNewTopic(msg = "", uiLang = "en") {
  const m = String(msg || "").toLowerCase().trim();
  if (/(otra cosa|cambiando de tema|nuevo tema|diferente|ahora|por cierto|adem[aá]s)/i.test(m)) return true;
  if (/(another thing|change topic|new topic|now|by the way|also)/i.test(m)) return true;
  if (/(top\s+reps|ranking|por\s+oficina|by\s+office|por\s+team|by\s+team|por\s+region|by\s+region)/i.test(m)) return true;
  return false;
}

function detectLangFromMessage(msg = "") {
  const m = String(msg || "").toLowerCase();
  if (/(dame|casos|últimos|este mes|semana|por favor|hola|buenas|quiero)/i.test(m)) return "es";
  return "en";
}

function buildSqlPipeline(rawSql, questionForAi, opts = {}) {
  const {
    rewritePersonEquals = false, // solo para retry (o cuando haga falta)
    extraNormalizeBrokenWhere = false, // opcional
  } = opts;

  let s = normalizeAnalyticsSql(rawSql);
  s = enforceOnlyFullGroupBy(s);
  s = ensureYearMonthGroupBy(s);

  if (rewritePersonEquals) {
    s = rewritePersonEqualsToLike(s, questionForAi);
  }

  s = ensurePeriodFilterStable(s, questionForAi);
  s = sanitizeSqlTypos(s);

  if (extraNormalizeBrokenWhere) {
    s = normalizeBrokenWhere(s);
  }

  return s;
}

function normalizeQuickActionMessage(msg = "", uiLang = "en") {
  // ✅ Ya no “renombramos” quick actions; el UI manda strings exactos.
  return String(msg || "").trim();
}

async function postChat(req, res) {
  const reqId = makeReqId();
  const logEnabled = shouldLogSql(req);

  const timers = makeTimers(reqId);
  const debugPerf = req.query?.perf === "1" || req.body?.perf === true;

  const { message, lang, clientId } = req.body || {};
  const cid = String(clientId || "").trim();

  const rawLang = String(lang || "").trim().toLowerCase();
  const uiLang = rawLang.startsWith("es")
    ? "es"
    : rawLang.startsWith("en")
    ? "en"
    : detectLangFromMessage(message);

  const debug = req.query?.debug === "1" || req.body?.debug === true;
  const uid = req.user?.uid || null;

  let userMemory = null;
  if (uid) {
    const memKey = `uid:${uid}`;
    const cached = cacheGet(__cache.userMemory, memKey);
    if (cached) userMemory = cached;
    else {
      const tStart = nowMs();
      userMemory = await getUserMemory(uid);
      cacheSet(__cache.userMemory, memKey, userMemory, 2 * 60 * 1000);
      if (debugPerf) timers.mark(`getUserMemory ${nowMs() - tStart}ms`);
    }
  }

  let effectiveMessage = normalizeQuickActionMessage(String(message || "").trim(), uiLang);

  // ✅ Detecta Quick Action con el texto REAL que manda tu UI
  const topQuickAction = isTopQuickAction(effectiveMessage);

  // ✅ Quick Action => limpiar contexto para que sea global
  if (cid && topQuickAction) clearContextForQuickAction(cid);

  /* =====================================================
     ✅ TOP QUICK ACTIONS (NO IA)
     Devuelve series para chart + cards bonitos
  ===================================================== */
  if (topQuickAction) {
    const qa = buildTopQuickActionSql(effectiveMessage, uiLang);

    if (!qa) {
      return res.json({
        ok: true,
        answer: uiLang === "es" ? "No pude reconocer ese acceso rápido." : "I couldn’t recognize that quick action.",
        cards: [{ type: "info", icon: "ℹ️", text: uiLang === "es" ? "Acción rápida desconocida." : "Unknown quick action." }],
        rowCount: 0,
        aiComment: "quick_action_unknown",
        userName: cid ? getUserName(cid) || null : null,
        chart: null,
        suggestions: buildSuggestions("", uiLang),
      });
    }

    if (logEnabled) logSql(reqId, `quick_action ${qa.mode}`, qa.sql, qa.params);

    let rowsQA = [];
    try {
      const [r] = await pool.query(qa.sql, qa.params);
      rowsQA = Array.isArray(r) ? r : [];
    } catch (e) {
      console.error(`[${reqId}] quick_action query failed:`, e?.message || e);
      return res.json({
        ok: true,
        answer: friendlyError(uiLang, reqId),
        cards: [{ type: "error", icon: "⚠️", text: friendlyError(uiLang, reqId) }],
        rowCount: 0,
        aiComment: "friendly_error_quick_action",
        userName: cid ? getUserName(cid) || null : null,
        chart: null,
        suggestions: buildSuggestions("", uiLang),
        ...(debug ? { debugDetails: String(e?.message || e) } : {}),
      });
    }

    // ✅ kpiPack:
    // - Si la query devuelve KPI pack row, úsalo.
    // - Si devuelve series, derivamos kpiPack sumando.
    let kpiPack = null;
    if (Array.isArray(rowsQA) && rowsQA[0] && looksLikeKpiPackRow(rowsQA[0])) {
      kpiPack = rowsQA[0];
    } else if (Array.isArray(rowsQA) && rowsQA.length) {
      const sum = rowsQA.reduce(
        (acc, r) => {
          acc.gross_cases += Number(r.gross_cases || 0);
          acc.dropped_cases += Number(r.dropped_cases || 0);
          acc.confirmed_cases += Number(r.confirmed_cases || 0);
          acc.case_converted_value += Number(r.case_converted_value || 0);
          return acc;
        },
        { gross_cases: 0, dropped_cases: 0, confirmed_cases: 0, case_converted_value: 0 }
      );
      sum.dropped_rate = sum.gross_cases ? (100 * sum.dropped_cases) / sum.gross_cases : 0;
      sum.confirmed_rate = sum.gross_cases ? (100 * sum.confirmed_cases) / sum.gross_cases : 0;
      kpiPack = sum;
    }

    // ✅ Answer (texto legacy) + Cards (bonito)
    const legacyAnswer = await buildOwnerAnswer(
      `${effectiveMessage} (${qa.windowLabel})`,
      qa.sql,
      rowsQA,
      {
        kpiPack,
        kpiWindow: qa.windowLabel,
        lang: uiLang,
        userName: cid ? getUserName(cid) || null : null,
        mode: "quick_action",
      }
    );

    const cards = buildInsightCards(uiLang, {
      windowLabel: qa.windowLabel,
      kpiPack,
      mode: qa.mode,
    });

    const chartWanted = shouldShowChartPayload({ topQuickAction: true, rows: rowsQA });
    const chart = chartWanted ? buildMiniChart(`${effectiveMessage} (${qa.windowLabel})`, uiLang, { kpiPack, rows: rowsQA }) : null;

    return res.json({
      ok: true,
      answer: legacyAnswer,
      cards,
      rowCount: Array.isArray(rowsQA) ? rowsQA.length : 0,
      aiComment: `quick_action_${qa.mode}`,
      userName: cid ? getUserName(cid) || null : null,
      chart: chart || null,
      suggestions: buildSuggestions("", uiLang),
      executedSql: debug ? qa.sql : undefined,
      ...(debug ? { chartDebug: { chartWanted, rowsLen: rowsQA.length, hasChartableShape: hasChartableShape(rowsQA) } } : {}),
    });
  }

  const ctxAtStart = cid ? getContext(cid) || {} : {};
  const ctxSnapshot = cid ? JSON.parse(JSON.stringify(ctxAtStart)) : null;

  /* =======================================================
     0) PENDING PICK (primero)
  ======================================================= */
  let forcedPick = null;
  let pendingContext = null;

  if (cid) {
    const pending = getPending(cid);
    if (pending) {
      const pick = tryResolvePick(effectiveMessage, pending.options);

      if (!pick) {
        return res.json({
          ok: true,
          answer: pending.prompt,
          rowCount: 0,
          aiComment: "pending_pick",
          userName: getUserName(cid) || null,
          chart: null,
          pick: { type: pending.type, options: pending.options },
          suggestions: null,
        });
      }

      clearPending(cid);
      forcedPick = pick;
      pendingContext = pending;
      effectiveMessage = pending.originalMessage || effectiveMessage;
    }
  }

  try {
    if (!effectiveMessage) {
      return res.json({
        ok: true,
        answer: uiLang === "es" ? "¿Qué te gustaría consultar?" : "What would you like to check?",
        rowCount: 0,
        aiComment: "empty_message",
        userName: cid ? getUserName(cid) || null : null,
        chart: null,
        suggestions: buildSuggestions("", uiLang),
      });
    }

    const suggestionsBase = buildSuggestions(effectiveMessage, uiLang);

    /* ================= USER NAME ================= */
    let userName = null;
    const extracted = extractUserNameFromMessage(effectiveMessage);
    if (cid && extracted) {
      setUserName(cid, extracted);
      userName = extracted;
    } else if (cid) userName = getUserName(cid);

    /* ================= GREETING ================= */
    if (isGreeting(effectiveMessage)) {
      return res.json({
        ok: true,
        answer: greetingAnswer(uiLang, userName),
        rowCount: 0,
        aiComment: "greeting",
        userName: userName || null,
        chart: null,
        suggestions: suggestionsBase,
      });
    }

    /* ================= EARLY RESOLVE PDF PICK ================= */
    if (cid && forcedPick?.value && pendingContext?.type === "pdf_user_pick") {
      const pickedId = String(forcedPick.value);

      const [rows] = await pool.query(
        `
        SELECT id, name, nick, email, logsIndividualFile, rosterIndividualFile
        FROM stg_g_users
        WHERE id = ?
        LIMIT 1
      `.trim(),
        [pickedId]
      );

      const user = Array.isArray(rows) && rows[0] ? rows[0] : null;

      if (!user) {
        return res.json({
          ok: true,
          answer: uiLang === "es" ? "No pude encontrar ese usuario. ¿Probamos otro?" : "I couldn’t find that user. Want to try another one?",
          rowCount: 0,
          aiComment: "pdf_links_not_found_after_pick",
          userName: userName || null,
          chart: null,
          suggestions: suggestionsBase,
        });
      }

      const pickedName = String(user?.name || user?.nick || "").trim();

      const ctxNow = getContext(cid) || {};
      const nextFilters = { ...(ctxNow.filters || {}) };
      if (pickedName) nextFilters.person = { value: pickedName, locked: true, exact: true };

      setContext(cid, {
        ...ctxNow,
        pdfUser: { id: String(user.id), name: pickedName },
        lastPerson: pickedName || ctxNow.lastPerson || null,
        filters: nextFilters,
      });

      const out = buildPdfAnswer(uiLang, user, userName);

      return res.json({
        ok: true,
        answer: out.answer,
        rowCount: 0,
        aiComment: "pdf_links_pick_resolved",
        userName: userName || null,
        chart: null,
        pdfLinks: out.pdfLinks,
        pdfItems: out.pdfItems,
        suggestions: suggestionsBase,
      });
    }

    /* ================= HELP MODE ================= */
    const intentInfo = classifyIntentInfo(effectiveMessage);
    if (intentInfo && intentInfo.needsSql === false) {
      return res.json({
        ok: true,
        answer: buildHelpAnswer(uiLang, { userName }),
        rowCount: 0,
        aiComment: "help_mode",
        userName: userName || null,
        chart: null,
        suggestions: suggestionsBase,
      });
    }

    /* ================= DEFAULT PERIOD HELPERS ================= */
    function hasExplicitPeriod(msg = "") {
      const m = String(msg || "").toLowerCase();
      if (/(hoy|ayer|mañana|esta semana|semana pasada|este mes|mes pasado|últimos?\s+\d+\s+d[ií]as|ultimos?\s+\d+\s+dias)/i.test(m)) return true;
      if (/(today|yesterday|tomorrow|this week|last week|this month|last month|last\s+\d+\s+days)/i.test(m)) return true;
      if (/\bweek\b/i.test(m)) return true;
      if (/\bsemana\b/i.test(m)) return true;
      return false;
    }

    function applyDefaultWindow(msg, uiLang2, mem) {
      if (!mem || hasExplicitPeriod(msg)) return msg;
      const w = mem.defaultWindow || "this_month";
      if (w === "last_7_days") return uiLang2 === "es" ? `${msg} últimos 7 días` : `${msg} last 7 days`;
      if (w === "last_30_days") return uiLang2 === "es" ? `${msg} últimos 30 días` : `${msg} last 30 days`;
      return msg;
    }

    /* =====================================================
       CONTEXT + FILTERS (locks)
    ===================================================== */
    const ctx = cid ? getContext(cid) || {} : {};
    let filters = cloneFilters(ctx);
    const lastPerson = ctx.lastPerson ? String(ctx.lastPerson).trim() : null;

    const explicitPersonNow =
      safeExtractExplicitPerson(effectiveMessage, uiLang) || fallbackNameFromText(effectiveMessage);

    const hasPersonLocked = Boolean(filters?.person?.locked && filters?.person?.value);
    const hasAnyPersonSignal = Boolean(explicitPersonNow || hasPersonLocked || lastPerson);

    if (cid) {
      for (const d of listDimensions()) {
        if (wantsToClear(effectiveMessage, d.key)) filters[d.key] = null;
      }
    }

    const userWantsPersonChange =
      wantsToChange(effectiveMessage, "person") || wantsToClear(effectiveMessage, "person");

    let explicitPersonRaw = null;
    if (cid) {
      explicitPersonRaw =
        safeExtractExplicitPerson(effectiveMessage, uiLang) ||
        fallbackNameFromText(effectiveMessage);
      explicitPersonRaw = explicitPersonRaw ? String(explicitPersonRaw).trim() : null;
    }

    if (cid && userWantsPersonChange) {
      if (filters?.person) filters.person = null;
      setContextMerge(cid, { filters, lastPerson: null, pdfUser: null });
    }

    if (cid && explicitPersonRaw && !userWantsPersonChange) {
      const currentLocked =
        filters?.person?.locked && filters?.person?.value
          ? String(filters.person.value).trim()
          : "";

      const isDifferent =
        !currentLocked || currentLocked.toLowerCase() !== explicitPersonRaw.toLowerCase();

      if (isDifferent) {
        const reps = await findPersonCandidates(pool, explicitPersonRaw, 8);

        if (Array.isArray(reps) && reps.length >= 2) {
          const def = getDimension("person");
          const prompt = buildPickPrompt(uiLang, "person", explicitPersonRaw);

          const options = reps.map((c) => ({
            id: String(c.submitter),
            label: String(c.submitter),
            sub: `${c.cnt} cases`,
            value: String(c.submitter),
          }));

          setPending(cid, {
            type: def?.pickType || "person_pick",
            prompt,
            options,
            dimKey: "person",
            originalMessage: effectiveMessage,
            originalMode: "person_disambiguation",
          });

          return res.json({
            ok: true,
            answer: prompt,
            rowCount: 0,
            aiComment: "person_disambiguation",
            userName: userName || null,
            chart: null,
            pick: { type: def?.pickType || "person_pick", options },
            suggestions: null,
          });
        }

        if (Array.isArray(reps) && reps.length === 1) {
          const chosen = String(reps[0].submitter).trim();
          filters.person = { value: chosen, locked: true, exact: true };

          const ctxNow = getContext(cid) || {};
          setContext(cid, { ...ctxNow, pdfUser: null, lastPerson: chosen, filters });
        } else if (Array.isArray(reps) && reps.length === 0) {
          filters.person = { value: explicitPersonRaw, locked: true, exact: false };

          const ctxNow = getContext(cid) || {};
          setContext(cid, { ...ctxNow, pdfUser: null, lastPerson: explicitPersonRaw, filters });
        }
      }
    }

    /* =====================================================
       ✅ PDF LINKS FAST PATH
    ======================================================= */
    const ctxNow = cid ? getContext(cid) || {} : {};
    const rememberedPdfUserId = ctxNow?.pdfUser?.id ? String(ctxNow.pdfUser.id) : null;

    const msgLooksLikePdfOnly =
      wantsPdfLinks(effectiveMessage) && !extractPersonNameFromMessage(effectiveMessage);

    if (wantsPdfLinks(effectiveMessage)) {
      if (msgLooksLikePdfOnly && rememberedPdfUserId) {
        const [rows] = await pool.query(
          `
            SELECT id, name, nick, email, logsIndividualFile, rosterIndividualFile
            FROM stg_g_users
            WHERE id = ?
            LIMIT 1
          `.trim(),
          [rememberedPdfUserId]
        );

        const user = Array.isArray(rows) && rows[0] ? rows[0] : null;
        if (user) {
          const out = buildPdfAnswer(uiLang, user, userName);
          return res.json({
            ok: true,
            answer: out.answer,
            rowCount: 0,
            aiComment: "pdf_links_from_context",
            userName: userName || null,
            chart: null,
            pdfLinks: out.pdfLinks,
            pdfItems: out.pdfItems,
            suggestions: suggestionsBase,
          });
        }
      }

      const candidates = await findUserPdfCandidates(pool, effectiveMessage, 8);

      if (!Array.isArray(candidates) || candidates.length === 0) {
        return res.json({
          ok: true,
          answer:
            uiLang === "es"
              ? "No encontré a quién le pertenecen esos PDFs. Prueba con nombre y apellido."
              : "I couldn’t find who those PDFs belong to. Try first + last name.",
          rowCount: 0,
          aiComment: "pdf_links_no_candidates",
          userName: userName || null,
          chart: null,
          suggestions: suggestionsBase,
        });
      }

      if (cid && candidates.length >= 2) {
        const prompt = uiLang === "es" ? "¿De cuál usuario quieres el PDF?" : "Which user do you want the PDF for?";
        const options = candidates.map((u) => ({
          id: String(u.id),
          label: String(u.name || u.nick || u.email || u.id),
          sub: u.email ? String(u.email) : "",
          value: String(u.id),
        }));

        setPending(cid, {
          type: "pdf_user_pick",
          prompt,
          options,
          dimKey: "__pdf_user__",
          originalMessage: effectiveMessage,
          originalMode: "pdf_links",
        });

        return res.json({
          ok: true,
          answer: prompt,
          rowCount: 0,
          aiComment: "pdf_links_disambiguation",
          userName: userName || null,
          chart: null,
          pick: { type: "pdf_user_pick", options },
          suggestions: null,
        });
      }

      const user = candidates[0];

      if (cid) {
        const pickedName = String(user?.name || user?.nick || "").trim();
        const nextFilters = { ...(ctxNow.filters || {}) };
        if (pickedName) nextFilters.person = { value: pickedName, locked: true, exact: true };

        setContext(cid, {
          ...ctxNow,
          pdfUser: { id: String(user.id), name: pickedName },
          lastPerson: pickedName || ctxNow.lastPerson || null,
          filters: nextFilters,
        });
      }

      const out = buildPdfAnswer(uiLang, user, userName);

      return res.json({
        ok: true,
        answer: out.answer,
        rowCount: 0,
        aiComment: "pdf_links_single_match",
        user: userName || null,
        chart: null,
        pdfLinks: out.pdfLinks,
        pdfItems: out.pdfItems,
        actions: buildPdfActions(uiLang, user?.name || user?.nick || ""),
        suggestions: suggestionsBase,
      });
    }

    /* =====================================================
       2) Detectar dimensión explícita y DISAMBIG
    ===================================================== */
    const extractedDim = extractDimensionAndValue(effectiveMessage, uiLang);
    const resolvedDim = extractedDim
      ? await resolveDimension(pool, extractedDim, effectiveMessage, uiLang)
      : null;

    /* =====================================================
       3) Follow-up: hereda lastPerson
    ===================================================== */
    if (cid) {
      const lockedPerson = filters?.person?.locked
        ? String(filters.person.value || "").trim()
        : null;
      const carryPerson = lockedPerson || (lastPerson ? String(lastPerson).trim() : null);

      const hasExplicitDimNotPerson = Boolean(resolvedDim?.key && resolvedDim.key !== "person");
      const hasExplicitPersonNow = Boolean(
        safeExtractExplicitPerson(effectiveMessage, uiLang) ||
          fallbackNameFromText(effectiveMessage)
      );

      if (
        carryPerson &&
        !userWantsPersonChange &&
        !hasExplicitPersonNow &&
        !hasExplicitDimNotPerson &&
        !looksLikeNewTopic(effectiveMessage, uiLang) &&
        (isFollowUpQuestion(effectiveMessage, uiLang) || effectiveMessage.trim().length <= 40)
      ) {
        effectiveMessage = injectPersonFromContext(effectiveMessage, uiLang, carryPerson);
      }
    }

    const msgWithUserDefault = applyDefaultWindow(effectiveMessage, uiLang, userMemory);
    const messageWithDefaultPeriod = ensureDefaultMonth(msgWithUserDefault, uiLang);
 function detectPerformanceGroupKey(msg = "", uiLang = "en") {
  const m = String(msg || "").toLowerCase();

  // prioridad por “by / por”
  if (/(by\s+office|por\s+oficina)/i.test(m)) return "office";
  if (/(by\s+pod|por\s+pod)/i.test(m)) return "pod";
  if (/(by\s+region|por\s+regi[oó]n)/i.test(m)) return "region";
  if (/(by\s+team|por\s+equipo|por\s+team)/i.test(m)) return "team";

  // si dice reps/submitters/person
  if (/(top\s+reps|reps|submitter|person|persona|representante)/i.test(m)) return "person";

  return "person";
}

function detectPerformanceWindowExpr(msg = "", uiLang = "en") {
  const m = String(msg || "").toLowerCase();

  // last 7 days / últimos 7 días
  if (/(last\s+7\s+days|últimos?\s+7\s+d[ií]as|ultimos?\s+7\s+dias)/i.test(m)) {
    return {
      fromExpr: `DATE_SUB(CURDATE(), INTERVAL 6 DAY)`,
      toExpr: `DATE_ADD(CURDATE(), INTERVAL 1 DAY)`,
      windowLabel: uiLang === "es" ? "Últimos 7 días" : "Last 7 days",
    };
  }

  // last 30 days
  if (/(last\s+30\s+days|últimos?\s+30\s+d[ií]as|ultimos?\s+30\s+dias)/i.test(m)) {
    return {
      fromExpr: `DATE_SUB(CURDATE(), INTERVAL 29 DAY)`,
      toExpr: `DATE_ADD(CURDATE(), INTERVAL 1 DAY)`,
      windowLabel: uiLang === "es" ? "Últimos 30 días" : "Last 30 days",
    };
  }

  // this week / esta semana (semana ISO lun-dom aproximado)
  if (/(this\s+week|esta\s+semana|semana)/i.test(m)) {
    return {
      fromExpr: `DATE_SUB(CURDATE(), INTERVAL WEEKDAY(CURDATE()) DAY)`,
      toExpr: `DATE_ADD(DATE_SUB(CURDATE(), INTERVAL WEEKDAY(CURDATE()) DAY), INTERVAL 7 DAY)`,
      windowLabel: uiLang === "es" ? "Esta semana" : "This week",
    };
  }

  // default: this month
  return {
    fromExpr: `DATE_FORMAT(CURDATE(), '%Y-%m-01')`,
    toExpr: `DATE_ADD(DATE_FORMAT(CURDATE(), '%Y-%m-01'), INTERVAL 1 MONTH)`,
    windowLabel: uiLang === "es" ? "Mes en curso" : "Month-to-date",
  };
}
// ✅ PERFORMANCE FAST PATH (NO IA)
if (wantsPerformance(messageWithDefaultPeriod)) {
  const groupKey = detectPerformanceGroupKey(messageWithDefaultPeriod, uiLang);
  const groupBy = resolvePerformanceGroupBy(groupKey);

  const win = detectPerformanceWindowExpr(messageWithDefaultPeriod, uiLang);

  // arma filtros simples desde tu contexto (solo valores)
  const perfFilters = {};
  for (const d of listDimensions()) {
    const lock = filters?.[d.key];
    if (lock?.locked && lock?.value) {
      perfFilters[d.key] = String(lock.value);
    }
  }

  const { sql: perfSql, params: perfParams } = buildPerformanceKpiSql({
    groupBy,
    fromExpr: win.fromExpr,
    toExpr: win.toExpr,
    filters: perfFilters,
    limit: 50,
  });

  if (logEnabled) logSql(reqId, "performance_leaderboard", perfSql, perfParams);

  let perfRows = [];
  try {
    const [r] = await pool.query(perfSql, perfParams);
    perfRows = Array.isArray(r) ? r : [];
  } catch (e) {
    console.error(`[${reqId}] performance query failed:`, e?.message || e);
    return res.json({
      ok: true,
      answer: friendlyError(uiLang, reqId),
      rowCount: 0,
      aiComment: "friendly_error_performance",
      userName: userName || null,
      chart: null,
      suggestions: suggestionsBase,
      ...(debug ? { debugDetails: String(e?.message || e) } : {}),
    });
  }

  // ✅ Tomamos la fila principal (cuando hay filtro de persona casi siempre es 1 row)
  const kpi = Array.isArray(perfRows) && perfRows[0] ? perfRows[0] : null;
  const pickedName = kpi?.name || kpi?.submitterName || filters?.person?.value || null;

  // ✅ Cards con tus KPIs: ttd, confirmed, confirmationRate, dropped_cases, dropped_rate, convertedValue
  const cards = buildPerformanceCards(uiLang, {
    windowLabel: win.windowLabel,
    name: pickedName,
    kpi,
  });

  // ✅ Answer legacy (si quieres mantener texto)
  const answer = await buildOwnerAnswer(
    `${messageWithDefaultPeriod} (${win.windowLabel})`,
    perfSql,
    perfRows,
    {
      lang: uiLang,
      userName,
      mode: "performance_leaderboard",
      kpiPack: kpi,          // ✅ importante: pasamos los números
      kpiWindow: win.windowLabel,
    }
  );

  const chartWanted = shouldShowChartPayload({ topQuickAction: false, rows: perfRows });
  const chart = chartWanted
    ? buildMiniChart(`${messageWithDefaultPeriod} (${win.windowLabel})`, uiLang, { kpiPack: kpi, rows: perfRows })
    : null;

  return res.json({
    ok: true,
    answer,
    cards,                 // ✅ esto es lo que te faltaba para que el UI muestre el resumen correcto
    rowCount: perfRows.length,
    aiComment: "performance_leaderboard",
    userName,
    chart: chart || null,
    suggestions: suggestionsBase,
    executedSql: debug ? perfSql : undefined,
  });
}



    /* =====================================================
       KPI-only fast path
    ===================================================== */
    if (hasAnyPersonSignal && isHowManyCasesQuestion(messageWithDefaultPeriod, uiLang)) {
      const { sql: kpiSql, params: kpiParams, windowLabel } = buildKpiPackSql(messageWithDefaultPeriod, {
        lang: uiLang,
        filters,
      });

      if (logEnabled) logSql(reqId, "kpi_only(forced) kpiSql", kpiSql, kpiParams);

      const [kpiRows] = await pool.query(kpiSql, kpiParams);
      const kpiPack = Array.isArray(kpiRows) && kpiRows[0] ? kpiRows[0] : null;

      const answer = await buildOwnerAnswer(messageWithDefaultPeriod, kpiSql, [], {
        kpiPack,
        kpiWindow: windowLabel,
        lang: uiLang,
        userName,
      });

      // KPI-only normalmente no chart (no serie)
      const chart = null;

      const cards = buildInsightCards(uiLang, { windowLabel, kpiPack, mode: "kpi_only_forced_how_many" });

      return res.json({
        ok: true,
        answer,
        cards,
        rowCount: 0,
        aiComment: "kpi_only_forced_how_many",
        userName,
        chart,
        suggestions: buildSuggestions(effectiveMessage, uiLang),
        executedSql: debug ? kpiSql : undefined,
      });
    }

    if (isKpiOnlyQuestion(messageWithDefaultPeriod)) {
      const { sql: kpiSql, params: kpiParams, windowLabel } = buildKpiPackSql(
        messageWithDefaultPeriod,
        { lang: uiLang, filters }
      );

      if (logEnabled) logSql(reqId, "kpi_only kpiSql", kpiSql, kpiParams);

      const [kpiRows] = await pool.query(kpiSql, kpiParams);
      const kpiPack = Array.isArray(kpiRows) && kpiRows[0] ? kpiRows[0] : null;

      const answer = await buildOwnerAnswer(messageWithDefaultPeriod, kpiSql, [], {
        kpiPack,
        kpiWindow: windowLabel,
        lang: uiLang,
        userName,
      });

      const chart = null;
      const cards = buildInsightCards(uiLang, { windowLabel, kpiPack, mode: "kpi_only" });

      return res.json({
        ok: true,
        answer,
        cards,
        rowCount: 0,
        aiComment: "kpi_only",
        userName,
        chart,
        suggestions: buildSuggestions(effectiveMessage, uiLang),
        executedSql: debug ? kpiSql : undefined,
      });
    }

    /* =====================================================
       NORMAL MODE (IA -> SQL)
    ===================================================== */
    let questionForAi = messageWithDefaultPeriod;
    let comment = null;
    let sqlObj = null;

    const sqlKey = `${uiLang}|${questionForAi}`;
    const cachedSqlObj = cacheGet(__cache.sqlFromQ, sqlKey);

    if (cachedSqlObj) {
      sqlObj = cachedSqlObj;
      if (debugPerf) timers.mark("buildSqlFromQuestion cache_hit");
    } else {
      const tStartAi = nowMs();
      sqlObj = await buildSqlFromQuestion(questionForAi, uiLang);
      cacheSet(__cache.sqlFromQ, sqlKey, sqlObj, 3 * 60 * 1000);
      if (debugPerf) timers.mark(`buildSqlFromQuestion ${nowMs() - tStartAi}ms`);
    }

    let { sql } = sqlObj;
    comment = sqlObj.comment || null;

    sql = buildSqlPipeline(sql, questionForAi);


    let safeSql;
    try {
      safeSql = validateAnalyticsSql(sql);
      if (logEnabled) logSql(reqId, "normal_mode safeSql", safeSql);
    } catch (e) {
      if (logEnabled) console.error(`[${reqId}] SQL not allowed:`, e?.message || e);
      return res.json({
        ok: true,
        answer: friendlyError(uiLang, reqId),
        rowCount: 0,
        aiComment: "friendly_error_sql_guard",
        userName: userName || null,
        chart: null,
        suggestions: suggestionsBase,
        ...(debug ? { debugDetails: e.message } : {}),
      });
    }

    let personValueFinal =
      filters.person && filters.person.locked && filters.person.value
        ? String(filters.person.value).trim()
        : null;

    if (!personValueFinal && lastPerson && !userWantsPersonChange) personValueFinal = String(lastPerson).trim();

    function applyLockedFiltersParam(baseSql) {
      let outSql = String(baseSql || "");
      let params = [];

      // Nota: stripSubmitterFilters viene de tu base previa (si no existe, debes tenerlo en utils)
      if (personValueFinal && typeof stripSubmitterFilters === "function") outSql = stripSubmitterFilters(outSql);

      for (const d of listDimensions()) {
        if (d.key === "person") continue;

        const lock = filters?.[d.key];
        if (!lock?.locked || !lock?.value) continue;

        outSql = stripFiltersForColumn(outSql, d.column);
        const inj = injectColumnTokensLike(outSql, d.column, String(lock.value), {
          exact: Boolean(lock.exact),
        });
        outSql = inj.sql;
        params = params.concat(inj.params);
      }

      if (personValueFinal) {
        const inj = injectSubmitterTokensLike(outSql, personValueFinal, {
          exact: Boolean(filters.person?.exact),
        });
        outSql = inj.sql;
        params = params.concat(inj.params);
      }

      return { sql: outSql, params };
    }

    async function runMainQuery(baseSql) {
      let { sql: finalSql, params } = applyLockedFiltersParam(baseSql);
      finalSql = normalizeBrokenWhere(finalSql);

      const [rows] = await pool.query(finalSql, params);
      return { rows, executedSqlFinal: finalSql, execParams: params };
    }

    let rows = [];
    let executedSqlFinal = safeSql;
    let execParams = [];

    try {
      const out = await runMainQuery(safeSql);
      rows = out.rows;
      executedSqlFinal = out.executedSqlFinal;
      execParams = out.execParams;
    } catch (errRun) {
      try {
        const fixMessage = buildSqlFixMessage(uiLang, questionForAi, safeSql, errRun?.message || String(errRun));
        const retryKey = `${uiLang}|${fixMessage}`;

        let retry = cacheGet(__cache.sqlFromQ, retryKey);
        if (!retry) {
          retry = await buildSqlFromQuestion(fixMessage, uiLang);
          cacheSet(__cache.sqlFromQ, retryKey, retry, 3 * 60 * 1000);
        }

      let sql2 = buildSqlPipeline(retry.sql, questionForAi, { rewritePersonEquals: true });


        const safe2 = validateAnalyticsSql(sql2);

        const out2 = await runMainQuery(safe2);
        rows = out2.rows;
        executedSqlFinal = out2.executedSqlFinal;
        execParams = out2.execParams;
        comment = retry.comment || comment;
      } catch (e2) {
        if (logEnabled) {
          console.error(`[${reqId}] main query failed:`, errRun?.message || errRun);
          console.error(`[${reqId}] retry failed:`, e2?.message || e2);
        }
        return res.json({
          ok: true,
          answer: friendlyError(uiLang, reqId),
          rowCount: 0,
          aiComment: "friendly_error_query",
          userName: userName || null,
          chart: null,
          suggestions: suggestionsBase,
          ...(debug ? { debugDetails: String(e2?.message || e2) } : {}),
        });
      }
    }

    // Persist context
    if (cid && personValueFinal) {
      filters.person = { value: personValueFinal, locked: true, exact: Boolean(filters.person?.exact) };
      setContextMerge(cid, { lastPerson: personValueFinal, filters });
    } else if (cid) {
      setContextMerge(cid, { filters });
    }

    if (logEnabled) logSql(reqId, "normal_mode executedSqlFinal", executedSqlFinal, execParams);

    // KPI pack post
    const looksAggregated = /\b(count|sum|avg|min|max)\s*\(|\bgroup\s+by\b/i.test(executedSqlFinal);

    let kpiPack = null;
    let kpiWindow = null;

    if (Array.isArray(rows) && rows[0] && looksLikeKpiPackRow(rows[0])) {
      kpiPack = rows[0];
      kpiWindow = uiLang === "es" ? "Según tu filtro actual" : "Based on current filters";
    } else if (looksAggregated) {
      const kpi = buildKpiPackSql(messageWithDefaultPeriod, { lang: uiLang, filters });
      if (logEnabled) logSql(reqId, "normal_mode kpiSqlFinal", kpi.sql, kpi.params);
      const [kpiRows] = await pool.query(kpi.sql, kpi.params);
      kpiPack = Array.isArray(kpiRows) && kpiRows[0] ? kpiRows[0] : null;
      kpiWindow = kpi.windowLabel;
    }

    const answer = await buildOwnerAnswer(messageWithDefaultPeriod, executedSqlFinal, rows, {
      kpiPack,
      kpiWindow,
      lang: uiLang,
      userName,
    });

   // ✅ Chart gating (NORMAL MODE): usa rows reales
    const chartWanted = shouldShowChartPayload({ topQuickAction: false, rows });
    const chart = chartWanted
      ? buildMiniChart(messageWithDefaultPeriod, uiLang, { kpiPack, rows })
      : null;


    // ✅ Cards bonitos si hay KPI pack
    const cards = kpiPack ? buildInsightCards(uiLang, { windowLabel: kpiWindow, kpiPack, mode: "normal" }) : null;

    return res.json({
      ok: true,
      answer,
      cards,
      rowCount: Array.isArray(rows) ? rows.length : 0,
      aiComment: comment,
      userName,
      chart: chart || null,
      suggestions: suggestionsBase,
      executedSql: debug ? executedSqlFinal : undefined,
      perf: debugPerf ? timers.done() : undefined,
      ...(debug ? { chartDebug: { chartWanted, rowsLen: rows.length, hasChartableShape: hasChartableShape(rows) } } : {}),
    });
  } catch (err) {
    if (cid) {
      clearPending(cid);
      if (ctxSnapshot) setContext(cid, ctxSnapshot);
    }

    console.error(`[${reqId}] Error /api/chat:`, err);

    return res.json({
      ok: true,
      answer: friendlyError(uiLang, reqId),
      rowCount: 0,
      aiComment: "friendly_error_catchall",
      userName: cid ? getUserName(cid) || null : null,
      chart: null,
      suggestions: buildSuggestions(effectiveMessage, uiLang),
      ...(debug ? { debugDetails: String(err?.message || err) } : {}),
    });
  }
}

module.exports = { postChat };
