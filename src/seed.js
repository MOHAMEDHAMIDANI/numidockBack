const bcrypt = require('bcrypt');
const { pool } = require('./db');

async function seed() {
  // --- Default supervisor user ---
  const email = 'supervisor@numidock.dz';
  const password = 'supervisor';
  const passwordHash = await bcrypt.hash(password, 10);

  const userResult = await pool.query(
    `INSERT INTO users (email, name, password_hash, role)
     VALUES ($1, $2, $3, 'supervisor')
     ON CONFLICT (email) DO NOTHING
     RETURNING id`,
    [email, 'Supervisor', passwordHash]
  );

  if (userResult.rows.length > 0) {
    console.log(`Supervisor user created: ${email} / ${password}`);
  } else {
    console.log(`Supervisor user already exists: ${email}`);
  }

  // Get the supervisor id (whether just created or already existing)
  const supervisorRow = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
  const supervisorId = supervisorRow.rows[0].id;

  // --- Parameter set version 1 (skip if one already exists) ---
  const existingParams = await pool.query('SELECT id FROM parameter_sets WHERE version = 1');
  if (existingParams.rows.length > 0) {
    console.log('Parameter set v1 already exists, skipping.');
    await pool.end();
    return;
  }

  const paramResult = await pool.query(
    `INSERT INTO parameter_sets
      (version, dock_count, slot_minutes, horizon_start_min, horizon_end_min,
       workers_per_dock, arrival_window_min, lateness_tolerance_min,
       acdc_delay_threshold_min, max_overtime_min, is_active, created_by)
     VALUES (1, 16, 30, 0, 1440, 3, 20, 30, 30, 0, TRUE, $1)
     RETURNING id`,
    [supervisorId]
  );
  const paramId = paramResult.rows[0].id;
  console.log(`Parameter set v1 created (id ${paramId}).`);

  // --- Shifts ---
  const shifts = [
    ['Shift 1', 480, 960, 4],     // 08:00-16:00
    ['Shift 2', 960, 1440, 14],   // 16:00-00:00
    ['Shift 3', 0, 480, 13],      // 00:00-08:00
  ];
  for (const [name, start, end, workers] of shifts) {
    await pool.query(
      `INSERT INTO shifts (parameter_set_id, name, start_min, end_min, workers_available)
       VALUES ($1, $2, $3, $4, $5)`,
      [paramId, name, start, end, workers]
    );
  }
  console.log('Shifts created (3).');

  // --- Operation durations ---
  const durations = [
    ['LOAD', 90, 30, 0],
    ['UNLOAD', 0, 30, 90],
    ['LOAD_UNLOAD', 90, 60, 90],
  ];
  for (const [type, prep, service, mise] of durations) {
    await pool.query(
      `INSERT INTO operation_durations
        (parameter_set_id, operation_type, preparation_min, service_min, mise_en_stock_min)
       VALUES ($1, $2, $3, $4, $5)`,
      [paramId, type, prep, service, mise]
    );
  }
  console.log('Operation durations created (3).');

  console.log('Seed complete.');
  await pool.end();
}

seed().catch((err) => {
  console.error('Seed failed:', err.message);
  process.exit(1);
});
