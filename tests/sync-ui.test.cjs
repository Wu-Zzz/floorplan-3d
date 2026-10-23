const assert = require('node:assert/strict');
const { webcrypto } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const test = require('node:test');
const DesignSync = require('../sync-core.js');

const clone = value => structuredClone(value);
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const source = readFileSync(resolve(__dirname, '../sync-ui.js'), 'utf8');
const appSource = readFileSync(resolve(__dirname, '../index.html'), 'utf8');
const languageSource = appSource.slice(appSource.indexOf('const LANG_KEY ='), appSource.indexOf('const exportName ='));
// Execute the production UI and sync engine. Only the CDN dependency, browser
// surfaces, timers, and network transport are replaced; no cloud account is used.
const uiSource = source.replace(
  /await import\('https:\/\/cdn\.jsdelivr\.net\/npm\/@supabase\/supabase-js@[^']+\/\+esm'\)/,
  '({createClient:() => clientStub})',
);
assert.notEqual(uiSource, source, 'The Supabase import must be replaced for an offline test.');

function memory(initial = []) {
  const data = new Map(initial);
  return {
    getItem: key => data.get(key) ?? null,
    setItem: (key, value) => data.set(key, value),
    removeItem: key => data.delete(key),
    key: index => [...data.keys()][index],
    get length() { return data.size; },
    entries: () => [...data],
  };
}

function deferred() {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
}

function locks() {
  const held = new Set();
  return {
    request(name, _options, callback) {
      if (held.has(name)) return Promise.resolve(callback(null));
      held.add(name);
      return Promise.resolve().then(() => callback({ name })).finally(() => held.delete(name));
    },
  };
}

const design = name => ({
  planId: 'home', furniture: [], rooms: { living: { name, mat: 'wood' } },
  demolished: [], measures: [],
});
const row = name => ({ revision: 1, content: design(name), plan_id: 'home', updated_at: '2026-10-23T00:00:00Z' });
const session = id => ({ user: { id, email: `${id.toLowerCase()}@example.test` }, access_token: `test-token-${id}` });

