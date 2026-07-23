require('dotenv').config();
const express = require('express');
const cors = require('cors');
const app = express();

// Middleware
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:3000',
  credentials: true
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Routes
app.use('/api/products', require('./routes/products'));
app.use('/api/categories', require('./routes/categories'));
app.use('/api/orders', require('./routes/orders'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/customers', require('./routes/customers'));
app.use('/api/auth', require('./routes/auth'));
app.use('/api/upload', require('./routes/upload'));
app.use('/api/bills', require('./routes/bills'));
app.use('/api/returns', require('./routes/returns'));
app.use('/api/popup', require('./routes/popup'));
app.use('/api/checkout-content', require('./routes/checkoutContent'));
app.use('/api/site-settings', require('./routes/siteSettings'));
app.use('/api/banner-slides', require('./routes/bannerSlides'));

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', message: 'Zelinalk API running' });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`ZelinalkLK API running on port ${PORT}`);
});
