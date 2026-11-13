const crypto = require('crypto');
const { db } = require('./db');

const STRIPE_API_BASE = 'https://api.stripe.com/v1';

function utcReqTime() {
  return new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14);
}

function hmacSha512Base64(value, secret) {
  return crypto.createHmac('sha512', secret).update(value).digest('base64');
}

function getBaseUrl(req) {
  const configured = process.env.PUBLIC_BASE_URL || process.env.APP_URL;
  if (configured) return configured.replace(/\/+$/, '');
  return `${req.protocol}://${req.get('host')}`.replace(/\/+$/, '');
}

function stripeConfigured() {
  return Boolean(process.env.STRIPE_SECRET_KEY);
}

function abaConfig() {
  const isProduction = (process.env.ABA_ENV || process.env.PAYMENT_ENV || 'sandbox').toLowerCase() === 'production';
  return {
    merchantId: process.env.ABA_MERCHANT_ID || '',
    apiKey: process.env.ABA_API_KEY || process.env.ABA_PUBLIC_KEY || '',
    baseUrl: (process.env.ABA_BASE_URL || (isProduction ? 'https://checkout.payway.com.kh' : 'https://checkout-sandbox.payway.com.kh')).replace(/\/+$/, ''),
    paymentOption: process.env.ABA_PAYMENT_OPTION || '',
    lifetime: process.env.ABA_LIFETIME_MINUTES || '1440',
    viewType: process.env.ABA_VIEW_TYPE || 'hosted_view'
  };
}

function abaConfigured() {
  const config = abaConfig();
  return Boolean(config.merchantId && config.apiKey);
}

const ABA_PAYMENT_OPTIONS = new Set(['', 'abapay_khqr', 'cards', 'alipay', 'wechat']);

function normalizeAbaPaymentOption(value) {
  const option = String(value || '').trim();
  return ABA_PAYMENT_OPTIONS.has(option) ? option : '';
}

function abaPaymentOptions() {
  return [
    { id: '', label: 'Auto — PayWay shows available methods' },
    { id: 'abapay_khqr', label: 'ABA PAY / KHQR — scan QR code' },
    { id: 'cards', label: 'Card — Visa, Mastercard, UnionPay, JCB' },
    { id: 'alipay', label: 'Alipay' },
    { id: 'wechat', label: 'WeChat Pay' }
  ];
}

function demoEnabledByMode() {
  const mode = (process.env.PAYMENT_PROVIDER || 'auto').toLowerCase();
  return ['demo', 'mock', 'test'].includes(mode);
}

function manualPaymentEnabled() {
  const mode = (process.env.PAYMENT_PROVIDER || 'auto').toLowerCase();
  return process.env.PAYMENT_MANUAL_ENABLED !== 'false' && (mode === 'auto' || process.env.PAYMENT_MANUAL_ENABLED === 'true');
}

function availableProviders() {
  const mode = (process.env.PAYMENT_PROVIDER || 'auto').toLowerCase();

  if (mode === 'demo' || mode === 'mock' || mode === 'test') {
    const providers = [{ id: 'demo', label: 'Card payment' }];
    if (process.env.PAYMENT_MANUAL_ENABLED === 'true') providers.push({ id: 'manual', label: 'Cash / manual payment' });
    return providers;
  }

  const providers = [];
  if (stripeConfigured()) providers.push({ id: 'stripe', label: 'Stripe' });
  if (abaConfigured()) providers.push({ id: 'aba', label: 'ABA PayWay' });

  if (mode === 'stripe') return providers.filter((provider) => provider.id === 'stripe');
  if (mode === 'aba') return providers.filter((provider) => provider.id === 'aba');
  if (mode !== 'auto') return providers;

  if (process.env.PAYMENT_DEMO_ENABLED !== 'false') {
    providers.push({ id: 'demo', label: 'Card payment' });
  }
  if (manualPaymentEnabled()) {
    providers.push({ id: 'manual', label: 'Cash / manual payment' });
  }
  return providers;
}

function defaultProviderId() {
  const providers = availableProviders();
  if (providers.length > 0) return providers[0].id;
  const mode = (process.env.PAYMENT_PROVIDER || 'demo').toLowerCase();
  return ['stripe', 'aba', 'demo', 'manual'].includes(mode) ? mode : 'demo';
}

function isProviderEnabled(provider) {
  return availableProviders().some((item) => item.id === provider);
}

