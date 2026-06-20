const express = require('express');
const { pool, query } = require('../db');
const { requireAuth, requireRole } = require('../auth/middleware');
const { generateSchedule, generateScheduleWithLocks } = require('../engine/scheduler');
const { optimize } = require('../engine/optimizer');
const crypto = require('crypto');

const router = express.Router();

// POST /api/schedules/generate/:date  -> run engine, save a new version
router.post('/generate/:date', requireAuth, requireRole('admin', 'supervisor'), async (req, res) => {
  const planningDate = req.params.date;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(planningDate)) {
    return res.status(400).json({ error: 'Date must be YYYY-MM-DD' });
  }

  // 1. Find the schedule + its trucks
  const sched = await query('SELECT id FROM schedules WHERE planning_date = $1', [planningDate]);
  if (sched.rows.length === 0) {
    return res.status(404).json({ error: 'No schedule for this date. Import trucks first.' });
  }
  const scheduleId = sched.rows[0].id;

  const trucksResult = await query(
    'SELECT id, reference, operation_type FROM truck_requests WHERE schedule_id = $1 ORDER BY id',
    [scheduleId]
  );
  if (trucksResult.rows.length === 0) {
    return res.status(400).json({ error: 'No trucks imported for this date.' });
  }

  // 2. Load active parameter set (+ shifts + durations)
  const active = await query('SELECT * FROM parameter_sets WHERE is_active = TRUE ORDER BY version DESC LIMIT 1');
  if (active.rows.length === 0) {
    return res.status(400).json({ error: 'No active parameter set.' });
  }
  const params = active.rows[0];
  const shifts = (await query('SELECT name, start_min, end_min, workers_available FROM shifts WHERE parameter_set_id = $1', [params.id])).rows;
  const durations = (await query('SELECT operation_type, preparation_min, service_min, mise_en_stock_min FROM operation_durations WHERE parameter_set_id = $1', [params.id])).rows;

  // 3. Run the engine with H8 + fallback
  const started = Date.now();
  const engineParams = {
    dock_count: params.dock_count,
    horizon_start_min: params.horizon_start_min,
    horizon_end_min: params.horizon_end_min,
    workers_per_dock: params.workers_per_dock,
    slot_minutes: params.slot_minutes,
    arrival_window_min: params.arrival_window_min,
    shifts,
    durations,
  };
  
  // Try H8 optimizer first, fallback to generateSchedule
  let appointments, unscheduled;
  try {
    const result = await optimize(trucksResult.rows, engineParams);
    appointments = result.appointments;
    unscheduled = result.unscheduled;
  } catch (optError) {
    console.warn('Optimizer failed, falling back to generateSchedule:', optError.message);
    const fallbackResult = generateSchedule(trucksResult.rows, engineParams);
    appointments = fallbackResult.appointments;
    unscheduled = fallbackResult.unscheduled;
  }
  
  const generationMs = Date.now() - started;

  // 4. Save as a new schedule version + appointments
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const vResult = await client.query(
      'SELECT COALESCE(MAX(version_number), 0) + 1 AS next FROM schedule_versions WHERE schedule_id = $1',
      [scheduleId]
    );
    const versionNumber = vResult.rows[0].next;

    const verInsert = await client.query(
      `INSERT INTO schedule_versions
        (schedule_id, version_number, parameter_set_id, engine_version, objective_value, generation_ms, reason, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING id`,
      [scheduleId, versionNumber, params.id, 'H8-SA-v1', unscheduled.length, generationMs, 'Generated', req.user.id]
    );
    const versionId = verInsert.rows[0].id;

    for (const a of appointments) {
      await client.query(
        `INSERT INTO appointments
          (schedule_version_id, truck_request_id, appointment_min, window_start_min, window_end_min,
           dock_number, preparation_start_min, service_start_min, expected_completion_min,
           expected_dock_release_min, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'PLANNED')`,
        [versionId, a.truck_request_id, a.appointment_min, a.window_start_min, a.window_end_min,
         a.dock_number, a.preparation_start_min, a.service_start_min, a.expected_completion_min,
         a.expected_dock_release_min]
      );
    }

    // set prep_state based on operation type
    await client.query(
      `UPDATE appointments a SET prep_state = 'NONE'
       FROM truck_requests t
       WHERE a.truck_request_id = t.id
         AND a.schedule_version_id = $1
         AND t.operation_type = 'UNLOAD'`,
      [versionId]
    );
    await client.query(
      `UPDATE appointments a SET prep_state = 'PENDING'
       FROM truck_requests t
       WHERE a.truck_request_id = t.id
         AND a.schedule_version_id = $1
         AND t.operation_type IN ('LOAD', 'LOAD_UNLOAD')`,
      [versionId]
    );

    // mark this version active on the schedule
    await client.query('UPDATE schedules SET active_version = $1, status = $2 WHERE id = $3',
      [versionNumber, 'GENERATED', scheduleId]);

    await client.query('COMMIT');

    res.status(201).json({
      schedule_id: scheduleId,
      version_number: versionNumber,
      planning_date: planningDate,
      scheduled_count: appointments.length,
      unscheduled_count: unscheduled.length,
      generation_ms: generationMs,
      appointments,
      unscheduled,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Generate failed:', err.message);
    res.status(500).json({ error: 'Failed to save generated schedule' });
  } finally {
    client.release();
  }
});

