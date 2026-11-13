const { db } = require('./db');
const { roleHome, formatMoney, formatDate, categoryIcon, fileIcon } = require('./utils');

function flash(req, type, message) {
  req.session.flash = req.session.flash || [];
  req.session.flash.push({ type, message });
}

function loadFlash(req, res, next) {
  res.locals.flash = req.session.flash || [];
  delete req.session.flash;
  next();
}

function loadUser(req, res, next) {
  req.user = null;
  if (req.session.userId) {
    req.user = db.prepare('SELECT id, name, email, role, status, created_at FROM users WHERE id = ?').get(req.session.userId) || null;
    if (req.user && req.user.status === 'banned') {
      req.session.destroy(() => {});
      req.user = null;
    }
  }
  res.locals.user = req.user;
  res.locals.roleHome = roleHome;
  res.locals.formatMoney = formatMoney;
  res.locals.formatDate = formatDate;
  res.locals.categoryIcon = categoryIcon;
  res.locals.fileIcon = fileIcon;
  next();
}

function requireAuth(req, res, next) {
  if (!req.user) {
    flash(req, 'error', 'Please sign in to continue.');
    return res.redirect('/login');
  }
  next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return requireAuth(req, res, next);
    if (!roles.includes(req.user.role)) {
      flash(req, 'error', 'You do not have access to that page.');
      return res.redirect(roleHome(req.user.role));
    }
    next();
  };
}

module.exports = { flash, loadFlash, loadUser, requireAuth, requireRole };
