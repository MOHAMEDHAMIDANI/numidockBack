const express = require('express');
const { query } = require('../db');
const { requireAuth, requireRole } = require('../auth/middleware');

const router = express.Router();

function nowMin() {
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes();
}

// Valid status transitions
const NEXT = {
  REQUESTED: ['ACCEPTED', 'CANCELLED'],
  ACCEPTED: ['COLLECTION_STARTED', 'CANCELLED', 'FAILED'],
  COLLECTION_STARTED: ['PRODUCTS_COLLECTED', 'FAILED'],
  PRODUCTS_COLLECTED: ['TRANSFERRED', 'FAILED'],
  TRANSFERRED: ['DOCK_RELEASED', 'FAILED'],
  DOCK_RELEASED: [],
  CANCELLED: [],
  FAILED: [],
};

// GET /api/acdc/eligible/:date  -> trucks currently ACDC-eligible (supervisor view)
// Eligible: operation includes loading AND products ready AND not arrived
//           AND appointment_min + lateness threshold has passed (vs current time)
router.get('/eligible/:date', requireAuth, requireRole('admin', 'supervisor'), async (req, res) => {
  const params = await query('SELECT acdc_delay_threshold_min FROM parameter_sets WHERE is_active = TRUE ORDER BY version DESC LIMIT 1');
  const threshold = params.rows[0]?.acdc_delay_threshold_min ?? 30;
  const current = nowMin();

  const result = await query(
    `SELECT a.id AS appointment_id, t.reference, t.operation_type, a.appointment_min,
            a.dock_number, a.products_ready,
            c.id IS NOT NULL AS arrived,
            ac.status AS acdc_status
     FROM appointments a
     JOIN schedule_versions v ON v.id = a.schedule_version_id
     JOIN schedules s ON s.id = v.schedule_id
     JOIN truck_requests t ON t.id = a.truck_request_id
     LEFT JOIN check_ins c ON c.appointment_id = a.id
     LEFT JOIN acdc_tasks ac ON ac.appointment_id = a.id
     WHERE s.planning_date = $1 AND v.version_number = s.active_version
       AND t.operation_type IN ('LOAD','LOAD_UNLOAD')
       AND a.products_ready = TRUE
       AND c.id IS NULL
       AND ($2 - a.appointment_min) >= $3
       AND ac.id IS NULL
     ORDER BY a.appointment_min`,
    [req.params.date, current, threshold]
  );
  res.json({ current_time_min: current, threshold_min: threshold, eligible: result.rows });
});

// POST /api/acdc/create  body: { appointment_id }  (supervisor OR gate)
router.post('/create', requireAuth, requireRole('admin', 'supervisor', 'gate'), async (req, res) => {
  const id = parseInt(req.body?.appointment_id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'appointment_id required' });

  const existing = await query('SELECT 1 FROM acdc_tasks WHERE appointment_id = $1', [id]);
  if (existing.rows.length > 0) return res.status(400).json({ error: 'ACDC task already exists' });

  // verify eligibility: loading op, products ready, not arrived, past appointment+threshold
  const params = await query('SELECT acdc_delay_threshold_min FROM parameter_sets WHERE is_active = TRUE ORDER BY version DESC LIMIT 1');
  const threshold = params.rows[0]?.acdc_delay_threshold_min ?? 30;
  const nowM = (() => { const d = new Date(); return d.getHours() * 60 + d.getMinutes(); })();

  const chk = await query(
    `SELECT t.operation_type, a.products_ready, a.appointment_min,
            c.id IS NOT NULL AS arrived
     FROM appointments a
     JOIN truck_requests t ON t.id = a.truck_request_id
     LEFT JOIN check_ins c ON c.appointment_id = a.id
     WHERE a.id = $1`,
    [id]
  );
  if (chk.rows.length === 0) return res.status(404).json({ error: 'Appointment not found' });
  const e = chk.rows[0];
  const eligible = ['LOAD', 'LOAD_UNLOAD'].includes(e.operation_type)
    && e.products_ready === true
    && e.arrived === false
    && (nowM - e.appointment_min) >= threshold;
  if (!eligible) return res.status(400).json({ error: 'Truck is not ACDC-eligible (needs loading op, products ready, not arrived, past delay threshold)' });

  const result = await query(`INSERT INTO acdc_tasks (appointment_id, status) VALUES ($1, 'REQUESTED') RETURNING id`, [id]);
  await query('UPDATE appointments SET status = $1 WHERE id = $2', ['ACDC_REQUESTED', id]);
  res.status(201).json({ task_id: result.rows[0].id, status: 'REQUESTED' });
});

