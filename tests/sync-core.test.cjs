const test = require('node:test');
const assert = require('node:assert/strict');
const DesignSync = require('../sync-core.js');

const clone = value => JSON.parse(JSON.stringify(value));
const design = value => ({ version: 1, rooms: [{ id: 'room', value }] });
const row = (value, revision = 1) => ({ revision, content: design(value), updated_at: `time-${revision}`, plan_id: 'home' });
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function memory() {
  const data = new Map();
  return { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value), data };
}
function fixture(t, overrides = {}) {
  const state = { local: design('local'), remote: null, editing: false, reads: 0, writes: [], applied: [], backups: [], statuses: [] };
  const storage = overrides.storage || memory();
  const options = {
    readLocal: () => clone(state.local),
    applyRemote: content => { state.local = clone(content); state.applied.push(clone(content)); },
    validate: content => content.version === 1 && Array.isArray(content.rooms),
    isEditing: () => state.editing,
    readRemote: async () => { state.reads++; return clone(state.remote); },
    writeRemote: async request => {
      state.writes.push(clone(request));
      if (request.expectedRevision !== (state.remote?.revision || 0)) return { applied: false, design: clone(state.remote) };
      state.remote = { revision: request.expectedRevision + 1, content: clone(request.content), updated_at: 'now', plan_id: 'home' };
      return { applied: true, design: clone(state.remote) };
    },
    storage, storageKey: 'user-a:home:tab-a', pristine: false,
    onStatus: status => state.statuses.push(status),
    backup: (content, reason) => { state.backups.push({ content, reason }); return true; },
    ...overrides
  };
  const engine = new DesignSync(options);
  t.after(() => engine.stop());
  return { state, storage, engine, options, change(value) { state.local = design(value); engine.changed(); } };
}

test('first upload reads first and creates revision 1', async t => {
  const f = fixture(t);
  await f.engine.start();
  assert.equal(f.state.reads, 1);
  assert.equal(f.state.writes[0].expectedRevision, 0);
  assert.deepEqual(f.state.remote.content, f.state.local);
  assert.equal(f.engine.getStatus().kind, 'synced');
});

test('pristine device downloads existing design without uploading it back', async t => {
  const f = fixture(t, { pristine: true });
  f.state.remote = row('cloud', 8);
  const apply = f.options.applyRemote;
  f.options.applyRemote = content => { apply(content); f.engine.changed(); };
  await f.engine.start();
  await f.engine.sync();
  assert.deepEqual(f.state.local, design('cloud'));
  assert.equal(f.state.writes.length, 0);
  assert.equal(f.engine.getStatus().revision, 8);
});

test('different initial local content has a conflict when no shared base exists', async t => {
  const f = fixture(t);
  f.state.remote = row('cloud');
  await f.engine.start();
  assert.equal(f.engine.getStatus().kind, 'conflict');
  assert.deepEqual(f.state.local, design('local'));
  assert.equal(f.state.writes.length, 0);
});

test('jsonb object key ordering is ignored', async t => {
  const f = fixture(t);
  f.state.remote = { ...row('local'), content: { rooms: [{ value: 'local', id: 'room' }], version: 1 } };
  await f.engine.start();
  assert.equal(f.engine.getStatus().kind, 'synced');
  assert.equal(f.state.writes.length, 0);
});

test('offline changes survive a reload and synchronize on reconnection', async t => {
  const storage = memory();
  const f = fixture(t, { storage });
  await f.engine.start();
  f.options.readRemote = async () => { throw new Error('offline'); };
  f.change('offline edit');
  await f.engine.sync();
  assert.equal(f.engine.getStatus().kind, 'offline');
  f.engine.stop();
  const next = fixture(t, { storage });
  next.state.remote = clone(f.state.remote);
  next.state.local = clone(f.state.remote.content);
  await next.engine.start();
  assert.deepEqual(next.state.local, design('offline edit'));
  assert.deepEqual(next.state.remote.content, design('offline edit'));
  assert.equal(next.engine.getStatus().kind, 'synced');
  assert.equal(JSON.parse(storage.getItem(next.options.storageKey)).pending, null);
});

