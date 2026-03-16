
function friendlyError(uiLang, reqId) {
  const base =
    uiLang === "es"
      ? "No pude procesar tu solicitud en este momento. Por favor, inténtalo de nuevo. Si la consulta incluye una persona, indica el nombre completo y el período (por ejemplo: este mes)."
      : "I wasn't able to process your request right now. Please try again. If your query involves a specific person, include their full name and time window (e.g., this month).";
  return base;
}

/**
 * Respuesta estándar cuando no hay datos para la consulta. No generar análisis ni LLM.
 * Produce mensajes contextuales según si hay persona/período o filtros restrictivos.
 *
 * @param {string} uiLang - "en" | "es"
 * @param {object} opts - Optional context
 * @param {string} [opts.personName] - Nombre de la persona/entidad cuando la consulta está scoped a alguien
 * @param {string} [opts.period] - Período (ej. "2035", "January 2026", "este mes")
 * @param {boolean} [opts.hasRestrictiveFilters] - true si hay filtros de attorney/office/etc. activos
 * @param {string} [opts.activeFiltersText] - Texto de filtros activos para añadir al mensaje (ej. "Current filter: Attorney: Tony Cao")
 */
function noDataFoundResponse(uiLang, opts = {}) {
  const isEs = uiLang === "es";
  const { personName, period, hasRestrictiveFilters, activeFiltersText } = opts;

  let answer;
  if (personName) {
    const periodPart = period
      ? (isEs ? ` en ${period}` : ` in ${period}`)
      : "";
    answer = isEs
      ? `No se encontraron datos para ${personName}${periodPart}. Prueba seleccionando otro período.`
      : `No data was found for ${personName}${periodPart}. Try selecting a different time period.`;
  } else if (hasRestrictiveFilters) {
    answer = isEs
      ? "No hay casos que coincidan con los filtros actuales. Prueba ajustando los filtros o la ventana de tiempo."
      : "No cases match the current filters. Try adjusting the filters or time window.";
  } else {
    answer = isEs
      ? "No encontré datos para esa consulta. Intenta ser más específico o ajustar los filtros."
      : "I couldn't find data for that request. Please try being more specific or adjust the filters.";
  }

  if (activeFiltersText && String(activeFiltersText).trim()) {
    const prefix = isEs ? " Filtros activos: " : " Current filters: ";
    answer = answer + prefix + activeFiltersText.trim() + ".";
  }

  // Sugerencias como acciones: { text, action } para que el frontend ejecute la acción en vez de enviar texto como pregunta
  const defaultSuggestions = isEs
    ? [
        { text: "2025", action: null },
        { text: "Últimos 7 días", action: null },
        { text: "Este mes", action: null },
        { text: "Cambiar filtro", action: "change_scope" },
        { text: "Especificar nombre completo", action: "change_scope" },
      ]
    : [
        { text: "2025", action: null },
        { text: "Last 7 days", action: null },
        { text: "This month", action: null },
        { text: "Change filter", action: "change_scope" },
        { text: "Specify full name", action: "change_scope" },
      ];
  const suggestions = opts.suggestions || defaultSuggestions;
  return { answer, suggestions };
}

module.exports = { friendlyError, noDataFoundResponse };
