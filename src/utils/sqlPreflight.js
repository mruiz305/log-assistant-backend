// src/utils/sqlPreflight.js
async function preflightExplain(pool, safeSql) {
  const sql = String(safeSql || '').trim();
  if (!sql) throw new Error('SQL vacío para preflight');
  await pool.query(`EXPLAIN ${sql}`);
}

async function runWithPreflightAndOneFix({
  pool,
  initialSql,
  validateSql,
  buildSqlFix, // async (mysqlErrorMessage) => fixedSql
}) {
  let safe = validateSql(initialSql);

  try {
    await preflightExplain(pool, safe);
    return { safeSql: safe, fixed: false, mysqlError: null };
  } catch (err) {
    const mysqlError = String(err?.message || 'Unknown MySQL error');

    // 1 solo intento de fix
    const fixedSql = await buildSqlFix(mysqlError);
    const safe2 = validateSql(fixedSql);

    await preflightExplain(pool, safe2);
    return { safeSql: safe2, fixed: true, mysqlError };
  }
}

module.exports = { preflightExplain, runWithPreflightAndOneFix };
