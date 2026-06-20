const express = require('express');
const { query } = require('../db');

const router = express.Router();

// GET /api/driver/lookup?reference=TRK-001&date=2026-06-20  (public)
router.get('/lookup', async (req, res) => {
  const reference = (req.query.reference || '').trim();
  const date = (req.query.date || '').trim();
  if (!reference || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'Truck ID and a valid date are required' });
  }

  const result = await query(
    `SELECT t.reference, t.operation_type, t.carrier,
            a.appointment_min, a.window_start_min, a.window_end_min,
            a.dock_number, a.status AS appt_status,
            s.planning_date, s.status AS schedule_status,
            ac.status AS acdc_status,
            ac.requested_at, ac.accepted_at, ac.collection_started_at,
            ac.products_collected_at, ac.transferred_at, ac.released_at,
            dt.delay_reported, dt.delay_minutes, dt.token AS appt_token
     FROM appointments a
     JOIN schedule_versions v ON v.id = a.schedule_version_id
     JOIN schedules s ON s.id = v.schedule_id
     JOIN truck_requests t ON t.id = a.truck_request_id
     LEFT JOIN acdc_tasks ac ON ac.appointment_id = a.id
     LEFT JOIN driver_tokens dt ON dt.appointment_id = a.id
     WHERE s.planning_date = $1 AND v.version_number = s.active_version
       AND LOWER(t.reference) = LOWER($2)`,
    [date, reference]
  );

  if (result.rows.length === 0) {
    return res.status(404).json({ error: 'No appointment found for this Truck ID on this date' });
  }
  const row = result.rows[0];
  if (row.schedule_status !== 'PUBLISHED') {
    return res.status(404).json({ error: 'Your appointment is not published yet. Please contact dispatch.' });
  }
  res.json(row);
});

// POST /api/driver/report-delay   body: { reference, date, delay_minutes }
router.post('/report-delay', async (req, res) => {
  const reference = (req.body?.reference || '').trim();
  const date = (req.body?.date || '').trim();
  const delay = parseInt(req.body?.delay_minutes, 10);
  if (!reference || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isInteger(delay) || delay < 0) {
    return res.status(400).json({ error: 'Truck ID, date, and a valid delay are required' });
  }

  // find the appointment's driver token row (create one if missing)
  const appt = await query(
    `SELECT a.id AS appointment_id
     FROM appointments a
     JOIN schedule_versions v ON v.id = a.schedule_version_id
     JOIN schedules s ON s.id = v.schedule_id
     JOIN truck_requests t ON t.id = a.truck_request_id
     WHERE s.planning_date = $1 AND v.version_number = s.active_version
       AND LOWER(t.reference) = LOWER($2)`,
    [date, reference]
  );
  if (appt.rows.length === 0) return res.status(404).json({ error: 'Appointment not found' });
  const appointmentId = appt.rows[0].appointment_id;

  const existing = await query('SELECT id FROM driver_tokens WHERE appointment_id = $1', [appointmentId]);
  if (existing.rows.length === 0) {
    const crypto = require('crypto');
    const token = crypto.randomBytes(24).toString('hex');
    await query('INSERT INTO driver_tokens (appointment_id, token, delay_reported, delay_minutes) VALUES ($1,$2,TRUE,$3)', [appointmentId, token, delay]);
  } else {
    await query('UPDATE driver_tokens SET delay_reported = TRUE, delay_minutes = $1 WHERE appointment_id = $2', [delay, appointmentId]);
  }
  res.json({ delay_reported: true, delay_minutes: delay });
});

module.exports = router;