// src/application/chat/chat.orchestrator.js

/* Infra */
const sqlRepo = require("../../repos/sql.repo");

/* Cache */
const { cacheGet, cacheSet, __cache } = require("./runtime/cache");

/* Services */
const { getUserMemory } = require("./runtime/aiMemory");
const { classifyIntentInfo, buildHelpAnswer } = require("../../domain/intent/intent");
const {
  extractUserNameFromMessage,
  setUserName,
  getUserName,
} = require("../../domain/context/userProfile");
const {
  getPending,
  clearPending,
  getContext,
  setContext,
} = require("../../domain/context/conversationState");
const { tryResolvePick } = require("../../services/pendingResolvers");

/* UI suggestions */
const { buildSuggestions } = require("../../domain/ui/suggestions.builder");

/* Utils */
const { greetingAnswer, isGreeting } = require("../../utils/greeting");
const { normalizeQuickActionMessage } = require("../../utils/quickActions");
const { looksLikeNewTopic } = require("../../utils/topic");
const { friendlyError } = require("../../utils/errors");
const {
  isFollowUpQuestion,
  injectPersonFromContext,
} = require("../../utils/chatRoute.helpers");

const {
  safeExtractExplicitPerson,
  fallbackNameFromText,
} = require("../../utils/personDetect");

/* ✅ KPI detection (para NO inyectar persona en preguntas KPI/how-many) */
const { isKpiOnlyQuestion, isHowManyCasesQuestion } = require("../../utils/kpiOnly");

/* Context locks */
const {
  wantsToChange,
  wantsToClear,
  cloneFilters,
} = require("../../utils/chatContextLocks");

/* Period helpers */
const { ensureDefaultMonth } = require("../../utils/text");
const { applyDefaultWindowToMessage } = require("../../utils/defaultWindow");

/* Handlers */
const { handleQuickActions } = require("./handlers/quickActions.handler");
const { handlePdfLinks } = require("./handlers/pdfLinks.handler");
const { handlePerformance } = require("./handlers/performance.handler");
const { handleKpiOnly } = require("./handlers/kpiOnly.handler");
const { handleNormalAi } = require("./handlers/normalAi.handler");

/* Dimensions */
const { extractDimensionAndValue } = require("../../domain/dimensions/dimensionExtractor");
const { resolveDimension } = require("../../domain/dimensions/dimensionResolver");
const { listDimensions } = require("../../domain/dimensions/dimensionRegistry");

/**
 * Orchestrator principal del chat.
 */
