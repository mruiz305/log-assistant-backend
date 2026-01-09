function validateAnalyticsSql(sql) {
  if (!sql || typeof sql !== 'string') {
    throw new Error('SQL vacío.');
  }

  // 1) Normalización básica
  let cleaned = sql.trim().replace(/;+\s*$/g, '');
  const lower = cleaned.toLowerCase().replace(/\s+/g, ' ').trim();

  // 2) Solo SELECT
  if (!lower.startsWith('select ')) {
    throw new Error('Solo se permiten consultas SELECT.');
  }

  // 3) Bloquear múltiples statements o comentarios (evita inyección y trucos)
  // Nota: MySQL también acepta "# comentario"
  if (/[;]\s*\S/.test(cleaned)) {
    throw new Error('Consulta no permitida (múltiples statements).');
  }
  if (/--\s|\/\*|\*\/|#/.test(cleaned)) {
    throw new Error('Consulta no permitida (comentarios).');
  }

  // 4) Debe tener FROM
  if (!/\sfrom\s/.test(lower)) {
    throw new Error('La consulta debe incluir un FROM.');
  }

  // 5) Restringir tabla(s): SOLO dmLogReportDashboard
  //    - permite alias: FROM dmLogReportDashboard d
  //    - NO permite schema.tabla distinta
  //    - NO permite joins / subqueries con FROM adicional
  const fromMatch = lower.match(/\sfrom\s+([a-z0-9_\.]+)/i);
  if (!fromMatch) {
    throw new Error('La consulta debe incluir un FROM válido.');
  }

  // Si viene con schema, aceptar solo si termina en .dmLogReportDashboard
  const fromTable = fromMatch[1];
  const endsOk =
    fromTable === 'dmlogreportdashboard' ||
    fromTable.endsWith('.dmlogreportdashboard');

  if (!endsOk) {
    throw new Error('Solo se permite consultar dmLogReportDashboard.');
  }

  // Bloquear JOINs
  if (/\b(join|left join|right join|inner join|cross join)\b/i.test(lower)) {
    throw new Error('JOIN no permitido.');
  }

  // Bloquear UNION / WITH / INTO / subqueries con FROM adicional
  if (/\bunion\b/i.test(lower)) throw new Error('UNION no permitido.');
  if (/\bwith\b/i.test(lower)) throw new Error('CTE (WITH) no permitido.');
  if (/\binto\b/i.test(lower)) throw new Error('INTO no permitido.');

  // Si hay más de un FROM, probablemente subquery o UNION -> bloquear
  const fromCount = (lower.match(/\sfrom\s/g) || []).length;
  if (fromCount !== 1) {
    throw new Error('Subconsultas no permitidas.');
  }

  // 6) Quitar strings para validar palabras peligrosas (y evitar falsos positivos)
  //    También removemos strings con comillas dobles por si el modelo las usa.
  const lowerWithoutStrings = lower
    .replace(/'[^']*'/g, "''")
    .replace(/"[^"]*"/g, '""');

  // 7) Bloquear keywords peligrosas y funciones/targets comunes de exfiltración
  const forbiddenTokens = [
    'insert',
    'update',
    'delete',
    'drop',
    'alter',
    'truncate',
    'create',
    'replace',
    'rename',
    'grant',
    'revoke',
    'set',
    'prepare',
    'execute',
    'deallocate',
    'call',
    'handler',
    'load_file',
    'outfile',
    'dumpfile',
    'information_schema',
    'mysql',
    'performance_schema',
    'sys',
  ];

  for (const token of forbiddenTokens) {
    if (new RegExp(`\\b${token}\\b`, 'i').test(lowerWithoutStrings)) {
      throw new Error('Consulta no permitida.');
    }
  }

  // 8) Reglas de LIMIT:
  //    - agregadas: NO permitir LIMIT (tu regla original)
  //    - no agregadas: si no trae LIMIT, forzamos LIMIT 500
  //    - si trae LIMIT, no permitir > 500
  const isAggregated =
    /\bgroup\s+by\b/i.test(lowerWithoutStrings) ||
    /\bcount\s*\(/i.test(lowerWithoutStrings) ||
    /\bsum\s*\(/i.test(lowerWithoutStrings) ||
    /\bavg\s*\(/i.test(lowerWithoutStrings) ||
    /\bmin\s*\(/i.test(lowerWithoutStrings) ||
    /\bmax\s*\(/i.test(lowerWithoutStrings);

  const limitMatch = lowerWithoutStrings.match(/\blimit\s+(\d+)\b/i);

  // agregadas: prohibir LIMIT
  if (isAggregated && limitMatch) {
    throw new Error('No se permite LIMIT en consultas agregadas.');
  }

  // no agregadas: aplicar/validar LIMIT
  let safeSql = cleaned;

  if (!isAggregated) {
    if (!limitMatch) {
      safeSql = `${cleaned} LIMIT 500`;
    } else {
      const n = parseInt(limitMatch[1], 10);
      if (!Number.isFinite(n) || n <= 0) {
        throw new Error('LIMIT inválido.');
      }
      if (n > 500) {
        throw new Error('LIMIT máximo permitido: 500.');
      }
    }
  }

  return safeSql;
}

module.exports = { validateAnalyticsSql };
