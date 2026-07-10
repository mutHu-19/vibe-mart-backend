const router = require('express').Router();
const db = require('../db');
const auth = require('../middleware/auth');

// Cache which optional columns exist so we only check DB schema once per server start
let _productCols = null;
let _variantCols = null;

async function getProductCols() {
  if (_productCols) return _productCols;
  const [rows] = await db.query('DESCRIBE products');
  _productCols = rows.map(r => r.Field);
  return _productCols;
}

async function getVariantCols() {
  if (_variantCols) return _variantCols;
  const [rows] = await db.query('DESCRIBE product_variants');
  _variantCols = rows.map(r => r.Field);
  return _variantCols;
}

// Safe junction table helpers — silently skip if tables don't exist
async function syncCategories(conn, productId, primaryCatId, extraCatIds) {
  try {
    await conn.query('DELETE FROM product_categories WHERE product_id = ?', [productId]);
    const ids = [...new Set([primaryCatId, ...(extraCatIds || [])].filter(Boolean).map(String))];
    for (const id of ids) {
      await conn.query('INSERT IGNORE INTO product_categories (product_id, category_id) VALUES (?,?)', [productId, id]);
    }
  } catch { /* product_categories table doesn't exist yet */ }
}

async function syncSubcategories(conn, productId, primarySubId, extraSubIds) {
  try {
    await conn.query('DELETE FROM product_subcategories WHERE product_id = ?', [productId]);
    const ids = [...new Set([primarySubId, ...(extraSubIds || [])].filter(Boolean).map(String))];
    for (const id of ids) {
      await conn.query('INSERT IGNORE INTO product_subcategories (product_id, subcategory_id) VALUES (?,?)', [productId, id]);
    }
  } catch { /* product_subcategories table doesn't exist yet */ }
}

// Build a safe INSERT for product_variants that only uses existing columns
async function insertVariant(conn, productId, v) {
  const cols = await getVariantCols();
  const fields = ['product_id', 'size', 'colour', 'colour_hex', 'stock_qty', 'extra_price'];
  const values = [productId, v.size || null, v.colour || null, v.colour_hex || null, v.stock_qty || 0, v.extra_price || 0];

  if (cols.includes('image_url')) {
    fields.push('image_url');
    values.push(v.image_url || null);
  }

  await conn.query(
    `INSERT INTO product_variants (${fields.join(',')}) VALUES (${fields.map(() => '?').join(',')})`,
    values
  );
}

// Build safe INSERT/UPDATE for products using only columns that exist
async function buildProductFields(body, isUpdate = false) {
  const cols = await getProductCols();
  const {
    category_id, subcategory_id, name, description,
    price, compare_price, cost_price, sku, images,
    is_active, is_featured, sort_order
  } = body;

  // Always-present columns
  const fields = [];
  const values = [];

  if (!isUpdate || name !== undefined) { fields.push('name'); values.push(name || ''); }
  if (!isUpdate || description !== undefined) { fields.push('description'); values.push(description || ''); }
  { fields.push('price'); values.push(price); }
  { fields.push('compare_price'); values.push(compare_price || null); }
  { fields.push('sku'); values.push(sku || ''); }
  { fields.push('images'); values.push(JSON.stringify(images || [])); }
  { fields.push('category_id'); values.push(category_id || null); }
  { fields.push('is_active'); values.push(is_active ?? 1); }

  // Optional columns — only add if they exist in DB
  if (cols.includes('subcategory_id')) {
    fields.push('subcategory_id');
    values.push(subcategory_id || null);
  }
  if (cols.includes('cost_price')) {
    fields.push('cost_price');
    values.push(cost_price || null);
  }
  if (cols.includes('is_featured')) {
    fields.push('is_featured');
    values.push(is_featured ? 1 : 0);
  }
  if (cols.includes('sort_order')) {
    fields.push('sort_order');
    values.push(sort_order || 0);
  }

  return { fields, values };
}