async function chatOrchestratorHandle({
  req,
  reqId,
  timers,
  debugPerf,
  debug,
  logEnabled,
  uid,
  cid,
  uiLang,
  message,
}) {
  // ✅ user memory (cache)
  let userMemory = null;
  if (uid) {
    const memKey = `uid:${uid}`;
    const cached = cacheGet(__cache.userMemory, memKey);
    if (cached) userMemory = cached;
    else {
      const tStart = Date.now();
      userMemory = await getUserMemory(uid);
      cacheSet(__cache.userMemory, memKey, userMemory, 2 * 60 * 1000);
      if (debugPerf) timers.mark(`getUserMemory ${Date.now() - tStart}ms`);
    }
  }

  let effectiveMessage = normalizeQuickActionMessage(message, uiLang);

  // ✅ suggestions base
  const suggestionsBase = buildSuggestions(effectiveMessage, uiLang);

  // ✅ QuickActions (NO IA)
  {
    const out = await handleQuickActions({
      reqId,
      logEnabled,
      debug,
      uiLang,
      cid,
      effectiveMessage,
      timers,
    });
    if (out) return out;
  }

 
  // snapshot context (para rollback)
  const ctxAtStart = cid ? getContext(cid) || {} : {};
  const ctxSnapshot = cid ? JSON.parse(JSON.stringify(ctxAtStart)) : null;

  /* =====================================================
     0) Pending pick primero
  ===================================================== */
  let forcedPick = null;
  let pendingContext = null;

  // ✅ bandera para NO re-resolver person por dimensionResolver en este request
  let skipPersonDimensionResolutionThisTurn = false;

  if (cid) {
    const pending = getPending(cid);
    if (pending) {
      const pick = tryResolvePick(effectiveMessage, pending.options);

      if (!pick) {
        return {
          ok: true,
          answer: pending.prompt,
          rowCount: 0,
          aiComment: "pending_pick",
          userName: getUserName(cid) || null,
          chart: null,
          pick: { type: pending.type, options: pending.options },
          suggestions: null,
        };
      }

      clearPending(cid);
      forcedPick = pick;
      pendingContext = pending;
      effectiveMessage = pending.originalMessage || effectiveMessage;

      // ✅ APLICAR pick inmediato si es person, y bloquear EXACT en contexto
      if (pendingContext?.dimKey === "person") {
        const chosen = String(pick.value || pick.id || "").trim();
        if (chosen) {
          const ctxNow = getContext(cid) || {};
          const nextFilters = { ...(ctxNow.filters || {}) };

          nextFilters.person = { value: chosen, locked: true, exact: true };

          setContext(cid, { filters: nextFilters, lastPerson: chosen });
          skipPersonDimensionResolutionThisTurn = true;

          if (logEnabled) {
            console.log(
              `[${reqId}] [orchestrator] applied pending person pick="${chosen}" exact=true`
            );
          }
        }
      }
    }
  }

  try {
    if (!effectiveMessage) {
      return {
        ok: true,
        answer: uiLang === "es" ? "¿Qué te gustaría consultar?" : "What would you like to check?",
        rowCount: 0,
        aiComment: "empty_message",
        userName: cid ? getUserName(cid) || null : null,
        chart: null,
        suggestions: suggestionsBase,
      };
    }

    /* ================= USER NAME ================= */
    let userName = null;
    const extracted = extractUserNameFromMessage(effectiveMessage);
    if (cid && extracted) {
      setUserName(cid, extracted);
      userName = extracted;
    } else if (cid) userName = getUserName(cid);

    /* ================= GREETING ================= */
    if (isGreeting(effectiveMessage)) {
      return {
        ok: true,
        answer: greetingAnswer(uiLang, userName),
        rowCount: 0,
        aiComment: "greeting",
        userName: userName || null,
        chart: null,
        suggestions: suggestionsBase,
      };
    }

    /* ================= EARLY RESOLVE PDF PICK ================= */
    {
      const out = await handlePdfLinks({
        reqId,
        logEnabled,
        debug,
        uiLang,
        cid,
        effectiveMessage,
        forcedPick,
        pendingContext,
        suggestionsBase,
        userName,
      });
      if (out) return out;
    }

    /* ================= HELP MODE ================= */
    const intentInfo = classifyIntentInfo(effectiveMessage);
    if (intentInfo && intentInfo.needsSql === false) {
      return {
        ok: true,
        answer: buildHelpAnswer(uiLang, { userName }),
        rowCount: 0,
        aiComment: "help_mode",
        userName: userName || null,
        chart: null,
        suggestions: suggestionsBase,
      };
    }

    /* =====================================================
       CONTEXT + FILTERS (locks)
    ===================================================== */
    const ctx = cid ? getContext(cid) || {} : {};
    let filters = cloneFilters(ctx);
    const lastPerson = ctx.lastPerson ? String(ctx.lastPerson).trim() : null;

    // señales de persona (directas)
    const explicitPersonNow =
      safeExtractExplicitPerson(effectiveMessage, uiLang) ||
      fallbackNameFromText(effectiveMessage);

    const hasPersonLocked = Boolean(filters?.person?.locked && filters?.person?.value);

    // clear dimension locks si usuario pidió "clear"
    if (cid) {
      for (const d of listDimensions()) {
        if (wantsToClear(effectiveMessage, d.key)) filters[d.key] = null;
      }
    }

    const userWantsPersonChange =
      wantsToChange(effectiveMessage, "person") || wantsToClear(effectiveMessage, "person");

    // Si el usuario pidió cambiar/limpiar person => resetea
    if (cid && userWantsPersonChange) {
      const ctxNow = getContext(cid) || {};
      const nextFilters = { ...(ctxNow.filters || {}) };
      nextFilters.person = null;

      setContext(cid, { filters: nextFilters, lastPerson: null, pdfUser: null });
      filters = nextFilters;
    }

    /* =====================================================
       2) Dimension extraction/resolution (si aplica)
    ===================================================== */
    const extractedDim = extractDimensionAndValue(effectiveMessage, uiLang);

    // ✅ detectamos candidato de person SOLO por extractor (sin resolver)
    const extractedPersonCandidate =
      extractedDim?.key === "person" && extractedDim?.value
        ? String(extractedDim.value).trim()
        : null;

    // ✅ si venimos de pick de person, NO permitimos que la capa resolver re-toque person
    const shouldResolveDim =
      extractedDim &&
      !(skipPersonDimensionResolutionThisTurn && extractedDim.key === "person");

    const resolvedDim = shouldResolveDim
      ? await resolveDimension(sqlRepo, extractedDim, effectiveMessage, uiLang)
      : null;

    if (resolvedDim?.key && resolvedDim?.value && cid) {
      // ✅ Protección adicional: NO sobreescribir person exact=true si ya está exact
      if (resolvedDim.key === "person" && filters?.person?.locked && filters.person.exact === true) {
        // no-op
      } else {
        const ctxNow = getContext(cid) || {};
        const nextFilters = { ...(ctxNow.filters || {}) };

        nextFilters[resolvedDim.key] = {
          value: resolvedDim.value,
          locked: true,
          exact: false,
        };

        const nextCtxPatch = { filters: nextFilters };
        if (resolvedDim.key === "person") nextCtxPatch.lastPerson = resolvedDim.value;

        setContext(cid, nextCtxPatch);
        filters = nextFilters;
      }
    }

    const extractedPersonFromDim =
      resolvedDim?.key === "person" && resolvedDim?.value ? String(resolvedDim.value) : null;

    const hasAnyPersonSignal = Boolean(
      explicitPersonNow || extractedPersonFromDim || hasPersonLocked || lastPerson
    );

    /* =====================================================
       3) Follow-up: hereda lastPerson
       ✅ FIX: NO inyectar persona previa en preguntas KPI/how-many
    ===================================================== */
    if (cid) {
      const lockedPerson = filters?.person?.locked
        ? String(filters.person.value || "").trim()
        : null;

      const carryPerson = lockedPerson || (lastPerson ? String(lastPerson).trim() : null);

      const hasExplicitDimNotPerson = Boolean(resolvedDim?.key && resolvedDim.key !== "person");

      // ✅ “nombre explícito” = lo detectado por reglas + lo detectado por extractor
      const hasExplicitPersonNow = Boolean(explicitPersonNow || extractedPersonCandidate);

      // ✅ BLOQUEO KPI/how-many: evita que "How many dropped Mariel has in 2025?"
      // sea tratado como follow-up y se le inyecte "for Chacon, Maria"
      const looksLikeKpiHowMany =
        isHowManyCasesQuestion(effectiveMessage, uiLang) ||
        isKpiOnlyQuestion(effectiveMessage) ||
        /\bhow\s+many\b/i.test(effectiveMessage) ||
        /\bcu[aá]ntos?\b/i.test(effectiveMessage);

      if (
        carryPerson &&
        !userWantsPersonChange &&
        !hasExplicitPersonNow &&
        !hasExplicitDimNotPerson &&
        !looksLikeKpiHowMany &&
        !looksLikeNewTopic(effectiveMessage, uiLang) &&
        (isFollowUpQuestion(effectiveMessage, uiLang) || effectiveMessage.trim().length <= 40)
      ) {
        effectiveMessage = injectPersonFromContext(effectiveMessage, uiLang, carryPerson);
      }
    }

    // Default window desde memoria
    const msgWithUserDefault = applyDefaultWindowToMessage(effectiveMessage, uiLang, userMemory);
    const messageWithDefaultPeriod = ensureDefaultMonth(msgWithUserDefault, uiLang);

    /* =====================================================
       PERFORMANCE FAST PATH (NO IA)
    ===================================================== */
    {
      const out = await handlePerformance({
        reqId,
        logEnabled,
        debug,
        uiLang,
        cid,
        messageWithDefaultPeriod,
        filters,
        suggestionsBase,
        userName,
      });
      if (out) return out;
    }

    /* =====================================================
       KPI-only FAST PATH
    ===================================================== */
    {
      const out = await handleKpiOnly({
        reqId,
        logEnabled,
        debug,
        uiLang,
        cid,
        messageWithDefaultPeriod,
        effectiveMessage,
        filters,
        hasAnyPersonSignal,
        suggestionsBase,
        userName,

        forcedPick,
        pendingContext,
      });
      if (out) return out;
    }

    /* =====================================================
       NORMAL MODE (IA -> SQL)
    ===================================================== */
    return await handleNormalAi({
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
    });
  } catch (err) {
    // rollback
    if (cid) {
      clearPending(cid);
      if (ctxSnapshot) setContext(cid, ctxSnapshot);
    }

    console.error(`[${reqId}] Orchestrator error:`, err);

    return {
      ok: true,
      answer: friendlyError(uiLang, reqId),
      rowCount: 0,
      aiComment: "friendly_error_catchall",
      userName: cid ? getUserName(cid) || null : null,
      chart: null,
      suggestions: suggestionsBase,
      ...(debug ? { debugDetails: String(err?.message || err) } : {}),
      perf: debugPerf ? timers.done() : undefined,
    };
  }
}

module.exports = { chatOrchestratorHandle };
