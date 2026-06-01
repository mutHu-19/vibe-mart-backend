const router = require('express').Router();
const cloudinary = require('cloudinary').v2;
const multer = require('multer');
const auth = require('../middleware/auth');

// Configure Cloudinary
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Only image files are allowed'));
  },
});

function uploadToCloudinary(buffer) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder: 'shoplk/products',
        transformation: [
          { width: 800, height: 800, crop: 'limit', quality: 'auto', fetch_format: 'auto' }
        ],
      },
      (error, result) => {
        if (error) reject(error);
        else resolve(result.secure_url);
      }
    );
    stream.end(buffer);
  });
}

// GET /api/upload/test — test if Cloudinary is configured
router.get('/test', auth, (req, res) => {
  const cloud = process.env.CLOUDINARY_CLOUD_NAME;
  const key = process.env.CLOUDINARY_API_KEY;
  const secret = process.env.CLOUDINARY_API_SECRET;
  res.json({
    configured: !!(cloud && key && secret),
    cloud_name: cloud || 'MISSING',
    api_key: key ? key.slice(0, 4) + '****' : 'MISSING',
    api_secret: secret ? '****set****' : 'MISSING',
  });
});

// POST /api/upload/images — upload multiple images
router.post('/images', auth, upload.array('images', 10), async (req, res) => {
  // Check config first
  if (!process.env.CLOUDINARY_CLOUD_NAME || !process.env.CLOUDINARY_API_KEY || !process.env.CLOUDINARY_API_SECRET) {
    return res.status(500).json({
      error: 'Cloudinary not configured — go to Railway → Variables and add: CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET'
    });
  }

  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: 'No images provided' });
  }

  try {
    console.log(`Uploading ${req.files.length} image(s) to Cloudinary...`);
    const urls = await Promise.all(req.files.map(f => uploadToCloudinary(f.buffer)));
    console.log('Upload success:', urls);
    res.json({ urls });
  } catch (err) {
    console.error('Cloudinary upload error:', err);
    res.status(500).json({ error: 'Cloudinary upload failed: ' + err.message });
  }
});

// POST /api/upload/single — upload one image
router.post('/single', auth, upload.single('image'), async (req, res) => {
  if (!process.env.CLOUDINARY_CLOUD_NAME) {
    return res.status(500).json({ error: 'Cloudinary not configured' });
  }
  if (!req.file) return res.status(400).json({ error: 'No image provided' });
  try {
    const url = await uploadToCloudinary(req.file.buffer);
    res.json({ url });
  } catch (err) {
    res.status(500).json({ error: 'Upload failed: ' + err.message });
  }
});

module.exports = router;
