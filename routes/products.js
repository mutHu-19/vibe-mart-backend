const router = require('express').Router();
const db = require('../db');
const auth = require('../middleware/auth');

// GET /api/products - public listing with filters
router.get('/', async (req, res) => {
  try {
    const { category, search, page = 1, limit = 12 } = req.query;
    const offset = (page - 1) * limit;
    let where = 'p.is_active = 1';
    const params = [];

    if (category) { where += ' AND c.slug = ?'; params.push(category); }
    if (search) { where += ' AND (p.name LIKE ? OR p.description LIKE ?)'; params.push(`%${search}%`, `%${search}%`); }

    const [products] = await db.query(`
      SELECT p.*, c.name as category_name, c.slug as category_slug
      FROM products p LEFT JOIN categories c ON p.category_id = c.id
      WHERE ${where} ORDER BY p.created_at DESC LIMIT ? OFFSET ?
    `, [...params, parseInt(limit), parseInt(offset)]);

    const [[{ total }]] = await db.query(`
      SELECT COUNT(*) as total FROM products p LEFT JOIN categories c ON p.category_id = c.id WHERE ${where}
    `, params);

    res.json({ products, total, page: parseInt(page), pages: Math.ceil(total / limit) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/products/:slug - single product with variants
router.get('/:slug', async (req, res) => {
  try {
    const [[product]] = await db.query(`
      SELECT p.*, c.name as category_name FROM products p
      LEFT JOIN categories c ON p.category_id = c.id
      WHERE p.slug = ? AND p.is_active = 1
    `, [req.params.slug]);
    if (!product) return res.status(404).json({ error: 'Product not found' });

    const [variants] = await db.query(
      'SELECT * FROM product_variants WHERE product_id = ? AND is_active = 1',
      [product.id]
    );
    product.variants = variants;
    product.images = typeof product.images === 'string' ? JSON.parse(product.images) : product.images;
    res.json(product);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---- ADMIN routes below (require auth) ----

// GET /api/products/admin/all
router.get('/admin/all', auth, async (req, res) => {
  try {
    const [products] = await db.query(`
      SELECT p.*, c.name as category_name,
        (SELECT SUM(stock_qty) FROM product_variants WHERE product_id = p.id) as total_stock
      FROM products p LEFT JOIN categories c ON p.category_id = c.id
      ORDER BY p.created_at DESC
    `);
    res.json(products);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/products - create product
router.post('/', auth, async (req, res) => {
  const { category_id, name, description, price, compare_price, cost_price, sku, images, variants } = req.body;
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-') + '-' + Date.now();
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const [result] = await conn.query(
      'INSERT INTO products (category_id, name, slug, description, price, compare_price, cost_price, sku, images) VALUES (?,?,?,?,?,?,?,?,?)',
      [category_id, name, slug, description, price, compare_price || null, cost_price || null, sku, JSON.stringify(images || [])]
    );
    const productId = result.insertId;
    if (variants && variants.length) {
      for (const v of variants) {
        await conn.query(
          'INSERT INTO product_variants (product_id, size, colour, colour_hex, stock_qty, extra_price) VALUES (?,?,?,?,?,?)',
          [productId, v.size || null, v.colour || null, v.colour_hex || null, v.stock_qty || 0, v.extra_price || 0]
        );
      }
    } else {
      await conn.query('INSERT INTO product_variants (product_id, stock_qty) VALUES (?,?)', [productId, 0]);
    }
    await conn.commit();
    res.status(201).json({ id: productId, message: 'Product created' });
  } catch (err) {
    await conn.rollback();
    res.status(500).json({ error: err.message });
  } finally { conn.release(); }
});

// PUT /api/products/:id - update product
router.put('/:id', auth, async (req, res) => {
  const { category_id, name, description, price, compare_price, cost_price, sku, images, is_active } = req.body;
  try {
    await db.query(
      'UPDATE products SET category_id=?, name=?, description=?, price=?, compare_price=?, cost_price=?, sku=?, images=?, is_active=? WHERE id=?',
      [category_id, name, description, price, compare_price || null, cost_price || null, sku, JSON.stringify(images || []), is_active ?? 1, req.params.id]
    );
    res.json({ message: 'Product updated' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /api/products/:id/variants - update variants
router.put('/:id/variants', auth, async (req, res) => {
  const { variants } = req.body;
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query('DELETE FROM product_variants WHERE product_id = ?', [req.params.id]);
    for (const v of variants) {
      await conn.query(
        'INSERT INTO product_variants (product_id, size, colour, colour_hex, stock_qty, extra_price) VALUES (?,?,?,?,?,?)',
        [req.params.id, v.size || null, v.colour || null, v.colour_hex || null, v.stock_qty || 0, v.extra_price || 0]
      );
    }
    await conn.commit();
    res.json({ message: 'Variants updated' });
  } catch (err) {
    await conn.rollback();
    res.status(500).json({ error: err.message });
  } finally { conn.release(); }
});

// DELETE /api/products/:id
router.delete('/:id', auth, async (req, res) => {
  try {
    await db.query('UPDATE products SET is_active = 0 WHERE id = ?', [req.params.id]);
    res.json({ message: 'Product deactivated' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
