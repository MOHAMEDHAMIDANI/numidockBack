const express = require('express');
const multer  = require('multer');
const XLSX    = require('xlsx');
const { query } = require('../db');
const { requireAuth, requireRole } = require('../auth/middleware');

const router  = express.Router();
const guard   = [requireAuth, requireRole('admin', 'supervisor')];
const upload  = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// ─── helpers ──────────────────────────────────────────────────────────────────
function pick(row, names) {
  for (const n of names) {
    const key = Object.keys(row).find(k => k.trim().toLowerCase() === n.toLowerCase());
    if (key && row[key] != null && String(row[key]).trim() !== '') return String(row[key]).trim();
  }
  return null;
}
async function buildWhere(q) {
  const { search = '', zone = '', warehouse = '', status = '' } = q;
  const conds = [], vals = [];
  let i = 1;
  if (search)    { conds.push(`(item_code ILIKE $${i} OR description ILIKE $${i} OR sku ILIKE $${i} OR pallet_id ILIKE $${i} OR location ILIKE $${i})`); vals.push(`%${search}%`); i++; }
  if (zone)      { conds.push(`zone ILIKE $${i}`);      vals.push(`%${zone}%`);      i++; }
  if (warehouse) { conds.push(`warehouse ILIKE $${i}`); vals.push(`%${warehouse}%`); i++; }
  if (status)    { conds.push(`status = $${i}`);        vals.push(status);            i++; }
  return { where: conds.length ? 'WHERE ' + conds.join(' AND ') : '', vals, nextIdx: i };
}