async function fixture(t, settings = {}) {
  const storage = settings.storage || memory();
  const sessionStorage = settings.sessionStorage || memory();
  const handlers = new Map(), elements = new Map(), timers = new Set();
  const f = {
    local: JSON.parse(storage.getItem('home-design') || 'null') || design('A base'), session: session('A'),
    rows: { A: row('A base'), B: row('B private') }, writes: [],
    readGate: null, writeGate: null, storage, sessionStorage, downloads: [],
  };
  function element(key) {
    if (!elements.has(key)) elements.set(key, {
      dataset: {}, children: [], open: false,
      setAttribute() {}, replaceChildren() { this.children = []; },
      append(child) { this.children.push(child); },
      click() { if (this.href) f.downloads.push({url:this.href,name:this.download}); },
      querySelector: element,
      showModal() { this.open = true; }, close() { this.open = false; },
    });
    return elements.get(key);
  }
  const language = new Function('localStorage', languageSource + '\nreturn {text:tr, set:value => {LANG = value;}};')(storage);
  language.set(settings.language || 'zh');
  const app = {
    text: language.text, read: () => clone(f.local),
    validate(content) {
      if (!content || !Array.isArray(content.furniture)) throw new Error('Invalid test design');
      return clone(content);
    },
    isEditing: () => false, isPristine: () => false,
    storageKey: 'home-design', planId: 'home', exportPlan() {},
    applyRemote(content) { f.local = clone(content); storage.setItem('home-design', JSON.stringify(content)); },
  };
  const window = {
    FloorplanApp: app, DesignSync,
    FLOORPLAN_CLOUD: { url: 'https://test.supabase.co', publishableKey: 'sb_publishable_test' },
    addEventListener: (name, callback) => handlers.set(name, callback),
  };
  const document = {
    createElement: tag => element(Symbol(tag)), querySelector: element, body: { append() {} },
    documentElement: { lang: 'zh-CN' }, hidden: false,
    addEventListener: (name, callback) => handlers.set(name, callback),
  };
  let authChanged;
  const clientStub = {
    auth: {
      onAuthStateChange(callback) { authChanged = callback; },
      getSession: async () => ({ data: { session: f.session }, error: null }),
    },
    from() {
      let owner;
      const query = {
        select() { return query; },
        eq(key, value) { if (key === 'owner_id') owner = value; return query; },
        maybeSingle() { return query; },
        abortSignal() {
          return f.readGate?.promise || Promise.resolve({
            data: owner === f.session?.user.id ? clone(f.rows[owner] || null) : null,
            error: null,
          });
        },
      };
      return query;
    },
    rpc(_name, args) {
      return {
        async abortSignal() {
          if (f.writeGate) await f.writeGate.promise;
          const owner = f.session?.user.id;
          const call = { owner, args: clone(args), applied: false };
          f.writes.push(call);
          // Model the database RPC's explicit request-owner guard. Its SQL
          // implementation is separately exercised in cloud-database.test.cjs.
          if (!owner || args.p_owner_id !== owner) {
            return { data: null, error: { code: '42501', message: 'Account changed' } };
          }
          const current = f.rows[owner];
          call.applied = args.p_expected_revision === (current?.revision || 0);
          if (call.applied) f.rows[owner] = {
            plan_id: 'home', revision: args.p_expected_revision + 1,
            content: clone(args.p_content), updated_at: '2026-10-23T01:00:00Z',
          };
          return { data: { applied: call.applied, design: clone(f.rows[owner] || null) }, error: null };
        },
      };
    },
  };
  const schedule = (callback, delay) => {
    const timer = setTimeout(() => { timers.delete(timer); callback(); }, delay);
    timer.unref(); timers.add(timer); return timer;
  };
  const cancel = timer => { clearTimeout(timer); timers.delete(timer); };
  const run = new AsyncFunction(
    'window', 'document', 'localStorage', 'sessionStorage', 'crypto', 'navigator',
    'location', 'clientStub', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout',
    uiSource + '\nreturn { getEngine: () => engine, getStatus: () => status, showStatus: next => engine.options.onStatus(next), messageCodes: Object.keys(statusMessages) };',
  );
  f.ui = await run(window, document, storage, sessionStorage, webcrypto,
    settings.navigator || { locks: settings.locks || locks() },
    { origin: 'https://example.test', pathname: '/' }, clientStub,
    () => 1, () => {}, schedule, cancel);
  f.emit = (name, event = {}) => handlers.get(name)?.(event);
  f.element = key => element('#' + key);
  f.setLanguage = value => {
    language.set(value);
    document.documentElement.lang = {zh:'zh-CN',zht:'zh-TW',en:'en'}[value];
    f.emit('designlanguagechange');
  };
  f.auth = (next, event = 'SIGNED_IN') => {
    f.session = next;
    authChanged(event, next);
  };
  f.change = name => {
    f.local = design(name);
    storage.setItem('home-design', JSON.stringify(f.local));
    f.emit('designchange');
  };
  t.after(() => {
    f.emit('pagehide');
    for (const timer of timers) clearTimeout(timer);
  });
  return f;
}

test('account change stops the old engine before its in-flight read can write', async t => {
  const f = await fixture(t);
  const engine = f.ui.getEngine();
  f.change('A private edit');
  f.readGate = deferred();
  const syncing = engine.sync();
  await new Promise(setImmediate);
  f.auth(session('B'));
  f.readGate.resolve({ data: clone(f.rows.A), error: null });
  await syncing;
  assert.equal(f.writes.length, 0, 'The old account must not reach RPC before deferred auth initialization.');
  assert.deepEqual(f.rows.B.content, design('B private'));
  const draft = f.storage.entries().find(([key]) => key.startsWith('home-design-cloud-A-'));
  assert.deepEqual(JSON.parse(draft[1]).pending, design('A private edit'));
});

