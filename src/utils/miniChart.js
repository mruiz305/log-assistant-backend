// src/utils/miniChart.js
// MiniChart debe aparecer SOLO cuando aporta valor visual.
// ✅ Enforcing by preset:
// - dropped_last_3_months => line (tendencia mensual)
// - summary/last_7_days/this_month/confirmed_month => donut (distribución)
// - top_reps => bar (ranking)

function safeNum(x, def = 0) {
  if (x === null || x === undefined) return def;
  if (typeof x === "number") return Number.isFinite(x) ? x : def;
  const s = String(x).trim();
  if (!s) return def;
  const n = Number(s.replace(/%/g, "").replace(/,/g, ""));
  return Number.isFinite(n) ? n : def;
}

function inferTopN(question = "") {
  const m = String(question || "").toLowerCase().match(/\btop\s+(\d{1,2})\b/);
  if (m && m[1]) {
    const n = Number(m[1]);
    if (Number.isFinite(n) && n >= 2 && n <= 15) return n;
  }
  return 10;
}

/** ✅ Decide kind 100% por preset (y fallback por texto) */
function inferKindFromPreset(presetKey = "", question = "") {
  const p = String(presetKey || "").toLowerCase();
  const q = String(question || "").toLowerCase();

  if (p.includes("dropped_last_3_months") || p.includes("dropped_3m") || /dropped.*3\s*months/.test(q)) {
    return "line";
  }

  if (
    p.includes("summary_week") ||
    p.includes("summary") ||
    p.includes("last_7_days") ||
    p.includes("this_month") ||
    p.includes("confirmed_month") ||
    /last 7 days|this month|summary|mes en curso|últimos 7 días|semana/i.test(q)
  ) {
    return "donut";
  }

  if (p.includes("top_reps") || /top reps|top\s+\d+|ranking/.test(q)) {
    return "bar";
  }

  return null;
}

// ✅ helper: leer keys alternativos del kpiPack
function pickKpi(kpiPack, keys = []) {
  for (const k of keys) {
    if (kpiPack && Object.prototype.hasOwnProperty.call(kpiPack, k)) return safeNum(kpiPack[k], 0);
  }
  return 0;
}

/**
 * ✅ DONUT SIEMPRE desde KPI PACK (misma fuente que tus cards)
 * Si el kpiPack trae distribución (confirmed/dropped/problem/active/referout), la usa.
 * Si NO la trae, hace fallback a confirmed/dropped/other usando gross.
 */
function buildDonutFromKpiPack(lang, kpiPack, presetKey) {
  if (!kpiPack || typeof kpiPack !== "object") return null;

  const confirmed = pickKpi(kpiPack, ["confirmed_cases", "confirmed", "Confirmed"]);
  const dropped = pickKpi(kpiPack, ["dropped_cases", "dropped", "Dropped"]);
  const problem = pickKpi(kpiPack, ["problem_cases", "problem", "Problem"]);
  const active = pickKpi(kpiPack, ["active_cases", "active", "Active"]);
  const referout = pickKpi(kpiPack, ["referout_cases", "referout", "Referout", "referred_out", "referredOut"]);

  const hasDistribution = (confirmed + dropped + problem + active + referout) > 0;

  let labels = [];
  let values = [];
  let colors = [];

  if (hasDistribution) {
    const points = [
      { label: lang === "es" ? "Confirmed" : "Confirmed", value: confirmed, color: "#22c55e" },
      { label: "Dropped", value: dropped, color: "#eab308" },
      { label: "Problem", value: problem, color: "#ef4444" },
      { label: lang === "es" ? "Active" : "Active", value: active, color: "#3b82f6" },
      { label: "Referout", value: referout, color: "#94a3b8" },
    ].filter((p) => p.value > 0);

    if (points.length < 2) return null;

    labels = points.map((p) => p.label);
    values = points.map((p) => p.value);
    colors = points.map((p) => p.color);
  } else {
    // fallback mínimo si tu kpiPack no trae active/referout/etc.
    const gross = pickKpi(kpiPack, ["gross_cases", "ttd", "total", "Total"]);
    const other = Math.max(0, gross - confirmed - dropped);

    const points = [
      { label: lang === "es" ? "Confirmed" : "Confirmed", value: confirmed, color: "#22c55e" },
      { label: "Dropped", value: dropped, color: "#eab308" },
      { label: lang === "es" ? "Other" : "Other", value: other, color: "#94a3b8" },
    ].filter((p) => p.value > 0);

    if (points.length < 2) return null;

    labels = points.map((p) => p.label);
    values = points.map((p) => p.value);
    colors = points.map((p) => p.color);
  }

  const total = values.reduce((a, b) => a + b, 0);

  return {
    kind: "donut",
    title: lang === "es" ? "Distribución de casos" : "Case distribution",
    labels,
    values,
    colors,
    center: { label: lang === "es" ? "Total" : "Total", value: total },
    meta: { presetKey: presetKey || null, source: "kpi_pack" },
  };
}

