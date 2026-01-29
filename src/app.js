require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');

const { requestIdMiddleware } = require('./middlewares/requestId.middleware');
const { makeRateLimiter } = require('./middlewares/rateLimit.middleware');
const { errorMiddleware } = require('./middlewares/error.middleware');

const chatRoute = require('./routes/chat.route');
const authRoute = require('./routes/auth.routes');
const dashboardRoute = require('./routes/dashboard.route');

const app = express();

// 1) request id (para logs/debug)
app.use(requestIdMiddleware);

// 2) seguridad headers
app.use(helmet());

// 3) CORS whitelist (DEBE ir antes de rutas)
const corsOptions = {
  origin: (origin, cb) => {
    const allowed = (process.env.CORS_ORIGINS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    if (!origin) return cb(null, true); 
    if (allowed.includes(origin)) return cb(null, true);

    return cb(new Error('CORS blocked: ' + origin), false);
  },
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: false, // pon true SOLO si usas cookies/sesión
};

app.use(cors(corsOptions));
app.options('/.*/', cors(corsOptions)); 
// 4) body limit (solo una vez)
app.use(express.json({ limit: '64kb' }));

// 5) rate limit
app.use('/api/', makeRateLimiter());

// 6) routes
app.use('/api', chatRoute);
app.use('/api/auth', authRoute);
app.use('/api/dashboard', dashboardRoute);

// 7) error handler (último)
app.use(errorMiddleware);

module.exports = app;
