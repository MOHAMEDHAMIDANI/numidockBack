const express = require('express');
const multer = require('multer');
const XLSX = require('xlsx');
const { pool, query } = require('../db');
const { requireAuth, requireRole } = require('../auth/middleware');

const router = express.Router();

// Keep the uploaded file in memory (we parse it, we don't store the raw file yet)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB max
});

const VALID_OPERATIONS = ['LOAD', 'UNLOAD', 'LOAD_UNLOAD'];

// Normalize French / loose labels to our canonical operation types
function normalizeOperation(raw) {
  if (!raw) return null;
  const v = String(raw).trim().toUpperCase();
  const map = {
    LOAD: 'LOAD',
    CHARGEMENT: 'LOAD',
    UNLOAD: 'UNLOAD',
    DECHARGEMENT: 'UNLOAD',
    'DÉCHARGEMENT': 'UNLOAD',
    LOAD_UNLOAD: 'LOAD_UNLOAD',
    'LOAD+UNLOAD': 'LOAD_UNLOAD',
    'CHARGEMENT/DECHARGEMENT': 'LOAD_UNLOAD',
    'CHARGEMENT/DÉCHARGEMENT': 'LOAD_UNLOAD',
    BOTH: 'LOAD_UNLOAD',
  };
  return map[v] || null;
}

// Read a cell by several possible column names (case-insensitive)
function pick(row, names) {
  const keys = Object.keys(row);
  for (const name of names) {
    const found = keys.find((k) => k.trim().toLowerCase() === name.toLowerCase());
    if (found && row[found] != null && String(row[found]).trim() !== '') {
      return String(row[found]).trim();
    }
  }
  return null;
}

// POST /api/import/:date   (date format: YYYY-MM-DD)   field name: "file"
router.post(
  '/:date',
  requireAuth,
  requireRole('admin', 'supervisor'),
  upload.single('file'),
  async (req, res) => {
    const planningDate = req.params.date;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(planningDate)) {
      return res.status(400).json({ error: 'Date must be YYYY-MM-DD' });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded (field name must be "file")' });
    }

    // Parse Excel
    let rows;
    try {
      const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
      const sheet = wb.Sheets[wb.SheetNames[0]];
      rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
    } catch (err) {
      return res.status(400).json({ error: 'Could not read the Excel file' });
    }

    // Validate rows
    const valid = [];
    const errors = [];
    const seenRefs = new Set();

    rows.forEach((row, i) => {
      const lineNo = i + 2; // +2: header is row 1, data starts row 2
      const reference = pick(row, ['truck_reference', 'reference', 'truck', 'ref']);
      const rawOp = pick(row, ['operation_type', 'operation', 'role', 'type']);

      const rowErrors = [];
      if (!reference) rowErrors.push('missing truck reference');

      const operation = normalizeOperation(rawOp);
      if (!rawOp) rowErrors.push('missing operation type');
      else if (!operation) rowErrors.push(`invalid operation type "${rawOp}"`);

      if (reference) {
        if (seenRefs.has(reference.toLowerCase())) {
          rowErrors.push(`duplicate reference "${reference}"`);
        } else {
          seenRefs.add(reference.toLowerCase());
        }
      }

      if (rowErrors.length > 0) {
        errors.push({ line: lineNo, reference: reference || null, errors: rowErrors });
        return;
      }

      valid.push({
        reference,
        operation,
        carrier: pick(row, ['carrier', 'transporteur']),
        priority: (pick(row, ['priority', 'priorite', 'priorité']) || 'NORMAL').toUpperCase(),
        driver_name: pick(row, ['driver_name', 'driver', 'chauffeur']),
        driver_phone: pick(row, ['driver_phone', 'phone', 'telephone']),
        vehicle_plate: pick(row, ['vehicle_plate', 'plate', 'matricule']),
      });
    });

    if (valid.length === 0) {
      return res.status(400).json({
        error: 'No valid trucks to import',
        total_rows: rows.length,
        valid_count: 0,
        error_count: errors.length,
        errors,
      });
    }

    // Store: get-or-create the schedule for this date, then insert valid trucks.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const sched = await client.query(
        `INSERT INTO schedules (planning_date, status, created_by)
         VALUES ($1, 'DRAFT', $2)
         ON CONFLICT (planning_date) DO UPDATE SET planning_date = EXCLUDED.planning_date
         RETURNING id`,
        [planningDate, req.user.id]
      );
      const scheduleId = sched.rows[0].id;

      // Remove any previously imported trucks for this date (re-import replaces)
      await client.query('DELETE FROM truck_requests WHERE schedule_id = $1', [scheduleId]);

      for (const t of valid) {
        await client.query(
          `INSERT INTO truck_requests
            (schedule_id, reference, operation_type, carrier, priority,
             driver_name, driver_phone, vehicle_plate, status)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'IMPORTED')`,
          [scheduleId, t.reference, t.operation, t.carrier, t.priority, t.driver_name, t.driver_phone, t.vehicle_plate]
        );
      }

      await client.query('COMMIT');

      res.status(201).json({
        schedule_id: scheduleId,
        planning_date: planningDate,
        total_rows: rows.length,
        valid_count: valid.length,
        error_count: errors.length,
        errors,
      });
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('Import failed:', err.message);
      res.status(500).json({ error: 'Failed to store imported trucks' });
    } finally {
      client.release();
    }
  }
);

// GET /api/import/:date/trucks  -> list trucks imported for a date
router.get('/:date/trucks', requireAuth, requireRole('admin', 'supervisor'), async (req, res) => {
  const result = await query(
    `SELECT t.id, t.reference, t.operation_type, t.carrier, t.priority,
            t.driver_name, t.driver_phone, t.vehicle_plate, t.status
     FROM truck_requests t
     JOIN schedules s ON s.id = t.schedule_id
     WHERE s.planning_date = $1
     ORDER BY t.id`,
    [req.params.date]
  );
  res.json(result.rows);
});

module.exports = router;