// Media bytes for the serverless deploy. Small files still arrive as PUT
// /api/media/{hash} (the same route the Docker server has). Files over the
// function body limit go straight to Supabase Storage with a signed upload URL,
// or, without Storage, in base64 parts that land in Postgres.
//
// The file-backed store in media.js is untouched and is what Docker keeps using.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MediaError, MEDIA_TYPES, HASH_RE, sniffMedia, mp4Info, referencedHashes } from '../media.js';
import * as pg from './store.js';

const MB = 1024 * 1024;
const PART = 3 * MB;
const DIRECT_MAX = Math.floor(3.5 * MB);

function safe(uid) {
  const s = String(uid ?? '').replace(/[^a-zA-Z0-9_-]/g, '');
  if (!s) throw new Error('media: a profile id is required');
  return s;
}
const contentType = req => String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();

function drain(req, max) {
  if (!req || req.complete || req.readableEnded) return;
  let n = 0;
  req.resume();
  req.on('data', d => { n += d.length; if (n > max) req.destroy(); });
}

function streamToFile(req, file, max) {
  return new Promise((resolve, reject) => {
    const out = fs.createWriteStream(file, { flags: 'wx', mode: 0o600 });
    const hash = crypto.createHash('sha256');
    const head = [];
    let headLen = 0, size = 0, settled = false, ended = false;
    const fail = err => {
      if (settled) return;
      settled = true;
      out.destroy();
      reject(err);
    };
    out.on('error', fail);
    req.on('data', chunk => {
      size += chunk.length;
      if (size > max) return fail(new MediaError(413, 'media-too-large'));
      hash.update(chunk);
      if (headLen < 64) {
        const part = Buffer.from(chunk.subarray(0, 64 - headLen));
        head.push(part);
        headLen += part.length;
      }
      if (!out.write(chunk)) req.pause();
    });
    out.on('drain', () => req.resume());
    req.on('end', () => {
      ended = true;
      out.end();
      out.once('close', () => {
        if (settled) return;
        settled = true;
        resolve({ size, sha: hash.digest('hex'), head: Buffer.concat(head) });
      });
    });
    req.on('error', e => fail(Object.assign(e || new Error('aborted'), { clientGone: true })));
    req.on('close', () => { if (!ended) fail(Object.assign(new Error('client went away'), { clientGone: true })); });
    req.resume();
  });
}

function inspect(file, size, head, hash, declared, limits) {
  const sn = sniffMedia(head);
  if (!sn || sn.category !== declared.category) throw new MediaError(415, 'media-type');
  const cap = (sn.kind === 'video' ? limits.videoMB : sn.kind === 'gif' ? limits.gifMB : limits.imageMB) * MB;
  if (size > cap) throw new MediaError(413, 'media-too-large', { maxMB: cap / MB });
  if (sn.ext === 'mp4' || sn.ext === 'mov') {
    const fd = fs.openSync(file, 'r');
    let info;
    try { info = mp4Info(fd, size); }
    finally { fs.closeSync(fd); }
    if (!info) throw new MediaError(415, 'media-invalid');
    if (info.durationSec != null && info.durationSec > limits.videoSec + 1) {
      throw new MediaError(413, 'media-too-long', { maxSec: limits.videoSec });
    }
  }
  return { ext: sn.ext, mime: sn.mime, kind: sn.kind, size, hash };
}

