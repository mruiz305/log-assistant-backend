// src/routes/chat.route.js
const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middlewares/requireFirebaseAuth');

/* Infra / Guard */
const pool = require('../infra/db.pool');
const { validateAnalyticsSql } = require('../../sqlGuard');

/* ✅ Firebase Admin inicializado (NO usar firebase-admin directo) */
const { admin } = require('../infra/firebaseAdmin');

/* Services */
const { buildSqlFromQuestion } = require('../services/sqlBuilder.service');
const { buildOwnerAnswer } = require('../services/ownerAnswer.service');
const { enforceOnlyFullGroupBy } = require('../services/sqlRules.service');
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
  getContext,
  setContext,
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
const { getUserMemory } = require('../services/aiMemory.service');

const {
  wantsToChange,
  wantsToClear,
  dimKeyFromColumn,
  cloneFilters,
  applyLockedFiltersToSql,
  buildSqlFixMessage,
} = require('../utils/chatContextLocks');

const { wantsPerformance, resolvePerformanceGroupBy } = require('../utils/performance');
const { buildPerformanceKpiSql } = require('../services/performanceKpi.service');

/* =========================================================
   HELPERS
========================================================= */
function extractOfficeOfPerson(msg = '', uiLang = 'es') {
  const s = String(msg || '').trim();

  // "la oficina de tony", "oficina de Tony", "office of Tony"
  const rxEs = /\b(?:la\s+)?oficina\s+de\s+([^\n,.;!?]{2,60})/i;
  const rxEn = /\boffice\s+of\s+([^\n,.;!?]{2,60})/i;

  const m = (uiLang === 'es' ? s.match(rxEs) : s.match(rxEn));
  if (!m || !m[1]) return null;

  return stripLeadingDe(m[1]);
}

function extractOfficeFromMessage(msg = '', uiLang = 'en') {
  const raw = String(msg || '').trim();

  // Español: "oficina de X" / "office of X" en inglés
  const rxEs = /\boficina\s+de\s+([^\n\r]{2,60})$/i;
  const rxEn = /\boffice\s+of\s+([^\n\r]{2,60})$/i;

  const m = (uiLang === 'es' ? raw.match(rxEs) : raw.match(rxEn));
  if (!m || !m[1]) return null;

  // corta ruido típico al final
  let val = m[1].trim();
  val = val.replace(/[?.!,;:]+$/g, '').trim();

  if (val.length < 2) return null;
  return val;
}


async function resolveOfficeNameByPerson(poolConn, personName) {
  const p = String(personName || '').trim();
  if (!p) return null;

  // Tomamos la oficina más frecuente en el periodo reciente (últimos 90 días)
  const [rows] = await poolConn.query(
    `
    SELECT
      TRIM(OfficeName) AS officeName,
      COUNT(*) AS cnt
    FROM dmLogReportDashboard
    WHERE
      dateCameIn >= DATE_SUB(CURDATE(), INTERVAL 90 DAY)
      AND TRIM(OfficeName) <> ''
      AND LOWER(TRIM(COALESCE(NULLIF(submitterName,''), submitter)))
          LIKE CONCAT('%', LOWER(TRIM(?)), '%')
    GROUP BY TRIM(OfficeName)
    ORDER BY cnt DESC
    LIMIT 1
    `.trim(),
    [p]
  );

  return rows && rows[0] && rows[0].officeName ? String(rows[0].officeName).trim() : null;
}

function makeReqId() {
  return Math.random().toString(16).slice(2) + Date.now().toString(16);
}

function shouldLogSql(req) {
  const debug = req.query?.debug === '1' || req.body?.debug === true;
  const env = (process.env.LOG_SQL || '').toLowerCase() === 'true';
  return debug || env;
}

