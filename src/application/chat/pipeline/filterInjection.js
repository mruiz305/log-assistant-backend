
// Inyección de filtros LOCKED usando LIKE + parámetros, de forma idempotente.
// - Para dimensiones normales: LOWER(TRIM(col)) LIKE %token% AND ...
// - Para PERSON: usa COALESCE(NULLIF(submitterName,''), submitter) para fallback (datos sucios)
// - Evita duplicar filtros existentes con stripFiltersForColumn()
// - Normaliza WHERE roto al final
//
const { tokenizePersonName } = require("../../../utils/chatRoute.helpers");
const { stripFiltersForColumn, normalizeBrokenWhere } = require("../../../utils/sqlText");

function stripSubmitterCoalesceLike(sql) {
  if (!sql) return sql;
  let out = String(sql);

  // Patrones para COALESCE/submitter con LIKE
  const rxLike = [
    /\s+AND\s+(?:(?!\s+AND\s+)[^;])*?COALESCE\s*\(\s*NULLIF\s*\(\s*submitterName\s*,\s*''\s*\)\s*,\s*submitter\s*\)[^;]*?\bLIKE\b[^;]*?(?=\s+AND|\s+GROUP\s+BY|\s+ORDER\s+BY|\s+LIMIT|$)/gis,
    /\bWHERE\b\s+(?:(?!\s+AND\s+)[^;])*?COALESCE\s*\(\s*NULLIF\s*\(\s*submitterName\s*,\s*''\s*\)\s*,\s*submitter\s*\)[^;]*?\bLIKE\b[^;]*?(?=\s+AND|\s+GROUP\s+BY|\s+ORDER\s+BY|\s+LIMIT|$)/gis,
  ];
  for (const r of rxLike) {
    out = out.replace(r, (m) => (m.toUpperCase().startsWith("WHERE") ? "WHERE " : " "));
  }

  // Patrones para TRIM(COALESCE(...)) = '...' o COALESCE(...) = '...' (IA usa = en vez de LIKE)
  const rxEq = [
    /\s+AND\s+(?:(?!\s+AND\s+)[^;])*?(?:TRIM\s*\(\s*)?COALESCE\s*\(\s*NULLIF\s*\(\s*submitterName\s*,\s*''\s*\)\s*,\s*submitter\s*\)[^;]*?=\s*'[^']*'(?=\s+AND|\s+GROUP\s+BY|\s+ORDER\s+BY|\s+LIMIT|$)/gis,
    /\bWHERE\b\s+(?:(?!\s+AND\s+)[^;])*?(?:TRIM\s*\(\s*)?COALESCE\s*\(\s*NULLIF\s*\(\s*submitterName\s*,\s*''\s*\)\s*,\s*submitter\s*\)[^;]*?=\s*'[^']*'(?=\s+AND|\s+GROUP\s+BY|\s+ORDER\s+BY|\s+LIMIT|$)/gis,
  ];
  for (const r of rxEq) {
    out = out.replace(r, (m) => (m.toUpperCase().startsWith("WHERE") ? "WHERE " : " "));
  }

  // Fallback: AND ... submitter/submitterName ... LIKE o =
  out = out.replace(
    /\s+AND\s+[^;]*?(?:submitterName|submitter)\b[^;]*?(?:\bLIKE\b|=)\s*'[^']*'(?=\s+AND|\s+GROUP\s+BY|\s+ORDER\s+BY|\s+LIMIT|$)/gis,
    " "
  );

  return out
    .replace(/\bWHERE\s+AND\b/gi, "WHERE ")
    .replace(/\bWHERE\s*(GROUP\s+BY|ORDER\s+BY|LIMIT)\b/gi, "$1")
    .replace(/\s+/g, " ")
    .trim();
}


function injectWhere(baseSql, condition, params) {
  const cutRx = /\b(group\s+by|order\s+by|limit)\b/i;
  const mm = baseSql.match(cutRx);
  const cutAt = mm ? mm.index : -1;

  const head = cutAt >= 0 ? baseSql.slice(0, cutAt).trimEnd() : baseSql;
  const tail = cutAt >= 0 ? baseSql.slice(cutAt) : "";

  const withWhere = /\bwhere\b/i.test(head)
    ? `${head} AND ${condition} ${tail}`.trim()
    : `${head} WHERE ${condition} ${tail}`.trim();

  return { sql: withWhere, params };
}

function cleanTokens(tokens = []) {
  return tokens
    .map((t) => String(t || "").trim())
    .filter(Boolean)
    .filter((t) => t.length >= 2);
}

