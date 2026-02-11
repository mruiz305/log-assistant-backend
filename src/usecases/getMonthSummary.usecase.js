// src/usecases/getMonthSummary.usecase.js
const dashboardRepo = require("../repos/dashboard.repo");
const { buildStatusChart } = require("../services/dashboard/dashboardSummary.service"); // o chart.service
const { generateExecutiveSummary } = require("../services/executiveSummary.service");

async function getMonthSummaryUsecase({ lang, userName = null }) {
  const windowLabel = lang === "es" ? "Mes en curso" : "Month-to-date";

  // 1) KPIs y top lists -> Repo
  const [kpis, topReps, topAttorneys] = await Promise.all([
    dashboardRepo.getMonthKpis(),
    dashboardRepo.getTopRepsMTD(10),
    dashboardRepo.getTopAttorneys(10),
  ]);

  // 2) Chart -> Service puro (sin DB)
  const chart = buildStatusChart({ lang, kpis });

  // 3) Executive summary -> Service IA
  const executiveSummary = await generateExecutiveSummary({
    lang,
    windowLabel,
    kpis,
    userName,
  });

  return {
    ok: true,
    window: windowLabel,
    kpis,
    chart,
    executiveSummary,
    topReps,
    topAttorneys,
    updatedAt: new Date().toISOString(),
  };
}

module.exports = { getMonthSummaryUsecase };
