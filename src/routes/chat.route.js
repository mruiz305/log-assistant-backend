const express = require('express');
const router = express.Router();

/* Infra / Guard */
const pool = require('../infra/db.pool');
const { validateAnalyticsSql } = require('../../sqlGuard');

/* Services */
const { buildSqlFromQuestion } = require('../services/sqlBuilder.service');
const { buildOwnerAnswer } = require('../services/ownerAnswer.service');
const { enforceStatusRules } = require('../services/sqlRules.service');
const { normalizeAnalyticsSql } = require('../services/sqlNormalize.service');
const { buildKpiPackSql } = require('../services/kpiPack.service');
const { wantsPdfLinks, findUserPdfLinks } = require('../services/pdfLinks.service');
const { classifyIntentInfo, buildHelpAnswer } = require('../services/intent');
const {
  extractUserNameFromMessage,
  setUserName,
  getUserName,
} = require('../services/userProfile.service');

/* Utils */
const { normalizePreset, ensureDefaultMonth } = require('../utils/text');
const { extractDimensionFromMessage, injectLikeFilter } = require('../utils/dimension');
const { wantsLinksLocal, extractNameFromLogRequest, findSubmitterCandidates } = require('../utils/pdfLinks.local');
const { rewritePersonEqualsToLike, extractPersonFilterFromSql } = require('../utils/personRewrite');
const { buildMiniChart } = require('../utils/miniChart');
const { presetToCanonicalMessage, presetToDeterministicSql } = require('../utils/presets');

/* =========================================================
   ROUTE
========================================================= */

