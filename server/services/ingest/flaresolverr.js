/**
 * Optional Cloudflare challenge solving through a FlareSolverr instance the operator runs (FLARESOLVERR_URL).
 *
 * FlareSolverr drives a real browser and cannot hand back binary bodies, so it is used only to obtain the
 * clearance cookie + matching User-Agent; the actual request is then repeated by guardedFetch with them.
 * Off unless configured, limited to an allowlist of hosts (default: the supported providers) so a crafted URL
 * can never make the operator's browser visit arbitrary sites, and clearances are cached per host.
 */
const DEFAULT_HOSTS = 'thingiverse.com,printables.com';
const FALLBACK_TTL_MS = 20 * 60 * 1000;

const baseUrl = () => (process.env.FLARESOLVERR_URL || '').trim().replace(/\/+$/, '');
const enabled = () => !!baseUrl();
const allowedHosts = () => (process.env.FLARESOLVERR_HOSTS || DEFAULT_HOSTS).split(',').map(h => h.trim().toLowerCase()).filter(Boolean);
const hostAllowed = host => allowedHosts().some(h => host === h || host.endsWith(`.${h}`));

const cache = new Map(); // hostname -> {cookie, ua, expires}

function clearanceFor(host) {
  const c = cache.get(host);
  if (c && c.expires > Date.now()) return c;
  cache.delete(host);
  return null;
}

/** Ask FlareSolverr to pass the challenge for `url`; returns {cookie, ua, expires} or throws {message}. */
async function solve(url, host) {
  const timeout = Number(process.env.FLARESOLVERR_TIMEOUT_MS) || 60000;
  let body;
  try {
    const res = await fetch(`${baseUrl()}/v1`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cmd: 'request.get', url, maxTimeout: timeout }),
      signal: AbortSignal.timeout(timeout + 15000),
    });
    body = await res.json();
  } catch (e) {
    throw new Error(`FlareSolverr is not reachable (${e.message})`);
  }
  const sol = body && body.solution;
  if (!body || body.status !== 'ok' || !sol) throw new Error(`FlareSolverr could not solve the challenge${body && body.message ? `: ${body.message}` : ''}`);
  const cookies = (sol.cookies || []).filter(c => c && c.name && c.value && (!c.domain || host === c.domain.replace(/^\./, '') || host.endsWith(`.${c.domain.replace(/^\./, '')}`)));
  if (!cookies.some(c => c.name === 'cf_clearance')) throw new Error('FlareSolverr did not obtain a Cloudflare clearance for this site');
  const exp = cookies.map(c => (c.expires > 0 ? c.expires * 1000 : 0)).filter(Boolean);
  const entry = {
    cookie: cookies.map(c => `${c.name}=${c.value}`).join('; '),
    ua: sol.userAgent || '',
    expires: exp.length ? Math.min(...exp) - 60000 : Date.now() + FALLBACK_TTL_MS,
  };
  if (entry.expires > Date.now()) cache.set(host, entry);
  return entry;
}

module.exports = { enabled, hostAllowed, clearanceFor, solve, _cache: cache };
