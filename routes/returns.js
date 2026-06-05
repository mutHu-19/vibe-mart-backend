const router = require('express').Router();
const db = require('../db');
const auth = require('../middleware/auth');

function genReturnNo() {
  const d = new Date();
  return `RET-${d.getFullYear().toString().slice(-2)}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}-${Math.floor(1000+Math.random()*9000)}`;
}

// POST /api/returns
router.post('/', auth, async (req, res) => {
  const { bill_id, order_id, customer_name, reason, notes, items } = req.body;
  if (!items?.length) return res.status(400).json({ error: 'No items to return' });
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const invoice_no = genReturnNo();
    const [r] = await conn.query(
      'INSERT INTO returns (invoice_no, bill_id, order_id, customer_name, reason, notes, created_by) VALUES (?,?,?,?,?,?,?)',
      [invoice_no, bill_id||null, order_id||null, customer_name||'', reason||'', notes||'', req.admin?.id||null]
    );
    const returnId = r.insertId;
    for (const item of items) {
      await conn.query(
        'INSERT INTO return_items (return_id, product_id, product_name, variant_id, size, colour, quantity, unit_price) VALUES (?,?,?,?,?,?,?,?)',
        [returnId, item.product_id||null, item.product_name, item.variant_id||null, item.size||null, item.colour||null, item.quantity, item.unit_price||0]
      );
      // Restore stock
      if (item.variant_id) {
        await conn.query('UPDATE product_variants SET stock_qty = stock_qty + ? WHERE id = ?', [item.quantity, item.variant_id]);
      } else if (item.product_id) {
        await conn.query(
          'UPDATE product_variants SET stock_qty = stock_qty + ? WHERE product_id = ? ORDER BY id ASC LIMIT 1',
          [item.quantity, item.product_id]
        );
      }
    }
    await conn.commit();
    res.status(201).json({ invoice_no, return_id: returnId, message: 'Return processed, stock restored' });
  } catch (err) {
    await conn.rollback();
    res.status(500).json({ error: err.message });
  } finally { conn.release(); }
});

// GET /api/returns
router.get('/', auth, async (req, res) => {
  try {
    const { from, to } = req.query;
    let where = '1=1'; const params = [];
    if (from) { where += ' AND DATE(r.created_at) >= ?'; params.push(from); }
    if (to)   { where += ' AND DATE(r.created_at) <= ?'; params.push(to); }
    const [rows] = await db.query(
      `SELECT r.*, COUNT(ri.id) as item_count FROM returns r
       LEFT JOIN return_items ri ON r.id = ri.return_id
       WHERE ${where} GROUP BY r.id ORDER BY r.created_at DESC LIMIT 100`,
      params
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/returns/:id
router.get('/:id', auth, async (req, res) => {
  try {
    const [[ret]] = await db.query('SELECT * FROM returns WHERE id=?', [req.params.id]);
    if (!ret) return res.status(404).json({ error: 'Not found' });
    const [items] = await db.query('SELECT * FROM return_items WHERE return_id=?', [ret.id]);
    ret.items = items;
    res.json(ret);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
