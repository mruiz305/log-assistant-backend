// src/utils/miniChart.js
// MiniChart debe aparecer SOLO cuando aporta valor visual.

function wantsMiniChart(question = '', lang = 'en') {
  const q = String(question || '').toLowerCase();

  const es = /(tendencia|graf(ic|i)c|chart|compar(a|e)|versus|vs|top\s+\d+|ranking|por\s+(oficina|team|equipo|pod|region|director|abogado))/i;
  const en = /(trend|chart|graph|compare|versus|vs|top\s+\d+|ranking|by\s+(office|team|pod|region|director|attorney))/i;

  return lang === 'es' ? es.test(q) : en.test(q);
}

function buildMiniChart(question, lang, { kpiPack, rows, presetKey } = {}) {
  const arr = Array.isArray(rows) ? rows : [];
  const rowCount = arr.length;

  const hasBreakdown = rowCount >= 2;
  if (!hasBreakdown && !wantsMiniChart(question, lang)) return null;

  const first = arr[0] || null;
  const keys = first ? Object.keys(first) : [];

  const labelKey =
    keys.find((k) => /office|team|pod|region|director|attorney|submitter|name/i.test(k)) ||
    keys.find((k) => /month|date|day/i.test(k)) ||
    null;

  const valueKey =
    keys.find((k) => /confirmed_rate|confirmationrate|confirmed|ttd|dropped_rate|dropped|convertedvalue|converted_value/i.test(k)) ||
    null;

  if (!labelKey || !valueKey) return null;

  const points = arr
    .slice(0, 12)
    .map((r) => ({
      label: String(r[labelKey] ?? '').trim(),
      value: Number(r[valueKey] ?? 0),
    }))
    .filter((p) => p.label);

  if (points.length < 2) return null;

  return {
    type: 'mini_bar',
    title: lang === 'es' ? 'Resumen visual' : 'Visual summary',
    labelKey,
    valueKey,
    points,
    meta: { presetKey: presetKey || null, hasKpiPack: Boolean(kpiPack) },
  };
}

module.exports = { buildMiniChart };
