const express = require('express');
const { pool, query } = require('../db');
const { requireAuth, requireRole } = require('../auth/middleware');

const router = express.Router();

// GET /api/parameters/active  -> active param set + shifts + durations
router.get('/active', requireAuth, requireRole('admin', 'supervisor'), async (req, res) => {
  const active = await query('SELECT * FROM parameter_sets WHERE is_active = TRUE ORDER BY version DESC LIMIT 1');
  if (active.rows.length === 0) return res.status(404).json({ error: 'No active parameter set' });
  const p = active.rows[0];
  const shifts = (await query('SELECT name, start_min, end_min, workers_available FROM shifts WHERE parameter_set_id = $1 ORDER BY start_min', [p.id])).rows;
  const durations = (await query('SELECT operation_type, preparation_min, service_min, mise_en_stock_min FROM operation_durations WHERE parameter_set_id = $1', [p.id])).rows;
  res.json({ ...p, shifts, durations });
});

// POST /api/parameters  -> create a new active version (deactivates previous)
router.post('/', requireAuth, requireRole('admin', 'supervisor'), async (req, res) => {
  const b = req.body || {};
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const vRes = await client.query('SELECT COALESCE(MAX(version), 0) + 1 AS next FROM parameter_sets');
    const version = vRes.rows[0].next;

    await client.query('UPDATE parameter_sets SET is_active = FALSE WHERE is_active = TRUE');

    const ins = await client.query(
      `INSERT INTO parameter_sets
        (version, dock_count, slot_minutes, horizon_start_min, horizon_end_min,
         workers_per_dock, arrival_window_min, lateness_tolerance_min, acdc_delay_threshold_min,
         max_overtime_min, dock_turnover_buffer_min, blocked_docks, is_active, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,TRUE,$13)
       RETURNING id`,
      [
        version,
        b.dock_count ?? 16, b.slot_minutes ?? 30,
        b.horizon_start_min ?? 0, b.horizon_end_min ?? 1440,
        b.workers_per_dock ?? 3, b.arrival_window_min ?? 20,
        b.lateness_tolerance_min ?? 30, b.acdc_delay_threshold_min ?? 30,
        b.max_overtime_min ?? 0, b.dock_turnover_buffer_min ?? 0, b.blocked_docks ?? 0,
        req.user.id,
      ]
    );
    const pid = ins.rows[0].id;

    // shifts
    const shifts = Array.isArray(b.shifts) ? b.shifts : [];
    for (const s of shifts) {
      await client.query(
        'INSERT INTO shifts (parameter_set_id, name, start_min, end_min, workers_available) VALUES ($1,$2,$3,$4,$5)',
        [pid, s.name, s.start_min, s.end_min, s.workers_available]
      );
    }

    // durations
    const durations = Array.isArray(b.durations) ? b.durations : [];
    for (const d of durations) {
      await client.query(
        'INSERT INTO operation_durations (parameter_set_id, operation_type, preparation_min, service_min, mise_en_stock_min) VALUES ($1,$2,$3,$4,$5)',
        [pid, d.operation_type, d.preparation_min, d.service_min, d.mise_en_stock_min]
      );
    }

    await client.query('COMMIT');
    res.status(201).json({ id: pid, version });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Save parameters failed:', err.message);
    res.status(500).json({ error: 'Failed to save parameters' });
  } finally {
    client.release();
  }
});

module.exports = router;