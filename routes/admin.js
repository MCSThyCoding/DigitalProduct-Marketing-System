const express = require('express');
const fs = require('fs');
const path = require('path');
const { db } = require('../db');
const payments = require('../payments');
const { UPLOAD_DIR } = require('../upload');
const { requireRole, flash } = require('../middleware');
const { formatMoney } = require('../utils');

const router = express.Router();
const ROOT_DIR = path.join(__dirname, '..');

function uploadedFilePathsForUser(userId) {
  const uploadRoot = path.resolve(UPLOAD_DIR);
  return db.prepare('SELECT file_path FROM products WHERE creator_id = ?').all(userId)
    .map((row) => path.resolve(ROOT_DIR, row.file_path))
    .filter((filePath) => filePath.startsWith(uploadRoot + path.sep));
}

async function removeUserUploadFiles(userId) {
  await Promise.all(uploadedFilePathsForUser(userId).map((filePath) => fs.promises.unlink(filePath).catch(() => {})));
}

router.get('/admin', requireRole('admin'), (req, res) => {
  const stats = {
    users: db.prepare('SELECT COUNT(*) AS count FROM users').get().count,
    products: db.prepare("SELECT COUNT(*) AS count FROM products WHERE status != 'removed'").get().count,
    pendingProducts: db.prepare("SELECT COUNT(*) AS count FROM products WHERE status = 'pending'").get().count,
    orders: db.prepare("SELECT COUNT(*) AS count FROM order_items").get().count,
    revenue: db.prepare("SELECT COALESCE(SUM(total_cents), 0) AS total FROM orders WHERE status = 'completed'").get().total
  };

  const users = db.prepare(`
    SELECT
      u.id,
      u.name,
      u.email,
      u.role,
      u.status,
      u.created_at,
      (SELECT COUNT(*) FROM products p WHERE p.creator_id = u.id AND p.status != 'removed') AS product_count,
      (SELECT COUNT(*) FROM order_items oi WHERE oi.creator_id = u.id) AS sales_count
    FROM users u
    ORDER BY u.created_at DESC, u.id DESC
  `).all();

  const products = db.prepare(`
    SELECT
      p.id,
      p.title,
      p.category,
      p.price_cents,
      p.status,
      p.created_at,
      u.name AS creator_name,
      (SELECT COUNT(*) FROM order_items oi WHERE oi.product_id = p.id) AS sales_count,
      (SELECT COALESCE(SUM(oi.price_cents), 0) FROM order_items oi WHERE oi.product_id = p.id) AS earnings_cents
    FROM products p
    JOIN users u ON u.id = p.creator_id
    ORDER BY CASE p.status WHEN 'pending' THEN 0 WHEN 'live' THEN 1 ELSE 2 END, p.created_at DESC
  `).all();

  const manualPayments = db.prepare(`
    SELECT
      pc.id,
      pc.token,
      pc.total_cents,
      pc.payment_option,
      pc.provider_ref,
      pc.created_at,
      u.name AS buyer_name,
      u.email AS buyer_email,
      p.title AS product_title,
      p.id AS product_id
    FROM pending_checkouts pc
    JOIN users u ON u.id = pc.buyer_id
    JOIN products p ON p.id = pc.product_id
    WHERE pc.provider = 'manual' AND pc.status = 'pending'
    ORDER BY pc.created_at DESC, pc.id DESC
  `).all();

  res.render('admin/dashboard', {
    title: 'Admin Panel',
    stats,
    users,
    products,
    manualPayments,
    formatMoney
  });
});

router.get('/admin/users/:id', requireRole('admin'), (req, res) => {
  const account = db.prepare(`
    SELECT id, name, email, role, status, created_at
    FROM users
    WHERE id = ?
  `).get(Number(req.params.id));

  if (!account) {
    flash(req, 'error', 'User not found.');
    return res.redirect('/admin');
  }

  const products = db.prepare(`
    SELECT
      p.id,
      p.title,
      p.category,
      p.price_cents,
      p.status,
      p.original_filename,
      p.created_at,
      (SELECT COUNT(*) FROM order_items oi WHERE oi.product_id = p.id) AS sales_count,
      (SELECT COALESCE(SUM(oi.price_cents), 0) FROM order_items oi WHERE oi.product_id = p.id) AS earnings_cents
    FROM products p
    WHERE p.creator_id = ?
    ORDER BY p.created_at DESC, p.id DESC
  `).all(account.id);

  const sales = db.prepare(`
    SELECT
      oi.id,
      oi.product_title,
      oi.price_cents,
      oi.created_at,
      o.order_number,
      buyer.name AS buyer_name,
      buyer.email AS buyer_email
    FROM order_items oi
    JOIN orders o ON o.id = oi.order_id
    JOIN users buyer ON buyer.id = o.buyer_id
    WHERE oi.creator_id = ? AND o.status = 'completed'
    ORDER BY oi.created_at DESC, oi.id DESC
  `).all(account.id);

  const purchases = db.prepare(`
    SELECT
      o.id,
      o.order_number,
      o.created_at,
      o.coupon_code,
      o.subtotal_cents,
      o.discount_cents,
      o.total_cents,
      o.payment_provider,
      o.payment_ref,
      o.status,
      (SELECT COUNT(*) FROM order_items oi WHERE oi.order_id = o.id) AS item_count,
      (SELECT GROUP_CONCAT(oi.product_title, ', ') FROM order_items oi WHERE oi.order_id = o.id) AS product_titles
    FROM orders o
    WHERE o.buyer_id = ?
    ORDER BY o.created_at DESC, o.id DESC
  `).all(account.id);

  const reviews = db.prepare(`
    SELECT
      r.id,
      r.rating,
      r.comment,
      r.created_at,
      p.title AS product_title
    FROM reviews r
    JOIN products p ON p.id = r.product_id
    WHERE r.user_id = ?
    ORDER BY r.created_at DESC, r.id DESC
  `).all(account.id);

  const coupons = db.prepare(`
    SELECT id, code, percent_off, active, created_at
    FROM coupons
    WHERE creator_id = ?
    ORDER BY created_at DESC, id DESC
  `).all(account.id);

  const stats = {
    products: products.length,
    liveProducts: products.filter((product) => product.status === 'live').length,
    pendingProducts: products.filter((product) => product.status === 'pending').length,
    itemsSold: sales.length,
    grossEarnings: sales.reduce((sum, sale) => sum + sale.price_cents, 0),
    purchases: purchases.length,
    totalSpent: purchases.filter((order) => order.status === 'completed').reduce((sum, order) => sum + order.total_cents, 0),
    reviews: reviews.length,
    coupons: coupons.length
  };

  res.render('admin/user-detail', {
    title: `${account.name} · Admin`,
    account,
    stats,
    products,
    sales,
    purchases,
    reviews,
    coupons
  });
});

