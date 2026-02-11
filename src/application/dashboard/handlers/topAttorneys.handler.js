// src/application/dashboard/handlers/topAttorneys.handler.js
const dashboardRepo = require("../../../repos/dashboard.repo");

async function runTopAttorneys(limit = 10) {
  try {
    return await dashboardRepo.getTopAttorneys(limit);
  } catch (e) {
    console.error("Top attorneys query failed:", e?.message || e);
    return [];
  }
}

module.exports = { runTopAttorneys };