function createPendingCheckout({ buyerId, product, coupon, discountCents, totalCents, provider, paymentOption = null }) {
  const token = `chk_${crypto.randomUUID()}`;
  const result = db.prepare(`
    INSERT INTO pending_checkouts
      (token, buyer_id, product_id, coupon_id, coupon_code, subtotal_cents, discount_cents, total_cents, provider, payment_option, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'created')
  `).run(
    token,
    buyerId,
    product.id,
    coupon ? coupon.id : null,
    coupon ? coupon.code : null,
    product.price_cents,
    discountCents,
    totalCents,
    provider,
    paymentOption || null
  );
  return getCheckoutById(Number(result.lastInsertRowid));
}

function getCheckoutById(id) {
  return db.prepare('SELECT * FROM pending_checkouts WHERE id = ?').get(id) || null;
}

function getCheckoutByToken(token) {
  return db.prepare('SELECT * FROM pending_checkouts WHERE token = ?').get(token) || null;
}

function getCheckoutByProviderRef(provider, providerRef) {
  return db.prepare('SELECT * FROM pending_checkouts WHERE provider = ? AND provider_ref = ? ORDER BY id DESC LIMIT 1')
    .get(provider, providerRef) || null;
}

function updateCheckout(id, fields) {
  const keys = Object.keys(fields);
  if (keys.length === 0) return;
  const assignments = keys.map((key) => `${key} = ?`).join(', ');
  db.prepare(`UPDATE pending_checkouts SET ${assignments}, updated_at = datetime('now') WHERE id = ?`)
    .run(...keys.map((key) => fields[key]), id);
}

async function stripeCreateSession(checkout, product, user, baseUrl) {
  const body = new URLSearchParams();
  body.set('mode', 'payment');
  body.set('success_url', `${baseUrl}/payments/stripe/success?checkout=${checkout.token}`);
  body.set('cancel_url', `${baseUrl}/payments/cancel?checkout=${checkout.token}&provider=stripe`);
  body.set('client_reference_id', String(checkout.id));
  body.set('metadata[checkout_id]', String(checkout.id));
  body.set('metadata[buyer_id]', String(checkout.buyer_id));
  body.set('metadata[product_id]', String(checkout.product_id));
  body.set('customer_email', user.email);
  body.set('line_items[0][quantity]', '1');
  body.set('line_items[0][price_data][currency]', 'usd');
  body.set('line_items[0][price_data][unit_amount]', String(checkout.total_cents));
  body.set('line_items[0][price_data][product_data][name]', product.title.slice(0, 250));
  body.set('line_items[0][price_data][product_data][description]', (product.description || '').slice(0, 500));

  const response = await fetch(`${STRIPE_API_BASE}/checkout/sessions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data?.error?.message || `Stripe request failed (${response.status})`);
  }
  if (!data.url || !data.id) throw new Error('Stripe did not return a checkout URL.');

  updateCheckout(checkout.id, { provider_ref: data.id, status: 'pending' });
  return { type: 'redirect', url: data.url };
}

async function stripeGetSession(sessionId) {
  const response = await fetch(`${STRIPE_API_BASE}/checkout/sessions/${encodeURIComponent(sessionId)}`, {
    headers: { Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}` }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.error?.message || `Stripe lookup failed (${response.status})`);
  return data;
}

function abaRequestTime() {
  return utcReqTime();
}

function abaTranId(checkout) {
  const suffix = Date.now().toString(36).slice(-6);
  return `D${checkout.id}${suffix}`.replace(/[^A-Za-z0-9]/g, '').slice(0, 20);
}

function splitName(name = '') {
  const parts = String(name).trim().split(/\s+/).filter(Boolean);
  return {
    firstname: (parts[0] || 'Customer').slice(0, 100),
    lastname: (parts.slice(1).join(' ') || 'Marketplace').slice(0, 100)
  };
}

