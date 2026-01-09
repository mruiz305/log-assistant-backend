const rateLimit = require('express-rate-limit');

function makeRateLimiter() {
  return rateLimit({
    windowMs: 60 * 1000,
    limit: Number(process.env.RATE_LIMIT_PER_MIN || 30),
    standardHeaders: true,
    legacyHeaders: false
  });
}

module.exports = { makeRateLimiter };
