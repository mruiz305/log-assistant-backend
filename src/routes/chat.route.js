const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middlewares/requireFirebaseAuth');

/* Infra / Guard */
const pool = require('../infra/db.pool');
const { validateAnalyticsSql } = require('../../sqlGuard');

/* Services */
const { buildSqlFromQuestion } = require('../services/sqlBuilder.service');
const { buildOwnerAnswer } = require('../services/ownerAnswer.service');
const { enforceStatusRules } = require('../services/sqlRules.service');
const { normalizeAnalyticsSql } = require('../services/sqlNormalize.service');
const { buildKpiPackSql } = require('../services/kpiPack.service');
const {
  wantsPdfLinks,
  findUserPdfLinks,
  findUserPdfCandidates,
} = require('../services/pdfLinks.service');
const { classifyIntentInfo, buildHelpAnswer } = require('../services/intent');
const {
  extractUserNameFromMessage,
  setUserName,
  getUserName,
} = require('../services/userProfile.service');
const {
  getPending,
  setPending,
  clearPending,
} = require('../services/conversationState.service');
const { tryResolvePick } = require('../services/pendingResolvers');

/* Utils */
const { normalizePreset, ensureDefaultMonth } = require('../utils/text');
const { extractDimensionFromMessage, injectLikeFilter } = require('../utils/dimension');
const {
  wantsLinksLocal,
  extractNameFromLogRequest,
  findSubmitterCandidates,
} = require('../utils/pdfLinks.local');
const {
  rewritePersonEqualsToLike,
  extractPersonFilterFromSql,
} = require('../utils/personRewrite');
const { buildMiniChart } = require('../utils/miniChart');
const {
  presetToCanonicalMessage,
  presetToDeterministicSql,
} = require('../utils/presets');

/* =========================================================
   HELPERS
========================================================= */
function clean(s) {
  return String(s || '').trim().replace(/\s+/g, ' ');
}
function same(a, b) {
  return clean(a).toLowerCase() === clean(b).toLowerCase();
}

function isGreeting(msg = '') {
  const m = String(msg || '').trim().toLowerCase();
  return /^(hola|hello|hi|buenas|buenos dias|buenas tardes|buenas noches)\b/.test(m);
}

function greetingAnswer(lang, userName) {
  const n = userName ? `, ${userName}` : '';
  if (lang === 'es') {
    // IMPORTANTE: sin bullets "•" para que BotPrettyAnswer no lo convierta en cards
    return (
      `Hola${n} 👋 Soy Nexus.\n` +
      `¿Qué quieres revisar hoy?\n\n` +
      `Ejemplos: Confirmados (mes) · Dropped últimos 7 días por oficina · Dame los logs de Maria Chachon`
    );
  }
  return (
    `Hi${n} 👋 I’m Nexus.\n` +
    `What do you want to review today?\n\n` +
    `Examples: Confirmed (month) · Dropped last 7 days by office · Give me logs for Maria Chachon`
  );
}

// evita “de maria …” / “del …”
function stripLeadingDe(s) {
  return clean(s).replace(/^(de|del)\s+/i, '').trim();
}

const NAME_STOPWORDS = new Set([
  'de', 'del', 'la', 'las', 'los', 'el',
  'y', 'e',
  'da', 'do', 'dos', 'das',
  'van', 'von',
]);

function tokenizePersonName(name) {
  const raw = stripLeadingDe(name).toLowerCase();
  let tokens = raw
    .split(/\s+/)
    .map((t) => t.replace(/[^\p{L}\p{N}]+/gu, ''))
    .filter(Boolean);

  const filtered = tokens.filter((t) => !NAME_STOPWORDS.has(t) && t.length >= 2);
  const finalTokens = (filtered.length ? filtered : tokens.filter((t) => t.length >= 2));
  return finalTokens.slice(0, 3);
}

async function findUserById(pool, id) {
  if (!id) return null;
  const [rows] = await pool.query(
    `
    SELECT
      id,
      name,
      nick,
      email,
      logsIndividualFile,
      rosterIndividualFile
    FROM stg_g_users
    WHERE id = ?
    LIMIT 1
  `.trim(),
    [String(id)]
  );
  return rows && rows[0] ? rows[0] : null;
}

