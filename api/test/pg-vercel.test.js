/* Postgres mode: two processes share one database, the way two Vercel instances would.
   Register on one and finish on the other, sync a profile across them, store a push
   subscription, and run the cron tick. Skips when nothing answers on the local URL. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { boundPort } from './helpers.mjs';

const API = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = path.join(API, '..');
const URL = process.env.OPENGYM_TEST_DATABASE_URL || 'postgres://opengym:opengym@127.0.0.1:5432/opengym';
const ORIGIN = 'http://localhost:8080';
const CRON = 'tick-secret';
const b64u = b => Buffer.from(b).toString('base64url');
const sha = b => crypto.createHash('sha256').update(b).digest();

function softPasskey() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' });
  const cose = Buffer.concat([
    Buffer.from([0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21, 0x58, 0x20]), Buffer.from(jwk.x, 'base64url'),
    Buffer.from([0x22, 0x58, 0x20]), Buffer.from(jwk.y, 'base64url')
  ]);
  const raw = crypto.randomBytes(16);
  const id = b64u(raw);
  let counter = 0;
  return {
    attestation(challenge) {
      const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge, origin: ORIGIN, crossOrigin: false }));
      const len = Buffer.from([raw.length >> 8, raw.length & 255]);
      const authData = Buffer.concat([sha('localhost'), Buffer.from([0x45]), Buffer.alloc(4), Buffer.alloc(16), len, raw, cose]);
      const attestationObject = Buffer.concat([
        Buffer.from([0xa3]), cborText('fmt'), cborText('none'), cborText('attStmt'), Buffer.from([0xa0]),
        cborText('authData'), cborBytes(authData)
      ]);
      return {
        id, rawId: id, type: 'public-key', clientExtensionResults: {}, authenticatorAttachment: 'platform',
        response: { clientDataJSON: b64u(clientDataJSON), attestationObject: b64u(attestationObject), transports: ['internal'] }
      };
    },
    assertion(challenge) {
      const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge, origin: ORIGIN, crossOrigin: false }));
      const c = Buffer.alloc(4); c.writeUInt32BE(++counter);
      const authData = Buffer.concat([sha('localhost'), Buffer.from([0x05]), c]);
      const signature = crypto.sign('sha256', Buffer.concat([authData, sha(clientDataJSON)]), privateKey);
      return {
        id, rawId: id, type: 'public-key', clientExtensionResults: {}, authenticatorAttachment: 'platform',
        response: { clientDataJSON: b64u(clientDataJSON), authenticatorData: b64u(authData), signature: b64u(signature), userHandle: null }
      };
    }
  };
}
const cborHead = (major, n) => n < 24 ? Buffer.from([(major << 5) | n])
  : n < 256 ? Buffer.from([(major << 5) | 24, n]) : Buffer.from([(major << 5) | 25, n >> 8, n & 255]);
const cborText = s => Buffer.concat([cborHead(3, Buffer.byteLength(s)), Buffer.from(s)]);
const cborBytes = b => Buffer.concat([cborHead(2, b.length), b]);

async function connect() {
  const sql = postgres(URL, { prepare: false, ssl: false, max: 1, connect_timeout: 3, onnotice: () => {} });
  try {
    await sql`select 1 as ok`;
    return sql;
  } catch (e) {
    await sql.end({ timeout: 1 }).catch(() => {});
    return null;
  }
}

function startServer(t, sqlReady) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-pg-'));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: API, stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      PORT: '0', DATA_DIR: dataDir, ORIGIN, RP_ID: 'localhost',
      DATABASE_URL: URL, DATABASE_SSL: 'disable',
      SESSION_SECRET: 'pg-test-session-secret',
      CRON_SECRET: CRON, TRUST_PROXY: '1', AUDIT_LOG: '1',
      VERCEL: '', FIRST_USER_ADMIN: '1'
    }
  });
  const h = { api: '', log: '' };
  child.stdout.on('data', d => { h.log += d; });
  child.stderr.on('data', d => { h.log += d; });
  t.after(() => child.kill('SIGKILL'));
  return boundPort(child, () => h.log).then(port => {
    h.api = `http://127.0.0.1:${port}`;
    h.req = async (method, p, { body, cookie, raw, headers = {} } = {}) => {
      const r = await fetch(`${h.api}${p}`, {
        method,
        headers: {
          'Content-Type': 'application/json',
          'Sec-Fetch-Site': 'same-origin',
          ...(cookie ? { Cookie: cookie } : {}),
          ...headers
        },
        body: raw !== undefined ? raw : body === undefined ? undefined : JSON.stringify(body)
      });
      const text = await r.text();
      let parsed = null;
      try { parsed = text ? JSON.parse(text) : null; } catch { parsed = { raw: text }; }
      const setCookie = r.headers.getSetCookie?.().find(c => c.startsWith('gymsid=') && !c.startsWith('gymsid=;'));
      return { status: r.status, body: parsed, cookie: setCookie ? setCookie.split(';')[0] : null };
    };
    return h;
  });
}

test('register, sync, push and cron across two processes', async t => {
  const sql = await connect();
  if (!sql) {
    t.skip('no Postgres at ' + URL);
    return;
  }
  t.after(() => sql.end({ timeout: 2 }));
  const migration = fs.readFileSync(path.join(ROOT, 'supabase/migrations/20261022183055_opengym_persistence.sql'), 'utf8');
  await sql.unsafe(migration);
  await sql.unsafe(`truncate app_kv, documents, challenges, pairings, presence, rest_timers, audit_events, media_objects, media_gc, media_pending, sync_parts restart identity`);

  const a = await startServer(t);
  const b = await startServer(t);
  const key = softPasskey();

  const health = await a.req('GET', '/api/health');
  assert.equal(health.status, 200);
  assert.equal(health.body.writable, true);

  const opt = await a.req('POST', '/api/register/options', { body: { name: 'Ada' } });
  assert.equal(opt.status, 200, JSON.stringify(opt.body));
  const reg = await b.req('POST', '/api/register/verify', {
    body: { cid: opt.body.cid, credential: key.attestation(opt.body.options.challenge) }
  });
  assert.equal(reg.status, 200, JSON.stringify(reg.body) + '\n' + a.log);
  assert.equal(reg.body.user.admin, true);
  const cookie = reg.cookie;
  const uid = reg.body.user.id;

  const loginOpt = await b.req('POST', '/api/login/options', { body: {} });
  const login = await a.req('POST', '/api/login/verify', {
    body: { cid: loginOpt.body.cid, credential: key.assertion(loginOpt.body.options.challenge) }
  });
  assert.equal(login.status, 200, JSON.stringify(login.body));

  const put = await a.req('PUT', '/api/data', {
    cookie,
    body: { state: { workouts: [], routines: [{ id: 'r', name: 'A' }], lang: 'en' }, stamped: true }
  });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  const got = await b.req('GET', '/api/data', { cookie });
  assert.equal(got.status, 200);
  assert.equal(got.body.state.routines[0].name, 'A');
  assert.equal(got.body.rev, put.body.rev);

  const gzipBody = zlib.gzipSync(Buffer.from(JSON.stringify({
    state: { workouts: [], routines: [{ id: 'r', name: 'B' }], lang: 'en' },
    stamped: true, baseRev: put.body.rev, baseWid: put.body.wid
  })));
  const zipped = await a.req('PUT', '/api/data', {
    cookie, raw: gzipBody, headers: { 'Content-Encoding': 'gzip', 'Content-Type': 'application/json' }
  });
  assert.equal(zipped.status, 200, JSON.stringify(zipped.body));

  const chunk = Buffer.from(JSON.stringify({
    state: { workouts: [{ d: '2026-01-01' }], routines: [], lang: 'en' },
    stamped: true, baseRev: zipped.body.rev, baseWid: zipped.body.wid
  }));
  const mid = Math.ceil(chunk.length / 2);
  const uploadId = 'up-' + crypto.randomBytes(4).toString('hex');
  for (const [index, slice] of [[0, chunk.subarray(0, mid)], [1, chunk.subarray(mid)]]) {
    const part = await b.req('POST', '/api/data/part', {
      cookie,
      body: { uploadId, index, total: 2, gzip: false, data: slice.toString('base64') }
    });
    assert.equal(part.status, 200, JSON.stringify(part.body));
  }
  const committed = await a.req('POST', '/api/data/commit', { cookie, body: { uploadId } });
  assert.equal(committed.status, 200, JSON.stringify(committed.body));
  const after = await b.req('GET', '/api/data', { cookie });
  assert.equal(after.body.state.workouts[0].d, '2026-01-01');

  const sub = await a.req('POST', '/api/push/subscribe', {
    cookie,
    body: {
      subscription: {
        endpoint: 'https://updates.push.services.mozilla.com/wpush/v2/opengym-test',
        keys: { p256dh: 'p256', auth: 'authkey' }
      },
      deviceId: 'deviceid1'
    }
  });
  assert.equal(sub.status, 200, JSON.stringify(sub.body));
  const status = await b.req('GET', '/api/push/status?endpoint=' + encodeURIComponent('https://updates.push.services.mozilla.com/wpush/v2/opengym-test'), { cookie });
  assert.equal(status.body.subscribed, true);

  const rest = await a.req('POST', '/api/push/rest-timer', { cookie, body: { seconds: 3600, deviceId: 'deviceid1' } });
  assert.equal(rest.status, 200);
  const rows = await sql`select key from rest_timers where user_id = ${uid}`;
  assert.equal(rows.length, 1);
  const cancel = await b.req('POST', '/api/push/rest-timer/cancel', { cookie, body: { deviceId: 'deviceid1' } });
  assert.equal(cancel.status, 200);
  assert.equal((await sql`select key from rest_timers where user_id = ${uid}`).length, 0);

  await sql`insert into rest_timers (key, user_id, device_id, lang, fire_at) values (${uid + ':deviceid1'}, ${uid}, 'deviceid1', 'en', ${Date.now() - 1000})`;
  const denied = await a.req('GET', '/api/cron/tick');
  assert.equal(denied.status, 401);
  const tick = await b.req('GET', '/api/cron/tick?secret=' + CRON);
  assert.equal(tick.status, 200, JSON.stringify(tick.body));
  assert.equal(tick.body.ok, true);
  assert.equal((await sql`select key from rest_timers`).length, 0);

  const code = await a.req('POST', '/api/pair/create', { cookie, body: {} });
  assert.equal(code.status, 200, JSON.stringify(code.body));
  const redeemed = await b.req('POST', '/api/pair/redeem', { body: { code: code.body.code } });
  assert.equal(redeemed.status, 200, JSON.stringify(redeemed.body));
  assert.ok(redeemed.body.token);
});
