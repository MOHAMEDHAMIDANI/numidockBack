const express = require('express');
const bcrypt = require('bcrypt');
const { query } = require('../db');
const { signToken } = require('../auth/jwt');
const { requireAuth } = require('../auth/middleware');

const router = express.Router();

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
  };
}

// POST /api/auth/login
router.post('/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }
  const normalizedEmail = String(email).trim().toLowerCase();

  const result = await query(
    `SELECT id, email, name, password_hash, role, is_active, department,
            employee_id, last_login
     FROM users
     WHERE LOWER(email) = $1`,
    [normalizedEmail]
  );
  const user = result.rows[0];

  if (!user || !user.is_active) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const updated = await query(
    `UPDATE users SET last_login = now()
     WHERE id = $1
     RETURNING id, email, name, role, is_active, department, employee_id, last_login`,
    [user.id]
  );
  const freshUser = updated.rows[0] || user;
  const token = signToken({ id: freshUser.id, email: freshUser.email, role: freshUser.role });
  res.json({
    token,
    user: publicUser(freshUser),
  });
});

// GET /api/auth/me  (requires token)
router.get('/me', requireAuth, async (req, res) => {
  const result = await query(
    `SELECT id, email, name, role, is_active, department, employee_id, last_login
     FROM users
     WHERE id = $1`,
    [req.user.id]
  );
  const user = result.rows[0];
  if (!user || !user.is_active) {
    return res.status(401).json({ error: 'Account is inactive or no longer exists' });
  }
  res.json({ user: publicUser(user) });
});

module.exports = router;
