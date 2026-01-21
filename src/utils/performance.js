
function wantsPerformance(msg = '') {
  const m = String(msg || '').toLowerCase();
  return /\b(performance|rendimiento|desempeño|ranking|top)\b/.test(m);
}

function resolvePerformanceGroupBy(dimKey) {
  const map = {
    person: 'submitterName',
    rep: 'submitterName',
    submitter: 'submitterName',
    office: 'OfficeName',   
    pod: 'PODEName',        
    region: 'RegionName',  
    team: 'TeamName',      
  };
  return map[dimKey] || 'submitterName';
}

module.exports = { wantsPerformance, resolvePerformanceGroupBy };
