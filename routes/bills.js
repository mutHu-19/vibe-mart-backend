const router = require('express').Router();
const db = require('../db');
const auth = require('../middleware/auth');

function genInvoice() {
  const d = new Date();
  const y = d.getFullYear().toString().slice(-2);
  const m = String(d.getMonth()+1).padStart(2,'0');
  const day = String(d.getDate()).padStart(2,'0');
  return `BILL-${y}${m}${day}-${Math.floor(1000+Math.random()*9000)}`;
}

// POST /api/bills — create POS bill
// Stock deducted immediately (no status flow needed for manual bills)
router.post('/', auth, async (req, res) => {
  const {
    customer_name, customer_phone, customer_phone2,
    customer_address, items, payment_method,
    delivery_charge, discount, discount_type, notes
  } = req.body;

  if (!customer_name?.trim()) return res.status(400).json({ error: 'Customer name is required' });
  if (!customer_phone?.trim()) return res.status(400).json({ error: 'Customer phone is required' });
  if (!items?.length) return res.status(400).json({ error: 'Add at least one item' });

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    // Upsert customer (store both phones)
    let customerId = null;
    const [ex] = await conn.query('SELECT id FROM customers WHERE phone = ?', [customer_phone.trim()]);
    if (ex.length) {
      customerId = ex[0].id;
      await conn.query(
        'UPDATE customers SET name=?, address=?, phone2=? WHERE id=?',
        [customer_name.trim(), customer_address||'', customer_phone2||null, customerId]
      );
    } else {
      const [cr] = await conn.query(
        'INSERT INTO customers (name, phone, phone2, address) VALUES (?,?,?,?)',
        [customer_name.trim(), customer_phone.trim(), customer_phone2||null, customer_address||'']
      );
      customerId = cr.insertId;
    }

    // Build items with cost prices
    let subtotal = 0;
    const enriched = [];
    for (const item of items) {
      const [[p]] = await conn.query('SELECT * FROM products WHERE id=?', [item.product_id]);
      if (!p) throw new Error(`Product not found: ${item.product_id}`);

      let unitPrice = parseFloat(p.price);
      let costPrice = parseFloat(p.cost_price || 0);
      let variantId = item.variant_id || null;

      if (variantId) {
        const [[v]] = await conn.query('SELECT * FROM product_variants WHERE id=?', [variantId]);
        if (v) unitPrice += parseFloat(v.extra_price || 0);
      }

      const lineTotal = unitPrice * item.quantity;
      subtotal += lineTotal;
      enriched.push({
        product_id: item.product_id,
        product_name: p.name,
        variant_id: variantId,
        size: item.size || null,
        colour: item.colour || null,
        quantity: item.quantity,
        unit_price: unitPrice,
        cost_price: costPrice,
        total_price: lineTotal,
      });
    }

    // Calculate discount
    const deliveryFee = parseFloat(delivery_charge || 0);
    let discountAmt = 0;
    if (discount && parseFloat(discount) > 0) {
      if (discount_type === 'percent') {
        discountAmt = (subtotal * parseFloat(discount)) / 100;
      } else {
        discountAmt = parseFloat(discount);
      }
    }
    const grandTotal = subtotal + deliveryFee - discountAmt;
    const invoice_no = genInvoice();

    // Save bill
    const [billResult] = await conn.query(
      `INSERT INTO bills
        (invoice_no, customer_id, customer_name, customer_phone, customer_phone2, customer_address,
         subtotal, delivery_charge, discount, discount_type, total, payment_method, notes, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [invoice_no, customerId, customer_name.trim(), customer_phone.trim(), customer_phone2||null,
       customer_address||'', subtotal, deliveryFee, discountAmt,
       discount_type||'fixed', grandTotal, payment_method, notes||null, req.admin?.id||null]
    );
    const billId = billResult.insertId;

    // Save items + deduct stock immediately
    for (const item of enriched) {
      await conn.query(
        `INSERT INTO bill_items
          (bill_id, product_id, product_name, variant_id, size, colour, quantity, unit_price, cost_price, total_price)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [billId, item.product_id, item.product_name, item.variant_id,
         item.size, item.colour, item.quantity, item.unit_price, item.cost_price, item.total_price]
      );

      // ── STOCK DEDUCTION ──
      if (item.variant_id) {
        // Has specific variant — deduct from variant
        await conn.query(
          'UPDATE product_variants SET stock_qty = GREATEST(0, stock_qty - ?) WHERE id = ?',
          [item.quantity, item.variant_id]
        );
      } else {
        // No variant — deduct from first available variant of this product
        await conn.query(
          `UPDATE product_variants
           SET stock_qty = GREATEST(0, stock_qty - ?)
           WHERE product_id = ?
           ORDER BY id ASC LIMIT 1`,
          [item.quantity, item.product_id]
        );
      }
    }

    await conn.commit();

    // Return full invoice for print
    res.status(201).json({
      invoice: {
        id: billId, invoice_no,
        customer_name: customer_name.trim(),
        customer_phone: customer_phone.trim(),
        customer_phone2: customer_phone2 || null,
        customer_address: customer_address || '',
        items: enriched, subtotal, delivery_charge: deliveryFee,
        discount: discountAmt, discount_type: discount_type||'fixed',
        discount_input: discount,
        total: grandTotal, payment_method,
        notes: notes||null,
        created_at: new Date().toISOString(),
      },
      message: 'Bill created',
    });
  } catch (err) {
    await conn.rollback();
    res.status(500).json({ error: err.message });
  } finally { conn.release(); }
});

