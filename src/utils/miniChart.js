// src/utils/miniChart.js
// MiniChart debe aparecer SOLO cuando aporta valor visual.

function wantsMiniChart(question = "", lang = "en") {
  const q = String(question || "").toLowerCase();

  const es =
    /(tendencia|graf(ic|i)c|chart|compar(a|e)|versus|vs|top\s+\d+|ranking|por\s+(oficina|team|equipo|pod|region|director|abogado|intake|representante|submitter))/i;
  const en =
    /(trend|chart|graph|compare|versus|vs|top\s+\d+|ranking|by\s+(office|team|pod|region|director|attorney|intake|rep|submitter))/i;

  return lang === "es" ? es.test(q) : en.test(q);
}

function inferTopN(question = "") {
  const m = String(question || "").toLowerCase().match(/\btop\s+(\d{1,2})\b/);
  if (m && m[1]) {
    const n = Number(m[1]);
    if (Number.isFinite(n) && n >= 2 && n <= 15) return n;
  }
  return 10;
}

function toNumber(x) {
  if (x === null || x === undefined) return 0;
  if (typeof x === "number") return Number.isFinite(x) ? x : 0;
  const s = String(x).trim();
  if (!s) return 0;
  // soporta "12.34", "12,34", "12%" etc.
  const cleaned = s.replace(/%/g, "").replace(/,/g, "");
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : 0;
}

function pickLabelKey(keys = []) {
  return (
    keys.find((k) =>
      /office|officename|team|teamname|pod|podename|region|regionname|director|directorname|attorney|submitter|submittername|name/i.test(
        k
      )
    ) ||
    keys.find((k) => /month|date|day|week/i.test(k)) ||
    null
  );
}

function pickValueKey(keys = [], question = "") {
  const q = String(question || "").toLowerCase();

  // Prioridad según la pregunta
  const wantsConfirmed = /(confirm|confirmed|confirmados|confirmacion|confirmación)/i.test(q);
  const wantsDropped = /(drop|dropped|problem|leakage|referout|ref\s*out)/i.test(q);
  const wantsValue = /(valor\s+de\s+conversi[oó]n|conversion\s+value|converted\s+value)/i.test(q);

  const candidates = [
    // rates
    "confirmed_rate",
    "confirmationRate",
    "confirmationrate",
    "dropped_rate",
    // counts
    "confirmed",
    "confirmed_cases",
    "dropped_cases",
    "dropped",
    "problem_cases",
    "problem",
    "ttd",
    // money-like (sin moneda)
    "convertedValue",
    "convertedvalue",
    "converted_value",
    "case_converted_value",
  ];

  // Si pide "valor de conversión", intentamos eso primero
  if (wantsValue) {
    const k = keys.find((x) => /convertedvalue|converted_value|case_converted_value/i.test(x));
    if (k) return k;
  }

  // Si pide dropped/leakage, prioriza dropped_rate o dropped_cases
  if (wantsDropped) {
    const k =
      keys.find((x) => /dropped_rate/i.test(x)) ||
      keys.find((x) => /dropped_cases|dropped\b/i.test(x)) ||
      null;
    if (k) return k;
  }

  // Si pide confirmación, prioriza confirmed_rate/confirmationRate/confirmed_cases
  if (wantsConfirmed) {
    const k =
      keys.find((x) => /confirmed_rate|confirmationrate/i.test(x)) ||
      keys.find((x) => /confirmed_cases|confirmed\b/i.test(x)) ||
      null;
    if (k) return k;
  }

  // Fallback por lista de candidatos
  for (const c of candidates) {
    const found = keys.find((k) => String(k).toLowerCase() === String(c).toLowerCase());
    if (found) return found;
  }

  // Último fallback: primer numérico razonable
  return keys.find((k) => /rate|count|total|sum|avg|min|max|value/i.test(k)) || null;
}

function buildFromBreakdownRows(question, lang, rows, presetKey) {
  const arr = Array.isArray(rows) ? rows : [];
  if (arr.length < 2) return null;

  const first = arr[0] || null;
  const keys = first ? Object.keys(first) : [];
  if (!keys.length) return null;

  const labelKey = pickLabelKey(keys);
  const valueKey = pickValueKey(keys, question);
  if (!labelKey || !valueKey) return null;

  const points = arr
    .slice(0, 12)
    .map((r) => ({
      label: String(r[labelKey] ?? "").trim(),
      value: toNumber(r[valueKey]),
    }))
    .filter((p) => p.label);

  // Debe haber mínimo 2 puntos con algo de variación
  if (points.length < 2) return null;

  const nonZero = points.filter((p) => p.value !== 0);
  if (nonZero.length < 1) return null;

  return {
    type: "mini_bar",
    title: lang === "es" ? "Resumen visual" : "Visual summary",
    labelKey,
    valueKey,
    points,
    meta: { presetKey: presetKey || null, source: "breakdown_rows" },
  };
}