test('pending drafts are isolated by account and plan key', async t => {
  const storage = memory();
  const f = fixture(t, { storage, readRemote: async () => { throw new Error('offline'); } });
  await f.engine.start();
  f.change('private account A draft');
  f.engine.stop();
  const other = fixture(t, { storage, storageKey: 'user-b:home:tab-a', pristine: true });
  other.state.remote = row('account B cloud');
  await other.engine.start();
  assert.deepEqual(other.state.local, design('account B cloud'));
  assert.deepEqual(JSON.parse(storage.getItem(f.options.storageKey)).pending, design('private account A draft'));
});

test('changes during an in-flight write remain pending and are uploaded next', async t => {
  const f = fixture(t);
  await f.engine.start();
  const gate = deferred();
  const write = f.options.writeRemote;
  f.options.writeRemote = async request => { const result = await write(request); await gate.promise; return result; };
  f.change('first edit');
  const saving = f.engine.sync();
  await new Promise(resolve => setImmediate(resolve));
  f.change('second edit');
  gate.resolve();
  await saving;
  assert.deepEqual(f.state.local, design('second edit'));
  assert.deepEqual(JSON.parse(f.storage.getItem(f.options.storageKey)).pending, design('second edit'));
  assert.equal(f.engine.getStatus().kind, 'pending');
  await f.engine.sync();
  assert.deepEqual(f.state.remote.content, design('second edit'));
});

test('unknown write result is recognized by content before retrying', async t => {
  const f = fixture(t);
  await f.engine.start();
  const write = f.options.writeRemote;
  f.options.writeRemote = async request => { await write(request); throw new Error('response lost'); };
  f.change('saved but response lost');
  await f.engine.sync();
  assert.equal(f.engine.getStatus().kind, 'offline');
  const count = f.state.writes.length;
  await f.engine.sync();
  assert.equal(f.engine.getStatus().kind, 'synced');
  assert.equal(f.state.writes.length, count);
});

test('CAS failure never silently overwrites an intervening cloud update', async t => {
  const f = fixture(t);
  await f.engine.start();
  const write = f.options.writeRemote;
  f.options.writeRemote = async request => { f.state.remote = row('other device', 2); return write(request); };
  f.change('my edit');
  await f.engine.sync();
  assert.equal(f.engine.getStatus().kind, 'conflict');
  assert.deepEqual(f.state.remote.content, design('other device'));
  assert.deepEqual(f.state.local, design('my edit'));
});

test('local conflict resolution uses exactly the revision the user reviewed', async t => {
  const f = fixture(t);
  f.state.remote = row('cloud', 4);
  await f.engine.start();
  f.state.remote = row('unseen new cloud', 5);
  await f.engine.resolve('local');
  assert.equal(f.state.writes[0].expectedRevision, 4);
  assert.equal(f.state.reads, 1);
  assert.equal(f.engine.getStatus().kind, 'conflict');
  assert.equal(f.engine.getStatus().remote.revision, 5);
  assert.deepEqual(f.state.backups[0].content, design('cloud'));
  assert.deepEqual(f.state.remote.content, design('unseen new cloud'));
});

test('remote conflict resolution backs up local content before applying', async t => {
  const f = fixture(t);
  f.state.remote = row('cloud', 4);
  await f.engine.start();
  await f.engine.resolve('remote');
  assert.deepEqual(f.state.backups, [{ content: design('local'), reason: 'local-before-cloud' }]);
  assert.deepEqual(f.state.local, design('cloud'));
  assert.equal(f.engine.getStatus().kind, 'synced');
  assert.equal(f.state.writes.length, 0);
});

test('failed backup blocks both destructive conflict choices', async t => {
  for (const choice of ['local', 'remote']) {
    const f = fixture(t, { backup: () => false });
    f.state.remote = row('cloud');
    await f.engine.start();
    await f.engine.resolve(choice);
    assert.equal(f.engine.getStatus().kind, 'conflict');
    assert.deepEqual(f.state.local, design('local'));
    assert.deepEqual(f.state.remote.content, design('cloud'));
    assert.equal(f.state.writes.length, 0);
  }
});

test('edits made while remote resolution awaits backup are not overwritten', async t => {
  const gate = deferred();
  const f = fixture(t, { backup: () => gate.promise });
  f.state.remote = row('cloud');
  await f.engine.start();
  const resolving = f.engine.resolve('remote');
  await new Promise(resolve => setImmediate(resolve));
  f.change('new edit during backup');
  gate.resolve(true);
  await resolving;
  assert.deepEqual(f.state.local, design('new edit during backup'));
  assert.equal(f.state.applied.length, 0);
  assert.equal(f.engine.getStatus().kind, 'conflict');
});