test('a queued RPC retains its original owner when the SDK token changes', async t => {
  const f = await fixture(t);
  const engine = f.ui.getEngine();
  f.change('A private edit');
  f.writeGate = deferred();
  const syncing = engine.sync();
  await new Promise(setImmediate);
  f.auth(session('B'));
  f.writeGate.resolve();
  await syncing;
  assert.equal(f.writes.length, 1);
  assert.equal(f.writes[0].owner, 'B');
  assert.equal(f.writes[0].args.p_owner_id, 'A');
  assert.equal(f.writes[0].applied, false);
  assert.deepEqual(f.rows.B.content, design('B private'));
  assert.deepEqual(f.rows.A.content, design('A base'));
});

test('refreshing a token for the same account leaves sync active', async t => {
  const f = await fixture(t);
  const engine = f.ui.getEngine();
  f.auth({ ...session('A'), access_token: 'refreshed-A' }, 'TOKEN_REFRESHED');
  f.change('A after refresh');
  await engine.sync();
  assert.equal(f.ui.getEngine(), engine);
  assert.deepEqual(f.rows.A.content, design('A after refresh'));
});

test('copied sessionStorage cannot give two active tabs the same draft key', async t => {
  const sharedLocks = locks(), sharedStorage = memory();
  const first = await fixture(t, { locks: sharedLocks, storage: sharedStorage });
  const second = await fixture(t, {
    locks: sharedLocks, storage: sharedStorage,
    sessionStorage: memory(first.sessionStorage.entries()),
  });
  assert.notEqual(first.sessionStorage.getItem('floorplan-sync-tab'), second.sessionStorage.getItem('floorplan-sync-tab'));
  first.change('First independent draft');
  second.change('Second independent draft');
  const drafts = sharedStorage.entries().filter(([key]) => key.startsWith('home-design-cloud-A-'));
  assert.equal(drafts.length, 2);
  assert.deepEqual(new Set(drafts.map(([, value]) => JSON.parse(value).pending.rooms.living.name)),
    new Set(['First independent draft', 'Second independent draft']));
});

test('returning from the page cache reclaims the tab and resumes synchronization', async t => {
  const f = await fixture(t);
  const originalTabId = f.sessionStorage.getItem('floorplan-sync-tab');
  f.emit('pagehide');
  f.rows.A = { ...row('Changed on phone'), revision: 2 };
  await new Promise(setImmediate);
  await f.emit('pageshow', { persisted: true });
  assert.equal(f.sessionStorage.getItem('floorplan-sync-tab'), originalTabId);
  assert.deepEqual(f.local, design('Changed on phone'));
  assert.equal(f.ui.getStatus().kind, 'synced');
});

test('reload without Web Locks reuses the pending draft and its base revision', async t => {
  const storage = memory(), sessionStorage = memory();
  const first = await fixture(t, {storage,sessionStorage,navigator:{}});
  const tabId = sessionStorage.getItem('floorplan-sync-tab');
  first.change('Offline edit before reload');
  first.emit('pagehide');
  const reloaded = await fixture(t, {storage,sessionStorage,navigator:{}});
  assert.equal(sessionStorage.getItem('floorplan-sync-tab'), tabId);
  assert.equal(reloaded.ui.getStatus().kind, 'synced');
  assert.equal(reloaded.writes.length, 1);
  assert.equal(reloaded.writes[0].args.p_expected_revision, 1);
  assert.deepEqual(reloaded.rows.A.content, design('Offline edit before reload'));
  assert.equal(storage.entries().filter(([key]) => key.startsWith('home-design-cloud-A-')).length, 1);
});

