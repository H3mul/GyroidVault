const { fetchText, IngestError } = require('../fetchGuard');

const API = 'https://api.thingiverse.com';
const TOKEN_URL = 'https://www.thingiverse.com/apps/create';
const token = () => (process.env.THINGIVERSE_TOKEN || '').trim();
const authHeaders = () => ({ authorization: `Bearer ${token()}` });

const tokenRequired = () => new IngestError(
  `Thingiverse imports need an API token. Create an app token at ${TOKEN_URL} and set it on the server as THINGIVERSE_TOKEN, then try again.`,
  422, 'token_required');

module.exports = {
  id: 'thingiverse',
  matches: host => /(^|\.)thingiverse\.com$/.test(host),
  // Without a token Thingiverse is not attempted at all (its pages sit behind a bot challenge): fail before any request.
  requiresToken: true,
  hasToken: () => !!token(),
  tokenRequired,

  parseId(url) {
    return new URL(url).pathname.match(/thing:(\d+)/)?.[1] || null;
  },

  async fetchMeta(url) {
    if (!token()) throw tokenRequired();
    const id = this.parseId(url);
    if (!id) throw new IngestError('Not a Thingiverse thing URL (expected /thing:<id>)', 400);
    const canonical = `https://www.thingiverse.com/thing:${id}`;

    const get = path => fetchText(`${API}${path}`, { headers: authHeaders() }).then(JSON.parse).catch(e => {
      // the API answering 401/403 for the token (not a bot challenge) means the token itself is bad
      if (e.httpStatus === 401 || (e.httpStatus === 403 && !e.challenge)) {
        throw new IngestError(`Thingiverse rejected the API token. Check THINGIVERSE_TOKEN (create a new one at ${TOKEN_URL}).`, 422, 'bad_token');
      }
      throw e;
    });
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
    throw new IngestError('Thingiverse did not provide a download link for this file');
  },
};
