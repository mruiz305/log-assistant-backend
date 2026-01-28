// src/utils/dimensionRegistry.js
// Fuente única de verdad para dimensiones permitidas en dmLogReportDashboard.

const DIMENSIONS = {
  // =========================
  // PERSONA (submitter/rep)
  // =========================
  person: {
    key: 'person',
    column: '__SUBMITTER__', // puente -> submitterName LIKE (fallback submitter)
    labelEs: 'representante',
    labelEn: 'rep',
    pickType: 'person_pick',
    synonymsEs: [
      'rep', 'representante', 'submitter', 'agente', 'persona', 'entered by', 'creado por'
    ],
    synonymsEn: [
      'rep', 'submitter', 'agent', 'person', 'entered by', 'created by'
    ],
    lookupColumn: 'submitterName',
  },

  // =========================
  // ORGANIZACIÓN
  // =========================
  office: {
    key: 'office',
    column: 'OfficeName',
    labelEs: 'oficina',
    labelEn: 'office',
    pickType: 'office_pick',
    synonymsEs: ['oficina', 'sucursal', 'office'],
    synonymsEn: ['office', 'branch'],
    lookupColumn: 'OfficeName',
  },
  team: {
    key: 'team',
    column: 'TeamName',
    labelEs: 'equipo',
    labelEn: 'team',
    pickType: 'team_pick',
    synonymsEs: ['equipo', 'team'],
    synonymsEn: ['team'],
    lookupColumn: 'TeamName',
  },
  pod: {
    key: 'pod',
    column: 'PODEName',
    labelEs: 'pod',
    labelEn: 'pod',
    pickType: 'pod_pick',
    synonymsEs: ['pod', 'pode'],
    synonymsEn: ['pod', 'pode'],
    lookupColumn: 'PODEName',
  },
  region: {
    key: 'region',
    column: 'RegionName',
    labelEs: 'región',
    labelEn: 'region',
    pickType: 'region_pick',
    synonymsEs: ['region', 'región'],
    synonymsEn: ['region'],
    lookupColumn: 'RegionName',
  },
  director: {
    key: 'director',
    column: 'DirectorName',
    labelEs: 'director',
    labelEn: 'director',
    pickType: 'director_pick',
    synonymsEs: ['director', 'dirección', 'dir'],
    synonymsEn: ['director'],
    lookupColumn: 'DirectorName',
  },

  // =========================
  // CAMPOS OPERATIVOS
  // =========================
  attorney: {
    key: 'attorney',
    column: 'attorney',
    labelEs: 'abogado',
    labelEn: 'attorney',
    pickType: 'attorney_pick',
    synonymsEs: ['abogado', 'attorney', 'lawyer'],
    synonymsEn: ['attorney', 'lawyer'],
    lookupColumn: 'attorney',
  },
  intake: {
    key: 'intake',
    column: 'intakeSpecialist',
    labelEs: 'intake',
    labelEn: 'intake',
    pickType: 'intake_pick',
    synonymsEs: ['intake', 'especialista de intake', 'locked down', 'intake specialist'],
    synonymsEn: ['intake', 'intake specialist', 'locked down'],
    lookupColumn: 'intakeSpecialist',
  },
  txLocation: {
    key: 'txLocation',
    column: 'txLocation',
    labelEs: 'ubicación',
    labelEn: 'location',
    pickType: 'txLocation_pick',
    synonymsEs: ['ubicacion', 'ubicación', 'location', 'txlocation'],
    synonymsEn: ['location', 'txlocation'],
    lookupColumn: 'txLocation',
  },
  origin: {
    key: 'origin',
    column: 'Origin',
    labelEs: 'origen',
    labelEn: 'origin',
    pickType: 'origin_pick',
    synonymsEs: ['origen', 'origin', 'source', 'fuente'],
    synonymsEn: ['origin', 'source'],
    lookupColumn: 'Origin',
  },
  accidentState: {
    key: 'accidentState',
    column: 'accidentState',
    labelEs: 'estado del accidente',
    labelEn: 'accident state',
    pickType: 'accidentState_pick',
    synonymsEs: ['estado accidente', 'accident state', 'accidentstate'],
    synonymsEn: ['accident state', 'accidentstate'],
    lookupColumn: 'accidentState',
  },
  status: {
    key: 'status',
    column: 'Status',
    labelEs: 'status',
    labelEn: 'status',
    pickType: 'status_pick',
    synonymsEs: ['status', 'estado', 'estatus'],
    synonymsEn: ['status', 'state'],
    lookupColumn: 'Status',
  },
  legalStatus: {
    key: 'legalStatus',
    column: 'LegalStatus',
    labelEs: 'estado legal',
    labelEn: 'legal status',
    pickType: 'legalStatus_pick',
    synonymsEs: ['legalstatus', 'legal status', 'estado legal'],
    synonymsEn: ['legalstatus', 'legal status'],
    lookupColumn: 'LegalStatus',
  },
  clinicalStatus: {
    key: 'clinicalStatus',
    column: 'ClinicalStatus',
    labelEs: 'estado clínico',
    labelEn: 'clinical status',
    pickType: 'clinicalStatus_pick',
    synonymsEs: ['clinicalstatus', 'clinical status', 'estado clínico', 'estado clinico'],
    synonymsEn: ['clinicalstatus', 'clinical status'],
    lookupColumn: 'ClinicalStatus',
  },

  // =========================
  // EMAILS
  // =========================
  directorEmail: {
    key: 'directorEmail',
    column: 'DirectorEmail',
    labelEs: 'email director',
    labelEn: 'director email',
    pickType: 'directorEmail_pick',
    synonymsEs: ['email director', 'correo director', 'directoremail'],
    synonymsEn: ['director email', 'directoremail'],
    lookupColumn: 'DirectorEmail',
  },
  regionEmail: {
    key: 'regionEmail',
    column: 'RegionEmail',
    labelEs: 'email región',
    labelEn: 'region email',
    pickType: 'regionEmail_pick',
    synonymsEs: ['email region', 'correo region', 'correo región', 'regionemail'],
    synonymsEn: ['region email', 'regionemail'],
    lookupColumn: 'RegionEmail',
  },
  officeEmail: {
    key: 'officeEmail',
    column: 'OfficeEmail',
    labelEs: 'email oficina',
    labelEn: 'office email',
    pickType: 'officeEmail_pick',
    synonymsEs: ['email oficina', 'correo oficina', 'officeemail'],
    synonymsEn: ['office email', 'officeemail'],
    lookupColumn: 'OfficeEmail',
  },
  podEmail: {
    key: 'podEmail',
    column: 'PODEmail',
    labelEs: 'email pod',
    labelEn: 'pod email',
    pickType: 'podEmail_pick',
    synonymsEs: ['email pod', 'correo pod', 'podemail', 'podeemail'],
    synonymsEn: ['pod email', 'podemail', 'podeemail'],
    lookupColumn: 'PODEmail',
  },
  teamEmail: {
    key: 'teamEmail',
    column: 'TeamEmail',
    labelEs: 'email equipo',
    labelEn: 'team email',
    pickType: 'teamEmail_pick',
    synonymsEs: ['email equipo', 'correo equipo', 'teamemail'],
    synonymsEn: ['team email', 'teamemail'],
    lookupColumn: 'TeamEmail',
  },
};

function getDimension(key) {
  return DIMENSIONS[key] || null;
}

function keyFromColumn(column) {
  const c = String(column || '').trim().toLowerCase();
  const entry = Object.values(DIMENSIONS).find(
    (d) => String(d.column || '').trim().toLowerCase() === c
  );
  return entry ? entry.key : null;
}

function listDimensions() {
  return Object.values(DIMENSIONS);
}

module.exports = {
  DIMENSIONS,
  getDimension,
  keyFromColumn,
  listDimensions,
};
