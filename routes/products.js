const router = require('express').Router();
const db = require('../db');
const auth = require('../middleware/auth');

// ── Helper: sync product_categories and product_subcategories junction tables ──
async function syncCategoryLinks(conn, productId, primaryCategoryId, primarySubcategoryId, extraCategoryIds, extraSubcategoryIds) {
  await conn.query('DELETE FROM product_categories WHERE product_id = ?', [productId]);

  const allCatIds = [...new Set(
    [primaryCategoryId, ...(extraCategoryIds || [])]
    .filter(Boolean)
    .map(String)
  )];
  for (const catId of allCatIds) {
    await conn.query(
      'INSERT IGNORE INTO product_categories (product_id, category_id) VALUES (?,?)',
      [productId, catId]
    );
  }

  // Only sync subcategories if the table exists
  try {
    await conn.query('DELETE FROM product_subcategories WHERE product_id = ?', [productId]);
    const allSubIds = [...new Set(
      [primarySubcategoryId, ...(extraSubcategoryIds || [])]
      .filter(Boolean)
      .map(String)
    )];
    for (const subId of allSubIds) {
      await conn.query(
        'INSERT IGNORE INTO product_subcategories (product_id, subcategory_id) VALUES (?,?)',
        [productId, subId]
      );
    }
  } catch (e) {
    // product_subcategories table doesn't exist yet — skip silently
  }
}