function injectColumnTokensLike(sql, column, rawValue, opts = {}) {
  const s0 = String(sql || "").trim().replace(/;\s*$/g, "");
  const col = String(column || "").trim();
  const value = String(rawValue || "").trim();
  const exact = Boolean(opts.exact);

  if (!s0 || !col || !value) return { sql: s0, params: [] };

  const tokens = exact
    ? [value]
    : cleanTokens(
        tokenizePersonName(value)
          .filter((t) => !/(accident|accidente|case|caso|lead|cliente|client|paciente)/i.test(t))
          .slice(0, 6)
      );

  if (!tokens.length) return { sql: s0, params: [] };

  const expr = `LOWER(TRIM(${col}))`;
  const likeConds = tokens
    .map(() => `${expr} LIKE CONCAT('%', LOWER(TRIM(?)), '%')`)
    .join(" AND ");

  return injectWhere(s0, `(${likeConds})`, tokens);
}

// =====================
// PERSONA (submitterName con fallback submitter)
// =====================
function injectSubmitterTokensLike(sql, personValue, opts = {}) {
   let s0 = String(sql || "").trim().replace(/;\s*$/g, "");

  s0 = stripSubmitterCoalesceLike(s0);

  const name = String(personValue || "").trim();
  const exact = Boolean(opts.exact);

  if (!s0 || !name) return { sql: s0, params: [] };

  // fallback robusto (igual que utils/dimension.js)
  const expr = "LOWER(TRIM(COALESCE(NULLIF(submitterName,''), submitter)))";

  if (exact) {
    const cond = `${expr} LIKE CONCAT('%', LOWER(TRIM(?)), '%')`;
    return injectWhere(s0, cond, [name]);
  }

  const tokens = cleanTokens(
    tokenizePersonName(name)
      .map((t) => t.toLowerCase().trim())
      .slice(0, 3)
  );

  // si hay pocos tokens, usa el string completo
  if (tokens.length < 2) {
    const cond = `${expr} LIKE CONCAT('%', LOWER(TRIM(?)), '%')`;
    return injectWhere(s0, cond, [name]);
  }

  // AND directo (más estable que OR invertido)
  const likeConds = tokens
    .map(() => `${expr} LIKE CONCAT('%', LOWER(TRIM(?)), '%')`)
    .join(" AND ");

  return injectWhere(s0, `(${likeConds})`, tokens);
}

/** Columnas que la IA puede confundir (attorney vs office). Strip la incorrecta según el filtro activo. */
const DIM_STRIP_CONFUSED = {
  attorney: ["OfficeName"],
  office: ["attorney"],
};

/** Dimensión -> columna en tabla. Para strip de scope anterior cuando cambia */
const DIM_TO_COL = {
  person: null,
  office: "OfficeName",
  pod: "PODEName",
  team: "TeamName",
  region: "RegionName",
  director: "DirectorName",
  intake: "intakeSpecialist",
  attorney: "attorney",
};

