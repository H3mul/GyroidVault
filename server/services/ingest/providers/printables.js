const { guardedFetch, codeForHttp, IngestError } = require('../fetchGuard');

const API = 'https://api.printables.com/graphql/';
const FILE_TYPES = [['stls', 'stl'], ['gcodes', 'gcode'], ['slas', 'sla']];

async function gql(query) {
  const res = await guardedFetch(API, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query }) });
  if (!res.ok) { await res.body?.cancel(); throw new IngestError(`Printables answered HTTP ${res.status}`, 422, codeForHttp(res.status)); }
  return JSON.parse(await res.text());
}

module.exports = {
  id: 'printables',
  matches: host => /(^|\.)printables\.com$/.test(host),

  /** /model/123-slug and /en/model/123-slug both carry the numeric id first. */
  parseId(url) {
    return new URL(url).pathname.match(/\/model\/(\d+)/)?.[1] || null;
  },

  async fetchMeta(url) {
    const id = this.parseId(url);
    if (!id) throw new IngestError('Not a Printables model URL (expected /model/<id>)', 400);
    const { data } = await gql(`query{print(id:"${id}"){id modified name summary description tags{name} image{filePath} ${FILE_TYPES.map(([f]) => `${f}{id name fileSize}`).join(' ')}}}`);
    const p = data?.print;
    if (!p) throw new IngestError('Printables model not found (private, deleted, or wrong id)', 422, 'not_found');
    return {
      title: p.name,
      remoteModified: p.modified,
      description: p.description || p.summary,
      url: `https://www.printables.com/model/${id}`,
      tags: p.tags,
      coverUrl: p.image?.filePath ? `https://media.printables.com/${p.image.filePath}` : '',
      files: FILE_TYPES.flatMap(([field, type]) => (p[field] || []).map(f => ({ id: `${type}:${f.id}`, name: f.name, size: f.fileSize }))),
      _printId: id,
    };
  },

  /** Signed, short-lived download URL for one file: {url, headers?}. */
  async resolveFile(meta, file) {
    const [type, fileId] = file.id.split(':');
    if (!FILE_TYPES.some(([, t]) => t === type) || !/^\d+$/.test(fileId)) throw new IngestError('Bad file id', 400);
    const { data } = await gql(`mutation{getDownloadLink(id:"${fileId}",printId:"${meta._printId}",fileType:${type},source:model_detail){ok output{link}}}`);
    const link = data?.getDownloadLink?.output?.link;
    if (!link) throw new IngestError('Printables did not provide a download link for this file');
    return { url: link };
  },
};
