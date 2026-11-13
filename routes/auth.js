const express = require('express');
const bcrypt = require('bcryptjs');
const { db } = require('../db');
const { flash, requireAuth } = require('../middleware');
const { roleHome } = require('../utils');

const router = express.Router();

function validEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
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

router.post('/register', (req, res, next) => {
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

  const result = db.prepare(`
    INSERT INTO users (name, email, password_hash, role, status)
    VALUES (?, ?, ?, ?, 'active')
  `).run(name, email, bcrypt.hashSync(password, 10), role);

  const user = db.prepare('SELECT id, name, role FROM users WHERE id = ?').get(Number(result.lastInsertRowid));
  setUserSession(req, res, next, user);
});

router.post('/logout', requireAuth, (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('connect.sid');
    res.redirect('/');
  });
});

module.exports = router;
