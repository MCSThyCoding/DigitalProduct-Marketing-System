const express = require('express');
const path = require('path');
const { db } = require('../db');
const { requireRole, flash } = require('../middleware');
const { upload, validateUploadedFile } = require('../upload');
const { CATEGORIES, parseMoneyToCents } = require('../utils');

const router = express.Router();

function productValues(body = {}) {
  return {
    title: String(body.title || '').trim(),
    description: String(body.description || '').trim(),
    price: String(body.price || '').trim(),
    category: CATEGORIES.includes(body.category) ? body.category : 'Other'
  };
}

function getOwnedProduct(req, res) {
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(Number(req.params.id));
  if (!product || Number(product.creator_id) !== Number(req.user.id) || product.status === 'removed') return null;
  return product;
}

function storedFileInfo(file) {
  return {
    filePath: path.join('storage', 'uploads', path.basename(file.path)),
    originalFilename: file.originalname,
    fileSize: file.size,
    mimeType: file.mimetype || null
  };
}

router.get('/creator', requireRole('creator'), (req, res) => {
  const stats = db.prepare(`
    SELECT
      COUNT(oi.id) AS sales_count,
      COALESCE(SUM(oi.price_cents), 0) AS earnings_cents
    FROM order_items oi
    WHERE oi.creator_id = ?
  `).get(req.user.id);

  const productCount = db.prepare(`
    SELECT COUNT(*) AS count
    FROM products
    WHERE creator_id = ? AND status != 'removed'
  `).get(req.user.id).count;

  const pendingCount = db.prepare(`
    SELECT COUNT(*) AS count
    FROM products
    WHERE creator_id = ? AND status = 'pending'
  `).get(req.user.id).count;

  const products = db.prepare(`
    SELECT
      p.*,
      (SELECT COUNT(*) FROM order_items oi WHERE oi.product_id = p.id) AS sales_count,
      (SELECT COALESCE(SUM(oi.price_cents), 0) FROM order_items oi WHERE oi.product_id = p.id) AS earnings_cents
    FROM products p
    WHERE p.creator_id = ? AND p.status != 'removed'
    ORDER BY p.created_at DESC, p.id DESC
  `).all(req.user.id);

  res.render('creator/dashboard', {
    title: 'Creator Dashboard',
    stats,
    productCount,
    pendingCount,
    products,
    categories: CATEGORIES
  });
});

router.get('/creator/products/new', requireRole('creator'), (req, res) => {
  res.render('creator/product-form', {
    title: 'Upload Product',
    product: null,
    values: { title: '', description: '', price: '', category: 'Other' },
    categories: CATEGORIES,
    error: null
  });
});

router.post('/creator/products', requireRole('creator'), upload.single('file'), validateUploadedFile, (req, res) => {
  const values = productValues(req.body);
  const priceCents = parseMoneyToCents(values.price);

  if (req.fileValidationError || !req.file) {
    return res.status(400).render('creator/product-form', {
      title: 'Upload Product',
      product: null,
      values,
      categories: CATEGORIES,
      error: req.fileValidationError || 'Please choose a digital file to upload (PDF, ZIP, DOCX, PPTX, code, and more).'
    });
  }

  if (!values.title || !values.description || priceCents === null || priceCents <= 0) {
    return res.status(400).render('creator/product-form', {
      title: 'Upload Product',
      product: null,
      values,
      categories: CATEGORIES,
      error: 'Title, description, and a price greater than $0.00 are required.'
    });
  }

  const file = storedFileInfo(req.file);
  db.prepare(`
    INSERT INTO products
      (creator_id, title, description, price_cents, category, file_path, original_filename, file_size, mime_type, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')
  `).run(
    req.user.id,
    values.title,
    values.description,
    priceCents,
    values.category,
    file.filePath,
    file.originalFilename,
    file.fileSize,
    file.mimeType
  );

  flash(req, 'success', 'Product submitted for review. It will appear in the marketplace after admin approval.');
  res.redirect('/creator');
});

