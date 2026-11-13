const CATEGORIES = ['E-books', 'Templates', 'Code', 'Design', 'Business', 'Other'];

function formatMoney(cents) {
  return `$${(Number(cents || 0) / 100).toFixed(2)}`;
}

function formatDate(value) {
  if (!value) return '';
  const date = new Date(`${String(value).replace(' ', 'T')}Z`);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function parseMoneyToCents(value) {
  const normalized = String(value || '').replace(/[$,\s]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(normalized)) return null;
  return Math.round(Number(normalized) * 100);
}

function categoryIcon(category) {
  if (category === 'E-books') return '📘';
  if (category === 'Templates') return '🧩';
  if (category === 'Code') return '💻';
  return '📦';
}

function fileIcon(filename = '') {
  const ext = filename.split('.').pop().toLowerCase();
  if (ext === 'pdf') return '📕';
  if (ext === 'zip' || ext === 'rar' || ext === '7z') return '🗜️';
  if (['js', 'ts', 'jsx', 'tsx', 'py', 'java', 'cpp', 'c'].includes(ext)) return '💻';
  if (['ppt', 'pptx', 'key'].includes(ext)) return '📽️';
  return '📄';
}

function roleHome(role) {
  if (role === 'admin') return '/admin';
  if (role === 'creator') return '/creator';
  return '/products';
}

module.exports = {
  CATEGORIES,
  formatMoney,
  formatDate,
  parseMoneyToCents,
  categoryIcon,
  fileIcon,
  roleHome
};
