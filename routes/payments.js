const crypto = require('crypto');
const os = require('os');
const express = require('express');
const QRCode = require('qrcode');
const payments = require('../payments');
const { db } = require('../db');
const { formatMoney } = require('../utils');
const { requireAuth, flash } = require('../middleware');

const router = express.Router();

function checkoutRedirect(checkout, provider = '') {
  const params = new URLSearchParams();
  if (checkout.coupon_code) params.set('coupon', checkout.coupon_code);
  const query = params.toString();
  return `/products/${checkout.product_id}/checkout${query ? `?${query}` : ''}`;
}

function checkoutProduct(productId) {
  return db.prepare('SELECT id, title, price_cents FROM products WHERE id = ?').get(productId) || null;
}

function lanIPv4() {
  const interfaces = os.networkInterfaces();
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries || []) {
      if (entry.family === 'IPv4' && !entry.internal) return entry.address;
    }
  }
  return null;
}

function scanBaseUrl(req) {
  const host = String(req.get('host') || '');
  const hostName = host.split(':')[0];
  if (hostName && !['localhost', '127.0.0.1', '::1'].includes(hostName)) {
    return `${req.protocol || 'http'}://${host}`;
  }

  const port = host.includes(':') ? host.split(':').pop() : String(process.env.PORT || req.socket.localPort || 3000);
  const ip = lanIPv4();
  if (ip) return `http://${ip}:${port}`;
  return payments.getBaseUrl(req);
}

async function demoQrDataUrl(req, checkout) {
  const scanUrl = `${scanBaseUrl(req)}/payments/demo/scan?checkout=${encodeURIComponent(checkout.token)}`;
  const qrDataUrl = await QRCode.toDataURL(scanUrl, { margin: 1, width: 340 });
  return { scanUrl, qrDataUrl };
}

function demoCheckoutOrNull(req, res) {
  const token = String(req.query.checkout || '');
  const checkout = payments.getCheckoutByToken(token);
  if (!checkout || checkout.provider !== 'demo') {
    flash(req, 'error', 'Card payment session not found.');
    res.redirect('/products');
    return null;
  }
  if (Number(checkout.buyer_id) !== Number(req.user.id) && req.user.role !== 'admin') {
    flash(req, 'error', 'You do not have access to this checkout.');
    res.redirect('/products');
    return null;
  }
  return checkout;
}

router.get('/payments/cancel', requireAuth, (req, res) => {
  const token = String(req.query.checkout || '');
  const provider = String(req.query.provider || '');
  const checkout = payments.cancelCheckoutByToken(token, { userId: req.user.id, isAdmin: req.user.role === 'admin' });

  if (!checkout) {
    flash(req, 'error', 'Payment was cancelled or the checkout session was not found.');
    return res.redirect('/products');
  }

  flash(req, provider === 'aba' ? 'info' : 'error', 'Payment was cancelled. No charge was completed.');
  res.redirect(checkoutRedirect(checkout, provider));
});

router.get('/payments/manual/awaiting', requireAuth, (req, res) => {
  const token = String(req.query.checkout || '');
  const checkout = payments.getCheckoutByToken(token);

  if (!checkout || checkout.provider !== 'manual') {
    flash(req, 'error', 'Manual payment request not found.');
    return res.redirect('/products');
  }
  if (Number(checkout.buyer_id) !== Number(req.user.id) && req.user.role !== 'admin') {
    flash(req, 'error', 'You do not have access to this checkout.');
    return res.redirect('/products');
  }

  const product = db.prepare('SELECT id, title, price_cents FROM products WHERE id = ?').get(checkout.product_id);
  res.render('payment-pending', {
    title: 'Manual payment pending',
    checkout,
    product,
    formatMoney
  });
});

router.get('/payments/demo/qr', requireAuth, async (req, res, next) => {
  try {
    const checkout = demoCheckoutOrNull(req, res);
    if (!checkout) return;

    if (checkout.status === 'completed') {
      flash(req, 'info', 'This payment was already completed.');
      return res.redirect('/library');
    }
    if (['failed', 'cancelled', 'duplicate'].includes(checkout.status)) {
      flash(req, 'error', 'This payment session is no longer valid.');
      return res.redirect(checkoutRedirect(checkout));
    }

    const product = checkoutProduct(checkout.product_id);
    const { scanUrl, qrDataUrl } = await demoQrDataUrl(req, checkout);
    res.render('payment-qr', {
      title: 'Scan to pay',
      checkout,
      product,
      scanUrl,
      qrDataUrl,
      formatMoney
    });
  } catch (error) {
    next(error);
  }
});

router.get('/payments/demo/status', requireAuth, (req, res) => {
  const checkout = payments.getCheckoutByToken(String(req.query.checkout || ''));
  if (!checkout || checkout.provider !== 'demo') {
    return res.status(404).json({ error: 'Payment session not found.' });
  }
  if (Number(checkout.buyer_id) !== Number(req.user.id) && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'You do not have access to this checkout.' });
  }
  res.json({ status: checkout.status });
});

function publicDemoCheckout(token) {
  const checkout = payments.getCheckoutByToken(token);
  if (!checkout || checkout.provider !== 'demo') return null;
  return checkout;
}

