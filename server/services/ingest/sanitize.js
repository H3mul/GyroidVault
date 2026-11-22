const { safeUrl } = require('../../middleware/security');

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : '';
    }
    return ENT[e.toLowerCase()] ?? m;
  });
}

/** HTML to plain text: paragraph/line breaks kept, tags and entities removed. */
function htmlToText(html, max) {
  const t = decodeEntities(String(html || '')
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>|<\/(p|div|li|h\d)>/gi, '\n')
    .replace(/<[^>]*>/g, ''))
    .replace(/[ \t\f\v]+/g, ' ').replace(/ ?\n ?/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return t.slice(0, max);
}

function cleanTags(tags, max = 15) {
  const out = [];
  for (const t of tags || []) {
    const c = htmlToText(typeof t === 'string' ? t : t?.name, 40).toLowerCase().replace(/\s+/g, ' ');
    if (c && !out.includes(c)) out.push(c);
    if (out.length >= max) break;
  }
  return out;
}

/** Drop tracking params, fragment and trailing slash so the same page always yields the same URL. */
function canonicalUrl(u) {
  try {
    const p = new URL(u);
    for (const k of [...p.searchParams.keys()]) if (/^(utm_|fbclid|gclid|ref$|source$)/i.test(k)) p.searchParams.delete(k);
    p.hash = '';
    return safeUrl(p.toString().replace(/\/$/, ''));
  } catch { return ''; }
}

/** Final shape returned to clients: bounded, plain text, safe URLs. */
function normalize(m) {
  return {
    title: htmlToText(m.title, 200).replace(/\n+/g, ' '),
    description: htmlToText(m.description, 5000),
    url: canonicalUrl(m.url),
    tags: cleanTags(m.tags),
    coverUrl: /^https:\/\//.test(m.coverUrl || '') ? m.coverUrl : '',
    files: (m.files || []).slice(0, 50).map(f => ({ id: String(f.id), name: String(f.name).replace(/[/\\]/g, '_').slice(0, 200), size: Number(f.size) || 0 })),
  };
}

module.exports = { htmlToText, cleanTags, canonicalUrl, normalize, decodeEntities };
