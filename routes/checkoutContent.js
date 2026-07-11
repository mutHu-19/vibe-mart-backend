const router = require('express').Router();
const db = require('../db');
const auth = require('../middleware/auth');

// Cache which optional columns exist, same pattern as products.js,
// so this works even before the migration has been run.
let _cols = null;
async function getCols() {
  if (_cols) return _cols;
  const [rows] = await db.query('DESCRIBE checkout_content');
  _cols = rows.map(r => r.Field);
  return _cols;
}

const DEFAULTS = { process_info: '', cod_info: '', bank_info: '' };

// GET /api/checkout-content — public: get content for the shop's checkout page
router.get('/', async (req, res) => {
  try {
    const [[row]] = await db.query('SELECT * FROM checkout_content ORDER BY id DESC LIMIT 1');
    res.json(row || DEFAULTS);
  } catch (err) {
    // Table might not exist yet on an un-migrated DB — fail soft with defaults
    res.json(DEFAULTS);
  }
});

// PUT /api/checkout-content — admin: create or update the single content row
router.put('/', auth, async (req, res) => {
  const { process_info, cod_info, bank_info } = req.body;
  try {
    _cols = null; // refresh cache in case table was just migrated in
    await getCols();

    const [[existing]] = await db.query('SELECT id FROM checkout_content LIMIT 1');

    if (existing) {
      await db.query(
        `UPDATE checkout_content SET process_info=?, cod_info=?, bank_info=?, updated_by=? WHERE id=?`,
        [process_info || '', cod_info || '', bank_info || '', req.admin.id, existing.id]
      );
    } else {
      await db.query(
        `INSERT INTO checkout_content (process_info, cod_info, bank_info, updated_by) VALUES (?,?,?,?)`,
        [process_info || '', cod_info || '', bank_info || '', req.admin.id]
      );
    }
    res.json({ message: 'Checkout content updated successfully' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;