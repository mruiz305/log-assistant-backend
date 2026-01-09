function classifyIntent(question = '') {
  const q = (question || '').toLowerCase();

  const isCnv = /\b(cnv|convertid|converted|confirmad|case converted)\b/.test(q);
  const isHealth = /\b(dropped|drop|problem|ref out|aging|>30|>60|sin visitas|no visits|visits)\b/.test(q);
  const isClinical = /\b(clinical|cl[ií]nic|treatment|ldot|visitas cl[ií]nicas)\b/.test(q);
  const isDetail = /\b(detalle|lista|listado|top|casos|cases|ver)\b/.test(q);

  if (isCnv && (isHealth || isClinical)) return 'mix';
  if (isCnv) return 'cnv';
  if (isClinical) return 'clinical';
  if (isHealth) return 'health';
  if (isDetail) return 'detail';
  return 'general';
}

module.exports = { classifyIntent };
