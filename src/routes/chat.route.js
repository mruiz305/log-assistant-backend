// src/routes/chat.route.js
const express = require("express");
const router = express.Router();
const { requireAuth } = require("../middlewares/requireFirebaseAuth");

/* Infra / Guard */
const pool = require("../infra/db.pool");
const { validateAnalyticsSql } = require("../../sqlGuard");

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

/* Utils */
const { ensureDefaultMonth } = require("../utils/text");
const {
  rewritePersonEqualsToLike,
  extractPersonFilterFromSql,extractPersonNameFromMessage
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
const { getDimension, listDimensions } = require("../utils/dimensionRegistry");

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
   Suggestions
========================= */
function buildSuggestions(message = "", uiLang = "en") {
  return uiLang === "es"
    ? ["Últimos 7 días", "Este mes", "Top reps", "Ver dropped"]
    : ["Last 7 days", "This month", "Top reps", "See dropped"];
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

/* =========================
   SQL normalizer (WHERE/AND)
========================= */
function normalizeBrokenWhere(sql) {
  if (!sql) return sql;
  let s = String(sql).trim();

  // FROM table AND ...  -> FROM table WHERE ...
  s = s.replace(/\bFROM\s+([a-zA-Z0-9_.`]+)\s+AND\b/gi, "FROM $1 WHERE");

  // WHERE AND -> WHERE
  s = s.replace(/\bWHERE\s+AND\b/gi, "WHERE");

  // Si hay múltiples WHERE, deja solo el primero y el resto -> AND
  const firstWhereIdx = s.search(/\bWHERE\b/i);
  if (firstWhereIdx >= 0) {
    const head = s.slice(0, firstWhereIdx + 5); // incluye "WHERE"
    let tail = s.slice(firstWhereIdx + 5);
    tail = tail.replace(/\bWHERE\b/gi, "AND");
    s = head + tail;
  }

  return s.replace(/\s+/g, " ").trim();
}

/* =========================
   SQL filter helpers (parametrizados)
========================= */

// Remueve condiciones WHERE/AND que filtren por una columna específica (LIKE o =)
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

// Remueve filtro “persona” (submitter/submitterName) en cualquier forma
function stripSubmitterFilters(sql) {
  if (!sql) return sql;
  let out = String(sql);

  // Caso EXACTO: TRIM(COALESCE(NULLIF...)) = '...'
  out = out.replace(
    /(\s+\bWHERE\b|\s+\bAND\b)\s*TRIM\s*\(\s*COALESCE\s*\(\s*NULLIF\s*\(\s*submitterName\s*,\s*''\s*\)\s*,\s*submitter\s*\)\s*\)\s*=\s*'[^']*'\s*(?=\s+\bAND\b|\s+\bGROUP\s+BY\b|\s+\bORDER\s+BY\b|\s+\bLIMIT\b|$)/gis,
    " "
  );

  // Caso general: submitterName/submitter/COALESCE con o sin LOWER/TRIM
  const expr = String.raw`
    (?:
      (?:LOWER\s*\(\s*)?
      (?:TRIM\s*\(\s*)?
      (?:
        COALESCE\s*\(\s*NULLIF\s*\(\s*submitterName\s*,\s*''\s*\)\s*,\s*submitter\s*\)
        |submitterName
        |submitter
      )
      (?:\s*\)\s*)?
      (?:\s*\)\s*)?
    )
  `;

  // Caso: LOWER(TRIM(COALESCE(NULLIF(submitterName,''), submitter))) LIKE CONCAT('%', LOWER(TRIM('x')), '%')
out = out.replace(
  /(\s+\bWHERE\b|\s+\bAND\b)\s*LOWER\s*\(\s*TRIM\s*\(\s*COALESCE\s*\(\s*NULLIF\s*\(\s*submitterName\s*,\s*''\s*\)\s*,\s*submitter\s*\)\s*\)\s*\)\s*LIKE\s*CONCAT\s*\(\s*'%'\s*,\s*LOWER\s*\(\s*TRIM\s*\(\s*'[^']*'\s*\)\s*\)\s*,\s*'%'\s*\)\s*(?=\s+\bAND\b|\s+\bGROUP\s+BY\b|\s+\bORDER\s+BY\b|\s+\bLIMIT\b|$)/gis,
  " "
);


  const re = new RegExp(
    String.raw`(\s+\bWHERE\b|\s+\bAND\b)\s*\(?\s*${expr}\s*\)?\s*\b(?:LIKE|=)\b\s*[^;]*?(?=\s+\bAND\b|\s+\bGROUP\s+BY\b|\s+\bORDER\s+BY\b|\s+\bLIMIT\b|$)`,
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

// Inyecta un filtro LIKE parametrizado para una columna (tokens AND o exacto)
function injectColumnTokensLike(sql, column, rawValue, opts = {}) {
  const s0 = String(sql || "").trim().replace(/;\s*$/g, "");
  const col = String(column || "").trim();
  const value = String(rawValue || "").trim();
  const exact = Boolean(opts.exact);

  if (!s0 || !col || !value) return { sql: s0, params: [] };

  const tokens = exact ? [value] : tokenizePersonName(value).slice(0, 6);
  if (!tokens.length) return { sql: s0, params: [] };

  const likeConds = tokens
    .map(() => `LOWER(TRIM(${col})) LIKE CONCAT('%', LOWER(TRIM(?)), '%')`)
    .join(" AND ");

  const cutRx = /\b(group\s+by|order\s+by|limit)\b/i;
  const m = s0.match(cutRx);
  const cutAt = m ? m.index : -1;

  const head = cutAt >= 0 ? s0.slice(0, cutAt).trimEnd() : s0;
  const tail = cutAt >= 0 ? s0.slice(cutAt) : "";

  const withWhere = /\bwhere\b/i.test(head)
    ? `${head} AND (${likeConds}) ${tail}`.trim()
    : `${head} WHERE (${likeConds}) ${tail}`.trim();

  return { sql: withWhere, params: tokens };
}

// ✅ Persona: SIEMPRE submitterName LIKE (regla tuya)
function injectSubmitterTokensLike(sql, personValue, opts = {}) {
  const s0 = String(sql || "").trim().replace(/;\s*$/g, "");
  const name = String(personValue || "").trim();
  const exact = Boolean(opts.exact);

  if (!s0 || !name) return { sql: s0, params: [] };

  const tokens = exact ? [name] : tokenizePersonName(name).slice(0, 6);
  if (!tokens.length) return { sql: s0, params: [] };

  const expr = "LOWER(TRIM(submitterName))";
  const likeConds = tokens
    .map(() => `${expr} LIKE CONCAT('%', LOWER(TRIM(?)), '%')`)
    .join(" AND ");

  const cutRx = /\b(group\s+by|order\s+by|limit)\b/i;
  const m = s0.match(cutRx);
  const cutAt = m ? m.index : -1;

  const head = cutAt >= 0 ? s0.slice(0, cutAt).trimEnd() : s0;
  const tail = cutAt >= 0 ? s0.slice(cutAt) : "";

  const withWhere = /\bwhere\b/i.test(head)
    ? `${head} AND (${likeConds}) ${tail}`.trim()
    : `${head} WHERE (${likeConds}) ${tail}`.trim();

  return { sql: withWhere, params: tokens };
}

/* =========================
   Candidate finders (1 query each, 180d window)
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
          .map(
            () => `LOWER(TRIM(${col})) LIKE CONCAT('%', LOWER(TRIM(?)), '%')`
          )
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

  // candidates por la "display string" (submitterName fallback submitter)
  const expr = "LOWER(TRIM(COALESCE(NULLIF(submitterName,''), submitter)))";
  const likeConds = parts
    .map(() => `${expr} LIKE CONCAT('%', LOWER(TRIM(?)), '%')`)
    .join(" AND ");

  const sql = `
SELECT
  TRIM(COALESCE(NULLIF(submitterName,''), submitter)) AS submitter,
  COUNT(*) AS cnt
FROM performance_data.dmLogReportDashboard
WHERE
  dateCameIn >= DATE_SUB(CURDATE(), INTERVAL 180 DAY)
  AND TRIM(COALESCE(NULLIF(submitterName,''), submitter)) <> ''
  AND (${likeConds})
GROUP BY TRIM(COALESCE(NULLIF(submitterName,''), submitter))
ORDER BY cnt DESC, submitter ASC
LIMIT ${Number(limit) || 8}
`.trim();

  const [rows] = await poolConn.query(sql, parts);
  return Array.isArray(rows) ? rows : [];
}

function buildPickPrompt(uiLang, dimKey, rawValue) {
  const def = getDimension(dimKey);
  const label =
    uiLang === "es" ? def?.labelEs || dimKey : def?.labelEn || dimKey;
  return uiLang === "es"
    ? `Encontré varias coincidencias para ${label} "${rawValue}". ¿Cuál es la correcta?`
    : `I found multiple matches for ${label} "${rawValue}". Which one is correct?`;
}

/* ✅ Pick de rol (cuando el mensaje fue "casos de X" sin rol explícito) */
function buildRolePickPrompt(uiLang, rawValue) {
  return uiLang === "es"
    ? `¿A qué te refieres con "${rawValue}"?`
    : `What do you mean by "${rawValue}"?`;
}

function buildRolePickOptions(uiLang, counts = {}) {
  const es = uiLang === "es";
  const fmt = (n) => `${n} matches`;

  const opts = [];
  if ((counts.person || 0) > 0) {
    opts.push({
      id: "person",
      value: "person",
      label: es ? "Representante (submitter)" : "Representative (submitter)",
      sub: fmt(counts.person),
    });
  }
  if ((counts.intake || 0) > 0) {
    opts.push({
      id: "intake",
      value: "intake",
      label: es ? "Intake (locked down)" : "Intake (locked down)",
      sub: fmt(counts.intake),
    });
  }
  if ((counts.attorney || 0) > 0) {
    opts.push({
      id: "attorney",
      value: "attorney",
      label: es ? "Abogado (attorney)" : "Attorney (lawyer)",
      sub: fmt(counts.attorney),
    });
  }
  return opts;
}

function looksLikeNewTopic(msg = "", uiLang = "en") {
  const m = String(msg || "").toLowerCase().trim();

  if (
    /(otra cosa|cambiando de tema|nuevo tema|diferente|ahora|por cierto|adem[aá]s)/i.test(
      m
    )
  )
    return true;
  if (/(another thing|change topic|new topic|now|by the way|also)/i.test(m))
    return true;

  if (
    /(top\s+reps|ranking|por\s+oficina|by\s+office|por\s+team|by\s+team|por\s+region|by\s+region)/i.test(
      m
    )
  )
    return true;

  return false;
}

/* =========================================================
   ROUTE
========================================================= */

router.post("/chat", requireAuth, async (req, res) => {
  const reqId = makeReqId();
  const logEnabled = shouldLogSql(req);

  const { message, lang, clientId } = req.body || {};
  const cid = String(clientId || "").trim();

const rawLang = String(lang || "").trim().toLowerCase();

function detectLangFromMessage(msg = "") {
  const m = String(msg || "").toLowerCase();
  if (/(dame|casos|últimos|este mes|semana|por favor|hola|buenas|quiero)/i.test(m)) return "es";
  return "en";
}

const uiLang =
  rawLang.startsWith("es") ? "es" :
  rawLang.startsWith("en") ? "en" :
  detectLangFromMessage(message);


  const debug = req.query?.debug === "1" || req.body?.debug === true;

  const uid = req.user?.uid || null;
  const userMemory = uid ? await getUserMemory(uid) : null;

  let effectiveMessage = String(message || "").trim();

  // ✅ Snapshots para rollback en error
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
      return res
        .status(400)
        .json({ error: uiLang === "es" ? "Mensaje vacío." : "Empty message." });
    }

    /* ================= USER NAME ================= */
    let userName = null;
    const extracted = extractUserNameFromMessage(effectiveMessage);
    if (cid && extracted) {
      setUserName(cid, extracted);
      userName = extracted;
    } else if (cid) {
      userName = getUserName(cid);
    }

    /* ================= GREETING ================= */
    if (isGreeting(effectiveMessage)) {
      return res.json({
        ok: true,
        answer: greetingAnswer(uiLang, userName),
        rowCount: 0,
        aiComment: "greeting",
        userName: userName || null,
        chart: null,
        suggestions: buildSuggestions(effectiveMessage, uiLang),
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
        suggestions: buildSuggestions(effectiveMessage, uiLang),
      });
    }

    /* ================= DEFAULT PERIOD ================= */
    function hasExplicitPeriod(msg = "") {
      const m = String(msg || "").toLowerCase();
      if (
        /(hoy|ayer|mañana|esta semana|semana pasada|este mes|mes pasado|últimos?\s+\d+\s+d[ií]as|ultimos?\s+\d+\s+dias)/i.test(
          m
        )
      )
        return true;
      if (
        /(today|yesterday|tomorrow|this week|last week|this month|last month|last\s+\d+\s+days)/i.test(
          m
        )
      )
        return true;
      return false;
    }

    function applyDefaultWindow(msg, uiLang2, mem) {
      if (!mem || hasExplicitPeriod(msg)) return msg;
      const w = mem.defaultWindow || "this_month";
      if (w === "last_7_days")
        return uiLang2 === "es"
          ? `${msg} últimos 7 días`
          : `${msg} last 7 days`;
      if (w === "last_30_days")
        return uiLang2 === "es"
          ? `${msg} últimos 30 días`
          : `${msg} last 30 days`;
      return msg;
    }

    const msgWithUserDefault = applyDefaultWindow(
      effectiveMessage,
      uiLang,
      userMemory
    );
    const messageWithDefaultPeriod = ensureDefaultMonth(
      msgWithUserDefault,
      uiLang
    );

    const suggestionsBase = buildSuggestions(effectiveMessage, uiLang);

    /* =====================================================
       CONTEXT + FILTERS (locks)
    ===================================================== */
    const ctx = cid ? getContext(cid) || {} : {};
    let filters = cloneFilters(ctx);
    const lastPerson = ctx.lastPerson ? String(ctx.lastPerson).trim() : null;

    // Clear intents para TODAS las dimensiones
    if (cid) {
      for (const d of listDimensions()) {
        if (wantsToClear(effectiveMessage, d.key)) filters[d.key] = null;
      }
    }

    const userWantsPersonChange =
      wantsToChange(effectiveMessage, "person") ||
      wantsToClear(effectiveMessage, "person");

    /* =====================================================
       1) Si venimos de un pick
    ===================================================== */
    if (cid && forcedPick?.value && pendingContext?.type === "role_pick") {
      const chosenRole = String(forcedPick.value); // person|intake|attorney
      const rawValue = String(pendingContext.rawValue || "").trim();

      if (chosenRole && rawValue) {
        filters[chosenRole] = { value: rawValue, locked: true, exact: false };
        if (chosenRole === "person") setContext(cid, { lastPerson: rawValue, filters });
        else setContext(cid, { filters });

        // ✅ Si eligió "person", ahora sí hacemos pick de nombres si hay varias coincidencias
        if (chosenRole === "person") {
          const candidates = await findPersonCandidates(pool, rawValue, 8);
          if (Array.isArray(candidates) && candidates.length >= 2) {
            const def = getDimension("person");
            const prompt = buildPickPrompt(uiLang, "person", rawValue);

            const options = candidates.map((c) => ({
              id: String(c.submitter),
              label: String(c.submitter),
              sub: `${c.cnt} cases`,
              value: String(c.submitter),
            }));

            setPending(cid, {
              type: def?.pickType || `person_pick`,
              prompt,
              options,
              dimKey: "person",
              originalMessage: effectiveMessage,
              originalMode: "dim",
            });

            return res.json({
              ok: true,
              answer: prompt,
              rowCount: 0,
              aiComment: "dimension_disambiguation",
              userName,
              chart: null,
              pick: { type: def?.pickType || `person_pick`, options },
              suggestions: null,
            });
          }
        }
      }
    } else if (cid && forcedPick?.value && pendingContext?.dimKey) {
      const k = pendingContext.dimKey;
      filters[k] = { value: String(forcedPick.value), locked: true, exact: true };

      if (k === "person") setContext(cid, { lastPerson: String(forcedPick.value), filters });
      else setContext(cid, { filters });
    }

    /* =====================================================
       2) Detectar dimensión explícita y DISAMBIG
    ===================================================== */
    const extractedDim = extractDimensionAndValue(effectiveMessage, uiLang);
    const resolvedDim = extractedDim
      ? await resolveDimension(pool, extractedDim, effectiveMessage, uiLang)
      : null;

      // ✅ (Integral) Si el usuario pidió "casos/logs de <nombre>" y NO mencionó intake/attorney,
// disambigua/lockea PERSONA por el MENSAJE (sin depender del SQL).
if (cid && !forcedPick) {
  const msgN = String(effectiveMessage || "").toLowerCase();

  const asksList =
    /(dame|give me|show me|logs|lista|list|casos|cases)/i.test(msgN);

  const mentionsOtherRole =
    /(intake|locked down|cerrado por|bloqueado por|attorney|abogado|lawyer)/i.test(msgN);

  // solo cuando parece un request tipo "casos de X"
  const rawName = extractPersonNameFromMessage(effectiveMessage);

  const personAlreadyLocked = Boolean(filters?.person?.locked && filters?.person?.value);

  if (asksList && !mentionsOtherRole && rawName && !personAlreadyLocked && !userWantsPersonChange) {
    const reps = await findPersonCandidates(pool, rawName, 8);

    if (Array.isArray(reps) && reps.length >= 2) {
      const def = getDimension("person");
      const prompt = buildPickPrompt(uiLang, "person", rawName);

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
        originalMode: "message_person_disambiguation",
      });

      return res.json({
        ok: true,
        answer: prompt,
        rowCount: 0,
        aiComment: "message_person_disambiguation",
        userName,
        chart: null,
        pick: { type: def?.pickType || "person_pick", options },
        suggestions: null,
      });
    }

    if (Array.isArray(reps) && reps.length === 1) {
      const chosen = String(reps[0].submitter);
      filters.person = { value: chosen, locked: true, exact: true };
      setContext(cid, { lastPerson: chosen, filters });
    }
  }
}

    // ✅ ROLE DISAMBIG + ✅ PERSON DISAMBIG obligatorio en fallback
    if (
      cid &&
      !forcedPick &&
      extractedDim?.key === "person" &&
     ["fallback", "fallback_cases"].includes(extractedDim?.matchType)

    ) {
      const rawValue = String(extractedDim?.value || "").trim();

      const [repCands, intakeCands, attyCands] = await Promise.all([
        findPersonCandidates(pool, rawValue, 2),
        findDimensionCandidates(pool, "intake", rawValue, 2),
        findDimensionCandidates(pool, "attorney", rawValue, 2),
      ]);

      const counts = {
        person: Array.isArray(repCands) ? repCands.length : 0,
        intake: Array.isArray(intakeCands) ? intakeCands.length : 0,
        attorney: Array.isArray(attyCands) ? attyCands.length : 0,
      };

      const howManyRoles = ["person", "intake", "attorney"].filter(
        (k) => (counts[k] || 0) > 0
      ).length;

      // 1) Si aparece en más de un rol -> preguntamos rol
      if (howManyRoles >= 2) {
        const prompt = buildRolePickPrompt(uiLang, rawValue);
        const options = buildRolePickOptions(uiLang, counts);

        setPending(cid, {
          type: "role_pick",
          prompt,
          options,
          dimKey: "__role__",
          rawValue,
          originalMessage: effectiveMessage,
          originalMode: "role",
        });

        return res.json({
          ok: true,
          answer: prompt,
          rowCount: 0,
          aiComment: "role_disambiguation",
          userName,
          chart: null,
          pick: { type: "role_pick", options },
          suggestions: null,
        });
      }

      // 2) ✅ Si NO hay ambigüedad de rol, pero hay varias reps -> preguntamos cuál (ANTES de ejecutar SQL)
      const reps = await findPersonCandidates(pool, rawValue, 8);

      if (Array.isArray(reps) && reps.length >= 2) {
        const def = getDimension("person");
        const prompt = buildPickPrompt(uiLang, "person", rawValue);

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
          originalMode: "fallback_person_disambiguation",
        });

        return res.json({
          ok: true,
          answer: prompt,
          rowCount: 0,
          aiComment: "fallback_person_disambiguation",
          userName,
          chart: null,
          pick: { type: def?.pickType || "person_pick", options },
          suggestions: null,
        });
      }

      // 3) ✅ Si solo hay 1 rep, la lockeamos exact
      if (Array.isArray(reps) && reps.length === 1) {
        const chosen = String(reps[0].submitter);
        filters.person = { value: chosen, locked: true, exact: true };
        setContext(cid, { lastPerson: chosen, filters });
      }
    }

    // Normal dimension disambiguation
    if (cid && !forcedPick && resolvedDim?.key) {
      const dimKey = resolvedDim.key;
      const rawValue = String(extractedDim?.value || resolvedDim.value || "").trim();

      const candidates =
        dimKey === "person"
          ? await findPersonCandidates(pool, rawValue, 8)
          : await findDimensionCandidates(pool, dimKey, rawValue || resolvedDim.value, 8);

      if (Array.isArray(candidates) && candidates.length >= 2) {
        const def = getDimension(dimKey);
        const prompt = buildPickPrompt(uiLang, dimKey, rawValue);

        const options =
          dimKey === "person"
            ? candidates.map((c) => ({
                id: String(c.submitter),
                label: String(c.submitter),
                sub: `${c.cnt} cases`,
                value: String(c.submitter),
              }))
            : candidates.map((r) => ({
                id: String(r.value),
                label: String(r.value),
                sub: `${r.cnt} cases`,
                value: String(r.value),
              }));

        setPending(cid, {
          type: def?.pickType || `${dimKey}_pick`,
          prompt,
          options,
          dimKey,
          originalMessage: effectiveMessage,
          originalMode: "dim",
        });

        return res.json({
          ok: true,
          answer: prompt,
          rowCount: 0,
          aiComment: "dimension_disambiguation",
          userName,
          chart: null,
          pick: { type: def?.pickType || `${dimKey}_pick`, options },
          suggestions: null,
        });
      }

      if (Array.isArray(candidates) && candidates.length === 1) {
        const chosen =
          dimKey === "person"
            ? String(candidates[0].submitter)
            : String(candidates[0].value);

        filters[dimKey] = { value: chosen, locked: true, exact: true };
        if (dimKey === "person") setContext(cid, { lastPerson: chosen, filters });
        else setContext(cid, { filters });
      } else if (rawValue) {
        filters[dimKey] = {
          value: String(resolvedDim.value || rawValue),
          locked: true,
          exact: false,
        };
        if (dimKey === "person")
          setContext(cid, { lastPerson: String(filters[dimKey].value), filters });
        else setContext(cid, { filters });
      }
    }

    /* =====================================================
       3) Follow-up: hereda lastPerson (con guard de "new topic")
    ===================================================== */
    if (cid) {
      const lockedPerson = filters?.person?.locked
        ? String(filters.person.value || "").trim()
        : null;
      const carryPerson = lockedPerson || (lastPerson ? String(lastPerson).trim() : null);

      const hasExplicitDimNotPerson = Boolean(resolvedDim?.key && resolvedDim.key !== "person");

      if (
        carryPerson &&
        !userWantsPersonChange &&
        !mentionsPersonExplicitly(effectiveMessage) &&
        !hasExplicitDimNotPerson &&
        !looksLikeNewTopic(effectiveMessage, uiLang) &&
        (isFollowUpQuestion(effectiveMessage, uiLang) ||
          effectiveMessage.trim().length <= 40)
      ) {
        effectiveMessage = injectPersonFromContext(
          effectiveMessage,
          uiLang,
          carryPerson
        );
      }
    }

    /* =====================================================
       4) KPI-only fast path (1 query)
    ===================================================== */
    if (isKpiOnlyQuestion(messageWithDefaultPeriod)) {
      const { sql: kpiSql, params: kpiParams, windowLabel } = buildKpiPackSql(
        messageWithDefaultPeriod,
        {
          lang: uiLang,
          filters,
        }
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

      const chart = buildMiniChart(messageWithDefaultPeriod, uiLang, { kpiPack, rows: [] });

      return res.json({
        ok: true,
        answer,
        rowCount: 0,
        aiComment: "kpi_only",
        userName,
        chart,
        suggestions: suggestionsBase,
        executedSql: debug ? kpiSql : undefined,
      });
    }

    /* =====================================================
       NORMAL MODE (IA -> SQL)
    ===================================================== */
    let questionForAi = messageWithDefaultPeriod;

    let { sql, comment } = await buildSqlFromQuestion(questionForAi, uiLang);

    sql = normalizeAnalyticsSql(sql);
    sql = enforceOnlyFullGroupBy(sql);
    sql = ensureYearMonthGroupBy(sql);
    sql = ensurePeriodFilterStable(sql, questionForAi);
    sql = sanitizeSqlTypos(sql);

    let safeSql;
    try {
      safeSql = validateAnalyticsSql(sql);
      if (logEnabled) logSql(reqId, "normal_mode safeSql", safeSql);
    } catch (e) {
      return res.status(400).json({
        error: uiLang === "es" ? "SQL no permitido" : "SQL not allowed",
        details: e.message,
      });
    }

    // Persona final (solo UNA fuente: pick/lock/context)
    let personValueFinal =
      filters.person && filters.person.locked && filters.person.value
        ? String(filters.person.value).trim()
        : null;

    if (!personValueFinal && lastPerson && !userWantsPersonChange) {
      personValueFinal = String(lastPerson).trim();
    }

    /* =====================================================
       ✅ Si la IA metió persona en SQL y NO hay persona lockeada:
       hacemos PICK antes de ejecutar (o lock exact si 1)
    ===================================================== */
    if (cid && !personValueFinal && !forcedPick) {
      const pf = extractPersonFilterFromSql(safeSql);
      if (pf?.value) {
        const rawPerson = String(pf.value || "").trim();
        if (rawPerson) {
          const candidates = await findPersonCandidates(pool, rawPerson, 8);

          if (Array.isArray(candidates) && candidates.length >= 2) {
            const dimKey = "person";
            const def = getDimension(dimKey);
            const prompt = buildPickPrompt(uiLang, dimKey, rawPerson);

            const options = candidates.map((c) => ({
              id: String(c.submitter),
              label: String(c.submitter),
              sub: `${c.cnt} cases associated`,
              value: String(c.submitter),
            }));

            setPending(cid, {
              type: def?.pickType || `${dimKey}_pick`,
              prompt,
              options,
              dimKey,
              originalMessage: effectiveMessage,
              originalMode: "sql_person_disambiguation",
            });

            return res.json({
              ok: true,
              answer: prompt,
              rowCount: 0,
              aiComment: "sql_person_disambiguation",
              userName,
              chart: null,
              pick: { type: def?.pickType || `${dimKey}_pick`, options },
              suggestions: null,
            });
          }

          if (Array.isArray(candidates) && candidates.length === 1) {
            const chosen = String(candidates[0].submitter);
            filters.person = { value: chosen, locked: true, exact: true };
            personValueFinal = chosen;
            setContext(cid, { lastPerson: chosen, filters });
          }
        }
      }

      // ✅ FALLBACK: IA se equivoca y mete el nombre en intakeSpecialist
      if (!personValueFinal) {
        const msgN = String(messageWithDefaultPeriod || "").toLowerCase();
        const mentionsIntake =
          /(intake|intake specialist|locked down|lock down|cerrado por|bloqueado por)/i.test(msgN);

        if (!mentionsIntake) {
          const m = safeSql.match(/intakeSpecialist\s+LIKE\s+'%([^%]+)%'/i);
          if (m && m[1]) {
            const raw = String(m[1]).trim();
            if (raw) {
              filters.person = { value: raw, locked: true, exact: false };
              personValueFinal = raw;
              setContext(cid, { lastPerson: raw, filters });
            }
          }
        }
      }
    }

    /* =====================================================
       Aplicar filtros determinísticos y parametrizados
    ===================================================== */
    function applyLockedFiltersParam(baseSql) {
      let outSql = String(baseSql || "");
      let params = [];

      // 1) Si tenemos persona final, quitamos cualquier filtro previo de persona
      if (personValueFinal) outSql = stripSubmitterFilters(outSql);

      // 2) Si tenemos persona final, eliminamos filtros accidentales en otros roles (si no están lockeados)
      if (personValueFinal) {
        const intakeLocked = Boolean(filters?.intake?.locked);
        const attorneyLocked = Boolean(filters?.attorney?.locked);

        if (!intakeLocked) outSql = stripFiltersForColumn(outSql, "intakeSpecialist");
        if (!attorneyLocked) outSql = stripFiltersForColumn(outSql, "attorney");
      }

      // 3) Inyectar dims lockeadas (excepto person)
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

      // 4) Persona al final (submitterName LIKE)
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
      const fixMessage = buildSqlFixMessage(
        uiLang,
        questionForAi,
        safeSql,
        errRun?.message || String(errRun)
      );
      const retry = await buildSqlFromQuestion(fixMessage, uiLang);

      let sql2 = normalizeAnalyticsSql(retry.sql);
      sql2 = enforceOnlyFullGroupBy(sql2);
      sql2 = ensureYearMonthGroupBy(sql2);
      sql2 = rewritePersonEqualsToLike(sql2, questionForAi);
      sql2 = ensurePeriodFilterStable(sql2, questionForAi);
      sql2 = sanitizeSqlTypos(sql2);

      let safe2;
      try {
        safe2 = validateAnalyticsSql(sql2);
      } catch (e) {
        return res.status(400).json({
          error:
            uiLang === "es"
              ? "La consulta generada tiene un error. Intenta reformular tu pregunta."
              : "The generated query has an error. Please rephrase your question.",
          details: e.message,
        });
      }

      const out2 = await runMainQuery(safe2);
      rows = out2.rows;
      executedSqlFinal = out2.executedSqlFinal;
      execParams = out2.execParams;
      comment = retry.comment || comment;
    }

    // Guarda contexto persona si aplica
    if (cid && personValueFinal) {
      filters.person = {
        value: personValueFinal,
        locked: true,
        exact: Boolean(filters.person?.exact),
      };
      setContext(cid, { lastPerson: personValueFinal, filters });
    } else if (cid) {
      setContext(cid, { filters });
    }

    if (logEnabled)
      logSql(reqId, "normal_mode executedSqlFinal", executedSqlFinal, execParams);

    // KPI Pack: solo si la consulta es agregada
    const looksAggregated =
      /\b(count|sum|avg|min|max)\s*\(|\bgroup\s+by\b/i.test(executedSqlFinal);

    let kpiPack = null;
    let kpiWindow = null;

    if (looksAggregated) {
      const kpi = buildKpiPackSql(messageWithDefaultPeriod, { lang: uiLang, filters });
      if (logEnabled) logSql(reqId, "normal_mode kpiSqlFinal", kpi.sql, kpi.params);

      const [kpiRows] = await pool.query(kpi.sql, kpi.params);
      kpiPack = Array.isArray(kpiRows) && kpiRows[0] ? kpiRows[0] : null;
      kpiWindow = kpi.windowLabel;
    }

    // ✅ Si es LISTA (no agregado), evita que el LLM invente resumen KPI
    const isListMode =
      /\bselect\b[\s\S]*\bidLead\b/i.test(executedSqlFinal) &&
      !/\bgroup\s+by\b/i.test(executedSqlFinal) &&
      !/\bcount\s*\(|\bsum\s*\(/i.test(executedSqlFinal);

    let answer;
    if (isListMode) {
      const n = Array.isArray(rows) ? rows.length : 0;
      answer =
        uiLang === "es"
          ? `Encontré ${n} caso(s) en el período seleccionado.`
          : `I found ${n} case(s) in the selected period.`;
    } else {
      answer = await buildOwnerAnswer(messageWithDefaultPeriod, executedSqlFinal, rows, {
        kpiPack,
        kpiWindow,
        lang: uiLang,
        userName,
      });
    }

    const chart = buildMiniChart(messageWithDefaultPeriod, uiLang, { kpiPack, rows });

    return res.json({
      ok: true,
      answer,
      rowCount: Array.isArray(rows) ? rows.length : 0,
      aiComment: comment,
      userName,
      chart,
      suggestions: suggestionsBase,
      executedSql: debug ? executedSqlFinal : undefined,
    });
  } catch (err) {
    // ✅ No dejar estado "pegado" si hubo error
    if (cid) {
      clearPending(cid);
      if (ctxSnapshot) setContext(cid, ctxSnapshot);
    }

    console.error("Error /api/chat:", err);
    return res.status(500).json({
      error: uiLang === "es" ? "Error interno" : "Internal error",
      details: err.message,
    });
  }
});

module.exports = router;