router.get('/creator/products/:id/edit', requireRole('creator'), (req, res) => {
  const product = getOwnedProduct(req, res);
  if (!product) {
    flash(req, 'error', 'Product not found.');
    return res.redirect('/creator');
  }

  res.render('creator/product-form', {
    title: `Edit ${product.title}`,
    product,
    values: {
      title: product.title,
      description: product.description,
      price: (product.price_cents / 100).toFixed(2),
      category: product.category
    },
    categories: CATEGORIES,
    error: null
  });
});

router.post('/creator/products/:id', requireRole('creator'), upload.single('file'), validateUploadedFile, (req, res) => {
  const product = getOwnedProduct(req, res);
  if (!product) {
    flash(req, 'error', 'Product not found.');
    return res.redirect('/creator');
  }

  const values = productValues(req.body);
  const priceCents = parseMoneyToCents(values.price);
  const file = req.file ? storedFileInfo(req.file) : null;

  if (req.fileValidationError) {
    return res.status(400).render('creator/product-form', {
      title: `Edit ${product.title}`,
      product,
      values,
      categories: CATEGORIES,
      error: req.fileValidationError
    });
  }

  if (!values.title || !values.description || priceCents === null || priceCents <= 0) {
    return res.status(400).render('creator/product-form', {
      title: `Edit ${product.title}`,
      product,
      values,
      categories: CATEGORIES,
      error: 'Title, description, and a price greater than $0.00 are required.'
    });
  }

  if (file) {
    db.prepare(`
      UPDATE products
      SET title = ?, description = ?, price_cents = ?, category = ?, file_path = ?, original_filename = ?, file_size = ?, mime_type = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(values.title, values.description, priceCents, values.category, file.filePath, file.originalFilename, file.fileSize, file.mimeType, product.id);
  } else {
    db.prepare(`
      UPDATE products
      SET title = ?, description = ?, price_cents = ?, category = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(values.title, values.description, priceCents, values.category, product.id);
  }

  flash(req, 'success', 'Product updated.');
  res.redirect('/creator');
});

router.post('/creator/products/:id/delete', requireRole('creator'), (req, res) => {
  const product = getOwnedProduct(req, res);
  if (!product) {
    flash(req, 'error', 'Product not found.');
    return res.redirect('/creator');
  }

  db.prepare(`UPDATE products SET status = 'removed', updated_at = datetime('now') WHERE id = ?`).run(product.id);
  flash(req, 'success', 'Product removed from the marketplace. Existing downloads remain available to buyers.');
  res.redirect('/creator');
});

router.get('/creator/coupons', requireRole('creator'), (req, res) => {
  const coupons = db.prepare(`
    SELECT *
    FROM coupons
    WHERE creator_id = ?
    ORDER BY created_at DESC, id DESC
  `).all(req.user.id);

  res.render('creator/coupons', {
    title: 'Coupon Codes',
    coupons,
    error: null
  });
});

router.post('/creator/coupons', requireRole('creator'), (req, res) => {
  const code = String(req.body.code || '').trim().toUpperCase();
  const percentOff = Number.parseInt(req.body.percentOff, 10);

  if (!/^[A-Z0-9_-]{3,30}$/.test(code) || !Number.isInteger(percentOff) || percentOff < 1 || percentOff > 100) {
    flash(req, 'error', 'Coupon code must be 3-30 letters/numbers and discount must be 1-100%.');
    return res.redirect('/creator/coupons');
  }

  try {
    db.prepare('INSERT INTO coupons (code, percent_off, creator_id, active) VALUES (?, ?, ?, 1)')
      .run(code, percentOff, req.user.id);
    flash(req, 'success', `Coupon ${code} created.`);
  } catch (error) {
    if (String(error.message).includes('UNIQUE')) {
      flash(req, 'error', 'That coupon code already exists.');
    } else {
      throw error;
    }
  }
  res.redirect('/creator/coupons');
});

router.post('/creator/coupons/:id/toggle', requireRole('creator'), (req, res) => {
  const coupon = db.prepare('SELECT * FROM coupons WHERE id = ? AND creator_id = ?').get(Number(req.params.id), req.user.id);
  if (coupon) {
    db.prepare('UPDATE coupons SET active = ? WHERE id = ?').run(coupon.active ? 0 : 1, coupon.id);
  }
  res.redirect('/creator/coupons');
});

module.exports = router;
