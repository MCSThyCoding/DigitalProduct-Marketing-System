const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { zipSync, strToU8 } = require('fflate');
const { db } = require('./db');

const UPLOAD_DIR = path.join(__dirname, 'storage', 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

function escapePdfText(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

function makePdf(title, lines = []) {
  const contentLines = [title, '', ...lines];
  let stream = 'BT /F1 22 Tf 56 760 Td\n';
  contentLines.forEach((line, index) => {
    const size = index === 0 ? 22 : 12;
    const y = 760 - index * 28;
    stream += `/${index === 0 ? 'F1' : 'F1'} ${size} Tf 56 ${y} Td (${escapePdfText(line)}) Tj\n`;
  });
  stream += 'ET';

  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  ];

  let pdf = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });

  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  offsets.forEach((offset) => {
    pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  });
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'utf8');
}

function makeZip(entries) {
  return Buffer.from(zipSync(entries));
}

function writeSeedFile(filename, content, extension) {
  const storedName = `${crypto.randomUUID()}${extension}`;
  fs.writeFileSync(path.join(UPLOAD_DIR, storedName), content);
  return {
    filePath: path.join('storage', 'uploads', storedName),
    storedName,
    size: content.length
  };
}

function insertUser({ name, email, password, role }) {
  const result = db.prepare(`
    INSERT INTO users (name, email, password_hash, role, status)
    VALUES (?, ?, ?, ?, 'active')
  `).run(name, email.toLowerCase(), bcrypt.hashSync(password, 10), role);
  return Number(result.lastInsertRowid);
}

function insertProduct({ creatorId, title, description, priceCents, category, file, status }) {
  const result = db.prepare(`
    INSERT INTO products
      (creator_id, title, description, price_cents, category, file_path, original_filename, file_size, mime_type, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    creatorId,
    title,
    description,
    priceCents,
    category,
    file.filePath,
    file.originalName,
    file.size,
    file.mimeType || null,
    status
  );
  return Number(result.lastInsertRowid);
}

function insertOrder({ orderNumber, buyerId, couponCode = null, items, discountCents = 0 }) {
  const subtotal = items.reduce((sum, item) => sum + item.priceCents, 0);
  const order = db.prepare(`
    INSERT INTO orders
      (order_number, buyer_id, coupon_code, subtotal_cents, discount_cents, total_cents, status)
    VALUES (?, ?, ?, ?, ?, ?, 'completed')
  `).run(orderNumber, buyerId, couponCode, subtotal, discountCents, subtotal - discountCents);
  const orderId = Number(order.lastInsertRowid);

  const itemStmt = db.prepare(`
    INSERT INTO order_items
      (order_id, product_id, product_title, creator_id, price_cents, file_path, original_filename, file_size)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const item of items) {
    itemStmt.run(
      orderId,
      item.productId,
      item.productTitle,
      item.creatorId,
      item.priceCents,
      item.filePath || item.file_path,
      item.originalFilename || item.originalName || item.original_filename,
      item.fileSize ?? item.size ?? item.file_size ?? 0
    );
  }
  return orderId;
}

