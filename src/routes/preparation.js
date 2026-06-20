const express = require('express');
const { query } = require('../db');
const { requireAuth, requireRole } = require('../auth/middleware');

const router = express.Router();
function nowMin() { const d = new Date(); return d.getHours() * 60 + d.getMinutes(); }

// POST /api/preparation/:appointmentId/start
router.post('/:appointmentId/start', requireAuth, requireRole('admin', 'supervisor', 'gate', 'preparation'), async (req, res) => {
  const id = parseInt(req.params.appointmentId, 10);
  const a = await query('SELECT id FROM appointments WHERE id = $1', [id]);
  if (a.rows.length === 0) return res.status(404).json({ error: 'Appointment not found' });
  await query('UPDATE appointments SET prep_state = $1 WHERE id = $2', ['STARTED', id]);
  await query('INSERT INTO preparation_events (appointment_id, status, event_min, recorded_by) VALUES ($1,$2,$3,$4)', [id, 'STARTED', nowMin(), req.user.id]);
  res.json({ appointment_id: id, prep_state: 'STARTED' });
});

// POST /api/preparation/:appointmentId/ready
router.post('/:appointmentId/ready', requireAuth, requireRole('admin', 'supervisor', 'gate', 'preparation'), async (req, res) => {
  const id = parseInt(req.params.appointmentId, 10);
  const a = await query('SELECT id FROM appointments WHERE id = $1', [id]);
  if (a.rows.length === 0) return res.status(404).json({ error: 'Appointment not found' });
  await query('UPDATE appointments SET products_ready = TRUE, prep_state = $1 WHERE id = $2', ['READY', id]);
  await query('INSERT INTO preparation_events (appointment_id, status, event_min, recorded_by) VALUES ($1,$2,$3,$4)', [id, 'READY', nowMin(), req.user.id]);
  res.json({ appointment_id: id, prep_state: 'READY', products_ready: true });
});

module.exports = router;