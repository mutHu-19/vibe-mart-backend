const router = require('express').Router();
const db = require('../db');
const auth = require('../middleware/auth');

// GET /api/admin/dashboard
router.get('/dashboard', auth, async (req, res) => {
  try {
    // Revenue from non-cancelled orders
    const [[{ revenue }]] = await db.query("SELECT COALESCE(SUM(total),0) as revenue FROM orders WHERE status != 'cancelled'");
    const [[{ orders }]] = await db.query('SELECT COUNT(*) as orders FROM orders');
    const [[{ pending }]] = await db.query("SELECT COUNT(*) as pending FROM orders WHERE status = 'pending'");
    const [[{ customers }]] = await db.query('SELECT COUNT(*) as customers FROM customers');
    const [[{ products }]] = await db.query('SELECT COUNT(*) as products FROM products WHERE is_active = 1');

    // Revenue by status breakdown
    const [statusBreakdown] = await db.query(`
      SELECT status, COUNT(*) as count, COALESCE(SUM(total), 0) as revenue
      FROM orders GROUP BY status ORDER BY FIELD(status, 'delivered', 'shipped', 'processing', 'confirmed', 'pending', 'cancelled')
    `);

    // Top products with cost for profit calculation
    const [topProducts] = await db.query(`
      SELECT p.name, p.cost_price, SUM(oi.quantity) as units_sold, SUM(oi.total_price) as revenue,
             COALESCE(SUM(oi.quantity * p.cost_price), 0) as total_cost
      FROM order_items oi
      JOIN products p ON oi.product_id = p.id
      JOIN orders o ON oi.order_id = o.id
      WHERE o.status != 'cancelled'
      GROUP BY p.id ORDER BY units_sold DESC LIMIT 5
    `);

    // Recent orders
    const [recentOrders] = await db.query('SELECT * FROM orders ORDER BY created_at DESC LIMIT 8');

    // Today's sales
    const [[todaySales]] = await db.query(`
      SELECT COALESCE(SUM(total),0) as revenue, COUNT(*) as count
      FROM orders WHERE DATE(created_at) = CURDATE() AND status != 'cancelled'
    `);

    // This month's sales
    const [[monthSales]] = await db.query(`
      SELECT COALESCE(SUM(total),0) as revenue, COUNT(*) as count
      FROM orders WHERE MONTH(created_at) = MONTH(NOW()) AND YEAR(created_at) = YEAR(NOW()) AND status != 'cancelled'
    `);

    // Low stock alert
    const [lowStock] = await db.query(`
      SELECT p.name, pv.colour, pv.size, pv.stock_qty
      FROM product_variants pv
      JOIN products p ON pv.product_id = p.id
      WHERE pv.stock_qty <= 5 AND p.is_active = 1
      ORDER BY pv.stock_qty ASC LIMIT 10
    `);

    res.json({
      revenue,
      orders,
      pending,
      customers,
      products,
      statusBreakdown,
      topProducts,
      recentOrders,
      todaySales,
      monthSales,
      lowStock
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