router.post('/admin/users/:id/toggle-status', requireRole('admin'), (req, res) => {
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(req.params.id));
  if (!target) {
    flash(req, 'error', 'User not found.');
    return res.redirect('/admin');
  }
  if (Number(target.id) === Number(req.user.id) || target.role === 'admin') {
    flash(req, 'error', 'Admin accounts cannot be banned from this panel.');
    return res.redirect('/admin');
  }

  const nextStatus = target.status === 'banned' ? 'active' : 'banned';
  db.prepare('UPDATE users SET status = ? WHERE id = ?').run(nextStatus, target.id);
  flash(req, 'success', `${target.name} is now ${nextStatus}.`);
  res.redirect(req.body.redirectTo === 'detail' ? `/admin/users/${target.id}` : '/admin');
});

router.post('/admin/products/:id/approve', requireRole('admin'), (req, res) => {
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(Number(req.params.id));
  if (!product) {
    flash(req, 'error', 'Product not found.');
    return res.redirect('/admin');
  }
  db.prepare(`UPDATE products SET status = 'live', updated_at = datetime('now') WHERE id = ?`).run(product.id);
  flash(req, 'success', `${product.title} is now live.`);
  res.redirect('/admin');
});

router.post('/admin/products/:id/remove', requireRole('admin'), (req, res) => {
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(Number(req.params.id));
  if (!product) {
    flash(req, 'error', 'Product not found.');
    return res.redirect('/admin');
  }
  db.prepare(`UPDATE products SET status = 'removed', updated_at = datetime('now') WHERE id = ?`).run(product.id);
  flash(req, 'success', `${product.title} was removed.`);
  res.redirect('/admin');
});

router.post('/admin/manual-payments/:id/approve', requireRole('admin'), (req, res) => {
  const result = payments.approveManualCheckout(Number(req.params.id));
  if (result.ok) {
    flash(req, 'success', result.alreadyCompleted ? 'Manual payment was already completed.' : 'Manual payment approved. The buyer can now download the product.');
  } else {
    flash(req, 'error', result.error || 'Could not approve this manual payment.');
  }
  res.redirect('/admin');
});

router.post('/admin/manual-payments/:id/reject', requireRole('admin'), (req, res) => {
  const checkout = payments.rejectManualCheckout(Number(req.params.id));
  if (checkout) {
    flash(req, 'success', 'Manual payment request rejected. No order was created.');
  } else {
    flash(req, 'error', 'Manual payment request not found.');
  }
  res.redirect('/admin');
});

router.post('/admin/users/:id/delete', requireRole('admin'), async (req, res, next) => {
  try {
    const target = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(req.params.id));
    if (!target) {
      flash(req, 'error', 'User not found.');
      return res.redirect('/admin');
    }
    if (Number(target.id) === Number(req.user.id)) {
      flash(req, 'error', 'You cannot delete your own admin account.');
      return res.redirect('/admin');
    }
    if (target.role === 'admin') {
      flash(req, 'error', 'Admin accounts cannot be deleted from this panel.');
      return res.redirect('/admin');
    }

    const filePaths = uploadedFilePathsForUser(target.id);
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('DELETE FROM users WHERE id = ?').run(target.id);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }

    await Promise.all(filePaths.map((filePath) => fs.promises.unlink(filePath).catch(() => {})));
    flash(req, 'success', `${target.name} (${target.email}) was deleted. Related products, orders, reviews, coupons, and pending checkouts were removed.`);
    res.redirect('/admin');
  } catch (error) {
    next(error);
  }
});

module.exports = router;
