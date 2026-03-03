
const dashboardRepo = require("../../../repos/dashboard.repo");

async function runMonthKpis() {
  try {
    // si tu repo se llama getMonthKpis()
    const k = await dashboardRepo.getMonthKpis();

    // normaliza campos para que siempre existan los que usa executiveSummary
    return {
      total: Number(k?.total || 0),
      confirmed: Number(k?.confirmed || 0),
      confirmationRate: Number(k?.confirmationRate || 0),
      dropped: Number(k?.dropped || 0),
      droppedRate: Number(k?.droppedRate || 0),
      active: Number(k?.active || 0),
      referOut: Number(k?.referOut || 0),
      problemCases: Number(k?.problemCases || 0),
      convertedValue: Number(k?.convertedValue || 0),
      conversionValue: Number(k?.conversionValue || 0),
    };
  } catch (e) {
    console.error("Month KPIs query failed:", e?.message || e);
    return {
      total: 0,
      confirmed: 0,
      confirmationRate: 0,
      dropped: 0,
      droppedRate: 0,
      active: 0,
      referOut: 0,
      problemCases: 0,
      convertedValue: 0,
      conversionValue: 0,
    };
  }
}

module.exports = { runMonthKpis };
