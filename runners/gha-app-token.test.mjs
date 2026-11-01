// node --test runners/gha-app-token.test.mjs
// gha-app-token.sh run in bash with a real RSA key and a stub curl on PATH (and a stub flock, which
// not every test host has): nothing reaches GitHub. Also the token choice of gha-ondemand.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync, verify } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { appToken, tokensByOwner } from './gha-ondemand.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, 'gha-app-token.sh');
const sh = (p) => p.split(String.fromCharCode(92)).join('/');

/**
 * A box with the App configured (unless `configured` is false) and a stub GitHub. `ownApp` names an
 * account given its own App (id 99, its own key, in `owner/`); `ownFiles` picks which of its two
 * files are written, `ownId` the id line.
 */
function box({ configured = true, org = false, installed = true, expiresIn = 3600, ownApp = '', ownFiles = ['env', 'pem'], ownId = 'GHA_APP_ID=99' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'app-token-'));
  const bin = join(dir, 'bin'); mkdirSync(bin);
  const ownerDir = join(dir, 'owner'); mkdirSync(ownerDir);
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const key = join(dir, 'gha-app.pem');
  const envf = join(dir, 'gha-app.env');
  if (configured) {
    writeFileSync(key, privateKey.export({ type: 'pkcs1', format: 'pem' }));
    writeFileSync(envf, 'GHA_APP_ID=42\nGHA_APP_SLUG=test-app\n');
  }
  const own = generateKeyPairSync('rsa', { modulusLength: 2048 });
  if (ownApp) {
    if (ownFiles.includes('pem')) writeFileSync(join(ownerDir, `gha-app.${ownApp}.pem`), own.privateKey.export({ type: 'pkcs1', format: 'pem' }));
    if (ownFiles.includes('env')) writeFileSync(join(ownerDir, `gha-app.${ownApp}.env`), `${ownId}\n`);
  }
  const calls = join(dir, 'calls.txt');
  const expires = new Date(Date.now() + expiresIn * 1000).toISOString().replace(/\.\d+Z$/, 'Z');
  const userAns = installed && !org ? 'echo \'{"id":7}\'' : 'exit 22';
  const orgAns = installed && org ? 'echo \'{"id":8}\'' : 'exit 22';
  // The stub records each request's method, URL, body and the header files it was given, and
  // answers like GitHub: an installation for the user (or only for the org), then a token.
  writeFileSync(join(bin, 'curl'), [
    '#!/usr/bin/env bash',
    'method=GET; url=; hdrs=; data=',
    'while [ $# -gt 0 ]; do',
    '  case "$1" in',
    '    -X) method=$2; shift ;;',
    '    -H) case "$2" in @*) hdrs="$hdrs$(cat "${2#@}")|" ;; esac; shift ;;',
    '    --data) data=$2; shift ;;',
    '    --max-time) shift ;;',
    '    -*) ;;',
    '    *) url=$1 ;;',
    '  esac; shift',
    'done',
    `echo "$method $url data=$data $hdrs" >> '${sh(calls)}'`,
    'case "$url" in',
    `  */users/*/installation) ${userAns} ;;`,
    `  */orgs/*/installation) ${orgAns} ;;`,
    `  */app/installations/*/access_tokens) echo "{\\"token\\":\\"ghs_tok_$RANDOM\\",\\"expires_at\\":\\"${expires}\\"}" ;;`,
    '  *) exit 22 ;;',
    'esac',
  ].join('\n') + '\n', { mode: 0o755 });
  writeFileSync(join(bin, 'flock'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
  const run = (...args) => {
    const r = spawnSync('bash', [SCRIPT, ...args], {
      env: { ...process.env, PATH: `${sh(bin)}:${process.env.PATH}`, GHA_APP_ENV: sh(envf), GHA_APP_KEY: sh(key), GHA_APP_OWNER_DIR: sh(ownerDir), GHA_APP_CACHE: sh(join(dir, 'cache')), GHA_API: 'https://api.test' },
      encoding: 'utf8',
    });
    return { status: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
  };
  const seen = () => (existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n') : []);
  const tokenAsks = () => seen().filter((c) => c.includes('access_tokens'));
  return { dir, bin, run, seen, tokenAsks, publicKey, ownPublicKey: own.publicKey, done: () => rmSync(dir, { recursive: true, force: true }) };
}

/** The issuer of the JWT on a token request, and whether `publicKey` verifies its signature. */
function signer(call, publicKey) {
  const [h, p, s] = /Authorization: Bearer ([\w-]+\.[\w-]+\.[\w-]+)/.exec(call)[1].split('.');
  return { iss: JSON.parse(Buffer.from(p, 'base64url').toString()).iss, ok: verify('sha256', Buffer.from(`${h}.${p}`), publicKey, Buffer.from(s, 'base64url')) };
}

test('not configured: exit 3 and nothing asked of GitHub, so the caller falls back', () => {
  const b = box({ configured: false });
  const r = b.run('askalf');
  assert.equal(r.status, 3, r.err);
  assert.equal(r.out, '');
  assert.deepEqual(b.seen(), []);
  b.done();
});

test('a token for a user installation, asked for with a JWT the App key signed', () => {
  const b = box();
  const r = b.run('askalf');
  assert.equal(r.status, 0, r.err);
  assert.match(r.out, /^ghs_tok_\d+$/);
  const calls = b.seen();
  assert.equal(calls.length, 2, calls.join('\n'));
  assert.match(calls[0], /^GET https:\/\/api\.test\/users\/askalf\/installation /);
  assert.match(calls[1], /^POST https:\/\/api\.test\/app\/installations\/7\/access_tokens data=\{\} /);
  const jwt = /Authorization: Bearer ([\w-]+\.[\w-]+\.[\w-]+)/.exec(calls[1])?.[1];
  assert.ok(jwt, 'no bearer JWT on the token request');
  const [h, p, s] = jwt.split('.');
  const payload = JSON.parse(Buffer.from(p, 'base64url').toString());
  assert.equal(payload.iss, '42');
  assert.ok(payload.exp - payload.iat <= 600, 'GitHub refuses a JWT that lives over ten minutes');
  assert.ok(verify('sha256', Buffer.from(`${h}.${p}`), b.publicKey, Buffer.from(s, 'base64url')), 'the signature does not verify with the App key');
  b.done();
});

test('a narrowed ask: one repository and the permissions named, in the token request body', () => {
  const b = box();
  assert.equal(b.run('askalf', 'dario', 'administration=write').status, 0);
  assert.equal(b.run('askalf', '-', 'actions=read,metadata=read').status, 0);
  const asks = b.tokenAsks();
  assert.match(asks[0], /data=\{"repositories":\["dario"\],"permissions":\{"administration":"write"\}\} /, asks[0]);
  assert.match(asks[1], /data=\{"permissions":\{"actions":"read","metadata":"read"\}\} /, asks[1]);
  b.done();
});

test('each ask is cached apart, and the installation id is looked up once for all of them', () => {
  const b = box();
  const a1 = b.run('askalf', 'dario', 'administration=write').out;
  const r1 = b.run('askalf', '-', 'actions=read').out;
  assert.notEqual(a1, r1, 'a narrowed token was handed out for a different ask');
  assert.equal(b.run('askalf', 'dario', 'administration=write').out, a1);
  assert.equal(b.run('askalf', '-', 'actions=read').out, r1);
  assert.equal(b.tokenAsks().length, 2);
  assert.equal(b.seen().filter((c) => c.includes('/installation ')).length, 1);
  b.done();
});

test('a cached token inside ten minutes of expiry is replaced', () => {
  const b = box({ expiresIn: 300 });
  b.run('askalf');
  b.run('askalf');
  assert.equal(b.tokenAsks().length, 2);
  b.done();
});

test('an organization installation is found at the org path', () => {
  const b = box({ org: true });
  const r = b.run('sprayberry-code', '-', 'organization_self_hosted_runners=write');
  assert.equal(r.status, 0, r.err);
  assert.match(b.tokenAsks().at(-1), /installations\/8\/access_tokens/);
  b.done();
});

test('not installed on the account: exit 4, and remembered so the next cycle asks nothing', () => {
  const b = box({ installed: false });
  const r = b.run('sprayberry-code');
  assert.equal(r.status, 4);
  assert.equal(r.out, '');
  assert.match(r.err, /not installed on sprayberry-code/);
  const asked = b.seen().length;
  assert.equal(b.run('sprayberry-code').status, 4);
  assert.equal(b.seen().length, asked, 'the second cycle asked GitHub again');
  b.done();
});

test('an account with its own App: its token comes from that App, signed with that App\'s key', () => {
  const b = box({ org: true, ownApp: 'sprayberry-code' });
  const r = b.run('sprayberry-code', '-', 'organization_self_hosted_runners=write');
  assert.equal(r.status, 0, r.err);
  const { iss, ok } = signer(b.tokenAsks().at(-1), b.ownPublicKey);
  assert.equal(iss, '99', 'the token was asked for by the runner App, not the account\'s own');
  assert.ok(ok, 'the JWT was not signed with the account\'s own key');
  assert.ok(existsSync(join(b.dir, 'cache', 'sprayberry-code.app99.inst')), 'the own App\'s installation id is not cached apart');
  b.done();
});

test('another account\'s App is never used: askalf keeps the runner App and its cache names', () => {
  const b = box({ ownApp: 'sprayberry-code' });
  const r = b.run('askalf', 'dario', 'administration=write');
  assert.equal(r.status, 0, r.err);
  const { iss, ok } = signer(b.tokenAsks().at(-1), b.publicKey);
  assert.equal(iss, '42');
  assert.ok(ok, 'the JWT was not signed with the runner App key');
  assert.ok(existsSync(join(b.dir, 'cache', 'askalf.inst')));
  b.done();
});

test('no App of its own: the account uses the runner App, exactly as before', () => {
  const b = box({ org: true });
  assert.equal(b.run('sprayberry-code', '-', 'organization_self_hosted_runners=write').status, 0);
  assert.equal(signer(b.tokenAsks().at(-1), b.publicKey).iss, '42');
  assert.ok(existsSync(join(b.dir, 'cache', 'sprayberry-code.inst')));
  b.done();
});

test('the runner App\'s "not installed" answer is not reused once the account has its own App', () => {
  const b = box({ installed: false });
  assert.equal(b.run('sprayberry-code').status, 4);
  const ownerDir = join(b.dir, 'owner');
  const own = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' });
  writeFileSync(join(ownerDir, 'gha-app.sprayberry-code.pem'), own);
  writeFileSync(join(ownerDir, 'gha-app.sprayberry-code.env'), 'GHA_APP_ID=99\n');
  const asked = b.seen().length;
  assert.equal(b.run('sprayberry-code').status, 4);
  assert.ok(b.seen().length > asked, 'the own App took the runner App\'s cached answer instead of asking');
  b.done();
});

test('half an own App (one file without the other, or no id): exit 1, and the runner App is not used', () => {
  for (const [ownFiles, ownId, want] of [[['env'], 'GHA_APP_ID=99', /needs both/], [['pem'], 'GHA_APP_ID=99', /needs both/], [['env', 'pem'], 'GHA_APP_SLUG=x', /no numeric GHA_APP_ID/]]) {
    const b = box({ org: true, ownApp: 'sprayberry-code', ownFiles, ownId });
    const r = b.run('sprayberry-code', '-', 'organization_self_hosted_runners=write');
    assert.equal(r.status, 1, `${ownFiles} ${ownId}: ${r.err}`);
    assert.equal(r.out, '');
    assert.match(r.err, want);
    assert.deepEqual(b.seen(), [], 'GitHub was asked with the runner App instead');
    b.done();
  }
});

test('a failed token request forgets the installation id, so the next run looks it up again', () => {
  const b = box();
  b.run('askalf');
  writeFileSync(join(b.bin, 'curl'), '#!/usr/bin/env bash\nexit 22\n', { mode: 0o755 });
  const r = b.run('askalf', 'dario', 'administration=write');
  assert.equal(r.status, 1);
  assert.equal(r.out, '');
  assert.ok(!existsSync(join(b.dir, 'cache', 'askalf.inst')));
  b.done();
});

test('arguments that are not a GitHub login, repository or permission list are refused first', () => {
  const b = box();
  for (const args of [['../etc'], ['a b'], ['x;y'], ['askalf', '../x'], ['askalf', '.git'], ['askalf', 'dario', 'administration=admin'], ['askalf', 'dario', 'administration=write}'], ['askalf', '-', 'a=read,']]) {
    const r = b.run(...args);
    assert.equal(r.status, 1, args.join(' '));
    assert.equal(r.out, '');
  }
  assert.deepEqual(b.seen(), []);
  b.done();
});

test('gha-ondemand: the App token per owner where there is one, the fallback elsewhere', async () => {
  const m = await tokensByOwner(['askalf/dario', 'askalf/ci', 'other/repo'], 'pat', async (o) => (o === 'askalf' ? 'ghs_app' : ''));
  assert.deepEqual(m.get('askalf'), { tok: 'ghs_app', source: 'app' });
  assert.deepEqual(m.get('other'), { tok: 'pat', source: 'GITHUB_TOKEN' });
  assert.equal(m.size, 2, 'one token per owner, not per repository');
});

test('gha-ondemand: asks for actions=read, and keeps the answer five minutes', async () => {
  const asked = [];
  let t = 1_000_000;
  const run = async (_cmd, args) => { asked.push(args.join(' ')); return `tok${asked.length}`; };
  const now = () => t;
  assert.equal(await appToken('memo-owner', { run, now }), 'tok1');
  t += 4 * 60 * 1000;
  assert.equal(await appToken('memo-owner', { run, now }), 'tok1');
  t += 2 * 60 * 1000;
  assert.equal(await appToken('memo-owner', { run, now }), 'tok2');
  assert.deepEqual(asked, ['memo-owner - actions=read', 'memo-owner - actions=read']);
});
