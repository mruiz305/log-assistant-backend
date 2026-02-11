// src/application/dashboard/handlers/executiveSummary.handler.js
const { generateExecutiveSummary } = require("../../../services/executiveSummary.service");

async function runExecutiveSummary({ lang, windowLabel, kpis, userName }) {
  return generateExecutiveSummary({
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
    userName: userName || null,
  });
}

module.exports = { runExecutiveSummary };
