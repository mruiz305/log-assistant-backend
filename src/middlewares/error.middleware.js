function errorMiddleware(err, req, res, next) {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Error interno', details: err.message });
}
module.exports = { errorMiddleware };
