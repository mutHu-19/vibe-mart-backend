const router = require('express').Router();
const db = require('../db');
const auth = require('../middleware/auth');

// GET /api/announcements — public, active items only, for the storefront ticker
router.get('/', async (req, res) => {
  try {
    const [rows] = await db.query(
      'SELECT * FROM announcement_items WHERE is_active = 1 ORDER BY sort_order ASC, id ASC'
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/announcements/admin — protected, all items for the admin panel
router.get('/admin', auth, async (req, res) => {
  try {
    const [rows] = await db.query(
      'SELECT * FROM announcement_items ORDER BY sort_order ASC, id ASC'
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/announcements — create a new item
router.post('/', auth, async (req, res) => {
  const { text, sort_order } = req.body;
  if (!text?.trim()) return res.status(400).json({ error: 'Text is required' });
  try {
    const [result] = await db.query(
      'INSERT INTO announcement_items (text, sort_order, is_active) VALUES (?,?,1)',
      [text.trim(), sort_order || 0]
    );
    res.status(201).json({ id: result.insertId, text: text.trim(), sort_order: sort_order || 0, is_active: 1 });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /api/announcements/:id — update text/order
router.put('/:id', auth, async (req, res) => {
  const { text, sort_order } = req.body;
  if (!text?.trim()) return res.status(400).json({ error: 'Text is required' });
  try {
    await db.query(
      'UPDATE announcement_items SET text = ?, sort_order = ? WHERE id = ?',
      [text.trim(), sort_order || 0, req.params.id]
    );
    res.json({ message: 'Updated' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /api/announcements/:id/toggle — flip active/inactive
router.put('/:id/toggle', auth, async (req, res) => {
  try {
    const [[item]] = await db.query('SELECT is_active FROM announcement_items WHERE id = ?', [req.params.id]);
    if (!item) return res.status(404).json({ error: 'Not found' });
    const newStatus = item.is_active ? 0 : 1;
    await db.query('UPDATE announcement_items SET is_active = ? WHERE id = ?', [newStatus, req.params.id]);
    res.json({ is_active: newStatus });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /api/announcements/:id — permanent delete
router.delete('/:id', auth, async (req, res) => {
  try {
    await db.query('DELETE FROM announcement_items WHERE id = ?', [req.params.id]);
    res.json({ message: 'Deleted' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;