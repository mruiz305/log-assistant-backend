const { findFocusCandidates } = require("./focus.repo");

/**
 * Busca candidatos de persona/submitter en nexus_g_user.
 * Usa la tabla performance_data.nexus_g_user como fuente de verdad.
 */
const PERSON_PICK_LIMIT = 500;

async function findPersonCandidates({ rawPerson, parts = [], limit = PERSON_PICK_LIMIT }) {
  const safeLimit = Number(limit) || PERSON_PICK_LIMIT;
  const query = String(rawPerson || "").trim();
  if (!query) return [];

  const rows = await findFocusCandidates({
    type: "submitter",
    query,
    limit: safeLimit,
  });

  return rows.map((r) => ({
    submitter: r.name ? String(r.name).trim() : "",
    cnt: null,
  })).filter((c) => c.submitter);
}

module.exports = {
  findPersonCandidates,
};
