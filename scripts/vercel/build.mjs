// Assembles a Vercel Build Output (v3) from the Vite app plus one Node function
// that serves every /api/* route. outputDirectory is intentionally unset in
// vercel.json: a static output directory would drop the function.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const run = (cmd, args, cwd) => {
  const r = spawnSync(cmd, args, { stdio: 'inherit', cwd, env: process.env });
  if (r.status) process.exit(r.status ?? 1);
};

run('npm', ['run', 'build'], path.join(root, 'frontend'));
run(process.execPath, ['scripts/catalogue/stage-media.mjs', 'frontend/dist'], root);

const out = path.join(root, '.vercel/output');
fs.rmSync(out, { recursive: true, force: true });
fs.cpSync(path.join(root, 'frontend/dist'), path.join(out, 'static'), { recursive: true });

const func = path.join(out, 'functions/api.func');
fs.mkdirSync(func, { recursive: true });
const skip = new Set(['node_modules', 'test', 'coverage']);
const copyApi = (from, to) => {
  fs.mkdirSync(to, { recursive: true });
  for (const name of fs.readdirSync(from)) {
    if (skip.has(name)) continue;
    const src = path.join(from, name);
    const dest = path.join(to, name);
    if (fs.statSync(src).isDirectory()) copyApi(src, dest);
    else fs.copyFileSync(src, dest);
  }
};
copyApi(path.join(root, 'server'), func);
fs.copyFileSync(path.join(root, 'scripts/vercel/function-entry.js'), path.join(func, 'index.js'));
fs.writeFileSync(path.join(func, '.vc-config.json'), JSON.stringify({
  runtime: 'nodejs22.x',
  handler: 'index.js',
  launcherType: 'Nodejs',
  shouldAddHelpers: true,
  maxDuration: 300,
  supportsResponseStreaming: true
}, null, 2));
// Fresh install inside the function so the optional Agent SDK (hundreds of MB,
// and it spawns a process Hobby cannot keep) stays out of the bundle.
run('npm', ['ci', '--omit=optional', '--omit=dev'], func);

const security = {
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'Content-Security-Policy': "frame-ancestors 'none'"
};
const config = {
  version: 3,
  crons: [{ path: '/api/cron/daily', schedule: '0 4 * * *' }],
  routes: [
    { src: '/api(?:/(.*))?', dest: '/api', headers: security },
    {
      src: '/(.*)\\.(?:js|css|json|html)$',
      headers: { ...security, 'Cache-Control': 'no-cache, must-revalidate' },
      continue: true
    },
    {
      src: '/exercise-media/(.*)',
      headers: {
        ...security,
        'Cross-Origin-Resource-Policy': 'same-origin',
        'Cache-Control': 'public, max-age=2592000, immutable'
      },
      continue: true
    },
    {
      src: '/(.*)\\.(?:png|jpe?g|gif|ico|svg|woff2?|webp|avif|mp4)$',
      headers: { ...security, 'Cache-Control': 'public, max-age=2592000, immutable' },
      continue: true
    },
    { src: '/(.*)', headers: security, continue: true },
    { handle: 'filesystem' },
    { src: '/(.*)', status: 302, headers: { Location: '/' } }
  ]
};
fs.writeFileSync(path.join(out, 'config.json'), JSON.stringify(config, null, 2));
console.log('vercel output ready', out);