// ── GET /api/products — public listing ──
router.get('/', async (req, res) => {
  try {
    const { category, subcategory, search, featured, page = 1, limit = 20 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    let where = 'p.is_active = 1';
    const params = [];

    let joins = `
      LEFT JOIN categories c ON p.category_id = c.id
      LEFT JOIN product_categories pc ON pc.product_id = p.id
      LEFT JOIN categories pcc ON pcc.id = pc.category_id
    `;

    if (category) {
      where += ' AND (c.slug = ? OR pcc.slug = ?)';
      params.push(category, category);
    }
    if (search) {
      where += ' AND (p.name LIKE ? OR p.description LIKE ?)';
      params.push(`%${search}%`, `%${search}%`);
    }
    if (featured === '1') {
      where += ' AND p.is_featured = 1';
    }

    const [products] = await db.query(`
      SELECT DISTINCT p.*,
        c.name as category_name, c.slug as category_slug
      FROM products p
      ${joins}
      WHERE ${where}
      ORDER BY p.sort_order ASC, p.created_at DESC
      LIMIT ? OFFSET ?
    `, [...params, parseInt(limit), parseInt(offset)]);

    const [[{ total }]] = await db.query(`
      SELECT COUNT(DISTINCT p.id) as total
      FROM products p ${joins}
      WHERE ${where}
    `, params);

    const parsed = await Promise.all(products.map(async p => {
      let catIds = [], subIds = [];
      try {
        const [cats] = await db.query('SELECT category_id FROM product_categories WHERE product_id=?', [p.id]);
        catIds = cats.map(c => c.category_id);
      } catch {}
      try {
        const [subs] = await db.query('SELECT subcategory_id FROM product_subcategories WHERE product_id=?', [p.id]);
        subIds = subs.map(s => s.subcategory_id);
      } catch {}
      return {
        ...p,
        images: typeof p.images === 'string' ? JSON.parse(p.images || '[]') : (p.images || []),
        category_ids: catIds,
        subcategory_ids: subIds,
      };
    }));

    res.json({ products: parsed, total, page: parseInt(page), pages: Math.ceil(total / limit) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── GET /api/products/featured-by-category ──
router.get('/featured-by-category', async (req, res) => {
  try {
    const [cats] = await db.query(
      'SELECT * FROM categories WHERE is_active = 1 ORDER BY id ASC'
    );
    const result = [];
    for (const cat of cats) {
      // is_featured column may not exist yet — fall back gracefully
      let products = [];
      try {
        [products] = await db.query(`
          SELECT DISTINCT p.*, c.name as category_name, c.slug as category_slug
          FROM products p
          LEFT JOIN categories c ON p.category_id = c.id
          LEFT JOIN product_categories pc ON pc.product_id = p.id
          WHERE (p.category_id = ? OR pc.category_id = ?)
            AND p.is_active = 1
            AND p.is_featured = 1
          ORDER BY p.sort_order ASC, p.created_at DESC
          LIMIT 8
        `, [cat.id, cat.id]);
      } catch {
        // is_featured doesn't exist yet — get all active products
        [products] = await db.query(`
          SELECT DISTINCT p.*, c.name as category_name, c.slug as category_slug
          FROM products p
          LEFT JOIN categories c ON p.category_id = c.id
          LEFT JOIN product_categories pc ON pc.product_id = p.id
          WHERE (p.category_id = ? OR pc.category_id = ?)
            AND p.is_active = 1
          ORDER BY p.created_at DESC
          LIMIT 8
        `, [cat.id, cat.id]);
      }
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
      SELECT p.*,
        c.name as category_name,
        (SELECT COALESCE(SUM(stock_qty),0) FROM product_variants WHERE product_id = p.id) as total_stock
      FROM products p
      LEFT JOIN categories c ON p.category_id = c.id
      ORDER BY p.created_at DESC
    `);
    const withCats = await Promise.all(products.map(async p => {
      let catIds = [], subIds = [];
      try { const [r] = await db.query('SELECT category_id FROM product_categories WHERE product_id=?',[p.id]); catIds=r.map(c=>c.category_id); } catch {}
      try { const [r] = await db.query('SELECT subcategory_id FROM product_subcategories WHERE product_id=?',[p.id]); subIds=r.map(s=>s.subcategory_id); } catch {}
      return {
        ...p,
        images: typeof p.images === 'string' ? JSON.parse(p.images || '[]') : (p.images || []),
        category_ids: catIds,
        subcategory_ids: subIds,
      };
    }));
    res.json(withCats);
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
    try { const [r] = await db.query('SELECT category_id FROM product_categories WHERE product_id=?',[product.id]); catIds=r.map(c=>c.category_id); } catch {}
    try { const [r] = await db.query('SELECT subcategory_id FROM product_subcategories WHERE product_id=?',[product.id]); subIds=r.map(s=>s.subcategory_id); } catch {}

    product.variants = variants;
    product.category_ids = catIds;
    product.subcategory_ids = subIds;
    product.images = typeof product.images === 'string'
      ? JSON.parse(product.images || '[]')
      : (product.images || []);

    res.json(product);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── POST /api/products — create ──
router.post('/', auth, async (req, res) => {
  const {
    category_id, subcategory_id, category_ids, subcategory_ids,
    name, description, price, compare_price, cost_price,
    sku, images, variants, is_featured, sort_order
  } = req.body;

  if (!name) return res.status(400).json({ error: 'Product name is required' });
  if (!price) return res.status(400).json({ error: 'Price is required' });

  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') + '-' + Date.now();
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    // Build INSERT dynamically based on which columns exist
    // Core columns always exist: category_id, name, slug, description, price, compare_price, sku, images, is_active
    // Optional columns (added by migration): subcategory_id, cost_price, is_featured, sort_order
    let cols = ['category_id','name','slug','description','price','compare_price','sku','images','is_active'];
    let vals = [category_id || null, name, slug, description || '', price, compare_price || null, sku || '', JSON.stringify(images || []), 1];
    let placeholders = cols.map(() => '?');

    // Try to add optional columns — they silently skip if missing
    const optionalCols = [
      { col: 'subcategory_id', val: subcategory_id || null },
      { col: 'cost_price',     val: cost_price || null },
      { col: 'is_featured',    val: is_featured ? 1 : 0 },
      { col: 'sort_order',     val: sort_order || 0 },
    ];

    // Check which optional columns exist
    const [colInfo] = await conn.query('DESCRIBE products');
    const existingCols = colInfo.map(c => c.Field);
    for (const opt of optionalCols) {
      if (existingCols.includes(opt.col)) {
        cols.push(opt.col);
        vals.push(opt.val);
        placeholders.push('?');
      }
    }

    const [result] = await conn.query(
      `INSERT INTO products (${cols.join(',')}) VALUES (${placeholders.join(',')})`,
      vals
    );
    const productId = result.insertId;

    // Sync category junction tables
    await syncCategoryLinks(conn, productId, category_id, subcategory_id, category_ids, subcategory_ids);

    // Insert variants
    if (variants && variants.length) {
      for (const v of variants) {
        // Check if image_url column exists on product_variants
        if (existingCols.includes('image_url') || true) {
          try {
            await conn.query(
              'INSERT INTO product_variants (product_id, size, colour, colour_hex, stock_qty, extra_price, image_url) VALUES (?,?,?,?,?,?,?)',
              [productId, v.size||null, v.colour||null, v.colour_hex||null, v.stock_qty||0, v.extra_price||0, v.image_url||null]
            );
          } catch {
            // image_url column doesn't exist yet — insert without it
            await conn.query(
              'INSERT INTO product_variants (product_id, size, colour, colour_hex, stock_qty, extra_price) VALUES (?,?,?,?,?,?)',
              [productId, v.size||null, v.colour||null, v.colour_hex||null, v.stock_qty||0, v.extra_price||0]
            );
          }
        }
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

// ── PUT /api/products/:id — update ──
router.put('/:id', auth, async (req, res) => {
  const {
    category_id, subcategory_id, category_ids, subcategory_ids,
    name, description, price, compare_price, cost_price,
    sku, images, is_active, is_featured, sort_order
  } = req.body;

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    // Dynamically build UPDATE based on existing columns
    const [colInfo] = await conn.query('DESCRIBE products');
    const existingCols = colInfo.map(c => c.Field);

    let sets = [
      'category_id = ?', 'name = ?', 'description = ?',
      'price = ?', 'compare_price = ?', 'sku = ?',
      'images = ?', 'is_active = ?'
    ];
    let vals = [
      category_id || null, name, description || '',
      price, compare_price || null, sku || '',
      JSON.stringify(images || []), is_active ?? 1
    ];

    const optionalUpdates = [
      { col: 'subcategory_id', val: subcategory_id || null },
      { col: 'cost_price',     val: cost_price || null },
      { col: 'is_featured',    val: is_featured ? 1 : 0 },
      { col: 'sort_order',     val: sort_order || 0 },
    ];

    for (const opt of optionalUpdates) {
      if (existingCols.includes(opt.col)) {
        sets.push(`${opt.col} = ?`);
        vals.push(opt.val);
      }
    }

    vals.push(req.params.id);
    await conn.query(`UPDATE products SET ${sets.join(', ')} WHERE id = ?`, vals);

    await syncCategoryLinks(conn, req.params.id, category_id, subcategory_id, category_ids, subcategory_ids);

    await conn.commit();
    res.json({ message: 'Product updated' });
  } catch (err) {
    await conn.rollback();
    res.status(500).json({ error: err.message });
  } finally { conn.release(); }
});

// ── PUT /api/products/:id/variants ──
router.put('/:id/variants', auth, async (req, res) => {
  const { variants } = req.body;
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query('DELETE FROM product_variants WHERE product_id = ?', [req.params.id]);
    for (const v of variants) {
      try {
        await conn.query(
          'INSERT INTO product_variants (product_id, size, colour, colour_hex, stock_qty, extra_price, image_url) VALUES (?,?,?,?,?,?,?)',
          [req.params.id, v.size||null, v.colour||null, v.colour_hex||null, v.stock_qty||0, v.extra_price||0, v.image_url||null]
        );
      } catch {
        await conn.query(
          'INSERT INTO product_variants (product_id, size, colour, colour_hex, stock_qty, extra_price) VALUES (?,?,?,?,?,?)',
          [req.params.id, v.size||null, v.colour||null, v.colour_hex||null, v.stock_qty||0, v.extra_price||0]
        );
      }
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

// ── DELETE /api/products/:id — permanent delete ──
router.delete('/:id', auth, async (req, res) => {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const [[billUsage]]  = await conn.query('SELECT COUNT(*) as cnt FROM bill_items WHERE product_id = ?', [req.params.id]).catch(()=>[[{cnt:0}]]);
    const [[orderUsage]] = await conn.query('SELECT COUNT(*) as cnt FROM order_items WHERE product_id = ?', [req.params.id]).catch(()=>[[{cnt:0}]]);

    await conn.query('DELETE FROM product_variants WHERE product_id = ?', [req.params.id]);
    await conn.query('DELETE FROM product_categories WHERE product_id = ?', [req.params.id]).catch(()=>{});
    await conn.query('DELETE FROM product_subcategories WHERE product_id = ?', [req.params.id]).catch(()=>{});
    await conn.query('UPDATE bill_items SET product_id = NULL WHERE product_id = ?', [req.params.id]).catch(()=>{});
    await conn.query('UPDATE order_items SET product_id = NULL WHERE product_id = ?', [req.params.id]).catch(()=>{});
    await conn.query('DELETE FROM products WHERE id = ?', [req.params.id]);

    await conn.commit();
    res.json({ message: 'Product permanently deleted', had_history: (billUsage.cnt > 0 || orderUsage.cnt > 0) });
  } catch (err) {
    await conn.rollback();
    res.status(500).json({ error: err.message });
  } finally { conn.release(); }
});

module.exports = router;