// GET /api/acdc/tasks?scope=active|completed  (today only)
router.get('/tasks', requireAuth, requireRole('admin', 'supervisor', 'acdc'), async (req, res) => {
  const scope = req.query.scope === 'completed' ? 'completed' : 'active';
  const whereClause = scope === 'completed'
    ? `ac.status IN ('DOCK_RELEASED','CANCELLED','FAILED') AND ac.released_at::date = CURRENT_DATE`
    : `ac.status NOT IN ('DOCK_RELEASED','CANCELLED','FAILED') AND ac.requested_at::date = CURRENT_DATE`;

  const result = await query(
    `SELECT ac.id AS task_id, ac.status, ac.requested_at, ac.accepted_at,
            ac.collection_started_at, ac.products_collected_at, ac.transferred_at, ac.released_at,
            t.reference, t.operation_type, a.dock_number, a.appointment_min
     FROM acdc_tasks ac
     JOIN appointments a ON a.id = ac.appointment_id
     JOIN truck_requests t ON t.id = a.truck_request_id
     WHERE ${whereClause}
     ORDER BY ac.requested_at DESC`
  );
  res.json(result.rows);
});

// POST /api/acdc/tasks/:id/transition  body: { to }  -> advance task status
router.post('/tasks/:id/transition', requireAuth, requireRole('admin', 'acdc', 'supervisor'), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const to = req.body?.to;

  const taskRes = await query('SELECT status, appointment_id FROM acdc_tasks WHERE id = $1', [id]);
  if (taskRes.rows.length === 0) return res.status(404).json({ error: 'Task not found' });

  const { status, appointment_id } = taskRes.rows[0];
  if (!NEXT[status] || !NEXT[status].includes(to)) {
    return res.status(400).json({ error: `Cannot move from ${status} to ${to}` });
  }

  // Build update with parameterized timestamps to avoid SQL injection
  const tsCol = { ACCEPTED: 'accepted_at', COLLECTION_STARTED: 'collection_started_at', PRODUCTS_COLLECTED: 'products_collected_at', TRANSFERRED: 'transferred_at', DOCK_RELEASED: 'released_at' };
  let extraSql = '';
  const extraVals = [];
  if (tsCol[to]) {
    extraSql = `, ${tsCol[to]} = now()`;
    if (to === 'ACCEPTED') extraSql += `, accepted_by = $3`;
  }

  if (to === 'ACCEPTED') {
    await query(`UPDATE acdc_tasks SET status = $1${extraSql} WHERE id = $2`, [to, id, req.user.id]);
  } else {
    await query(`UPDATE acdc_tasks SET status = $1${extraSql} WHERE id = $2`, [to, id]);
  }

  if (to === 'DOCK_RELEASED') {
    await query('UPDATE appointments SET status = $1 WHERE id = $2', ['ACDC_TRANSFERRED', appointment_id]);
  }
  res.json({ task_id: id, status: to });
});

// GET /api/acdc/history  -> last 7 days avg cycle time per day
router.get('/history', requireAuth, requireRole('admin', 'supervisor', 'acdc'), async (req, res) => {
  const result = await query(`
    SELECT released_at::date AS day,
           ROUND(AVG(EXTRACT(EPOCH FROM (released_at - requested_at)) / 60))::int AS avg_min,
           COUNT(*)::int AS cnt
    FROM acdc_tasks
    WHERE status = 'DOCK_RELEASED'
      AND released_at >= CURRENT_DATE - INTERVAL '6 days'
    GROUP BY released_at::date
    ORDER BY released_at::date
  `);
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(); d.setDate(d.getDate() - i);
    const iso = d.toISOString().slice(0, 10);
    const row = result.rows.find(r => String(r.day).slice(0,10) === iso);
    const dow = d.toLocaleDateString('en-US', { weekday: 'short' });
    const dm  = (d.getMonth() + 1) + '/' + d.getDate();
    days.push({ date: iso, day: dow + '\n' + dm, avg_min: row?.avg_min ?? null, count: row?.cnt ?? 0 });
  }
  res.json(days);
});

// GET /api/acdc/kpis  -> real KPI numbers
router.get('/kpis', requireAuth, requireRole('admin', 'supervisor', 'acdc'), async (req, res) => {
  const active = await query(
    `SELECT COUNT(*)::int AS n FROM acdc_tasks
     WHERE status NOT IN ('DOCK_RELEASED','CANCELLED','FAILED')
       AND requested_at::date = CURRENT_DATE`
  );
  const completedToday = await query(
    `SELECT COUNT(*)::int AS n FROM acdc_tasks
     WHERE status = 'DOCK_RELEASED' AND released_at::date = CURRENT_DATE`
  );
  const cycle = await query(
    `SELECT AVG(EXTRACT(EPOCH FROM (released_at - requested_at)))::int AS secs
     FROM acdc_tasks
     WHERE status = 'DOCK_RELEASED' AND released_at::date = CURRENT_DATE`
  );
  res.json({
    active_tasks: active.rows[0].n,
    completed_today: completedToday.rows[0].n,
    avg_cycle_seconds: cycle.rows[0].secs || 0,
  });
});

module.exports = router;