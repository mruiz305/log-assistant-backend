const express = require("express");
const router = express.Router();
const pool = require("../infra/db.pool"); 

router.get("/resolve-user", async (req, res) => {
  try {
    const email = String(req.query.email || "").trim().toLowerCase();
    if (!email) return res.json({ ok: true, found: false });

    const [rows] = await pool.query(
      `
      SELECT
        TRIM(
          COALESCE(           
            NULLIF(name,''),
            NULLIF(nick,'')           
          )
        ) AS displayName,
        TRIM(email) AS emailDb
      FROM stg_g_users
      WHERE TRIM(LOWER(email)) = ?
      LIMIT 1
      `,
      [email]
    );

    const name = rows?.[0]?.displayName;

    // ✅ LOG IMPORTANTE
    console.log("[resolve-user] email=", email, "row=", rows?.[0]);

    if (name) return res.json({ ok: true, found: true, name });

    return res.json({ ok: true, found: false });
  } catch (e) {
    console.error("[resolve-user] error:", e);
    return res.status(500).json({ ok: false, error: "SERVER_ERROR" });
  }
});


module.exports = router;
