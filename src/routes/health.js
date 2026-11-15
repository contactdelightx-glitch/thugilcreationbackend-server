const { Router } = require('express');
const pool = require('../db');

const router = Router();

/**
 * @openapi
 * /health:
 *   get:
 *     tags: [Health]
 *     summary: Health check
 *     responses:
 *       200:
 *         description: Service is up
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status: { type: string, example: ok }
 *                 uptime: { type: number, example: 12.3 }
 *                 timestamp: { type: string, format: date-time }
 */
router.get('/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

/**
 * @openapi
 * /health/db:
 *   get:
 *     tags: [Health]
 *     summary: Database health check
 *     responses:
 *       200:
 *         description: Database is reachable
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status: { type: string, example: ok }
 *                 database: { type: string, example: thugilcreations }
 *                 latencyMs: { type: number, example: 4 }
 *       503:
 *         description: Database is unreachable
 */
router.get('/health/db', async (req, res) => {
  const start = Date.now();
  try {
    const { rows } = await pool.query('select current_database() as database');
    res.status(200).json({
      status: 'ok',
      database: rows[0].database,
      latencyMs: Date.now() - start,
    });
  } catch (err) {
    console.error('DB health check failed:', err.message);
    res.status(503).json({ status: 'error', database: 'unreachable' });
  }
});

module.exports = router;
