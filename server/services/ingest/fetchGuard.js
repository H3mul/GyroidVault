const dns = require('dns').promises;
const net = require('net');
const fs = require('fs');
const flare = require('./flaresolverr');

const UA = 'GyroidVault-Importer/1.0 (+https://github.com/TeeCodeDev/GyroidVault)';
class IngestError extends Error {
  // code: not_found | rate_limited | blocked | http | error (callers decide whether a failure is definitive)
  constructor(message, status = 422, code = 'error') { super(message); this.status = status; this.code = code; }
}

const MAX_REDIRECTS = 3;
const codeForHttp = st => (st === 404 || st === 410 ? 'not_found' : st === 429 ? 'rate_limited' : st === 403 || st === 503 ? 'blocked' : 'http');
/** A failed response as an IngestError; a Cloudflare challenge is named as bot protection, not a bare 403. */
const httpError = (res, prefix) => {
  const challenge = res.headers.get('cf-mitigated') === 'challenge';
  const e = challenge
    ? new IngestError("Blocked by the site's bot protection (Cloudflare challenge); automated access is not allowed from this network", 422, 'blocked')
    : new IngestError(`${prefix} HTTP ${res.status}`, 422, codeForHttp(res.status));
  e.httpStatus = res.status; e.challenge = challenge;
  return e;
};
const TIMEOUT_MS = 15000;

/** True only for globally routable unicast addresses. */
function isPublicIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT
    if (a === 169 && b === 254) return false;           // link-local / cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && (b === 168 || (b === 0 && ip.split('.')[2] === '0'))) return false;
    if (a === 198 && (b === 18 || b === 19)) return false;
    return true;
  }
  if (net.isIPv6(ip)) {
    const l = ip.toLowerCase();
    const mapped = l.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPublicIp(mapped[1]);
    if (l === '::' || l === '::1') return false;
    if (/^f[cd]/.test(l) || /^fe[89ab]/.test(l) || l.startsWith('ff')) return false;
    return true;
  }
  return false;
}

async function assertPublicUrl(urlString) {
  let u;
  try { u = new URL(urlString); } catch { throw new IngestError('Invalid URL', 400); }
  if (!['http:', 'https:'].includes(u.protocol)) throw new IngestError('Only http(s) URLs are supported', 400);
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true }).catch(() => []);
  if (!addrs.length) throw new IngestError('Host could not be resolved', 400);
  // ponytail: lookup-then-connect leaves a DNS-rebinding window; pin the IP via an undici dispatcher if needed
  if (!addrs.every(a => isPublicIp(a.address))) throw new IngestError('URL points to a non-public address', 400);
  return u;
}

/** fetch() that validates the target and every redirect hop, with timeout. Caller must consume the body. */
async function guardedFetch(url, opts = {}) {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertPublicUrl(current);
    const host = new URL(current).hostname.toLowerCase();
    const useFs = flare.enabled() && flare.hostAllowed(host);
    const send = clearance => fetch(current, {
      ...opts,
      redirect: 'manual',
      signal: AbortSignal.timeout(opts.timeoutMs || TIMEOUT_MS),
      // Honest by default; an operator can override for their own instance (INGEST_USER_AGENT).
      // A FlareSolverr clearance is bound to the browser's User-Agent, so that one is sent with its cookie.
      headers: {
        'user-agent': (clearance && clearance.ua) || process.env.INGEST_USER_AGENT || UA, accept: '*/*',
        ...(clearance && clearance.cookie ? { cookie: clearance.cookie } : {}), ...(opts.headers || {}),
      },
    });
    let res = await send(useFs ? flare.clearanceFor(host) : null);
    if (useFs && res.headers.get('cf-mitigated') === 'challenge') { // opt-in: pass the challenge once, then repeat the request
      await res.body?.cancel();
      let clearance;
      try { clearance = await flare.solve(current, host); } catch (e) { throw new IngestError(`Blocked by the site's bot protection and ${e.message}`, 422, 'blocked'); }
      res = await send(clearance);
      if (res.headers.get('cf-mitigated') === 'challenge') { // the clearance did not help: do not cache it, do not loop
        await res.body?.cancel(); flare.forget(host);
        throw new IngestError("Blocked by the site's bot protection; the clearance FlareSolverr obtained was not accepted", 422, 'blocked');
      }
    }
    if ([301, 302, 303, 307, 308].includes(res.status) && res.headers.get('location')) {
      await res.body?.cancel();
      const next = new URL(res.headers.get('location'), current);
      if (next.origin !== new URL(current).origin && opts.headers) {
        // never forward credentials to another origin
        opts = { ...opts, headers: Object.fromEntries(Object.entries(opts.headers).filter(([k]) => k.toLowerCase() !== 'authorization')) };
      }
      current = next.toString();
      continue;
    }
    return res;
  }
  throw new IngestError('Too many redirects', 422);
}

async function readCapped(res, maxBytes, onChunk) {
  const len = Number(res.headers.get('content-length'));
  if (len && len > maxBytes) { await res.body?.cancel(); throw new IngestError('Response too large', 422); }
  let total = 0;
  const chunks = [];
  for await (const chunk of res.body) {
    total += chunk.length;
    if (total > maxBytes) throw new IngestError('Response too large', 422);
    if (onChunk) await onChunk(chunk); else chunks.push(chunk);
  }
  return chunks.length ? Buffer.concat(chunks) : null;
}

/** GET a text page (HTML/JSON) with a size cap. */
async function fetchText(url, opts = {}) {
  const res = await guardedFetch(url, opts);
  if (!res.ok) { await res.body?.cancel(); throw httpError(res, 'Site answered'); }
  return (await readCapped(res, opts.maxBytes || 1.5 * 1024 * 1024)).toString('utf8');
}

/** Stream a file to disk with a size cap; deletes the partial file on failure. */
async function downloadToFile(url, dest, maxBytes, headers) {
  const res = await guardedFetch(url, { timeoutMs: 10 * 60 * 1000, headers });
  if (!res.ok) { await res.body?.cancel(); throw httpError(res, 'Download failed with'); }
  const out = fs.createWriteStream(dest);
  try {
    await readCapped(res, maxBytes, chunk => out.write(chunk) ? undefined : new Promise(r => out.once('drain', r)));
    await new Promise((ok, bad) => out.end(err => err ? bad(err) : ok()));
    return fs.statSync(dest).size;
  } catch (e) {
    out.destroy();
    fs.rmSync(dest, { force: true });
    throw e;
  }
}

module.exports = { codeForHttp, isPublicIp, assertPublicUrl, guardedFetch, fetchText, downloadToFile, IngestError, UA };
