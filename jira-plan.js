try { process.loadEnvFile(); } catch (_e) {}

const BASE_URL = (process.env.JIRA_BASE_URL || '').replace(/\/$/, '');
const EMAIL = process.env.JIRA_EMAIL;
const TOKEN = process.env.JIRA_API_TOKEN;
const PROJECT_KEY = process.env.JIRA_PROJECT_KEY || 'DIG';
if (!BASE_URL || !EMAIL || !TOKEN) { console.error('Missing Jira env vars.'); process.exit(1); }
const auth = `Basic ${Buffer.from(`${EMAIL}:${TOKEN}`).toString('base64')}`;
const headers = { Authorization: auth, Accept: 'application/json', 'Content-Type': 'application/json' };

const DUE = {
  'stage-data-collection': '2026-11-16',
  'stage-design': '2026-11-20',
  'stage-implementation': '2026-11-25',
  'stage-testing': '2026-11-28',
  'stage-deployment': '2026-11-30'
};
const EXTRA = ['november-2026', 'project-plan', 'timeline'];

async function jira(path, options = {}) {
  const res = await fetch(`${BASE_URL}${path}`, { headers, ...options });
  const text = await res.text();
  if (!res.ok) throw new Error(`${path} -> ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}

(async () => {
  const data = await jira('/rest/api/3/search/jql', {
    method: 'POST',
    body: JSON.stringify({ jql: `project = ${PROJECT_KEY} ORDER BY key ASC`, maxResults: 100, fields: ['labels'] })
  });
  const issues = data.issues || data.values || [];
  for (const issue of issues) {
    const labels = issue.fields?.labels || [];
    const stage = labels.find((l) => DUE[l]);
    if (!stage) continue;
    const nextLabels = [...new Set([...labels, ...EXTRA])];
    await jira(`/rest/api/3/issue/${issue.key}`, {
      method: 'PUT',
      body: JSON.stringify({ fields: { duedate: DUE[stage], labels: nextLabels } })
    });
    console.log(`${issue.key} -> due ${DUE[stage]} [${stage}]`);
  }
  console.log('Done.');
})().catch((e) => { console.error(e.message || e); process.exit(1); });