async function abaCreateSession(checkout, product, user, baseUrl, paymentOption = null) {
  const config = abaConfig();
  const selectedPaymentOption = paymentOption || config.paymentOption || '';
  const tranId = abaTranId(checkout);
  const amount = (checkout.total_cents / 100).toFixed(2);
  const items = Buffer.from(JSON.stringify([
    { name: product.title.slice(0, 120), quantity: 1, price: Number(amount) }
  ])).toString('base64');
  const customFields = Buffer.from(JSON.stringify({
    checkout_token: checkout.token,
    buyer_id: checkout.buyer_id,
    product_id: checkout.product_id
  })).toString('base64');
  const { firstname, lastname } = splitName(user.name);
  const email = String(user.email || '').slice(0, 50);
  const phone = '';
  const returnUrl = Buffer.from(`${baseUrl}/payments/aba/callback?checkout=${checkout.token}`).toString('base64');
  const cancelUrl = `${baseUrl}/payments/cancel?checkout=${checkout.token}&provider=aba`;
  const successUrl = `${baseUrl}/payments/aba/success?checkout=${checkout.token}`;
  const returnParams = JSON.stringify({ checkout_token: checkout.token });

  const fields = {
    req_time: abaRequestTime(),
    merchant_id: config.merchantId,
    tran_id: tranId,
    firstname,
    lastname,
    email,
    phone,
    type: 'purchase',
    payment_option: selectedPaymentOption,
    items,
    shipping: '0',
    amount,
    currency: 'USD',
    return_url: returnUrl,
    cancel_url: cancelUrl,
    skip_success_page: '1',
    continue_success_url: successUrl,
    custom_fields: customFields,
    return_params: returnParams,
    lifetime: String(config.lifetime),
    view_type: config.viewType,
    payment_gate: '0'
  };

  const hashInput = [
    fields.req_time,
    fields.merchant_id,
    fields.tran_id,
    fields.amount,
    fields.items,
    fields.shipping,
    fields.firstname,
    fields.lastname,
    fields.email,
    fields.phone,
    fields.type,
    fields.payment_option,
    fields.return_url,
    fields.cancel_url,
    fields.continue_success_url,
    '',
    fields.currency,
    fields.custom_fields,
    fields.return_params,
    '',
    fields.lifetime,
    '',
    '',
    fields.skip_success_page
  ].join('');
  fields.hash = hmacSha512Base64(hashInput, config.apiKey);

  const formFields = { ...fields };
  ['payment_option', 'google_pay_token', 'return_deeplink', 'payout', 'additional_params'].forEach((key) => {
    if (!formFields[key]) delete formFields[key];
  });

  updateCheckout(checkout.id, { provider_ref: tranId, status: 'pending' });
  return {
    type: 'form',
    action: `${config.baseUrl}/api/payment-gateway/v1/payments/purchase`,
    fields: formFields
  };
}

function demoCreateSession(checkout, _product, _user, baseUrl) {
  const ref = `demo_${checkout.token}`;
  updateCheckout(checkout.id, { provider_ref: ref, status: 'pending' });
  return { type: 'redirect', url: `${baseUrl}/payments/demo/qr?checkout=${checkout.token}` };
}

function manualCreateSession(checkout) {
  const ref = `manual_${checkout.token}`;
  updateCheckout(checkout.id, { provider_ref: ref, payment_option: checkout.payment_option || 'cash', status: 'pending' });
  return { type: 'manual' };
}

async function createPaymentSession(checkout, { product, user, baseUrl, paymentOption = null }) {
  if (checkout.provider === 'stripe') return stripeCreateSession(checkout, product, user, baseUrl);
  if (checkout.provider === 'aba') return abaCreateSession(checkout, product, user, baseUrl, normalizeAbaPaymentOption(paymentOption));
  if (checkout.provider === 'demo') return demoCreateSession(checkout, product, user, baseUrl);
  if (checkout.provider === 'manual') return manualCreateSession(checkout);
  throw new Error('Unsupported payment provider.');
}

async function stripeVerify(checkout) {
  const session = await stripeGetSession(checkout.provider_ref);
  const paid = session.payment_status === 'paid' || session.payment_status === 'no_payment_required';
  const complete = session.status === 'complete';
  const amountMatches = Number(session.amount_total) === Number(checkout.total_cents);
  const currencyMatches = String(session.currency || '').toLowerCase() === 'usd';
  const referenceMatches = String(session.client_reference_id || session.metadata?.checkout_id || '') === String(checkout.id);

  if (paid && complete && amountMatches && currencyMatches && referenceMatches) {
    return { approved: true, paymentRef: session.payment_intent || session.id };
  }
  if (session.status === 'expired') return { approved: false, failed: true, status: 'expired' };
  return { approved: false, pending: true, status: session.payment_status || session.status };
}