function applyLockedFiltersParam({ baseSql, filters, personValueFinal, listDimensions, focusType }) {
  let outSql = String(baseSql || "");
  let params = [];

  if (process.env.LOG_SQL || process.env.DEBUG_PICK) {
    const hasAttorney = !!(filters?.attorney?.locked && filters?.attorney?.value);
    const hasOffice = !!(filters?.office?.locked && filters?.office?.value);
    console.log(
      `[filterInjection] ENTRADA focusType=${focusType || "(null)"} filters.attorney=${hasAttorney} filters.office=${hasOffice} personValueFinal=${!!personValueFinal}`
    );
    console.log(
      `[filterInjection] baseSql: OfficeName=${outSql.includes("OfficeName")} submitter=${outSql.includes("submitter")} attorney=${outSql.includes("attorney")}`
    );
  }

  const activeScopeDim =
    focusType && DIM_TO_COL[focusType]
      ? focusType
      : (filters?.attorney?.locked && filters?.attorney?.value ? "attorney" : null) ||
        (filters?.office?.locked && filters?.office?.value ? "office" : null) ||
        (filters?.pod?.locked && filters?.pod?.value ? "pod" : null) ||
        (filters?.team?.locked && filters?.team?.value ? "team" : null) ||
        (filters?.region?.locked && filters?.region?.value ? "region" : null) ||
        (filters?.director?.locked && filters?.director?.value ? "director" : null) ||
        (filters?.intake?.locked && filters?.intake?.value ? "intake" : null);

  // Fuente de verdad: focusType (ctx.focus) o activeScopeDim (filters). Strip la columna confundida.
  // Cuando el usuario eligió ATTORNEY en el pick, NUNCA inyectar OfficeName ni submitter (aunque la IA los genere).
  const scopeIsAttorney = focusType === "attorney" || (filters?.attorney?.locked && filters?.attorney?.value);
  const scopeIsOffice = focusType === "office" || (filters?.office?.locked && filters?.office?.value);
  const scopeIsOrg = scopeIsAttorney || scopeIsOffice ||
    ["pod", "team", "region", "director", "intake"].some((k) => filters?.[k]?.locked && filters?.[k]?.value);

  if (scopeIsAttorney) {
    outSql = stripFiltersForColumn(outSql, "OfficeName");
  }
  if (scopeIsOffice) {
    outSql = stripFiltersForColumn(outSql, "attorney");
  }
  // Scope orgánico (attorney/office/etc): quitar submitter que la IA pudo añadir (lo hacemos aquí para no depender de hasNonPersonScope)
  if (scopeIsOrg) {
    outSql = stripSubmitterCoalesceLike(outSql);
    if (process.env.LOG_SQL || process.env.DEBUG_PICK) {
      console.log(`[filterInjection] después scopeIsOrg strip: submitter=${outSql.includes("submitter")}`);
    }
  }

  // Si hay scope activo: quitar columnas de OTROS scope que la IA pudo añadir (submitter ya se quitó arriba si scopeIsOrg)
  if (activeScopeDim) {
    for (const [dim, col] of Object.entries(DIM_TO_COL)) {
      if (col && dim !== activeScopeDim) {
        outSql = stripFiltersForColumn(outSql, col);
      }
    }
  }

  // Si el scope es org (attorney/office/pod/team/etc, no person), quitar filtro submitter que la IA pudo añadir por error
  const SCOPE_NON_PERSON = new Set(["attorney", "office", "pod", "team", "region", "director", "intake"]);
  const hasNonPersonScope =
    (activeScopeDim && SCOPE_NON_PERSON.has(activeScopeDim)) ||
    SCOPE_NON_PERSON.has(focusType) ||
    ["attorney", "office", "pod", "team", "region", "director", "intake"].some(
      (k) => filters?.[k]?.locked && filters?.[k]?.value
    );
  if (hasNonPersonScope) {
    outSql = stripSubmitterCoalesceLike(outSql);
  }

  // dims (menos person). filters ya viene correcto de mergeFocusIntoFilters (solo el focus cuando hay scope)
  for (const d of listDimensions()) {
    if (d.key === "person") continue;

    const lock = filters?.[d.key];
    if (!lock?.locked || !lock?.value) continue;

    // Al inyectar attorney: quitar OfficeName (confundido). Al inyectar office: quitar attorney.
    if (d.key === "attorney") outSql = stripFiltersForColumn(outSql, "OfficeName");
    if (d.key === "office") outSql = stripFiltersForColumn(outSql, "attorney");

    outSql = stripFiltersForColumn(outSql, d.column);

    const inj = injectColumnTokensLike(outSql, d.column, String(lock.value), {
      exact: Boolean(lock.exact),
    });

    outSql = inj.sql;
    params = params.concat(inj.params);
  }

  if (process.env.LOG_SQL || process.env.DEBUG_PICK) {
    console.log(`[filterInjection] después inject dims: OfficeName=${outSql.includes("OfficeName")} submitter=${outSql.includes("submitter")} attorney=${outSql.includes("attorney")}`);
  }

  // person (submitter)
  if (personValueFinal) {
    // NOTE: stripFiltersForColumn NO aplica a person porque person no es una columna real,
    // es una expresión. 
    const inj = injectSubmitterTokensLike(outSql, personValueFinal, {
      exact: Boolean(filters?.person?.exact),
    });

    outSql = inj.sql;
    params = params.concat(inj.params);
  }

  outSql = normalizeBrokenWhere(outSql);

  if (process.env.LOG_SQL || process.env.DEBUG_PICK) {
    console.log(
      `[filterInjection] applyLockedFiltersParam DONE outSqlHasOfficeName=${outSql.includes("OfficeName")} outSqlHasAttorney=${outSql.includes("attorney")}`
    );
  }

  return { sql: outSql, params };
}

module.exports = {
  injectColumnTokensLike,
  injectSubmitterTokensLike,
  applyLockedFiltersParam,
};
