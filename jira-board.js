try { process.loadEnvFile(); } catch (_e) {}

const BASE_URL = (process.env.JIRA_BASE_URL || '').replace(/\/$/, '');
const EMAIL = process.env.JIRA_EMAIL;
const TOKEN = process.env.JIRA_API_TOKEN;
const PROJECT_KEY = process.env.JIRA_PROJECT_KEY || 'DIG';
if (!BASE_URL || !EMAIL || !TOKEN) { console.error('Missing Jira env vars.'); process.exit(1); }
const auth = `Basic ${Buffer.from(`${EMAIL}:${TOKEN}`).toString('base64')}`;
const headers = { Authorization: auth, Accept: 'application/json', 'Content-Type': 'application/json' };

const PER_STATUS = 5;
const STAGE_TO_TRANSITION = {
  'stage-data-collection': '31',
  'stage-design': '2',
  'stage-implementation': '3',
  'stage-testing': '4'
};

async function jira(path, options = {}) {
  const res = await fetch(`${BASE_URL}${path}`, { headers, ...options });
  const text = await res.text();
  if (!res.ok) throw new Error(`${path} -> ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}

const keyNum = (k) => Number(String(k).split('-')[1]);

(async () => {
  const data = await jira('/rest/api/3/search/jql', {
    method: 'POST',
    body: JSON.stringify({ jql: `project = ${PROJECT_KEY} ORDER BY key ASC`, maxResults: 100, fields: ['labels', 'status'] })
  });
  const issues = data.issues || data.values || [];

  for (const [stage, transitionId] of Object.entries(STAGE_TO_TRANSITION)) {
    const matches = issues
      .filter((i) => (i.fields.labels || []).includes(stage))
      .sort((a, b) => keyNum(a.key) - keyNum(b.key))
      .slice(0, PER_STATUS);

    for (const issue of matches) {
      await jira(`/rest/api/3/issue/${issue.key}/transitions`, {
        method: 'POST',
        body: JSON.stringify({ transition: { id: transitionId } })
      });
      console.log(`${issue.key} -> ${stage}`);
    }
    console.log(`${stage}: moved ${matches.length} task(s)`);
  }
  console.log('Done.');
})().catch((e) => { console.error(e.message || e); process.exit(1); });