// GET /api/schedules/:date  -> active version's appointments
router.get('/:date', requireAuth, requireRole('admin', 'supervisor'), async (req, res) => {
  const result = await query(
    `SELECT a.*, t.reference, t.operation_type, t.carrier
     FROM appointments a
     JOIN schedule_versions v ON v.id = a.schedule_version_id
     JOIN schedules s ON s.id = v.schedule_id
     JOIN truck_requests t ON t.id = a.truck_request_id
     WHERE s.planning_date = $1 AND v.version_number = s.active_version
     ORDER BY a.appointment_min`,
    [req.params.date]
  );
  res.json(result.rows);
});

// POST /api/schedules/:date/approve
router.post('/:date/approve', requireAuth, requireRole('admin', 'supervisor'), async (req, res) => {
  const sched = await query('SELECT id, status FROM schedules WHERE planning_date = $1', [req.params.date]);
  if (sched.rows.length === 0) return res.status(404).json({ error: 'Schedule not found' });

  const { id, status } = sched.rows[0];
  if (status !== 'GENERATED') {
    return res.status(400).json({ error: `Cannot approve a schedule in status ${status}. Generate it first.` });
  }

  await query('UPDATE schedules SET status = $1 WHERE id = $2', ['APPROVED', id]);
  res.json({ planning_date: req.params.date, status: 'APPROVED' });
});

// POST /api/schedules/:date/publish
router.post('/:date/publish', requireAuth, requireRole('admin', 'supervisor'), async (req, res) => {
  const sched = await query('SELECT id, status FROM schedules WHERE planning_date = $1', [req.params.date]);
  if (sched.rows.length === 0) return res.status(404).json({ error: 'Schedule not found' });

  const { id, status } = sched.rows[0];
  if (status !== 'APPROVED') {
    return res.status(400).json({ error: `Cannot publish a schedule in status ${status}. Approve it first.` });
  }

  await query('UPDATE schedules SET status = $1 WHERE id = $2', ['PUBLISHED', id]);
  // Mark all appointments in the active version as published
  await query(
    `UPDATE appointments SET status = 'PUBLISHED'
     WHERE schedule_version_id IN (
       SELECT v.id FROM schedule_versions v
       JOIN schedules s ON s.id = v.schedule_id
       WHERE s.id = $1 AND v.version_number = s.active_version
     )`,
    [id]
  );

  // Generate a secure token for each appointment (if not already present)
  const appts = await query(
    `SELECT a.id FROM appointments a
     JOIN schedule_versions v ON v.id = a.schedule_version_id
     JOIN schedules s ON s.id = v.schedule_id
     WHERE s.id = $1 AND v.version_number = s.active_version`,
    [id]
  );
  for (const a of appts.rows) {
    const existing = await query('SELECT 1 FROM driver_tokens WHERE appointment_id = $1', [a.id]);
    if (existing.rows.length === 0) {
      const token = crypto.randomBytes(24).toString('hex');
      await query('INSERT INTO driver_tokens (appointment_id, token) VALUES ($1, $2)', [a.id, token]);
    }
  }

  res.json({ planning_date: req.params.date, status: 'PUBLISHED' });
});

