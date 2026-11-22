const generic = require('./generic');
const { fetchText, IngestError } = require('../fetchGuard');

const API = 'https://api.thingiverse.com';
const token = () => process.env.THINGIVERSE_TOKEN || '';
const authHeaders = () => ({ authorization: `Bearer ${token()}` });

module.exports = {
  id: 'thingiverse',
  matches: host => /(^|\.)thingiverse\.com$/.test(host),
  hasToken: () => !!token(),

  parseId(url) {
    return new URL(url).pathname.match(/thing:(\d+)/)?.[1] || null;
  },

  async fetchMeta(url) {
    const id = this.parseId(url);
    if (!id) throw new IngestError('Not a Thingiverse thing URL (expected /thing:<id>)', 400);
    const canonical = `https://www.thingiverse.com/thing:${id}`;

    if (!token()) {
      // Public page: JSON-LD/OpenGraph give title, description and cover; tags and files need the API.
      const m = generic.parseHtml(await fetchText(canonical), canonical);
      if (!m.title) throw new IngestError('Could not read that Thingiverse page (the site may block automated access)');
      return { ...m, url: canonical, tags: [], files: [], _needsToken: true, _thingId: id };
    }

    const get = path => fetchText(`${API}${path}`, { headers: authHeaders() }).then(JSON.parse);
    const [t, files] = await Promise.all([get(`/things/${id}`), get(`/things/${id}/files`)]);
    return {
      title: t.name,
      description: t.description || t.details || '',
      url: canonical,
      tags: t.tags || [],
      remoteModified: t.modified || '',
      coverUrl: t.default_image?.url || t.thumbnail || '',
      files: (files || []).map(f => ({ id: String(f.id), name: f.name, size: f.size, _direct: f.direct_url, _api: f.download_url })),
      _thingId: id,
    };
  },

  /** Prefers the pre-signed direct URL; otherwise the API download URL with the token (dropped on redirect to the CDN). */
  async resolveFile(meta, file) {
    if (file._direct) return { url: file._direct };
    if (file._api && token()) return { url: file._api, headers: authHeaders() };
    throw new IngestError('Thingiverse file downloads need THINGIVERSE_TOKEN');
  },
};
