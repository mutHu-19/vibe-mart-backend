const router = require('express').Router();
const db = require('../db');
const auth = require('../middleware/auth');

function generateInvoiceNo() {
  const date = new Date();
  const y = date.getFullYear().toString().slice(-2);
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const rand = Math.floor(1000 + Math.random() * 9000);
  return `INV-${y}${m}${d}-${rand}`;
}

// POST /api/orders — customer places order (stock NOT deducted yet, only on confirm)
router.post('/', async (req, res) => {
  const { customer_name, customer_phone, customer_address, items, payment_method, delivery_charge } = req.body;
  const deliveryFee = parseFloat(delivery_charge) || 0;

  if (!customer_name || !customer_phone || !customer_address || !items?.length || !payment_method) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    // Find or create customer
    let customerId = null;
    const [existing] = await conn.query('SELECT id FROM customers WHERE phone = ?', [customer_phone]);
    if (existing.length) {
      customerId = existing[0].id;
      await conn.query('UPDATE customers SET name=?, address=? WHERE id=?', [customer_name, customer_address, customerId]);
    } else {
      const [cResult] = await conn.query(
        'INSERT INTO customers (name, phone, address) VALUES (?,?,?)',
        [customer_name, customer_phone, customer_address]
      );
      customerId = cResult.insertId;
    }

    // Calculate totals (do NOT deduct stock on order placement — only on confirm)
    let subtotal = 0;
    const enrichedItems = [];
    for (const item of items) {
      const [[product]] = await conn.query('SELECT * FROM products WHERE id = ?', [item.product_id]);
      if (!product) throw new Error(`Product ${item.product_id} not found`);

      let variantInfo = { size: item.size || null, colour: item.colour || null };
      let unitPrice = parseFloat(product.price);

      if (item.variant_id) {
        const [[variant]] = await conn.query('SELECT * FROM product_variants WHERE id = ?', [item.variant_id]);
        if (variant) {
          unitPrice += parseFloat(variant.extra_price || 0);
          variantInfo = { size: variant.size, colour: variant.colour };
          // NOTE: Stock is NOT deducted here — deducted when status → confirmed
        }
      }

      const lineTotal = unitPrice * item.quantity;
      subtotal += lineTotal;
      enrichedItems.push({ ...item, product_name: product.name, unit_price: unitPrice, total_price: lineTotal, ...variantInfo });
    }

    const invoice_no = generateInvoiceNo();
    const grandTotal = subtotal + deliveryFee;
    const [orderResult] = await conn.query(
      'INSERT INTO orders (invoice_no, customer_id, customer_name, customer_phone, customer_address, subtotal, total, payment_method) VALUES (?,?,?,?,?,?,?,?)',
      [invoice_no, customerId, customer_name, customer_phone, customer_address, subtotal, grandTotal, payment_method]
    );
    const orderId = orderResult.insertId;

    for (const item of enrichedItems) {
      await conn.query(
        'INSERT INTO order_items (order_id, product_id, product_name, variant_id, size, colour, quantity, unit_price, total_price) VALUES (?,?,?,?,?,?,?,?,?)',
        [orderId, item.product_id, item.product_name, item.variant_id || null, item.size || null, item.colour || null, item.quantity, item.unit_price, item.total_price]
      );
    }

    await conn.commit();

    // Build WhatsApp message
    const whatsappNumber = process.env.WHATSAPP_NUMBER || '94771234567';
    const payLabel = payment_method === 'bank_deposit' ? 'Bank Deposit' : 'Cash on Delivery';
    let msg = `━━━━━━━━━━━━━━━━━━━━\n🧾 *NEW ORDER — ${invoice_no}*\n━━━━━━━━━━━━━━━━━━━━\n\n`;
    msg += `👤 *Customer Details*\n`;
    msg += `Name: ${customer_name}\n`;
    msg += `Phone: ${customer_phone}\n`;
    msg += `Address: ${customer_address}\n\n`;
    msg += `📦 *Order Items*\n`;
    for (const item of enrichedItems) {
      msg += `• ${item.product_name}`;
      if (item.colour) msg += ` | ${item.colour}`;
      if (item.size) msg += ` | ${item.size}`;
      msg += ` × ${item.quantity} = Rs. ${item.total_price.toFixed(2)}\n`;
    }
    msg += `\n🚚 Delivery: Rs. ${deliveryFee.toFixed(2)}\n`;
    msg += `💰 *TOTAL: Rs. ${grandTotal.toFixed(2)}*\n`;
    msg += `💳 Payment: ${payLabel}\n\n`;
    msg += `✅ Thank you for your order!`;

    const whatsappUrl = `https://wa.me/${whatsappNumber}?text=${encodeURIComponent(msg)}`;

    res.status(201).json({
      order_id: orderId,
      invoice_no,
      total: grandTotal,
      whatsapp_url: whatsappUrl,
      message: 'Order placed successfully'
    });
  } catch (err) {
    await conn.rollback();
    res.status(500).json({ error: err.message });
  } finally { conn.release(); }
});

