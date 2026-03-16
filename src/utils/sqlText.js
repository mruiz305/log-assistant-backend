
function normalizeBrokenWhere(sql) {
  if (!sql) return sql;
  let s = String(sql).trim();

  s = s.replace(/\bFROM\s+([a-zA-Z0-9_.`]+)\s+AND\b/gi, "FROM $1 WHERE");
  s = s.replace(/\bWHERE\s+AND\b/gi, "WHERE");

  const firstWhereIdx = s.search(/\bWHERE\b/i);
  if (firstWhereIdx >= 0) {
    const head = s.slice(0, firstWhereIdx + 5);
    let tail = s.slice(firstWhereIdx + 5);
    tail = tail.replace(/\bWHERE\b/gi, "AND");
    s = head + tail;
  }

  return s.replace(/\s+/g, " ").trim();
}

function stripFiltersForColumn(sql, column) {
  if (!sql) return sql;
  const col = String(column || "").trim();
  if (!col) return sql;

  let out = String(sql);
  // Operar solo en la cláusula WHERE para evitar matchear AND dentro de CASE WHEN
  const fromMatch = out.match(/\bFROM\s+([a-zA-Z0-9_.`]+)\s+/i);
  if (!fromMatch) return out;
  const fromEnd = fromMatch.index + fromMatch[0].length;
  const whereMatch = out.slice(fromEnd).match(/\bWHERE\b/i);
  if (!whereMatch) return out;
  const whereStart = fromEnd + whereMatch.index;
  const rest = out.slice(whereStart);
  const cutRx = /\b(GROUP\s+BY|ORDER\s+BY|LIMIT)\b/i;
  const cutMatch = rest.match(cutRx);
  const whereEnd = cutMatch ? whereStart + cutMatch.index : out.length;
  const whereClause = out.slice(whereStart, whereEnd);
  let newWhere = whereClause;

  // 1) Patrón principal: AND + columna + LIKE o = (solo en WHERE)
  const re = new RegExp(
    String.raw`\s+AND\s+(?:LOWER\s*\(\s*TRIM\s*\(\s*)?\s*${col}\b[^;]*?(?:LIKE|=)[^;]*?(?=\s+AND\b|\s+GROUP\s+BY|\s+ORDER\s+BY|\s+LIMIT|$)`,
    "gis"
  );
  newWhere = newWhere.replace(re, " ");

  // 2) Fallback: columna = '...' (dentro del WHERE)
  const reSimple = new RegExp(
    String.raw`\s+AND\s+${col}\s*=\s*(?:'[^']*'|"[^"]*")(?=\s+AND|\s+GROUP\s+BY|\s+ORDER\s+BY|\s+LIMIT|$)`,
    "gis"
  );
  newWhere = newWhere.replace(reSimple, " ");
  const reSimpleWhere = new RegExp(
    String.raw`\bWHERE\s+${col}\s*=\s*(?:'[^']*'|"[^"]*")(?=\s+AND|\s+GROUP\s+BY|\s+ORDER\s+BY|\s+LIMIT|$)`,
    "gis"
  );
  newWhere = newWhere.replace(reSimpleWhere, " WHERE ");

  out = out.slice(0, whereStart) + newWhere + out.slice(whereEnd);

  out = out
    .replace(/\bWHERE\s+AND\b/gi, "WHERE")
    .replace(/\bFROM\s+([a-zA-Z0-9_.`]+)\s+AND\b/gi, "FROM $1 WHERE")
    .replace(/\bWHERE\s+(GROUP\s+BY|ORDER\s+BY|LIMIT)\b/gi, "$1")
    .replace(/\bWHERE\s*$/i, "")
    .replace(/\s+/g, " ")
    .trim();

  return out;
}

module.exports = { normalizeBrokenWhere, stripFiltersForColumn };
