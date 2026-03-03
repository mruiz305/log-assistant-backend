
const dashboardRepo = require("../repos/dashboard.repo");
const { generateExecutiveSummary } = require("./executiveSummary.service");

function buildStatusChart(lang, kpis) {
  return {
    title: lang === "es" ? "Distribución de estatus" : "Status distribution",
    data: [
      { label: "Confirmed", value: kpis.confirmed },
      { label: "Active", value: kpis.active },
      { label: "Ref out", value: kpis.referOut },
      { label: "Dropped", value: kpis.dropped },
      { label: "Problem", value: kpis.problemCases },
    ].filter((x) => Number(x.value || 0) > 0),
  };
}

async function getMonthSummary({ lang = "en", userName = null }) {
  const windowLabel = lang === "es" ? "Mes en curso" : "Month-to-date";

  const k = await dashboardRepo.getMonthKpisMTD();

  const kpis = {
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

  const [topReps, topAttorneys] = await Promise.all([
    dashboardRepo.getTopRepsMTD(10),
    dashboardRepo.getTopAttorneysMTD(10),
  ]);

  const chart = buildStatusChart(lang, kpis);

  const executiveSummary = await generateExecutiveSummary({
    lang,
    windowLabel,
    kpis: {
      total: kpis.total,
      confirmed: kpis.confirmed,
      confirmationRate: kpis.confirmationRate,
      dropped: kpis.dropped,
      droppedRate: kpis.droppedRate,
      active: kpis.active,
      referOut: kpis.referOut,
      problemCases: kpis.problemCases,
      convertedValue: kpis.convertedValue,
    },
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

module.exports = { getMonthSummary };
