const { normalizeText } = require('../utils/text');

/* =========================================================
   MINI CHART (backend)
========================================================= */

function wantsMiniChart(message = '') {
  const q = normalizeText(message);
  return (
    q.includes('resumen') ||
    q.includes('summary') ||
    q.includes('semana') ||
    q.includes('week') ||
    q.includes('mes') ||
    q.includes('month') ||
    q.includes('tendencia') ||
    q.includes('trend') ||
    q.includes('distrib') ||
    q.includes('status') ||
    q.includes('por estado') ||
    q.includes('by status') ||
    q.includes('compar') ||
    q.includes('top') ||
    q.includes('oficina') ||
    q.includes('office') ||
    q.includes('equipo') ||
    q.includes('team') ||
    q.includes('pod') ||
    q.includes('region') ||
    q.includes('director') ||
    q.includes('attorney')
  );
}

function pickNumber(obj, keys = []) {
  if (!obj || typeof obj !== 'object') return null;
  for (const k of keys) {
    if (Object.prototype.hasOwnProperty.call(obj, k)) {
      const n = Number(obj[k]);
      if (Number.isFinite(n)) return n;
    }
  }
  return null;
}

function buildStatusChartFromKpi(kpiPack, uiLang) {
  if (!kpiPack || typeof kpiPack !== 'object') return null;

  const confirmed = pickNumber(kpiPack, ['confirmed', 'Confirmed', 'confirmed_cases', 'confirmedCases']);
  const dropped = pickNumber(kpiPack, ['dropped', 'Dropped', 'dropped_cases', 'droppedCases']);
  const problem = pickNumber(kpiPack, ['problem', 'Problem', 'problem_cases', 'problemCases']);
  const active = pickNumber(kpiPack, ['active', 'Active', 'active_cases', 'activeCases']);
  const referout = pickNumber(kpiPack, ['referout', 'Referout', 'referout_cases', 'referoutCases']);

  const total = pickNumber(kpiPack, ['total', 'Total', 'totalCases', 'gross_cases', 'cases']);

  const hasAny = [confirmed, dropped, problem, active, referout].some((v) => Number.isFinite(v));
  if (!hasAny) return null;

  const labels = [];
  const values = [];

  if (Number.isFinite(referout)) { labels.push('Referout'); values.push(referout); }
  if (Number.isFinite(active))   { labels.push('Active');   values.push(active); }
  if (Number.isFinite(dropped))  { labels.push('Dropped');  values.push(dropped); }
  if (Number.isFinite(confirmed)){ labels.push('Confirmed');values.push(confirmed); }
  if (Number.isFinite(problem))  { labels.push('Problem');  values.push(problem); }

  if (Number.isFinite(total) && total > 0) {
    const sum = values.reduce((a, b) => a + b, 0);
    if (total > sum) {
      labels.push('Other');
      values.push(total - sum);
    }
  }

  return {
    kind: 'pie',
    title: uiLang === 'es' ? 'Distribución por estado' : 'Status distribution',
    labels,
    values,
  };
}

function buildTrendChartFromRows(rows, uiLang) {
  if (!Array.isArray(rows) || rows.length < 2) return null;

  const sample = rows[0] || {};
  const keys = Object.keys(sample);

  const dateKey = keys.find((k) => ['day', 'date', 'fecha', 'mes', 'month'].includes(String(k).toLowerCase()));
  if (!dateKey) return null;

  const preferred = ['gross_cases', 'grossCases', 'cases', 'caseCount', 'cnt', 'count', 'total', 'totalCases'];
  const countKey = keys.find((k) => preferred.includes(k));
  if (!countKey) return null;

  const labels = [];
  const values = [];
  for (const r of rows.slice(0, 14)) {
    const lab = String(r[dateKey] ?? '').replace(/\s+/g, ' ').trim();
    const v = Number(r[countKey]);
    if (lab && Number.isFinite(v)) {
      labels.push(lab);
      values.push(v);
    }
  }

  if (labels.length < 2) return null;

  return {
    kind: 'line',
    title: uiLang === 'es' ? 'Casos por día' : 'Cases per day',
    labels,
    values,
  };
}

function buildMiniChart(message, uiLang, { kpiPack, rows, presetKey = null } = {}) {
  if (!wantsMiniChart(message)) return null;

  const q = normalizeText(message);
  const isWeekly =
    presetKey === 'summary_week' ||
    q.includes('semana') ||
    q.includes('week') ||
    q.includes('ultimos 7') ||
    q.includes('últimos 7') ||
    q.includes('last 7');

  if (isWeekly) {
    const trend = buildTrendChartFromRows(rows, uiLang);
    if (trend) return trend;
  }

  const status = buildStatusChartFromKpi(kpiPack, uiLang);
  if (status) return status;

  const trend2 = buildTrendChartFromRows(rows, uiLang);
  if (trend2) return trend2;

  return null;
}
module.exports = { buildMiniChart };