for (const raw of [
  JSON.stringify({version:1,pending:{unreadable:true},baseRevision:1,baseContent:design('A base')}),
  '{malformed draft JSON',
]) {
  test('recheck preserves an unreadable draft verbatim and makes it downloadable: ' + raw.slice(0,30), async t => {
    const key = 'home-design-cloud-A-existing-tab';
    const storage = memory([[key,raw]]);
    const f = await fixture(t, {
      storage,sessionStorage:memory([['floorplan-sync-tab','existing-tab']]),navigator:{},
    });
    assert.equal(f.ui.getStatus().kind, 'error');
    await f.element('cloudRecheck').onclick();
    assert.equal(f.ui.getStatus().kind, 'synced');
    assert.equal(f.writes.length, 0, 'Recovery must compare with the existing cloud design before writing.');
    const backups = JSON.parse(storage.getItem('home-design-sync-backups'));
    const archived = backups.find(record => record.rawDraft != null);
    assert.equal(archived.rawDraft, raw);
    assert.equal(archived.sourceKey, key);
    assert.deepEqual(backups.find(record => record.reason === 'before-recheck').content, design('A base'));
    assert.equal(JSON.parse(storage.getItem(key)).pending, null);
    f.element('cloudSyncButton').onclick();
    const rawButton = f.element('cloudRecoveryList').children.find(button => button.textContent.includes('原始记录'));
    assert.ok(rawButton, 'The archived raw draft must be reachable from the recovery panel.');
    rawButton.onclick();
    assert.equal(await (await fetch(f.downloads.at(-1).url)).text(), raw);
  });
}

test('a failed raw-draft backup leaves the invalid draft key and engine intact', async t => {
  const key = 'home-design-cloud-A-existing-tab', raw = '{malformed draft JSON';
  const storage = memory([[key,raw]]), save = storage.setItem;
  let backupWrites = 0;
  storage.setItem = (name, value) => {
    if (name === 'home-design-sync-backups' && ++backupWrites === 2) throw new Error('Storage full');
    return save(name,value);
  };
  const f = await fixture(t, {
    storage,sessionStorage:memory([['floorplan-sync-tab','existing-tab']]),navigator:{},language:'en',
  });
  const engine = f.ui.getEngine();
  await f.element('cloudRecheck').onclick();
  assert.equal(storage.getItem(key), raw);
  assert.equal(f.ui.getEngine(), engine);
  assert.equal(f.ui.getStatus().kind, 'error');
  assert.equal(f.writes.length, 0);
  assert.equal(f.element('cloudMessage').textContent, 'Could not create a backup. Export your local design first.');
});

test('all sync-engine explanations render in English and update when language changes', async t => {
  const f = await fixture(t, {language:'en'});
  for (const messageCode of f.ui.messageCodes) {
    f.ui.showStatus({kind:'error',messageCode});
    assert.ok(f.element('cloudTime').textContent.length > 10, messageCode);
    assert.doesNotMatch(f.element('cloudTime').textContent, /[\u3400-\u9fff]/, messageCode);
    assert.equal(f.element('cloudMessage').textContent, f.element('cloudTime').textContent, messageCode);
  }
  f.ui.showStatus({kind:'error',messageCode:'draft-mismatch'});
  assert.equal(f.element('cloudTime').textContent, 'The current design differs from the pending draft. Export both designs, then import the version you want to continue.');
  f.setLanguage('zht');
  assert.equal(f.element('cloudTime').textContent, '當前方案與待同步草稿不同。請先導出兩份方案，再導入要繼續的版本。');
  assert.equal(f.element('cloudMessage').textContent, f.element('cloudTime').textContent);
  f.ui.showStatus({kind:'error',messageCode:'draft-storage-failed'});
  assert.equal(f.element('cloudTime').textContent, '瀏覽器無法保存待同步草稿，請先導出方案並釋放存儲空間。');
  f.ui.showStatus({kind:'conflict',messageCode:'backup-failed'});
  assert.equal(f.element('cloudTime').textContent, '備份未成功，尚未覆蓋任何版本。請先導出備份。');
  assert.equal(f.element('cloudMessage').textContent, '', 'A resolved error must not leave stale recovery instructions in another language.');
});
