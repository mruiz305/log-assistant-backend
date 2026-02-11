// src/repos/sql.repo.js
const pool = require("../infra/db.pool");

/**
 * Repo genérico para queries.
 * Centraliza:
 * - pool
 * - params
 * - salida consistente
 */
async function query(sql, params = []) {
  const [rows] = await pool.query(sql, params);
  return rows;
}

async function queryOne(sql, params = []) {
  const rows = await query(sql, params);
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

/**
 * Útil para debug/logs.
 */
async function queryWithMeta(sql, params = []) {
  const [rows] = await pool.query(sql, params);
  return {
    rows,
    rowCount: Array.isArray(rows) ? rows.length : 0,
    sql,
    params,
  };
}

/**
 * Para INSERT/UPDATE/DELETE (devuelve OkPacket)
 */
async function execute(sql, params = []) {
  const [result] = await pool.query(sql, params);
  return result; // affectedRows, insertId, etc.
}

module.exports = { query, queryOne, queryWithMeta, execute };
