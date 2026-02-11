// src/application/chat/handlers/normalAi.handler.js
const sqlRepo = require("../../../repos/sql.repo");

/* Guard */
const { validateAnalyticsSql } = require("../../../../sqlGuard");

/* Services */

const { buildOwnerAnswer } = require("../../../services/answers/ownerAnswer.service");
const { buildKpiPackSql } = require("../../../services/kpis/kpiPack.service");
const { buildSqlFromQuestion } = require("../sql/sqlBuilder");


/* Context */
const { getContext, setContext, setPending } = require("../../../domain/context/conversationState");

/* Dimensions */
const { listDimensions, getDimension } = require("../../../domain/dimensions/dimensionRegistry");

/* Cache */
const { __cache, cacheGet, cacheSet } = require("../runtime/cache");

/* Pipeline */
const { buildSqlPipeline } = require("../pipeline/sql.pipeline");
const { applyLockedFiltersParam } = require("../pipeline/filterInjection");

/* Utils */
const { logSql, tokenizePersonName } = require("../../../utils/chatRoute.helpers");
const { friendlyError } = require("../../../utils/errors");
const { buildSqlFixMessage } = require("../../../utils/chatContextLocks");
const { buildMiniChart } = require("../../../utils/miniChart");
const { safeExtractExplicitPerson, fallbackNameFromText } = require("../../../utils/personDetect");

/* UI */
const {
  shouldShowChartPayload,
  looksLikeKpiPackRow,
  buildInsightCards,
} = require("../../../domain/ui/cardsAndChart.builder");

const chatRepo = require("../../../repos/chat.repo");


// Merge superficial seguro para filters (evita perder locks por setContext shallow-merge)
function mergeFiltersFromContext(cid, localFilters) {
  if (!cid) return localFilters || {};
  const ctxNow = getContext(cid) || {};
  return { ...(ctxNow.filters || {}), ...(localFilters || {}) };
}

function persistContextFilters({ cid, filters, lastPerson, pdfUser }) {
  if (!cid) return;
  const nextFilters = mergeFiltersFromContext(cid, filters);

  const payload = { filters: nextFilters };
  if (typeof lastPerson !== "undefined") payload.lastPerson = lastPerson;
  if (typeof pdfUser !== "undefined") payload.pdfUser = pdfUser;

  setContext(cid, payload);
}

function buildPickPrompt(uiLang, dimKey, rawValue) {
  const def = getDimension(dimKey);
  const label = uiLang === "es" ? def?.labelEs || dimKey : def?.labelEn || dimKey;
  return uiLang === "es"
    ? `Encontré varias coincidencias para ${label} "${rawValue}". ¿Cuál es la correcta?`
    : `I found multiple matches for ${label} "${rawValue}". Which one is correct?`;
}

/* =========================================================
   Handler
========================================================= */

