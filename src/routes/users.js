const express = require('express');
const bcrypt = require('bcrypt');
const { query } = require('../db');
const { requireAuth, requireRole } = require('../auth/middleware');

const router = express.Router();
const guard = [requireAuth, requireRole('supervisor')];

const validRoles = ['supervisor', 'gate', 'acdc'];

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function publicUser(row) {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role === 'admin' ? 'supervisor' : row.role,
    is_active: row.is_active,
    department: row.department,
    employee_id: row.employee_id,
    last_login: row.last_login,
    created_at: row.created_at,
  };
}

// ── helpers ────────────────────────────────────────────────────────────────

function buildWhere(filters) {
  const conds = [];
  const vals = [];
  let i = 1;

  if (filters.search) {
    conds.push(`(u.name ILIKE $${i} OR u.email ILIKE $${i} OR u.employee_id ILIKE $${i})`);
    vals.push(`%${filters.search}%`); i++;
  }
  if (filters.role) {
    conds.push(`u.role = $${i}`); vals.push(filters.role); i++;
  }
  if (filters.department) {
    conds.push(`u.department ILIKE $${i}`); vals.push(`%${filters.department}%`); i++;
  }
  if (filters.status === 'active') {
    conds.push(`u.is_active = true`);
  } else if (filters.status === 'inactive') {
    conds.push(`u.is_active = false`);
  }

  return { where: conds.length ? 'WHERE ' + conds.join(' AND ') : '', vals };
}

// ── GET /api/users ─────────────────────────────────────────────────────────
router.get('/', ...guard, async (req, res) => {
  const { search = '', role = '', status = '', department = '', page = 1, limit = 10 } = req.query;
  const { where, vals } = buildWhere({ search, role, status, department });
  const offset = (parseInt(page) - 1) * parseInt(limit);

  const countQ = await query(`SELECT COUNT(*) FROM users u ${where}`, vals);
  const total = parseInt(countQ.rows[0].count);

  const dataQ = await query(
    `SELECT u.id, u.email, u.name, u.role, u.is_active, u.department,
            u.last_login, u.employee_id, u.created_at
     FROM users u
     ${where}
     ORDER BY u.created_at DESC
     LIMIT $${vals.length + 1} OFFSET $${vals.length + 2}`,
    [...vals, parseInt(limit), offset]
  );

  res.json({ users: dataQ.rows.map(publicUser), total, page: parseInt(page), pages: Math.ceil(total / parseInt(limit)) });
});

// ── GET /api/users/:id ─────────────────────────────────────────────────────
router.get('/:id', ...guard, async (req, res) => {
  const r = await query(
    `SELECT id, email, name, role, is_active, department, last_login, employee_id, created_at
     FROM users WHERE id = $1`,
    [req.params.id]
  );
  if (!r.rows[0]) return res.status(404).json({ error: 'User not found' });
  res.json(publicUser(r.rows[0]));
});

// ── POST /api/users ─────────────────────────────────────────────────────────
router.post('/', ...guard, async (req, res) => {
  const { email, name, password, role, department = 'General', employee_id = '' } = req.body;
  if (!email || !name || !password || !role) {
    return res.status(400).json({ error: 'email, name, password and role are required' });
  }
  if (!validRoles.includes(role)) return res.status(400).json({ error: 'Invalid role' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

  const hash = await bcrypt.hash(password, 10);
  try {
    const r = await query(
      `INSERT INTO users (email, name, password_hash, role, department, employee_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, email, name, role, is_active, department, employee_id, last_login, created_at`,
      [normalizeEmail(email), name.trim(), hash, role, department, employee_id]
    );
    res.status(201).json(publicUser(r.rows[0]));
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'A user with this email already exists' });
    throw err;
  }
});

// ── PUT /api/users/:id ──────────────────────────────────────────────────────
router.put('/:id', ...guard, async (req, res) => {
  const { name, email, role, department, employee_id, is_active } = req.body;
  const sets = [];
  const vals = [];
  let i = 1;

  if (name       !== undefined) { sets.push(`name = $${i++}`);            vals.push(name); }
  if (email      !== undefined) { sets.push(`email = $${i++}`);           vals.push(normalizeEmail(email)); }
  if (role       !== undefined) {
    if (!validRoles.includes(role)) return res.status(400).json({ error: 'Invalid role' });
    sets.push(`role = $${i++}`); vals.push(role);
  }
  if (department !== undefined) { sets.push(`department = $${i++}`);      vals.push(department); }
  if (employee_id!== undefined) { sets.push(`employee_id = $${i++}`);     vals.push(employee_id); }
  if (is_active  !== undefined) { sets.push(`is_active = $${i++}`);       vals.push(is_active); }
  if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });
  vals.push(req.params.id);

  try {
    const r = await query(
      `UPDATE users SET ${sets.join(', ')} WHERE id = $${i}
       RETURNING id, email, name, role, is_active, department, employee_id, last_login, created_at`,
      vals
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'User not found' });
    res.json(publicUser(r.rows[0]));
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'A user with this email already exists' });
    throw err;
  }
});

// ── PUT /api/users/:id/password ─────────────────────────────────────────────
router.put('/:id/password', ...guard, async (req, res) => {
  const { password } = req.body;
  if (!password || password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  }
  const hash = await bcrypt.hash(password, 10);
  const r = await query(
    `UPDATE users SET password_hash = $1 WHERE id = $2 RETURNING id, name, email`,
    [hash, req.params.id]
  );
  if (!r.rows[0]) return res.status(404).json({ error: 'User not found' });
  res.json({ ok: true, user: r.rows[0] });
});

// ── DELETE /api/users/:id ───────────────────────────────────────────────────
router.delete('/:id', requireAuth, requireRole('supervisor'), async (req, res) => {
  const { permanent = false } = req.query;

  if (String(req.params.id) === String(req.user.id)) {
    return res.status(400).json({ error: 'You cannot delete your own account' });
  }

  if (permanent === 'true') {
    await query('DELETE FROM users WHERE id = $1', [req.params.id]);
    res.json({ ok: true, deleted: true });
  } else {
    const r = await query(
      `UPDATE users SET is_active = false WHERE id = $1 RETURNING id`,
      [req.params.id]
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'User not found' });
    res.json({ ok: true, deactivated: true });
  }
});

module.exports = router;
