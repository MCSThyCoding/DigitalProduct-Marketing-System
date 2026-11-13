const express = require('express');
const { db } = require('../db');
const { requireAuth, requireRole, flash } = require('../middleware');
const { CATEGORIES, formatMoney } = require('../utils');
const payments = require('../payments');

const router = express.Router();

function getProduct(productId) {
  return db.prepare(`
    SELECT
      p.*,
      u.name AS creator_name,
      u.email AS creator_email,
      (SELECT AVG(r.rating) FROM reviews r WHERE r.product_id = p.id) AS avg_rating,
      (SELECT COUNT(*) FROM reviews r WHERE r.product_id = p.id) AS review_count,
      (SELECT COUNT(*) FROM order_items oi WHERE oi.product_id = p.id) AS sales_count
    FROM products p
    JOIN users u ON u.id = p.creator_id
    WHERE p.id = ?
  `).get(productId);
}

function hasPurchased(productId, userId) {
  return Boolean(db.prepare(`
    SELECT 1
    FROM order_items oi
    JOIN orders o ON o.id = oi.order_id
    WHERE oi.product_id = ? AND o.buyer_id = ? AND o.status = 'completed'
    LIMIT 1
  `).get(productId, userId));
}

function getCoupon(code, creatorId) {
  const normalized = String(code || '').trim().toUpperCase();
  if (!normalized) return null;
  return db.prepare(`
    SELECT *
    FROM coupons
    WHERE code = ? AND active = 1 AND (creator_id IS NULL OR creator_id = ?)
    LIMIT 1
  `).get(normalized, creatorId) || null;
}

function calculateDiscount(subtotalCents, percentOff) {
  return Math.min(subtotalCents, Math.round(subtotalCents * Number(percentOff) / 100));
}

function canViewProduct(product, user) {
  return product && (product.status === 'live' || user?.role === 'admin' || Number(product.creator_id) === Number(user?.id));
}

router.get('/products', requireAuth, (req, res) => {
  const category = String(req.query.category || 'All');
  const q = String(req.query.q || '').trim();
  const conditions = ["p.status = 'live'"];
  const params = [];

  if (category !== 'All' && CATEGORIES.includes(category)) {
    conditions.push('p.category = ?');
    params.push(category);
  }
  if (q) {
    conditions.push('(p.title LIKE ? OR p.description LIKE ? OR u.name LIKE ?)');
    const like = `%${q}%`;
    params.push(like, like, like);
  }

  const products = db.prepare(`
    SELECT
      p.id,
      p.title,
      p.description,
      p.price_cents,
      p.category,
      p.created_at,
      u.name AS creator_name,
      (SELECT AVG(r.rating) FROM reviews r WHERE r.product_id = p.id) AS avg_rating,
      (SELECT COUNT(*) FROM reviews r WHERE r.product_id = p.id) AS review_count,
      (SELECT COUNT(*) FROM order_items oi WHERE oi.product_id = p.id) AS sales_count
    FROM products p
    JOIN users u ON u.id = p.creator_id
    WHERE ${conditions.join(' AND ')}
    ORDER BY p.created_at DESC, p.id DESC
  `).all(...params);

  const categories = db.prepare(`
    SELECT DISTINCT category
    FROM products
    WHERE status = 'live'
    ORDER BY category
  `).all().map((row) => row.category);

  res.render('products/index', {
    title: 'Browse Products',
    products,
    categories,
    filters: { category, q }
  });
});

router.get('/products/:id', requireAuth, (req, res) => {
  const product = getProduct(Number(req.params.id));
  if (!canViewProduct(product, req.user)) {
    flash(req, 'error', 'Product not found.');
    return res.redirect('/products');
  }

  const reviews = db.prepare(`
    SELECT r.id, r.rating, r.comment, r.created_at, u.name AS user_name
    FROM reviews r
    JOIN users u ON u.id = r.user_id
    WHERE r.product_id = ?
    ORDER BY r.created_at DESC
  `).all(product.id);

  const purchased = hasPurchased(product.id, req.user.id);
  const userReview = req.user.role === 'buyer'
    ? db.prepare('SELECT * FROM reviews WHERE product_id = ? AND user_id = ?').get(product.id, req.user.id)
    : null;

  res.render('products/show', {
    title: product.title,
    product,
    reviews,
    purchased,
    userReview,
    formatMoney
  });
});

router.get('/products/:id/checkout', requireAuth, requireRole('buyer'), (req, res) => {
  const product = getProduct(Number(req.params.id));
  if (!product || product.status !== 'live') {
    flash(req, 'error', 'This product is not available.');
    return res.redirect('/products');
  }
  if (hasPurchased(product.id, req.user.id)) {
    flash(req, 'info', 'You already own this product. Open My Library to download it.');
    return res.redirect('/library');
  }

  const requestedCoupon = String(req.query.coupon || '').trim();
  const coupon = getCoupon(requestedCoupon, product.creator_id);
  const discountCents = coupon ? calculateDiscount(product.price_cents, coupon.percent_off) : 0;
  const totalCents = product.price_cents - discountCents;

  const paymentProviders = payments.availableProviders();
  res.render('checkout', {
    title: `Checkout: ${product.title}`,
    product,
    coupon,
    requestedCoupon,
    couponError: requestedCoupon && !coupon ? 'Coupon code is invalid or not available for this product.' : null,
    discountCents,
    totalCents,
    paymentProviders,
    defaultProvider: paymentProviders[0]?.id || '',
    abaPaymentOptions: payments.abaPaymentOptions(),
    defaultAbaPaymentOption: '',
    formatMoney
  });
});

