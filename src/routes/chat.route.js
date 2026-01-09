const express = require('express');
const router = express.Router();

const pool = require('../infra/db.pool');
const { validateAnalyticsSql } = require('../../sqlGuard');

const { buildSqlFromQuestion } = require('../services/sqlBuilder.service');
const { buildOwnerAnswer } = require('../services/ownerAnswer.service');
const { enforceStatusRules } = require('../services/sqlRules.service');
const { normalizeAnalyticsSql } = require('../services/sqlNormalize.service');
const { buildKpiPackSql } = require('../services/kpiPack.service');
const { wantsPdfLinks, findUserPdfLinks } = require('../services/pdfLinks.service');

/* =========================================================
   HELPERS
========================================================= */
function normalizeText(s = '') {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function questionMentionsClient(message = '') {
  const q = normalizeText(message);
  return (
    q.includes('cliente') ||
    q.includes('client') ||
    q.includes('patient') ||
    q.includes('paciente') ||
    q.includes('lead') ||
    q.includes('case') ||
    q.includes('caso') ||
    q.includes('claimant') ||
    q.includes('injured') ||
    q.includes('nombre del caso') ||
    q.includes('nombre del cliente')
  );
}

function questionMentionsIntake(message = '') {
  const q = normalizeText(message);
  return (
    q.includes('intake') ||
    q.includes('intake specialist') ||
    q.includes('locked down') ||
    q.includes('lock down') ||
    q.includes('cerrado por') ||
    q.includes('bloqueado por')
  );
}

/**
 * Detecta si piden links/pdf/logs (singular/plural).
 * Nota: esta función viene de pdfLinks.service, pero por si esa regex aún no está lista,
 * usamos una local robusta para el "modo logs".
 */
function wantsLinksLocal(message = '') {
  return /(pdf|url|link|enlace|log\b|logs\b|log completo|full log|details|roster|reporte|report)/i.test(
    String(message || '')
  );
}

/**
 * Extrae un "nombre probable" desde pedidos de logs/pdf sin IA.
 * Ej: "Give me the Lalesca Castilblanco log." => "Lalesca Castilblanco"
 */
function extractNameFromLogRequest(message = '') {
  const cleaned = String(message || '')
    .replace(/(give me|please|por favor|dame|mu[eé]strame|send me)/gi, ' ')
    .replace(/\b(the|el|la|los|las)\b/gi, ' ')
    .replace(/\b(log|logs|pdf|link|url|roster|reporte|report|details|completo)\b/gi, ' ')
    .replace(/[^\p{L}\p{N}\s'-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return cleaned.length >= 3 ? cleaned : null;
}

/**
 * Reglas:
 * - Si la IA usa intakeSpecialist='X' y NO pidieron intake => cambia a submitter LIKE
 * - Si la IA usa submitterName='X' => cambia a submitter LIKE
 * - Si la IA usa COALESCE(...)='X' => cambia a LIKE
 * - Si la IA usa name='X' y NO pidieron cliente => cambia a submitter LIKE (evita confundir "name")
 */
function rewritePersonEqualsToLike(sql, message) {
  let s = String(sql || '');

  const esc = (v) => String(v || '').replace(/'/g, "''");

  const isIntakeAsked = questionMentionsIntake(message);
  const isClientAsked = questionMentionsClient(message);

  // intakeSpecialist = 'X'
  const rxIntakeEq =
    /(?:\b\w+\b\.)?(?:`?\w+`?\.)?`?intakeSpecialist`?\s*=\s*'([^']+)'/gi;

  // submitterName = 'X'
  const rxSubmitterEq =
    /(?:\b\w+\b\.)?(?:`?\w+`?\.)?`?submitterName`?\s*=\s*'([^']+)'/gi;

  // TRIM(COALESCE(NULLIF(submitterName,''),submitter)) = 'X'
  const rxCoalesceSubmitterEq =
    /TRIM\s*\(\s*COALESCE\s*\(\s*NULLIF\s*\(\s*submitterName\s*,\s*''\s*\)\s*,\s*submitter\s*\)\s*\)\s*=\s*'([^']+)'/gi;

  // name = 'X'  (en tu tabla es nombre del cliente/lead)
  const rxNameEq =
    /(?:\b\w+\b\.)?(?:`?\w+`?\.)?`?name`?\s*=\s*'([^']+)'/gi;

  // Si NO pidieron intake, fuerza intakeSpecialist -> submitter LIKE
  if (!isIntakeAsked) {
    s = s.replace(rxIntakeEq, (m, name) => {
      const v = esc(name);
      return `LOWER(TRIM(COALESCE(NULLIF(submitterName,''), submitter))) LIKE CONCAT('%', LOWER(TRIM('${v}')), '%')`;
    });
  }

  // submitterName='X' -> LIKE (coalesce submitterName/submitter)
  s = s.replace(rxSubmitterEq, (m, name) => {
    const v = esc(name);
    return `LOWER(TRIM(COALESCE(NULLIF(submitterName,''), submitter))) LIKE CONCAT('%', LOWER(TRIM('${v}')), '%')`;
  });

  // COALESCE(...)='X' -> LIKE
  s = s.replace(rxCoalesceSubmitterEq, (m, name) => {
    const v = esc(name);
    return `LOWER(TRIM(COALESCE(NULLIF(submitterName,''), submitter))) LIKE CONCAT('%', LOWER(TRIM('${v}')), '%')`;
  });

  // name='X' -> si NO pidieron cliente/caso, reescribe a submitter LIKE
  if (!isClientAsked) {
    s = s.replace(rxNameEq, (m, name) => {
      const v = esc(name);
      return `LOWER(TRIM(COALESCE(NULLIF(submitterName,''), submitter))) LIKE CONCAT('%', LOWER(TRIM('${v}')), '%')`;
    });
  }

  return s;
}

