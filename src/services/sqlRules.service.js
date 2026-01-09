
/* ============================================================
   FIX: Reglas Dropped/Problem SIEMPRE por Status LIKE
   (por si el modelo insiste en leadStatus)
   ============================================================ */
function enforceStatusRules(sql) {
  if (!sql || typeof sql !== 'string') return sql;

  let out = sql;

  // leadStatus = 'Dropped'  => Status LIKE '%DROP%'
  out = out.replace(/leadStatus\s*=\s*'Dropped'/gi, "Status LIKE '%DROP%'");
  out = out.replace(/leadStatus\s+LIKE\s+'%Dropped%'/gi, "Status LIKE '%DROP%'");

  // Status = 'Dropped' => Status LIKE '%DROP%'
  out = out.replace(/Status\s*=\s*'Dropped'/gi, "Status LIKE '%DROP%'");
  out = out.replace(/Status\s+LIKE\s+'%Dropped%'/gi, "Status LIKE '%DROP%'");

  return out;
}

module.exports = { enforceStatusRules };
