import './services/logBuffer.js';
import express, { type Express } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import path from 'path';
import { fileURLToPath } from 'url';
import { keysRouter } from './routes/keys.js';
import { modelsRouter } from './routes/models.js';
import { proxyRouter } from './routes/proxy.js';
import { fallbackRouter } from './routes/fallback.js';
import { analyticsRouter } from './routes/analytics.js';
import { healthRouter } from './routes/health.js';
import { settingsRouter } from './routes/settings.js';
import { logsRouter } from './routes/logs.js';
import { adminAuth } from './middleware/adminAuth.js';
import { errorHandler } from './middleware/errorHandler.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MAX_LOG_BODY_CHARS = 2000;
const DEFAULT_DEV_CORS_ORIGINS = [
  'http://localhost:5173',
  'http://127.0.0.1:5173',
];

function parseAllowedOrigins(): string[] {
  const raw = process.env.ADMIN_CORS_ORIGINS;
  if (!raw) return DEFAULT_DEV_CORS_ORIGINS;

  return raw
    .split(',')
    .map(origin => origin.trim())
    .filter(Boolean);
}

function isSensitiveLoggingEnabled(): boolean {
  return process.env.LOG_SENSITIVE_DATA === 'true';
}

function stringifyForLog(value: unknown): string {
  try {
    const serialized = JSON.stringify(value);
    if (!serialized) return '';
    return serialized.length > MAX_LOG_BODY_CHARS
      ? `${serialized.slice(0, MAX_LOG_BODY_CHARS)}...`
      : serialized;
  } catch {
    return '[unserializable body]';
  }
}

export function createApp(): Express {
  const app = express();

  app.use((req, res, next) => {
    const start = Date.now();
    const requestUrl = req.originalUrl;
    let responseBody: unknown;
    const originalJson = res.json.bind(res);

    res.json = (body: unknown) => {
      responseBody = body;
      return originalJson(body);
    };

    res.on('finish', () => {
      if (requestUrl.startsWith('/api/logs')) return;
      console.log(`[HTTP] ${req.method} ${requestUrl} -> ${res.statusCode} (${Date.now() - start}ms)`);
      if (isSensitiveLoggingEnabled() && res.statusCode >= 400 && requestUrl.startsWith('/v1/')) {
        console.warn(`[HTTP] ${req.method} ${requestUrl} request body: ${stringifyForLog(req.body)}`);
        console.warn(`[HTTP] ${req.method} ${requestUrl} response body: ${stringifyForLog(responseBody)}`);
      }
    });
    next();
  });

  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'", ...parseAllowedOrigins()],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
      },
    },
    strictTransportSecurity: process.env.DISABLE_HSTS === 'true' ? false : undefined,
  }));
  app.use(cors({
    origin(origin, callback) {
      if (!origin) {
        callback(null, true);
        return;
      }
      callback(null, parseAllowedOrigins().includes(origin));
    },
  }));
  app.use(express.json({ limit: '1mb' }));

  app.get('/api/ping', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  app.use('/api', adminAuth);

  // API routes
  app.use('/api/keys', keysRouter);
  app.use('/api/models', modelsRouter);
  app.use('/api/fallback', fallbackRouter);
  app.use('/api/analytics', analyticsRouter);
  app.use('/api/health', healthRouter);
  app.use('/api/settings', settingsRouter);
  app.use('/api/logs', logsRouter);

  // OpenAI-compatible proxy
  app.use('/v1', proxyRouter);

  // Error handler (for API routes)
  app.use(errorHandler);

  // Serve client static files (after API error handler)
  const clientDist = path.resolve(__dirname, '../../client/dist');
  app.use(express.static(clientDist));
  // SPA fallback — serve index.html for non-API routes
  app.use((req, res, next) => {
    if (req.path.startsWith('/api/') || req.path.startsWith('/v1/')) {
      next();
      return;
    }
    res.sendFile(path.join(clientDist, 'index.html'));
  });

  return app;
}