function seedIfEmpty() {
  const userCount = db.prepare('SELECT COUNT(*) AS count FROM users').get().count;
  if (Number(userCount) > 0) return false;

  const adminId = insertUser({ name: 'Admin', email: 'admin@demo.com', password: 'admin123', role: 'admin' });
  const creatorAId = insertUser({ name: 'Creator A', email: 'creator@demo.com', password: 'creator123', role: 'creator' });
  const creatorBId = insertUser({ name: 'Creator B', email: 'creator.b@demo.com', password: 'creator123', role: 'creator' });
  const creatorCId = insertUser({ name: 'Creator C', email: 'creator.c@demo.com', password: 'creator123', role: 'creator' });
  const buyerId = insertUser({ name: 'Demo Buyer', email: 'buyer@demo.com', password: 'buyer123', role: 'buyer' });
  const buyer2Id = insertUser({ name: 'Alex Buyer', email: 'buyer.two@demo.com', password: 'password123', role: 'buyer' });
  const buyer3Id = insertUser({ name: 'Sam Buyer', email: 'buyer.three@demo.com', password: 'password123', role: 'buyer' });

  const pitchDeck = {
    originalName: 'startup-pitch-deck.pdf',
    mimeType: 'application/pdf',
    ...writeSeedFile('startup-pitch-deck.pdf', makePdf('Startup Pitch Deck', [
      'Editable pitch deck template',
      'Problem, solution, traction, and ask slides',
      'Replace the sample text with your startup story.'
    ]), '.pdf')
  };

  const reactStarter = {
    originalName: 'react-admin-starter.zip',
    mimeType: 'application/zip',
    ...writeSeedFile('react-admin-starter.zip', makeZip({
      'README.md': strToU8('# React Admin Starter\n\nA demo starter kit for admin dashboards.\n'),
      'src/App.jsx': strToU8('export default function App() {\n  return <main>React Admin Starter</main>;\n}\n'),
      'src/styles.css': strToU8('body { font-family: system-ui, sans-serif; }\n')
    }), '.zip')
  };

  const sqlEbook = {
    originalName: 'intro-to-sql.pdf',
    mimeType: 'application/pdf',
    ...writeSeedFile('intro-to-sql.pdf', makePdf('Intro to SQL', [
      'SELECT, JOIN, GROUP BY, and practical query patterns',
      'A short beginner-friendly ebook sample.'
    ]), '.pdf')
  };

  const swipeFile = {
    originalName: 'marketing-swipe-file.pdf',
    mimeType: 'application/pdf',
    ...writeSeedFile('marketing-swipe-file.pdf', makePdf('Marketing Swipe File', [
      'Headline formulas, email hooks, and CTA examples',
      'Use these examples to improve product launches.'
    ]), '.pdf')
  };

  const budgetTracker = {
    originalName: 'budget-tracker-template.xlsx.txt',
    mimeType: 'text/plain',
    ...writeSeedFile('budget-tracker-template.txt', Buffer.from('Budget Tracker Template\nMonthly income, expenses, savings, and notes.\n'), '.txt')
  };

  const pitchDeckId = insertProduct({
    creatorId: creatorAId,
    title: 'Startup Pitch Deck',
    description: 'A clean startup pitch deck with editable slide copy for problem, solution, traction, and funding ask.',
    priceCents: 900,
    category: 'Templates',
    file: pitchDeck,
    status: 'live'
  });

  const reactStarterId = insertProduct({
    creatorId: creatorBId,
    title: 'React Admin Starter',
    description: 'A lightweight React starter with dashboard layout, reusable table and form components, and a setup guide.',
    priceCents: 1900,
    category: 'Code',
    file: reactStarter,
    status: 'live'
  });

  const sqlEbookId = insertProduct({
    creatorId: creatorCId,
    title: 'Intro to SQL E-book',
    description: 'A beginner ebook covering SELECT queries, joins, grouping, filtering, and common SQL patterns.',
    priceCents: 1200,
    category: 'E-books',
    file: sqlEbook,
    status: 'live'
  });

  const swipeFileId = insertProduct({
    creatorId: creatorBId,
    title: 'Marketing Swipe File',
    description: 'A collection of headline formulas, email hooks, social posts, and call-to-action examples.',
    priceCents: 700,
    category: 'Business',
    file: swipeFile,
    status: 'live'
  });

  const budgetTrackerId = insertProduct({
    creatorId: creatorAId,
    title: 'Budget Tracker Template',
    description: 'A simple budget planner template for tracking monthly income, expenses, savings, and notes.',
    priceCents: 500,
    category: 'Templates',
    file: budgetTracker,
    status: 'pending'
  });

  db.prepare(`INSERT INTO coupons (code, percent_off, creator_id, active) VALUES ('DISCOUNT20', 20, NULL, 1)`).run();
  db.prepare(`INSERT INTO coupons (code, percent_off, creator_id, active) VALUES ('CREATOR10', 10, ?, 1)`).run(creatorAId);

  insertOrder({
    orderNumber: 1001,
    buyerId: buyer2Id,
    items: [{ productId: reactStarterId, productTitle: 'React Admin Starter', creatorId: creatorBId, priceCents: 1900, ...reactStarter }]
  });
  insertOrder({
    orderNumber: 1002,
    buyerId: buyer3Id,
    items: [{ productId: sqlEbookId, productTitle: 'Intro to SQL E-book', creatorId: creatorCId, priceCents: 1200, ...sqlEbook }]
  });
  insertOrder({
    orderNumber: 1003,
    buyerId: buyerId,
    items: [{ productId: swipeFileId, productTitle: 'Marketing Swipe File', creatorId: creatorBId, priceCents: 700, ...swipeFile }]
  });
  insertOrder({
    orderNumber: 1004,
    buyerId: buyer2Id,
    couponCode: 'DISCOUNT20',
    discountCents: 180,
    items: [{ productId: pitchDeckId, productTitle: 'Startup Pitch Deck', creatorId: creatorAId, priceCents: 900, ...pitchDeck }]
  });

  db.prepare(`INSERT INTO reviews (product_id, user_id, rating, comment) VALUES (?, ?, 5, 'Clean structure, easy to start.')`).run(reactStarterId, buyer2Id);
  db.prepare(`INSERT INTO reviews (product_id, user_id, rating, comment) VALUES (?, ?, 4, 'Great for beginners. I wish it had more exercises.')`).run(sqlEbookId, buyer3Id);
  db.prepare(`INSERT INTO reviews (product_id, user_id, rating, comment) VALUES (?, ?, 5, 'The swipe file saved me hours of writing.')`).run(swipeFileId, buyerId);

  return true;
}

module.exports = { seedIfEmpty };