// ═══════════════════════════════════════════════════════════════════════════════
// KPIs
// ═══════════════════════════════════════════════════════════════════════════════
router.get('/kpis', ...guard, async (req, res) => {
  const [skus, pallets, units, locs, avail] = await Promise.all([
    query('SELECT COUNT(DISTINCT item_code)::int AS n FROM storage_pallets'),
    query('SELECT COUNT(*)::int AS n FROM storage_pallets'),
    query('SELECT COALESCE(SUM(quantity),0)::int AS n FROM storage_pallets'),
    query('SELECT COUNT(DISTINCT location)::int AS n FROM storage_pallets WHERE quantity > 0'),
    query("SELECT COUNT(*)::int AS n FROM storage_pallets WHERE status = 'Available'"),
  ]);
  res.json({
    total_skus:         skus.rows[0].n,
    total_pallets:      pallets.rows[0].n,
    total_units:        units.rows[0].n,
    occupied_locations: locs.rows[0].n,
    available_count:    avail.rows[0].n,
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// PALLETS CRUD
// ═══════════════════════════════════════════════════════════════════════════════
router.get('/pallets', ...guard, async (req, res) => {
  const { where, vals, nextIdx: i } = await buildWhere(req.query);
  const { page = 1, limit = 15 } = req.query;
  const totalRes = await query(`SELECT COUNT(*)::int AS n FROM storage_pallets ${where}`, vals);
  const total    = totalRes.rows[0].n;
  const offset   = (parseInt(page) - 1) * parseInt(limit);
  const dataRes  = await query(
    `SELECT * FROM storage_pallets ${where} ORDER BY updated_at DESC LIMIT $${i} OFFSET $${i + 1}`,
    [...vals, parseInt(limit), offset]
  );
  res.json({ pallets: dataRes.rows, total, page: parseInt(page), pages: Math.ceil(total / parseInt(limit)) });
});

router.get('/pallets/:id', ...guard, async (req, res) => {
  const r = await query('SELECT * FROM storage_pallets WHERE id = $1', [req.params.id]);
  if (!r.rows[0]) return res.status(404).json({ error: 'Not found' });
  res.json(r.rows[0]);
});

router.post('/pallets', ...guard, async (req, res) => {
  const {
    item_code, description = '', sku, warehouse = 'WH1 - Central', zone = 'Z02 - Storage',
    location, pallet_id, pallet_type = 'EUR', quantity = 0, base_unit = 'PCS', status = 'Available',
    max_weight_kg, product_type, compatibility_group, max_slots = 1,
  } = req.body;
  if (!item_code) return res.status(400).json({ error: 'item_code is required' });
  const zs = await query('SELECT status FROM storage_zones WHERE name = $1', [zone]);
  if (zs.rows[0]?.status === 'CLOSED') return res.status(400).json({ error: `Zone "${zone}" is closed. Choose an open zone.` });
  const r = await query(
    `INSERT INTO storage_pallets
       (item_code, description, sku, warehouse, zone, location, pallet_id, pallet_type,
        quantity, base_unit, status, max_weight_kg, product_type, compatibility_group, max_slots)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
    [item_code, description, sku, warehouse, zone, location, pallet_id, pallet_type,
     quantity, base_unit, status, max_weight_kg || null, product_type || null,
     compatibility_group || null, max_slots || 1]
  );
  res.status(201).json(r.rows[0]);
});

router.put('/pallets/:id', ...guard, async (req, res) => {
  const fields = ['item_code','description','sku','warehouse','zone','location','pallet_id',
                  'pallet_type','quantity','base_unit','status',
                  'max_weight_kg','product_type','compatibility_group','max_slots'];
  const sets = [], vals = [];
  let i = 1;
  for (const f of fields) {
    if (req.body[f] !== undefined) { sets.push(`${f} = $${i++}`); vals.push(req.body[f]); }
  }
  if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });
  if (req.body.zone) {
    const zs = await query('SELECT status FROM storage_zones WHERE name = $1', [req.body.zone]);
    if (zs.rows[0]?.status === 'CLOSED') return res.status(400).json({ error: `Zone "${req.body.zone}" is closed.` });
  }
  sets.push(`updated_at = now()`);
  vals.push(req.params.id);
  const r = await query(`UPDATE storage_pallets SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`, vals);
  if (!r.rows[0]) return res.status(404).json({ error: 'Not found' });
  res.json(r.rows[0]);
});

router.delete('/pallets/:id', ...guard, async (req, res) => {
  const r = await query('DELETE FROM storage_pallets WHERE id = $1 RETURNING id', [req.params.id]);
  if (!r.rows[0]) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

// ═══════════════════════════════════════════════════════════════════════════════
// IMPORT (Excel → storage_pallets)
// ═══════════════════════════════════════════════════════════════════════════════
router.post('/import', ...guard, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded. Field name must be "file".' });
  let rows;
  try {
    const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
    rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '' });
  } catch { return res.status(400).json({ error: 'Could not read Excel file. Make sure it is a valid .xlsx file.' }); }
  if (!rows.length) return res.status(400).json({ error: 'The spreadsheet has no data rows.' });

  const valid = [], errors = [];
  const STATUSES = ['Available', 'Reserved', 'On Hold'];
  const TYPES    = ['EUR', 'IND', 'ISO'];

  rows.forEach((row, idx) => {
    const lineNo   = idx + 2;
    const item_code = pick(row, ['item_code','Item Code','CODE','code','ITEM_CODE']);
    if (!item_code) { errors.push({ line: lineNo, error: 'Missing item_code / Item Code column' }); return; }
    const qty = parseInt(pick(row, ['quantity','Quantity','QTY','qty']) || '0');
    if (isNaN(qty) || qty < 0) { errors.push({ line: lineNo, error: `Invalid quantity for ${item_code}` }); return; }
    const rawStatus  = pick(row, ['status','Status','STATUS']) || 'Available';
    const status     = STATUSES.find(s => s.toLowerCase() === rawStatus.toLowerCase()) || 'Available';
    const rawType    = pick(row, ['pallet_type','Pallet Type','type','Type']) || 'EUR';
    const pallet_type = TYPES.find(t => t.toLowerCase() === rawType.toLowerCase()) || 'EUR';
    valid.push({
      item_code,
      description:         pick(row, ['description','Description','DESC']) || '',
      sku:                 pick(row, ['sku','SKU']) || null,
      warehouse:           pick(row, ['warehouse','Warehouse','WH'])      || 'WH1 - Central',
      zone:                pick(row, ['zone','Zone','ZONE'])              || 'Z02 - Storage',
      location:            pick(row, ['location','Location','LOC'])       || null,
      pallet_id:           pick(row, ['pallet_id','Pallet ID','PALLET'])  || null,
      pallet_type,
      quantity:            qty,
      base_unit:           pick(row, ['base_unit','Unit','BASE_UNIT'])    || 'PCS',
      status,
      product_type:        pick(row, ['product_type','Product Type'])     || null,
      compatibility_group: pick(row, ['compatibility_group','Compat'])    || null,
      max_weight_kg:       parseInt(pick(row, ['max_weight_kg','Max Weight']) || '0') || null,
    });
  });

  let inserted = 0, failed = 0;
  for (const r of valid) {
    try {
      const zs = await query('SELECT status FROM storage_zones WHERE name = $1', [r.zone]);
      if (zs.rows[0]?.status === 'CLOSED') {
        errors.push({ line: valid.indexOf(r) + 2, error: `Zone "${r.zone}" is closed — row skipped` });
        failed++; continue;
      }
      await query(
        `INSERT INTO storage_pallets
           (item_code, description, sku, warehouse, zone, location, pallet_id, pallet_type,
            quantity, base_unit, status, product_type, compatibility_group, max_weight_kg)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [r.item_code, r.description, r.sku, r.warehouse, r.zone, r.location, r.pallet_id,
         r.pallet_type, r.quantity, r.base_unit, r.status,
         r.product_type, r.compatibility_group, r.max_weight_kg]
      );
      inserted++;
    } catch (e) { errors.push({ line: valid.indexOf(r) + 2, error: e.message }); failed++; }
  }

  res.status(inserted > 0 ? 201 : 400).json({
    ok: inserted > 0, total_rows: rows.length, valid_parsed: valid.length,
    inserted, skipped: failed, errors,
    message: inserted > 0
      ? `Imported ${inserted} pallets.${failed > 0 ? ` ${failed} rows skipped.` : ''}`
      : 'No rows were imported.',
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// EXPORT (current filtered view → Excel download)
// ═══════════════════════════════════════════════════════════════════════════════
router.get('/export', ...guard, async (req, res) => {
  const { where, vals } = await buildWhere(req.query);
  const dataRes = await query(
    `SELECT id, item_code, description, sku, warehouse, zone, location, pallet_id,
            pallet_type, quantity, base_unit, status, product_type, compatibility_group,
            max_weight_kg, max_slots, updated_at
     FROM storage_pallets ${where} ORDER BY updated_at DESC`, vals
  );
  if (!dataRes.rows.length) return res.status(400).json({ error: 'No data to export with the current filters.' });

  const xlsRows = dataRes.rows.map(r => ({
    'Item Code':           r.item_code,
    'Description':         r.description,
    'SKU':                 r.sku || '',
    'Warehouse':           r.warehouse,
    'Zone':                r.zone,
    'Location':            r.location || '',
    'Pallet ID':           r.pallet_id || '',
    'Pallet Type':         r.pallet_type,
    'Quantity':            r.quantity,
    'Base Unit':           r.base_unit,
    'Status':              r.status,
    'Product Type':        r.product_type || '',
    'Compatibility Group': r.compatibility_group || '',
    'Max Weight (kg)':     r.max_weight_kg || '',
    'Max Slots':           r.max_slots || '',
    'Last Updated':        r.updated_at ? new Date(r.updated_at).toISOString().slice(0,19).replace('T',' ') : '',
  }));
  const wb  = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(xlsRows), 'Stock');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.set('Content-Disposition', `attachment; filename="stock-${new Date().toISOString().slice(0,10)}.xlsx"`);
  res.send(buf);
});

// ═══════════════════════════════════════════════════════════════════════════════
// MATRIX VIEW
// ═══════════════════════════════════════════════════════════════════════════════
router.get('/matrix', ...guard, async (req, res) => {
  const zonesAgg = await query(`
    SELECT p.zone, p.warehouse,
           COUNT(*)::int                                               AS total_pallets,
           SUM(CASE WHEN p.status='Available' THEN 1 ELSE 0 END)::int AS available,
           SUM(CASE WHEN p.status='Reserved'  THEN 1 ELSE 0 END)::int AS reserved,
           SUM(CASE WHEN p.status='On Hold'   THEN 1 ELSE 0 END)::int AS on_hold,
           COALESCE(SUM(p.quantity),0)::int                            AS total_units
    FROM storage_pallets p GROUP BY p.zone, p.warehouse
  `);
  const zoneMeta  = await query('SELECT id, name, warehouse, status, capacity_pallets, is_prep_zone, description FROM storage_zones ORDER BY warehouse, name');
  const metaMap   = {};
  for (const z of zoneMeta.rows) metaMap[z.name] = z;

  const allZoneNames = new Set([...zonesAgg.rows.map(z => z.zone), ...zoneMeta.rows.map(z => z.name)]);
  const agg = {};
  for (const r of zonesAgg.rows) agg[r.zone] = r;

  const today = new Date().toISOString().slice(0, 10);
  let activeDocks = [];
  try {
    const dr = await query(`
      SELECT a.dock_number, a.gate_state, t.operation_type, t.reference
      FROM appointments a
      JOIN schedule_versions v ON v.id = a.schedule_version_id
      JOIN schedules s ON s.id = v.schedule_id
      JOIN truck_requests t ON t.id = a.truck_request_id
      WHERE s.planning_date=$1 AND v.version_number=s.active_version
        AND a.gate_state IN ('ARRIVED','WAITING','AT_DOCK','MISE_EN_STOCK')
      ORDER BY a.dock_number
    `, [today]);
    activeDocks = dr.rows;
  } catch { /* no schedule */ }

  const zones = [...allZoneNames].map(name => {
    const meta = metaMap[name];
    const data = agg[name] || { total_pallets: 0, available: 0, reserved: 0, on_hold: 0, total_units: 0 };
    const cap  = meta?.capacity_pallets || 50;
    return {
      zone_id:       meta?.id || null,
      name,
      warehouse:     meta?.warehouse || data.warehouse || 'Unknown',
      status:        meta?.status  || 'OPEN',
      capacity:      cap,
      is_prep_zone:  meta?.is_prep_zone  || false,
      description:   meta?.description   || null,
      total_pallets: data.total_pallets,
      available:     data.available,
      reserved:      data.reserved,
      on_hold:       data.on_hold,
      total_units:   data.total_units,
      occupancy_pct: Math.min(100, Math.round((data.total_pallets / cap) * 100)),
      prep_active:   data.reserved > 0,
    };
  }).sort((a, b) => a.warehouse.localeCompare(b.warehouse) || a.name.localeCompare(b.name));

  const dockCount = ((await query('SELECT dock_count FROM parameter_sets WHERE is_active=TRUE ORDER BY version DESC LIMIT 1')).rows[0]?.dock_count) || 16;
  const activeDockNums = new Set(activeDocks.map(d => d.dock_number));
  const allDocks = Array.from({ length: dockCount }, (_, i) => ({
    dock_number: i + 1,
    active: activeDockNums.has(i + 1),
    state:  activeDocks.find(d => d.dock_number === i + 1)?.gate_state || null,
    truck:  activeDocks.find(d => d.dock_number === i + 1)?.reference  || null,
  }));

  res.json({ zones, docks: allDocks, total_docks: dockCount, active_dock_count: activeDockNums.size });
});

// ═══════════════════════════════════════════════════════════════════════════════
// ZONE MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════════
router.get('/zones-list', ...guard, async (req, res) => {
  const r = await query(`
    SELECT z.*, COALESCE(p.cnt,0)::int AS pallet_count
    FROM storage_zones z
    LEFT JOIN (SELECT zone, COUNT(*)::int AS cnt FROM storage_pallets GROUP BY zone) p ON p.zone = z.name
    ORDER BY z.warehouse, z.name
  `);
  res.json(r.rows);
});

router.put('/zones/:id/status', ...guard, async (req, res) => {
  const { status } = req.body;
  if (!['OPEN','CLOSED'].includes(status)) return res.status(400).json({ error: 'status must be OPEN or CLOSED' });
  const zoneRes = await query('SELECT * FROM storage_zones WHERE id = $1', [req.params.id]);
  if (!zoneRes.rows[0]) return res.status(404).json({ error: 'Zone not found' });
  const zoneName = zoneRes.rows[0].name;
  if (status === 'CLOSED') {
    const active = await query(
      "SELECT COUNT(*)::int AS n FROM storage_pallets WHERE zone=$1 AND status != 'Available'",
      [zoneName]
    );
    if (active.rows[0].n > 0) {
      return res.status(400).json({
        error: `Cannot close zone "${zoneName}": ${active.rows[0].n} pallet(s) are Reserved or On Hold. Relocate or release them first.`,
      });
    }
  }
  await query('UPDATE storage_zones SET status=$1, updated_at=now() WHERE id=$2', [status, req.params.id]);
  res.json({ id: parseInt(req.params.id), name: zoneName, status });
});

// ═══════════════════════════════════════════════════════════════════════════════
// TRANSFER
// ═══════════════════════════════════════════════════════════════════════════════
router.post('/transfer', ...guard, async (req, res) => {
  const { type, pallet_id, new_zone, new_location, swap_with_id, method = 'MANUAL' } = req.body;
  if (!pallet_id) return res.status(400).json({ error: 'pallet_id is required' });
  const pallet = (await query('SELECT * FROM storage_pallets WHERE id=$1', [pallet_id])).rows[0];
  if (!pallet) return res.status(404).json({ error: 'Pallet not found' });

  if (type === 'relocate') {
    if (!new_zone) return res.status(400).json({ error: 'new_zone is required for relocate' });
    const zs = await query('SELECT status FROM storage_zones WHERE name=$1', [new_zone]);
    if (zs.rows[0]?.status === 'CLOSED') return res.status(400).json({ error: `Zone "${new_zone}" is closed.` });
    await query('UPDATE storage_pallets SET zone=$1, location=$2, updated_at=now() WHERE id=$3', [new_zone, new_location||null, pallet_id]);
    return res.json({ ok: true, type: 'relocate', pallet_id, new_zone, new_location });
  }

  if (type === 'swap') {
    if (!swap_with_id) return res.status(400).json({ error: 'swap_with_id is required for swap' });
    if (parseInt(pallet_id) === parseInt(swap_with_id)) return res.status(400).json({ error: 'Cannot swap a pallet with itself' });
    const other = (await query('SELECT * FROM storage_pallets WHERE id=$1', [swap_with_id])).rows[0];
    if (!other) return res.status(404).json({ error: 'Target pallet not found' });
    await query('UPDATE storage_pallets SET zone=$1, location=$2, warehouse=$3, updated_at=now() WHERE id=$4', [other.zone, other.location, other.warehouse, pallet.id]);
    await query('UPDATE storage_pallets SET zone=$1, location=$2, warehouse=$3, updated_at=now() WHERE id=$4', [pallet.zone, pallet.location, pallet.warehouse, other.id]);
    return res.json({ ok: true, type: 'swap', swapped: [pallet.id, other.id] });
  }

  if (type === 'dispatch') {
    let targetId = parseInt(pallet_id);
    if (method === 'FIFO') {
      const fifo = await query("SELECT id FROM storage_pallets WHERE item_code=$1 AND status='Available' ORDER BY created_at ASC LIMIT 1", [pallet.item_code]);
      if (fifo.rows[0]) targetId = fifo.rows[0].id;
    }
    await query("UPDATE storage_pallets SET status='On Hold', updated_at=now() WHERE id=$1", [targetId]);
    return res.json({ ok: true, type: 'dispatch', pallet_id: targetId, method });
  }

  return res.status(400).json({ error: 'Unknown transfer type. Use: relocate, swap, dispatch' });
});

// ═══════════════════════════════════════════════════════════════════════════════
// MOVE TO PREP ZONE
// ═══════════════════════════════════════════════════════════════════════════════
router.post('/pallets/:id/move-to-prep', ...guard, async (req, res) => {
  const { prep_zone, prep_location } = req.body;
  const pallet = (await query('SELECT * FROM storage_pallets WHERE id=$1', [req.params.id])).rows[0];
  if (!pallet) return res.status(404).json({ error: 'Pallet not found' });
  let targetZone = prep_zone;
  if (!targetZone) {
    const zr = await query("SELECT name FROM storage_zones WHERE is_prep_zone=TRUE AND status='OPEN' LIMIT 1");
    if (!zr.rows[0]) return res.status(400).json({ error: 'No open preparation zones available.' });
    targetZone = zr.rows[0].name;
  } else {
    const zs = await query('SELECT status FROM storage_zones WHERE name=$1', [targetZone]);
    if (zs.rows[0]?.status === 'CLOSED') return res.status(400).json({ error: `Zone "${targetZone}" is closed.` });
  }
  await query("UPDATE storage_pallets SET zone=$1, location=$2, status='Reserved', updated_at=now() WHERE id=$3",
    [targetZone, prep_location||null, req.params.id]);
  res.json({ ok: true, id: parseInt(req.params.id), zone: targetZone, location: prep_location||null, status: 'Reserved' });
});

// ═══════════════════════════════════════════════════════════════════════════════
// PALLET ALLOCATION
// ═══════════════════════════════════════════════════════════════════════════════
router.post('/pallets/allocate', ...guard, async (req, res) => {
  const { item_code, quantity = 1, pallet_type = 'EUR', preferred_warehouse, product_type } = req.body;
  if (!item_code) return res.status(400).json({ error: 'item_code is required' });
  const conds = ["z.status = 'OPEN'"];
  const vals  = [];
  let i = 1;
  if (preferred_warehouse) { conds.push(`z.warehouse = $${i++}`); vals.push(preferred_warehouse); }
  const zonesQ = await query(`
    SELECT z.id, z.name, z.warehouse, z.capacity_pallets,
           COALESCE(COUNT(p.id),0)::int AS current_count
    FROM storage_zones z
    LEFT JOIN storage_pallets p ON p.zone = z.name
    WHERE ${conds.join(' AND ')}
    GROUP BY z.id, z.name, z.warehouse, z.capacity_pallets
    HAVING COALESCE(COUNT(p.id),0) < z.capacity_pallets
    ORDER BY (COALESCE(COUNT(p.id),0)::float / z.capacity_pallets) ASC
    LIMIT 5
  `, vals);
  if (!zonesQ.rows.length) return res.status(400).json({ error: preferred_warehouse ? `No open zones with capacity in "${preferred_warehouse}".` : 'No open zones with available capacity.' });
  const zone = zonesQ.rows[0];
  const np = await query(
    `INSERT INTO storage_pallets (item_code, zone, warehouse, pallet_type, quantity, status, product_type)
     VALUES ($1,$2,$3,$4,$5,'Available',$6) RETURNING *`,
    [item_code, zone.name, zone.warehouse, pallet_type, quantity, product_type||null]
  );
  res.status(201).json({
    pallet: np.rows[0], allocated_zone: zone.name, warehouse: zone.warehouse,
    zone_capacity: zone.capacity_pallets, zone_used: zone.current_count + 1,
    alternatives: zonesQ.rows.slice(1).map(z => ({ name: z.name, warehouse: z.warehouse, available: z.capacity_pallets - z.current_count })),
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// DISTINCT HELPERS
// ═══════════════════════════════════════════════════════════════════════════════
router.get('/zones',      ...guard, async (req, res) => { const r = await query('SELECT DISTINCT zone FROM storage_pallets ORDER BY zone'); res.json(r.rows.map(r => r.zone)); });
router.get('/warehouses', ...guard, async (req, res) => { const r = await query('SELECT DISTINCT warehouse FROM storage_pallets ORDER BY warehouse'); res.json(r.rows.map(r => r.warehouse)); });

module.exports = router;
