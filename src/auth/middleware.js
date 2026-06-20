const { verifyToken } = require('./jwt');
const { query } = require('../db');

// Requires a valid token. Attaches the current active DB user to req.user.
async function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  try {
    const payload = verifyToken(token);
    const result = await query(
      `SELECT id, email, name, role, is_active, department, employee_id
       FROM users
       WHERE id = $1`,
      [payload.id]
    );
    const user = result.rows[0];
    if (!user || !user.is_active) {
      return res.status(401).json({ error: 'Account is inactive or no longer exists' });
    }
    req.user = { ...user, role: user.role === 'admin' ? 'supervisor' : user.role };
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// Requires the user's role to be in the allowed list. Returns 403 otherwise.
function requireRole(...allowedRoles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Forbidden: insufficient permissions' });
    }
    next();
  };
}

module.exports = { requireAuth, requireRole };
