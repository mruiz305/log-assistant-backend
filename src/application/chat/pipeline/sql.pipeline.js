
const { normalizeAnalyticsSql } = require("../../../domain/sql/sqlNormalize.service");
const { enforceOnlyFullGroupBy } = require("../../../domain/sql/sqlRules.service");

const { ensureYearMonthGroupBy } = require("../../../utils/chatRoute.helpers");
const { ensurePeriodFilterStable } = require("../../../utils/chatRoute.helpers");
const { sanitizeSqlTypos } = require("../../../utils/chatRoute.helpers");
const { rewritePersonEqualsToLike } = require("../../../utils/personRewrite");
const { normalizeBrokenWhere } = require("../../../utils/sqlText");

function buildSqlPipeline(rawSql, questionForAi, opts = {}) {
  const { rewritePersonEquals = false, extraNormalizeBrokenWhere = false } = opts;

  let s = normalizeAnalyticsSql(rawSql);
  s = enforceOnlyFullGroupBy(s);
  s = ensureYearMonthGroupBy(s);

  if (rewritePersonEquals) s = rewritePersonEqualsToLike(s, questionForAi);

  s = ensurePeriodFilterStable(s, questionForAi);
  s = sanitizeSqlTypos(s);

  if (extraNormalizeBrokenWhere) s = normalizeBrokenWhere(s);

  return s;
}

module.exports = { buildSqlPipeline };
