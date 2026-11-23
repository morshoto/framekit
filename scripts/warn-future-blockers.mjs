import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const marker = '<!-- framekit-future-blocker-warning -->';
const resolved = `${marker}\n**Resolved:** No later-release milestone blockers are currently detected.`;
const version = title => {
  const match = /^Release for v(\d+)\.(\d+)\.(\d+)$/.exec(title ?? '');
  return match ? match.slice(1).map(BigInt) : null;
};
export function futureBlockers(issue, blockers) {
  const target = version(issue.milestone?.title);
  if (!target) return [];
  return blockers.filter(blocker => {
    const candidate = version(blocker.milestone?.title);
    if (!candidate) return false;
    for (let i = 0; i < 3; i++) {
      if (candidate[i] !== target[i]) return candidate[i] > target[i];
    }
    return false;
  }).sort((a, b) => a.url.localeCompare(b.url));
}
export async function syncWarning(api, issue, blockers) {
  const later = futureBlockers(issue, blockers);
  const comments = await api.listComments(issue.number);
  const existing = comments.find(comment => comment.user?.login === 'github-actions[bot]' && comment.body?.includes(marker));
  const body = later.length ? `${marker}\n⚠️ **Future milestone blockers**\n\nThis issue is in **${issue.milestone.title}**, but it is blocked by later release work:\n\n${later.map(item => `- ${item.url} — ${item.milestone.title}`).join('\n')}\n\nPlease review the dependency or milestone: a release normally depends on work in the same or an earlier milestone.` : resolved;
  if (!existing && later.length) await api.createComment(issue.number, body);
  else if (existing && existing.body !== body) await api.updateComment(existing.id, body);
}

export function createApi({ repository, token, apiUrl = 'https://api.github.com', fetchImpl = fetch }) {
  if (!/^[^/]+\/[^/]+$/.test(repository ?? '') || !token) throw new Error('Repository and token are required');
  const [owner, name] = repository.split('/');
  const root = apiUrl.replace(/\/$/, '');
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'X-GitHub-Api-Version': '2022-11-28' };
  async function request(path, method = 'GET', body) {
    const response = await fetchImpl(`${root}${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (!response.ok) throw new Error(`GitHub API ${method} ${path.split('?')[0]} failed: ${response.status}`);
    return response.json();
  }
  async function graph(query, variables) {
    const result = await request('/graphql', 'POST', { query, variables: { owner, name, ...variables } });
    if (result.errors?.length) throw new Error(`GitHub GraphQL: ${result.errors.map(e => e.message).join('; ')}`);
    return result.data;
  }
  async function connection(query, key, variables = {}) {
    let cursor = null;
    const nodes = [];
    do {
      const data = await graph(query, { ...variables, cursor });
      const page = key(data);
      if (!page) throw new Error('GitHub GraphQL connection missing');
      nodes.push(...page.nodes);
      cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
      if (page.pageInfo.hasNextPage && !cursor) throw new Error('GitHub pagination cursor missing');
    } while (cursor);
    return nodes;
  }
  const issueFields = 'number url state milestone { title } repository { nameWithOwner }';
  const pageFields = 'pageInfo { hasNextPage endCursor }';
  const relation = field => `query($owner:String!, $name:String!, $number:Int!, $cursor:String) { repository(owner:$owner,name:$name) { issue(number:$number) { ${field}(first:100,after:$cursor) { nodes { ${issueFields} } ${pageFields} } } } }`;
  return {
    async issue(number) { const data = await graph(`query($owner:String!, $name:String!, $number:Int!) { repository(owner:$owner,name:$name) { issue(number:$number) { ${issueFields} } } }`, { number }); if (!data.repository?.issue) throw new Error(`Issue #${number} not found`); return data.repository.issue; },
    blockers: number => connection(relation('blockedBy'), d => d.repository?.issue?.blockedBy, { number }),
    blocking: number => connection(relation('blocking'), d => d.repository?.issue?.blocking, { number }),
    issues: () => connection(`query($owner:String!, $name:String!, $cursor:String) { repository(owner:$owner,name:$name) { issues(first:100,after:$cursor,states:OPEN) { nodes { ${issueFields} } ${pageFields} } } }`, d => d.repository?.issues),
    async listComments(number) {
      const comments = [];
      for (let page = 1; ; page++) {
        const items = await request(`/repos/${repository}/issues/${number}/comments?per_page=100&page=${page}`);
        comments.push(...items);
        if (items.length < 100) return comments;
      }
    },
    createComment: (number, body) => request(`/repos/${repository}/issues/${number}/comments`, 'POST', { body }),
    updateComment: (id, body) => request(`/repos/${repository}/issues/comments/${id}`, 'PATCH', { body }),
  };
}
export async function reconcile(api, repository, eventName, event) {
  let issues;
  if (eventName === 'issues') {
    if (event.issue?.pull_request) return;
    const issue = await api.issue(event.issue.number);
    const affected = await api.blocking(issue.number);
    issues = [issue, ...affected.filter(item => item.repository.nameWithOwner === repository && item.state === 'OPEN')];
  } else issues = await api.issues();
  for (const issue of new Map(issues.map(item => [item.number, item])).values()) {
    await syncWarning(api, issue, await api.blockers(issue.number));
  }
}
async function main() {
  const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const repository = process.env.GITHUB_REPOSITORY;
  const api = createApi({ repository, token: process.env.GITHUB_TOKEN, apiUrl: process.env.GITHUB_API_URL });
  await reconcile(api, repository, process.env.GITHUB_EVENT_NAME, event);
}
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
