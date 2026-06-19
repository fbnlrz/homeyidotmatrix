'use strict';

/**
 * Resolve a directory listing from a remote HTTP server (typically nginx with
 * `autoindex on;` in an LXC container on the same LAN). Two formats supported:
 *
 *   1. `<baseUrl>/index.json` containing either ["file1.gif", "file2.png"]
 *      or [{ "name": "file1.gif", "size": 1234 }]. If present, used directly.
 *
 *   2. The directory's HTML listing — anchors of the form
 *      <a href="filename.ext">…</a> are extracted. Trailing slashes
 *      (subdirectories) and parent links are ignored.
 *
 * Allowed extensions match the in-app store so the Flow card behavior is
 * consistent regardless of source.
 */

const ALLOWED_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp']);
const FETCH_TIMEOUT_MS = 5000;
const MAX_LIST_BYTES = 1024 * 1024; // 1 MiB cap on index pages

function _hasAllowedExt(name) {
  const dot = name.lastIndexOf('.');
  if (dot < 0) return false;
  return ALLOWED_EXT.has(name.slice(dot).toLowerCase());
}

function _normalizeBase(baseUrl) {
  if (!baseUrl) throw new Error('media_base_url is not configured');
  let s = String(baseUrl).trim();
  if (!/^https?:\/\//i.test(s)) s = 'http://' + s;
  if (!s.endsWith('/')) s += '/';
  return s;
}

async function _fetchWithTimeout(url, opts = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), opts.timeoutMs || FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

async function _readCapped(res) {
  // Read up to MAX_LIST_BYTES — protects against pointing at a huge URL.
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > MAX_LIST_BYTES) throw new Error('listing too large (>1 MiB)');
    chunks.push(value);
  }
  return Buffer.concat(chunks.map(c => Buffer.from(c)));
}

function _parseHtmlListing(html) {
  // Permissive anchor extractor — works with nginx autoindex, Apache, Python -m http.server.
  const re = /<a\s+[^>]*href\s*=\s*["']([^"']+)["'][^>]*>/gi;
  const seen = new Set();
  const out = [];
  let m;
  while ((m = re.exec(html)) !== null) {
    let href = m[1];
    if (!href || href.startsWith('?') || href.startsWith('#')) continue;
    if (href === '../' || href === '..') continue;
    // strip query/fragment
    href = href.split('?')[0].split('#')[0];
    if (href.endsWith('/')) continue; // subdirectory, skip
    // decode percent-encoded names (nginx autoindex encodes spaces etc.)
    let name;
    try { name = decodeURIComponent(href); } catch { name = href; }
    // strip any leading path segments — autoindex normally gives bare filenames
    const slash = name.lastIndexOf('/');
    if (slash >= 0) name = name.slice(slash + 1);
    if (!_hasAllowedExt(name)) continue;
    if (seen.has(name)) continue;
    seen.add(name);
    out.push({ name });
  }
  return out;
}

async function list(baseUrl) {
  const base = _normalizeBase(baseUrl);

  // 1) Try index.json first
  try {
    const res = await _fetchWithTimeout(base + 'index.json');
    if (res.ok) {
      const json = await res.json();
      const arr = Array.isArray(json) ? json : (json && json.files);
      if (Array.isArray(arr)) {
        const items = [];
        for (const e of arr) {
          if (typeof e === 'string') {
            if (_hasAllowedExt(e)) items.push({ name: e });
          } else if (e && typeof e.name === 'string') {
            if (_hasAllowedExt(e.name)) items.push({ name: e.name, size: e.size });
          }
        }
        if (items.length) return items;
      }
    }
  } catch (e) { /* fall through to HTML listing */ }

  // 2) HTML directory listing
  const res = await _fetchWithTimeout(base);
  if (!res.ok) throw new Error(`HTTP ${res.status} listing ${base}`);
  const buf = await _readCapped(res);
  const charset = _extractCharset(res.headers && res.headers.get && res.headers.get('content-type'));
  // Node's TextDecoder accepts any charset label that ICU supports; fall back
  // to utf-8 silently if the label is something exotic. Filenames with
  // non-ASCII chars on iso-8859-1 servers used to come through as mojibake.
  let html;
  try {
    html = new TextDecoder(charset || 'utf-8').decode(buf);
  } catch (_) {
    html = buf.toString('utf8');
  }
  return _parseHtmlListing(html);
}

function _extractCharset(contentType) {
  if (!contentType) return null;
  const m = /charset=([^;\s]+)/i.exec(contentType);
  return m ? m[1].trim().toLowerCase() : null;
}

async function fetchFile(baseUrl, name) {
  const base = _normalizeBase(baseUrl);
  if (!name || /[\\/]/.test(name)) throw new Error('invalid file name');
  const url = base + encodeURIComponent(name);
  const res = await _fetchWithTimeout(url, { timeoutMs: 15000 });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  const ab = await res.arrayBuffer();
  return { buffer: Buffer.from(ab), url };
}

module.exports = { list, fetchFile };