async function abaCheckTransaction(tranId) {
  const config = abaConfig();
  const reqTime = abaRequestTime();
  const hash = hmacSha512Base64(`${reqTime}${config.merchantId}${tranId}`, config.apiKey);
  const response = await fetch(`${config.baseUrl}/api/payment-gateway/v1/payments/check-transaction-2`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      req_time: reqTime,
      merchant_id: config.merchantId,
      tran_id: tranId,
      hash
    })
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`ABA transaction check failed (${response.status})`);
  if (payload.status && payload.status.code !== '00' && payload.status.code !== 0) {
    const error = new Error(payload.status.message || 'ABA transaction check failed');
    error.abaStatus = payload.status;
    throw error;
  }
  return payload.data || {};
}

async function abaVerify(checkout) {
  const data = await abaCheckTransaction(checkout.provider_ref);
  const statusCode = Number(data.payment_status_code);
  const status = String(data.payment_status || '').toUpperCase();
  const amountCents = Math.round(Number(data.total_amount ?? data.payment_amount ?? 0) * 100);
  const amountMatches = Math.abs(amountCents - Number(checkout.total_cents)) <= 1;

  if ((statusCode === 0 || status === 'APPROVED' || status === 'PRE-AUTH') && amountMatches) {
    return { approved: true, paymentRef: data.apv || checkout.provider_ref };
  }
  if (status === 'PENDING' || statusCode === 2) return { approved: false, pending: true, status };
  if (status === 'CANCELLED' || statusCode === 7) return { approved: false, failed: true, status: 'cancelled' };
  return { approved: false, failed: true, status: status || `code_${statusCode}` };
}

async function verifyPayment(checkout) {
  if (checkout.provider === 'demo') {
    return { approved: true, paymentRef: checkout.provider_ref || 'demo' };
  }
  if (checkout.provider === 'manual') {
    return { approved: false, pending: true, status: 'manual_review' };
  }
  if (checkout.provider === 'stripe') return stripeVerify(checkout);
  if (checkout.provider === 'aba') return abaVerify(checkout);
  return { approved: false, failed: true, status: 'unsupported_provider' };
}

function productForOrder(productId) {
  return db.prepare(`
    SELECT p.*, u.name AS creator_name
    FROM products p
    JOIN users u ON u.id = p.creator_id
    WHERE p.id = ?
  `).get(productId);
}

function hasCompletedPurchase(productId, buyerId) {
  return Boolean(db.prepare(`
    SELECT 1
    FROM order_items oi
    JOIN orders o ON o.id = oi.order_id
    WHERE oi.product_id = ? AND o.buyer_id = ? AND o.status = 'completed'
    LIMIT 1
  `).get(productId, buyerId));
}

