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

// POST /api/bills — create a POS bill (manual billing, this is the source of truth for P&L)
router.post('/', auth, async (req, res) => {
  const { customer_name, customer_phone, customer_address, items, payment_method, delivery_charge, discount, notes } = req.body;
  if (!items?.length) return res.status(400).json({ error: 'No items' });

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    // Upsert customer
    let customerId = null;
    if (customer_phone) {
      const [ex] = await conn.query('SELECT id FROM customers WHERE phone = ?', [customer_phone]);
      if (ex.length) {
        customerId = ex[0].id;
        await conn.query('UPDATE customers SET name=?, address=? WHERE id=?', [customer_name||'Walk-in', customer_address||'', customerId]);
      } else {
        const [cr] = await conn.query('INSERT INTO customers (name,phone,address) VALUES (?,?,?)', [customer_name||'Walk-in', customer_phone, customer_address||'']);
        customerId = cr.insertId;
      }
    }

    // Calculate totals
    let subtotal = 0;
    const enriched = [];
    for (const item of items) {
      const [[p]] = await conn.query('SELECT * FROM products WHERE id=?', [item.product_id]);
      if (!p) throw new Error(`Product ${item.product_id} not found`);
      let unitPrice = parseFloat(p.price);
      let costPrice = parseFloat(p.cost_price || 0);
      let variantInfo = { size: item.size||null, colour: item.colour||null };
      if (item.variant_id) {
        const [[v]] = await conn.query('SELECT * FROM product_variants WHERE id=?', [item.variant_id]);
        if (v) { unitPrice += parseFloat(v.extra_price||0); variantInfo = { size:v.size, colour:v.colour }; }
      }
      const lineTotal = unitPrice * item.quantity;
      subtotal += lineTotal;
      enriched.push({ ...item, product_name: p.name, unit_price: unitPrice, cost_price: costPrice, total_price: lineTotal, ...variantInfo });
    }

    const deliveryFee = parseFloat(delivery_charge||0);
    const discountAmt = parseFloat(discount||0);
    const grandTotal = subtotal + deliveryFee - discountAmt;
    const invoice_no = genInvoice();

    const [billResult] = await conn.query(
      `INSERT INTO bills (invoice_no, customer_id, customer_name, customer_phone, customer_address,
        subtotal, delivery_charge, discount, total, payment_method, notes, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [invoice_no, customerId, customer_name||'Walk-in', customer_phone||'', customer_address||'',
       subtotal, deliveryFee, discountAmt, grandTotal, payment_method, notes||null, req.admin?.id||null]
    );
    const billId = billResult.insertId;

    for (const item of enriched) {
      await conn.query(
        `INSERT INTO bill_items (bill_id, product_id, product_name, variant_id, size, colour, quantity, unit_price, cost_price, total_price)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [billId, item.product_id, item.product_name, item.variant_id||null, item.size||null,
         item.colour||null, item.quantity, item.unit_price, item.cost_price||0, item.total_price]
      );
      // Deduct stock
      if (item.variant_id) {
        await conn.query('UPDATE product_variants SET stock_qty = GREATEST(0, stock_qty - ?) WHERE id=?', [item.quantity, item.variant_id]);
      }
    }

    await conn.commit();

    // Build invoice data for print
    const invoice = {
      id: billId, invoice_no, customer_name: customer_name||'Walk-in',
      customer_phone: customer_phone||'', customer_address: customer_address||'',
      items: enriched, subtotal, delivery_charge: deliveryFee,
      discount: discountAmt, total: grandTotal, payment_method,
      notes, created_at: new Date().toISOString()
    };

    res.status(201).json({ invoice, message: 'Bill created' });
  } catch (err) {
    await conn.rollback();
    res.status(500).json({ error: err.message });
  } finally { conn.release(); }
});

// GET /api/bills — list bills with date filter
router.get('/', auth, async (req, res) => {
  try {
    const { from, to, page=1, limit=50 } = req.query;
    const offset = (page-1)*limit;
    let where = '1=1';
    const params = [];
    if (from) { where += ' AND DATE(b.created_at) >= ?'; params.push(from); }
    if (to) { where += ' AND DATE(b.created_at) <= ?'; params.push(to); }
    const [bills] = await db.query(
      `SELECT b.*, COUNT(bi.id) as item_count FROM bills b
       LEFT JOIN bill_items bi ON b.id = bi.bill_id
       WHERE ${where} GROUP BY b.id ORDER BY b.created_at DESC LIMIT ? OFFSET ?`,
      [...params, parseInt(limit), parseInt(offset)]
    );
    const [[{total}]] = await db.query(`SELECT COUNT(*) as total FROM bills b WHERE ${where}`, params);
    res.json({ bills, total });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// GET /api/bills/:id — single bill with items
router.get('/:id', auth, async (req, res) => {
  try {
    const [[bill]] = await db.query('SELECT * FROM bills WHERE id=?', [req.params.id]);
    if (!bill) return res.status(404).json({ error: 'Bill not found' });
    const [items] = await db.query('SELECT * FROM bill_items WHERE bill_id=?', [bill.id]);
    bill.items = items;
    res.json(bill);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// GET /api/bills/stats/summary — P&L summary for a period
router.get('/stats/summary', auth, async (req, res) => {
  try {
    const { from, to } = req.query;
    let where = '1=1';
    const params = [];
    if (from) { where += ' AND DATE(b.created_at) >= ?'; params.push(from); }
    if (to) { where += ' AND DATE(b.created_at) <= ?'; params.push(to); }

    const [[revenue]] = await db.query(
      `SELECT COALESCE(SUM(b.total),0) as gross FROM bills b WHERE ${where}`, params
    );
    const [[costs]] = await db.query(
      `SELECT COALESCE(SUM(bi.cost_price * bi.quantity),0) as total_cost
       FROM bill_items bi JOIN bills b ON bi.bill_id = b.id WHERE ${where}`, params
    );
    const [[counts]] = await db.query(
      `SELECT COUNT(*) as bill_count, COALESCE(SUM(b.discount),0) as total_discount,
              COALESCE(SUM(b.delivery_charge),0) as total_delivery
       FROM bills b WHERE ${where}`, params
    );
    const [topProducts] = await db.query(
      `SELECT bi.product_name, SUM(bi.quantity) as units,
              SUM(bi.total_price) as revenue,
              SUM(bi.cost_price * bi.quantity) as cost
       FROM bill_items bi JOIN bills b ON bi.bill_id = b.id
       WHERE ${where} GROUP BY bi.product_name ORDER BY revenue DESC LIMIT 5`, params
    );

    const gross = parseFloat(revenue.gross);
    const cogs = parseFloat(costs.total_cost);
    const grossProfit = gross - cogs;

    res.json({
      gross_revenue: gross,
      cogs,
      gross_profit: grossProfit,
      bill_count: counts.bill_count,
      total_discount: parseFloat(counts.total_discount),
      total_delivery: parseFloat(counts.total_delivery),
      top_products: topProducts,
    });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
