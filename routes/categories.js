const router = require('express').Router();
const db = require('../db');
const auth = require('../middleware/auth');

router.get('/', async (req, res) => {
  try {
    const [rows] = await db.query('SELECT * FROM categories WHERE is_active = 1 ORDER BY name');
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/', auth, async (req, res) => {
  const { name, description, image_url } = req.body;
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  try {
    const [result] = await db.query(
      'INSERT INTO categories (name, slug, description, image_url) VALUES (?,?,?,?)',
      [name, slug, description, image_url]
    );
    res.status(201).json({ id: result.insertId });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/:id', auth, async (req, res) => {
  const { name, description, image_url, is_active } = req.body;
  try {
    await db.query(
      'UPDATE categories SET name=?, description=?, image_url=?, is_active=? WHERE id=?',
      [name, description, image_url, is_active ?? 1, req.params.id]
    );
    res.json({ message: 'Category updated' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