// ── GET /api/products — public listing ──
router.get('/', async (req, res) => {
  try {
    const { category, subcategory, search, featured, page = 1, limit = 20 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    const cols = await getProductCols();

    let where = 'p.is_active = 1';
    const params = [];

    // Join product_categories if table exists
    let catJoin = '';
    try {
      await db.query('SELECT 1 FROM product_categories LIMIT 1');
      catJoin = 'LEFT JOIN product_categories pc ON pc.product_id = p.id LEFT JOIN categories pcc ON pcc.id = pc.category_id';
    } catch {}

    const joins = `LEFT JOIN categories c ON p.category_id = c.id ${catJoin}`;

    if (category) {
      if (catJoin) {
        where += ' AND (c.slug = ? OR pcc.slug = ?)';
        params.push(category, category);
      } else {
        where += ' AND c.slug = ?';
        params.push(category);
      }
    }
    if (search) {
      where += ' AND (p.name LIKE ? OR p.description LIKE ?)';
      params.push(`%${search}%`, `%${search}%`);
    }
    if (featured === '1' && cols.includes('is_featured')) {
      where += ' AND p.is_featured = 1';
    }

    const orderBy = cols.includes('sort_order')
      ? 'p.sort_order ASC, p.created_at DESC'
      : 'p.created_at DESC';

    const [products] = await db.query(`
      SELECT DISTINCT p.*, c.name as category_name, c.slug as category_slug
      FROM products p ${joins}
      WHERE ${where}
      ORDER BY ${orderBy}
      LIMIT ? OFFSET ?
    `, [...params, parseInt(limit), parseInt(offset)]);

    const [[{ total }]] = await db.query(
      `SELECT COUNT(DISTINCT p.id) as total FROM products p ${joins} WHERE ${where}`,
      params
    );

    const parsed = products.map(p => ({
      ...p,
      images: typeof p.images === 'string' ? JSON.parse(p.images || '[]') : (p.images || []),
    }));

    res.json({ products: parsed, total, page: parseInt(page), pages: Math.ceil(total / limit) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── GET /api/products/featured-by-category ──
router.get('/featured-by-category', async (req, res) => {
  try {
    const cols = await getProductCols();
    const hasFeatured = cols.includes('is_featured');
    const hasSortOrder = cols.includes('sort_order');
    const orderBy = hasSortOrder ? 'p.sort_order ASC, p.created_at DESC' : 'p.created_at DESC';

    let catJoin = '';
    try { await db.query('SELECT 1 FROM product_categories LIMIT 1'); catJoin = 'LEFT JOIN product_categories pc ON pc.product_id = p.id'; } catch {}

    const [cats] = await db.query('SELECT * FROM categories WHERE is_active = 1 ORDER BY id ASC');
    const result = [];

    for (const cat of cats) {
      const featuredWhere = hasFeatured ? 'AND p.is_featured = 1' : '';
      const [products] = await db.query(`
        SELECT DISTINCT p.*, c.name as category_name, c.slug as category_slug
        FROM products p
        LEFT JOIN categories c ON p.category_id = c.id
        ${catJoin}
        WHERE (p.category_id = ? ${catJoin ? 'OR pc.category_id = ?' : ''})
          AND p.is_active = 1
          ${featuredWhere}
        ORDER BY ${orderBy}
        LIMIT 8
      `, catJoin ? [cat.id, cat.id] : [cat.id]);

      if (products.length > 0) {
        result.push({
          category: cat,
          products: products.map(p => ({
            ...p,
            images: typeof p.images === 'string' ? JSON.parse(p.images || '[]') : (p.images || []),
          }))
        });
      }
    }
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── GET /api/products/admin/all ──
router.get('/admin/all', auth, async (req, res) => {
  try {
    const [products] = await db.query(`
      SELECT p.*, c.name as category_name,
        (SELECT COALESCE(SUM(stock_qty),0) FROM product_variants WHERE product_id = p.id) as total_stock
      FROM products p
      LEFT JOIN categories c ON p.category_id = c.id
      ORDER BY p.created_at DESC
    `);

    const parsed = await Promise.all(products.map(async p => {
      let catIds = [], subIds = [];
      try { const [r] = await db.query('SELECT category_id FROM product_categories WHERE product_id=?', [p.id]); catIds = r.map(c => c.category_id); } catch {}
      try { const [r] = await db.query('SELECT subcategory_id FROM product_subcategories WHERE product_id=?', [p.id]); subIds = r.map(s => s.subcategory_id); } catch {}
      return {
        ...p,
        images: typeof p.images === 'string' ? JSON.parse(p.images || '[]') : (p.images || []),
        category_ids: catIds,
        subcategory_ids: subIds,
      };
    }));
    res.json(parsed);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── GET /api/products/:slug ──
router.get('/:slug', async (req, res) => {
  try {
    const [[product]] = await db.query(`
      SELECT p.*, c.name as category_name, c.slug as category_slug
      FROM products p
      LEFT JOIN categories c ON p.category_id = c.id
      WHERE p.slug = ? AND p.is_active = 1
    `, [req.params.slug]);

    if (!product) return res.status(404).json({ error: 'Product not found' });

    const [variants] = await db.query(
      'SELECT * FROM product_variants WHERE product_id = ? AND is_active = 1',
      [product.id]
    );

    let catIds = [], subIds = [];
    try { const [r] = await db.query('SELECT category_id FROM product_categories WHERE product_id=?', [product.id]); catIds = r.map(c => c.category_id); } catch {}
    try { const [r] = await db.query('SELECT subcategory_id FROM product_subcategories WHERE product_id=?', [product.id]); subIds = r.map(s => s.subcategory_id); } catch {}

    product.variants = variants;
    product.category_ids = catIds;
    product.subcategory_ids = subIds;
    product.images = typeof product.images === 'string'
      ? JSON.parse(product.images || '[]')
      : (product.images || []);

    res.json(product);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── POST /api/products ──
router.post('/', auth, async (req, res) => {
  if (!req.body.name)  return res.status(400).json({ error: 'Product name is required' });
  if (!req.body.price) return res.status(400).json({ error: 'Price is required' });

  const slug = req.body.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') + '-' + Date.now();
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    _productCols = null; // reset cache so fresh DESCRIBE runs inside transaction

    const { fields, values } = await buildProductFields(req.body);
    fields.push('slug');
    values.push(slug);

    const [result] = await conn.query(
      `INSERT INTO products (${fields.join(',')}) VALUES (${fields.map(() => '?').join(',')})`,
      values
    );
    const productId = result.insertId;

    await syncCategories(conn, productId, req.body.category_id, req.body.category_ids);
    await syncSubcategories(conn, productId, req.body.subcategory_id, req.body.subcategory_ids);

    const variants = req.body.variants;
    if (variants && variants.length) {
      for (const v of variants) await insertVariant(conn, productId, v);
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

// ── PUT /api/products/:id ──
router.put('/:id', auth, async (req, res) => {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    _productCols = null; // reset cache

    const { fields, values } = await buildProductFields(req.body, true);
    values.push(req.params.id);

    await conn.query(
      `UPDATE products SET ${fields.map(f => `${f} = ?`).join(', ')} WHERE id = ?`,
      values
    );

    await syncCategories(conn, req.params.id, req.body.category_id, req.body.category_ids);
    await syncSubcategories(conn, req.params.id, req.body.subcategory_id, req.body.subcategory_ids);

    await conn.commit();
    res.json({ message: 'Product updated' });
  } catch (err) {
    await conn.rollback();
    res.status(500).json({ error: err.message });
  } finally { conn.release(); }
});

// ── PUT /api/products/:id/variants ──
router.put('/:id/variants', auth, async (req, res) => {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query('DELETE FROM product_variants WHERE product_id = ?', [req.params.id]);
    _variantCols = null; // reset cache
    for (const v of req.body.variants || []) {
      await insertVariant(conn, req.params.id, v);
    }
    await conn.commit();
    res.json({ message: 'Variants updated' });
  } catch (err) {
    await conn.rollback();
    res.status(500).json({ error: err.message });
  } finally { conn.release(); }
});

// ── PUT /api/products/:id/deactivate ──
router.put('/:id/deactivate', auth, async (req, res) => {
  try {
    await db.query('UPDATE products SET is_active = 0 WHERE id = ?', [req.params.id]);
    res.json({ message: 'Product deactivated' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── DELETE /api/products/:id ──
router.delete('/:id', auth, async (req, res) => {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query('DELETE FROM product_variants WHERE product_id = ?', [req.params.id]);
    await conn.query('DELETE FROM product_categories WHERE product_id = ?', [req.params.id]).catch(() => {});
    await conn.query('DELETE FROM product_subcategories WHERE product_id = ?', [req.params.id]).catch(() => {});
    await conn.query('UPDATE bill_items SET product_id = NULL WHERE product_id = ?', [req.params.id]).catch(() => {});
    await conn.query('UPDATE order_items SET product_id = NULL WHERE product_id = ?', [req.params.id]).catch(() => {});
    await conn.query('DELETE FROM products WHERE id = ?', [req.params.id]);
    await conn.commit();
    res.json({ message: 'Product permanently deleted' });
  } catch (err) {
    await conn.rollback();
    res.status(500).json({ error: err.message });
  } finally { conn.release(); }
});

module.exports = router;
