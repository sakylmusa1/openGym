// Postgres worker. The API is synchronous (saveDb, readState, the challenge map),
// and node-postgres is not. This thread owns the connection so the main thread
// can wait on a SharedArrayBuffer without stalling the query itself.
//
// Prepared statements stay off: Supabase's transaction pooler (port 6543) rejects
// them. One connection is enough for a single-user Hobby deployment.
import { parentPort, workerData } from 'node:worker_threads';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import postgres from 'postgres';

const { sab, connectionString } = workerData;
const i32 = new Int32Array(sab);
const u8 = new Uint8Array(sab);
const opts = { prepare: false, max: 1, idle_timeout: 20, connect_timeout: 15 };
if (process.env.DATABASE_SSL === 'disable') opts.ssl = false;
if (process.env.DATABASE_SSL === 'require') opts.ssl = 'require';
const sql = postgres(connectionString, opts);

const BUCKET = 'opengym-media';

function storageOn() {
  return !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
}
function storageBase() {
  return process.env.SUPABASE_URL.replace(/\/$/, '') + '/storage/v1';
}
function storageHeaders(extra) {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return { Authorization: 'Bearer ' + key, apikey: key, ...(extra || {}) };
}

function spill(obj) {
  const bytes = Buffer.from(JSON.stringify(obj));
  if (8 + bytes.length <= sab.byteLength) return bytes;
  const file = path.join(os.tmpdir(), 'ogym-spill-' + process.pid + '-' + Date.now() + '-' + Math.random().toString(16).slice(2));
  fs.writeFileSync(file, bytes);
  return Buffer.from(JSON.stringify({ __spill: file }));
}

function reply(status, obj) {
  const bytes = spill(obj);
  u8.set(bytes, 8);
  i32[1] = bytes.length;
  i32[0] = status;
  Atomics.notify(i32, 0);
}

async function ensureBucket() {
  if (!storageOn()) return { ok: true, storage: false };
  const res = await fetch(storageBase() + '/bucket', {
    method: 'POST',
    headers: storageHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ id: BUCKET, name: BUCKET, public: false })
  });
  // 409 / 400: the bucket is already there. Anything else is a real failure,
  // but boot should still come up so accounts work while media is fixed.
  if (!res.ok && res.status !== 409 && res.status !== 400) {
    const text = await res.text();
    console.error('storage bucket', res.status, text.slice(0, 300));
    return { ok: false, storage: true, error: text.slice(0, 200) };
  }
  return { ok: true, storage: true };
}