/**
 * Extrae filtro de persona para pasarlo al KPI pack
 * Retorna: { column: 'submitterName'|'intakeSpecialist'|'attorney', value: '...' } | null
 */
function extractPersonFilterFromSql(sql = '') {
  const s = String(sql || '');

  // LOWER(TRIM(COALESCE(NULLIF(submitterName,''), submitter))) LIKE CONCAT('%', LOWER(TRIM('X')), '%')
  let m = s.match(
    /LOWER\s*\(\s*TRIM\s*\(\s*COALESCE\s*\(\s*NULLIF\s*\(\s*submitterName\s*,\s*''\s*\)\s*,\s*submitter\s*\)\s*\)\s*\)\s+LIKE\s+CONCAT\s*\(\s*'%'\s*,\s*LOWER\s*\(\s*TRIM\s*\(\s*'([^']+)'\s*\)\s*\)\s*,\s*'%'\s*\)/i
  );
  if (m) return { column: 'submitterName', value: m[1] };

  // submitterName LIKE '%X%'
  m = s.match(/\bsubmitterName\s+LIKE\s+'%([^']+)%'/i);
  if (m) return { column: 'submitterName', value: m[1] };

  // intakeSpecialist LIKE '%X%'
  m = s.match(/\bintakeSpecialist\s+LIKE\s+'%([^']+)%'/i);
  if (m) return { column: 'intakeSpecialist', value: m[1] };

  // attorney LIKE '%X%'
  m = s.match(/\battorney\s+LIKE\s+'%([^']+)%'/i);
  if (m) return { column: 'attorney', value: m[1] };

  // submitterName = 'X'
  m = s.match(/\bsubmitterName\s*=\s*'([^']+)'/i);
  if (m) return { column: 'submitterName', value: m[1] };

  // intakeSpecialist = 'X'
  m = s.match(/\bintakeSpecialist\s*=\s*'([^']+)'/i);
  if (m) return { column: 'intakeSpecialist', value: m[1] };

  return null;
}

