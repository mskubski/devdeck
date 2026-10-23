import type { Connector } from './types.js';

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const API = 'https://api.github.com';

/** GitHub: Token-Gültigkeit, Repo-Zugriff, offene Issues/PRs. Feste API-Domain (kein SSRF-Vektor). */
export const githubConnector: Connector = {
  type: 'github',
  label: 'GitHub',
  fields: [{ key: 'repo', label: 'Repository', placeholder: 'owner/name' }],

  validateConfig(config) {
    const repo = typeof config.repo === 'string' ? config.repo.trim() : '';
    if (!REPO_RE.test(repo) || repo.split('/').some((part) => part === '.' || part === '..')) throw new Error('repo muss die Form "owner/name" haben');
    return { repo };
  },

  async check({ config, credential, fetch: doFetch }) {
    const headers = {
      Authorization: `Bearer ${credential}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'devdeck',
    };
    const call = async (path: string) => {
      try {
        return await doFetch(`${API}${path}`, { headers, signal: AbortSignal.timeout(10_000) });
      } catch {
        return null;
      }
    };

    const user = await call('/user');
    if (!user) return { ok: false, message: 'GitHub nicht erreichbar' };
    if (user.status === 401) return { ok: false, message: 'Token ungültig oder abgelaufen' };
    if (!user.ok) return { ok: false, message: `GitHub antwortete mit HTTP ${user.status}` };
    const login = ((await user.json().catch(() => ({}))) as { login?: string }).login ?? '?';

    const repoRes = await call(`/repos/${config.repo}`);
    if (!repoRes) return { ok: false, message: 'GitHub nicht erreichbar' };
    if (repoRes.status === 404) return { ok: false, message: `Repository ${config.repo} nicht gefunden oder kein Zugriff` };
    if (!repoRes.ok) return { ok: false, message: `Repository-Abfrage: HTTP ${repoRes.status}` };
    const repo = (await repoRes.json()) as {
      full_name: string;
      private: boolean;
      default_branch: string;
      open_issues_count: number;
      pushed_at: string | null;
      archived: boolean;
    };

    let openPrs: number | null = null;
    const pulls = await call(`/search/issues?q=${encodeURIComponent(`repo:${config.repo} is:pr is:open`)}&per_page=1`);
    if (pulls?.ok) openPrs = ((await pulls.json().catch(() => ({}))) as { total_count?: number }).total_count ?? null;

    return {
      ok: true,
      message: `Verbunden als ${login}: ${repo.full_name}${repo.archived ? ' (archiviert)' : ''}`,
      details: {
        login,
        private: repo.private,
        default_branch: repo.default_branch,
        open_items: repo.open_issues_count, // Issues + PRs
        open_pull_requests: openPrs,
        pushed_at: repo.pushed_at,
      },
    };
  },
};
