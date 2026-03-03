
const dashboardRepo = require("../../../repos/dashboard.repo");

async function runTopReps(limit = 10) {
  try {
    return await dashboardRepo.getTopRepsMTD(limit);
  } catch (e) {
    console.error("Top reps query failed:", e?.message || e);
    return [];
  }
}

module.exports = { runTopReps };
