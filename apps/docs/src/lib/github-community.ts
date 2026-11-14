/** Public GitHub data only; neither endpoint requires a browser credential. */
const repository = '/repos/morshoto/framekit';
const ttl = 60 * 60 * 1000;
const loginPattern = /^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i;
export interface Contributor { login: string; profile: string; avatar: string; bot: boolean }

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
function githubUrl(value: unknown, host: string): value is string {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === host && !url.username && !url.password && !url.port;
  } catch { return false; }
}
async function request(path: string, signal?: AbortSignal): Promise<unknown> {
  if (signal?.aborted) throw new Error('Request cancelled');
  const key = `framekit-community-v1:${path}`;
  try {
    const cached: unknown = JSON.parse(sessionStorage.getItem(key) || 'null');
    if (record(cached) && typeof cached.time === 'number' && Date.now() >= cached.time && Date.now() - cached.time < ttl) return cached.data;
  } catch { /* Storage is optional, including in private browsing. */ }
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let cancel = () => {};
  try {
    const interrupted = new Promise<never>((_, reject) => {
      cancel = () => { controller.abort(); reject(new Error('Request cancelled')); };
      timeout = setTimeout(() => { controller.abort(); reject(new Error('GitHub request timed out')); }, 8000);
      signal?.addEventListener('abort', cancel, { once: true });
    });
    const data = await Promise.race([
      fetch(`https://api.github.com${path}`, { headers: { Accept: 'application/vnd.github+json' }, signal: controller.signal })
        .then(async response => {
          if (!response.ok) throw new Error(`GitHub returned ${response.status}`);
          return response.json() as Promise<unknown>;
        }),
      interrupted,
    ]);
    try { sessionStorage.setItem(key, JSON.stringify({ time: Date.now(), data })); } catch { /* Optional cache. */ }
    return data;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', cancel);
  }
}
export async function loadContributors(signal?: AbortSignal): Promise<Contributor[]> {
  const data = await request(`${repository}/contributors?per_page=100`, signal);
  if (!Array.isArray(data)) throw new Error('Invalid GitHub contributor response');
  const contributors: Contributor[] = [];
  for (const item of data) {
    if (!record(item) || !['User', 'Bot'].includes(String(item.type)) || typeof item.login !== 'string') continue;
    const login = item.login.replace(/\[bot\]$/, '');
    if (!loginPattern.test(login) || !githubUrl(item.html_url, 'github.com') || !githubUrl(item.avatar_url, 'avatars.githubusercontent.com')) continue;
    if (contributors.some(person => person.login === item.login)) continue;
    contributors.push({ login: item.login, profile: item.html_url, avatar: item.avatar_url, bot: item.type === 'Bot' });
  }
  return contributors.slice(0, 24);
}
export async function loadFunding(signal?: AbortSignal): Promise<string[]> {
  const data = await request(`${repository}/contents/.github/FUNDING.yml`, signal);
  if (!record(data) || data.encoding !== 'base64' || typeof data.content !== 'string' || data.content.length > 16384) throw new Error('Invalid GitHub funding response');
  const text = atob(data.content.replace(/\s/g, ''));
  const lines = text.split(/\r?\n/);
  const index = lines.findIndex(line => /^github\s*:/.test(line));
  if (index < 0) return [];
  let value = lines[index].replace(/^github\s*:/, '').split('#')[0].trim();
  if (!value) {
    const items: string[] = [];
    for (const line of lines.slice(index + 1)) {
      if (!line.trim() || line.trimStart().startsWith('#')) continue;
      const item = line.match(/^\s*-\s+(.+)$/);
      if (!item) break;
      items.push(item[1].split('#')[0].trim());
    }
    value = items.join(',');
  }
  if (/^(?:null|~)$/i.test(value)) return [];
  return [...new Set(value.replace(/^\[|\]$/g, '').split(',').map(item => item.trim().replace(/^(['"])(.*)\1$/, '$2')).filter(item => loginPattern.test(item)))].slice(0, 10);
}
