function validateBody(schema) {
  return (req, res, next) => {
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Body inválido', details: parsed.error.issues });
    }
    req.body = parsed.data;
    next();
  };
}

module.exports = { validateBody };