function fulfillCheckout(checkout, verification) {
  const product = productForOrder(checkout.product_id);

  db.exec('BEGIN IMMEDIATE');
  try {
    const current = getCheckoutById(checkout.id);
    if (current.status === 'completed') {
      db.exec('COMMIT');
      return { alreadyCompleted: true, orderId: current.completed_order_id, checkout: current };
    }

    if (hasCompletedPurchase(checkout.product_id, checkout.buyer_id)) {
      updateCheckout(checkout.id, { status: 'duplicate' });
      db.exec('COMMIT');
      return { duplicate: true, checkout: getCheckoutById(checkout.id) };
    }

    if (!product || product.status !== 'live') {
      updateCheckout(checkout.id, { status: 'failed' });
      db.exec('COMMIT');
      return { failed: true, error: 'Product is no longer available.', checkout: getCheckoutById(checkout.id) };
    }

    const nextOrder = db.prepare('SELECT COALESCE(MAX(order_number), 1000) + 1 AS next_order FROM orders').get().next_order;
    const orderResult = db.prepare(`
      INSERT INTO orders
        (order_number, buyer_id, coupon_id, coupon_code, subtotal_cents, discount_cents, total_cents, payment_provider, payment_ref, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'completed')
    `).run(
      Number(nextOrder),
      checkout.buyer_id,
      checkout.coupon_id || null,
      checkout.coupon_code || null,
      checkout.subtotal_cents,
      checkout.discount_cents,
      checkout.total_cents,
      checkout.provider,
      verification.paymentRef || checkout.provider_ref || null
    );
    const orderId = Number(orderResult.lastInsertRowid);

    db.prepare(`
      INSERT INTO order_items
        (order_id, product_id, product_title, creator_id, price_cents, file_path, original_filename, file_size)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      orderId,
      product.id,
      product.title,
      product.creator_id,
      product.price_cents,
      product.file_path,
      product.original_filename,
      product.file_size
    );

    updateCheckout(checkout.id, { status: 'completed', completed_order_id: orderId });
    db.exec('COMMIT');
    return { orderId, checkout: getCheckoutById(checkout.id) };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

async function completeCheckoutById(id, { userId = null, isAdmin = false, skipUserCheck = false } = {}) {
  const checkout = getCheckoutById(id);
  if (!checkout) return { ok: false, error: 'Checkout session not found.' };

  if (!skipUserCheck && userId && Number(checkout.buyer_id) !== Number(userId) && !isAdmin) {
    return { ok: false, error: 'You do not have access to this checkout.', checkout };
  }
  if (checkout.status === 'completed') {
    return { ok: true, alreadyCompleted: true, orderId: checkout.completed_order_id, checkout };
  }
  if (['failed', 'cancelled', 'duplicate'].includes(checkout.status)) {
    return { ok: false, error: 'This checkout is no longer valid.', checkout };
  }

  let verification;
  try {
    verification = await verifyPayment(checkout);
  } catch (error) {
    return { ok: false, error: error.message || 'Payment verification failed.', checkout };
  }

  if (!verification.approved) {
    if (verification.failed) {
      updateCheckout(checkout.id, { status: verification.status === 'cancelled' ? 'cancelled' : 'failed' });
    }
    return {
      ok: false,
      pending: Boolean(verification.pending),
      error: verification.status ? `Payment status: ${verification.status}` : 'Payment is not complete yet.',
      checkout: getCheckoutById(checkout.id)
    };
  }

  const result = fulfillCheckout(checkout, verification);
  if (result.duplicate) return { ok: false, duplicate: true, error: 'You already own this product.', checkout: result.checkout };
  if (result.failed) return { ok: false, error: result.error, checkout: result.checkout };
  return { ok: true, orderId: result.orderId, alreadyCompleted: Boolean(result.alreadyCompleted), checkout: result.checkout };
}

async function completeCheckoutByToken(token, options = {}) {
  const checkout = getCheckoutByToken(token);
  if (!checkout) return { ok: false, error: 'Checkout session not found.' };
  return completeCheckoutById(checkout.id, options);
}

function approveManualCheckout(id) {
  const checkout = getCheckoutById(id);
  if (!checkout || checkout.provider !== 'manual') {
    return { ok: false, error: 'Manual checkout not found.' };
  }
  if (checkout.status === 'completed') {
    return { ok: true, alreadyCompleted: true, orderId: checkout.completed_order_id, checkout };
  }
  if (!['created', 'pending'].includes(checkout.status)) {
    return { ok: false, error: 'This checkout is no longer pending.', checkout };
  }

  const result = fulfillCheckout(checkout, { paymentRef: checkout.provider_ref || 'manual_approved' });
  if (result.duplicate) {
    return { ok: false, duplicate: true, error: 'Buyer already owns this product.', checkout: result.checkout };
  }
  if (result.failed) {
    return { ok: false, error: result.error, checkout: result.checkout };
  }
  return { ok: true, orderId: result.orderId, checkout: result.checkout };
}

function rejectManualCheckout(id) {
  const checkout = getCheckoutById(id);
  if (!checkout || checkout.provider !== 'manual') return null;
  if (!['completed', 'failed', 'cancelled', 'duplicate'].includes(checkout.status)) {
    updateCheckout(checkout.id, { status: 'cancelled' });
  }
  return getCheckoutById(checkout.id);
}

function cancelCheckoutByToken(token, { userId = null, isAdmin = false } = {}) {
  const checkout = getCheckoutByToken(token);
  if (!checkout) return null;
  if (userId && Number(checkout.buyer_id) !== Number(userId) && !isAdmin) return null;
  if (!['completed', 'failed', 'cancelled', 'duplicate'].includes(checkout.status)) {
    updateCheckout(checkout.id, { status: 'cancelled' });
  }
  return getCheckoutById(checkout.id);
}

module.exports = {
  availableProviders,
  defaultProviderId,
  isProviderEnabled,
  getBaseUrl,
  createPendingCheckout,
  getCheckoutById,
  getCheckoutByToken,
  getCheckoutByProviderRef,
  createPaymentSession,
  completeCheckoutById,
  completeCheckoutByToken,
  approveManualCheckout,
  rejectManualCheckout,
  cancelCheckoutByToken,
  abaCheckTransaction,
  abaPaymentOptions,
  normalizeAbaPaymentOption
};
