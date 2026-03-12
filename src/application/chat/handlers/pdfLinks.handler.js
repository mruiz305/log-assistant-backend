
const sqlRepo = require("../../../repos/sql.repo");

const {
  wantsPdfLinks,
  findUserPdfCandidates,
} = require("../../../services/pdf/pdfLinks.service");

const { extractPersonNameFromMessage } = require("../../../utils/personRewrite");

const {
  getContext,
  setContext,
  setPending,
} = require("../../../domain/context/conversationState");

const { buildPdfAnswer, buildPdfActions } = require("../../../domain/ui/pdf.builder");

async function handlePdfLinks({
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
}) {
  // EARLY RESOLVE PDF PICK
  if (cid && forcedPick?.value && pendingContext?.type === "pdf_user_pick") {
    const pickedId = String(forcedPick.value);

    const rows = await sqlRepo.query(
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
      return {
        ok: true,
        answer:
          uiLang === "es"
            ? "No pude encontrar ese usuario. ¿Probamos otro?"
            : "I couldn’t find that user. Want to try another one?",
        rowCount: 0,
        aiComment: "pdf_links_not_found_after_pick",
        userName: userName || null,
        chart: null,
        suggestions: suggestionsBase,
      };
    }

    const pickedName = String(user?.name || user?.nick || "").trim();

    const ctxNow = getContext(cid) || {};
    const nextFilters = { ...(ctxNow.filters || {}) };
    if (pickedName) nextFilters.person = { value: pickedName, locked: true, exact: true };

    setContext(cid, {
      pdfUser: { id: String(user.id), name: pickedName },
      lastPerson: pickedName || ctxNow.lastPerson || null,
      filters: nextFilters,
    });

    const out = buildPdfAnswer(uiLang, user, userName);

    return {
      ok: true,
      answer: out.answer,
      rowCount: 0,
      aiComment: "pdf_links_pick_resolved",
      userName: userName || null,
      chart: null,
      pdfLinks: out.pdfLinks,
      pdfItems: out.pdfItems,
      actions: buildPdfActions(uiLang, user?.name || user?.nick || ""),
      suggestions: suggestionsBase,
    };
  }

  // Si scope focus está activo, NUNCA usar pdfLinks: prioridad al flujo focus
  const ctxNow = cid ? getContext(cid) || {} : {};
  if (ctxNow.scopeMode === "focus" && ctxNow.focus?.type) return null;

  // PDF LINKS FAST PATH
  if (!wantsPdfLinks(effectiveMessage)) return null;
  const rememberedPdfUserId = ctxNow?.pdfUser?.id ? String(ctxNow.pdfUser.id) : null;

  const msgLooksLikePdfOnly =
    wantsPdfLinks(effectiveMessage) && !extractPersonNameFromMessage(effectiveMessage);

  if (msgLooksLikePdfOnly && rememberedPdfUserId) {
    const rows = await sqlRepo.query(
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
      return {
        ok: true,
        answer: out.answer,
        rowCount: 0,
        aiComment: "pdf_links_from_context",
        userName: userName || null,
        chart: null,
        pdfLinks: out.pdfLinks,
        pdfItems: out.pdfItems,
        actions: buildPdfActions(uiLang, user?.name || user?.nick || ""),
        suggestions: suggestionsBase,
      };
    }
  }

  const candidates = await findUserPdfCandidates(sqlRepo, effectiveMessage, 8);

  if (!Array.isArray(candidates) || candidates.length === 0) {
    return {
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
    };
  }

  if (cid && candidates.length >= 2) {
    const prompt =
      uiLang === "es" ? "¿De cuál usuario quieres el PDF?" : "Which user do you want the PDF for?";
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

    return {
      ok: true,
      answer: prompt,
      rowCount: 0,
      aiComment: "pdf_links_disambiguation",
      userName: userName || null,
      chart: null,
      pick: { type: "pdf_user_pick", options },
      suggestions: null,
    };
  }

  const user = candidates[0];

  if (cid) {
    const pickedName = String(user?.name || user?.nick || "").trim();
    const nextFilters = { ...(ctxNow.filters || {}) };
    if (pickedName) nextFilters.person = { value: pickedName, locked: true, exact: true };

    setContext(cid, {
      pdfUser: { id: String(user.id), name: pickedName },
      lastPerson: pickedName || ctxNow.lastPerson || null,
      filters: nextFilters,
    });
  }

  const out = buildPdfAnswer(uiLang, user, userName);

  return {
    ok: true,
    answer: out.answer,
    rowCount: 0,
    aiComment: "pdf_links_single_match",
    userName: userName || null, // FIX (antes decía user:)
    chart: null,
    pdfLinks: out.pdfLinks,
    pdfItems: out.pdfItems,
    actions: buildPdfActions(uiLang, user?.name || user?.nick || ""),
    suggestions: suggestionsBase,
  };
}

module.exports = { handlePdfLinks };
