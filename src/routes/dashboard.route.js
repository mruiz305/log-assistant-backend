const express = require("express");
const router = express.Router();

const { requireAuth } = require("../middlewares/requireFirebaseAuth");
const pool = require("../infra/db.pool");
const { generateExecutiveSummary } = require("../services/executiveSummary.service");

/**
 * ✅ MES EN CURSO (MTD)
 * - KPIs generales
 * - Top 10 reps: ORDER BY TTD (total leads) DESC, convertedValue DESC
 * - Top 10 attorneys: ORDER BY confirmed DESC
 *
 * ⚠️ Ajusta SOLO si tu columna de abogado no se llama `attorney`.
 */
router.get("/summary/month", requireAuth, async (req, res) => {
  try {
    const lang = req.query.lang === "es" ? "es" : "en";
    const windowLabel = lang === "es" ? "Mes en curso" : "Month-to-date";

    // ✅ KPIs del mes en curso (filtro por dateCameIn)
    const kpiSql = `
      SELECT
        COUNT(*) AS total,
        ROUND(SUM(COALESCE(convertedValue,0)), 2) AS conversionValue,
        SUM(CASE WHEN confirmed = 1 THEN 1 ELSE 0 END) AS confirmed,
        ROUND(
          (SUM(CASE WHEN confirmed = 1 THEN 1 ELSE 0 END) / NULLIF(COUNT(*),0)) * 100,
          2
        ) AS confirmationRate,

        SUM(CASE WHEN LOWER(TRIM(status)) = 'dropped' THEN 1 ELSE 0 END) AS dropped,
        ROUND(
          (SUM(CASE WHEN LOWER(TRIM(status)) = 'dropped' THEN 1 ELSE 0 END) / NULLIF(COUNT(*),0)) * 100,
          2
        ) AS droppedRate,

        SUM(CASE WHEN LOWER(TRIM(status)) = 'active' THEN 1 ELSE 0 END) AS active,
        SUM(CASE WHEN LOWER(TRIM(status)) IN ('referout','refer out','refer-out','ref out') THEN 1 ELSE 0 END) AS referOut,
        SUM(CASE WHEN LOWER(TRIM(status)) LIKE '%problem%' THEN 1 ELSE 0 END) AS problemCases,

        ROUND(SUM(COALESCE(convertedValue, 0)), 2) AS convertedValue
      FROM dmLogReportDashboard
      WHERE dateCameIn >= DATE_FORMAT(CURDATE(), '%Y-%m-01')
        AND dateCameIn <  DATE_ADD(DATE_FORMAT(CURDATE(), '%Y-%m-01'), INTERVAL 1 MONTH)
    `;

    const [[k]] = await pool.query(kpiSql);

    const kpis = {
      total: Number(k?.total || 0), // (TTD global = total leads del mes)
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

    const chart = {
      title: lang === "es" ? "Distribución de estatus" : "Status distribution",
      data: [
        { label: "Confirmed", value: kpis.confirmed },
        { label: "Active", value: kpis.active },
        { label: "Ref out", value: kpis.referOut },
        { label: "Dropped", value: kpis.dropped },
        { label: "Problem", value: kpis.problemCases },
      ].filter((x) => x.value > 0),
    };

    // ✅ TOP 10 reps (TTD + convertedValue)
    const topRepsSql = `
      SELECT
        submitterName AS name,
        COUNT(*) AS ttd,
        SUM(CASE WHEN confirmed = 1 THEN 1 ELSE 0 END) AS confirmed,
        ROUND(
          (SUM(CASE WHEN confirmed = 1 THEN 1 ELSE 0 END) / NULLIF(COUNT(*),0)) * 100,
          2
        ) AS confirmationRate,
        ROUND(SUM(COALESCE(convertedValue, 0)), 2) AS convertedValue
      FROM dmLogReportDashboard
      WHERE dateCameIn >= DATE_FORMAT(CURDATE(), '%Y-%m-01')
        AND dateCameIn <  DATE_ADD(DATE_FORMAT(CURDATE(), '%Y-%m-01'), INTERVAL 1 MONTH)
        AND submitterName IS NOT NULL
        AND submitterName <> ''
      GROUP BY submitterName
      ORDER BY ttd DESC, convertedValue DESC, confirmed DESC
      LIMIT 10
    `;

    // ✅ TOP 10 attorneys (más confirmados)
    // ⚠️ Si tu columna se llama distinto, cambia `attorney` aquí.
    const topAttorneysSql = `
      SELECT
        attorney AS name,
        SUM(CASE WHEN confirmed = 1 THEN 1 ELSE 0 END) AS confirmed,
        COUNT(*) AS ttd,
        ROUND(SUM(COALESCE(convertedValue, 0)), 2) AS convertedValue
      FROM dmLogReportDashboard
      WHERE dateCameIn >= DATE_FORMAT(CURDATE(), '%Y-%m-01')
        AND dateCameIn <  DATE_ADD(DATE_FORMAT(CURDATE(), '%Y-%m-01'), INTERVAL 1 MONTH)
        AND attorney IS NOT NULL
        AND attorney <> ''
      GROUP BY attorney
      ORDER BY confirmed DESC, convertedValue DESC, ttd DESC
      LIMIT 10
    `;

    let topReps = [];
    try {
      const [r] = await pool.query(topRepsSql);
      topReps = r || [];
    } catch (e) {
      console.error("Top reps query failed:", e.message);
      topReps = [];
    }

    let topAttorneys = [];
    try {
      const [a] = await pool.query(topAttorneysSql);
      topAttorneys = a || [];
    } catch (e) {
      console.error("Top attorneys query failed:", e.message);
      topAttorneys = [];
    }

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
      userName: null,
    });

    return res.json({
      ok: true,
      window: windowLabel,
      kpis,
      chart,
      executiveSummary,
      topReps,
      topAttorneys,
      updatedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error("Dashboard summary month error:", err);
    return res.status(500).json({
      ok: false,
      error: "Failed to load dashboard summary (month)",
    });
  }
});

module.exports = router;