router.get('/payments/demo/scan', (req, res) => {
  const checkout = publicDemoCheckout(String(req.query.checkout || ''));
  if (!checkout) return res.status(404).render('error', { title: 'Payment link not found', message: 'This payment QR link is invalid or has expired.' });

  const product = checkoutProduct(checkout.product_id);
  if (checkout.status === 'completed') {
    return res.render('payment-complete', {
      title: 'Payment complete',
      checkout,
      product,
      formatMoney
    });
  }
  if (!['created', 'pending'].includes(checkout.status)) {
    return res.status(400).render('error', { title: 'Payment unavailable', message: 'This payment session is no longer valid.' });
  }

  res.render('payment-scan', {
    title: 'Confirm card payment',
    checkout,
    product,
    completeUrl: `/payments/demo/complete?checkout=${encodeURIComponent(checkout.token)}`,
    formatMoney
  });
});

router.get('/payments/demo/complete', async (req, res, next) => {
  try {
    const checkout = publicDemoCheckout(String(req.query.checkout || ''));
    if (!checkout) return res.status(404).render('error', { title: 'Payment link not found', message: 'This payment QR link is invalid or has expired.' });

    const result = await payments.completeCheckoutByToken(checkout.token, { skipUserCheck: true });
    const product = checkoutProduct(checkout.product_id);
    if (result.ok) {
      return res.render('payment-complete', {
        title: 'Payment complete',
        checkout: result.checkout || checkout,
        product,
        formatMoney
      });
    }

    res.status(400).render('error', {
      title: 'Payment not completed',
      message: result.error || 'The payment could not be completed.'
    });
  } catch (error) {
    next(error);
  }
});

async function handlePaymentReturn(req, res, providerLabel) {
  const token = String(req.query.checkout || '');
  const result = await payments.completeCheckoutByToken(token, {
    userId: req.user.id,
    isAdmin: req.user.role === 'admin'
  });

  if (result.ok) {
    flash(req, 'success', `Payment confirmed by ${providerLabel}. Your download is ready in My Library.`);
    return res.redirect('/library');
  }

  if (result.pending) {
    flash(req, 'info', 'Payment is still being confirmed. Please wait a moment and check My Library.');
    return res.redirect(result.checkout ? checkoutRedirect(result.checkout) : '/products');
  }

  flash(req, 'error', result.error || 'Payment could not be confirmed.');
  res.redirect(result.checkout ? checkoutRedirect(result.checkout) : '/products');
}

router.get('/payments/demo/success', requireAuth, (req, res) => handlePaymentReturn(req, res, 'card'));
router.get('/payments/stripe/success', requireAuth, (req, res) => handlePaymentReturn(req, res, 'Stripe'));
router.get('/payments/aba/success', requireAuth, (req, res) => handlePaymentReturn(req, res, 'ABA PayWay'));

function verifyStripeSignature(rawBody, signatureHeader, secret) {
  const parts = String(signatureHeader || '').split(',').map((part) => part.trim());
  const timestamp = parts.find((part) => part.startsWith('t='))?.slice(2);
  const signatures = parts.filter((part) => part.startsWith('v1=')).map((part) => part.slice(3));
  if (!timestamp || signatures.length === 0) return false;
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;

  const expected = crypto.createHmac('sha256', secret).update(`${timestamp}.${rawBody.toString()}`).digest('hex');
  return signatures.some((signature) => {
    const expectedBuffer = Buffer.from(expected, 'utf8');
    const signatureBuffer = Buffer.from(signature, 'utf8');
    return expectedBuffer.length === signatureBuffer.length && crypto.timingSafeEqual(expectedBuffer, signatureBuffer);
  });
}

router.post('/payments/stripe/webhook', async (req, res) => {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) return res.status(501).json({ error: 'Stripe webhook secret is not configured.' });
  if (!req.rawBody || !verifyStripeSignature(req.rawBody, req.get('stripe-signature'), secret)) {
    return res.status(400).json({ error: 'Invalid Stripe signature.' });
  }

  const event = JSON.parse(req.rawBody.toString());
  if (['checkout.session.completed', 'checkout.session.async_payment_succeeded'].includes(event.type)) {
    const session = event.data?.object || {};
    let checkout = session.id ? payments.getCheckoutByProviderRef('stripe', session.id) : null;
    if (!checkout && session.metadata?.checkout_id) {
      checkout = payments.getCheckoutById(Number(session.metadata.checkout_id));
    }
    if (checkout) {
      await payments.completeCheckoutById(checkout.id, { skipUserCheck: true });
    }
  }

  res.json({ received: true });
});

router.post('/payments/aba/callback', async (req, res) => {
  try {
    const tranId = String(req.body.tran_id || req.body.tranId || '');
    const returnParams = typeof req.body.return_params === 'string' ? req.body.return_params : '';
    let checkout = tranId ? payments.getCheckoutByProviderRef('aba', tranId) : null;

    if (!checkout && returnParams) {
      try {
        const parsed = JSON.parse(returnParams);
        checkout = parsed.checkout_token ? payments.getCheckoutByToken(parsed.checkout_token) : null;
      } catch (_error) {
        checkout = null;
      }
    }

    if (!checkout) {
      return res.status(404).json({ status: 'error', message: 'Checkout not found' });
    }

    const result = await payments.completeCheckoutById(checkout.id, { skipUserCheck: true });
    if (result.ok) {
      return res.json({ status: '00', message: 'Success' });
    }
    return res.status(202).json({ status: result.pending ? 'pending' : 'error', message: result.error || 'Payment pending' });
  } catch (error) {
    console.error('ABA callback error', error);
    return res.status(500).json({ status: 'error', message: 'Callback processing failed' });
  }
});

module.exports = router;
