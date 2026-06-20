const express = require('express');
const { query } = require('../db');
const { requireAuth, requireRole } = require('../auth/middleware');

const router = express.Router();

function nowMinGate() { 
  const d = new Date(); 
  return d.getHours() * 60 + d.getMinutes(); 
}

// GET /api/gate/lookup/:date/:reference  -> find a published appointment by truck reference
router.get('/lookup/:date/:reference', requireAuth, requireRole('admin', 'supervisor', 'gate'), async (req, res) => {
  const result = await query(
    `SELECT a.id AS appointment_id, t.reference, t.operation_type, t.carrier,
            a.appointment_min, a.window_start_min, a.window_end_min, a.dock_number,
            c.category AS arrival_category, c.arrived_at_min
     FROM appointments a
     JOIN schedule_versions v ON v.id = a.schedule_version_id
     JOIN schedules s ON s.id = v.schedule_id
     JOIN truck_requests t ON t.id = a.truck_request_id
     LEFT JOIN check_ins c ON c.appointment_id = a.id
     WHERE s.planning_date = $1 AND v.version_number = s.active_version
       AND LOWER(t.reference) = LOWER($2)`,
    [req.params.date, req.params.reference]
  );
  if (result.rows.length === 0) {
    return res.status(404).json({ error: 'No appointment found for this reference on this date' });
  }
  res.json(result.rows[0]);
});

// POST /api/gate/check-in  body: { appointment_id, arrived_at_min, vehicle_plate? }
router.post('/check-in', requireAuth, requireRole('admin', 'supervisor', 'gate'), async (req, res) => {
  const apptId = parseInt(req.body?.appointment_id, 10);
  const arrived = parseInt(req.body?.arrived_at_min, 10);
  if (!Number.isInteger(apptId) || !Number.isInteger(arrived)) {
    return res.status(400).json({ error: 'appointment_id and arrived_at_min are required' });
  }

  // Load the appointment window
  const appt = await query('SELECT window_start_min, window_end_min FROM appointments WHERE id = $1', [apptId]);
  if (appt.rows.length === 0) return res.status(404).json({ error: 'Appointment not found' });

  const { window_start_min, window_end_min } = appt.rows[0];
  let category;
  if (arrived < window_start_min) category = 'EARLY';
  else if (arrived <= window_end_min) category = 'ON_TIME';
  else category = 'LATE';

  await query(
    `INSERT INTO check_ins (appointment_id, arrived_at_min, category, vehicle_plate, recorded_by)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (appointment_id) DO UPDATE
       SET arrived_at_min = EXCLUDED.arrived_at_min, category = EXCLUDED.category,
           vehicle_plate = EXCLUDED.vehicle_plate`,
    [apptId, arrived, category, req.body?.vehicle_plate || null, req.user.id]
  );

  // mark appointment as arrived with gate_state
  await query('UPDATE appointments SET gate_state = $1 WHERE id = $2', ['ARRIVED', apptId]);

  res.json({ appointment_id: apptId, category, arrived_at_min: arrived });
});

// POST /api/gate/:appointmentId/waiting
router.post('/:appointmentId/waiting', requireAuth, requireRole('admin', 'supervisor', 'gate'), async (req, res) => {
  const id = parseInt(req.params.appointmentId, 10);
  const a = await query('SELECT gate_state FROM appointments WHERE id = $1', [id]);
  if (a.rows.length === 0) return res.status(404).json({ error: 'Appointment not found' });
  if (a.rows[0].gate_state !== 'ARRIVED') return res.status(400).json({ error: `Cannot send to waiting from ${a.rows[0].gate_state}` });
  await query('UPDATE appointments SET gate_state = $1 WHERE id = $2', ['WAITING', id]);
  await query('UPDATE check_ins SET waiting_started_at_min = $1 WHERE appointment_id = $2', [nowMinGate(), id]);
  res.json({ appointment_id: id, gate_state: 'WAITING' });
});

// POST /api/gate/:appointmentId/admit
router.post('/:appointmentId/admit', requireAuth, requireRole('admin', 'supervisor', 'gate'), async (req, res) => {
  const id = parseInt(req.params.appointmentId, 10);
  const a = await query('SELECT gate_state FROM appointments WHERE id = $1', [id]);
  if (a.rows.length === 0) return res.status(404).json({ error: 'Appointment not found' });
  if (!['ARRIVED', 'WAITING'].includes(a.rows[0].gate_state)) return res.status(400).json({ error: `Cannot admit from ${a.rows[0].gate_state}` });
  await query('UPDATE appointments SET gate_state = $1 WHERE id = $2', ['AT_DOCK', id]);
  await query('UPDATE check_ins SET dock_admitted_at_min = $1 WHERE appointment_id = $2', [nowMinGate(), id]);
  res.json({ appointment_id: id, gate_state: 'AT_DOCK' });
});

// POST /api/gate/:appointmentId/service-done  -> service finished; start mise en stock if needed
router.post('/:appointmentId/service-done', requireAuth, requireRole('admin', 'supervisor', 'gate'), async (req, res) => {
  const id = parseInt(req.params.appointmentId, 10);
  const a = await query(
    `SELECT a.gate_state, t.operation_type
     FROM appointments a JOIN truck_requests t ON t.id = a.truck_request_id
     WHERE a.id = $1`, [id]);
  if (a.rows.length === 0) return res.status(404).json({ error: 'Appointment not found' });
  if (a.rows[0].gate_state !== 'AT_DOCK') return res.status(400).json({ error: `Cannot finish service from ${a.rows[0].gate_state}` });

  await query('UPDATE check_ins SET service_done_at_min = $1 WHERE appointment_id = $2', [nowMinGate(), id]);

  // unload / load_unload need mise en stock; load is done -> departed
  const needsMise = ['UNLOAD', 'LOAD_UNLOAD'].includes(a.rows[0].operation_type);
  if (needsMise) {
    await query('UPDATE appointments SET gate_state = $1 WHERE id = $2', ['MISE_EN_STOCK', id]);
    res.json({ appointment_id: id, gate_state: 'MISE_EN_STOCK' });
  } else {
    await query('UPDATE appointments SET gate_state = $1 WHERE id = $2', ['DEPARTED', id]);
    await query('UPDATE check_ins SET departed_at_min = $1 WHERE appointment_id = $2', [nowMinGate(), id]);
    res.json({ appointment_id: id, gate_state: 'DEPARTED' });
  }
});

