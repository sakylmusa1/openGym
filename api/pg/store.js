// Synchronous face of the Postgres worker. File-mode (Docker, the existing tests)
// never calls init(); enabled() is false unless DATABASE_URL is set.
import fs from 'node:fs';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';

const MAX = 12 * 1024 * 1024;
let worker = null;
let sab = null;
let i32 = null;
let u8 = null;
let storage = false;

export function enabled() {
  return !!process.env.DATABASE_URL;
}

export function storageEnabled() {
  return storage || !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
}

export function init() {
  if (!enabled()) return;
  if (worker) return;
  sab = new SharedArrayBuffer(8 + MAX);
  i32 = new Int32Array(sab);
  u8 = new Uint8Array(sab);
  worker = new Worker(fileURLToPath(new URL('./worker.js', import.meta.url)), {
    workerData: { sab, connectionString: process.env.DATABASE_URL }
  });
  worker.on('error', e => console.error('pg worker', e));
  const ping = call('ping');
  storage = !!ping.storage;
  if (ping.bucket) console.error('storage:', ping.bucket);
}

function call(op, args) {
  if (!worker) throw new Error('postgres is not connected');
  i32[0] = 0;
  worker.postMessage({ op, args });
  const waited = Atomics.wait(i32, 0, 0, 60000);
  if (i32[0] === 0) throw new Error('postgres timed out (' + op + ', ' + waited + ')');
  const len = i32[1];
  const text = Buffer.from(u8.subarray(8, 8 + len)).toString('utf8');
  let obj;
  try { obj = JSON.parse(text); }
  catch (e) { throw new Error('postgres returned a bad answer for ' + op); }
  if (i32[0] === 2) throw new Error(obj.message || op);
  if (obj && obj.__spill) {
    const raw = fs.readFileSync(obj.__spill, 'utf8');
    fs.unlinkSync(obj.__spill);
    return JSON.parse(raw);
  }
  return obj;
}

export const kvGet = key => call('kvGet', { key }).value;
export const kvSet = (key, value) => call('kvSet', { key, value });
export const docGet = id => call('docGet', { id });
export const docStat = id => call('docStat', { id });
export const docCas = (id, body, expectedRev) => call('docCas', { id, body, expectedRev });
export const docPut = (id, body) => call('docPut', { id, body });
export const docDel = id => call('docDel', { id });
export const docList = prefix => call('docList', { prefix });

export const challengePut = (id, payload, exp) => call('challengePut', { id, payload, exp });
export const challengeTake = id => call('challengeTake', { id });
export const pairPut = (code, uid, exp) => call('pairPut', { code, uid, exp });
export const pairTake = code => call('pairTake', { code });
export const pairDropUser = uid => call('pairDropUser', { uid });
export const pairExists = code => call('pairExists', { code });

export const presenceUpsert = (uid, payload) => call('presenceUpsert', { uid, payload });
export const presencePatch = (uid, patch) => call('presencePatch', { uid, patch });
export const presenceGet = uid => call('presenceGet', { uid });
export const presenceDelete = uid => call('presenceDelete', { uid });
export const presenceAll = () => call('presenceAll');

export const restUpsert = row => call('restUpsert', row);
export const restClaim = key => call('restClaim', { key });
export const restCancel = (userId, deviceId) => call('restCancel', { userId, deviceId: deviceId || null });
export const restDue = now => call('restDue', { now });

export const auditAppend = rec => call('auditAppend', { rec });
export const auditList = () => call('auditList');
export const auditClear = () => call('auditClear');
export const auditCompact = spec => call('auditCompact', spec);
export const auditMaxId = () => call('auditMaxId');

export const mediaPut = row => call('mediaPut', row);
export const mediaGet = (uid, hash) => call('mediaGet', { uid, hash });
export const mediaList = uid => call('mediaList', { uid });
export const mediaUsage = uid => call('mediaUsage', { uid });
export const mediaDel = (uid, hash) => call('mediaDel', { uid, hash });
export const mediaDelUser = uid => call('mediaDelUser', { uid });
export const gcGet = uid => call('gcGet', { uid });
export const gcPut = (uid, marks) => call('gcPut', { uid, marks });
export const pendingPut = row => call('pendingPut', row);
export const pendingGet = (uid, hash) => call('pendingGet', { uid, hash });
export const pendingDel = (uid, hash) => call('pendingDel', { uid, hash });

export const syncPut = row => call('syncPut', row);
export const syncAssemble = (uploadId, uid) => call('syncAssemble', { uploadId, uid });
export const syncDel = uploadId => call('syncDel', { uploadId });
export const sweepEphemeral = now => call('sweepEphemeral', { now });
export const signUpload = objectPath => call('signUpload', { objectPath });
export const signDownload = objectPath => call('signDownload', { objectPath });
export const storageDownload = objectPath => call('storageDownload', { objectPath });
export const storageDelete = objectPath => call('storageDelete', { objectPath });
export const ping = () => call('ping');