router.post('/chat', async (req, res) => {
  const { message, lang, clientId, preset } = req.body || {};
  const presetKey = normalizePreset(preset);

  const cid = String(clientId || '').trim();
  const uiLang = lang === 'es' ? 'es' : 'en';

  try {
    if (!message || !String(message).trim()) {
      return res.status(400).json({
        error: uiLang === 'es' ? 'Mensaje vacío.' : 'Empty message.',
      });
    }

    // ====== USER NAME (opcional) ======
    let userName = null;

    const extracted = extractUserNameFromMessage(message);
    if (cid && extracted) {
      setUserName(cid, extracted);
      userName = extracted;
    } else if (cid) {
      userName = getUserName(cid);
    }

    // 2.1) Intent: si es saludo/ayuda, NO ejecutar SQL
    const intentInfo = classifyIntentInfo(message);
    if (intentInfo && intentInfo.needsSql === false) {
      return res.json({
        ok: true,
        answer: buildHelpAnswer(uiLang, { userName }),
        rowCount: 0,
        aiComment: 'help_mode',
        links: null,
        userName: userName || null,
        chart: null,
      });
    }

    // ====== default: ESTE MES si no especifican periodo ======
    const messageWithDefaultPeriod = ensureDefaultMonth(message, uiLang);
   
    // ====== detectar dimension (office/team/etc) ======
    const dim = extractDimensionFromMessage(message, uiLang);

    // Usamos wantsPdfLinks service + fallback local
    const wantsLinks =
      (typeof wantsPdfLinks === 'function' ? wantsPdfLinks(message) : false) || wantsLinksLocal(message);

    // =========================================================
    // A) MODO "LOGS/PDF": determinístico
    // =========================================================
    if (wantsLinks) {
      const guessedName = extractNameFromLogRequest(message);

      const u = await findUserPdfLinks(pool, guessedName || message);
      console.log('\nPDFLINKS_LOOKUP_MESSAGE =>', message);
      console.log('PDFLINKS_USER_FOUND =>', u ? { name: u.name, nick: u.nick } : null);

      let links = null;
      let personName = null;

      if (u) {
        personName = u.name || u.nick || guessedName || null;
        links = {
          logsPdf: u.logsIndividualFile || null,
          rosterPdf: u.rosterIndividualFile || null,
          user: { name: u.name, nick: u.nick, email: u.email },
        };
      }

      let rows = [];
      let mainSql = '/* no person resolved */ SELECT 1 WHERE 1=0';
      let mainParams = [];

      if (personName) {
        mainSql = `
          SELECT
            TRIM(COALESCE(NULLIF(submitterName,''), submitter)) AS submitter,
            YEAR(dateCameIn) AS yearCameIn,
            MONTH(dateCameIn) AS monthCameIn,
            COUNT(*) AS caseCount
          FROM dmLogReportDashboard
          WHERE
            LOWER(TRIM(COALESCE(NULLIF(submitterName,''), submitter))) LIKE CONCAT('%', LOWER(TRIM(?)), '%')
            AND dateCameIn >= DATE_FORMAT(CURDATE(), '%Y-%m-01')
          GROUP BY TRIM(COALESCE(NULLIF(submitterName,''), submitter)), YEAR(dateCameIn), MONTH(dateCameIn)
        `.trim();
        mainParams = [personName];

        console.log('\n=== SQL_MAIN_EXEC ===\n', mainSql, '\nPARAMS:', mainParams);
        const [r] = await pool.query(mainSql, mainParams);
        rows = r || [];
      } else {
        console.log('\n=== SQL_MAIN_EXEC ===\n', mainSql, '\nNOTE: no person resolved from message:', message);
      }

      const personFilter = personName ? { column: 'submitterName', value: personName } : null;

      // KPI pack en logs mode: dejamos tu idea (últimos 90 días)
      const kpiMessage = uiLang === 'es' ? `${message} últimos 90 días` : `${message} last 90 days`;

      let { sql: kpiSql, params: kpiParams, windowLabel } = buildKpiPackSql(kpiMessage, {
        lang: uiLang,
        person: personFilter,
      });

      if (dim) kpiSql = injectLikeFilter(kpiSql, dim.column, dim.value);

      console.log('\n=== SQL_KPI_EXEC ===\n', kpiSql, '\nPARAMS:', kpiParams);
      const [kpiRows] = await pool.query(kpiSql, kpiParams);
      const kpiPack = Array.isArray(kpiRows) && kpiRows[0] ? kpiRows[0] : null;

      const sqlForAnswer = `/* LOGS MODE */\n${mainSql}`;
      const answer = await buildOwnerAnswer(kpiMessage, sqlForAnswer, rows, {
        kpiPack,
        kpiWindow: windowLabel,
        lang: uiLang,
        links,
        userName,
      });

      const showSql = String(process.env.SHOW_SQL || '').toLowerCase() === 'true';
      const chart = buildMiniChart(kpiMessage, uiLang, { kpiPack, rows });

      return res.json({
        ok: true,
        answer,
        rowCount: Array.isArray(rows) ? rows.length : 0,
        aiComment: 'logs_mode',
        links,
        userName: userName || null,
        chart,
        ...(showSql ? { sql: mainSql } : {}),
      });
    }

    // =========================================================
    // A.5) QUICK PRESETS: determinístico (NO IA)
    // =========================================================
    if (presetKey) {
      const canonicalMsg = presetToCanonicalMessage(presetKey, uiLang);
      const deterministicSql = presetToDeterministicSql(presetKey);

      if (canonicalMsg && deterministicSql) {
        console.log('\n=== PRESET_MODE ===', presetKey);
        console.log('CANONICAL_MESSAGE =>', canonicalMsg);
        console.log('SQL_PRESET_EXEC =>\n', deterministicSql);

        const [rowsPreset] = await pool.query(deterministicSql);

        let { sql: kpiSql, params: kpiParams, windowLabel } = buildKpiPackSql(canonicalMsg, {
          lang: uiLang,
          person: null,
        });

        console.log('\n=== SQL_KPI_EXEC (PRESET) ===\n', kpiSql, '\nPARAMS:', kpiParams);
        const [kpiRows] = await pool.query(kpiSql, kpiParams);
        const kpiPack = Array.isArray(kpiRows) && kpiRows[0] ? kpiRows[0] : null;

        const answer = await buildOwnerAnswer(
          canonicalMsg,
          `/* PRESET ${presetKey} */\n${deterministicSql}`,
          rowsPreset,
          {
            kpiPack,
            kpiWindow: windowLabel,
            lang: uiLang,
            links: null,
            userName,
          }
        );

        const chart = buildMiniChart(canonicalMsg, uiLang, {
          kpiPack,
          rows: rowsPreset,
          presetKey,
        });

        return res.json({
          ok: true,
          answer,
          rowCount: Array.isArray(rowsPreset) ? rowsPreset.length : 0,
          aiComment: `preset:${presetKey}`,
          links: null,
          userName: userName || null,
          chart,
        });
      }
    }

    // =========================================================
    // B) MODO NORMAL: IA -> SQL -> rows -> KPI -> resumen
    // =========================================================

    // 1) SQL (IA)
    let { sql, comment } = await buildSqlFromQuestion(messageWithDefaultPeriod, uiLang);
console.log('\n=== SQL_AI_RAW ===\n', sql);

    // 2) Normalizar + reglas
    sql = normalizeAnalyticsSql(sql);
    console.log('\n=== SQL_AFTER_NORMALIZE ===\n', sql);
    sql = enforceStatusRules(sql);

    // 2.1) persona => submitter LIKE (incluye name='X' si aplica)
    {
      const before = sql;
      sql = rewritePersonEqualsToLike(sql, messageWithDefaultPeriod);
      console.log('\n=== SQL_AFTER_PERSON_REWRITE ===\n', sql);
  console.log('PERSON_REWRITE_CHANGED?', before !== sql);

      if (before !== sql) console.log('\n=== SQL_REWRITE_APPLIED (PERSON) ===\n', sql);
    }

    // 2.2) dimensión => inyectar LIKE
    if (dim) {
      const before = sql;
      sql = injectLikeFilter(sql, dim.column, dim.value);
       console.log('\n=== SQL_AFTER_DIM_REWRITE ===\n', sql);
  console.log('DIM_REWRITE_CHANGED?', before !== sql);

      if (before !== sql) console.log('\n=== SQL_REWRITE_APPLIED (DIM) ===\n', sql);
    }

    // 3) Validar SQL
    let safeSql;
    try {
      safeSql = validateAnalyticsSql(sql);
      console.log('\n=== SQL_SAFE ===\n', safeSql);
    } catch (e) {
      return res.status(400).json({
        error: uiLang === 'es' ? 'SQL no permitido' : 'SQL not allowed',
        details: e.message,
        generatedSql: sql,
      });
    }

    // 4) Ejecutar SQL principal
    console.log('\n=== SQL_MAIN_EXEC ===\n', safeSql);
    const [rows] = await pool.query(safeSql);

    // 4.0) Anti "0 cases" cuando hay filtro de submitter: sugerir variantes
    if (Array.isArray(rows) && rows.length === 0) {
      const pf0 = extractPersonFilterFromSql(safeSql);

      if (pf0 && pf0.column === 'submitterName' && pf0.value) {
        const candidates = await findSubmitterCandidates(pool, pf0.value, 8);

        if (candidates.length > 0) {
          const list = candidates.map((c, i) => `${i + 1}) ${c.submitter} (${c.cnt})`).join('\n');

          const msg =
            uiLang === 'es'
              ? `No encontré casos con el nombre exacto "${pf0.value}", pero encontré estas variantes. ¿Cuál es la correcta?\n\n${list}`
              : `I didn't find cases for the exact name "${pf0.value}", but I found these close matches. Which one do you mean?\n\n${list}`;

          return res.json({
            ok: true,
            answer: msg,
            rowCount: 0,
            aiComment: 'person_disambiguation',
            links: null,
            userName: userName || null,
            chart: null,
          });
        }
      }
    }

    // 4.1) KPI Pack con MISMO filtro persona + MISMA dimensión
const personFilter = extractPersonFilterFromSql(safeSql); // <- del SQL final (safe)
console.log('\nPERSON_FILTER =>', personFilter);
console.log('\nDIM_FILTER =>', dim);

let { sql: kpiSql, params: kpiParams, windowLabel } = buildKpiPackSql(messageWithDefaultPeriod, {
  lang: uiLang,
  person: personFilter,
});

if (dim) kpiSql = injectLikeFilter(kpiSql, dim.column, dim.value);

console.log('\n=== SQL_KPI_EXEC ===\n', kpiSql, '\nPARAMS:', kpiParams);
const [kpiPack] = await pool.query(kpiSql, kpiParams);


    // 4.2) Links opcional (modo normal)
    let links = null;
    if (wantsLinksLocal(message)) {
      const guessedName = extractNameFromLogRequest(message);
      const u = await findUserPdfLinks(pool, guessedName || message);
      if (u) {
        links = {
          logsPdf: u.logsIndividualFile || null,
          rosterPdf: u.rosterIndividualFile || null,
          user: { name: u.name, nick: u.nick, email: u.email },
        };
      }
    }

    // 5) Resumen ejecutivo
    const sqlForAnswer = `/* ${comment || ''} */\n${safeSql}`;
    const answer = await buildOwnerAnswer(messageWithDefaultPeriod, sqlForAnswer, rows, {
      kpiPack,
      kpiWindow: windowLabel,
      lang: uiLang,
      links,
      userName,
    });

    const showSql = String(process.env.SHOW_SQL || '').toLowerCase() === 'true';
    const chart = buildMiniChart(messageWithDefaultPeriod, uiLang, { kpiPack, rows });

    return res.json({
      ok: true,
      answer,
      rowCount: Array.isArray(rows) ? rows.length : 0,
      aiComment: comment,
      links,
      userName: userName || null,
      chart,
      ...(showSql ? { sql: safeSql } : {}),
    });
  } catch (err) {
    console.error('Error /api/chat:', err);
    return res.status(500).json({
      error: uiLang === 'es' ? 'Error interno' : 'Internal error',
      details: err.message,
    });
  }
});

module.exports = router;