// POST /api/gate/:appointmentId/release-dock  -> mise en stock done, dock free, truck departed
router.post('/:appointmentId/release-dock', requireAuth, requireRole('admin', 'supervisor', 'gate'), async (req, res) => {
  const id = parseInt(req.params.appointmentId, 10);
  const a = await query('SELECT gate_state FROM appointments WHERE id = $1', [id]);
  if (a.rows.length === 0) return res.status(404).json({ error: 'Appointment not found' });
  if (a.rows[0].gate_state !== 'MISE_EN_STOCK') return res.status(400).json({ error: `Cannot release dock from ${a.rows[0].gate_state}` });
  await query('UPDATE appointments SET gate_state = $1 WHERE id = $2', ['DEPARTED', id]);
  await query('UPDATE check_ins SET departed_at_min = $1 WHERE appointment_id = $2', [nowMinGate(), id]);
  res.json({ appointment_id: id, gate_state: 'DEPARTED' });
});

// POST /api/gate/:appointmentId/depart (keep for backward compatibility, but now only for LOAD trucks)
router.post('/:appointmentId/depart', requireAuth, requireRole('admin', 'supervisor', 'gate'), async (req, res) => {
  const id = parseInt(req.params.appointmentId, 10);
  const a = await query('SELECT gate_state FROM appointments WHERE id = $1', [id]);
  if (a.rows.length === 0) return res.status(404).json({ error: 'Appointment not found' });
  if (a.rows[0].gate_state !== 'AT_DOCK') return res.status(400).json({ error: `Cannot depart from ${a.rows[0].gate_state}` });
  await query('UPDATE appointments SET gate_state = $1 WHERE id = $2', ['DEPARTED', id]);
  await query('UPDATE check_ins SET departed_at_min = $1 WHERE appointment_id = $2', [nowMinGate(), id]);
  res.json({ appointment_id: id, gate_state: 'DEPARTED' });
});

router.get('/day/:date', requireAuth, requireRole('admin', 'supervisor', 'gate'), async (req, res) => {
  const date = req.params.date;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'Date must be YYYY-MM-DD' });

  const paramRow = await query('SELECT acdc_delay_threshold_min FROM parameter_sets WHERE is_active = TRUE ORDER BY version DESC LIMIT 1');
  const threshold = paramRow.rows[0]?.acdc_delay_threshold_min ?? 30;

  const rows = (await query(
    `SELECT a.id AS appointment_id, t.reference, t.operation_type, t.carrier,
            a.appointment_min, a.window_start_min, a.window_end_min, a.dock_number,
            a.products_ready, a.preparation_start_min, a.prep_state, a.gate_state,
            a.expected_completion_min, a.expected_dock_release_min,
            c.category AS arrival_category, c.arrived_at_min,
            c.waiting_started_at_min, c.dock_admitted_at_min, c.service_done_at_min, c.departed_at_min,
            ac.status AS acdc_status, ac.id AS acdc_task_id
     FROM appointments a
     JOIN schedule_versions v ON v.id = a.schedule_version_id
     JOIN schedules s ON s.id = v.schedule_id
     JOIN truck_requests t ON t.id = a.truck_request_id
     LEFT JOIN check_ins c ON c.appointment_id = a.id
     LEFT JOIN acdc_tasks ac ON ac.appointment_id = a.id
     WHERE s.planning_date = $1 AND v.version_number = s.active_version
     ORDER BY a.appointment_min`,
    [date]
  )).rows;

  const nowM = nowMinGate();
  let expected = rows.length, arrived = 0, waiting = 0, late = 0, noShow = 0;
  for (const r of rows) {
    // ACDC eligible if: LOAD/LOAD_UNLOAD + products ready + no existing task +
    // (truck is physically present at gate/dock OR truck is late and not yet arrived)
    r.acdc_eligible = ['LOAD', 'LOAD_UNLOAD'].includes(r.operation_type)
      && r.products_ready === true
      && !r.acdc_status
      && (
        ['ARRIVED', 'WAITING', 'AT_DOCK'].includes(r.gate_state)
        || (!r.arrival_category && (nowM - r.appointment_min) >= threshold)
      );
    
    r.prep_needed = r.prep_state !== 'NONE';
    r.prep_overdue = r.prep_needed && r.prep_state === 'PENDING' && nowM >= r.preparation_start_min;
    
    r.needs_mise = ['UNLOAD', 'LOAD_UNLOAD'].includes(r.operation_type);
    
    if (r.arrival_category) { 
      arrived++; 
      if (r.arrival_category === 'LATE') late++; 
    }
    else if (nowM > r.window_end_min) noShow++;
    if (r.gate_state === 'WAITING') waiting++;
  }

  res.json({
    date, current_time_min: nowM, threshold_min: threshold,
    kpis: { expected, arrived, waiting, late_noshow: late + noShow, late, no_show: noShow },
    trucks: rows,
  });
});

module.exports = router;