const router = require('express').Router();
const db = require('../db');
const auth = require('../middleware/auth');

// GET /api/banner-slides — public: active slides only, ordered
router.get('/', async (req, res) => {
  try {
    const [rows] = await db.query(
      'SELECT * FROM banner_slides WHERE is_active = 1 ORDER BY sort_order ASC, id ASC'
    );
    res.json(rows);
  } catch (err) {
    res.json([]); // table might not exist yet on an un-migrated DB
  }
});

// GET /api/banner-slides/admin — admin: all slides, including inactive
router.get('/admin', auth, async (req, res) => {
  try {
    const [rows] = await db.query('SELECT * FROM banner_slides ORDER BY sort_order ASC, id ASC');
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/banner-slides — admin: add a slide
router.post('/', auth, async (req, res) => {
  const { image_url, link_url, sort_order } = req.body;
  if (!image_url) return res.status(400).json({ error: 'image_url is required' });
  try {
    const [[{ cnt }]] = await db.query('SELECT COUNT(*) cnt FROM banner_slides');
    if (cnt >= 5) return res.status(400).json({ error: 'Maximum 5 slides allowed' });
    const [r] = await db.query(
      'INSERT INTO banner_slides (image_url, link_url, sort_order, is_active) VALUES (?,?,?,1)',
      [image_url, link_url || null, sort_order ?? cnt]
    );
    res.json({ id: r.insertId, message: 'Slide added' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /api/banner-slides/:id — admin: update a slide
router.put('/:id', auth, async (req, res) => {
  const { image_url, link_url, sort_order, is_active } = req.body;
  try {
    await db.query(
      'UPDATE banner_slides SET image_url=?, link_url=?, sort_order=?, is_active=? WHERE id=?',
      [image_url, link_url || null, sort_order ?? 0, is_active ? 1 : 0, req.params.id]
    );
    res.json({ message: 'Slide updated' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /api/banner-slides/:id — admin
router.delete('/:id', auth, async (req, res) => {
  try {
    await db.query('DELETE FROM banner_slides WHERE id=?', [req.params.id]);
    res.json({ message: 'Slide deleted' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
