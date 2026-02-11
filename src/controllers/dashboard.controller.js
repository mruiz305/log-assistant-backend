const { getMonthSummaryUsecase } = require("../usecases/getMonthSummary.usecase");

async function getMonthSummary(req, res) {
  try {
    const lang = req.query.lang === "es" ? "es" : "en";

    const result = await getMonthSummaryUsecase({
      lang,
      uid: req.user?.uid || null,
    });

    return res.json(result);
  } catch (err) {
    console.error("Dashboard summary month error:", err);
    return res.status(500).json({
      ok: false,
      error: "Failed to load dashboard summary (month)",
    });
  }
}

module.exports = { getMonthSummary };
