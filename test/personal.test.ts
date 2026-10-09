import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, symlinkSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PersonalAuthenticator, installationOwner } from '../src/personal-auth.js';
import { readConfiguredSecret } from '../src/private-file.js';
import { loadRuntimeConfig } from '../src/runtime-config.js';
import { loadPersonalFeishuApp } from '../src/feishu-config.js';
import { Store } from '../src/store.js';
import { fixture, mockApp } from './fixtures.js';
import { MOCK_TOKEN_A, MOCK_TOKEN_B, MOCK_INSTALL_A, personalFixture } from './personal-fixtures.js';
test('personal authentication requires the exact private credential and keeps identity stable on rotation', async () => {
  const a = new PersonalAuthenticator(MOCK_INSTALL_A, MOCK_TOKEN_A, () => 1000), rotated = new PersonalAuthenticator(MOCK_INSTALL_A, MOCK_TOKEN_B, () => 1000), other = new PersonalAuthenticator('MOCK_installation_B', MOCK_TOKEN_B, () => 1000);
  assert.equal((await a.authenticate(MOCK_TOKEN_A)).id, (await rotated.authenticate(MOCK_TOKEN_B)).id);
  assert.notEqual(a.ownerId, other.ownerId); assert.equal((await a.authenticate(MOCK_TOKEN_A)).expiresAt, 3601000);
  for (const key of [null, '', 'Bearer '+MOCK_TOKEN_A, MOCK_TOKEN_B, MOCK_TOKEN_A+', '+MOCK_TOKEN_A, 'x'.repeat(10000)]) await assert.rejects(a.authenticate(key), /unauthorized/);
  await assert.rejects(other.authenticate(MOCK_TOKEN_A)); await assert.rejects(rotated.authenticate(MOCK_TOKEN_A));
  assert.throws(() => new PersonalAuthenticator(MOCK_INSTALL_A, '')); assert.throws(() => new PersonalAuthenticator('short', MOCK_TOKEN_A));
});
test('personal is the default and rejects public binds, mixed OAuth settings and host mismatch', () => {
  const env = { INSTALLATION_ID: MOCK_INSTALL_A, BRIDGE_TOKEN: MOCK_TOKEN_A };
  const c = loadRuntimeConfig(env); assert.equal(c.mode, 'personal-tunnel'); assert.equal(c.host, '127.0.0.1'); assert.equal(c.databasePath, './data/personal.sqlite');
  for (const host of ['0.0.0.0','::','localhost','192.168.1.2','example.com']) assert.throws(() => loadRuntimeConfig({ ...env, HOST: host }), /loopback/);
  for (const mixed of [{PUBLIC_URL:'https://public.example'}, {OAUTH_ISSUER:'https://idp.example'}, {OAUTH_JWKS_URL:'https://idp.example/keys'}, {FEISHU_APPS_FILE:'apps.json'}, {ALLOWED_HOSTS:'public.example'}, {PORT:'0'}, {AUTH_MODE:'none'}]) assert.throws(() => loadRuntimeConfig({ ...env, ...mixed }));
  assert.throws(() => loadRuntimeConfig({INSTALLATION_ID:MOCK_INSTALL_A}));
  assert.equal(loadRuntimeConfig({...env,HOST:'::1'}).baseUrl, 'http://[::1]:3000');
});
test('private file credentials reject permissive files and symlinks without fallback', () => {
  const dir = mkdtempSync(join(tmpdir(), 'MOCK-personal-secret-'));
  try {
    const path = join(dir, 'token'); writeFileSync(path, MOCK_TOKEN_A+'\n', { mode: 0o600 });
    assert.equal(readConfiguredSecret({BRIDGE_TOKEN_FILE:path}, 'BRIDGE_TOKEN'), MOCK_TOKEN_A);
    assert.throws(() => readConfiguredSecret({BRIDGE_TOKEN:MOCK_TOKEN_A,BRIDGE_TOKEN_FILE:path},'BRIDGE_TOKEN'), /exactly one/);
    chmodSync(path,0o644); assert.throws(() => readConfiguredSecret({BRIDGE_TOKEN_FILE:path},'BRIDGE_TOKEN'), /owner-only/); chmodSync(path,0o600);
    const link=join(dir,'symlink'); symlinkSync(path,link); assert.throws(() => readConfiguredSecret({BRIDGE_TOKEN_FILE:link},'BRIDGE_TOKEN'), /owner-only/);
    assert.throws(() => readConfiguredSecret({BRIDGE_TOKEN_FILE:dir},'BRIDGE_TOKEN'), /owner-only/);
  } finally { rmSync(dir,{recursive:true,force:true}); }
});
test('personal app config accepts one object and rejects multi-app arrays', () => {
  const raw={appId:'cli_mock',tenantKey:'tenant',appSecretEnv:'APP_SECRET',encryptKeyEnv:'ENCRYPT_KEY',verificationTokenEnv:'VERIFY_TOKEN'};
  assert.equal(loadPersonalFeishuApp(raw,()=> 'MOCK_ONLY').appId,'cli_mock');
  assert.throws(() => loadPersonalFeishuApp([raw],()=> 'MOCK_ONLY'), /one app object/);
});
test('personal core rejects another owner/app and allows only the paired Feishu sender', () => {
  const f=personalFixture(); try {
    assert.throws(() => f.bridge.beginBinding(f.alice), /unauthorized/);
    const pair=f.bridge.beginBinding(f.owner); assert.equal(f.bridge.receive(f.message({text:pair.command,appId:'other_app'})).state,'wrong_installation');
    assert.equal(f.bridge.receive(f.message({text:pair.command,messageId:'pair'})).state,'bound');
    assert.throws(() => f.bridge.beginBinding(f.owner), /already_bound/);
    assert.equal(f.bridge.receive(f.message({openId:'ou_stranger',chatId:'oc_stranger'})).state,'unbound');
    assert.equal(f.bridge.receive(f.message({messageId:'owner_text'})).state,'accepted'); assert.equal(f.bridge.receive(f.message({messageId:'owner_text'})).state,'duplicate');
  } finally { f.store.close(); }
});
test('personal startup refuses old multi-owner data before recovering sending jobs', () => {
  const dir=mkdtempSync(join(tmpdir(),'MOCK-personal-db-')), path=join(dir,'db.sqlite'), f=fixture(path);
  try {
    f.bind();f.bridge.receive(f.message());const id=f.store.db.prepare('SELECT id FROM inbox').get()!.id as string;
    const reply=f.bridge.reply(f.alice,{event_id:id,text:'MOCK'});f.store.db.prepare("UPDATE jobs SET state='sending' WHERE id=?").run(reply.reply_id);f.store.close();
    assert.throws(() => new Store(path,{owner:installationOwner(MOCK_INSTALL_A),appId:mockApp.appId,tenantKey:mockApp.tenantKey}), /another owner/);
    // Read without Store's recovery to prove failure didn't reset/dispatch/adopt queued work.
    const { DatabaseSync } = requireSqlite();const db=new DatabaseSync(path);try { assert.equal(db.prepare('SELECT state FROM jobs').get()!.state,'sending'); } finally {db.close();}
  } finally {rmSync(dir,{recursive:true,force:true});}
});
import { DatabaseSync } from 'node:sqlite';
function requireSqlite() { return { DatabaseSync }; }
import { spawnSync } from 'node:child_process';
test('private file rejects FIFO without hanging on open', { skip: process.platform === 'win32' }, () => {
  const dir=mkdtempSync(join(tmpdir(),'MOCK-fifo-'));try {
    const fifo=join(dir,'pipe');const created=spawnSync('mkfifo',[fifo],{timeout:1000});assert.equal(created.status,0);
    const check=spawnSync(process.execPath,['--input-type=module','-e',`import {readPrivateFile} from ${JSON.stringify(new URL('../src/private-file.js',import.meta.url).href)};try{readPrivateFile(process.argv[1]);process.exitCode=2}catch{process.exitCode=0}` ,fifo],{timeout:1000});
    assert.equal(check.status,0);assert.equal(check.error,undefined);
  }finally{rmSync(dir,{recursive:true,force:true});}
});
test('explicit legacy OAuth mode preserves exact issuer and cannot mix personal credentials', () => {
  const env={AUTH_MODE:'oauth',PUBLIC_URL:'https://bridge.example',OAUTH_ISSUER:'https://idp.example/',OAUTH_JWKS_URL:'https://idp.example/keys'};
  const config=loadRuntimeConfig(env);assert.equal(config.mode,'oauth');assert.equal(config.issuer,'https://idp.example/');assert.equal(config.databasePath,'./data/bridge.sqlite');
  assert.throws(()=>loadRuntimeConfig({...env,BRIDGE_TOKEN:MOCK_TOKEN_A}),/Remove personal/);
});