// GET /api/schedules/:date/status  -> current status
router.get('/:date/status', requireAuth, requireRole('admin', 'supervisor'), async (req, res) => {
  const sched = await query('SELECT status, active_version FROM schedules WHERE planning_date = $1', [req.params.date]);
  if (sched.rows.length === 0) return res.status(404).json({ error: 'Schedule not found' });
  res.json({ planning_date: req.params.date, ...sched.rows[0] });
});

// GET /api/schedules/:date/driver-links  -> tokens for sharing with drivers
router.get('/:date/driver-links', requireAuth, requireRole('admin', 'supervisor'), async (req, res) => {
  const result = await query(
    `SELECT t.reference, dt.token, dt.confirmed
     FROM driver_tokens dt
     JOIN appointments a ON a.id = dt.appointment_id
     JOIN schedule_versions v ON v.id = a.schedule_version_id
     JOIN schedules s ON s.id = v.schedule_id
     JOIN truck_requests t ON t.id = a.truck_request_id
     WHERE s.planning_date = $1 AND v.version_number = s.active_version
     ORDER BY a.appointment_min`,
    [req.params.date]
  );
  res.json(result.rows);
});

// GET /api/schedules/:date/meta
router.get('/:date/meta', requireAuth, requireRole('admin', 'supervisor'), async (req, res) => {
  const { date } = req.params;
  const sched = await query('SELECT * FROM schedules WHERE planning_date = $1', [date]);
  if (sched.rows.length === 0) return res.json({ exists: false, status: null });
  const s = sched.rows[0];

  const imported = await query('SELECT COUNT(*) as cnt FROM truck_requests WHERE schedule_id = $1', [s.id]);
  const importedCount = parseInt(imported.rows[0].cnt);

  if (!s.active_version) {
    return res.json({ exists: true, status: s.status, imported_count: importedCount, scheduled_count: 0, unscheduled_count: 0 });
  }

  const ver = await query('SELECT * FROM schedule_versions WHERE schedule_id = $1 AND version_number = $2', [s.id, s.active_version]);
  if (ver.rows.length === 0) return res.json({ exists: true, status: s.status, imported_count: importedCount });
  const v = ver.rows[0];

  const scheduled = await query('SELECT COUNT(*) as cnt FROM appointments WHERE schedule_version_id = $1', [v.id]);
  const scheduledCount = parseInt(scheduled.rows[0].cnt);

  res.json({
    exists: true,
    status: s.status,
    imported_count: importedCount,
    version_number: v.version_number,
    generation_ms: v.generation_ms,
    objective_value: v.objective_value,
    scheduled_count: scheduledCount,
    unscheduled_count: Math.max(0, importedCount - scheduledCount),
  });
});

// GET /api/schedules/:date/unscheduled
router.get('/:date/unscheduled', requireAuth, requireRole('admin', 'supervisor'), async (req, res) => {
  const sched = await query('SELECT id, active_version FROM schedules WHERE planning_date = $1', [req.params.date]);
  if (sched.rows.length === 0) return res.json([]);
  const { id: schedId, active_version } = sched.rows[0];
  if (!active_version) return res.json([]);

  const ver = await query('SELECT id FROM schedule_versions WHERE schedule_id = $1 AND version_number = $2', [schedId, active_version]);
  if (ver.rows.length === 0) return res.json([]);
  const versionId = ver.rows[0].id;

  const result = await query(
    `SELECT t.id, t.reference, t.operation_type, t.carrier
     FROM truck_requests t
     LEFT JOIN appointments a ON a.truck_request_id = t.id AND a.schedule_version_id = $1
     WHERE t.schedule_id = $2 AND a.id IS NULL`,
    [versionId, schedId]
  );
  res.json(result.rows);
});

