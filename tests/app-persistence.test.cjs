const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const DesignSync = require('../sync-core.js');

const html = readFileSync(resolve(__dirname, '../index.html'), 'utf8');
const saveStart = html.indexOf('function save(notifyCloud = true){');
const appStart = html.indexOf('window.FloorplanApp = {');
assert.ok(saveStart > 0 && appStart > saveStart);
// Exercise the production save and app adapter with synthetic browser storage.
const source = html.slice(saveStart, html.indexOf('const snap =', saveStart))
  + html.slice(appStart, html.indexOf('\n};', appStart) + 3);
const clone = value => JSON.parse(JSON.stringify(value));
const design = name => ({ planId: 'home', furniture: [], rooms: { living: { name } }, demolished: [], measures: [] });

function browser(storage, nativeValidation = false) {
  const context = {
    window: {}, PLAN: { id: 'home' }, STORE: 'home-design',
    state: JSON.parse(storage.getItem('home-design')),
    localStorage: storage, persistence: {},
    ui: { sel: 'selected', mA: 'measurement', mCur: 'cursor' },
    undoStack: ['undo'], redoStack: ['redo'], renders: 0,
    fixState: clone, snap: () => JSON.stringify(context.state),
    defaultState: () => design('default'),
    LIB: [{ items: [['bed']] }], HEIGHT_TYPES: new Set(), WALLS: [],
    ROOMS: [{ id: 'living', name: 'Living', mat: 'wood' }], MATS: { wood: {} },
    updateSaveStatus() {}, renderAll() { context.renders++; }, tr() {}, toast() {},
  };
  if (nativeValidation) {
    const start = html.indexOf('function fixState(s){');
    vm.runInNewContext(html.slice(start, html.indexOf('const PX_MM', start)), context);
  }
  vm.runInNewContext(source, context);
  return context;
}

function memory() {
  const data = new Map([['home-design', JSON.stringify(design('old local'))]]);
  return {
    failPrimary: false,
    getItem: key => data.get(key) ?? null,
    setItem(key, value) {
      if (this.failPrimary && key === 'home-design') throw new Error('Storage full');
      data.set(key, value);
    },
  };
}

test('failed primary save preserves the current design and history during remote application', () => {
  const storage = memory(), page = browser(storage);
  storage.failPrimary = true;
  assert.throws(() => page.window.FloorplanApp.applyRemote(design('new cloud')));
  assert.deepEqual(page.state, design('old local'));
  assert.deepEqual(JSON.parse(storage.getItem('home-design')), design('old local'));
  assert.equal(page.ui.sel, 'selected');
  assert.deepEqual(page.undoStack, ['undo']);
  assert.deepEqual(page.redoStack, ['redo']);
  assert.equal(page.renders, 0);
  assert.equal(page.persistence.status, 'error');
});

test('a failed remote primary save cannot advance the sync base or upload stale data after reload', async t => {
  const storage = memory(), key = 'home-cloud-tab';
  storage.setItem(key, JSON.stringify({
    version: 1, pending: null, baseRevision: 1,
    baseContent: design('old local'), unconfirmed: null,
  }));
  const remote = { revision: 2, content: design('new cloud') };
  let writes = 0;
  const connect = page => {
    const engine = new DesignSync({
      readLocal: page.window.FloorplanApp.read,
      applyRemote: page.window.FloorplanApp.applyRemote,
      validate: clone, isEditing: () => false, pristine: false,
      storage, storageKey: key,
      readRemote: async () => clone(remote),
      writeRemote: async () => { writes++; throw new Error('Unexpected stale upload'); },
    });
    t.after(() => engine.stop());
    return engine;
  };
  storage.failPrimary = true;
  const first = connect(browser(storage));
  await first.start();
  assert.equal(first.getStatus().kind, 'error');
  assert.equal(first.getStatus().revision, 1);
  assert.equal(JSON.parse(storage.getItem(key)).baseRevision, 1);
  first.stop();

  storage.failPrimary = false;
  const reloaded = browser(storage), next = connect(reloaded);
  await next.start();
  assert.equal(next.getStatus().kind, 'synced');
  assert.equal(next.getStatus().revision, 2);
  assert.deepEqual(clone(reloaded.state), remote.content);
  assert.deepEqual(JSON.parse(storage.getItem('home-design')), remote.content);
  assert.equal(writes, 0);
});

test('successful remote application saves before clearing history and rendering', () => {
  const storage = memory(), page = browser(storage);
  page.window.FloorplanApp.applyRemote(design('new cloud'));
  assert.deepEqual(JSON.parse(storage.getItem('home-design')), design('new cloud'));
  assert.equal(page.ui.sel, null);
  assert.deepEqual(page.undoStack, []);
  assert.deepEqual(page.redoStack, []);
  assert.equal(page.renders, 1);
});

test('a plan accepted by the real import validator surfaces the 1 MiB cloud rejection and can be reduced', async t => {
  const storage = memory(), page = browser(storage, true), app = page.window.FloorplanApp;
  page.state = app.validate({
    ...design('large'),
    furniture: Array.from({ length: 1100 }, (_, i) => ({
      id: 'f' + i, type: 'bed', name: 'Bed', color: '#ffffff',
      cx: 100, cy: 100, w: 1000, d: 2000, rot: 0, notes: 'x'.repeat(1000),
    })),
  });
  assert.ok(Buffer.byteLength(JSON.stringify(page.state), 'utf8') > 1048576);
  assert.equal(page.state.furniture.length, 1100);
  storage.setItem('home-design', JSON.stringify(page.state));
  let attempts = 0;
  const engine = new DesignSync({
    readLocal: app.read, applyRemote: app.applyRemote, validate: app.validate,
    isEditing: () => false, pristine: false, storage, storageKey: 'cloud-draft',
    readRemote: async () => null,
    writeRemote: async ({ content }) => {
      attempts++;
      if (Buffer.byteLength(JSON.stringify(content), 'utf8') > 1048576) {
        throw { code: '22023', message: 'Plan content exceeds the storage limit.' };
      }
      return { applied: true, design: { revision: 1, content } };
    },
  });
  t.after(() => engine.stop());
  await engine.start();
  assert.equal(engine.getStatus().kind, 'error');
  assert.equal(engine.getStatus().messageCode, 'save-rejected');
  assert.deepEqual(JSON.parse(storage.getItem('cloud-draft')).pending, clone(page.state));
  await engine.sync();
  assert.equal(attempts, 1);
  page.state = app.validate(design('reduced'));
  engine.changed();
  await engine.sync();
  assert.equal(attempts, 2);
  assert.equal(engine.getStatus().kind, 'synced');
});
