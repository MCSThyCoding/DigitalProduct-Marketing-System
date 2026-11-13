const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const multer = require('multer');

const UPLOAD_DIR = path.join(__dirname, 'storage', 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const ALLOWED_EXTENSIONS = new Set([
  '.pdf', '.zip', '.txt', '.md', '.csv', '.json', '.doc', '.docx',
  '.ppt', '.pptx', '.xls', '.xlsx', '.fig', '.sketch', '.ai',
  '.js', '.jsx', '.ts', '.tsx', '.html', '.css'
]);

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const extension = path.extname(file.originalname || '').toLowerCase();
    cb(null, `${crypto.randomUUID()}${extension}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 25 * 1024 * 1024 }
});

function removeUploadedFile(file) {
  if (!file || !file.path) return;
  fs.promises.unlink(file.path).catch(() => {});
}

function validateUploadedFile(req, _res, next) {
  if (!req.file) return next();
  const extension = path.extname(req.file.originalname || '').toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(extension)) {
    removeUploadedFile(req.file);
    req.fileValidationError = `File type ${extension || '(none)'} is not supported.`;
    req.file = undefined;
  }
  next();
}

module.exports = { upload, validateUploadedFile, removeUploadedFile, UPLOAD_DIR, ALLOWED_EXTENSIONS };