test('dragging or input prevents uploads and remote application, including an in-flight read', async t => {
  const f = fixture(t, { pristine: true });
  const gate = deferred();
  f.options.readRemote = () => gate.promise;
  const connecting = f.engine.start();
  await new Promise(resolve => setImmediate(resolve));
  f.state.editing = true;
  gate.resolve(row('cloud'));
  await connecting;
  assert.equal(f.state.applied.length, 0);
  assert.equal(f.state.writes.length, 0);
  f.state.editing = false;
  await f.engine.sync();
  assert.deepEqual(f.state.local, design('cloud'));
  f.state.editing = true;
  f.change('drag edit');
  await f.engine.sync();
  assert.equal(f.state.writes.length, 0);
});

test('stopped engine ignores pending read and write responses', async t => {
  const readGate = deferred();
  const f = fixture(t, { pristine: true, readRemote: () => readGate.promise });
  const connecting = f.engine.start();
  await new Promise(resolve => setImmediate(resolve));
  f.engine.stop();
  const statuses = f.state.statuses.length;
  readGate.resolve(row('cloud'));
  await connecting;
  assert.equal(f.state.applied.length, 0);
  assert.equal(f.state.statuses.length, statuses);

  const next = fixture(t);
  await next.engine.start();
  const writeGate = deferred();
  next.options.writeRemote = () => writeGate.promise;
  next.change('pending');
  const saving = next.engine.sync();
  await new Promise(resolve => setImmediate(resolve));
  next.engine.stop();
  const before = next.storage.getItem(next.options.storageKey);
  writeGate.resolve({ applied: true, design: row('pending', 2) });
  await saving;
  assert.equal(next.storage.getItem(next.options.storageKey), before);
});

test('invalid remote content preserves local draft', async t => {
  const f = fixture(t, { pristine: true });
  f.state.remote = { ...row('cloud'), content: { version: 999 } };
  await f.engine.start();
  assert.equal(f.engine.getStatus().kind, 'error');
  assert.deepEqual(f.state.local, design('local'));
  assert.equal(f.state.writes.length, 0);
});

test('storage failures are visible and prevent false safe/synced claims', async t => {
  const f = fixture(t);
  await f.engine.start();
  const setItem = f.storage.setItem;
  f.storage.setItem = () => { throw new Error('quota'); };
  f.change('not durably stored');
  assert.equal(f.engine.getStatus().kind, 'error');
  const writes = f.state.writes.length;
  await f.engine.sync();
  assert.equal(f.engine.getStatus().kind, 'error');
  assert.equal(f.state.writes.length, writes);
  f.storage.setItem = setItem;
  await f.engine.sync();
  assert.deepEqual(f.state.remote.content, design('not durably stored'));
  assert.equal(f.engine.getStatus().kind, 'synced');
});

test('concurrent sync calls share one network request and execute serially', async t => {
  const gate = deferred();
  let calls = 0, concurrent = 0, maxConcurrent = 0;
  const f = fixture(t, { pristine: true, readRemote: async () => {
    calls++; concurrent++; maxConcurrent = Math.max(concurrent, maxConcurrent);
    await gate.promise;
    concurrent--;
    return row('cloud');
  } });
  const a = f.engine.start();
  const b = f.engine.sync();
  const c = f.engine.sync();
  assert.equal(a, b);
  assert.equal(b, c);
  gate.resolve();
  await Promise.all([a, b, c]);
  assert.equal(maxConcurrent, 1);
  assert.ok(calls <= 2);
});

test('an unchanged local device pulls later remote edits', async t => {
  const f = fixture(t);
  await f.engine.start();
  f.state.remote = row('changed on phone', 2);
  await f.engine.sync();
  assert.deepEqual(f.state.local, design('changed on phone'));
  assert.equal(f.state.writes.length, 1);
  assert.equal(f.engine.getStatus().revision, 2);
});

test('validator-returned canonical content is used for comparison and upload', async t => {
  const f = fixture(t, { validate: content => ({ version: 1, rooms: content.rooms }) });
  f.state.local.debugOnly = true;
  await f.engine.start();
  assert.equal(f.state.remote.content.debugOnly, undefined);
  assert.deepEqual(f.state.remote.content, design('local'));
  f.state.remote = { ...row('local', 2), content: { ...design('local'), discardedRemoteField: true } };
  await f.engine.sync();
  assert.equal(f.engine.getStatus().kind, 'synced');
  assert.equal(f.state.writes.length, 1);
});

