const { classifyIntent } = require('./intent');

/* ============================================================
   summarySanitizer.service
   - Devuelve un payload compacto: summary + top + sample
   - Evita mezclar crédito (Confirmed/CNV) en análisis de salud cuando no aplica
   - Reduce tokens y mejora precisión del mini-análisis
   ============================================================ */

function normalizeText(s = '') {
  return (s || '')
    .toString()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function isNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function pick(obj, keys) {
  const out = {};
  for (const k of keys) {
    if (k && obj && Object.prototype.hasOwnProperty.call(obj, k)) out[k] = obj[k];
  }
  return out;
}

function sum(rows, key) {
  let t = 0;
  for (const r of rows || []) {
    const v = r?.[key];
    if (isNumber(v)) t += v;
  }
  return t;
}

function safeDiv(a, b) {
  if (!isNumber(a) || !isNumber(b) || b === 0) return null;
  return a / b;
}

function topN(rows, key, n = 3) {
  const arr = Array.isArray(rows) ? [...rows] : [];
  arr.sort((a, b) => {
    const av = isNumber(a?.[key]) ? a[key] : -Infinity;
    const bv = isNumber(b?.[key]) ? b[key] : -Infinity;
    return bv - av;
  });
  return arr.slice(0, n);
}

/**
 * Retorna:
 * {
 *   summary: { intent, rowCount, totals, rates, dimsDetected, metricsDetected },
 *   top: [ ...top 3 filas relevantes... ],
 *   sample: [ ...hasta 10 filas compactas... ]
 * }
 */
function sanitizeRowsForSummary(question, rows) {
  const intent = classifyIntent(question);
  const q = normalizeText(question);

  const data = Array.isArray(rows) ? rows : [];
  const rowCount = data.length;

  const cols = data[0] ? Object.keys(data[0]) : [];
  const has = (c) => cols.includes(c);

  // Métricas comunes (plantillas doradas + agregados)
  const metrics = {
    cnv: has('cnv') ? 'cnv' : null,
    gross: has('gross_cases') ? 'gross_cases' : null,
    dropped: has('dropped_cases') ? 'dropped_cases' : null,
    pctDropped: has('pct_dropped') ? 'pct_dropped' : null,

    problem: has('problem_cases') ? 'problem_cases' : null,
    problem30: has('problem_gt_30') ? 'problem_gt_30' : null,
    dropped60: has('dropped_gt_60') ? 'dropped_gt_60' : null,

    confirmedProblem: has('confirmed_problem') ? 'confirmed_problem' : null,
    confirmedDroppedStatus: has('confirmed_dropped_status') ? 'confirmed_dropped_status' : null,
    confirmedClinicalDropped: has('confirmed_clinical_dropped') ? 'confirmed_clinical_dropped' : null,
  };

  // Dimensiones típicas
  const dims = {
    anio: has('anio') ? 'anio' : null,
    mes: has('mes') ? 'mes' : null,
    office: has('OfficeName') ? 'OfficeName' : (has('officeLabel') ? 'officeLabel' : null),
    team: has('TeamName') ? 'TeamName' : null,
    region: has('RegionName') ? 'RegionName' : null,
  };

  // --- regla original: si es salud (dropped/problem) y NO es mix, evitar campos de crédito
  // (para que no invente cosas con convertedValue/credit)
  const isDroppedOrProblem = /(dropped|drop|problem)/i.test(q);
  const allowCreditFields = intent === 'cnv' || intent === 'mix';

  // Columnas a mantener (dims + métricas) con control de crédito
  const keepMetricCols = [];

  // dims siempre ok
  const keepDimCols = [dims.anio, dims.mes, dims.office, dims.team, dims.region].filter(Boolean);

  // métricas según intent
  if (allowCreditFields) {
    if (metrics.cnv) keepMetricCols.push(metrics.cnv);
    if (metrics.confirmedProblem) keepMetricCols.push(metrics.confirmedProblem);
    if (metrics.confirmedDroppedStatus) keepMetricCols.push(metrics.confirmedDroppedStatus);
    if (metrics.confirmedClinicalDropped) keepMetricCols.push(metrics.confirmedClinicalDropped);
  }

  // métricas de salud siempre ok
  if (metrics.gross) keepMetricCols.push(metrics.gross);
  if (metrics.dropped) keepMetricCols.push(metrics.dropped);
  if (metrics.pctDropped) keepMetricCols.push(metrics.pctDropped);
  if (metrics.problem) keepMetricCols.push(metrics.problem);
  if (metrics.problem30) keepMetricCols.push(metrics.problem30);
  if (metrics.dropped60) keepMetricCols.push(metrics.dropped60);

  // Si intent=health y el query accidentalmente trae cnv, lo filtramos
  const keepCols = [...keepDimCols, ...keepMetricCols].filter(Boolean);

  // ---------------- SUMMARY ----------------
  const summary = {
    intent,
    rowCount,
    totals: {},
    rates: {},
    dimsDetected: Object.fromEntries(Object.entries(dims).filter(([, v]) => v)),
    metricsDetected: Object.fromEntries(Object.entries(metrics).filter(([, v]) => v)),
    notes: [],
  };

  // Totales solo si existen
  if (metrics.cnv && allowCreditFields) summary.totals.cnv = sum(data, metrics.cnv);
  if (metrics.gross) summary.totals.gross_cases = sum(data, metrics.gross);
  if (metrics.dropped) summary.totals.dropped_cases = sum(data, metrics.dropped);
  if (metrics.problem) summary.totals.problem_cases = sum(data, metrics.problem);
  if (metrics.problem30) summary.totals.problem_gt_30 = sum(data, metrics.problem30);
  if (metrics.dropped60) summary.totals.dropped_gt_60 = sum(data, metrics.dropped60);

  if (allowCreditFields) {
    if (metrics.confirmedProblem) summary.totals.confirmed_problem = sum(data, metrics.confirmedProblem);
    if (metrics.confirmedDroppedStatus) summary.totals.confirmed_dropped_status = sum(data, metrics.confirmedDroppedStatus);
    if (metrics.confirmedClinicalDropped) summary.totals.confirmed_clinical_dropped = sum(data, metrics.confirmedClinicalDropped);
  }

  // Rate: dropped/gross si no viene pct_dropped
  if (!metrics.pctDropped && summary.totals.dropped_cases != null && summary.totals.gross_cases != null) {
    const r = safeDiv(summary.totals.dropped_cases, summary.totals.gross_cases);
    if (r != null) summary.rates.pct_dropped = +(r * 100).toFixed(2);
  }

  // Nota útil para el análisis
  if (isDroppedOrProblem && !allowCreditFields) {
    summary.notes.push('health_mode: credit fields removed');
  }

  // ---------------- TOP + SAMPLE ----------------
  // Métrica principal para ranking
  let primaryMetric = null;
  if (intent === 'cnv') primaryMetric = metrics.cnv || metrics.gross;
  else if (intent === 'health') primaryMetric = metrics.dropped60 || metrics.problem30 || metrics.dropped || metrics.problem || metrics.gross;
  else if (intent === 'clinical') primaryMetric = metrics.confirmedClinicalDropped || metrics.dropped || metrics.problem || metrics.gross;
  else if (intent === 'mix') primaryMetric = metrics.confirmedProblem || metrics.confirmedClinicalDropped || metrics.cnv || metrics.dropped || metrics.gross;
  else primaryMetric = metrics.gross || metrics.dropped || metrics.problem || metrics.cnv;

  const top = primaryMetric ? topN(data, primaryMetric, 3).map((r) => pick(r, keepCols)) : [];
  const sample = data.slice(0, 10).map((r) => pick(r, keepCols));

  return { summary, top, sample };
}

module.exports = { sanitizeRowsForSummary };
