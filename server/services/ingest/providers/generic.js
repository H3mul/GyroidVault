const { fetchText, IngestError } = require('../fetchGuard');
const { htmlToText, decodeEntities } = require('../sanitize');

function meta(html, key) {
  const re = new RegExp(`<meta[^>]+(?:property|name)=["']${key}["'][^>]*>`, 'i');
  const tag = html.match(re)?.[0];
  const c = tag?.match(/content=(?:"([^"]*)"|'([^']*)')/i);
  return c ? decodeEntities(c[1] ?? c[2]) : '';
}

function jsonLd(html) {
  for (const m of html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const j = JSON.parse(m[1]);
      const hit = [].concat(j, j['@graph'] || []).find(x => x && x.name);
      if (hit) return hit;
    } catch { /* ignore broken block */ }
  }
  return null;
}

/** Title/description/cover/tags from JSON-LD, OpenGraph, then <title>. Exported for reuse by provider tests. */
function parseHtml(html, url) {
  const ld = jsonLd(html) || {};
  const img = [].concat(ld.image || [])[0];
  const kw = meta(html, 'keywords');
  return {
    title: ld.name || meta(html, 'og:title') || htmlToText(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '', 200),
    description: ld.description || meta(html, 'og:description') || meta(html, 'description'),
    url: meta(html, 'og:url') || url,
    coverUrl: (typeof img === 'string' ? img : img?.url) || meta(html, 'og:image'),
    tags: Array.isArray(ld.keywords) ? ld.keywords : String(ld.keywords || kw || '').split(',').filter(Boolean),
  };
}

module.exports = {
  id: 'generic',
  matches: () => true,
  parseHtml,
  async fetchMeta(url) {
    const m = parseHtml(await fetchText(url), url);
    if (!m.title) throw new IngestError('Could not read a title from that page (the site may block automated access)');
    m.url = url; // never trust a page-declared URL over what the user submitted for provenance
    return m;
  },
};
