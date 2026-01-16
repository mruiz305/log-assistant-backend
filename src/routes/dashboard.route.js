const express = require("express");
const router = express.Router();
const { requireAuth } = require("../middlewares/requireFirebaseAuth");
const pool = require("../infra/db.pool");
const { buildKpiPackSql } = require("../services/kpiPack.service");
const { generateExecutiveSummary } = require("../services/executiveSummary.service");

router.get("/summary/week", requireAuth, async (req, res) => {
  try {
    const lang = req.query.lang === "es" ? "es" : "en";
    const message = lang === "es" ? "ultimos 7 dias" : "last 7 days";

    const { sql, params, windowLabel } = buildKpiPackSql(message, {
      lang,
      person: null,
    });

    const [rows] = await pool.query(sql, params);
    const kpiPack = rows?.[0] || {};

    // ✅ KPIs finales (NUMÉRICOS)
    const kpis = {
      total: Number(kpiPack.gross_cases ?? kpiPack.total ?? 0),
      confirmed: Number(kpiPack.confirmed_cases ?? kpiPack.confirmed ?? 0),
      confirmationRate: Number(kpiPack.confirmed_rate ?? kpiPack.confirmation_rate ?? 0),

      dropped: Number(kpiPack.dropped_cases ?? kpiPack.dropped ?? 0),
      droppedRate: Number(kpiPack.dropped_rate ?? 0),

      active: Number(kpiPack.active_cases ?? kpiPack.active ?? 0),
      referOut: Number(kpiPack.referout_cases ?? kpiPack.referout ?? 0),

      problemCases: Number(kpiPack.problem_cases ?? kpiPack.problem ?? 0),
    };

    // ✅ Chart (tu formato actual)
    const chart = {
      title: lang === "es" ? "Distribución de estatus" : "Status distribution",
      data: [
        { label: "Confirmed", value: kpis.confirmed },
        { label: "Active", value: kpis.active },
        { label: "Referout", value: kpis.referOut },
        { label: "Dropped", value: kpis.dropped },
        { label: "Problem", value: kpis.problemCases },
      ].filter((x) => x.value > 0),
    };

    // ✅ AQUÍ VA LA IA (justo aquí)
    const executiveSummary = await generateExecutiveSummary({
      lang,
      windowLabel,
      kpis,
      userName: null, // si luego quieres pasar el user
    });

    const response = {
      ok: true,
      window: windowLabel,
      kpis,
      chart,
      executiveSummary,
      updatedAt: new Date().toISOString(),
    };

    // debug opcional
    if (req.query.debug === "1") {
      response.debug = { message, windowLabel, sql, params, firstRow: kpiPack };
    }

    return res.json(response);
  } catch (err) {
    console.error("Dashboard summary error:", err);
    return res.status(500).json({
      ok: false,
      error: "Failed to load dashboard summary",
    });
  }
});

module.exports = router;