// PUT /api/schedules/:date/appointments/:id  -> update dock_number, is_locked, and/or appointment_min
router.put('/:date/appointments/:id', requireAuth, requireRole('admin', 'supervisor'), async (req, res) => {
  const { id } = req.params;
  const { dock_number, is_locked, appointment_min } = req.body;
  const updates = [];
  const values = [];
  let idx = 1;
  if (dock_number !== undefined) { updates.push(`dock_number = $${idx++}`); values.push(dock_number); }
  if (is_locked !== undefined) { updates.push(`is_locked = $${idx++}`); values.push(is_locked); }
  if (appointment_min !== undefined) {
    // Shift all time windows by the same delta to keep durations consistent
    const cur = await query('SELECT * FROM appointments WHERE id = $1', [id]);
    if (cur.rows.length === 0) return res.status(404).json({ error: 'Appointment not found' });
    const delta = parseInt(appointment_min, 10) - cur.rows[0].appointment_min;
    updates.push(`appointment_min = $${idx++}`); values.push(parseInt(appointment_min, 10));
    updates.push(`window_start_min = $${idx++}`); values.push(cur.rows[0].window_start_min + delta);
    updates.push(`window_end_min = $${idx++}`); values.push(cur.rows[0].window_end_min + delta);
    updates.push(`preparation_start_min = $${idx++}`); values.push(cur.rows[0].preparation_start_min + delta);
    updates.push(`service_start_min = $${idx++}`); values.push(cur.rows[0].service_start_min + delta);
    updates.push(`expected_completion_min = $${idx++}`); values.push(cur.rows[0].expected_completion_min + delta);
    updates.push(`expected_dock_release_min = $${idx++}`); values.push(cur.rows[0].expected_dock_release_min + delta);
  }
  if (updates.length === 0) return res.status(400).json({ error: 'Nothing to update' });
  values.push(id);
  const result = await query(
    `UPDATE appointments SET ${updates.join(', ')} WHERE id = $${idx} RETURNING *`,
    values
  );
  if (result.rows.length === 0) return res.status(404).json({ error: 'Appointment not found' });
  res.json(result.rows[0]);
});