/**
 * ✅ LINE: Dropped last 3 months (tendencia por mes)
 * Espera rows con algo como: month + dropped_rate OR dropped_cases
 */
function buildDroppedTrendLine(lang, rows, presetKey) {
  const arr = Array.isArray(rows) ? rows : [];
  if (arr.length < 2) return null;

  const keys = Object.keys(arr[0] || {});
  if (!keys.length) return null;

  const monthKey =
    keys.find((k) => /month|mes|period/i.test(k)) ||
    keys.find((k) => /date|yyyy/i.test(k)) ||
    null;

  const valueKey =
    keys.find((k) => /dropped_rate|droppedrate/i.test(k)) ||
    keys.find((k) => /dropped_cases|dropped\b/i.test(k)) ||
    null;

  if (!monthKey || !valueKey) return null;

  const points = arr
    .slice(0, 12)
    .map((r) => ({
      label: String(r[monthKey] ?? "").trim(),
      value: safeNum(r[valueKey], 0),
    }))
    .filter((p) => p.label);

  if (points.length < 2) return null;

  return {
    kind: "line",
    title: lang === "es" ? "Dropped últimos 3 meses" : "Dropped last 3 months",
    labels: points.map((p) => p.label),
    values: points.map((p) => p.value),
    meta: { presetKey: presetKey || null, source: "rows_monthly", monthKey, valueKey },
  };
}

/**
 * ✅ BAR: Top reps (ranking)
 * Si rows ya trae columnas de ranking (submitterName + confirmed/ttd/etc) usa eso.
 * Si no, hace fallback contando ocurrencias por submitterName/submitter.
 */
function buildTopRepsBar(question, lang, rows, presetKey) {
  const arr = Array.isArray(rows) ? rows : [];
  if (arr.length < 2) return null;

  const n = inferTopN(question);
  const keys = Object.keys(arr[0] || {});

  const labelKey =
    keys.find((k) => /submittername/i.test(k)) ||
    keys.find((k) => /^submitter$/i.test(k)) ||
    keys.find((k) => /rep|name/i.test(k)) ||
    null;

  const valueKey =
    keys.find((k) => /confirmed\b|confirmed_cases/i.test(k)) ||
    keys.find((k) => /ttd|total|count/i.test(k)) ||
    keys.find((k) => /convertedvalue|converted_value/i.test(k)) ||
    null;

  // Caso A: viene valueKey (ranking real)
  if (labelKey && valueKey) {
    const points = arr
      .map((r) => ({ label: String(r[labelKey] ?? "").trim(), value: safeNum(r[valueKey], 0) }))
      .filter((p) => p.label)
      .sort((a, b) => b.value - a.value)
      .slice(0, n);

    if (points.length < 2) return null;

    return {
      kind: "bar",
      title: lang === "es" ? "Top reps" : "Top reps",
      labels: points.map((p) => p.label),
      values: points.map((p) => p.value),
      meta: { presetKey: presetKey || null, source: "rows_rank", labelKey, valueKey },
    };
  }

  // Caso B: fallback por conteo
  if (!labelKey) return null;

  const map = new Map();
  for (const r of arr) {
    const label = String(r[labelKey] ?? "").trim();
    if (!label) continue;
    map.set(label, (map.get(label) || 0) + 1);
  }

  const points = Array.from(map.entries())
    .map(([label, value]) => ({ label, value }))
    .sort((a, b) => b.value - a.value)
    .slice(0, n);

  if (points.length < 2) return null;

  return {
    kind: "bar",
    title: lang === "es" ? "Top reps" : "Top reps",
    labels: points.map((p) => p.label),
    values: points.map((p) => p.value),
    meta: { presetKey: presetKey || null, source: "rows_count", labelKey },
  };
}

function buildMiniChart(question, lang, { kpiPack, rows, presetKey } = {}) {
  const kind = inferKindFromPreset(presetKey, question);

  // ✅ 1) DONUT: summary/this_month/last_7_days/confirmed_month (siempre desde KPI PACK)
  if (kind === "donut") {
    return buildDonutFromKpiPack(lang, kpiPack, presetKey);
  }

  // ✅ 2) LINE: dropped_last_3_months (siempre desde rows mensual)
  if (kind === "line") {
    return buildDroppedTrendLine(lang, rows, presetKey);
  }

  // ✅ 3) BAR: top_reps (siempre desde rows)
  if (kind === "bar") {
    return buildTopRepsBar(question, lang, rows, presetKey);
  }

  return null;
}

module.exports = { buildMiniChart };