async function handleNormalAi({
  reqId,
  timers,
  debugPerf,
  logEnabled,
  debug,
  uiLang,
  cid,
  messageWithDefaultPeriod,
  effectiveMessage,
  filters,
  userWantsPersonChange,
  suggestionsBase,
  userName,
}) {
  // ====== Disambiguación de PERSON (esto estaba en el controller) ======
  if (cid) {
    let explicitPersonRaw =
      safeExtractExplicitPerson(effectiveMessage, uiLang) || fallbackNameFromText(effectiveMessage);

    explicitPersonRaw = explicitPersonRaw ? String(explicitPersonRaw).trim() : null;

    if (explicitPersonRaw && !userWantsPersonChange) {
      const currentLocked =
        filters?.person?.locked && filters?.person?.value
          ? String(filters.person.value).trim()
          : "";

      const isDifferent =
        !currentLocked || currentLocked.toLowerCase() !== explicitPersonRaw.toLowerCase();

      if (isDifferent) {
        const parts = tokenizePersonName(explicitPersonRaw).slice(0, 6);
        const reps = await chatRepo.findPersonCandidates({
          rawPerson: explicitPersonRaw,
          parts,
          limit: 8,
        });


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

          return {
            ok: true,
            answer: prompt,
            rowCount: 0,
            aiComment: "person_disambiguation",
            userName: userName || null,
            chart: null,
            pick: { type: def?.pickType || "person_pick", options },
            suggestions: null,
          };
        }

        if (Array.isArray(reps) && reps.length === 1) {
          const chosen = String(reps[0].submitter).trim();
          filters.person = { value: chosen, locked: true, exact: true };

          // ✅ NO perder otros locks: merge desde ctx
          persistContextFilters({ cid, filters, lastPerson: chosen, pdfUser: null });
        } else if (Array.isArray(reps) && reps.length === 0) {
          filters.person = { value: explicitPersonRaw, locked: true, exact: false };

          // ✅ NO perder otros locks: merge desde ctx
          persistContextFilters({ cid, filters, lastPerson: explicitPersonRaw, pdfUser: null });
        }
      }
    }
  }

  // ====== NORMAL IA -> SQL ======
  const questionForAi = messageWithDefaultPeriod;

  const sqlKey = `${uiLang}|${questionForAi}`;
  let sqlObj = cacheGet(__cache.sqlFromQ, sqlKey);

  if (!sqlObj) {
    const tStartAi = Date.now();
    sqlObj = await buildSqlFromQuestion(questionForAi, uiLang);
    cacheSet(__cache.sqlFromQ, sqlKey, sqlObj, 3 * 60 * 1000);
    if (debugPerf) timers.mark(`buildSqlFromQuestion ${Date.now() - tStartAi}ms`);
  } else {
    if (debugPerf) timers.mark("buildSqlFromQuestion cache_hit");
  }

  let sql = sqlObj.sql;
  let comment = sqlObj.comment || null;

  sql = buildSqlPipeline(sql, questionForAi);

  let safeSql;
  try {
    safeSql = validateAnalyticsSql(sql);
    if (logEnabled) logSql(reqId, "normal_mode safeSql", safeSql);
  } catch (e) {
    return {
      ok: true,
      answer: friendlyError(uiLang, reqId),
      rowCount: 0,
      aiComment: "friendly_error_sql_guard",
      userName: userName || null,
      chart: null,
      suggestions: suggestionsBase,
      ...(debug ? { debugDetails: e.message } : {}),
    };
  }

  // final person lock
  const ctx = cid ? getContext(cid) || {} : {};
  const lastPerson = ctx?.lastPerson ? String(ctx.lastPerson).trim() : null;

  let personValueFinal =
    filters?.person && filters.person.locked && filters.person.value
      ? String(filters.person.value).trim()
      : null;

  if (!personValueFinal && lastPerson && !userWantsPersonChange) {
    personValueFinal = String(lastPerson).trim();
  }

  async function runMainQuery(baseSql) {
    const out = applyLockedFiltersParam({
      baseSql,
      filters,
      personValueFinal,
      listDimensions,
    });

    const finalSql = out.sql;
    const params = out.params;

    const rows = await sqlRepo.query(finalSql, params);
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
      const fixMessage = buildSqlFixMessage(
        uiLang,
        questionForAi,
        safeSql,
        errRun?.message || String(errRun)
      );
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
      return {
        ok: true,
        answer: friendlyError(uiLang, reqId),
        rowCount: 0,
        aiComment: "friendly_error_query",
        userName: userName || null,
        chart: null,
        suggestions: suggestionsBase,
        ...(debug ? { debugDetails: String(e2?.message || e2) } : {}),
      };
    }
  }

  // Persist context
  if (cid && personValueFinal) {
    filters.person = {
      value: personValueFinal,
      locked: true,
      exact: Boolean(filters?.person?.exact),
    };

    // ✅ NO perder otros locks: merge desde ctx
    persistContextFilters({ cid, filters, lastPerson: personValueFinal, pdfUser: null });
  } else if (cid) {
    // ✅ NO perder otros locks: merge desde ctx
    persistContextFilters({ cid, filters });
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
    const kpiRows = await sqlRepo.query(kpi.sql, kpi.params);
    kpiPack = Array.isArray(kpiRows) && kpiRows[0] ? kpiRows[0] : null;
    kpiWindow = kpi.windowLabel;
  }

  const answer = await buildOwnerAnswer(messageWithDefaultPeriod, executedSqlFinal, rows, {
    kpiPack,
    kpiWindow,
    lang: uiLang,
    userName,
  });

  const chartWanted = shouldShowChartPayload({ topQuickAction: false, rows });
  const chart = chartWanted
    ? buildMiniChart(messageWithDefaultPeriod, uiLang, { kpiPack, rows })
    : null;

  const cards = kpiPack
    ? buildInsightCards(uiLang, { windowLabel: kpiWindow, kpiPack, mode: "normal" })
    : null;

  return {
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
    ...(debug ? { chartDebug: { chartWanted, rowsLen: rows.length } } : {}),
  };
}

module.exports = { handleNormalAi };
