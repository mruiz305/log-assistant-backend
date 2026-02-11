
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
  if (rosterPdf) items.push({ id: "roster", label: uiLang === "es" ? "Roster (PDF)" : "Roster (PDF)", url: rosterPdf });

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

module.exports = { buildPdfActions, buildPdfAnswer };
