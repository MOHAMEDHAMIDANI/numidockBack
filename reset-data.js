/**
 * reset-data.js
 * Wipes every row of operational data from the database and restores the
 * storage_pallets seed rows so the app starts with a clean slate.
 *
 * Keeps intact:
 *   - users  (supervisor + any demo users you created with make-demo-users.js)
 *   - parameter_sets, shifts, operation_durations
 *   - storage_zones
 *
 * Run once before handing the demo to the teacher:
 *   node reset-data.js
 */

const { pool } = require('./src/db');

async function reset() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // ── 1. Operational tables, in FK-safe order ──────────────────────────────
    await client.query('DELETE FROM acdc_tasks');
    await client.query('DELETE FROM preparation_events');
    await client.query('DELETE FROM check_ins');
    await client.query('DELETE FROM driver_tokens');
    await client.query('DELETE FROM appointments');
    await client.query('DELETE FROM schedule_versions');
    await client.query('DELETE FROM truck_requests');
    await client.query('DELETE FROM schedules');

    // ── 2. Wipe all existing storage pallets ─────────────────────────────────
    await client.query('DELETE FROM storage_pallets');

    // ── 3. Re-seed the 10 default storage pallets (from migration 012) ───────
    await client.query(`
      INSERT INTO storage_pallets
        (item_code, description, sku, warehouse, zone, location, pallet_id, pallet_type, quantity, base_unit, status)
      VALUES
        ('ITM-10001','Electric Motor 5kW',   'EM-5KW',     'WH1 - Central','Z01 - Receiving','Z01-R01-L02','PALT-000123','EUR', 12,'PCS','Available'),
        ('ITM-10002','Gearbox Reducer',       'GBX-RED-50', 'WH1 - Central','Z02 - Storage',  'Z02-A03-L01','PALT-000124','EUR',  8,'PCS','Available'),
        ('ITM-10003','Bearing 6205',          'BRG-6205',   'WH1 - Central','Z02 - Storage',  'Z02-B01-L03','PALT-000125','EUR',200,'PCS','Available'),
        ('ITM-10004','Hydraulic Pump',        'HDP-10A',    'WH2 - North',  'Z03 - Bulk',     'Z03-C02-L01','PALT-000126','IND',  6,'PCS','Reserved'),
        ('ITM-10005','Filter Element',        'FLT-100',    'WH1 - Central','Z02 - Storage',  'Z02-B02-L02','PALT-000127','EUR',150,'PCS','Available'),
        ('ITM-10006','Seal Kit',              'SEAL-KIT-01','WH3 - South',  'Z04 - Picking',  'Z04-P01-L01','PALT-000128','EUR', 30,'PCS','Available'),
        ('ITM-10007','Vent Valve',            'VV-25',      'WH2 - North',  'Z02 - Storage',  'Z02-A01-L04','PALT-000129','IND', 25,'PCS','On Hold'),
        ('ITM-10008','Pressure Gauge',        'PG-63',      'WH3 - South',  'Z03 - Bulk',     'Z03-C01-L02','PALT-000130','EUR', 40,'PCS','Available'),
        ('ITM-10009','Coupling',              'CPG-24',     'WH1 - Central','Z02 - Storage',  'Z02-B03-L01','PALT-000131','EUR', 18,'PCS','Reserved'),
        ('ITM-10010','Lubricant Oil 20L',     'LUB-20L',    'WH2 - North',  'Z05 - Chemical', 'Z05-D01-L01','PALT-000132','IND', 60,'PCS','Available')
    `);

    await client.query('COMMIT');

    console.log('');
    console.log('✓  acdc_tasks          cleared');
    console.log('✓  preparation_events  cleared');
    console.log('✓  check_ins           cleared');
    console.log('✓  driver_tokens       cleared');
    console.log('✓  appointments        cleared');
    console.log('✓  schedule_versions   cleared');
    console.log('✓  truck_requests      cleared');
    console.log('✓  schedules           cleared');
    console.log('✓  storage_pallets     reset to 10 seed rows');
    console.log('');
    console.log('Kept: users, parameter_sets, shifts, operation_durations, storage_zones.');
    console.log('');
    console.log('Database is clean and ready for the demo.');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Reset failed:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

reset();
