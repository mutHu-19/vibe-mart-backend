const jwt = require('jsonwebtoken');

// Main auth middleware — verifies JWT token
module.exports = (req, res, next) => {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer '))
    return res.status(401).json({ error: 'No token provided' });
  const token = auth.split(' ')[1];
  try {
    req.admin = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }
};

// Super admin only middleware
module.exports.superAdminOnly = (req, res, next) => {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer '))
    return res.status(401).json({ error: 'No token provided' });
  try {
    req.admin = jwt.verify(auth.split(' ')[1], process.env.JWT_SECRET);
    if (req.admin.role !== 'super_admin')
      return res.status(403).json({ error: 'Super admin access required' });
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }
};