// POST /api/schedules/:date/reoptimize  -> re-run engine with locked appointments pinned
router.post('/:date/reoptimize', requireAuth, requireRole('admin', 'supervisor'), async (req, res) => {
  const planningDate = req.params.date;
  const sched = await query('SELECT * FROM schedules WHERE planning_date = $1', [planningDate]);
  if (sched.rows.length === 0) return res.status(404).json({ error: 'No schedule for this date.' });
  const { id: scheduleId, active_version } = sched.rows[0];
  if (!active_version) return res.status(400).json({ error: 'Generate a schedule first.' });

  const ver = await query('SELECT id FROM schedule_versions WHERE schedule_id = $1 AND version_number = $2', [scheduleId, active_version]);
  if (ver.rows.length === 0) return res.status(404).json({ error: 'Active version not found.' });
  const currentVersionId = ver.rows[0].id;

  const lockedResult = await query(
    `SELECT a.*, t.reference, t.operation_type FROM appointments a
     JOIN truck_requests t ON t.id = a.truck_request_id
     WHERE a.schedule_version_id = $1 AND a.is_locked = TRUE`,
    [currentVersionId]
  );
  const lockedAppointments = lockedResult.rows.map((a) => ({
    truck_request_id: a.truck_request_id,
    reference: a.reference,
    operation_type: a.operation_type,
    appointment_min: a.appointment_min,
    window_start_min: a.window_start_min,
    window_end_min: a.window_end_min,
    dock_number: a.dock_number,
    preparation_start_min: a.preparation_start_min,
    service_start_min: a.service_start_min,
    expected_completion_min: a.expected_completion_min,
    expected_dock_release_min: a.expected_dock_release_min,
    is_locked: true,
  }));

  const trucksResult = await query('SELECT id, reference, operation_type FROM truck_requests WHERE schedule_id = $1 ORDER BY id', [scheduleId]);
  const active = await query('SELECT * FROM parameter_sets WHERE is_active = TRUE ORDER BY version DESC LIMIT 1');
  if (active.rows.length === 0) return res.status(400).json({ error: 'No active parameter set.' });
  const params = active.rows[0];
  const shifts = (await query('SELECT name, start_min, end_min, workers_available FROM shifts WHERE parameter_set_id = $1', [params.id])).rows;
  const durations = (await query('SELECT operation_type, preparation_min, service_min, mise_en_stock_min FROM operation_durations WHERE parameter_set_id = $1', [params.id])).rows;

  const engineParams = {
    dock_count: params.dock_count, horizon_start_min: params.horizon_start_min,
    horizon_end_min: params.horizon_end_min, workers_per_dock: params.workers_per_dock,
    slot_minutes: params.slot_minutes, arrival_window_min: params.arrival_window_min,
    shifts, durations,
  };

  const started = Date.now();
  const { appointments, unscheduled } = generateScheduleWithLocks(trucksResult.rows, lockedAppointments, engineParams);
  const generationMs = Date.now() - started;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const vResult = await client.query('SELECT COALESCE(MAX(version_number),0)+1 AS next FROM schedule_versions WHERE schedule_id = $1', [scheduleId]);
    const versionNumber = vResult.rows[0].next;
    const verInsert = await client.query(
      `INSERT INTO schedule_versions (schedule_id, version_number, parameter_set_id, engine_version, objective_value, generation_ms, reason, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [scheduleId, versionNumber, params.id, 'H8-reopt', unscheduled.length, generationMs, 'Re-optimized with locks', req.user.id]
    );
    const versionId = verInsert.rows[0].id;

    for (const a of appointments) {
      await client.query(
        `INSERT INTO appointments (schedule_version_id, truck_request_id, appointment_min, window_start_min, window_end_min,
         dock_number, preparation_start_min, service_start_min, expected_completion_min, expected_dock_release_min, status, is_locked)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'PLANNED',$11)`,
        [versionId, a.truck_request_id, a.appointment_min, a.window_start_min, a.window_end_min,
         a.dock_number, a.preparation_start_min, a.service_start_min, a.expected_completion_min,
         a.expected_dock_release_min, a.is_locked || false]
      );
    }
    await client.query(
      `UPDATE appointments a SET prep_state = 'NONE' FROM truck_requests t
       WHERE a.truck_request_id = t.id AND a.schedule_version_id = $1 AND t.operation_type = 'UNLOAD'`,
      [versionId]
    );
    await client.query(
      `UPDATE appointments a SET prep_state = 'PENDING' FROM truck_requests t
       WHERE a.truck_request_id = t.id AND a.schedule_version_id = $1 AND t.operation_type IN ('LOAD', 'LOAD_UNLOAD')`,
      [versionId]
    );
    await client.query('UPDATE schedules SET active_version = $1, status = $2 WHERE id = $3', [versionNumber, 'GENERATED', scheduleId]);
    await client.query('COMMIT');

    res.status(201).json({ version_number: versionNumber, scheduled_count: appointments.length, unscheduled_count: unscheduled.length, generation_ms: generationMs, appointments, unscheduled });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Reoptimize failed:', err.message);
    res.status(500).json({ error: 'Reoptimize failed' });
  } finally {
    client.release();
  }
});

module.exports = router;