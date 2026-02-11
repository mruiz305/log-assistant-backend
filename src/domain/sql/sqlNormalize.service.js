
/* ============================================================
   NORMALIZADOR DE SQL
   - Reduce DATE_FORMAT('%Y-%m') => YEAR/MONTH
   - Limpia espacios y caracteres invisibles
   ============================================================ */
function normalizeAnalyticsSql(sql) {
  if (!sql || typeof sql !== 'string') return sql;

  let out = sql;

  // 1) Reemplazos robustos para "year_month" (con o sin AS)
  // DATE_FORMAT(DATE(dateCameIn), '%Y-%m')  =>  CONCAT(YEAR(dateCameIn),'-',LPAD(MONTH(dateCameIn),2,'0'))
  out = out.replace(
    /DATE_FORMAT\s*\(\s*DATE\s*\(\s*dateCameIn\s*\)\s*,\s*'%Y-%m'\s*\)/gi,
    `CONCAT(YEAR(dateCameIn), '-', LPAD(MONTH(dateCameIn), 2, '0'))`
  );

  // DATE_FORMAT(dateCameIn, '%Y-%m') => idem
  out = out.replace(
    /DATE_FORMAT\s*\(\s*dateCameIn\s*,\s*'%Y-%m'\s*\)/gi,
    `CONCAT(YEAR(dateCameIn), '-', LPAD(MONTH(dateCameIn), 2, '0'))`
  );

  // Si escribió "... AS year_month" no pasa nada, solo queda bien.
  // (ya lo reemplazamos arriba)

  // 2) GROUP BY que incluya DATE_FORMAT(...'%Y-%m') => YEAR/MONTH
  // Maneja "GROUP BY algo, DATE_FORMAT(...)" sin romper lo previo.
  out = out.replace(
    /GROUP BY\s+([^;]*?)CONCAT\s*\(\s*YEAR\s*\(\s*dateCameIn\s*\)[^;]*?\)/gi,
    (m) => m // si ya viene normalizado, no tocar
  );

  // GROUP BY ... DATE_FORMAT(DATE(dateCameIn),'%Y-%m') o DATE_FORMAT(dateCameIn,'%Y-%m')
  out = out.replace(
    /GROUP BY\s+([^;]*?)DATE_FORMAT\s*\(\s*DATE\s*\(\s*dateCameIn\s*\)\s*,\s*'%Y-%m'\s*\)/gi,
    (_, before) => `GROUP BY ${before}YEAR(dateCameIn), MONTH(dateCameIn)`
  );

  out = out.replace(
    /GROUP BY\s+([^;]*?)DATE_FORMAT\s*\(\s*dateCameIn\s*,\s*'%Y-%m'\s*\)/gi,
    (_, before) => `GROUP BY ${before}YEAR(dateCameIn), MONTH(dateCameIn)`
  );

  // 3) Limpieza general
  out = out.replace(/\s*,\s*\n\s*/g, ', ');
  out = out.replace(/\n+/g, ' ').replace(/\s+/g, ' ');
  out = out.replace(/\s+,/g, ',');
  out = out.replace(/,(\s*FROM)/gi, ' $1');

  // eliminar caracteres invisibles
  out = out.replace(/[\u200B-\u200F\u202A-\u202E\uFEFF]/g, '');

  return out.trim();
}
module.exports = { normalizeAnalyticsSql };