/* =========================================================
   ROUTE
========================================================= */

router.post('/chat', requireAuth, async (req, res) => {
  const { message, lang, clientId, preset } = req.body || {};

  const cid = String(clientId || '').trim();
  const uiLang = lang === 'es' ? 'es' : 'en';
  const presetKey = normalizePreset(preset);

  // ✅ A PARTIR DE AQUÍ SIEMPRE USAMOS effectiveMessage
  let effectiveMessage = String(message || '');
  let forcedPick = null;
  let pendingContext = null;

  /* =======================================================
     GLOBAL PENDING PICK (ANTES DE TODO)
     - Si hay pending y NO eligió => devolvemos prompt + pick
     - Si eligió => forcedPick y retomamos originalMessage
  ======================================================= */
  if (cid) {
    const pending = getPending(cid);

    if (pending) {
      const raw = String(message || '').trim();
      const looksLikeChoice = /^\d+$/.test(raw);

      const pick = tryResolvePick(message, pending.options);

      // Si escribió otra cosa (no número), cancela pending y procesa lo nuevo
      if (!pick && !looksLikeChoice) {
        clearPending(cid);
      } else if (!pick) {
        // sigue pendiente: devolvemos SOLO el prompt + pick
        return res.json({
          ok: true,
          answer: pending.prompt,
          rowCount: 0,
          aiComment: 'pending_pick',
          links: null,
          userName: getUserName(cid) || null,
          chart: null,
          pick: { type: pending.type, options: pending.options },
        });
      } else {
        // ✅ eligió bien
        clearPending(cid);
        forcedPick = pick;
        pendingContext = pending;

        // 🔥 CLAVE: procesar la petición original (la que disparó el pick)
        effectiveMessage =
          pending.originalMessage ||
          pending.message ||
          effectiveMessage;
      }
    }
  }

  try {
    if (!effectiveMessage || !String(effectiveMessage).trim()) {
      return res.status(400).json({
        error: uiLang === 'es' ? 'Mensaje vacío.' : 'Empty message.',
      });
    }

    /* ================= USER NAME ================= */
    let userName = null;
    const extracted = extractUserNameFromMessage(effectiveMessage);

    if (cid && extracted) {
      setUserName(cid, extracted);
      userName = extracted;
    } else if (cid) {
      userName = getUserName(cid);
    }

    /* ================= GREETING (amigable) ================= */
    if (isGreeting(effectiveMessage)) {
      return res.json({
        ok: true,
        answer: greetingAnswer(uiLang, userName),
        rowCount: 0,
        aiComment: 'greeting',
        links: null,
        userName: userName || null,
        chart: null,
      });
    }

    /* ================= HELP MODE ================= */
    const intentInfo = classifyIntentInfo(effectiveMessage);
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

    /* ================= DEFAULT PERIOD ================= */
    const messageWithDefaultPeriod = ensureDefaultMonth(effectiveMessage, uiLang);

    /* ================= DIMENSION ================= */
    const dim = extractDimensionFromMessage(effectiveMessage, uiLang);

    /* ================= LINKS ================= */
    const wantsLinks =
      (typeof wantsPdfLinks === 'function' ? wantsPdfLinks(effectiveMessage) : false) ||
      wantsLinksLocal(effectiveMessage);

    /* =====================================================
       A) LOGS / PDF MODE
    ===================================================== */
    if (wantsLinks) {
      const guessedNameRaw = extractNameFromLogRequest(effectiveMessage);
      const guessedName = guessedNameRaw ? stripLeadingDe(guessedNameRaw) : null;

      const lookupText = stripLeadingDe(guessedName || effectiveMessage);

      // ✅ si hay elección, úsala
      const forcedPersonValue = forcedPick?.value
        ? stripLeadingDe(String(forcedPick.value))
        : null;

      // 1) Candidatos (solo si NO hay forcedPick)
      if (!forcedPick && cid) {
        const candidates = await findUserPdfCandidates(pool, lookupText, 8);

        if (Array.isArray(candidates) && candidates.length > 1) {
          const options = candidates.map((u) => {
            const name = clean(u.name);
            const nick = clean(u.nick);
            const sub = nick && !same(nick, name) ? nick : null;

            return {
              id: String(u.id),
              label: name || sub || '(sin nombre)', // ✅ SOLO nombre para UI
              sub,
              value: name || nick || '',
            };
          });

          const prompt =
            uiLang === 'es'
              ? `Encontré varias coincidencias para "${lookupText}". ¿Cuál es la correcta?`
              : `I found multiple matches for "${lookupText}". Which one is correct?`;

          setPending(cid, {
            type: 'user_pick',
            options,
            prompt,
            originalMessage: effectiveMessage,
            originalMode: 'logs',
          });

          return res.json({
            ok: true,
            answer: prompt,
            rowCount: 0,
            aiComment: 'pending_pick',
            links: null,
            userName: userName || null,
            chart: null,
            pick: { type: 'user_pick', options },
          });
        }
      }

      // 2) Resolver usuario/links (si hay pick, traer por ID para no equivocarnos)
      let u = null;
      if (forcedPick?.id) {
        u = await findUserById(pool, forcedPick.id);
      }
      if (!u) {
        // fallback a tu lógica existente
        u = await findUserPdfLinks(pool, forcedPersonValue || guessedName || effectiveMessage);
      }

      const personNameRaw =
        forcedPersonValue ||
        u?.name ||
        u?.nick ||
        guessedName ||
        null;

      const personName = personNameRaw ? stripLeadingDe(personNameRaw) : null;

      let links = null;
      if (u) {
        links = {
          logsPdf: u.logsIndividualFile || null,
          rosterPdf: u.rosterIndividualFile || null,
          user: { name: u.name, nick: u.nick }, // ✅ sin email
        };
      }

      let rows = [];
      let mainSql = 'SELECT 1 WHERE 1=0';
      let mainParams = [];

      // 3) Query logs: LIKE por tokens
      if (personName) {
        const parts = tokenizePersonName(personName);

        if (parts.length > 0) {
          const likeConds = parts
            .map(
              () => `
                LOWER(TRIM(COALESCE(NULLIF(submitterName,''), submitter)))
                  LIKE CONCAT('%', LOWER(TRIM(?)), '%')
              `.trim()
            )
            .join(' AND ');

          mainSql = `
            SELECT
              TRIM(COALESCE(NULLIF(submitterName,''), submitter)) AS submitter,
              YEAR(dateCameIn) AS yearCameIn,
              MONTH(dateCameIn) AS monthCameIn,
              COUNT(*) AS caseCount
            FROM dmLogReportDashboard
            WHERE
              ${likeConds}
              AND dateCameIn >= DATE_FORMAT(CURDATE(), '%Y-%m-01')
            GROUP BY
              TRIM(COALESCE(NULLIF(submitterName,''), submitter)),
              YEAR(dateCameIn),
              MONTH(dateCameIn)
            ORDER BY YEAR(dateCameIn) DESC, MONTH(dateCameIn) DESC
          `.trim();

          mainParams = parts;

          console.log('\n=== SQL_MAIN_EXEC ===\n', mainSql, '\nPARAMS:', mainParams);
          const [r] = await pool.query(mainSql, mainParams);
          rows = r || [];
        }
      }

      // 4) KPI pack
      const kpiMsg =
        uiLang === 'es'
          ? `${effectiveMessage} últimos 90 días`
          : `${effectiveMessage} last 90 days`;

      const { sql: kpiSql, params, windowLabel } = buildKpiPackSql(kpiMsg, {
        lang: uiLang,
        person: personName ? { column: 'submitterName', value: personName } : null,
      });

      const [kpiRows] = await pool.query(kpiSql, params);
      const kpiPack = kpiRows?.[0] || null;

      const answer = await buildOwnerAnswer(kpiMsg, mainSql, rows, {
        kpiPack,
        kpiWindow: windowLabel,
        lang: uiLang,
        links,
        userName,
      });

      const chart = buildMiniChart(kpiMsg, uiLang, { kpiPack, rows });

      return res.json({
        ok: true,
        answer,
        rowCount: Array.isArray(rows) ? rows.length : 0,
        aiComment: 'logs_mode',
        links,
        userName,
        chart,
      });
    }

    /* =====================================================
       A.5) PRESETS
    ===================================================== */
    if (presetKey) {
      const canonicalMsg = presetToCanonicalMessage(presetKey, uiLang);
      const deterministicSql = presetToDeterministicSql(presetKey);

      if (canonicalMsg && deterministicSql) {
        const [rowsPreset] = await pool.query(deterministicSql);

        const { sql: kpiSql, params: kpiParams, windowLabel } = buildKpiPackSql(canonicalMsg, {
          lang: uiLang,
          person: null,
        });

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

    /* =====================================================
       B) NORMAL MODE (IA → SQL)
    ===================================================== */
    let { sql, comment } = await buildSqlFromQuestion(messageWithDefaultPeriod, uiLang);

    sql = normalizeAnalyticsSql(sql);
    sql = enforceStatusRules(sql);
    sql = rewritePersonEqualsToLike(sql, messageWithDefaultPeriod);

    if (dim) {
      sql = injectLikeFilter(sql, dim.column, dim.value);
    }

    let safeSql;
    try {
      safeSql = validateAnalyticsSql(sql);
    } catch (e) {
      return res.status(400).json({
        error: uiLang === 'es' ? 'SQL no permitido' : 'SQL not allowed',
        details: e.message,
      });
    }

    // ✅ Si venimos de person_pick, aplica el pick al SQL principal (no solo al KPI)
    // (reemplaza el valor anterior dentro del SQL, sin duplicar filtros)
    if (forcedPick?.value && pendingContext?.type === 'person_pick') {
      const pf = extractPersonFilterFromSql(safeSql);
      if (pf?.value && String(pf.value).trim() && String(pf.value) !== String(forcedPick.value)) {
        const from = String(pf.value);
        const to = String(forcedPick.value);
        safeSql = safeSql.split(from).join(to);
      }
    }

    /* =====================================================
       GLOBAL PERSON DISAMBIGUATION (submitterName)
    ===================================================== */
    const pf = extractPersonFilterFromSql(safeSql);

    if (!forcedPick && cid && pf?.value) {
      const candidates = await findSubmitterCandidates(pool, pf.value, 8);

      if (candidates.length >= 2) {
        const msg =
          uiLang === 'es'
            ? `Encontré varias coincidencias para "${pf.value}". ¿Cuál es la correcta?`
            : `I found multiple matches for "${pf.value}". Which one do you mean?`;

        const options = candidates.map((c) => ({
          id: c.submitter,
          label: c.submitter,
          sub: `${c.cnt} cases`,
          value: c.submitter,
        }));

        setPending(cid, {
          type: 'person_pick',
          options,
          prompt: msg,
          originalMessage: effectiveMessage,
          originalMode: 'normal',
        });

        return res.json({
          ok: true,
          answer: msg,
          rowCount: 0,
          aiComment: 'person_disambiguation',
          userName,
          chart: null,
          pick: { type: 'person_pick', options },
        });
      }
    }

    /* ================= EXECUTE ================= */
    const [rows] = await pool.query(safeSql);

    const personFilter = forcedPick?.value
      ? { column: 'submitterName', value: String(forcedPick.value) }
      : extractPersonFilterFromSql(safeSql);

    const { sql: kpiSql, params, windowLabel } = buildKpiPackSql(messageWithDefaultPeriod, {
      lang: uiLang,
      person: personFilter,
    });

    const [kpiRows] = await pool.query(kpiSql, params);
    const kpiPack = kpiRows?.[0] || null;

    const answer = await buildOwnerAnswer(messageWithDefaultPeriod, safeSql, rows, {
      kpiPack,
      kpiWindow: windowLabel,
      lang: uiLang,
      userName,
    });

    const chart = buildMiniChart(messageWithDefaultPeriod, uiLang, { kpiPack, rows });

    return res.json({
      ok: true,
      answer,
      rowCount: Array.isArray(rows) ? rows.length : 0,
      aiComment: comment,
      userName,
      chart,
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
