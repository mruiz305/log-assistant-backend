/**
 * rosterLookup.handler.js
 * Maneja peticiones de ROSTER: solo PDF/link, sin consulta de tabla.
 * Usa focus para resolver la entidad.
 */
const sqlRepo = require("../../../repos/sql.repo");
const { FOCUS } = require("../../../domain/focus/focusRegistry");
const { findFocusCandidates } = require("../../../repos/focus.repo");
const { findUserByResolvedName } = require("../../../services/pdf/pdfLinks.service");
const {
  wantsRosterLookup,
  extractEntityPhrase,
} = require("../../../services/logsRoster/logsRoster.service");
const {
  getContext,
  setContext,
  setPending,
} = require("../../../domain/context/conversationState");
const { FOCUS_TO_DIM_KEY } = require("../../../utils/chatContextLocks");

async function handleRosterLookup({
  reqId,
  uiLang,
  cid,
  effectiveMessage,
  forcedPick,
  pendingContext,
  suggestionsBase,
  userName,
}) {
  if (!wantsRosterLookup(effectiveMessage)) return null;

  const ctx = cid ? getContext(cid) || {} : {};
  const focusType = ctx.scopeMode === "focus" && ctx.focus?.type
    ? String(ctx.focus.type).trim()
    : "submitter";
  const focusValue = ctx.focus?.value ? String(ctx.focus.value).trim() : null;

  // Si ya hay entidad resuelta, usarla; NO extraer del mensaje (puede ser garbage)
  let query =
    ctx.scopeMode === "focus" && ctx.focus?.value ? focusValue : (extractEntityPhrase(effectiveMessage) || focusValue);
  if (!query) {
    return {
      ok: true,
      answer: uiLang === "es"
        ? "¿De quién quieres el roster? Indica el nombre."
        : "Whose roster do you want? Please provide a name.",
      rowCount: 0,
      aiComment: "roster_lookup_no_entity",
      chart: null,
      suggestions: suggestionsBase,
    };
  }

  const cfg = FOCUS[focusType];
  const rows = await findFocusCandidates({
    type: focusType,
    query: String(query).trim(),
    limit: 500,
  });

  if (!rows.length) {
    return {
      ok: true,
      answer: uiLang === "es"
        ? `No encontré coincidencias para "${query}" en ${cfg?.label || focusType}. Intenta con otro nombre o verifica la ortografía.`
        : `I couldn't find any matches for "${query}" in ${cfg?.label || focusType}. Try another name or check the spelling.`,
      rowCount: 0,
      aiComment: "roster_lookup_no_match",
      chart: null,
      suggestions: suggestionsBase,
    };
  }

  if (cid && rows.length >= 2 && !(forcedPick?.value && pendingContext?.kind === "pick_roster_entity")) {
    const options = rows.map((r, idx) => ({
      id: String(idx + 1),
      label: (cfg?.canonicalFromRow ? cfg.canonicalFromRow(r) : r.name || r.attorney || r.office) || "",
      value: (cfg?.canonicalFromRow ? cfg.canonicalFromRow(r) : r.name || r.attorney || r.office) || "",
    }));

    setPending(cid, {
      kind: "pick_roster_entity",
      focusType,
      options,
      originalMessage: effectiveMessage,
    });

    return {
      ok: true,
      answer: uiLang === "es"
        ? `Encontré ${options.length} coincidencias. ¿Cuál es la correcta?`
        : `I found ${options.length} matches. Which one is correct?`,
      rowCount: 0,
      aiComment: "roster_lookup_pick",
      chart: null,
      pick: { type: "pick_roster_entity", options },
      suggestions: null,
    };
  }

  const resolvedRow = rows.length === 1
    ? rows[0]
    : rows[Number(forcedPick?.id || forcedPick?.value || 1) - 1];
  if (!resolvedRow) {
    return {
      ok: true,
      answer: uiLang === "es" ? "No pude resolver el candidato." : "I couldn't resolve the candidate.",
      rowCount: 0,
      aiComment: "roster_lookup_pick_invalid",
      chart: null,
      suggestions: suggestionsBase,
    };
  }

  const resolvedValue = (cfg?.canonicalFromRow ? cfg.canonicalFromRow(resolvedRow) : resolvedRow.name || resolvedRow.attorney || resolvedRow.office) || "";
  const dimKey = FOCUS_TO_DIM_KEY[focusType] || "person";

  if (cid) {
    const filters = {};
    for (const k of ["person", "office", "pod", "team", "region", "director", "intake", "attorney"]) {
      filters[k] = k === dimKey ? { value: resolvedValue, locked: true, exact: true } : null;
    }
    setContext(cid, {
      scopeMode: "focus",
      focus: { type: focusType, value: resolvedValue, label: resolvedValue },
      filters,
      lastPerson: dimKey === "person" ? resolvedValue : ctx.lastPerson,
    });
    if (pendingContext?.kind === "pick_roster_entity") {
      setPending(cid, null);
    }
  }

  const userCandidates = await findUserByResolvedName(sqlRepo, resolvedValue, 1);
  const user = userCandidates[0] || null;

  const rosterPdf = user?.rosterIndividualFile ? String(user.rosterIndividualFile).trim() : null;
  const displayName = resolvedValue;

  if (!rosterPdf) {
    return {
      ok: true,
      answer: uiLang === "es"
        ? `Encontré a **${displayName}**, pero no tiene roster PDF configurado.`
        : `I found **${displayName}**, but they don't have a roster PDF configured.`,
      rowCount: 0,
      aiComment: "roster_lookup_no_pdf",
      chart: null,
      pdfLinks: null,
      pdfItems: [],
      suggestions: suggestionsBase,
    };
  }

  const pdfItems = [{ id: "roster", label: uiLang === "es" ? "Roster (PDF)" : "Roster (PDF)", url: rosterPdf }];
  const pdfLinks = { logsPdf: null, rosterPdf, items: pdfItems };

  const answer = uiLang === "es"
    ? `${userName ? `${userName}, ` : ""}Aquí tienes el roster de **${displayName}**:`
    : `${userName ? `${userName}, ` : ""}Here is the roster for **${displayName}**:`;

  return {
    ok: true,
    answer,
    rowCount: 0,
    aiComment: "roster_lookup",
    chart: null,
    pdfLinks,
    pdfItems,
    suggestions: suggestionsBase,
  };
}

module.exports = { handleRosterLookup };
