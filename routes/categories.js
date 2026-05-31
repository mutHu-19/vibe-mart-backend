const router = require('express').Router();
const db = require('../db');
const auth = require('../middleware/auth');

// GET /api/categories - all active categories with subcategories
router.get('/', async (req, res) => {
  try {
    const [cats] = await db.query(
      'SELECT * FROM categories WHERE is_active = 1 ORDER BY sort_order ASC, name ASC'
    );
    const [subs] = await db.query(
      'SELECT * FROM subcategories WHERE is_active = 1 ORDER BY sort_order ASC, name ASC'
    );
    // Attach subcategories to each category
    const result = cats.map(c => ({
      ...c,
      subcategories: subs.filter(s => s.category_id === c.id)
    }));
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/categories/admin/all - admin: all including inactive
router.get('/admin/all', auth, async (req, res) => {
  try {
    const [cats] = await db.query(
      'SELECT * FROM categories ORDER BY sort_order ASC, name ASC'
    );
    const [subs] = await db.query(
      'SELECT * FROM subcategories ORDER BY category_id, sort_order ASC'
    );
    const result = cats.map(c => ({
      ...c,
      subcategories: subs.filter(s => s.category_id === c.id)
    }));
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/categories - create category
router.post('/', auth, async (req, res) => {
  const { name, description, image_url, sort_order } = req.body;
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  try {
    const [result] = await db.query(
      'INSERT INTO categories (name, slug, description, image_url, sort_order) VALUES (?,?,?,?,?)',
      [name, slug, description || null, image_url || null, sort_order || 0]
    );
    res.status(201).json({ id: result.insertId, slug });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /api/categories/:id - update category
router.put('/:id', auth, async (req, res) => {
  const { name, description, image_url, is_active, sort_order } = req.body;
  try {
    await db.query(
      'UPDATE categories SET name=?, description=?, image_url=?, is_active=?, sort_order=? WHERE id=?',
      [name, description || null, image_url || null, is_active ?? 1, sort_order || 0, req.params.id]
    );
    res.json({ message: 'Category updated' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /api/categories/:id
router.delete('/:id', auth, async (req, res) => {
  try {
    await db.query('UPDATE categories SET is_active = 0 WHERE id = ?', [req.params.id]);
    res.json({ message: 'Category deactivated' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---- SUBCATEGORY ROUTES ----

// POST /api/categories/:id/subcategories
router.post('/:id/subcategories', auth, async (req, res) => {
  const { name, image_url, sort_order } = req.body;
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') + '-' + Date.now();
  try {
    const [result] = await db.query(
      'INSERT INTO subcategories (category_id, name, slug, image_url, sort_order) VALUES (?,?,?,?,?)',
      [req.params.id, name, slug, image_url || null, sort_order || 0]
    );
    res.status(201).json({ id: result.insertId, slug });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /api/categories/subcategories/:id
router.put('/subcategories/:id', auth, async (req, res) => {
  const { name, image_url, is_active, sort_order } = req.body;
  try {
    await db.query(
      'UPDATE subcategories SET name=?, image_url=?, is_active=?, sort_order=? WHERE id=?',
      [name, image_url || null, is_active ?? 1, sort_order || 0, req.params.id]
    );
    res.json({ message: 'Subcategory updated' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /api/categories/subcategories/:id
router.delete('/subcategories/:id', auth, async (req, res) => {
  try {
    await db.query('DELETE FROM subcategories WHERE id = ?', [req.params.id]);
    res.json({ message: 'Subcategory deleted' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
