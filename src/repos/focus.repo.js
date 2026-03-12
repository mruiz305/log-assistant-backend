
const pool = require("../infra/db.pool");
const { FOCUS } = require("../domain/focus/focusRegistry");
const { tokenizePersonName } = require("../utils/chatRoute.helpers");
const { validateEntityCandidate } = require("../utils/entityCandidate");

function likeWrap(q) {
  const s = String(q || "").trim();
  return `%${s}%`;
}

function buildActiveClause(cfg) {
  if (!cfg.activeCol) return { sql: "", params: [] };

  const truthy = Array.isArray(cfg.activeTruthy) && cfg.activeTruthy.length
    ? cfg.activeTruthy
    : [1, "1", true, "true", "Active"];

  const ph = truthy.map(() => "?").join(",");
  return { sql: ` AND ${cfg.activeCol} IN (${ph})`, params: truthy };
}

async function findFocusCandidates({ type, query, limit = 500 }) {
  const cfg = FOCUS[type];
  if (!cfg) throw new Error(`Invalid focus type: ${type}`);

  const qRaw = String(query || "").trim();
  if (!qRaw) return [];

  const validation = validateEntityCandidate(qRaw, { source: "findFocusCandidates", intent: type });
  if (!validation.ok) {
    return [];
  }
  const q = validation.value;

  const cols = (cfg.searchCols || []).filter(Boolean);
  if (!cols.length) return [];

   const active = buildActiveClause(cfg);

  // Estrategia:
  // - TOKENS_AND: AND por token (encuentra "Porras, Karla" cuando buscas "Karla Porras")
  // - OR: búsqueda literal para el resto
  const useTokensAnd = ["submitter", "intake", "director", "attorney", "region", "team", "office", "pod"].includes(cfg.key);

  let whereSql = "";
  let whereParams = [];

  if (!useTokensAnd) {
    //  OR (igual que hoy)
    const whereParts = cols.map((c) => `${c} LIKE ?`);
    whereParams = cols.map(() => likeWrap(q));
    whereSql = `(${whereParts.join(" OR ")})`;
  } else {
    // TOKENS_AND
    const stop = new Set(["in", "on", "at", "for", "of", "the", "and", "or", "to", "en", "de", "del", "la", "el", "y", "por", "para"]);
    const tokens = tokenizePersonName(q)
      .map((t) => String(t || "").trim().toLowerCase())
      .filter((t) => t && t.length >= 2 && !stop.has(t))
      .slice(0, 6);

    // fallback si no quedaron tokens “buenos”
    const effectiveTokens = tokens.length ? tokens : [q.toLowerCase().trim()];

    // (col1 LIKE ? OR col2 LIKE ?) AND (col1 LIKE ? OR col2 LIKE ?) ...
    const tokenGroups = effectiveTokens.map(() => `(${cols.map((c) => `${c} LIKE ?`).join(" OR ")})`);
    whereSql = `(${tokenGroups.join(" AND ")})`;

    // params: por cada token repetimos por cada col
    for (const t of effectiveTokens) {
      for (let i = 0; i < cols.length; i++) whereParams.push(`%${t}%`);
    }
  }

  const sql = `
    SELECT *
    FROM ${cfg.table}
    WHERE ${whereSql}
    ${active.sql}
    LIMIT ${Number(limit) || 500}
  `;

  const params = [...whereParams, ...active.params];
  if (process.env.LOG_SQL || process.env.DEBUG_PICK) {
    console.log(`[findFocusCandidates] type=${type} query="${q}" table=${cfg.table} searchCols=[${cols.join(",")}]`);
    console.log(`[findFocusCandidates] SQL:\n${sql.trim()}`);
    console.log(`[findFocusCandidates] params:`, JSON.stringify(params));
  }

  const [rows] = await pool.query(sql, params);
  return rows || [];

}

module.exports = { findFocusCandidates };