const ops = {
  async ping() {
    const rows = await sql`select 1 as ok`;
    const bucket = await ensureBucket();
    return { ok: rows[0].ok === 1, storage: bucket.storage, bucket: bucket.error || null };
  },
  async kvGet({ key }) {
    const rows = await sql`select value from app_kv where key = ${key}`;
    return { value: rows.length ? rows[0].value : null };
  },
  async kvSet({ key, value }) {
    await sql`
      insert into app_kv (key, value, updated_at) values (${key}, ${value}, now())
      on conflict (key) do update set value = excluded.value, updated_at = now()
    `;
    return { ok: true };
  },
  async docGet({ id }) {
    const rows = await sql`select body, rev from documents where id = ${id}`;
    if (!rows.length) return null;
    return { body: rows[0].body, rev: Number(rows[0].rev) };
  },
  async docStat({ id }) {
    const rows = await sql`select rev, octet_length(body) as size from documents where id = ${id}`;
    if (!rows.length) return null;
    return { rev: Number(rows[0].rev), size: Number(rows[0].size) };
  },
  async docCas({ id, body, expectedRev }) {
    if (!expectedRev) {
      const rows = await sql`
        insert into documents (id, body, rev) values (${id}, ${body}, 1)
        on conflict (id) do nothing
        returning rev
      `;
      if (rows.length) return { ok: true, rev: Number(rows[0].rev) };
      return { ok: false };
    }
    const rows = await sql`
      update documents set body = ${body}, rev = rev + 1, updated_at = now()
      where id = ${id} and rev = ${expectedRev}
      returning rev
    `;
    if (!rows.length) return { ok: false };
    return { ok: true, rev: Number(rows[0].rev) };
  },
  async docPut({ id, body }) {
    const rows = await sql`
      insert into documents (id, body, rev) values (${id}, ${body}, 1)
      on conflict (id) do update set body = excluded.body, rev = documents.rev + 1, updated_at = now()
      returning rev
    `;
    return { rev: Number(rows[0].rev) };
  },
  async docDel({ id }) {
    await sql`delete from documents where id = ${id}`;
    return { ok: true };
  },
  async docList({ prefix }) {
    const rows = await sql`select id from documents where id like ${prefix + '%'}`;
    return rows.map(r => r.id);
  },
  async challengePut({ id, payload, exp }) {
    await sql`
      insert into challenges (id, payload, exp) values (${id}, ${sql.json(payload)}, ${exp})
      on conflict (id) do update set payload = excluded.payload, exp = excluded.exp
    `;
    return { ok: true };
  },
  async challengeTake({ id }) {
    const rows = await sql`delete from challenges where id = ${id} returning payload, exp`;
    if (!rows.length) return null;
    if (Number(rows[0].exp) < Date.now()) return null;
    return rows[0].payload;
  },
  async pairPut({ code, uid, exp }) {
    await sql`
      insert into pairings (code, uid, exp) values (${code}, ${uid}, ${exp})
      on conflict (code) do update set uid = excluded.uid, exp = excluded.exp
    `;
    return { ok: true };
  },
  async pairTake({ code }) {
    const rows = await sql`delete from pairings where code = ${code} returning uid, exp`;
    if (!rows.length) return null;
    return { uid: rows[0].uid, exp: Number(rows[0].exp) };
  },
  async pairDropUser({ uid }) {
    await sql`delete from pairings where uid = ${uid}`;
    return { ok: true };
  },
  async pairExists({ code }) {
    const rows = await sql`select 1 from pairings where code = ${code}`;
    return rows.length > 0;
  },
  async presenceUpsert({ uid, payload }) {
    await sql`
      insert into presence (uid, payload, updated_at) values (${uid}, ${sql.json(payload)}, ${Date.now()})
      on conflict (uid) do update set payload = excluded.payload, updated_at = excluded.updated_at
    `;
    return { ok: true };
  },
  async presencePatch({ uid, patch }) {
    const rows = await sql`select payload from presence where uid = ${uid}`;
    if (!rows.length) return null;
    const next = { ...rows[0].payload, ...patch };
    await sql`update presence set payload = ${sql.json(next)}, updated_at = ${Date.now()} where uid = ${uid}`;
    return next;
  },
  async presenceGet({ uid }) {
    const rows = await sql`select payload from presence where uid = ${uid}`;
    return rows.length ? rows[0].payload : null;
  },
  async presenceDelete({ uid }) {
    await sql`delete from presence where uid = ${uid}`;
    return { ok: true };
  },
  async presenceAll() {
    const rows = await sql`select uid, payload from presence`;
    return rows.map(r => ({ uid: r.uid, payload: r.payload }));
  },
  async restUpsert({ key, userId, deviceId, lang, fireAt }) {
    await sql`
      insert into rest_timers (key, user_id, device_id, lang, fire_at)
      values (${key}, ${userId}, ${deviceId}, ${lang}, ${fireAt})
      on conflict (key) do update set user_id = excluded.user_id, device_id = excluded.device_id,
        lang = excluded.lang, fire_at = excluded.fire_at
    `;
    return { ok: true };
  },
  async restClaim({ key }) {
    const rows = await sql`
      delete from rest_timers where key = ${key}
      returning key, user_id, device_id, lang, fire_at
    `;
    if (!rows.length) return null;
    return { key: rows[0].key, userId: rows[0].user_id, deviceId: rows[0].device_id, lang: rows[0].lang, fireAt: Number(rows[0].fire_at) };
  },
  async restCancel({ userId, deviceId }) {
    if (deviceId) await sql`delete from rest_timers where user_id = ${userId} and device_id = ${deviceId}`;
    else await sql`delete from rest_timers where user_id = ${userId}`;
    return { ok: true };
  },
  async restDue({ now }) {
    const rows = await sql`
      delete from rest_timers where fire_at <= ${now}
      returning key, user_id, device_id, lang, fire_at
    `;
    return rows.map(r => ({ key: r.key, userId: r.user_id, deviceId: r.device_id, lang: r.lang, fireAt: Number(r.fire_at) }));
  },
  async auditAppend({ rec }) {
    const rows = await sql`insert into audit_events (rec) values (${sql.json(rec)}) returning id`;
    const id = Number(rows[0].id);
    const stored = { ...rec, id };
    await sql`update audit_events set rec = ${sql.json(stored)} where id = ${id}`;
    return stored;
  },
  async auditList() {
    const rows = await sql`select rec from audit_events order by id`;
    return rows.map(r => r.rec);
  },
  async auditClear() {
    await sql`delete from audit_events`;
    return { ok: true };
  },
  async auditCompact({ max, days, now }) {
    if (days) {
      const cut = now - days * 86400000;
      await sql`delete from audit_events where (rec->>'ts')::bigint < ${cut}`;
    }
    if (max) {
      await sql`
        delete from audit_events where id not in (
          select id from audit_events order by id desc limit ${max}
        )
      `;
    }
    const rows = await sql`select count(*)::int as n, coalesce(max(id), 0)::int as max from audit_events`;
    return { count: rows[0].n, maxId: rows[0].max };
  },
  async auditMaxId() {
    const rows = await sql`select coalesce(max(id), 0)::int as max, count(*)::int as n from audit_events`;
    return { maxId: rows[0].max, count: rows[0].n };
  },
  async mediaPut({ uid, hash, ext, mime, size, file, storagePath }) {
    const bytes = file ? fs.readFileSync(file) : null;
    await sql`
      insert into media_objects (uid, hash, ext, mime, size, storage_path, bytes)
      values (${uid}, ${hash}, ${ext}, ${mime}, ${size}, ${storagePath}, ${bytes})
      on conflict (uid, hash) do update set ext = excluded.ext, mime = excluded.mime, size = excluded.size,
        storage_path = excluded.storage_path, bytes = excluded.bytes
    `;
    return { ok: true };
  },
  async mediaGet({ uid, hash }) {
    const rows = await sql`select ext, mime, size, storage_path, bytes from media_objects where uid = ${uid} and hash = ${hash}`;
    if (!rows.length) return null;
    const row = rows[0];
    let file = null;
    if (row.bytes) {
      file = path.join(os.tmpdir(), `ogym-media-${uid}-${hash}.${row.ext}`);
      fs.writeFileSync(file, row.bytes);
    }
    return { ext: row.ext, mime: row.mime, size: Number(row.size), storagePath: row.storage_path, file };
  },
  async mediaList({ uid }) {
    const rows = await sql`select hash, ext, size from media_objects where uid = ${uid}`;
    return rows.map(r => ({ hash: r.hash, ext: r.ext, size: Number(r.size) }));
  },
  async mediaUsage({ uid }) {
    const rows = await sql`select coalesce(sum(size), 0)::bigint as bytes, count(*)::int as n from media_objects where uid = ${uid}`;
    return { bytes: Number(rows[0].bytes), count: rows[0].n };
  },
  async mediaDel({ uid, hash }) {
    const rows = await sql`delete from media_objects where uid = ${uid} and hash = ${hash} returning storage_path, size`;
    await sql`delete from media_gc where uid = ${uid} and hash = ${hash}`;
    return rows.length ? { storagePath: rows[0].storage_path, size: Number(rows[0].size) } : null;
  },
  async mediaDelUser({ uid }) {
    const rows = await sql`delete from media_objects where uid = ${uid} returning storage_path`;
    await sql`delete from media_gc where uid = ${uid}`;
    await sql`delete from media_pending where uid = ${uid}`;
    return rows.map(r => r.storage_path).filter(Boolean);
  },
  async gcGet({ uid }) {
    const rows = await sql`select hash, unreferenced_since from media_gc where uid = ${uid}`;
    const marks = {};
    for (const r of rows) marks[r.hash] = Number(r.unreferenced_since);
    return marks;
  },
  async gcPut({ uid, marks }) {
    await sql`delete from media_gc where uid = ${uid}`;
    for (const [hash, ts] of Object.entries(marks || {})) {
      await sql`
        insert into media_gc (uid, hash, unreferenced_since) values (${uid}, ${hash}, ${ts})
        on conflict (uid, hash) do update set unreferenced_since = excluded.unreferenced_since
      `;
    }
    return { ok: true };
  },
  async pendingPut({ uid, hash, mime, size, storagePath, exp }) {
    await sql`
      insert into media_pending (uid, hash, mime, size, storage_path, exp)
      values (${uid}, ${hash}, ${mime}, ${size}, ${storagePath}, ${exp})
      on conflict (uid, hash) do update set mime = excluded.mime, size = excluded.size,
        storage_path = excluded.storage_path, exp = excluded.exp
    `;
    return { ok: true };
  },
  async pendingGet({ uid, hash }) {
    const rows = await sql`select mime, size, storage_path, exp from media_pending where uid = ${uid} and hash = ${hash}`;
    if (!rows.length) return null;
    return { mime: rows[0].mime, size: Number(rows[0].size), storagePath: rows[0].storage_path, exp: Number(rows[0].exp) };
  },
  async pendingDel({ uid, hash }) {
    await sql`delete from media_pending where uid = ${uid} and hash = ${hash}`;
    return { ok: true };
  },
  async syncPut({ uploadId, idx, total, uid, gzip, b64 }) {
    const data = Buffer.from(b64, 'base64');
    await sql`
      insert into sync_parts (upload_id, idx, total, uid, gzip, data)
      values (${uploadId}, ${idx}, ${total}, ${uid}, ${gzip}, ${data})
      on conflict (upload_id, idx) do update set total = excluded.total, gzip = excluded.gzip, data = excluded.data
    `;
    return { ok: true, size: data.length };
  },
  async syncAssemble({ uploadId, uid }) {
    const rows = await sql`
      select idx, total, gzip, data from sync_parts
      where upload_id = ${uploadId} and uid = ${uid}
      order by idx
    `;
    if (!rows.length) return null;
    const total = rows[0].total;
    if (rows.length !== total) return { complete: false, have: rows.length, total };
    const chunks = [];
    for (let i = 0; i < total; i++) {
      if (rows[i].idx !== i) return { complete: false, have: rows.length, total };
      chunks.push(rows[i].data);
    }
    const file = path.join(os.tmpdir(), 'ogym-sync-' + uploadId);
    fs.writeFileSync(file, Buffer.concat(chunks));
    return { complete: true, gzip: rows[0].gzip, file, total };
  },
  async syncDel({ uploadId }) {
    await sql`delete from sync_parts where upload_id = ${uploadId}`;
    return { ok: true };
  },
  async sweepEphemeral({ now }) {
    const challenges = await sql`delete from challenges where exp < ${now}`;
    const pairings = await sql`delete from pairings where exp < ${now}`;
    const pending = await sql`delete from media_pending where exp < ${now}`;
    const hour = now - 3600000;
    await sql`delete from sync_parts where created_at < to_timestamp(${hour} / 1000.0)`;
    const n = r => Number(r?.count || 0);
    return { challenges: n(challenges), pairings: n(pairings), pending: n(pending) };
  },
  async signUpload({ objectPath }) {
    const res = await fetch(storageBase() + '/object/upload/sign/' + BUCKET + '/' + objectPath, {
      method: 'POST',
      headers: storageHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ upsert: true })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error('signed upload ' + res.status + ' ' + JSON.stringify(data).slice(0, 200));
    const pathPart = data.url || data.signedUrl || '';
    const url = /^https?:/i.test(pathPart) ? pathPart : storageBase() + pathPart;
    return { url, token: data.token || null };
  },
  async signDownload({ objectPath }) {
    const res = await fetch(storageBase() + '/object/sign/' + BUCKET + '/' + objectPath, {
      method: 'POST',
      headers: storageHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ expiresIn: 3600 })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error('signed download ' + res.status);
    const pathPart = data.signedURL || data.signedUrl || '';
    const url = /^https?:/i.test(pathPart) ? pathPart : storageBase() + pathPart;
    return { url };
  },
  async storageDownload({ objectPath }) {
    const res = await fetch(storageBase() + '/object/' + BUCKET + '/' + objectPath, { headers: storageHeaders() });
    if (!res.ok) throw new Error('storage download ' + res.status);
    const buf = Buffer.from(await res.arrayBuffer());
    const file = path.join(os.tmpdir(), 'ogym-dl-' + path.basename(objectPath));
    fs.writeFileSync(file, buf);
    return { file, size: buf.length };
  },
  async storageDelete({ objectPath }) {
    if (!objectPath || !storageOn()) return { ok: true };
    const res = await fetch(storageBase() + '/object/' + BUCKET + '/' + objectPath, {
      method: 'DELETE',
      headers: storageHeaders()
    });
    return { ok: res.ok || res.status === 404 };
  }
};

parentPort.on('message', async msg => {
  try {
    const fn = ops[msg.op];
    if (!fn) throw new Error('unknown op ' + msg.op);
    reply(1, await fn(msg.args || {}));
  } catch (e) {
    reply(2, { message: e.message || String(e) });
  }
});
