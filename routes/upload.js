const router = require('express').Router();
const multer = require('multer');
const auth = require('../middleware/auth');
const db = require('../db');
const https = require('https');
const http = require('http');

// Memory storage — file goes to ImgBB, URL saved to DB
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 32 * 1024 * 1024 }, // 32MB max
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Only image files allowed'));
  },
});

// Upload a single image to ImgBB and return the URL
async function uploadToImgBB(buffer, filename) {
  const apiKey = process.env.IMGBB_API_KEY;
  if (!apiKey) throw new Error('IMGBB_API_KEY not set in environment variables');

  const base64 = buffer.toString('base64');

  return new Promise((resolve, reject) => {
    const postData = `key=${apiKey}&image=${encodeURIComponent(base64)}&name=${encodeURIComponent(filename || 'product')}`;

    const options = {
      hostname: 'api.imgbb.com',
      path: '/1/upload',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData),
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.success) {
            resolve(json.data.url); // permanent direct image URL
          } else {
            reject(new Error(json.error?.message || 'ImgBB upload failed'));
          }
        } catch (e) {
          reject(new Error('Invalid response from ImgBB'));
        }
      });
    });

    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

// POST /api/upload/images — upload 1 or multiple images
// Returns: { urls: ['https://i.ibb.co/...', ...] }
router.post('/images', auth, upload.array('images', 10), async (req, res) => {
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: 'No images provided' });
  }

  try {
    const uploadPromises = req.files.map(file =>
      uploadToImgBB(file.buffer, file.originalname)
    );
    const urls = await Promise.all(uploadPromises);

    // Save URLs to uploaded_images table for reference
    try {
      for (const url of urls) {
        await db.query(
          'INSERT IGNORE INTO uploaded_images (url, uploaded_at) VALUES (?, NOW())',
          [url]
        );
      }
    } catch (dbErr) {
      // Table might not exist yet — that's ok, URLs still returned
      console.warn('Could not save to uploaded_images table:', dbErr.message);
    }

    res.json({ urls });
  } catch (err) {
    console.error('Upload error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
