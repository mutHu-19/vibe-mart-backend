const router = require('express').Router();
const db = require('../db');
const auth = require('../middleware/auth');

// GET /api/admin/dashboard
router.get('/dashboard', auth, async (req, res) => {
  const isSuperAdmin = req.admin.role === 'super_admin';
  try {
    const [[{ revenue }]] = await db.query(
      "SELECT COALESCE(SUM(total),0) as revenue FROM bills WHERE MONTH(created_at)=MONTH(NOW()) AND YEAR(created_at)=YEAR(NOW())"
    );
    const [[{ orders }]] = await db.query('SELECT COUNT(*) as orders FROM orders');
    const [[{ pending }]] = await db.query("SELECT COUNT(*) as pending FROM orders WHERE status='pending'");
    const [[{ customers }]] = await db.query('SELECT COUNT(*) as customers FROM customers');
    const [[{ products }]] = await db.query('SELECT COUNT(*) as products FROM products WHERE is_active=1');
    const [recentOrders] = await db.query('SELECT * FROM orders ORDER BY created_at DESC LIMIT 8');
    const [lowStock] = await db.query(`
      SELECT p.name, pv.colour, pv.size, pv.stock_qty
      FROM product_variants pv JOIN products p ON pv.product_id=p.id
      WHERE pv.stock_qty <= 5 AND p.is_active=1 ORDER BY pv.stock_qty ASC LIMIT 10
    `);

    // Top products — hide cost/profit from non-super-admins
    const [topProducts] = await db.query(`
      SELECT bi.product_name as name, SUM(bi.quantity) as units_sold,
             SUM(bi.total_price) as revenue
             ${isSuperAdmin ? ', SUM(bi.cost_price * bi.quantity) as total_cost' : ''}
      FROM bill_items bi JOIN bills b ON bi.bill_id=b.id
      WHERE MONTH(b.created_at)=MONTH(NOW()) AND YEAR(b.created_at)=YEAR(NOW())
      GROUP BY bi.product_name ORDER BY units_sold DESC LIMIT 5
    `);

    const response = {
      revenue: isSuperAdmin ? revenue : null, // hide from staff
      orders, pending, customers, products,
      recentOrders, lowStock,
      topProducts,
      role: req.admin.role,
    };

    // Only super_admin sees financial summary
    if (isSuperAdmin) {
      const [[{ bill_count }]] = await db.query(
        "SELECT COUNT(*) as bill_count FROM bills WHERE MONTH(created_at)=MONTH(NOW()) AND YEAR(created_at)=YEAR(NOW())"
      );
      response.bill_count = bill_count;
    }

    res.json(response);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
