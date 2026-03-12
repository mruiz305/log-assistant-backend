
function friendlyError(uiLang, reqId) {
  const base =
    uiLang === "es"
      ? "Ups 😅 no pude completar eso ahora mismo. ¿Puedes intentar de nuevo? Si quieres, dime el nombre completo y el período (por ejemplo: “este mes”)."
      : "Oops 😅 I couldn’t complete that right now. Can you try again? If you want, tell me the full name and the time window (e.g., “this month”).";
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

  const suggestions = opts.suggestions || (isEs
    ? ["Probar otro período", "Especificar nombre completo", "Cambiar filtro (submitter, attorney, office)"]
    : ["Try another time period", "Specify a full name", "Change the filter (submitter, attorney, office)"]);
  return { answer, suggestions };
}

module.exports = { friendlyError, noDataFoundResponse };
