const admin = require('firebase-admin');

function mustEnv(name) {
  const v = (process.env[name] || '').trim();
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

function initFirebaseAdmin() {
  if (admin.apps.length) return admin;

  const projectId = mustEnv('FIREBASE_PROJECT_ID');
  const clientEmail = mustEnv('FIREBASE_CLIENT_EMAIL');

  const privateKey = mustEnv('FIREBASE_PRIVATE_KEY').replace(/\\n/g, '\n');

  admin.initializeApp({
    credential: admin.credential.cert({
      projectId,
      clientEmail,
      privateKey,
    }),
  });

  return admin;
}

module.exports = { admin: initFirebaseAdmin() };

