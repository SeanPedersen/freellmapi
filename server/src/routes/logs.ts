import { Router, type Router as ExpressRouter } from 'express';
import { getLogs } from '../services/logBuffer.js';

export const logsRouter: ExpressRouter = Router();

logsRouter.get('/', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 1000, 6000);
  res.json(getLogs(limit));
});