/* =========================================================
   ROUTE
========================================================= */
router.post('/chat', async (req, res) => {
  const { message, lang } = req.body || {};
  const uiLang = lang === 'es' ? 'es' : 'en';

  try {
    if (!message || !String(message).trim()) {
      return res.status(400).json({
        error: uiLang === 'es' ? 'Mensaje vacío.' : 'Empty message.',
      });
    }

    // Usamos la detección del service (si está bien) + fallback robusto
    const wantsLinks =
      (typeof wantsPdfLinks === 'function' ? wantsPdfLinks(message) : false) || wantsLinksLocal(message);

    // =========================================================
    // A) MODO "LOGS/PDF": determinístico (NO dependas de la IA)
    // =========================================================
    if (wantsLinks) {
      const guessedName = extractNameFromLogRequest(message);

      // 1) resolver persona desde stg_g_users usando guessedName
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

      // 2) Snapshot de ESTE MES por submitter
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

      // 3) KPI pack con filtro de persona si existe
      const personFilter = personName ? { column: 'submitterName', value: personName } : null;

      // ✅ CAMBIO PRUDENTE: SOLO en modo logs/roster, forzamos "últimos 90 días" para el KPI pack.
      //    No tocamos el modo normal, ni cambiamos tu SQL principal (mainSql).
      const kpiMessage =
        uiLang === 'es' ? `${message} últimos 90 días` : `${message} last 90 days`;

      const { sql: kpiSql, params: kpiParams, windowLabel } = buildKpiPackSql(kpiMessage, {
        lang: uiLang,
        person: personFilter,
      });

      console.log('\n=== SQL_KPI_EXEC ===\n', kpiSql, '\nPARAMS:', kpiParams);
      const [kpiRows] = await pool.query(kpiSql, kpiParams);
      const kpiPack = Array.isArray(kpiRows) && kpiRows[0] ? kpiRows[0] : null;

      const sqlForAnswer = `/* LOGS MODE */\n${mainSql}`;
      const answer = await buildOwnerAnswer(message, sqlForAnswer, rows, {
        kpiPack,
        kpiWindow: windowLabel,
        lang: uiLang,
        links,
      });

      const showSql = String(process.env.SHOW_SQL || '').toLowerCase() === 'true';

      return res.json({
        ok: true,
        answer,
        rowCount: Array.isArray(rows) ? rows.length : 0,
        aiComment: 'logs_mode',
        links, // ✅ aquí SIEMPRE devolvemos links si los resolvimos
        ...(showSql ? { sql: mainSql } : {}),
      });
    }

    // =========================================================
    // B) MODO NORMAL: IA -> SQL -> rows -> KPI -> resumen
    // =========================================================

    // 1) SQL (IA)
    let { sql, comment } = await buildSqlFromQuestion(message, uiLang);

    // 2) Normalizar + reglas
    sql = normalizeAnalyticsSql(sql);
    sql = enforceStatusRules(sql);

    // 2.1) persona => submitter LIKE (incluye name='X' si aplica)
    const beforeRewrite = sql;
    sql = rewritePersonEqualsToLike(sql, message);

    if (beforeRewrite !== sql) {
      console.log('\n=== SQL_REWRITE_APPLIED ===\n', sql);
    }

    // 3) Validar SQL
    let safeSql;
    try {
      safeSql = validateAnalyticsSql(sql);
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

    // 4.1) KPI Pack con MISMO filtro persona si existe
    const personFilter = extractPersonFilterFromSql(safeSql);
    console.log('\nPERSON_FILTER =>', personFilter);

    const { sql: kpiSql, params: kpiParams, windowLabel } = buildKpiPackSql(message, {
      lang: uiLang,
      person: personFilter,
    });

    console.log('\n=== SQL_KPI_EXEC ===\n', kpiSql, '\nPARAMS:', kpiParams);
    const [kpiRows] = await pool.query(kpiSql, kpiParams);
    const kpiPack = Array.isArray(kpiRows) && kpiRows[0] ? kpiRows[0] : null;

    // 4.2) Links opcional si el usuario lo pidió (modo normal)
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
    const answer = await buildOwnerAnswer(message, sqlForAnswer, rows, {
      kpiPack,
      kpiWindow: windowLabel,
      lang: uiLang,
      links,
    });

    const showSql = String(process.env.SHOW_SQL || '').toLowerCase() === 'true';

    return res.json({
      ok: true,
      answer,
      rowCount: Array.isArray(rows) ? rows.length : 0,
      aiComment: comment,
      links,
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
