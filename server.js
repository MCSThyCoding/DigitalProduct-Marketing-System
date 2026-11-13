try {
  process.loadEnvFile();
} catch (_error) {
  // .env is optional for local demo mode.
}

const path = require('path');
const express = require('express');
const session = require('express-session');
const { seedIfEmpty } = require('./seed');
const { loadFlash, loadUser, flash } = require('./middleware');

const authRoutes = require('./routes/auth');
const productRoutes = require('./routes/products');
const libraryRoutes = require('./routes/library');
const creatorRoutes = require('./routes/creator');
const adminRoutes = require('./routes/admin');
const paymentRoutes = require('./routes/payments');

seedIfEmpty();

const app = express();
const PORT = Number(process.env.PORT || 3000);

app.disable('x-powered-by');
app.set('trust proxy', 1);
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.urlencoded({ extended: true }));
app.use(express.json({
  verify: (req, _res, buf) => {
    req.rawBody = buf;
  }
}));
app.use(session({
  name: 'connect.sid',
  secret: process.env.SESSION_SECRET || 'digital-products-marketplace-dev-secret',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 1000 * 60 * 60 * 8
  }
}));
app.use(loadFlash);
app.use(loadUser);
app.use(express.static(path.join(__dirname, 'public')));

app.use('/', authRoutes);
app.use('/', productRoutes);
app.use('/', libraryRoutes);
app.use('/', creatorRoutes);
app.use('/', adminRoutes);
app.use('/', paymentRoutes);

app.use((req, res) => {
  res.status(404).render('error', {
    title: 'Page Not Found',
    message: 'The page you requested does not exist.'
  });
});

app.use((err, req, res, next) => {
  if (err && (err.code === 'LIMIT_FILE_SIZE' || err.name === 'MulterError')) {
    flash(req, 'error', 'Upload failed. Files must be 25 MB or smaller.');
    return res.redirect('/creator');
  }

  console.error(err);
  res.status(500).render('error', {
    title: 'Something Went Wrong',
    message: 'The server encountered an unexpected error. Please try again.'
  });
});

app.listen(PORT, () => {
  console.log(`Digital Products Marketplace running at http://localhost:${PORT}`);
});
