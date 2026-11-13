const BASE_URL = (process.env.JIRA_BASE_URL || '').replace(/\/$/, '');
const EMAIL = process.env.JIRA_EMAIL;
const TOKEN = process.env.JIRA_API_TOKEN;
const PROJECT_KEY = process.env.JIRA_PROJECT_KEY || 'KAN';

if (!BASE_URL || !EMAIL || !TOKEN) {
  console.error('Missing Jira credentials. Set JIRA_BASE_URL, JIRA_EMAIL, and JIRA_API_TOKEN in .env.');
  process.exit(1);
}

const auth = `Basic ${Buffer.from(`${EMAIL}:${TOKEN}`).toString('base64')}`;

const EPICS = [
  ['Authentication & Role Management', ['User registration', 'Login/logout', 'Role guards', 'Ban protection', 'Session handling']],
  ['Product & File Management', ['Product create', 'Product edit', 'Product delete', 'File upload validation', 'Pending status flow']],
  ['Admin Approval & Moderation', ['Approve products', 'Remove products', 'Ban/unban users', 'Delete user accounts', 'Admin dashboard metrics']],
  ['Buyer Marketplace', ['Product browse', 'Search/filter', 'Product detail page', 'Sales count display', 'Rating summary']],
  ['Coupons & Promotions', ['Global coupon', 'Creator coupon', 'Discount calculation', 'Coupon validation', 'Coupon admin controls']],
  ['Checkout & Payments', ['Stripe checkout', 'ABA PayWay', 'Demo card QR', 'Manual cash approval', 'Payment status polling']],
  ['Library & Downloads', ['Purchase history', 'Secure download links', 'Download authorization', 'Order completion flow', 'Library UI']],
  ['Reviews & Ratings', ['Star rating input', 'Review submit', 'Review update', 'Purchase-only rule', 'Review display']],
  ['Creator Dashboard', ['Sales metrics', 'Earnings summary', 'Product management', 'Coupon management', 'Pending product tracking']],
  ['Deployment & Presentation', ['GitHub repository', 'Run instructions', 'Demo accounts', 'Presentation script', 'Reset/demo data steps']]
];

const STAGES = ['data-collection', 'design', 'implementation', 'testing', 'deployment'];
let taskCounter = 0;

async function createIssue(fields) {
  const response = await fetch(`${BASE_URL}/rest/api/3/issue`, {
    method: 'POST',
    headers: {
      Authorization: auth,
      'Content-Type': 'application/json',
      Accept: 'application/json'
    },
    body: JSON.stringify({ fields })
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Jira ${response.status}: ${text}`);
  return JSON.parse(text);
}

(async () => {
  for (let epicIndex = 0; epicIndex < EPICS.length; epicIndex += 1) {
    const [title, tasks] = EPICS[epicIndex];
    const moduleNumber = epicIndex + 1;
    const epic = await createIssue({
      project: { key: PROJECT_KEY },
      issuetype: { name: 'Epic' },
      summary: `Module ${moduleNumber}: ${title}`,
      labels: [`module-${moduleNumber}`]
    });
    console.log(`Epic ${epic.key}: ${title}`);

    for (const task of tasks) {
      const stage = STAGES[taskCounter % STAGES.length];
      taskCounter += 1;
      const issue = await createIssue({
        project: { key: PROJECT_KEY },
        issuetype: { name: 'Task' },
        summary: `${title}: ${task}`,
        labels: [`module-${moduleNumber}`, `stage-${stage}`]
      });
      console.log(`  Task ${issue.key}: ${task} [${stage}]`);
    }
  }
  console.log('Done. Move tasks into the Data Collection / Design / Implementation / Testing / Deployment columns on the board.');
})().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
