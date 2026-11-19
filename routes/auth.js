const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { db } = require('../db');
const { sendOtpEmail } = require('../mailer');
const { flash, requireAuth } = require('../middleware');
const { roleHome } = require('../utils');

const router = express.Router();

function validEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function otpCodeHash(code) {
  return crypto.createHash('sha256').update(String(code)).digest('hex');
}

function generateOtpCode() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}

function issueRegisterOtp(email, payload) {
  const code = generateOtpCode();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  db.prepare(`
    INSERT INTO email_otps (email, code_hash, purpose, payload, expires_at, attempts)
    VALUES (?, ?, 'register', ?, ?, 0)
    ON CONFLICT(email, purpose) DO UPDATE SET
      code_hash = excluded.code_hash,
      payload = excluded.payload,
      expires_at = excluded.expires_at,
      attempts = 0,
      created_at = datetime('now')
  `).run(email, otpCodeHash(code), JSON.stringify(payload), expiresAt);
  return code;
}

function setUserSession(req, res, next, user) {
  const userId = user.id;
  req.session.regenerate((err) => {
    if (err) return next(err);
    req.session.userId = userId;
    flash(req, 'success', `Welcome, ${user.name}.`);
    res.redirect(roleHome(user.role));
  });
}

router.get('/', (req, res) => {
  if (req.user) return res.redirect(roleHome(req.user.role));
  res.render('index', { title: 'Digital Products Marketplace' });
});

router.get('/login', (req, res) => res.redirect('/'));

router.post('/login', (req, res, next) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);

  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    flash(req, 'error', 'Invalid email or password.');
    return res.redirect('/');
  }

  if (user.status === 'banned') {
    flash(req, 'error', 'This account has been banned.');
    return res.redirect('/');
  }

  setUserSession(req, res, next, user);
});

router.get('/register', (req, res) => {
  if (req.user) return res.redirect(roleHome(req.user.role));
  res.render('register', { title: 'Create Account', values: {}, error: null });
});

router.post('/register', async (req, res, next) => {
  const name = String(req.body.name || '').trim();
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const confirmPassword = String(req.body.confirmPassword || '');
  const role = String(req.body.role || '');
  const values = { name, email, role };

  if (!name || !validEmail(email) || password.length < 8 || password !== confirmPassword || !['buyer', 'creator'].includes(role)) {
    return res.status(400).render('register', {
      title: 'Create Account',
      values,
      error: 'Please complete all fields, use a valid email, choose Buyer or Creator, and use a matching password of at least 8 characters.'
    });
  }

  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (existing) {
    return res.status(400).render('register', {
      title: 'Create Account',
      values,
      error: 'An account with that email already exists.'
    });
  }

  try {
    const payload = { name, passwordHash: bcrypt.hashSync(password, 10), role };
    const code = issueRegisterOtp(email, payload);
    const result = await sendOtpEmail(email, code);
    res.render('verify-email', {
      title: 'Verify Email',
      email,
      error: result.delivered || result.devCode ? null : 'Could not send the verification email. Please try again later or contact the admin.',
      message: null,
      devCode: result.delivered ? null : result.devCode
    });
  } catch (error) {
    next(error);
  }
});

function renderVerify(req, res, { email, error = null, message = null, devCode = null }) {
  res.render('verify-email', { title: 'Verify Email', email, error, message, devCode });
}

router.get('/verify-email', (req, res) => {
  const email = String(req.query.email || '').trim().toLowerCase();
  if (!email) return res.redirect('/register');
  renderVerify(req, res, { email });
});

router.post('/verify-email', async (req, res, next) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    const code = String(req.body.code || '').trim();
    const row = db.prepare(`
      SELECT * FROM email_otps
      WHERE email = ? AND purpose = 'register'
      ORDER BY id DESC
      LIMIT 1
    `).get(email);

    if (!row) return renderVerify(req, res, { email, error: 'No verification code found. Please register again.' });
    if (new Date(row.expires_at).getTime() < Date.now()) {
      db.prepare('DELETE FROM email_otps WHERE id = ?').run(row.id);
      return renderVerify(req, res, { email, error: 'That code expired. Please resend a new one.' });
    }
    if (Number(row.attempts) >= 5) {
      db.prepare('DELETE FROM email_otps WHERE id = ?').run(row.id);
      return renderVerify(req, res, { email, error: 'Too many attempts. Please register again.' });
    }
    if (otpCodeHash(code) !== row.code_hash) {
      db.prepare('UPDATE email_otps SET attempts = attempts + 1 WHERE id = ?').run(row.id);
      return renderVerify(req, res, { email, error: 'Incorrect code. Please try again.' });
    }

    const payload = JSON.parse(row.payload || '{}');
    const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
    if (existing) {
      db.prepare('DELETE FROM email_otps WHERE id = ?').run(row.id);
      return renderVerify(req, res, { email, error: 'An account with that email already exists.' });
    }

    const result = db.prepare(`
      INSERT INTO users (name, email, password_hash, role, status)
      VALUES (?, ?, ?, ?, 'active')
    `).run(payload.name, email, payload.passwordHash, payload.role);
    db.prepare('DELETE FROM email_otps WHERE id = ?').run(row.id);

    const user = db.prepare('SELECT id, name, email, role, status FROM users WHERE id = ?').get(Number(result.lastInsertRowid));
    setUserSession(req, res, next, user);
  } catch (error) {
    next(error);
  }
});

router.post('/resend-otp', async (req, res, next) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    const row = db.prepare(`
      SELECT payload FROM email_otps
      WHERE email = ? AND purpose = 'register'
      ORDER BY id DESC
      LIMIT 1
    `).get(email);
    if (!row) return renderVerify(req, res, { email, error: 'No pending registration found. Please register again.' });

    const payload = JSON.parse(row.payload || '{}');
    const code = issueRegisterOtp(email, payload);
    const result = await sendOtpEmail(email, code);
    renderVerify(req, res, {
      email,
      error: result.delivered || result.devCode ? null : 'Could not send the verification email. Please try again later or contact the admin.',
      message: result.delivered ? 'A new code was sent to your email.' : (result.devCode ? 'A new code was generated (dev mode).' : null),
      devCode: result.delivered ? null : result.devCode
    });
  } catch (error) {
    next(error);
  }
});

router.post('/logout', requireAuth, (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('connect.sid');
    res.redirect('/');
  });
});

module.exports = router;
