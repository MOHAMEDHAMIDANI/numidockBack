/**
 * Demo seed route — POST /api/demo/seed
 * Inserts realistic demo data for today so every page shows populated data.
 * Safe to call multiple times (idempotent via ON CONFLICT DO NOTHING / upserts).
 */
const express = require('express');
const { pool, query } = require('../db');
const { requireAuth, requireRole } = require('../auth/middleware');

const router = express.Router();

router.post('/seed', requireAuth, requireRole('admin', 'supervisor'), async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const today = new Date().toISOString().slice(0, 10);

    // ── 1. Get / create schedule for today ──
    const schedRes = await client.query(
      `INSERT INTO schedules (planning_date, status, created_by)
       VALUES ($1, 'PUBLISHED', 1)
       ON CONFLICT (planning_date) DO UPDATE SET status = 'PUBLISHED'
       RETURNING id`,
      [today]
    );
    const schedId = schedRes.rows[0].id;

    // ── 2. Clear old demo trucks for today ──
    await client.query('DELETE FROM truck_requests WHERE schedule_id = $1', [schedId]);

    // ── 3. Insert demo trucks ──
    const trucks = [
      { ref: 'TRK-D01', op: 'UNLOAD',      carrier: 'Carrier Alpha' },
      { ref: 'TRK-D02', op: 'LOAD',         carrier: 'Carrier Beta'  },
      { ref: 'TRK-D03', op: 'LOAD_UNLOAD',  carrier: 'Carrier Gamma' },
      { ref: 'TRK-D04', op: 'UNLOAD',       carrier: 'Carrier Delta' },
      { ref: 'TRK-D05', op: 'LOAD',         carrier: 'Carrier Alpha' },
      { ref: 'TRK-D06', op: 'UNLOAD',       carrier: 'Carrier Beta'  },
      { ref: 'TRK-D07', op: 'LOAD',         carrier: 'Carrier Gamma' },
      { ref: 'TRK-D08', op: 'UNLOAD',       carrier: 'Carrier Delta' },
      { ref: 'TRK-D09', op: 'LOAD_UNLOAD',  carrier: 'Carrier Omega' },
      { ref: 'TRK-D10', op: 'LOAD',         carrier: 'Carrier Sigma' },
    ];
    const truckIds = [];
    for (const t of trucks) {
      const r = await client.query(
        `INSERT INTO truck_requests (schedule_id, reference, operation_type, carrier, priority, status)
         VALUES ($1,$2,$3,$4,'NORMAL','IMPORTED') RETURNING id`,
        [schedId, t.ref, t.op, t.carrier]
      );
      truckIds.push(r.rows[0].id);
    }

    // ── 4. Get active parameter_set & schedule_version ──
    const paramR = await client.query('SELECT id, dock_count FROM parameter_sets WHERE is_active=TRUE ORDER BY version DESC LIMIT 1');
    const paramId   = paramR.rows[0]?.id   ?? 1;
    const dockCount = paramR.rows[0]?.dock_count ?? 8;

    // Clear old version if re-seeding
    await client.query('DELETE FROM schedule_versions WHERE schedule_id=$1', [schedId]);
    const svRes = await client.query(
      `INSERT INTO schedule_versions (schedule_id, version_number, created_by, generation_ms, objective_value)
       VALUES ($1, 1, 1, 1200, 0) RETURNING id`,
      [schedId]
    );
    const svId = svRes.rows[0].id;

    // active_version stores version_number (integer 1,2,3…) NOT the schedule_versions.id
    await client.query('UPDATE schedules SET active_version=1 WHERE id=$1', [schedId]);

    // ── 5. Clear any existing appointments for this schedule version, then insert ──
    await client.query(
      `DELETE FROM appointments WHERE schedule_version_id = $1`, [svId]
    );

    // ── 5b. Insert appointments for each truck ──
    const now = new Date();
    // Clamp to at least 5 AM (300 min) so no appointment times go negative
    const baseMin = Math.max(now.getHours() * 60 + now.getMinutes(), 300);

    // arrivalOffset: minutes relative to apptMin the driver actually arrived
    //   negative = arrived early, positive = arrived late, 0 = right on time
    const apptDefs = [
      // ── Departed (completed) ──
      { truckIdx: 0, apptMin: baseMin - 180, dock: 1, gateState: 'DEPARTED',      acdc: false, arrivalOffset: -5  },  // ON_TIME
      { truckIdx: 1, apptMin: baseMin - 150, dock: 2, gateState: 'DEPARTED',      acdc: true,  acdcDone: true,  arrivalOffset: 35  },  // LATE
      { truckIdx: 2, apptMin: baseMin - 110, dock: 3, gateState: 'DEPARTED',      acdc: false, arrivalOffset: -35 },  // EARLY
      // ── Active at dock ──
      { truckIdx: 3, apptMin: baseMin - 60,  dock: 4, gateState: 'AT_DOCK',       acdc: false, arrivalOffset: -3  },  // ON_TIME
      { truckIdx: 4, apptMin: baseMin - 40,  dock: 5, gateState: 'MISE_EN_STOCK', acdc: true,  acdcDone: false, arrivalOffset: -8  },  // ON_TIME
      // ── Gate decisions needed ──
      { truckIdx: 5, apptMin: baseMin - 20,  dock: 6, gateState: 'WAITING',       acdc: false, arrivalOffset: 38  },  // LATE
      { truckIdx: 6, apptMin: baseMin - 10,  dock: 7, gateState: 'ARRIVED',       acdc: false, arrivalOffset: -5  },  // ON_TIME
      // ── Upcoming ──
      { truckIdx: 7, apptMin: baseMin + 45,  dock: 8, gateState: 'EXPECTED',      acdc: false },
      { truckIdx: 8, apptMin: baseMin + 75,  dock: 1, gateState: 'EXPECTED',      acdc: false },  // reuses freed dock
      { truckIdx: 9, apptMin: baseMin + 110, dock: 2, gateState: 'EXPECTED',      acdc: false },  // reuses freed dock
    ];

    const apptIds = [];
    for (const d of apptDefs) {
      const dur = { UNLOAD: [15,45,15], LOAD: [10,30,15], LOAD_UNLOAD: [20,60,20] };
      const [prep, svc, mise] = dur[trucks[d.truckIdx].op] || [15,45,15];
      const op = trucks[d.truckIdx].op;
      const prepState = op === 'UNLOAD' ? 'NONE'
        : ['DEPARTED','AT_DOCK','MISE_EN_STOCK','WAITING'].includes(d.gateState) ? 'READY'
        : d.gateState === 'ARRIVED' ? 'STARTED'
        : 'PENDING';
      const r = await client.query(
        `INSERT INTO appointments
           (truck_request_id, schedule_version_id, dock_number, appointment_min,
            window_start_min, window_end_min,
            preparation_start_min, service_start_min, expected_completion_min, expected_dock_release_min,
            gate_state, products_ready, is_locked, prep_state)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,TRUE,FALSE,$12)
         RETURNING id`,
        [
          truckIds[d.truckIdx], svId, d.dock, d.apptMin,
          d.apptMin - 30, d.apptMin + 30,
          d.apptMin - prep, d.apptMin, d.apptMin + svc, d.apptMin + svc + mise,
          d.gateState, prepState,
        ]
      );
      if (r.rows.length) apptIds.push({ id: r.rows[0].id, ...d });
    }

    // ── 6. Gate check-ins for non-EXPECTED trucks ──
    for (const a of apptIds) {
      if (a.gateState === 'EXPECTED') continue;
      const offset     = a.arrivalOffset ?? -5;
      const arrivedAt  = Math.max(0, a.apptMin + offset);
      const windowStart = a.apptMin - 30;
      const windowEnd   = a.apptMin + 30;
      const category   = arrivedAt < windowStart ? 'EARLY' : arrivedAt <= windowEnd ? 'ON_TIME' : 'LATE';
      await client.query(
        `INSERT INTO check_ins (appointment_id, arrived_at_min, category, recorded_by)
         VALUES ($1,$2,$3,1) ON CONFLICT (appointment_id) DO NOTHING`,
        [a.id, arrivedAt, category]
      );
    }

    // ── 7. ACDC tasks ──
    for (const a of apptIds.filter(a => a.acdc)) {
      if (a.acdcDone) {
        await client.query(
          `INSERT INTO acdc_tasks (appointment_id, status, requested_at, accepted_at, collection_started_at,
             products_collected_at, transferred_at, released_at)
           VALUES ($1, 'DOCK_RELEASED', now() - '2 hours'::interval, now() - '100 minutes'::interval,
                   now() - '90 minutes'::interval, now() - '70 minutes'::interval,
                   now() - '60 minutes'::interval, now() - '50 minutes'::interval)
           ON CONFLICT (appointment_id) DO NOTHING`,
          [a.id]
        );
      } else {
        await client.query(
          `INSERT INTO acdc_tasks (appointment_id, status, requested_at, accepted_at, collection_started_at,
             products_collected_at, transferred_at)
           VALUES ($1, 'TRANSFERRED', now() - '1 hour'::interval, now() - '55 minutes'::interval,
                   now() - '50 minutes'::interval, now() - '40 minutes'::interval,
                   now() - '30 minutes'::interval)
           ON CONFLICT (appointment_id) DO NOTHING`,
          [a.id]
        );
      }
    }

    // ── 8. Historical ACDC data — create past schedules + appointments for 6 previous days ──
    // The acdc_tasks table has UNIQUE(appointment_id), so we need unique appointments per day.
    // We create minimal past appointments + acdc_tasks to populate the 7-day line chart.
    const histExists = await client.query(
      `SELECT COUNT(*)::int AS n FROM acdc_tasks WHERE released_at::date < CURRENT_DATE AND status='DOCK_RELEASED'`
    );
    if (histExists.rows[0].n === 0) {
      const cycleMins = [68, 72, 65, 80, 74, 69, 75];
      for (let i = 6; i >= 1; i--) {
        const pastDate = new Date();
        pastDate.setDate(pastDate.getDate() - i);
        const pastISO = pastDate.toISOString().slice(0, 10);

        // Create a minimal past schedule
        const ps = await client.query(
          `INSERT INTO schedules (planning_date, status, created_by)
           VALUES ($1, 'PUBLISHED', 1)
           ON CONFLICT (planning_date) DO UPDATE SET status='PUBLISHED' RETURNING id`,
          [pastISO]
        );
        const pSchedId = ps.rows[0].id;

        // Create a truck request
        const ptr = await client.query(
          `INSERT INTO truck_requests (schedule_id, reference, operation_type, carrier, priority, status)
           VALUES ($1, $2, 'LOAD', 'Carrier Demo', 'NORMAL', 'IMPORTED') RETURNING id`,
          [pSchedId, `TRK-HIST-${pastISO}`]
        );
        const pTruckId = ptr.rows[0].id;

        // Create a schedule version (delete first if re-seeding)
        await client.query('DELETE FROM schedule_versions WHERE schedule_id=$1', [pSchedId]);
        const psv = await client.query(
          `INSERT INTO schedule_versions (schedule_id, version_number, created_by, generation_ms, objective_value)
           VALUES ($1, 1, 1, 500, 0) RETURNING id`,
          [pSchedId]
        );
        const pSvId = psv.rows[0].id;
        await client.query('UPDATE schedules SET active_version=1 WHERE id=$1', [pSchedId]);

        // Create an appointment (clear first in case of re-seed)
        await client.query('DELETE FROM appointments WHERE schedule_version_id=$1', [pSvId]);
        const pa = await client.query(
          `INSERT INTO appointments
             (truck_request_id, schedule_version_id, dock_number, appointment_min,
              window_start_min, window_end_min,
              preparation_start_min, service_start_min, expected_completion_min, expected_dock_release_min,
              gate_state, products_ready)
           VALUES ($1,$2,1,480,450,510,470,480,510,525,'DEPARTED',TRUE) RETURNING id`,
          [pTruckId, pSvId]
        );
        const pApptId = pa.rows[0].id;

        // Insert check_in
        await client.query(
          `INSERT INTO check_ins (appointment_id, arrived_at_min, category, recorded_by)
           VALUES ($1,475,'ON_TIME',1) ON CONFLICT (appointment_id) DO NOTHING`,
          [pApptId]
        );

        // Insert the ACDC task with past timestamp
        const avgM = cycleMins[6 - i];
        await client.query(
          `INSERT INTO acdc_tasks (appointment_id, status, requested_at, accepted_at,
             collection_started_at, products_collected_at, transferred_at, released_at)
           VALUES ($1, 'DOCK_RELEASED',
             NOW() - ($2 || ' days')::interval - '3 hours'::interval,
             NOW() - ($2 || ' days')::interval - '170 minutes'::interval,
             NOW() - ($2 || ' days')::interval - '160 minutes'::interval,
             NOW() - ($2 || ' days')::interval - '140 minutes'::interval,
             NOW() - ($2 || ' days')::interval - '130 minutes'::interval,
             NOW() - ($2 || ' days')::interval - '3 hours'::interval + ($3 || ' minutes')::interval)
           ON CONFLICT (appointment_id) DO NOTHING`,
          [pApptId, i, avgM]
        );
      }
    }

    await client.query('COMMIT');
    const hhmm = m => `${String(Math.floor(m / 60)).padStart(2,'0')}:${String(m % 60).padStart(2,'0')}`;
    res.json({
      ok: true,
      message: `Demo data seeded for ${today}. Appointments span ${hhmm(baseMin - 180)} – ${hhmm(baseMin + 60)}. Re-seed any time to refresh timestamps to the current time.`,
      schedule_id: schedId,
    });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('Demo seed error:', e.message);
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

module.exports = router;