// GET /api/bills — list with date filter
router.get('/', auth, async (req, res) => {
  try {
    const { from, to, page=1, limit=50 } = req.query;
    const offset = (page-1) * limit;
    let where = '1=1';
    const params = [];
    if (from) { where += ' AND DATE(b.created_at) >= ?'; params.push(from); }
    if (to)   { where += ' AND DATE(b.created_at) <= ?'; params.push(to); }
    const [bills] = await db.query(
      `SELECT b.*, COUNT(bi.id) as item_count
       FROM bills b LEFT JOIN bill_items bi ON b.id = bi.bill_id
       WHERE ${where} GROUP BY b.id ORDER BY b.created_at DESC LIMIT ? OFFSET ?`,
      [...params, parseInt(limit), parseInt(offset)]
    );
    const [[{total}]] = await db.query(`SELECT COUNT(*) as total FROM bills b WHERE ${where}`, params);
    res.json({ bills, total });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// GET /api/bills/stats/summary — P&L for period
router.get('/stats/summary', auth, async (req, res) => {
  try {
    const { from, to } = req.query;
    let where = '1=1';
    const params = [];
    if (from) { where += ' AND DATE(b.created_at) >= ?'; params.push(from); }
    if (to)   { where += ' AND DATE(b.created_at) <= ?'; params.push(to); }

    const [[rev]]   = await db.query(`SELECT COALESCE(SUM(b.total),0) as gross FROM bills b WHERE ${where}`, params);
    const [[costs]] = await db.query(
      `SELECT COALESCE(SUM(bi.cost_price * bi.quantity),0) as total_cost
       FROM bill_items bi JOIN bills b ON bi.bill_id=b.id WHERE ${where}`, params
    );
    const [[counts]] = await db.query(
      `SELECT COUNT(*) as bill_count,
              COALESCE(SUM(b.discount),0) as total_discount,
              COALESCE(SUM(b.delivery_charge),0) as total_delivery
       FROM bills b WHERE ${where}`, params
    );
    const [topProducts] = await db.query(
      `SELECT bi.product_name, SUM(bi.quantity) as units,
              SUM(bi.total_price) as revenue,
              SUM(bi.cost_price * bi.quantity) as cost
       FROM bill_items bi JOIN bills b ON bi.bill_id=b.id
       WHERE ${where} GROUP BY bi.product_name ORDER BY revenue DESC LIMIT 5`, params
    );

    const gross = parseFloat(rev.gross);
    const cogs  = parseFloat(costs.total_cost);
    res.json({
      gross_revenue: gross,
      cogs,
      gross_profit: gross - cogs,
      bill_count: counts.bill_count,
      total_discount: parseFloat(counts.total_discount),
      total_delivery: parseFloat(counts.total_delivery),
      top_products: topProducts,
    });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// GET /api/bills/:id
router.get('/:id', auth, async (req, res) => {
  try {
    const [[bill]] = await db.query('SELECT * FROM bills WHERE id=?', [req.params.id]);
    if (!bill) return res.status(404).json({ error: 'Not found' });
    const [items] = await db.query('SELECT * FROM bill_items WHERE bill_id=?', [bill.id]);
    bill.items = items;
    res.json(bill);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
