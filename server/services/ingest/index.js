const printables = require('./providers/printables');
const thingiverse = require('./providers/thingiverse');
const generic = require('./providers/generic');
const { normalize } = require('./sanitize');
const { IngestError, assertPublicUrl } = require('./fetchGuard');

const PROVIDERS = [printables, thingiverse];

/** Host label used in the origin tag, e.g. "printables" or "example.com". */
function siteOf(provider, url) {
  return provider.id !== 'generic' ? provider.id : new URL(url).hostname.replace(/^www\./, '').toLowerCase();
}

function resolveProvider(url) {
  let u;
  try { u = new URL(url); } catch { throw new IngestError('Invalid URL', 400); }
  if (!['http:', 'https:'].includes(u.protocol)) throw new IngestError('Only http(s) URLs are supported', 400);
  return PROVIDERS.find(p => p.matches(u.hostname.toLowerCase())) || generic;
}

/**
 * Fetch and normalize metadata for a model page URL.
 * Returns the public shape plus a non-enumerable `_raw` (provider-private data needed to resolve files later).
 */
async function preview(url) {
  url = String(url || '').trim();
  const provider = resolveProvider(url);
  await assertPublicUrl(url);
  let raw;
  try {
    raw = await provider.fetchMeta(url);
  } catch (e) {
    if (provider === generic || e.status === 400 || e.code === 'not_found' || e.code === 'rate_limited') throw e;
    // dedicated provider failed: try plain page metadata, but report the provider's (more specific) error if that fails too
    raw = await generic.fetchMeta(url).catch(() => { throw e; });
    raw.files = [];
  }
  const site = siteOf(provider, url);
  const out = normalize(raw);
  if (!out.title) throw new IngestError('Could not read a title from that page');
  out.site = site;
  out.tags = [...new Set([`source:${site}`, ...out.tags])];
  out.filesNeedToken = !!raw._needsToken;
  Object.defineProperty(out, '_raw', { value: raw });
  Object.defineProperty(out, '_provider', { value: provider });
  return out;
}

module.exports = { preview, resolveProvider };