function logSql(reqId, label, sql, params) {
  console.log(`\n[sql][${reqId}] ${label}`);
  console.log(sql);
  if (params && Array.isArray(params) && params.length) {
    console.log(`[sql][${reqId}] params:`, params);
  }
}

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
    return (
      `Hola${n} 👋 Soy Nexus.\n` +
      `¿Qué quieres revisar hoy?\n\n` +
      `Ejemplos: Confirmados (mes) · Dropped últimos 7 días por oficina · Dame los logs de Maria Chacon`
    );
  }
  return (
    `Hi${n} 👋 I’m Nexus.\n` +
    `What do you want to review today?\n\n` +
    `Examples: Confirmed (month) · Dropped last 7 days by office · Give me logs for Maria Chacon`
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

async function findUserById(poolConn, id) {
  if (!id) return null;
  const [rows] = await poolConn.query(
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

async function findRosterRepCandidates(poolConn, q, limit = 8) {
  const needle = String(q || '').trim().toLowerCase();
  if (!needle) return [];

  const [rows] = await poolConn.query(
    `
    SELECT
      id,
      COALESCE(NULLIF(TRIM(nick),''), TRIM(name)) AS label,
      TRIM(name) AS name,
      TRIM(nick) AS nick
    FROM stg_g_users
    WHERE
      LOWER(TRIM(COALESCE(nick,''))) LIKE CONCAT('%', ?, '%')
      OR LOWER(TRIM(COALESCE(name,''))) LIKE CONCAT('%', ?, '%')
    ORDER BY
      (LOWER(TRIM(COALESCE(nick,''))) = ?) DESC,
      (LOWER(TRIM(COALESCE(name,''))) = ?) DESC,
      label ASC
    LIMIT ?
    `,
    [needle, needle, needle, needle, Number(limit)]
  );

  return (rows || []).filter((r) => r.label && String(r.label).trim());
}

function sanitizeSqlTypos(sql = '') {
  let s = String(sql || '');
  s = s.replace(/\bdateCameIn'\b/g, 'dateCameIn');
  s = s.replace(/\(\s*dateCameIn'\s*\)/g, '(dateCameIn)');
  return s;
}

/* =========================
   Period injection (stable)
========================= */
function injectDateCameInRange(sql, fromExpr, toExpr) {
  let s = String(sql || '').trim();
  if (!s) return s;

  s = s.replace(/;\s*$/g, '');

  const cond = `dateCameIn >= ${fromExpr} AND dateCameIn < ${toExpr}`;
  if (s.toLowerCase().includes(cond.toLowerCase())) return s;

  const cutRx = /\b(group\s+by|order\s+by|limit)\b/i;
  const m = s.match(cutRx);
  const cutAt = m ? m.index : -1;

  const head = cutAt >= 0 ? s.slice(0, cutAt).trimEnd() : s;
  const tail = cutAt >= 0 ? s.slice(cutAt) : '';

  if (/\bwhere\b/i.test(head)) return `${head} AND ${cond}\n${tail}`.trim();
  return `${head}\nWHERE ${cond}\n${tail}`.trim();
}

function escapeSqlLikeValue(v) {
  // Escapa comillas simples para SQL literal seguro
  return String(v ?? '').replace(/'/g, "''").trim();
}

function injectSubmitterNameLike(sql = '', personValue = '') {
  const s0 = String(sql || '').trim();
  const v = escapeSqlLikeValue(personValue);
  if (!s0 || !v) return s0;

  // condición estándar: SIEMPRE submitterName con fallback a submitter
  const cond = `
    LOWER(TRIM(COALESCE(NULLIF(submitterName,''), submitter)))
      LIKE CONCAT('%', LOWER(TRIM('${v}')), '%')
  `.trim();

  // evita duplicar
  if (s0.toLowerCase().includes(cond.toLowerCase())) return s0;

  const s = s0.replace(/;\s*$/g, '');
  const cutRx = /\b(group\s+by|order\s+by|limit)\b/i;
  const m = s.match(cutRx);
  const cutAt = m ? m.index : -1;

  const head = cutAt >= 0 ? s.slice(0, cutAt).trimEnd() : s;
  const tail = cutAt >= 0 ? s.slice(cutAt) : '';

  if (/\bwhere\b/i.test(head)) return `${head} AND ${cond}\n${tail}`.trim();
  return `${head}\nWHERE ${cond}\n${tail}`.trim();
}

/**
 * ✅ Bridge: firma compatible con applyLockedFiltersToSql(sql, injector, filters)
 * - Si column es "__SUBMITTER__", aplica submitterName LIKE.
 * - Si no, usa injectLikeFilter normal.
 */
function injectLikeFilterSmart(sql = '', column = '', value = '') {
  const col = String(column || '').trim();
  if (!col) return String(sql || '').trim();

  if (col === '__SUBMITTER__' || col.toLowerCase() === 'submittername' || col.toLowerCase() === 'submitter') {
    return injectSubmitterNameLike(sql, value);
  }
  return injectLikeFilter(sql, col, value);
}

function ensurePeriodFilterStable(sql = '', msg = '') {
  const s = String(sql || '');
  const m = String(msg || '').toLowerCase();

  const hasDateFilter =
    /\bdateCameIn\b/i.test(s) &&
    (/\bbetween\b/i.test(s) || /dateCameIn\s*>=/i.test(s) || /dateCameIn\s*</i.test(s));

  if (hasDateFilter) return s;

  if (/(mes\s+pasado|last\s+month)/i.test(m)) {
    const from = "DATE_FORMAT(DATE_SUB(CURDATE(), INTERVAL 1 MONTH), '%Y-%m-01')";
    const to = "DATE_FORMAT(CURDATE(), '%Y-%m-01')";
    return injectDateCameInRange(s, from, to);
  }

  // default: este mes
  const from = "DATE_FORMAT(CURDATE(), '%Y-%m-01')";
  const to = "DATE_ADD(DATE_FORMAT(CURDATE(), '%Y-%m-01'), INTERVAL 1 MONTH)";
  return injectDateCameInRange(s, from, to);
}

/* =========================
   Follow-up context
========================= */
function isFollowUpQuestion(msg = '', uiLang = 'en') {
  const m = String(msg || '').toLowerCase().trim();
  const es = /(y\s+el\s+mes\s+pasado|mes\s+pasado|y\s+ayer|y\s+hoy|y\s+esta\s+semana|y\s+la\s+semana\s+pasada|y\s+en\s+los\s+últimos\s+\d+\s+d[ií]as)\b/;
  const en = /(and\s+last\s+month|last\s+month|and\s+yesterday|today|this\s+week|last\s+week|last\s+\d+\s+days)\b/;
  return uiLang === 'es' ? es.test(m) : en.test(m);
}

function mentionsPersonExplicitly(msg = '') {
  const m = String(msg || '');

  // ✅ si es "oficina de X" / "office of X", NO es persona
  if (/\boficina\s+de\s+/i.test(m)) return false;
  if (/\boffice\s+of\s+/i.test(m)) return false;

  return /(submittername|submitter|representante|rep|\bde\s+[\p{L}\p{N}]+|\bfor\s+[\p{L}\p{N}]+)/iu.test(m);
}


function injectPersonFromContext(msg, uiLang, lastPerson) {
  if (!lastPerson) return msg;
  if (uiLang === 'es') return `${msg} de ${lastPerson}`;
  return `${msg} for ${lastPerson}`;
}

/* =========================
   Suggestions helper
========================= */
function buildSuggestions(message = '', uiLang = 'en', mem = null) {
  const m = String(message || '').trim();
  const mentionsRep = /(rep|representante|submitter|marketing)/i.test(m);
  const prefer = Array.isArray(mem?.followupOrder) ? mem.followupOrder : null;

  if (mentionsRep) {
    const baseEs = ['Ver confirmados', 'Ver dropped', 'Cambiar período (hoy / 7 días / mes)', 'Ver lista de casos'];
    const baseEn = ['See confirmed', 'See dropped', 'Change time window (today / 7d / month)', 'See case list'];
    const base = uiLang === 'es' ? baseEs : baseEn;

    if (prefer) {
      const rank = (x) => {
        const k = String(x).toLowerCase();
        if (k.includes('confirm')) return prefer.indexOf('confirmed');
        if (k.includes('drop')) return prefer.indexOf('dropped');
        if (k.includes('per')) return prefer.indexOf('by_period');
        return 99;
      };
      return base.slice().sort((a, b) => (rank(a) - rank(b)));
    }
    return base;
  }

  return uiLang === 'es'
    ? ['Últimos 7 días', 'Este mes', 'Ver top reps', 'Ver dropped']
    : ['Last 7 days', 'This month', 'Top reps', 'See dropped'];
}

/* =========================
   ONLY_FULL_GROUP_BY patch
========================= */
function ensureYearMonthGroupBy(sql = '') {
  const s = String(sql || '');
  const hasAgg = /\b(count|sum|avg|min|max)\s*\(/i.test(s);
  const hasYearMonth =
    /\bYEAR\s*\(\s*dateCameIn\s*\)/i.test(s) ||
    /\bMONTH\s*\(\s*dateCameIn\s*\)/i.test(s);

  const hasGroupBy = /\bGROUP\s+BY\b/i.test(s);

  if (hasAgg && hasYearMonth && !hasGroupBy) {
    return `${s.trim()} GROUP BY YEAR(dateCameIn), MONTH(dateCameIn)`;
  }
  return s;
}

/* =========================================================
   ROUTE
========================================================= */

router.post('/chat', requireAuth, async (req, res) => {
  const reqId = makeReqId();
  const logEnabled = shouldLogSql(req);

  const { message, lang, clientId, preset } = req.body || {};
  const uid = req.user?.uid || null;

  const userMemory = uid ? await getUserMemory(uid) : null;

  const cid = String(clientId || '').trim();
  const uiLang = lang === 'es' ? 'es' : 'en';
  const presetKey = normalizePreset(preset);

  const debug = req.query?.debug === '1' || req.body?.debug === true;

  let effectiveMessage = String(message || '');
  let forcedPick = null;
  let pendingContext = null;

  // ✅ DEBUG: log clientId + message (IMPORTANT: AFTER effectiveMessage init)
  if ((req.query?.debug === '1' || req.body?.debug === true) || (process.env.LOG_CHAT || '').toLowerCase() === 'true') {
    console.log('[chat] cid=', cid, 'msg=', effectiveMessage);
  }

  /* =======================================================
     GLOBAL PENDING PICK (ANTES DE TODO)
  ======================================================= */
  if (cid) {
    const pending = getPending(cid);
    if (pending) {
      const raw = String(message || '').trim();
      const looksLikeChoice = /^\d+$/.test(raw);

      const pick = tryResolvePick(message, pending.options);

      if (!pick && !looksLikeChoice) {
        clearPending(cid);
      } else if (!pick) {
        return res.json({
          ok: true,
          answer: pending.prompt,
          rowCount: 0,
          aiComment: 'pending_pick',
          links: null,
          userName: getUserName(cid) || null,
          chart: null,
          pick: { type: pending.type, options: pending.options },
          suggestions: null,
        });
      } else {
        clearPending(cid);
        forcedPick = pick;
        pendingContext = pending;
        effectiveMessage = pending.originalMessage || pending.message || effectiveMessage;
      }
    }
  }

  try {
    if (!effectiveMessage || !String(effectiveMessage).trim()) {
      return res.status(400).json({ error: uiLang === 'es' ? 'Mensaje vacío.' : 'Empty message.' });
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

    /* ================= GREETING ================= */
    if (isGreeting(effectiveMessage)) {
      const answer = greetingAnswer(uiLang, userName);

      return res.json({
        ok: true,
        answer,
        rowCount: 0,
        aiComment: 'greeting',
        links: null,
        userName: userName || null,
        chart: null,
        suggestions: buildSuggestions(effectiveMessage, uiLang, userMemory),
      });
    }

    /* =====================================================
       FOLLOW-UP CONTEXT injection (message-level)
    ===================================================== */
    if (cid) {
      const ctx0 = getContext(cid) || {};
      const filters0 = ctx0.filters || {};
      const lockedPerson = filters0?.person?.locked ? String(filters0.person.value || '').trim() : null;
      const carryPerson = lockedPerson || (ctx0.lastPerson ? String(ctx0.lastPerson).trim() : null);

      const userChangingPerson = wantsToChange(effectiveMessage, 'person') || wantsToClear(effectiveMessage, 'person');

      if (carryPerson && !userChangingPerson && !mentionsPersonExplicitly(effectiveMessage)) {
        if (isFollowUpQuestion(effectiveMessage, uiLang) || effectiveMessage.trim().length <= 40) {
          effectiveMessage = injectPersonFromContext(effectiveMessage, uiLang, carryPerson);
        }
      }
    }

    /* ================= HELP MODE ================= */
    const intentInfo = classifyIntentInfo(effectiveMessage);
    if (intentInfo && intentInfo.needsSql === false) {
      const answer = buildHelpAnswer(uiLang, { userName });
      const suggestions = buildSuggestions(effectiveMessage, uiLang, userMemory);

      return res.json({
        ok: true,
        answer,
        rowCount: 0,
        aiComment: 'help_mode',
        links: null,
        userName: userName || null,
        chart: null,
        suggestions,
      });
    }

    /* ================= DEFAULT PERIOD ================= */
    function hasExplicitPeriod(msg = '') {
      const m = String(msg || '').toLowerCase();
      if (/(hoy|ayer|mañana|esta semana|semana pasada|este mes|mes pasado|últimos?\s+\d+\s+d[ií]as|ultimos?\s+\d+\s+dias)/i.test(m)) return true;
      if (/(today|yesterday|tomorrow|this week|last week|this month|last month|last\s+\d+\s+days)/i.test(m)) return true;
      return false;
    }

    function applyDefaultWindow(msg, uiLang2, mem) {
      if (!mem || hasExplicitPeriod(msg)) return msg;

      const w = mem.defaultWindow || 'this_month';
      if (w === 'last_7_days') return uiLang2 === 'es' ? `${msg} últimos 7 días` : `${msg} last 7 days`;
      if (w === 'last_30_days') return uiLang2 === 'es' ? `${msg} últimos 30 días` : `${msg} last 30 days`;
      return msg;
    }

    const msgWithUserDefault = applyDefaultWindow(effectiveMessage, uiLang, userMemory);
    const messageWithDefaultPeriod = ensureDefaultMonth(msgWithUserDefault, uiLang);

    // ✅ FIX: si el usuario dice "oficina de X", eso NO es persona; es OfficeName
const officeFromMsg = extractOfficeFromMessage(effectiveMessage, uiLang);
const officeDim =
  officeFromMsg
    ? { key: 'office', column: 'OfficeName', value: officeFromMsg }
    : null;

    /* ================= DIMENSION ================= */
    const dim = extractDimensionFromMessage(effectiveMessage, uiLang);

    /* ================= LINKS ================= */
    const wantsLinks =
      (typeof wantsPdfLinks === 'function' ? wantsPdfLinks(effectiveMessage) : false) ||
      wantsLinksLocal(effectiveMessage);

    const suggestionsBase = buildSuggestions(effectiveMessage, uiLang, userMemory);

    /* =====================================================
       A) LOGS / PDF MODE
    ===================================================== */
    if (wantsLinks) {
      const guessedNameRaw = extractNameFromLogRequest(effectiveMessage);
      const guessedName = guessedNameRaw ? stripLeadingDe(guessedNameRaw) : null;

      const lookupText = stripLeadingDe(guessedName || effectiveMessage);

      const forcedPersonValue = forcedPick?.value
        ? stripLeadingDe(String(forcedPick.value))
        : null;

      if (!forcedPick && cid) {
        const candidates = await findUserPdfCandidates(pool, lookupText, 8);

        if (Array.isArray(candidates) && candidates.length > 1) {
          const options = candidates.map((u) => {
            const name = clean(u.name);
            const nick = clean(u.nick);
            const sub = nick && !same(nick, name) ? nick : null;

            return {
              id: String(u.id),
              label: name || sub || '(sin nombre)',
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
            suggestions: null,
          });
        }
      }

      let u = null;
      if (forcedPick?.id) u = await findUserById(pool, forcedPick.id);
      if (!u) u = await findUserPdfLinks(pool, forcedPersonValue || guessedName || effectiveMessage);

      const personNameRaw =
        forcedPersonValue ||
        u?.name ||
        u?.nick ||
        guessedName ||
        null;

      const personName = personNameRaw ? stripLeadingDe(personNameRaw) : null;

      if (cid && personName) setContext(cid, { lastPerson: personName });

      let links = null;
      if (u) {
        links = {
          logsPdf: u.logsIndividualFile || null,
          rosterPdf: u.rosterIndividualFile || null,
          user: { name: u.name, nick: u.nick },
        };
      }

      let rows = [];
      let mainSql = 'SELECT 1 WHERE 1=0';
      let mainParams = [];

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

          if (logEnabled) logSql(reqId, 'logs_mode mainSql', mainSql, mainParams);

          const [r] = await pool.query(mainSql, mainParams);
          rows = r || [];
        }
      }

      const kpiMsg =
        uiLang === 'es'
          ? `${effectiveMessage} últimos 90 días`
          : `${effectiveMessage} last 90 days`;

      const { sql: kpiSql, params, windowLabel } = buildKpiPackSql(kpiMsg, {
        lang: uiLang,
        person: personName ? { column: 'submitterName', value: personName } : null,
      });

      if (logEnabled) logSql(reqId, 'logs_mode kpiSql', kpiSql, params);

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
        suggestions: suggestionsBase,
      });
    }

    /* =====================================================
       A.5) PRESETS
    ===================================================== */
    if (presetKey) {
      const canonicalMsg = presetToCanonicalMessage(presetKey, uiLang);
      const deterministicSql = presetToDeterministicSql(presetKey);

      if (canonicalMsg && deterministicSql) {
        if (logEnabled) logSql(reqId, `preset:${presetKey} deterministicSql`, deterministicSql);

        const [rowsPreset] = await pool.query(deterministicSql);

        const { sql: kpiSql, params: kpiParams, windowLabel } = buildKpiPackSql(canonicalMsg, {
          lang: uiLang,
          person: null,
        });

        if (logEnabled) logSql(reqId, `preset:${presetKey} kpiSql`, kpiSql, kpiParams);

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
          suggestions: suggestionsBase,
        });
      }
    }

    /* =====================================================
      PERFORMANCE KPI MODE (determinístico)
    ===================================================== */
    if (wantsPerformance(effectiveMessage)) {
      const m = String(effectiveMessage || '').toLowerCase();
      const isLastMonth = /(mes\s+pasado|last\s+month)/i.test(m);

      const fromExpr = isLastMonth
        ? "DATE_FORMAT(DATE_SUB(CURDATE(), INTERVAL 1 MONTH), '%Y-%m-01')"
        : "DATE_FORMAT(CURDATE(), '%Y-%m-01')";

      const toExpr = isLastMonth
        ? "DATE_FORMAT(CURDATE(), '%Y-%m-01')"
        : "DATE_ADD(DATE_FORMAT(CURDATE(), '%Y-%m-01'), INTERVAL 1 MONTH)";

      // 1) dimension (rep/oficina/pod/region/team)
      const dimPerf = extractDimensionFromMessage(effectiveMessage, uiLang);
      const groupBy = resolvePerformanceGroupBy(dimPerf?.key);

      // 2) construir SQL base del KPI performance
      let { sql: perfSql } = buildPerformanceKpiSql({ groupBy, fromExpr, toExpr });

      // 3) aplicar filtros locked desde memoria (office/pod/team/etc)
      const ctxPerf = cid ? (getContext(cid) || {}) : {};
      let filtersPerf = cloneFilters(ctxPerf);
      perfSql = applyLockedFiltersToSql(perfSql, injectLikeFilterSmart, filtersPerf);

      // 4) si el usuario escribió un filtro explícito (ej: "oficina Miami")
      if (dimPerf?.column && dimPerf?.value) {
        perfSql = injectLikeFilterSmart(perfSql, dimPerf.column, dimPerf.value);
      }

      // =========================================================
      // ✅ FIX: aplicar persona en performance (de tony) + memoria
      // Prioridad: locked > lastPerson > "de X" > forcedPick
      // =========================================================
      let perfPerson = null;

      // A) persona locked (filters) o lastPerson
      if (cid) {
        const ctxP = getContext(cid) || {};
        const fP = cloneFilters(ctxP);

        const locked =
          (fP.person && fP.person.locked && fP.person.value)
            ? String(fP.person.value).trim()
            : null;

        perfPerson = locked || (ctxP.lastPerson ? String(ctxP.lastPerson).trim() : null);
      }

      // B) si el usuario lo escribió: "performance de tony" / "performance for tony"
      if (!perfPerson) {
        const raw = String(effectiveMessage || '');
        const mx = raw.match(/\b(?:de|for)\s+([a-zA-Z0-9 .'-]{2,40})\b/i);
        if (mx && mx[1]) perfPerson = mx[1].trim();
      }

      // C) si venía de pick
      if (!perfPerson && forcedPick?.value) {
        perfPerson = String(forcedPick.value).trim();
      }

      // D) aplicar si existe
      if (perfPerson) {
        perfSql = injectLikeFilterSmart(perfSql, '__SUBMITTER__', perfPerson);

        // persistir memoria para próximos follow-ups
        if (cid) {
          filtersPerf = filtersPerf || {};
          filtersPerf.person = { value: perfPerson, locked: true };
          setContext(cid, { lastPerson: perfPerson, filters: filtersPerf });
        }

        if (logEnabled) console.log('[perf] person=', perfPerson);
      }

      // 5) Guard + ejecutar
      let safePerf;
      try {
        safePerf = validateAnalyticsSql(perfSql);
        if (logEnabled) logSql(reqId, 'performance_kpi safeSql', safePerf);
      } catch (e) {
        return res.status(400).json({
          error: uiLang === 'es' ? 'SQL no permitido' : 'SQL not allowed',
          details: e.message,
        });
      }

      const [rowsPerf] = await pool.query(safePerf);

      // ✅ hint para que la IA siempre cubra TTD/confirmed/rates/convertedValue
      const perfHint = JSON.stringify(
        {
          mode: "performance",
          expected_fields: [
            "name",
            "ttd",
            "confirmed",
            "confirmationRate",
            "dropped_cases",
            "dropped_rate",
            "convertedValue"
          ],
          rules: [
            "Always mention TTD, confirmed, confirmationRate, dropped_rate and convertedValue when present.",
            "If rowCount=1 analyze only that entity.",
            "If multiple rows: highlight top 3 by ttd or convertedValue and 1–2 outliers by confirmationRate or dropped_rate.",
            "Do not invent metrics not in the data."
          ]
        },
        null,
        2
      ).slice(0, 3500);

      const answer = await buildOwnerAnswer(effectiveMessage, safePerf, rowsPerf, {
        kpiPack: null,
        kpiWindow: isLastMonth
          ? (uiLang === 'es' ? 'Mes pasado' : 'Last month')
          : (uiLang === 'es' ? 'Este mes' : 'This month'),
        lang: uiLang,
        userName,

        mode: 'performance',
        modeHint: perfHint,
      });


      const chart = buildMiniChart(effectiveMessage, uiLang, { kpiPack: null, rows: rowsPerf });

      return res.json({
        ok: true,
        answer,
        rowCount: Array.isArray(rowsPerf) ? rowsPerf.length : 0,
        aiComment: 'performance_kpi_mode',
        userName,
        chart,
        suggestions: suggestionsBase,
        executedSql: debug ? safePerf : undefined,
      });
    }

    /* =====================================================
       NORMAL MODE (IA -> SQL)
    ===================================================== */
    const ctx = cid ? (getContext(cid) || {}) : {};
    const lastPerson = ctx.lastPerson ? String(ctx.lastPerson).trim() : null;
    let filters = cloneFilters(ctx);

    // Clear intents
    if (cid) {
      if (wantsToClear(effectiveMessage, 'person')) filters.person = null;
      if (wantsToClear(effectiveMessage, 'office')) filters.office = null;
      if (wantsToClear(effectiveMessage, 'team')) filters.team = null;
      if (wantsToClear(effectiveMessage, 'pod')) filters.pod = null;
    }

    const userWantsPersonChange =
      wantsToChange(effectiveMessage, 'person') || wantsToClear(effectiveMessage, 'person');

    const carryPerson =
      (filters.person && filters.person.value ? String(filters.person.value).trim() : null) ||
      (lastPerson ? String(lastPerson).trim() : null);

    const isShortFollowUp =
      isFollowUpQuestion(effectiveMessage, uiLang) || effectiveMessage.trim().length <= 40;

    if (!userWantsPersonChange && carryPerson && isShortFollowUp) {
      filters.person = { value: carryPerson, locked: true };
    }

    const personLocked = !!(filters.person && filters.person.locked && filters.person.value);

    let questionForAi = messageWithDefaultPeriod;
    if (cid && personLocked && !userWantsPersonChange && !mentionsPersonExplicitly(questionForAi)) {
      questionForAi = injectPersonFromContext(questionForAi, uiLang, String(filters.person.value));
    }

    // =====================================================
// ✅ "oficina de X" => convertir a filtro OfficeName (NO submitter)
// =====================================================
const officeOfPerson = extractOfficeOfPerson(questionForAi, uiLang);

if (officeOfPerson) {
  const resolvedOffice = await resolveOfficeNameByPerson(pool, officeOfPerson);

  if (resolvedOffice) {
    // lock office y NO lock person para este tipo de pregunta
    filters.office = { value: resolvedOffice, locked: true };
    filters.person = null;

    if (cid) setContext(cid, { lastPerson: officeOfPerson, filters });

    // reescribe el texto para que la IA genere SQL por oficina
    questionForAi =
      uiLang === 'es'
        ? questionForAi.replace(/(?:la\s+)?oficina\s+de\s+[^\n,.;!?]{2,60}/i, `oficina ${resolvedOffice}`)
        : questionForAi.replace(/office\s+of\s+[^\n,.;!?]{2,60}/i, `office ${resolvedOffice}`);

    if (logEnabled) console.log('[chat] office_of_person=', officeOfPerson, '=> OfficeName=', resolvedOffice);
  }
}


    let { sql, comment } = await buildSqlFromQuestion(questionForAi, uiLang);

    sql = normalizeAnalyticsSql(sql);
    sql = enforceOnlyFullGroupBy(sql);
    sql = ensureYearMonthGroupBy(sql);
    sql = rewritePersonEqualsToLike(sql, questionForAi);
    sql = ensurePeriodFilterStable(sql, questionForAi);

    const explicitDim = officeDim || dim;

    if (explicitDim && explicitDim.column && explicitDim.value) {
      sql = injectLikeFilterSmart(sql, explicitDim.column, explicitDim.value);

      const k = explicitDim.key || dimKeyFromColumn(explicitDim.column);
      if (cid && k && ['office', 'pod', 'team'].includes(k)) {
        filters[k] = { value: String(explicitDim.value), locked: true };
      }
    }


    // Apply locked dims (✅ ahora funciona)
    sql = applyLockedFiltersToSql(sql, injectLikeFilterSmart, filters);

    // If we come from person_pick, lock it
    if (forcedPick?.value && pendingContext?.type === 'person_pick') {
      filters.person = { value: String(forcedPick.value), locked: true };
    }

    // ✅ Apply locked person (✅ ahora usa value real)
    if (cid && filters.person && filters.person.locked && filters.person.value && !userWantsPersonChange) {
      sql = injectLikeFilterSmart(sql, '__SUBMITTER__', String(filters.person.value));
    }

    sql = sanitizeSqlTypos(sql);

    let safeSql;
    try {
      safeSql = validateAnalyticsSql(sql);
      if (logEnabled) logSql(reqId, 'normal_mode safeSql', safeSql);
    } catch (e) {
      return res.status(400).json({
        error: uiLang === 'es' ? 'SQL no permitido' : 'SQL not allowed',
        details: e.message,
      });
    }

    /* =====================================================
       GLOBAL PERSON DISAMBIGUATION (submitterName)
    ===================================================== */
    const pf = extractPersonFilterFromSql(safeSql);

    // ✅ AUTO-LOCK persona si el SQL ya trae una (aunque no haya pick)
    // Esto es lo que te falta para que el 2do mensaje herede "Alix".
    if (cid && !userWantsPersonChange && pf?.value) {
      const detected = String(pf.value).trim();

      // fija filters.person para que el hard-lock funcione en el próximo request
      filters.person = { value: detected, locked: true };

      // persiste en memoria de conversación
      setContext(cid, { lastPerson: detected, filters });

      if ((req.query?.debug === '1' || req.body?.debug === true) || (process.env.LOG_CHAT || '').toLowerCase() === 'true') {
        console.log('[chat] AUTO-LOCK person=', detected);
      }
    }

    if (cid && !forcedPick) {
      if (personLocked && !userWantsPersonChange) {
        forcedPick = { value: String(filters.person.value) };
        pendingContext = { type: 'person_pick' };
      } else if (pf?.value) {
        const candidates = await findSubmitterCandidates(pool, pf.value, 8);

        if (lastPerson && Array.isArray(candidates) && candidates.length >= 2) {
          const hit = candidates.find((c) => same(c.submitter, lastPerson));
          if (hit) {
            forcedPick = { value: hit.submitter };
            pendingContext = { type: 'person_pick' };
          }
        }

        if (!forcedPick && Array.isArray(candidates) && candidates.length >= 2) {
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
            suggestions: null,
          });
        }
      }
    }

    // If forcedPick resolved, inject and persist (✅ ahora ok)
    if (forcedPick?.value) {
      const chosen = String(forcedPick.value);
      safeSql = injectLikeFilterSmart(safeSql, '__SUBMITTER__', chosen);
      if (cid) {
        filters.person = { value: chosen, locked: true };
        setContext(cid, { lastPerson: chosen, filters });
      }
    } else if (cid) {
      setContext(cid, { filters });
    }

    /* =====================================================
       PRE-FLIGHT (EXPLAIN) + 1 AUTO-FIX RETRY
    ===================================================== */
    let executedSql = safeSql;

    try {
      if (logEnabled) logSql(reqId, 'normal_mode RUN (EXPLAIN)', executedSql);
      await pool.query(`EXPLAIN ${executedSql}`);
    } catch (errExplain) {
      const fixMessage = buildSqlFixMessage(
        uiLang,
        questionForAi,
        executedSql,
        errExplain?.message || String(errExplain)
      );

      const retry = await buildSqlFromQuestion(fixMessage, uiLang);

      let sql2 = normalizeAnalyticsSql(retry.sql);
      sql2 = enforceOnlyFullGroupBy(sql2);
      sql2 = ensureYearMonthGroupBy(sql2);
      sql2 = rewritePersonEqualsToLike(sql2, questionForAi);
      sql2 = ensurePeriodFilterStable(sql2, questionForAi);

      if (dim && dim.column && dim.value) sql2 = injectLikeFilterSmart(sql2, dim.column, dim.value);
      sql2 = applyLockedFiltersToSql(sql2, injectLikeFilterSmart, filters);

      if (cid && filters.person && filters.person.locked && filters.person.value && !userWantsPersonChange) {
        sql2 = injectLikeFilterSmart(sql2, '__SUBMITTER__', String(filters.person.value));
      }

      sql2 = sanitizeSqlTypos(sql2);

      let safe2;
      try {
        safe2 = validateAnalyticsSql(sql2);
      } catch (e) {
        return res.status(400).json({
          error:
            uiLang === 'es'
              ? 'La consulta generada tiene un error. Intenta reformular tu pregunta.'
              : 'The generated query has an error. Please rephrase your question.',
          details: e.message,
        });
      }

      try {
        await pool.query(`EXPLAIN ${safe2}`);
      } catch (e2) {
        return res.status(400).json({
          error:
            uiLang === 'es'
              ? 'La consulta generada tiene un error. Intenta reformular tu pregunta.'
              : 'The generated query has an error. Please rephrase your question.',
          details: e2?.message || String(e2),
        });
      }

      executedSql = safe2;
      comment = retry.comment || comment;
    }

    /* ================= EXECUTE ================= */
    if (logEnabled) logSql(reqId, 'normal_mode executedSql (RUN)', executedSql);
   
    // ✅ persist both lastPerson and filters so follow-ups keep person
    if (cid && filters.person && filters.person.locked && filters.person.value) {
      setContext(cid, { lastPerson: String(filters.person.value), filters });
    }

    // ✅ KPI person: locked > forcedPick > lastPerson > extracted
  // ✅ Persona FINAL (fuente única de verdad)
const extractedPf = extractPersonFilterFromSql(executedSql);

const personValueFinal =
  (filters.person && filters.person.locked && filters.person.value)
    ? String(filters.person.value).trim()
    : (forcedPick?.value
      ? String(forcedPick.value).trim()
      : (lastPerson
        ? String(lastPerson).trim()
        : (extractedPf?.value ? String(extractedPf.value).trim() : null)));

if ((req.query?.debug === '1' || req.body?.debug === true) || (process.env.LOG_CHAT || '').toLowerCase() === 'true') {
  console.log('[chat] personValueFinal=', personValueFinal);
}

// ✅ Asegura que el SQL principal SIEMPRE lleve la persona (si existe)
let executedSqlFinal = executedSql;
if (personValueFinal) {
  executedSqlFinal = injectLikeFilterSmart(executedSqlFinal, '__SUBMITTER__', personValueFinal);
  if (logEnabled) logSql(reqId, 'normal_mode executedSqlFinal (with person)', executedSqlFinal);
}

// Ejecuta con SQL final
if (logEnabled) logSql(reqId, 'normal_mode executedSql (RUN)', executedSqlFinal);
const [rows] = await pool.query(executedSqlFinal);

// ✅ KPI SQL SIEMPRE con persona si existe
const { sql: kpiSql0, params, windowLabel } = buildKpiPackSql(messageWithDefaultPeriod, {
  lang: uiLang,
  person: personValueFinal ? { column: 'submitterName', value: personValueFinal } : null,
});

let kpiSqlFinal = kpiSql0;
if (personValueFinal) {
  kpiSqlFinal = injectLikeFilterSmart(kpiSqlFinal, '__SUBMITTER__', personValueFinal);
}

if (logEnabled) logSql(reqId, 'normal_mode kpiSqlFinal', kpiSqlFinal, params);

const [kpiRows] = await pool.query(kpiSqlFinal, params);
const kpiPack = kpiRows?.[0] || null;

   // Detecta si estos rows parecen performance (TTD / convertedValue / rates)
const r0 = Array.isArray(rows) && rows[0] ? rows[0] : null;
const keys0 = r0 ? Object.keys(r0).map((k) => k.toLowerCase()) : [];
const isPerformanceRows =
  keys0.includes('ttd') ||
  keys0.includes('confirmationrate') ||
  keys0.includes('convertedvalue') ||
  keys0.includes('dropped_rate') ||
  keys0.includes('dropped_cases');

const perfHint2 = isPerformanceRows
  ? JSON.stringify(
      {
        mode: "performance",
        expected_fields: ["name","ttd","confirmed","confirmationRate","dropped_cases","dropped_rate","convertedValue"],
        rules: [
          "Always mention TTD, confirmed, confirmationRate, dropped_rate and convertedValue when present.",
          "If rowCount=1 analyze only that entity.",
          "If multiple rows: highlight top 3 by ttd or convertedValue and 1–2 outliers by confirmationRate or dropped_rate.",
          "Do not invent metrics not present in the data."
        ]
      },
      null,
      2
    ).slice(0, 3500)
  : null;

const answer = await buildOwnerAnswer(messageWithDefaultPeriod, executedSqlFinal, rows, {
  kpiPack,
  kpiWindow: windowLabel,
  lang: uiLang,
  userName,
  mode: isPerformanceRows ? 'performance' : undefined,
  modeHint: perfHint2 || undefined,
});

const chart = buildMiniChart(messageWithDefaultPeriod, uiLang, { kpiPack, rows });

    return res.json({
      ok: true,
      answer,
      rowCount: Array.isArray(rows) ? rows.length : 0,
      aiComment: comment,
      userName,
      chart,
      suggestions: suggestionsBase,
      executedSql: debug ? executedSql : undefined,
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
