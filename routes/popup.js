const router = require('express').Router();
const db = require('../db');
const auth = require('../middleware/auth');

// GET /api/popup — public: get active popup (for shop frontend)
router.get('/', async (req, res) => {
  try {
    const [[popup]] = await db.query(
      'SELECT * FROM popup_messages WHERE is_active = 1 ORDER BY id DESC LIMIT 1'
    );
    res.json(popup || null);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/popup/settings — admin: get popup settings (active or not)
router.get('/settings', auth, async (req, res) => {
  try {
    const [[popup]] = await db.query(
      'SELECT * FROM popup_messages ORDER BY id DESC LIMIT 1'
    );
    res.json(popup || null);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /api/popup — admin: update popup (both roles allowed)
router.put('/', auth, async (req, res) => {
  const {
    title, message, button_text, button_url,
    bg_color, text_color, show_once, delay_seconds, is_active
  } = req.body;

  if (!message?.trim()) return res.status(400).json({ error: 'Message is required' });

  try {
    // Check if record exists
    const [[existing]] = await db.query('SELECT id FROM popup_messages LIMIT 1');

    if (existing) {
      await db.query(
        `UPDATE popup_messages SET
          title=?, message=?, button_text=?, button_url=?,
          bg_color=?, text_color=?, show_once=?, delay_seconds=?,
          is_active=?, updated_by=?
         WHERE id=?`,
        [
          title || '', message, button_text || 'OK, Got it!', button_url || '',
          bg_color || '#0288d1', text_color || '#ffffff',
          show_once ? 1 : 0, delay_seconds || 2,
          is_active ? 1 : 0, req.admin.id, existing.id
        ]
      );
    } else {
      await db.query(
        `INSERT INTO popup_messages
          (title, message, button_text, button_url, bg_color, text_color, show_once, delay_seconds, is_active, updated_by)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [
          title || '', message, button_text || 'OK, Got it!', button_url || '',
          bg_color || '#0288d1', text_color || '#ffffff',
          show_once ? 1 : 0, delay_seconds || 2,
          is_active ? 1 : 0, req.admin.id
        ]
      );
    }
    res.json({ message: 'Popup updated successfully' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PATCH /api/popup/toggle — admin: quick toggle active/inactive
router.patch('/toggle', auth, async (req, res) => {
  try {
    const [[current]] = await db.query('SELECT id, is_active FROM popup_messages LIMIT 1');
    if (!current) return res.status(404).json({ error: 'No popup configured yet' });
    const newState = current.is_active ? 0 : 1;
    await db.query('UPDATE popup_messages SET is_active=?, updated_by=? WHERE id=?',
      [newState, req.admin.id, current.id]);
    res.json({ is_active: newState, message: newState ? 'Popup enabled' : 'Popup disabled' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