test('a restored pending draft cannot overwrite a distinct newer local design', async t => {
  const storage = memory();
  const saved = JSON.stringify({ version: 1, baseRevision: 1, baseContent: design('base'), pending: design('old pending') });
  storage.setItem('user-a:home:tab-a', saved);
  const f = fixture(t, { storage });
  f.state.local = design('edited while signed out');
  f.state.remote = row('base');
  await f.engine.start();
  assert.equal(f.engine.getStatus().kind, 'error');
  assert.deepEqual(f.state.local, design('edited while signed out'));
  assert.equal(storage.getItem(f.options.storageKey), saved);
  f.change('yet another local edit');
  await f.engine.sync();
  assert.equal(storage.getItem(f.options.storageKey), saved);
  assert.equal(f.state.reads, 0);
  assert.equal(f.state.applied.length, 0);
  // Explicitly importing the preserved draft allows synchronization to resume.
  f.state.local = design('old pending');
  await f.engine.sync();
  assert.equal(f.engine.getStatus().kind, 'synced');
  assert.deepEqual(f.state.remote.content, design('old pending'));
});

test('unknown write with subsequent edits is confirmed after reload before saving the new draft', async t => {
  const f = fixture(t);
  await f.engine.start();
  const gate = deferred();
  const write = f.options.writeRemote;
  f.options.writeRemote = async request => { await write(request); await gate.promise; throw new Error('lost response'); };
  f.change('first saved edit');
  const saving = f.engine.sync();
  await new Promise(resolve => setImmediate(resolve));
  f.change('newer pending edit');
  gate.resolve();
  await saving;
  assert.equal(f.engine.getStatus().kind, 'offline');
  f.engine.stop();
  const next = fixture(t, { storage: f.storage });
  next.state.remote = clone(f.state.remote);
  next.state.local = clone(f.state.local);
  await next.engine.start();
  assert.equal(next.engine.getStatus().kind, 'synced');
  assert.deepEqual(next.state.remote.content, design('newer pending edit'));
  assert.equal(next.state.writes[0].expectedRevision, 2);
});

test('a backup without an explicit success result cannot discard a version', async t => {
  const f = fixture(t, { backup: () => undefined });
  f.state.remote = row('cloud');
  await f.engine.start();
  await f.engine.resolve('remote');
  assert.equal(f.engine.getStatus().kind, 'conflict');
  assert.deepEqual(f.state.local, design('local'));
});

test('local conflict resolution stays visible if editing starts during backup', async t => {
  const gate = deferred();
  const f = fixture(t, { backup: () => gate.promise });
  f.state.remote = row('cloud');
  await f.engine.start();
  const resolving = f.engine.resolve('local');
  await new Promise(resolve => setImmediate(resolve));
  f.state.editing = true;
  gate.resolve(true);
  await resolving;
  assert.equal(f.engine.getStatus().kind, 'conflict');
  assert.equal(f.state.writes.length, 0);
  f.state.editing = false;
  await f.engine.resolve('local');
  assert.equal(f.engine.getStatus().kind, 'synced');
});

test('a storage error during a conflict recovers without losing the conflict', async t => {
  const f = fixture(t);
  f.state.remote = row('cloud');
  await f.engine.start();
  const setItem = f.storage.setItem;
  f.storage.setItem = () => { throw new Error('full'); };
  f.change('edited during conflict');
  await f.engine.sync();
  assert.equal(f.engine.getStatus().kind, 'error');
  f.storage.setItem = setItem;
  await f.engine.sync();
  assert.equal(f.engine.getStatus().kind, 'conflict');
  assert.deepEqual(JSON.parse(f.storage.getItem(f.options.storageKey)).pending, design('edited during conflict'));
});

test('restarting an engine cannot apply the previous generation response', async t => {
  const oldRead = deferred();
  const f = fixture(t, { pristine: true, readRemote: () => oldRead.promise });
  const previous = f.engine.start();
  await new Promise(resolve => setImmediate(resolve));
  f.engine.stop();
  f.options.readRemote = async () => row('new session', 3);
  await f.engine.start();
  oldRead.resolve(row('stale session', 1));
  await previous;
  assert.deepEqual(f.state.local, design('new session'));
  assert.equal(f.engine.getStatus().revision, 3);
});