function buildFromListMode(question, lang, rows, presetKey) {
  // List mode: contamos por una dimensión (Status/Office/Team/Submitter/etc.)
  const arr = Array.isArray(rows) ? rows : [];
  if (arr.length < 2) return null;

  const q = String(question || "").toLowerCase();
  const n = inferTopN(question);

  // Elegimos dimensión según la pregunta
  const dimPriority = [
    { rx: /(por\s+oficina|by\s+office)/i, keys: ["OfficeName", "officeName", "office", "Office"] },
    { rx: /(por\s+team|por\s+equipo|by\s+team)/i, keys: ["TeamName", "teamName", "team", "Team"] },
    { rx: /(por\s+pod|by\s+pod)/i, keys: ["PODEName", "podName", "pod", "POD"] },
    { rx: /(por\s+region|by\s+region)/i, keys: ["RegionName", "regionName", "region", "Region"] },
    { rx: /(por\s+director|by\s+director)/i, keys: ["DirectorName", "directorName", "director", "Director"] },
    { rx: /(por\s+abogado|by\s+attorney)/i, keys: ["attorney", "Attorney"] },
    { rx: /(por\s+intake|locked\s+down|by\s+intake)/i, keys: ["intakeSpecialist", "IntakeSpecialist"] },
    { rx: /(por\s+rep|representante|submitter|entered\s+by|by\s+rep)/i, keys: ["submitterName", "submitter", "name"] },
    // fallback útil si pregunta "status"
    { rx: /(status|dropped|problem|leakage|ref\s*out)/i, keys: ["Status", "status", "leadStatus", "ClinicalStatus", "LegalStatus"] },
  ];

  // fallback general: Status si existe, si no submitterName/OfficeName
  const defaultDims = ["Status", "OfficeName", "TeamName", "submitterName", "submitter", "name"];

  let dimKey = null;

  for (const d of dimPriority) {
    if (!d.rx.test(q)) continue;
    for (const k of d.keys) {
      if (k in (arr[0] || {})) {
        dimKey = k;
        break;
      }
    }
    if (dimKey) break;
  }

  if (!dimKey) {
    for (const k of defaultDims) {
      if (k in (arr[0] || {})) {
        dimKey = k;
        break;
      }
    }
  }

  if (!dimKey) return null;

  // Conteo
  const map = new Map();
  for (const r of arr) {
    const label = String(r[dimKey] ?? "").trim();
    if (!label) continue;

    map.set(label, (map.get(label) || 0) + 1);
  }

  const points = Array.from(map.entries())
    .map(([label, value]) => ({ label, value }))
    .sort((a, b) => b.value - a.value)
    .slice(0, n);

  if (points.length < 2) return null;

  return {
    type: "mini_bar",
    title: lang === "es" ? "Top (conteo)" : "Top (count)",
    labelKey: dimKey,
    valueKey: "count",
    points,
    meta: { presetKey: presetKey || null, source: "list_mode_count" },
  };
}

function buildFromKpiPack(question, lang, kpiPack, presetKey) {
  if (!kpiPack || typeof kpiPack !== "object") return null;

  // Si el usuario pidió chart, podemos mostrar 2–4 barras KPI.
  // OJO: solo si tenemos al menos 2 métricas válidas.
  const candidates = [
    { key: "gross_cases", label: lang === "es" ? "Casos" : "Cases" },
    { key: "ttd", label: lang === "es" ? "Casos" : "Cases" },
    { key: "confirmed_cases", label: lang === "es" ? "Confirmados" : "Confirmed" },
    { key: "confirmed_rate", label: lang === "es" ? "Tasa confirmación" : "Confirmation rate" },
    { key: "dropped_cases", label: lang === "es" ? "Dropped" : "Dropped" },
    { key: "dropped_rate", label: lang === "es" ? "Tasa dropped" : "Dropped rate" },
    { key: "problem_rate", label: lang === "es" ? "Tasa problem" : "Problem rate" },
    { key: "case_converted_value", label: lang === "es" ? "Valor conversión" : "Conversion value" },
  ];

  const points = [];
  for (const c of candidates) {
    if (!(c.key in kpiPack)) continue;
    const v = toNumber(kpiPack[c.key]);
    // permitir 0 solo si ya hay algo más
    if (v === 0 && points.length === 0) continue;
    points.push({ label: c.label, value: v });
    if (points.length >= 4) break;
  }

  if (points.length < 2) return null;

  return {
    type: "mini_bar",
    title: lang === "es" ? "KPIs" : "KPIs",
    labelKey: "kpi",
    valueKey: "value",
    points,
    meta: { presetKey: presetKey || null, source: "kpi_pack" },
  };
}

function buildMiniChart(question, lang, { kpiPack, rows, presetKey } = {}) {
  const arr = Array.isArray(rows) ? rows : [];
  const rowCount = arr.length;

  const userAsked = wantsMiniChart(question, lang);

  // 1) Si hay breakdown (>=2 filas con columnas de label/value), úsalo.
  const fromBreakdown = buildFromBreakdownRows(question, lang, arr, presetKey);
  if (fromBreakdown) return fromBreakdown;

  // 2) Si es list mode, solo construimos chart si el usuario lo pidió (top/ranking/por x/chart)
  if (rowCount >= 2 && userAsked) {
    const fromList = buildFromListMode(question, lang, arr, presetKey);
    if (fromList) return fromList;
  }

  // 3) Si no hay breakdown pero usuario pidió chart, intenta con KPI pack
  if (userAsked) {
    const fromKpi = buildFromKpiPack(question, lang, kpiPack, presetKey);
    if (fromKpi) return fromKpi;
  }

  // 4) Si no aporta valor, nada
  return null;
}

module.exports = { buildMiniChart };
