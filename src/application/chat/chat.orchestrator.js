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
  setPending,
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
const { normalizeMessage } = require("../../utils/messageNormalizer");
const { parseAnalyticsQuestion } = require("../../utils/analyticsParser");
const { looksLikeNewTopic } = require("../../utils/topic");
const { friendlyError } = require("../../utils/errors");
const {
  isFollowUpQuestion,
  injectPersonFromContext,
  tokenizePersonName,
  isResolvedEntityReusable,
} = require("../../utils/chatRoute.helpers");

const {
  getExplicitPersonFromMessage,
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
  mergeFocusIntoFilters,
  SCOPE_DIM_KEYS,
  FOCUS_TO_DIM_KEY,
  DIM_KEY_TO_FOCUS_TYPE,
} = require("../../utils/chatContextLocks");

/* Period helpers */
const { ensureDefaultMonth } = require("../../utils/text");
const { applyDefaultWindowToMessage } = require("../../utils/defaultWindow");

/* Handlers */
const { handleQuickActions } = require("./handlers/quickActions.handler");
const { handleLogsLookup } = require("./handlers/logsLookup.handler");
const { handleRosterLookup } = require("./handlers/rosterLookup.handler");
const { handleLogsReview } = require("./handlers/logsReview.handler");
const { handlePdfLinks } = require("./handlers/pdfLinks.handler");
const { handlePerformance } = require("./handlers/performance.handler");
const { handleEntityComparison } = require("./handlers/entityComparison.handler");
const { handleKpiOnly } = require("./handlers/kpiOnly.handler");
const { handleNormalAi } = require("./handlers/normalAi.handler");

/* Dimensions */
const { extractDimensionAndValue, extractDimensionForFocusType } = require("../../domain/dimensions/dimensionExtractor");
const { resolveDimension } = require("../../domain/dimensions/dimensionResolver");
const { listDimensions, getDimension } = require("../../domain/dimensions/dimensionRegistry");

const { buildScopeUi } = require("../../domain/ui/scopeUi");
const { buildActiveFiltersUi } = require("../../domain/ui/activeFilters");

const {
  openScopeWizard,
  applyPickedScopeType,
  handleAwaitScopeValue,
  looksLikeQuestion,
} = require("../../services/scopeWizard.service");

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

  function withScope(out) {
  if (!out || !cid) return out;
  const ctxNow = getContext(cid) || {};
  const scope = buildScopeUi(ctxNow, uiLang);
  const period = out?.kpiWindow || out?.windowLabel || out?.logsPerformanceReview?.windowLabel;
  const activeFilters = buildActiveFiltersUi(ctxNow.filters || {}, period, ctxNow, uiLang);
  return { ...out, scope, activeFilters };
}


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
  effectiveMessage = normalizeMessage(effectiveMessage, uiLang).normalized;

  const ctxInitial = cid ? getContext(cid) || {} : {};
  let activeScope = ctxInitial.scopeMode === "focus" && ctxInitial.focus?.type ? ctxInitial.focus.type : null;
  // Fallback: frontend envía meta.scope cuando el usuario tiene scope activo; el contexto backend puede no tenerlo
  if (!activeScope && req?.body?.meta?.scope?.mode === "focus" && req?.body?.meta?.scope?.label) {
    const label = String(req.body.meta.scope.label).trim().toLowerCase();
    const LABEL_TO_TYPE = {
      attorney: "attorney",
      submitter: "submitter",
      office: "office",
      pod: "pod",
      team: "team",
      region: "region",
      director: "director",
      "intake specialist": "intake",
      intake: "intake",
    };
    activeScope = LABEL_TO_TYPE[label] || (label && label !== "general" ? label.split(/\s+/)[0] : null);
    if (logEnabled && activeScope) console.log(`[${reqId}] [scope] activeScope from meta.scope label="${req.body.meta.scope.label}" -> "${activeScope}"`);
  }

  // Deterministic analytics parser (entity/metric/period/intent/comparisonTarget) for known patterns.
  const parsedAnalytics = parseAnalyticsQuestion(effectiveMessage, uiLang, activeScope);

  // Persistir userName del frontend (cuando aún no hay) para que la IA lo use desde el primer mensaje
  const reqUserName = (req?.body?.userName || req?.body?.meta?.userName || "")
    .toString()
    .trim();
  if (cid && reqUserName.length >= 2 && !getUserName(cid)) {
    setUserName(cid, reqUserName);
  }

  const wantsScopeWizard =
  (req?.body?.preset === "change_scope") ||
  /\b(change scope|cambiar filtro|cambiar scope|switch filter|switch scope)\b/i.test(effectiveMessage);