export function createPgMediaStore({ limits, readState, log = console } = {}) {
  const quotaBytes = limits.quotaMB > 0 ? Math.round(limits.quotaMB * MB) : 0;
  const maxCap = Math.round(Math.max(limits.imageMB, limits.gifMB, limits.videoMB) * MB);

  function usage(uid) {
    const u = pg.mediaUsage(safe(uid));
    return { bytes: u.bytes, count: u.count, quotaBytes };
  }
  function assertRoom(uid, need) {
    if (!quotaBytes) return;
    const u = pg.mediaUsage(safe(uid));
    if (u.bytes + need > quotaBytes) {
      try { sweep(uid, { graceMs: 3600000 }); } catch (e) { log.error('media quota sweep', e.message); }
      const again = pg.mediaUsage(safe(uid));
      if (again.bytes + need > quotaBytes) {
        throw new MediaError(413, 'media-quota', { usedMB: Math.round(again.bytes / MB * 10) / 10, quotaMB: limits.quotaMB });
      }
    }
  }
  function marksOf(uid) {
    try { return pg.gcGet(safe(uid)) || {}; }
    catch { return {}; }
  }
  function stateOf(uid) {
    let S = null;
    try { S = readState(uid); } catch { S = null; }
    return S && typeof S === 'object' && !Array.isArray(S) ? S : null;
  }
  function remember(uid, hash, meta, storagePath) {
    pg.mediaPut({
      uid: safe(uid), hash, ext: meta.ext, mime: meta.mime, size: meta.size,
      file: storagePath ? null : meta.file, storagePath: storagePath || null
    });
    const S = stateOf(uid);
    const refs = S ? referencedHashes(S) : null;
    if (!refs || !refs.has(hash)) {
      const marks = marksOf(uid);
      marks[hash] = Date.now();
      pg.gcPut(safe(uid), marks);
    }
  }

  function sweep(uid, { graceMs = limits.gcGraceDays * 86400000 } = {}) {
    const id = safe(uid);
    const res = { removed: 0, freedBytes: 0, skipped: false };
    const S = stateOf(uid);
    if (!S) { res.skipped = true; return res; }
    const refs = referencedHashes(S);
    const files = pg.mediaList(id);
    const marks = marksOf(uid);
    const t = Date.now();
    let changed = false;
    for (const f of files) {
      if (refs.has(f.hash)) { if (f.hash in marks) { delete marks[f.hash]; changed = true; } }
      else if (!(f.hash in marks)) { marks[f.hash] = t; changed = true; }
    }
    for (const f of files) {
      if (refs.has(f.hash)) continue;
      if (graceMs > 0 && !(t - (marks[f.hash] || t) >= graceMs)) continue;
      const gone = pg.mediaDel(id, f.hash);
      if (gone?.storagePath) { try { pg.storageDelete(gone.storagePath); } catch (e) { log.error('storage delete', e.message); } }
      delete marks[f.hash];
      changed = true;
      res.removed++;
      res.freedBytes += f.size;
    }
    if (changed) pg.gcPut(id, marks);
    return res;
  }

  async function receive(uid, hash, req) {
    if (!HASH_RE.test(String(hash))) { drain(req, maxCap * 2); throw new MediaError(400, 'bad-request'); }
    const declared = MEDIA_TYPES[contentType(req)];
    if (!declared) { drain(req, maxCap * 2); throw new MediaError(415, 'media-type'); }
    const cap = (declared.kind === 'video' ? limits.videoMB : declared.kind === 'gif' ? limits.gifMB : limits.imageMB) * MB;
    const len = Number(req.headers['content-length']);
    if (Number.isFinite(len) && len > cap) { drain(req, maxCap * 2); throw new MediaError(413, 'media-too-large'); }
    if (Number.isFinite(len) && len > DIRECT_MAX) {
      drain(req, maxCap * 2);
      throw new MediaError(413, 'media-too-large', { maxMB: DIRECT_MAX / MB });
    }
    const have = pg.mediaGet(safe(uid), hash);
    if (have && (!Number.isFinite(len) || have.size === len)) {
      drain(req, maxCap * 2);
      if (have.file) fs.unlinkSync(have.file);
      return { status: 200, body: { ok: true, hash, mime: have.mime, size: have.size, existed: true } };
    }
    assertRoom(uid, Number.isFinite(len) ? len : cap);
    const tmp = path.join(os.tmpdir(), 'ogym-up-' + crypto.randomBytes(8).toString('hex'));
    let got;
    try { got = await streamToFile(req, tmp, cap); }
    catch (e) { try { fs.unlinkSync(tmp); } catch { /* none */ } throw e; }
    try {
      if (got.sha !== hash) throw new MediaError(400, 'hash-mismatch');
      const meta = inspect(tmp, got.size, got.head, hash, declared, limits);
      meta.file = tmp;
      const storagePath = pg.storageEnabled() ? safe(uid) + '/' + hash : null;
      if (storagePath) {
        const put = await uploadLocal(storagePath, tmp, meta.mime);
        if (!put.ok) throw new Error(put.error || 'storage upload failed');
      }
      remember(uid, hash, meta, storagePath);
      return { status: 201, body: { ok: true, hash, mime: meta.mime, size: meta.size, existed: false } };
    } finally {
      try { fs.unlinkSync(tmp); } catch { /* gone */ }
    }
  }

  function file(uid, hash) {
    const row = pg.mediaGet(safe(uid), hash);
    if (!row) return null;
    if (row.storagePath && pg.storageEnabled()) {
      if (row.size > DIRECT_MAX) {
        try {
          const signed = pg.signDownload(row.storagePath);
          return { redirect: signed.url, ext: row.ext, mime: row.mime, size: row.size };
        } catch (e) { log.error('sign download', e.message); }
      }
    }
    if (row.size > DIRECT_MAX) {
      if (row.file) try { fs.unlinkSync(row.file); } catch { /* keep the row */ }
      return { chunked: true, ext: row.ext, mime: row.mime, size: row.size, part: PART };
    }
    if (!row.file) {
      if (!row.storagePath) return null;
      try {
        const dl = pg.storageDownload(row.storagePath);
        return { path: dl.file, ext: row.ext, mime: row.mime, size: row.size };
      } catch { return null; }
    }
    return { path: row.file, ext: row.ext, mime: row.mime, size: row.size };
  }

  function readRange(uid, hash, offset, len) {
    const row = pg.mediaGet(safe(uid), hash);
    if (!row) return null;
    let filePath = row.file;
    if (!filePath && row.storagePath) {
      try { filePath = pg.storageDownload(row.storagePath).file; }
      catch { return null; }
    }
    if (!filePath) return null;
    const fd = fs.openSync(filePath, 'r');
    try {
      const take = Math.max(0, Math.min(len, row.size - offset));
      const buf = Buffer.alloc(take);
      fs.readSync(fd, buf, 0, take, offset);
      return { buf, mime: row.mime, size: row.size };
    } finally { fs.closeSync(fd); }
  }

  return {
    limits,
    discard: req => drain(req, maxCap * 2),
    usage,
    has: (uid, hash) => !!pg.mediaGet(safe(uid), hash),
    file,
    readRange,
    receive,
    missing(uid, hashes) {
      const have = new Set(pg.mediaList(safe(uid)).map(f => f.hash));
      return { missing: [...new Set(hashes)].filter(h => !have.has(h)), usage: usage(uid) };
    },
    noteState(uid, state) {
      const id = safe(uid);
      const files = pg.mediaList(id);
      if (!files.length) return false;
      const refs = referencedHashes(state);
      const marks = marksOf(uid);
      let changed = false;
      for (const f of files) {
        if (refs.has(f.hash)) { if (f.hash in marks) { delete marks[f.hash]; changed = true; } }
        else if (!(f.hash in marks)) { marks[f.hash] = Date.now(); changed = true; }
      }
      if (changed) pg.gcPut(id, marks);
      return changed;
    },
    sweep,
    sweepAll({ uids = [] } = {}) {
      const out = { swept: 0, removed: 0, freedBytes: 0, skipped: 0, orphans: 0, tmp: 0 };
      for (const uid of uids) {
        try {
          const r = sweep(uid, {});
          if (r.skipped) out.skipped++; else out.swept++;
          out.removed += r.removed;
          out.freedBytes += r.freedBytes;
        } catch (e) { log.error('media sweep', uid, e.message); }
      }
      return out;
    },
    removeUser(uid) {
      const paths = pg.mediaDelUser(safe(uid));
      for (const p of paths) { try { pg.storageDelete(p); } catch { /* best effort */ } }
    },
    cleanTmp() { return 0; },
    sign(uid, hash, mime, size) {
      if (!HASH_RE.test(String(hash))) throw new MediaError(400, 'bad-request');
      const declared = MEDIA_TYPES[mime];
      if (!declared) throw new MediaError(415, 'media-type');
      const cap = (declared.kind === 'video' ? limits.videoMB : declared.kind === 'gif' ? limits.gifMB : limits.imageMB) * MB;
      if (!(size > 0) || size > cap) throw new MediaError(413, 'media-too-large', { maxMB: cap / MB });
      assertRoom(uid, size);
      if (!pg.storageEnabled()) {
        return { mode: 'chunk', partBytes: 2 * MB, hash };
      }
      const objectPath = safe(uid) + '/' + hash;
      const signed = pg.signUpload(objectPath);
      pg.pendingPut({ uid: safe(uid), hash, mime, size, storagePath: objectPath, exp: Date.now() + 2 * 3600000 });
      return { mode: 'signed', url: signed.url, token: signed.token, hash, partBytes: 2 * MB };
    },
    async acceptPart(uid, hash, index, total, b64) {
      if (!HASH_RE.test(String(hash))) throw new MediaError(400, 'bad-request');
      if (!Number.isInteger(index) || !Number.isInteger(total) || index < 0 || total < 1 || index >= total || total > 64) {
        throw new MediaError(400, 'bad-request');
      }
      pg.syncPut({ uploadId: 'media:' + safe(uid) + ':' + hash, idx: index, total, uid: safe(uid), gzip: false, b64 });
      return { ok: true, index, total };
    },
    async finishParts(uid, hash, mime) {
      const id = safe(uid);
      const assembled = pg.syncAssemble('media:' + id + ':' + hash, id);
      if (!assembled?.complete) throw new MediaError(400, 'bad-request');
      const declared = MEDIA_TYPES[mime];
      if (!declared) throw new MediaError(415, 'media-type');
      try {
        const buf = fs.readFileSync(assembled.file);
        const sha = crypto.createHash('sha256').update(buf).digest('hex');
        if (sha !== hash) throw new MediaError(400, 'hash-mismatch');
        const meta = inspect(assembled.file, buf.length, buf.subarray(0, 64), hash, declared, limits);
        meta.file = assembled.file;
        assertRoom(uid, buf.length);
        remember(uid, hash, meta, null);
        return { status: 201, body: { ok: true, hash, mime: meta.mime, size: buf.length, existed: false } };
      } finally {
        try { fs.unlinkSync(assembled.file); } catch { /* gone */ }
        try { pg.syncDel('media:' + id + ':' + hash); } catch { /* gone */ }
      }
    },
    async completeSigned(uid, hash) {
      const pending = pg.pendingGet(safe(uid), hash);
      if (!pending || pending.exp < Date.now()) throw new MediaError(400, 'bad-request');
      const dl = pg.storageDownload(pending.storagePath);
      try {
        const buf = fs.readFileSync(dl.file);
        const sha = crypto.createHash('sha256').update(buf).digest('hex');
        if (sha !== hash) throw new MediaError(400, 'hash-mismatch');
        const declared = MEDIA_TYPES[pending.mime];
        if (!declared) throw new MediaError(415, 'media-type');
        const meta = inspect(dl.file, buf.length, buf.subarray(0, 64), hash, declared, limits);
        if (pending.size && Math.abs(buf.length - pending.size) > 1024) throw new MediaError(400, 'hash-mismatch');
        meta.file = null;
        remember(uid, hash, { ...meta, file: null, size: buf.length }, pending.storagePath);
        pg.pendingDel(safe(uid), hash);
        return { status: 201, body: { ok: true, hash, mime: meta.mime, size: buf.length, existed: false } };
      } finally {
        try { fs.unlinkSync(dl.file); } catch { /* gone */ }
      }
    }
  };
}

// Service-role upload of a file that already arrived at the function (under 4.5 MB).
async function uploadLocal(objectPath, file, mime) {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) return { ok: false };
  const base = process.env.SUPABASE_URL.replace(/\/$/, '') + '/storage/v1';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const res = await fetch(base + '/object/opengym-media/' + objectPath, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + key, apikey: key,
      'Content-Type': mime, 'x-upsert': 'true'
    },
    body: fs.readFileSync(file)
  });
  if (!res.ok) return { ok: false, error: (await res.text()).slice(0, 200) };
  return { ok: true };
}
