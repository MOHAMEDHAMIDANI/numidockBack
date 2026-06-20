const express = require('express');
const { query } = require('../db');

const router = express.Router();

router.get('/live', (req, res) => {
  res.json({ status: 'ok' });
});

router.get('/ready', async (req, res) => {
  try {
    await query('SELECT 1');
    res.json({ status: 'ready', database: 'ok' });
  } catch (err) {
    console.error('DB ERROR:', err.message);
    res.status(500).json({ status: 'error', database: 'unreachable' });
  }
});

module.exports = router;