// GET /api/orders — admin: list all orders
router.get('/', auth, async (req, res) => {
  try {
    const { status, page = 1, limit = 50 } = req.query;
    const offset = (page - 1) * limit;
    let where = '1=1';
    const params = [];
    if (status) { where += ' AND o.status = ?'; params.push(status); }

    const [orders] = await db.query(`
      SELECT o.*, COUNT(oi.id) as item_count
      FROM orders o LEFT JOIN order_items oi ON o.id = oi.order_id
      WHERE ${where} GROUP BY o.id ORDER BY o.created_at DESC LIMIT ? OFFSET ?
    `, [...params, parseInt(limit), parseInt(offset)]);

    const [[{ total }]] = await db.query(`SELECT COUNT(*) as total FROM orders o WHERE ${where}`, params);
    res.json({ orders, total, page: parseInt(page) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/orders/:id — admin: single order with items
router.get('/:id', auth, async (req, res) => {
  try {
    const [[order]] = await db.query('SELECT * FROM orders WHERE id = ?', [req.params.id]);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    const [items] = await db.query('SELECT * FROM order_items WHERE order_id = ?', [order.id]);
    order.items = items;
    res.json(order);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /api/orders/:id/status — admin: update order status
// KEY FEATURE: Deduct stock when status moves to 'confirmed'
router.put('/:id/status', auth, async (req, res) => {
  const { status } = req.body;
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    // Get current order status before update
    const [[currentOrder]] = await conn.query('SELECT status FROM orders WHERE id = ?', [req.params.id]);
    if (!currentOrder) {
      await conn.rollback();
      return res.status(404).json({ error: 'Order not found' });
    }

    const wasConfirmed = currentOrder.status === 'confirmed' || currentOrder.status === 'processing' ||
                         currentOrder.status === 'shipped' || currentOrder.status === 'delivered';

    // Update status
    await conn.query('UPDATE orders SET status = ? WHERE id = ?', [status, req.params.id]);

    // ============================================================
    // STOCK DEDUCTION LOGIC
    // Deduct stock when:  pending/any → confirmed (first confirmation)
    // Restore stock when: confirmed/processing/shipped → cancelled
    // ============================================================

    if (status === 'confirmed' && !wasConfirmed) {
      // Deduct stock for all items
      const [items] = await conn.query('SELECT * FROM order_items WHERE order_id = ?', [req.params.id]);
      for (const item of items) {
        if (item.variant_id) {
          // Deduct from variant stock
          await conn.query(
            'UPDATE product_variants SET stock_qty = GREATEST(0, stock_qty - ?) WHERE id = ?',
            [item.quantity, item.variant_id]
          );
        }
      }
    }

    if (status === 'cancelled' && wasConfirmed) {
      // Restore stock (order was previously confirmed/processing/shipped)
      const [items] = await conn.query('SELECT * FROM order_items WHERE order_id = ?', [req.params.id]);
      for (const item of items) {
        if (item.variant_id) {
          await conn.query(
            'UPDATE product_variants SET stock_qty = stock_qty + ? WHERE id = ?',
            [item.quantity, item.variant_id]
          );
        }
      }
    }

    await conn.commit();
    res.json({ message: 'Status updated', stock_adjusted: status === 'confirmed' && !wasConfirmed });
  } catch (err) {
    await conn.rollback();
    res.status(500).json({ error: err.message });
  } finally { conn.release(); }
});

// GET /api/orders/admin/stats — dashboard stats
router.get('/admin/stats', auth, async (req, res) => {
  try {
    const [[revenue]] = await db.query("SELECT COALESCE(SUM(total),0) as total FROM orders WHERE status != 'cancelled'");
    const [[orderCount]] = await db.query('SELECT COUNT(*) as count FROM orders');
    const [[pending]] = await db.query("SELECT COUNT(*) as count FROM orders WHERE status = 'pending'");
    const [[customers]] = await db.query('SELECT COUNT(*) as count FROM customers');
    const [recentOrders] = await db.query('SELECT * FROM orders ORDER BY created_at DESC LIMIT 5');
    res.json({ revenue: revenue.total, orders: orderCount.count, pending: pending.count, customers: customers.count, recentOrders });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
