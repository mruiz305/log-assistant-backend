/**
 * Build human-readable active filters for BI-style transparency.
 * Used in no-data messages and response metadata.
 */

const { getDimension } = require("../dimensions/dimensionRegistry");

const SCOPE_ORDER = ["person", "attorney", "office", "pod", "team", "region", "director", "intake"];

/**
 * Build active filters text for inline display (e.g. in no-data message).
 * @param {object} filters - { person: { value, locked }, attorney: {...}, ... }
 * @param {string} [period] - e.g. "2025", "year 1900", "this month"
 * @param {string} uiLang - "en" | "es"
 * @returns {string} e.g. "Submitter: Tony | Period: 2025 | Attorney: Tony Cao"
 */
function buildActiveFiltersText(filters = {}, period, uiLang = "en") {
  const parts = [];
  const isEs = uiLang === "es";

  for (const key of SCOPE_ORDER) {
    const lock = filters?.[key];
    if (!lock?.locked || !lock?.value) continue;
    const def = getDimension(key);
    const label = isEs ? (def?.labelEs || key) : (def?.labelEn || key);
    const cap = label.charAt(0).toUpperCase() + label.slice(1);
    parts.push(`${cap}: ${String(lock.value).trim()}`);
  }

  if (period && String(period).trim()) {
    const periodLabel = isEs ? "Período" : "Period";
    parts.push(`${periodLabel}: ${String(period).trim()}`);
  }

  return parts.length ? parts.join(" | ") : "";
}

/**
 * Build structured active filters for UI display.
 * @param {object} filters
 * @param {string} [period]
 * @param {object} [scopeCtx] - { scopeMode, focus }
 * @param {string} uiLang
 * @returns {{ text: string, items: Array<{key,label,value}> }}
 */
function buildActiveFiltersUi(filters = {}, period, scopeCtx = {}, uiLang = "en") {
  const items = [];
  const isEs = uiLang === "es";

  for (const key of SCOPE_ORDER) {
    const lock = filters?.[key];
    if (!lock?.locked || !lock?.value) continue;
    const def = getDimension(key);
    const label = isEs ? (def?.labelEs || key) : (def?.labelEn || key);
    const cap = label.charAt(0).toUpperCase() + label.slice(1);
    items.push({ key, label: cap, value: String(lock.value).trim() });
  }

  if (period && String(period).trim()) {
    const periodLabel = isEs ? "Período" : "Period";
    items.push({ key: "period", label: periodLabel, value: String(period).trim() });
  }

  if (scopeCtx?.scopeMode === "focus" && scopeCtx?.focus?.type) {
    const scopeLabel = scopeCtx.focus.type.charAt(0).toUpperCase() + scopeCtx.focus.type.slice(1);
    items.push({ key: "scope", label: "Scope", value: scopeLabel });
  }

  const text = items.map((i) => `${i.label}: ${i.value}`).join(" | ");
  return { text: text || (isEs ? "Sin filtros" : "No filters"), items };
}

module.exports = { buildActiveFiltersText, buildActiveFiltersUi };