router.post('/products/:id/purchase', requireAuth, requireRole('buyer'), async (req, res) => {
  const productId = Number(req.params.id);
  const product = getProduct(productId);

  if (!product || product.status !== 'live') {
    flash(req, 'error', 'This product is not available.');
    return res.redirect('/products');
  }
  if (hasPurchased(productId, req.user.id)) {
    flash(req, 'info', 'You already own this product.');
    return res.redirect('/library');
  }

  const couponCode = String(req.body.couponCode || '').trim().toUpperCase();
  const coupon = getCoupon(couponCode, product.creator_id);
  if (couponCode && !coupon) {
    flash(req, 'error', 'Coupon code is invalid or not available for this product.');
    return res.redirect(`/products/${productId}/checkout?coupon=${encodeURIComponent(couponCode)}`);
  }

  const discountCents = coupon ? calculateDiscount(product.price_cents, coupon.percent_off) : 0;
  const totalCents = product.price_cents - discountCents;
  const provider = String(req.body.paymentProvider || payments.defaultProviderId() || '');

  if (!payments.isProviderEnabled(provider)) {
    flash(req, 'error', 'The selected payment provider is not configured.');
    return res.redirect(`/products/${productId}/checkout${couponCode ? `?coupon=${encodeURIComponent(couponCode)}` : ''}`);
  }

  if (provider === 'manual') {
    const existing = db.prepare(`
      SELECT token
      FROM pending_checkouts
      WHERE buyer_id = ? AND product_id = ? AND provider = 'manual' AND status IN ('created', 'pending')
      ORDER BY id DESC
      LIMIT 1
    `).get(req.user.id, productId);
    if (existing) return res.redirect(`/payments/manual/awaiting?checkout=${encodeURIComponent(existing.token)}`);
  }

  const paymentOption = provider === 'aba'
    ? payments.normalizeAbaPaymentOption(req.body.paymentOption)
    : provider === 'manual'
      ? 'cash'
      : null;
  const checkout = payments.createPendingCheckout({
    buyerId: req.user.id,
    product,
    coupon,
    discountCents,
    totalCents,
    provider,
    paymentOption
  });

  try {
    const result = await payments.createPaymentSession(checkout, {
      product,
      user: req.user,
      baseUrl: payments.getBaseUrl(req),
      paymentOption
    });

    if (result.type === 'redirect') return res.redirect(result.url);
    if (result.type === 'manual') {
      return res.redirect(`/payments/manual/awaiting?checkout=${encodeURIComponent(checkout.token)}`);
    }
    if (result.type === 'form') {
      return res.render('payment-form', {
        title: 'Redirecting to payment provider',
        action: result.action,
        fields: result.fields
      });
    }
    throw new Error('Unsupported payment provider response.');
  } catch (error) {
    payments.cancelCheckoutByToken(checkout.token, { userId: req.user.id });
    flash(req, 'error', error.message || 'Could not start the payment session.');
    return res.redirect(`/products/${productId}/checkout${couponCode ? `?coupon=${encodeURIComponent(couponCode)}` : ''}`);
  }
});

router.post('/products/:id/reviews', requireAuth, requireRole('buyer'), (req, res) => {
  const productId = Number(req.params.id);
  const product = getProduct(productId);
  const rating = Number.parseInt(req.body.rating, 10);
  const comment = String(req.body.comment || '').trim();

  if (!product || product.status !== 'live' || !hasPurchased(productId, req.user.id)) {
    flash(req, 'error', 'Only buyers who purchased this product can review it.');
    return res.redirect(`/products/${productId}`);
  }
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    flash(req, 'error', 'Please choose a rating from 1 to 5 stars.');
    return res.redirect(`/products/${productId}#reviews`);
  }
  if (comment.length > 1000) {
    flash(req, 'error', 'Review comment is too long.');
    return res.redirect(`/products/${productId}#reviews`);
  }

  const existing = db.prepare('SELECT id FROM reviews WHERE product_id = ? AND user_id = ?').get(productId, req.user.id);
  if (existing) {
    db.prepare('UPDATE reviews SET rating = ?, comment = ? WHERE id = ?').run(rating, comment, existing.id);
    flash(req, 'success', 'Your review was updated.');
  } else {
    db.prepare('INSERT INTO reviews (product_id, user_id, rating, comment) VALUES (?, ?, ?, ?)')
      .run(productId, req.user.id, rating, comment);
    flash(req, 'success', 'Thanks for your review.');
  }
  res.redirect(`/products/${productId}#reviews`);
});

module.exports = router;
