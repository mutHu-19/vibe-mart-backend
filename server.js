require('dotenv').config();
const express = require('express');
const cors = require('cors');
const app = express();

// Middleware
app.use(cors({
  origin: function(origin, callback) {
    const allowed = [
      'https://vibe-mart-topaz.vercel.app',
      'http://localhost:3000',
    ];
    // Allow requests with no origin (mobile apps, curl, Postman)
    if (!origin || allowed.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
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

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', message: 'ShopLK API running' });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`ShopLK API running on port ${PORT}`);
});
