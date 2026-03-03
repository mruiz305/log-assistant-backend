
function buildStatusChart({ lang = "en", kpis }) {
  return {
    title: lang === "es" ? "Distribución de estatus" : "Status distribution",
    data: [
      { label: "Confirmed", value: Number(kpis?.confirmed || 0) },
      { label: "Active", value: Number(kpis?.active || 0) },
      { label: "Ref out", value: Number(kpis?.referOut || 0) },
      { label: "Dropped", value: Number(kpis?.dropped || 0) },
      { label: "Problem", value: Number(kpis?.problemCases || 0) },
    ].filter((x) => x.value > 0),
  };
}

module.exports = { buildStatusChart };
