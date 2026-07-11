const router = require('express').Router();
const db = require('../db');
const auth = require('../middleware/auth');

const DEFAULTS = {
  logo_url: '',
  shop_hours: '',
  delivery_policy: '',
  pricing_policy: '',
  preorder_policy: '',
  facebook_url: '',
  tiktok_url: '',
  whatsapp_number: '',
  featured_active: 1,
  hotdeals_active: 1,
};

// GET /api/site-settings — public
router.get('/', async (req, res) => {
  try {
    const [[row]] = await db.query('SELECT * FROM site_settings ORDER BY id DESC LIMIT 1');
    res.json(row || DEFAULTS);
  } catch (err) {
    res.json(DEFAULTS); // table might not exist yet on an un-migrated DB
  }
});

// PUT /api/site-settings — admin
router.put('/', auth, async (req, res) => {
  const {
    logo_url, shop_hours, delivery_policy, pricing_policy, preorder_policy,
    facebook_url, tiktok_url, whatsapp_number, featured_active, hotdeals_active,
  } = req.body;
  try {
    const [[existing]] = await db.query('SELECT id FROM site_settings LIMIT 1');
    const params = [
      logo_url || '', shop_hours || '', delivery_policy || '', pricing_policy || '', preorder_policy || '',
      facebook_url || '', tiktok_url || '', whatsapp_number || '',
      featured_active ? 1 : 0, hotdeals_active ? 1 : 0,
    ];
    if (existing) {
      await db.query(
        `UPDATE site_settings SET logo_url=?, shop_hours=?, delivery_policy=?, pricing_policy=?, preorder_policy=?,
         facebook_url=?, tiktok_url=?, whatsapp_number=?, featured_active=?, hotdeals_active=? WHERE id=?`,
        [...params, existing.id]
      );
    } else {
      await db.query(
        `INSERT INTO site_settings (logo_url, shop_hours, delivery_policy, pricing_policy, preorder_policy,
         facebook_url, tiktok_url, whatsapp_number, featured_active, hotdeals_active) VALUES (?,?,?,?,?,?,?,?,?,?)`,
        params
      );
    }
    res.json({ message: 'Site settings updated successfully' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
