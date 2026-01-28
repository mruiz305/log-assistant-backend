// src/utils/dimensionMessageSanitizer.js
function stripResolvedDimensionsFromMessage(message, resolvedDim, chosenPerson) {
  let out = String(message || '');

  if (resolvedDim?.value) {
    const rx = new RegExp(`\\b${resolvedDim.value}\\b`, 'ig');
    out = out.replace(rx, ' ');
  }

  if (chosenPerson) {
    const rx = new RegExp(`\\b${chosenPerson}\\b`, 'ig');
    out = out.replace(rx, ' ');
  }

  return out.replace(/\s+/g, ' ').trim();
}

module.exports = { stripResolvedDimensionsFromMessage };
