const router = require('express').Router();
const db = require('../db');
const auth = require('../middleware/auth');

// GET /api/products — public listing with filters (supports multi-category via junction table)
router.get('/', async (req, res) => {
  try {
    const { category, subcategory, search, featured, page = 1, limit = 20 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    let where = 'p.is_active = 1';
    const params = [];
    let joinClause = '';

    if (category) {
      // Match products linked via junction table OR primary category
      joinClause = `LEFT JOIN product_categories pc ON pc.product_id = p.id
                    LEFT JOIN categories pcc ON pcc.id = pc.category_id`;
      where += ' AND (c.slug = ? OR pcc.slug = ?)';
      params.push(category, category);
    }
    if (subcategory) { where += ' AND s.slug = ?'; params.push(subcategory); }
    if (search) { where += ' AND (p.name LIKE ? OR p.description LIKE ?)'; params.push(`%${search}%`, `%${search}%`); }
    if (featured === '1') { where += ' AND p.is_featured = 1'; }

    const [products] = await db.query(`
      SELECT DISTINCT p.*, c.name as category_name, c.slug as category_slug,
             s.name as subcategory_name, s.slug as subcategory_slug
      FROM products p
      LEFT JOIN categories c ON p.category_id = c.id
      LEFT JOIN subcategories s ON p.subcategory_id = s.id
      ${joinClause}
      WHERE ${where}
      ORDER BY p.sort_order ASC, p.created_at DESC
      LIMIT ? OFFSET ?
    `, [...params, parseInt(limit), parseInt(offset)]);

    const parsed = await Promise.all(products.map(async p => {
      const [cats] = await db.query(
        'SELECT category_id FROM product_categories WHERE product_id = ?', [p.id]
      );
      return {
        ...p,
        images: typeof p.images === 'string' ? JSON.parse(p.images || '[]') : (p.images || []),
        category_ids: cats.map(c => c.category_id),
      };
    }));

    const [[{ total }]] = await db.query(`
      SELECT COUNT(DISTINCT p.id) as total FROM products p
      LEFT JOIN categories c ON p.category_id = c.id
      LEFT JOIN subcategories s ON p.subcategory_id = s.id
      ${joinClause}
      WHERE ${where}
    `, params);

    res.json({ products: parsed, total, page: parseInt(page), pages: Math.ceil(total / limit) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/products/featured-by-category
router.get('/featured-by-category', async (req, res) => {
  try {
    const [cats] = await db.query(
      'SELECT * FROM categories WHERE is_active = 1 ORDER BY sort_order ASC, name ASC'
    );
    const result = [];
    for (const cat of cats) {
      const [products] = await db.query(`
        SELECT DISTINCT p.*, c.name as category_name, c.slug as category_slug
        FROM products p
        LEFT JOIN categories c ON p.category_id = c.id
        LEFT JOIN product_categories pc ON pc.product_id = p.id
        WHERE (p.category_id = ? OR pc.category_id = ?) AND p.is_active = 1 AND p.is_featured = 1
        ORDER BY p.sort_order ASC, p.created_at DESC
        LIMIT 8
      `, [cat.id, cat.id]);
      if (products.length > 0) {
        result.push({
          category: cat,
          products: products.map(p => ({
            ...p,
            images: typeof p.images === 'string' ? JSON.parse(p.images || '[]') : (p.images || [])
          }))
        });
      }
    }
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/products/admin/all
router.get('/admin/all', auth, async (req, res) => {
  try {
    const [products] = await db.query(`
      SELECT p.*, c.name as category_name, s.name as subcategory_name,
        (SELECT COALESCE(SUM(stock_qty),0) FROM product_variants WHERE product_id = p.id) as total_stock
      FROM products p
      LEFT JOIN categories c ON p.category_id = c.id
      LEFT JOIN subcategories s ON p.subcategory_id = s.id
      ORDER BY p.created_at DESC
    `);
    const withCats = await Promise.all(products.map(async p => {
      const [cats] = await db.query('SELECT category_id FROM product_categories WHERE product_id=?', [p.id]);
      return {
        ...p,
        images: typeof p.images === 'string' ? JSON.parse(p.images || '[]') : (p.images || []),
        category_ids: cats.map(c => c.category_id),
      };
    }));
    res.json(withCats);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/products/:slug — single product (must stay after specific routes)
router.get('/:slug', async (req, res) => {
  try {
    const [[product]] = await db.query(`
      SELECT p.*, c.name as category_name, c.slug as category_slug,
             s.name as subcategory_name, s.slug as subcategory_slug
      FROM products p
      LEFT JOIN categories c ON p.category_id = c.id
      LEFT JOIN subcategories s ON p.subcategory_id = s.id
      WHERE p.slug = ? AND p.is_active = 1
    `, [req.params.slug]);

    if (!product) return res.status(404).json({ error: 'Product not found' });

    const [variants] = await db.query(
      'SELECT * FROM product_variants WHERE product_id = ? AND is_active = 1',
      [product.id]
    );
    const [cats] = await db.query('SELECT category_id FROM product_categories WHERE product_id = ?', [product.id]);

    product.variants = variants;
    product.category_ids = cats.map(c => c.category_id);
    product.images = typeof product.images === 'string'
      ? JSON.parse(product.images || '[]')
      : (product.images || []);

    res.json(product);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/products — create with multi-category support
router.post('/', auth, async (req, res) => {
  const { category_id, subcategory_id, category_ids, name, description, price, compare_price, cost_price, sku, images, variants, is_featured, sort_order } = req.body;
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') + '-' + Date.now();
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const [result] = await conn.query(
      'INSERT INTO products (category_id, subcategory_id, name, slug, description, price, compare_price, cost_price, sku, images, is_featured, sort_order) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
      [category_id, subcategory_id || null, name, slug, description, price, compare_price || null, cost_price || null, sku, JSON.stringify(images || []), is_featured ? 1 : 0, sort_order || 0]
    );
    const productId = result.insertId;

    // Insert into junction table — combine primary category_id with extra category_ids
    const allCategoryIds = new Set([category_id, ...(category_ids || [])].filter(Boolean).map(String));
    for (const catId of allCategoryIds) {
      await conn.query(
        'INSERT IGNORE INTO product_categories (product_id, category_id, subcategory_id) VALUES (?,?,?)',
        [productId, catId, String(catId) === String(category_id) ? (subcategory_id || null) : null]
      );
    }

    if (variants && variants.length) {
      for (const v of variants) {
        await conn.query(
          'INSERT INTO product_variants (product_id, size, colour, colour_hex, stock_qty, extra_price, image_url) VALUES (?,?,?,?,?,?,?)',
          [productId, v.size || null, v.colour || null, v.colour_hex || null, v.stock_qty || 0, v.extra_price || 0, v.image_url || null]
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

// PUT /api/products/:id — update with multi-category support
router.put('/:id', auth, async (req, res) => {
  const { category_id, subcategory_id, category_ids, name, description, price, compare_price, cost_price, sku, images, is_active, is_featured, sort_order } = req.body;
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query(
      'UPDATE products SET category_id=?, subcategory_id=?, name=?, description=?, price=?, compare_price=?, cost_price=?, sku=?, images=?, is_active=?, is_featured=?, sort_order=? WHERE id=?',
      [category_id, subcategory_id || null, name, description, price, compare_price || null, cost_price || null, sku, JSON.stringify(images || []), is_active ?? 1, is_featured ? 1 : 0, sort_order || 0, req.params.id]
    );

    // Refresh category junction links
    await conn.query('DELETE FROM product_categories WHERE product_id = ?', [req.params.id]);
    const allCategoryIds = new Set([category_id, ...(category_ids || [])].filter(Boolean).map(String));
    for (const catId of allCategoryIds) {
      await conn.query(
        'INSERT IGNORE INTO product_categories (product_id, category_id, subcategory_id) VALUES (?,?,?)',
        [req.params.id, catId, String(catId) === String(category_id) ? (subcategory_id || null) : null]
      );
    }

    await conn.commit();
    res.json({ message: 'Product updated' });
  } catch (err) {
    await conn.rollback();
    res.status(500).json({ error: err.message });
  } finally { conn.release(); }
});

// PUT /api/products/:id/variants
router.put('/:id/variants', auth, async (req, res) => {
  const { variants } = req.body;
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query('DELETE FROM product_variants WHERE product_id = ?', [req.params.id]);
    for (const v of variants) {
      await conn.query(
        'INSERT INTO product_variants (product_id, size, colour, colour_hex, stock_qty, extra_price, image_url) VALUES (?,?,?,?,?,?,?)',
        [req.params.id, v.size || null, v.colour || null, v.colour_hex || null, v.stock_qty || 0, v.extra_price || 0, v.image_url || null]
      );
    }
    await conn.commit();
    res.json({ message: 'Variants updated' });
  } catch (err) {
    await conn.rollback();
    res.status(500).json({ error: err.message });
  } finally { conn.release(); }
});

// PUT /api/products/:id/deactivate — soft deactivate (keeps history)
router.put('/:id/deactivate', auth, async (req, res) => {
  try {
    await db.query('UPDATE products SET is_active = 0 WHERE id = ?', [req.params.id]);
    res.json({ message: 'Product deactivated' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /api/products/:id — PERMANENT delete
router.delete('/:id', auth, async (req, res) => {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    // Check if product has been used in any bills or orders — warn but still allow delete
    const [[billUsage]] = await conn.query('SELECT COUNT(*) as cnt FROM bill_items WHERE product_id = ?', [req.params.id]);
    const [[orderUsage]] = await conn.query('SELECT COUNT(*) as cnt FROM order_items WHERE product_id = ?', [req.params.id]);

    // Delete variants, category links first (FK constraints)
    await conn.query('DELETE FROM product_variants WHERE product_id = ?', [req.params.id]);
    await conn.query('DELETE FROM product_categories WHERE product_id = ?', [req.params.id]);

    // Null out references in bill_items / order_items (preserve historical records)
    await conn.query('UPDATE bill_items SET product_id = NULL WHERE product_id = ?', [req.params.id]);
    await conn.query('UPDATE order_items SET product_id = NULL WHERE product_id = ?', [req.params.id]);

    await conn.query('DELETE FROM products WHERE id = ?', [req.params.id]);

    await conn.commit();
    res.json({
      message: 'Product permanently deleted',
      had_history: (billUsage.cnt > 0 || orderUsage.cnt > 0)
    });
  } catch (err) {
    await conn.rollback();
    res.status(500).json({ error: err.message });
  } finally { conn.release(); }
});

module.exports = router;
