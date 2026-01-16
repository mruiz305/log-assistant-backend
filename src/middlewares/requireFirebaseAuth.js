// src/middlewares/requireFirebaseAuth.js
const { admin } = require('../infra/firebaseAdmin');

function parseAllowedDomains() {
  const raw = process.env.ALLOWED_EMAIL_DOMAINS || '';
  return raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

const allowedDomains = parseAllowedDomains();

function emailDomain(email = '') {
  const m = String(email || '').toLowerCase().match(/@(.+)$/);
  return m ? m[1] : '';
}

function requireAuth(req, res, next) {
  try {
    const h = req.headers.authorization || '';
    const m = String(h).match(/^Bearer\s+(.+)$/i);
    const token = m ? m[1] : null;

    if (!token) {
      return res.status(401).json({ ok: false, error: 'Missing Authorization Bearer token' });
    }

    admin
      .auth()
      .verifyIdToken(token)
      .then((decoded) => {
        const email = decoded?.email || '';
        if (!email) {
          return res.status(403).json({ ok: false, error: 'No email on token' });
        }

        if (allowedDomains.length) {
          const dom = emailDomain(email);
          const ok = allowedDomains.includes(dom);
          if (!ok) {
            return res.status(403).json({
              ok: false,
              error: `Email domain not allowed: ${dom}`,
            });
          }
        }

        req.user = decoded;
        next();
      })
      .catch((err) => {
        return res.status(401).json({ ok: false, error: 'Invalid token', details: err?.message });
      });
  } catch (e) {
    return res.status(500).json({ ok: false, error: 'Auth middleware error', details: e?.message });
  }
}

module.exports = { requireAuth };
