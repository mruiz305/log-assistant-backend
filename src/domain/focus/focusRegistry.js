
// Registry único: define cómo buscar candidatos y cuál columna filtrar en la vista principal.

const FOCUS = {
  // =========================================
  // People-like scopes
  // =========================================
  submitter: {
    key: "submitter",
    label: "Submitter",
    table: "performance_data.nexus_person_submitter", // si no existe, luego lo resolvemos con DISTINCT en dmLogReportDashboard
    searchCols: ["name", "email"],
    targetColumn: "submitterName",
    activeCol: "active",
    activeTruthy: [1, "1", true, "true", "Active"],
    canonicalFromRow: (r) => r.name,
  },

  intake: {
    key: "intake",
    label: "Intake Specialist",
    table: "performance_data.nexus_person_intake",
    searchCols: ["name", "email"],
    targetColumn: "intakeSpecialist",
    activeCol: "active",
    activeTruthy: [1, "1", true, "true", "Active"],
    canonicalFromRow: (r) => r.name,
  },

  director: {
    key: "director",
    label: "Director",
    table: "performance_data.nexus_person_directore",
    searchCols: ["name", "email"],
    targetColumn: "DirectorName",
    activeCol: "active",
    activeTruthy: [1, "1", true, "true", "Active"],
    canonicalFromRow: (r) => r.name,
  },

  // =========================================
  // Org scopes
  // =========================================
  office: {
    key: "office",
    label: "Office",
    table: "performance_data.nexus_person_office",
    // ✅ Buscar por name, office, decription (typo real) y email
    searchCols: ["name", "office", "decription", "email"],
    // ✅ Columna de tu vista principal (confírmala luego, por ahora usas OfficeName)
    targetColumn: "OfficeName",
    activeCol: "active",
    activeTruthy: [1, "1", true, "true", "Active"],
    // ✅ IMPORTANTÍSIMO: lo que se usa para filtrar es "name"
    canonicalFromRow: (r) => r.name,
  },

  pod: {
    key: "pod",
    label: "POD",
    table: "performance_data.nexus_person_pod",
    searchCols: ["name", "email"],
    targetColumn: "PODName",
    activeCol: "active",
    activeTruthy: [1, "1", true, "true", "Active"],
    canonicalFromRow: (r) => r.name,
  },

  team: {
    key: "team",
    label: "Team",
    table: "performance_data.nexus_person_team",
    searchCols: ["name", "email"],
    targetColumn: "TeamName",
    activeCol: "active", // en tu DDL es varchar(100)
    activeTruthy: ["1", "true", "Active", 1, true],
    canonicalFromRow: (r) => r.name,
  },

  region: {
    key: "region",
    label: "Region",
    table: "performance_data.nexus_person_region",
    searchCols: ["name", "email"],
    targetColumn: "RegionName",
    activeCol: "active", // en tu DDL es varchar(100)
    activeTruthy: ["1", "true", "Active", 1, true],
    canonicalFromRow: (r) => r.name,
  },

  // =========================================
  // Attorney
  // =========================================
  attorney: {
    key: "attorney",
    label: "Attorney",
    table: "performance_data.nexus_refAttorneys",
    searchCols: ["attorney", "states"],
    targetColumn: "attorney",
    activeCol: "active",
    activeTruthy: [1, "1", true, "true", "Active"],
    canonicalFromRow: (r) => r.attorney,
  },
};

function isValidFocusType(type) {
  return !!FOCUS[type];
}

module.exports = { FOCUS, isValidFocusType };
