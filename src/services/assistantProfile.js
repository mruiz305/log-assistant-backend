function getAssistantProfile(lang = 'en') {
  const isEs = lang === 'es';

  return {
    name: 'Nexus', 
    style: isEs
      ? 'Cálido, claro, directo. Español neutro. Sin exagerar.'
      : 'Warm, clear, direct. Professional-friendly.',
    greeting: isEs ? 'Hola' : 'Hi',
  };
}

module.exports = { getAssistantProfile };