if (cid && wantsScopeWizard) {
  return withScope(openScopeWizard(cid, uiLang));
}

 
  const suggestionsBase = buildSuggestions(effectiveMessage, uiLang);


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
    if (out) return withScope(out);
  }

 
  // snapshot context (para rollback)
  const ctxAtStart = cid ? getContext(cid) || {} : {};
  const ctxSnapshot = cid ? JSON.parse(JSON.stringify(ctxAtStart)) : null;

  /* =====================================================
   0) Pending primero (wizard + pick)
===================================================== */
let forcedPick = null;
let pendingContext = null;


let skipPersonDimensionResolutionThisTurn = false;
let skipDimensionResolutionForKeys = new Set();
let skipDimensionResolutionEntirelyThisTurn = false; // evita re-resolver otra dim tras aplicar pick
let justAppliedFocusPick = false; // tras pick_focus_candidate: NO re-extraer entidad del mensaje

if (cid) {
  const pending = getPending(cid);

  if (logEnabled && !pending && /^[1-9]$/.test(String(effectiveMessage || "").trim())) {
    console.log(`[${reqId}] [orchestrator] WARN cid="${cid}" getPending=null con msg="${effectiveMessage}" (parece pick numérico; ¿cid distinto entre requests?)`);
  }

  if (pending?.kind === "await_scope_value") {
    let scopeValueOverride = null;
    if (looksLikeQuestion(effectiveMessage)) {
      // Attorney: si el mensaje es una pregunta tipo "How many cases did X handle...",
      // el parser puede extraer el nombre; así no pasamos la frase completa a findFocusCandidates
      if (pending.focusType === "attorney") {
        const parsedAttorney = parseAnalyticsQuestion(effectiveMessage, uiLang, "attorney");
        if (parsedAttorney?.entity?.type === "attorney" && parsedAttorney?.entity?.name) {
          scopeValueOverride = String(parsedAttorney.entity.name).trim();
          if (logEnabled) console.log(`[${reqId}] [await_scope_value] attorney from parser scopeValueOverride="${scopeValueOverride}"`);
        }
      }
      if (!scopeValueOverride) {
        let extracted = extractDimensionAndValue(effectiveMessage, uiLang);
        // focusType "submitter" => dimKey "person"; otros coinciden (office, pod, etc.)
        const dimKeyForFocus = FOCUS_TO_DIM_KEY[pending.focusType] || pending.focusType;
        if (extracted?.key !== dimKeyForFocus && extracted?.key !== pending.focusType) {
          const override = extractDimensionForFocusType(effectiveMessage, pending.focusType, uiLang);
          if (override) extracted = override;
        }
        const matches = extracted && (extracted.key === pending.focusType || extracted.key === dimKeyForFocus);
        if (matches && extracted?.value) {
          scopeValueOverride = String(extracted.value).trim();
        }
      }
    }

    clearPending(cid);

    const out = await handleAwaitScopeValue({
      cid,
      focusType: pending.focusType,
      message: effectiveMessage,
      uiLang,
      scopeValueOverride: scopeValueOverride || undefined,
    });

    // Si resolver dejó un pick (múltiples matches), lo devolvemos
    const p2 = getPending(cid);

    // Si aplicó focus (1 match) y no hay pick => continuar procesando la pregunta en el mismo turno
    if (out?.applied && !p2?.options?.length) {
      // no return: el flujo sigue con effectiveMessage (la pregunta original)
    } else {
      return withScope({
        ok: true,
        answer: out?.answer || out?.message || "",
        rowCount: 0,
        aiComment: "scope_value",
        userName: getUserName(cid) || null,
        chart: null,
        pick: p2?.options ? { type: p2.type || "pick", options: p2.options } : null,
        suggestions: null,
      });
    }
  }

  // (B) Si hay pending con opciones (pick numérico)
  if (pending?.options?.length) {
    // [DEBUG] pending actual antes de resolver
    if (logEnabled) {
      console.log(
        `[${reqId}] [orchestrator] PENDING antes resolver kind=${pending.kind || pending.type} dimKey=${pending.dimKey || "-"} optionsCount=${pending.options.length} originalMsg="${(pending.originalMessage || "").slice(0, 50)}..."`
      );
      pending.options.forEach((o, i) => {
        console.log(`[${reqId}] [orchestrator]   option[${i}] id=${o.id} label="${(o.label || "").slice(0, 40)}" value="${(o.value || "").slice(0, 40)}"`);
      });
    }

    const pick = tryResolvePick(effectiveMessage, pending.options);

    if (!pick) {
      if (logEnabled) {
        console.log(
          `[${reqId}] [orchestrator] PICK NOT RESOLVED msg="${effectiveMessage}" (len=${effectiveMessage?.length}) optionsIds=${pending.options.map((o) => o.id).join(",")}`
        );
      }
      return withScope({
        ok: true,
        answer: pending.prompt,
        rowCount: 0,
        aiComment: "pending_pick",
        userName: getUserName(cid) || null,
        chart: null,
        pick: { type: pending.type || pending.kind || "pick", options: pending.options },
        suggestions: null,
      });
    }

    // Guardamos contexto del pending y limpiamos
    pendingContext = pending;
    forcedPick = pick;

    // [DEBUG] opción seleccionada y contexto antes de clearPending
    if (logEnabled) {
      const ctxBefore = getContext(cid) || {};
      console.log(
        `[${reqId}] [orchestrator] PICK RESOLVED id=${pick.id} label="${(pick.label || "").slice(0, 50)}" value="${(pick.value || "").slice(0, 50)}" (canonical)`
      );
      console.log(`[${reqId}] [orchestrator] ctx ANTES clearPending filtersKeys=${Object.keys(ctxBefore.filters || {}).join(",")}`);
    }

    clearPending(cid);

    if (logEnabled) {
      const ctxAfter = getContext(cid) || {};
      console.log(`[${reqId}] [orchestrator] clearPending ejecutado. ctx DESPUÉS pending=${getPending(cid) ? "EXISTE" : "null"}`);
    }

    // (B1) si era el selector de tipo de scope
    if (pendingContext.kind === "pick_scope_type") {
      const pickedValue = String(pick.value || "").trim();
      const out = await applyPickedScopeType({ cid, pickedValue, uiLang });

      return withScope({
        ok: true,
        answer: out?.answer || out?.message || "",
        rowCount: 0,
        aiComment: "scope_type_picked",
        userName: getUserName(cid) || null,
        chart: null,
        pick: null,
        suggestions: null,
      });
    }

    // restaurar el mensaje original si existía
    effectiveMessage = pendingContext.originalMessage || effectiveMessage;

    // (B2) pick para escoger candidato de focus (office/pod/team/etc)
    if (pendingContext.kind === "pick_focus_candidate") {
      const focusType = String(pendingContext.focusType || "").trim();
      const chosenValue = String(pick.value || "").trim();

      if (focusType && chosenValue) {
        const FOCUS_TO_DIM = {
          submitter: "person",
          office: "office",
          pod: "pod",
          team: "team",
          region: "region",
          director: "director",
          intake: "intake",
          attorney: "attorney",
        };
        const dimKey = FOCUS_TO_DIM[focusType] || focusType;
        const SCOPE_DIM_KEYS = ["person", "office", "pod", "team", "region", "director", "intake", "attorney"];

        const ctxNow = getContext(cid) || {};
        const nextFilters = { ...(ctxNow.filters || {}) };
        SCOPE_DIM_KEYS.forEach((k) => {
          nextFilters[k] = k === dimKey ? { value: chosenValue, locked: true, exact: true } : null;
        });

        const ctxUpdate = {
          scopeMode: "focus",
          focus: { type: focusType, value: chosenValue, label: chosenValue },
          filters: nextFilters,
        };
        if (dimKey === "person") ctxUpdate.lastPerson = chosenValue;
        else ctxUpdate.lastPerson = null;
        setContext(cid, ctxUpdate);
        skipDimensionResolutionForKeys.add(dimKey);
        skipDimensionResolutionEntirelyThisTurn = true;
        justAppliedFocusPick = true; // lock entidad: no re-extraer del mensaje, no invalida con garbage

        // Rehidratar mensaje original para reejecutar la pregunta
        if (pendingContext.originalMessage) {
          effectiveMessage = String(pendingContext.originalMessage).trim();
        }

        if (logEnabled) {
          console.log(
            `[${reqId}] [orchestrator] applied pending focus pick type="${focusType}" value="${chosenValue}" filters.${dimKey} set, originalMsg restored`
          );
        }
      }
      // no return: dejamos que el flujo siga para responder la pregunta original ya con focus aplicado
    }

    // (B2b) pick para escoger candidato de dimensión (office, attorney, etc. desde tabla nexus)
    if (pendingContext.kind === "pick_dimension_candidate") {
      const dimKey = String(pendingContext.dimKey || "").trim();
      const chosenValue = String(pick.value || "").trim();

      if (dimKey && chosenValue) {
        const ctxNow = getContext(cid) || {};
        const nextFilters = { ...(ctxNow.filters || {}) };

        if (SCOPE_DIM_KEYS.has(dimKey)) {
          // Al elegir scope (attorney, office, etc.), actualizar focus para que mergeFocusIntoFilters
          // use el scope correcto y no siga usando uno anterior (ej: office cuando eligió attorney)
          SCOPE_DIM_KEYS.forEach((k) => {
            nextFilters[k] = k === dimKey ? { value: chosenValue, locked: true, exact: true } : null;
          });
          const focusType = DIM_KEY_TO_FOCUS_TYPE[dimKey] || dimKey;
          const ctxUpdate = {
            scopeMode: "focus",
            focus: { type: focusType, value: chosenValue, label: chosenValue },
            filters: nextFilters,
          };
          if (dimKey === "person") ctxUpdate.lastPerson = chosenValue;
          else ctxUpdate.lastPerson = null; // scope orgánico: no inyectar submitter
          setContext(cid, ctxUpdate);
        } else {
          nextFilters[dimKey] = { value: chosenValue, locked: true, exact: true };
          if (dimKey === "person") {
            setContext(cid, { filters: nextFilters, lastPerson: chosenValue });
          } else {
            setContext(cid, { filters: nextFilters });
          }
        }

        skipPersonDimensionResolutionThisTurn = dimKey === "person";
        skipDimensionResolutionForKeys.add(dimKey);
        skipDimensionResolutionEntirelyThisTurn = true; // evita re-resolver otra dim (ej: person) que daría otro pick
        if (SCOPE_DIM_KEYS.has(dimKey)) justAppliedFocusPick = true;
        effectiveMessage = pendingContext.originalMessage || effectiveMessage;

        if (logEnabled) {
          console.log(
            `[${reqId}] [orchestrator] applied pending dimension pick dimKey="${dimKey}" value="${chosenValue}"`
          );
        }
      }
      // no return: dejamos que el flujo siga para responder la pregunta original
    }

    //  (B3) EXISTENTE: pick de persona (exact)
    if (pendingContext?.dimKey === "person") {
      const chosen = String(pick.value || pick.id || "").trim();
      if (chosen) {
        const ctxNow = getContext(cid) || {};
        const nextFilters = { ...(ctxNow.filters || {}) };

        nextFilters.person = { value: chosen, locked: true, exact: true };

        setContext(cid, { filters: nextFilters, lastPerson: chosen });
        skipPersonDimensionResolutionThisTurn = true;
        skipDimensionResolutionForKeys.add("person");
        justAppliedFocusPick = true;

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
      return withScope({
        ok: true,
        answer: uiLang === "es" ? "¿Qué te gustaría consultar?" : "What would you like to check?",
        rowCount: 0,
        aiComment: "empty_message",
        userName: cid ? getUserName(cid) || null : null,
        chart: null,
        suggestions: suggestionsBase,
      });
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
      return withScope({
        ok: true,
        answer: greetingAnswer(uiLang, userName),
        rowCount: 0,
        aiComment: "greeting",
        userName: userName || null,
        chart: null,
        suggestions: suggestionsBase,
      });
    }

    /* ================= LOGS LOOKUP (tabla + registros + PDF opcional) ================= */
    {
      const out = await handleLogsLookup({
        reqId,
        logEnabled,
        uiLang,
        cid,
        effectiveMessage,
        forcedPick,
        pendingContext,
        suggestionsBase,
        userName,
      });
      if (out) return withScope(out);
    }

    /* ================= ROSTER LOOKUP (solo PDF) ================= */
    {
      const out = await handleRosterLookup({
        reqId,
        uiLang,
        cid,
        effectiveMessage,
        forcedPick,
        pendingContext,
        suggestionsBase,
        userName,
      });
      if (out) return withScope(out);
    }

    /* ================= EARLY RESOLVE PDF PICK ================= */
    /* Si scope focus está activo, NO usar pdfLinks: el usuario quiere análisis,
       no archivos. El flujo focus/performance resolverá la entidad y la pregunta. */
    const ctxEarly = cid ? getContext(cid) || {} : {};
    const hasActiveFocus = ctxEarly.scopeMode === "focus" && ctxEarly.focus?.type;

    if (!hasActiveFocus) {
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
      if (out) return withScope(out);
    }

    /* ================= HELP MODE ================= */
    const intentInfo = classifyIntentInfo(effectiveMessage);
    if (intentInfo && intentInfo.needsSql === false) {
      return withScope({
        ok: true,
        answer: buildHelpAnswer(uiLang, { userName }),
        rowCount: 0,
        aiComment: "help_mode",
        userName: userName || null,
        chart: null,
        suggestions: suggestionsBase,
      });
    }

    /* =====================================================
       CONTEXT + FILTERS (locks)
    ===================================================== */
    const ctx = cid ? getContext(cid) || {} : {};
    let filters = cloneFilters(ctx);
    filters = mergeFocusIntoFilters(filters, ctx);

    // Fallback: meta.scope from frontend cuando ctx no tiene focus (scope activo en UI pero backend desincronizado)
    const metaScope = req?.body?.meta?.scope;
    const hasScopeFromCtx = ctx.scopeMode === "focus" && ctx.focus?.value;
    const hasScopeFromFilters = [...SCOPE_DIM_KEYS].some((k) => filters?.[k]?.locked && filters[k].value);
    if (!hasScopeFromCtx && !hasScopeFromFilters && metaScope?.mode === "focus" && metaScope?.label) {
      const label = String(metaScope.label).trim();
      const colonIdx = label.indexOf(":");
      if (colonIdx > 0) {
        const scopeLabel = label.slice(0, colonIdx).trim().toLowerCase().replace(/\s+/g, " ");
        const scopeValue = label.slice(colonIdx + 1).trim();
        const LABEL_TO_DIM = {
          submitter: "person",
          attorney: "attorney",
          office: "office",
          pod: "pod",
          team: "team",
          region: "region",
          director: "director",
          "intake specialist": "intake",
          intake: "intake",
        };
        const dimKey = LABEL_TO_DIM[scopeLabel];
        if (dimKey && scopeValue) {
          filters[dimKey] = { value: scopeValue, locked: true, exact: true };
          if (cid) {
            const ctxNow = getContext(cid) || {};
            const focusType = DIM_KEY_TO_FOCUS_TYPE[dimKey] || dimKey;
            const nextCtx = {
              ...ctxNow,
              filters: { ...(ctxNow.filters || {}), [dimKey]: filters[dimKey] },
              scopeMode: "focus",
              focus: { type: focusType, value: scopeValue, label },
              ...(dimKey === "person" ? { lastPerson: scopeValue } : { lastPerson: null }),
            };
            setContext(cid, nextCtx);
            Object.assign(ctx, nextCtx);
          }
          if (logEnabled) console.log(`[${reqId}] [scope] applied meta.scope label="${label}" -> filters.${dimKey}="${scopeValue}"`);
        }
      }
    }

    const lastPerson = ctx.lastPerson ? String(ctx.lastPerson).trim() : null;

    // Si el parser determinístico ya extrajo entidad, fijar filtros según scope y evitar re-guessing.
    if (parsedAnalytics?.entity?.name) {
      const name = String(parsedAnalytics.entity.name).trim();
      const scopeType = parsedAnalytics.entity.type || activeScope;
      if (name && scopeType) {
        if (scopeType === "attorney") {
          filters.attorney = { value: name, locked: true, exact: false };
        } else if (scopeType === "submitter") {
          filters.person = { value: name, locked: true, exact: false };
          skipPersonDimensionResolutionThisTurn = true;
        }
        if (cid) {
          const ctxNow = getContext(cid) || {};
          const nextFilters = { ...(ctxNow.filters || {}), ...(filters || {}) };
          const nextCtx = { ...ctxNow, filters: nextFilters };
          if (scopeType === "submitter") nextCtx.lastPerson = name;
          setContext(cid, nextCtx);
        }
        if (logEnabled) {
          console.log(
            `[${reqId}] [parse] using parser entity="${name}" as scope="${scopeType}" (filters updated)`
          );
        }
      }
    }

    // señales de persona (directas) - incluye "how is X doing", "X performance", dimension extractor
    const explicitPersonNow = getExplicitPersonFromMessage(effectiveMessage, uiLang);

    const hasPersonLocked = Boolean(filters?.person?.locked && filters?.person?.value);

    // Si el usuario menciona explícitamente una persona distinta a la del contexto,
    // NO reutilizar la entidad previa: soltar lock, lastPerson y scope focus para este turno.
    // IMPORTANTE: NO hacer esto cuando justAppliedFocusPick (usuario acaba de elegir entidad);
    // el mensaje restaurado puede contener fragmentos que extraerían garbage (ej: "2025 - would you consider").
    if (cid && explicitPersonNow && !justAppliedFocusPick) {
      const explicitPersonRaw = String(explicitPersonNow).trim();
      const currentCtxPerson =
        filters?.person?.locked && filters.person.value
          ? String(filters.person.value).trim()
          : lastPerson;

      if (
        currentCtxPerson &&
        !isResolvedEntityReusable(explicitPersonRaw, currentCtxPerson)
      ) {
        const ctxNow = getContext(cid) || {};
        const nextFilters = { ...(ctxNow.filters || {}) };
        nextFilters.person = null;
        const FOCUS_TO_DIM = { submitter: "person", office: "office", pod: "pod", team: "team", region: "region", director: "director", intake: "intake", attorney: "attorney" };
        const isPersonScope = ctxNow.scopeMode === "focus" && FOCUS_TO_DIM[ctxNow.focus?.type] === "person";
        setContext(cid, {
          filters: nextFilters,
          lastPerson: null,
          pdfUser: null,
          ...(isPersonScope ? { scopeMode: "general", focus: null } : {}),
        });
        filters = nextFilters;
        // Refresh ctx so downstream logic uses updated context (no stale focus)
        if (cid) Object.assign(ctx, getContext(cid) || {});
      }
    }

    // clear dimension locks si usuario pidió "clear"
    if (cid) {
      const FOCUS_TO_DIM = { submitter: "person", office: "office", pod: "pod", team: "team", region: "region", director: "director", intake: "intake", attorney: "attorney" };
      for (const d of listDimensions()) {
        if (wantsToClear(effectiveMessage, d.key)) {
          filters[d.key] = null;
          if (ctx.scopeMode === "focus" && ctx.focus?.type && FOCUS_TO_DIM[ctx.focus.type] === d.key) {
            setContext(cid, { scopeMode: "general", focus: null });
          }
        }
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
       ⚠️ Si el parser ya resolvió entidad para scope=attorney, NO re-intentamos resolución
          de dimensiones: usamos directamente los filtros bloqueados que fijó el parser.
    ===================================================== */
    let extractedDim = null;
    let resolvedDim = null;

    const skipDimBecauseParsedAttorney =
      Boolean(parsedAnalytics?.entity?.name) &&
      parsedAnalytics?.entity?.type === "attorney";

    if (!skipDimensionResolutionEntirelyThisTurn && !skipDimBecauseParsedAttorney) {
      extractedDim = extractDimensionAndValue(effectiveMessage, uiLang);

      // Override: si scope focus está activo, SIEMPRE intentar extraer valor del mensaje para esa dim
      // y buscar candidatos en la tabla nexus (igual que attorney/office/pod)
      const focusType = ctx?.scopeMode === "focus" ? ctx?.focus?.type : null;
      const ctxValue = ctx?.focus?.value ? String(ctx.focus.value).trim() : "";
      const ctxValueLooksWrong = /^of\s+/i.test(ctxValue);
      const shouldOverrideScope =
        focusType &&
        ((!extractedDim || extractedDim.key !== focusType) ||
          ctxValueLooksWrong ||
          !ctxValue); // focus.value null => extraer y buscar candidatos
      if (shouldOverrideScope) {
        const override = extractDimensionForFocusType(effectiveMessage, focusType, uiLang);
        if (override?.value) extractedDim = override;
      }

      // si venimos de pick (person u otra dimensión), NO re-resolver esa dimensión (evita ciclo)
      const shouldResolveDim =
        extractedDim &&
        !(skipPersonDimensionResolutionThisTurn && extractedDim.key === "person") &&
        !skipDimensionResolutionForKeys.has(extractedDim.key);

      if (shouldResolveDim) {
        // Reuse previously resolved person when same short name, scope unchanged, no conflicting signal
        if (extractedDim.key === "person") {
          const resolvedPerson =
            filters?.person?.locked && filters.person.value
              ? String(filters.person.value).trim()
              : lastPerson
                ? String(lastPerson).trim()
                : null;
          const extractedPerson = String(extractedDim.value || "").trim();
          if (
            resolvedPerson &&
            extractedPerson &&
            isResolvedEntityReusable(extractedPerson, resolvedPerson)
          ) {
            resolvedDim = {
              key: "person",
              value: resolvedPerson,
              rawValue: extractedPerson,
              needsPick: false,
            };
          } else {
            resolvedDim = await resolveDimension(sqlRepo, extractedDim, effectiveMessage, uiLang);
          }
        } else {
          resolvedDim = await resolveDimension(sqlRepo, extractedDim, effectiveMessage, uiLang);
        }
      } else {
        resolvedDim = null;
      }
    }

    // detectamos candidato de person SOLO por extractor (sin resolver)
    const extractedPersonCandidate =
      extractedDim?.key === "person" && extractedDim?.value
        ? String(extractedDim.value).trim()
        : null;

    // 0 candidatos en tabla nexus: no usar valor literal, mostrar error
    if (resolvedDim?.noMatches && cid) {
      const def = getDimension(resolvedDim.key);
      const label = uiLang === "es" ? def?.labelEs || resolvedDim.key : def?.labelEn || resolvedDim.key;
      const msg =
        uiLang === "es"
          ? `No encontré coincidencias para **"${resolvedDim.rawValue}"** en ${label}. ¿Puedes intentar con otro nombre o verificar la ortografía?`
          : `I didn't find any matches for **"${resolvedDim.rawValue}"** in ${label}. Can you try a different name or check the spelling?`;
      return withScope({
        ok: true,
        answer: msg,
        rowCount: 0,
        aiComment: "dimension_no_matches",
        userName: getUserName(cid) || null,
        chart: null,
        suggestions: null,
      });
    }

    // Si la dimensión requiere pick (múltiples candidatos en tabla nexus)
    // NO devolver pick si ya aplicamos uno este turno (evita ciclo)
    if (
      resolvedDim?.needsPick &&
      cid &&
      resolvedDim?.options?.length &&
      !forcedPick
    ) {
      const def = getDimension(resolvedDim.key);
      const label = uiLang === "es" ? def?.labelEs || resolvedDim.key : def?.labelEn || resolvedDim.key;
      const prompt =
        uiLang === "es"
          ? `Encontré ${resolvedDim.options.length} coincidencias para ${label} "${resolvedDim.rawValue}". ¿Cuál es la correcta?`
          : `I found ${resolvedDim.options.length} matches for ${label} "${resolvedDim.rawValue}". Which one is correct?`;

      setPending(cid, {
        kind: "pick_dimension_candidate",
        dimKey: resolvedDim.key,
        focusType: resolvedDim.focusType,
        prompt,
        options: resolvedDim.options,
        originalMessage: effectiveMessage,
      });

      return withScope({
        ok: true,
        answer: prompt,
        rowCount: 0,
        aiComment: "dimension_pick",
        userName: getUserName(cid) || null,
        chart: null,
        pick: { type: resolvedDim.pickKind || "pick", options: resolvedDim.options },
        suggestions: null,
      });
    }

    if (resolvedDim?.key && resolvedDim?.value && !resolvedDim?.needsPick && cid) {
      // ✅ Protección adicional: NO sobreescribir person exact=true si ya está exact
      if (resolvedDim.key === "person" && filters?.person?.locked && filters.person.exact === true) {
        // no-op
      } else {
        const ctxNow = getContext(cid) || {};
        const nextFilters = { ...(ctxNow.filters || {}) };

        // Si el usuario buscó 1 sola palabra (ej: "Tony") y resolvimos desde nexus,
        // usar ese token para el filtro: DirectorName LIKE '%tony%' en vez de tokenizar
        // el canónico completo (que exigiría "press" y "tony" y falla si el dashboard
        // tiene "Tony" abreviado).
        let filterValue = resolvedDim.value;
        let filterExact = false;
        if (resolvedDim.meta?.resolvedFromNexus && extractedDim?.value) {
          const userTokens = tokenizePersonName(String(extractedDim.value).trim());
          if (userTokens.length === 1) {
            filterValue = String(extractedDim.value).trim();
            filterExact = true;
          }
        }

        if (SCOPE_DIM_KEYS.has(resolvedDim.key)) {
          SCOPE_DIM_KEYS.forEach((k) => {
            nextFilters[k] =
              k === resolvedDim.key
                ? { value: filterValue, locked: true, exact: filterExact }
                : null;
          });
          const focusType = DIM_KEY_TO_FOCUS_TYPE[resolvedDim.key] || resolvedDim.key;
          const nextCtxPatch = {
            scopeMode: "focus",
            focus: { type: focusType, value: resolvedDim.value, label: resolvedDim.value },
            filters: nextFilters,
          };
          if (resolvedDim.key === "person") nextCtxPatch.lastPerson = resolvedDim.value;
          setContext(cid, nextCtxPatch);
        } else {
          nextFilters[resolvedDim.key] = {
            value: filterValue,
            locked: true,
            exact: filterExact,
          };
          const nextCtxPatch = { filters: nextFilters };
          if (resolvedDim.key === "person") nextCtxPatch.lastPerson = resolvedDim.value;
          setContext(cid, nextCtxPatch);
        }
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
       FIX: NO inyectar persona previa en preguntas KPI/how-many
    ===================================================== */
    if (cid) {
      const lockedPerson = filters?.person?.locked
        ? String(filters.person.value || "").trim()
        : null;

      const carryPerson = lockedPerson || (lastPerson ? String(lastPerson).trim() : null);

      const hasExplicitDimNotPerson = Boolean(resolvedDim?.key && resolvedDim.key !== "person");

      // “nombre explícito” = lo detectado por reglas + lo detectado por extractor
      const hasExplicitPersonNow = Boolean(explicitPersonNow || extractedPersonCandidate);

      // BLOQUEO KPI/how-many: evita que "How many dropped Mariel has in 2025?"
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
       PARSED INTENT ROUTING (comparison_vs_average / logs_review)
       Parsed intents have priority over generic handlers.
    ===================================================== */
    if (parsedAnalytics?.intent === "comparison_vs_average" || parsedAnalytics?.intent === "comparison_vs_peers") {
      console.log(`[${reqId}] [route] parsedIntent="${parsedAnalytics.intent}"`);
      console.log(`[${reqId}] [route] selected handler=entityComparison`);
      const out = await handleEntityComparison({
        reqId,
        logEnabled,
        uiLang,
        messageWithDefaultPeriod,
        filters,
        parsedAnalytics,
        userName,
      });
      if (out) {
        console.log(`[${reqId}] [route] generic fallthrough skipped=true reason=parsed_entity_comparison`);
        return withScope(out);
      }
      console.log(`[${reqId}] [route] entityComparison returned null → falling through`);
    }

    /* =====================================================
       LOGS PERFORMANCE REVIEW (prioridad: evaluación/compensation fit)
       Debe ejecutarse ANTES de performance/kpiOnly para no quedar en query agregado solo.
    ===================================================== */
    let logsReviewEntered = false;
    let logsReviewReturned = false;
    {
      logsReviewEntered = true;
      const out = await handleLogsReview({
        reqId,
        logEnabled,
        uiLang,
        cid,
        messageWithDefaultPeriod,
        effectiveMessage,
        filters,
        suggestionsBase,
        userName,
      });
      logsReviewReturned = !!out;
      if (out) {
        console.log(`[${reqId}] [route] selected handler=handleLogsReview`);
        console.log(`[${reqId}] [route] skipped handler=performance.handler reason=logsReview_handled`);
        console.log(`[${reqId}] [route] entered generic leaderboard=false`);
        return withScope(out);
      }
      console.log(`[${reqId}] [route] logsReview returned null → falling through to performance`);
    }

    /* =====================================================
       PERFORMANCE FAST PATH (NO IA)
    ===================================================== */
    let performanceEntered = false;
    let performanceReturned = false;
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
      performanceEntered = true;
      performanceReturned = !!out;
      if (out) {
        console.log(`[${reqId}] [route] selected handler=handlePerformance (logsReview returned null)`);
        console.log(`[${reqId}] [route] logsReview.entered=${logsReviewEntered} logsReview.returned=${logsReviewReturned}`);
        console.log(`[${reqId}] [route] entered generic leaderboard=true`);
        return withScope(out);
      } else {
        console.log(`[${reqId}] [route] skipped handler=performance.handler reason=entity-specific_comparison_or_null`);
      }
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
      if (out) return withScope(out);
    }

    /* =====================================================
       NORMAL MODE (IA -> SQL)
    ===================================================== */
    if (logEnabled) {
      const fAtt = filters?.attorney?.locked ? `attorney=${filters.attorney.value}` : "attorney=null";
      const fOff = filters?.office?.locked ? `office=${filters.office.value}` : "office=null";
      console.log(`[${reqId}] [orchestrator] → handleNormalAi filters: ${fAtt} ${fOff} ctx.scopeMode=${ctx.scopeMode} ctx.focus.type=${ctx.focus?.type || "(null)"}`);
    }
    return withScope(await handleNormalAi({
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
      forcedPick,
      pendingContext,
    }));
  } catch (err) {
    // rollback
    if (cid) {
      clearPending(cid);
      if (ctxSnapshot) setContext(cid, ctxSnapshot);
    }

    console.error(`[${reqId}] Orchestrator error:`, err);

    return withScope({
      ok: true,
      answer: friendlyError(uiLang, reqId),
      rowCount: 0,
      aiComment: "friendly_error_catchall",
      userName: cid ? getUserName(cid) || null : null,
      chart: null,
      suggestions: suggestionsBase,
      ...(debug ? { debugDetails: String(err?.message || err) } : {}),
      perf: debugPerf ? timers.done() : undefined,
    });
  }
}

module.exports = { chatOrchestratorHandle };
