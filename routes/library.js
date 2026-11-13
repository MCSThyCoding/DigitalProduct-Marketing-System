const express = require('express');
const path = require('path');
const { db } = require('../db');
const { requireAuth } = require('../middleware');
const { UPLOAD_DIR } = require('../upload');

const router = express.Router();
const ROOT_DIR = path.join(__dirname, '..');

router.get('/library', requireAuth, (req, res) => {
  const items = db.prepare(`
    SELECT
      oi.id,
      oi.product_id,
      oi.product_title,
      oi.original_filename,
      oi.file_size,
      oi.price_cents,
      oi.created_at AS purchased_at,
      o.order_number,
      o.created_at AS order_date,
      p.status AS product_status,
      u.name AS creator_name,
      r.rating AS user_rating,
      r.comment AS user_review
    FROM order_items oi
    JOIN orders o ON o.id = oi.order_id
    LEFT JOIN products p ON p.id = oi.product_id
    LEFT JOIN users u ON u.id = oi.creator_id
    LEFT JOIN reviews r ON r.product_id = oi.product_id AND r.user_id = o.buyer_id
    WHERE o.buyer_id = ? AND o.status = 'completed'
    ORDER BY o.created_at DESC, oi.id DESC
  `).all(req.user.id);

  res.render('library', {
    title: 'My Library',
    items,
    user: req.user
  });
});

router.get('/library/:itemId/download', requireAuth, (req, res) => {
  const itemId = Number(req.params.itemId);
  const item = db.prepare(`
    SELECT oi.*, o.buyer_id, o.status AS order_status
    FROM order_items oi
    JOIN orders o ON o.id = oi.order_id
    WHERE oi.id = ?
  `).get(itemId);

  if (!item || item.order_status !== 'completed' || (item.buyer_id !== req.user.id && req.user.role !== 'admin')) {
    return res.status(403).send('You do not have access to this download.');
  }

  const filePath = path.resolve(ROOT_DIR, item.file_path);
  const uploadRoot = path.resolve(UPLOAD_DIR);
  if (!filePath.startsWith(uploadRoot + path.sep) || !require('fs').existsSync(filePath)) {
    return res.status(404).send('Download file is unavailable.');
  }

  res.download(filePath, item.original_filename);
});

module.exports = router;
