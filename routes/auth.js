const router = require('express').Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../db');
const auth = require('../middleware/auth');

// POST /api/auth/login
router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  try {
    const [[user]] = await db.query(
      'SELECT * FROM admin_users WHERE email = ? AND is_active = 1', [email]
    );
    if (!user) return res.status(401).json({ error: 'Invalid email or password' });
    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) return res.status(401).json({ error: 'Invalid email or password' });
    const token = jwt.sign(
      { id: user.id, email: user.email, name: user.name, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: '30d' }
    );
    res.json({
      token,
      admin: { id: user.id, name: user.name, email: user.email, role: user.role }
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /api/auth/change-password — any logged-in admin can change their own password
router.put('/change-password', auth, async (req, res) => {
  const { current_password, new_password } = req.body;
  if (!current_password || !new_password)
    return res.status(400).json({ error: 'Both current and new password required' });
  if (new_password.length < 6)
    return res.status(400).json({ error: 'New password must be at least 6 characters' });
  try {
    const [[user]] = await db.query('SELECT * FROM admin_users WHERE id = ?', [req.admin.id]);
    const match = await bcrypt.compare(current_password, user.password_hash);
    if (!match) return res.status(401).json({ error: 'Current password is incorrect' });
    const hash = await bcrypt.hash(new_password, 10);
    await db.query('UPDATE admin_users SET password_hash = ? WHERE id = ?', [hash, req.admin.id]);
    res.json({ message: 'Password changed successfully' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/auth/admins — super_admin only: list all admins
router.get('/admins', auth, async (req, res) => {
  if (req.admin.role !== 'super_admin')
    return res.status(403).json({ error: 'Super admin access required' });
  try {
    const [admins] = await db.query(
      'SELECT id, name, email, role, is_active, created_at FROM admin_users ORDER BY created_at DESC'
    );
    res.json(admins);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/auth/admins — super_admin only: create new admin
router.post('/admins', auth, async (req, res) => {
  if (req.admin.role !== 'super_admin')
    return res.status(403).json({ error: 'Super admin access required' });
  const { name, email, password, role } = req.body;
  if (!name || !email || !password)
    return res.status(400).json({ error: 'Name, email and password required' });
  if (password.length < 6)
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  const allowedRoles = ['admin', 'staff'];
  const assignedRole = allowedRoles.includes(role) ? role : 'staff';
  try {
    const [[existing]] = await db.query('SELECT id FROM admin_users WHERE email = ?', [email]);
    if (existing) return res.status(400).json({ error: 'Email already in use' });
    const hash = await bcrypt.hash(password, 10);
    const [result] = await db.query(
      'INSERT INTO admin_users (name, email, password_hash, role) VALUES (?,?,?,?)',
      [name, email, hash, assignedRole]
    );
    res.status(201).json({ id: result.insertId, message: 'Admin created successfully' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /api/auth/admins/:id — super_admin only: update admin
router.put('/admins/:id', auth, async (req, res) => {
  if (req.admin.role !== 'super_admin')
    return res.status(403).json({ error: 'Super admin access required' });
  // Prevent super_admin from demoting themselves
  if (parseInt(req.params.id) === req.admin.id)
    return res.status(400).json({ error: 'Cannot modify your own account here' });
  const { name, email, role, is_active, new_password } = req.body;
  try {
    if (new_password) {
      if (new_password.length < 6) return res.status(400).json({ error: 'Password min 6 chars' });
      const hash = await bcrypt.hash(new_password, 10);
      await db.query(
        'UPDATE admin_users SET name=?, email=?, role=?, is_active=?, password_hash=? WHERE id=?',
        [name, email, role, is_active ?? 1, hash, req.params.id]
      );
    } else {
      await db.query(
        'UPDATE admin_users SET name=?, email=?, role=?, is_active=? WHERE id=?',
        [name, email, role, is_active ?? 1, req.params.id]
      );
    }
    res.json({ message: 'Admin updated' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /api/auth/admins/:id — super_admin only: deactivate admin
router.delete('/admins/:id', auth, async (req, res) => {
  if (req.admin.role !== 'super_admin')
    return res.status(403).json({ error: 'Super admin access required' });
  if (parseInt(req.params.id) === req.admin.id)
    return res.status(400).json({ error: 'Cannot deactivate yourself' });
  try {
    await db.query('UPDATE admin_users SET is_active = 0 WHERE id = ?', [req.params.id]);
    res.json({ message: 'Admin deactivated' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
