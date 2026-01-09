const crypto = require('crypto');

function requestIdMiddleware(req, res, next) {
  req.id = crypto.randomUUID();
  res.setHeader('x-request-id', req.id);
  next();
}

module.exports = { requestIdMiddleware };
