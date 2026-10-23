const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { after, before, beforeEach, describe, test } = require('node:test');
const { PGlite } = require('@electric-sql/pglite');

const migration = readFileSync(resolve(__dirname,
  '../supabase/migrations/202610230001_floorplan_sync.sql'), 'utf8');
const USER_A = '10000000-0000-4000-8000-000000000001';
const USER_B = '20000000-0000-4000-8000-000000000002';
const PLAN = 'home-2a-cad-v2';
const plan = (name = 'Original', planId = PLAN) => ({
  planId, furniture: [], rooms: { living: { name, mat: 'wood' } },
  demolished: [], measures: [],
});

describe('Supabase plan storage (actual PostgreSQL migration in PGlite)', { concurrency: false }, () => {
  let db;
  let requestOwner;

  before(async () => {
    db = new PGlite();
    await db.exec(`
      create role anon;
      create role authenticated;
      create role service_role bypassrls;
      create schema auth;
      create table auth.users (id uuid primary key);
      create function auth.uid() returns uuid language sql stable as $$
        select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
      $$;
      grant usage on schema public, auth to anon, authenticated, service_role;
      grant execute on function auth.uid() to anon, authenticated, service_role;
      insert into auth.users values ('${USER_A}'), ('${USER_B}');
      -- Model Supabase projects with the historical automatic API grants.
      alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
      alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
    `);
    await db.exec(migration);
  });

  after(async () => { await db?.close(); });

  beforeEach(async () => {
    await db.exec('reset role; truncate public.floorplan_designs;');
    await actor(USER_A);
  });

  async function actor(id, role = 'authenticated') {
    requestOwner = id || null;
    await db.exec('reset role;');
    await db.query("select set_config('request.jwt.claim.sub', $1, false)", [id || '']);
    // The role argument is an internal test constant, never user input.
    assert.ok(['authenticated', 'anon', 'service_role'].includes(role));
    await db.exec(`set role ${role};`);
  }

  async function save(expected, content = plan(), planId = PLAN, ownerId = requestOwner) {
    const result = await db.query(
      'select public.save_floorplan($1::uuid, $2, $3::bigint, $4::jsonb) as result',
      [ownerId, planId, expected, content === null ? null : JSON.stringify(content)],
    );
    return result.rows[0].result;
  }

  const rejected = (operation, code) => assert.rejects(operation, error => error.code === code);

  test('creates revision 1 and returns only the public design fields', async () => {
    const result = await save(0);
    assert.equal(result.applied, true);
    assert.deepEqual(Object.keys(result.design).sort(), ['content', 'plan_id', 'revision', 'updated_at']);
    assert.equal(result.design.plan_id, PLAN);
    assert.equal(result.design.revision, 1);
    assert.deepEqual(result.design.content, plan());
    assert.ok(Number.isFinite(Date.parse(result.design.updated_at)));
    const rows = (await db.query('select * from public.floorplan_designs')).rows;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].owner_id, USER_A);
  });

  test('updates only the expected revision; stale writes return the preserved winner', async () => {
    await save(0);
    const winner = await save(1, plan('Computer'));
    assert.equal(winner.applied, true);
    assert.equal(winner.design.revision, 2);
    const stale = await save(1, plan('Phone'));
    assert.equal(stale.applied, false);
    assert.deepEqual(stale.design, winner.design);
    assert.equal((await save(2, plan('Resolved'))).design.revision, 3);
  });

  test('expected revision zero never overwrites an existing design', async () => {
    const original = await save(0, plan('Computer'));
    const duplicate = await save(0, plan('Phone default'));
    assert.equal(duplicate.applied, false);
    assert.deepEqual(duplicate.design, original.design);
  });

  test('queued first saves and updates have exactly one winner', async () => {
    // PGlite has one connection: this tests simultaneous queued API requests,
    // not independent PostgreSQL transactions. The migration's unique key and
    // atomic UPDATE predicate enforce that latter guarantee on the server.
    const creations = await Promise.all([save(0, plan('A')), save(0, plan('B'))]);
    assert.equal(creations.filter(result => result.applied).length, 1);
    assert.deepEqual(creations[0].design, creations[1].design);
    const updates = await Promise.all([save(1, plan('C')), save(1, plan('D'))]);
    assert.equal(updates.filter(result => result.applied).length, 1);
    assert.deepEqual(updates[0].design, updates[1].design);
    assert.equal(updates[0].design.revision, 2);
  });

  test('an update of a missing design reports conflict without creating one', async () => {
    assert.deepEqual(await save(1), { applied: false, design: null });
    assert.equal((await db.query('select * from public.floorplan_designs')).rows.length, 0);
  });

  test('different plan IDs remain independent within one account', async () => {
    await save(0, plan('First'));
    const second = await save(0, plan('Second', 'another-plan'), 'another-plan');
    assert.equal(second.applied, true);
    assert.equal(second.design.revision, 1);
    assert.equal((await db.query('select * from public.floorplan_designs')).rows.length, 2);
  });

  test('RLS isolates owners; RPC conflicts cannot disclose or overwrite another owner', async () => {
    const first = await save(0, plan('Private A'));
    await actor(USER_B);
    assert.deepEqual((await db.query('select * from public.floorplan_designs')).rows, []);
    assert.deepEqual(await save(1, plan('Attempted overwrite')), { applied: false, design: null });
    const second = await save(0, plan('Private B'));
    assert.equal(second.applied, true);
    assert.equal(second.design.revision, 1);
    assert.equal((await db.query('select * from public.floorplan_designs')).rows[0].owner_id, USER_B);
    await actor(USER_A);
    assert.deepEqual((await save(0)).design, first.design);
    const rows = (await db.query('select * from public.floorplan_designs')).rows;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].owner_id, USER_A);
  });

  test('anonymous sessions cannot read rows or execute the save RPC', async () => {
    await save(0);
    await actor(null, 'anon');
    await rejected(() => db.query('select * from public.floorplan_designs'), '42501');
    await rejected(() => save(0), '42501');
  });

  test('a mismatched or missing request owner cannot save under a changed session', async () => {
    const originalA = await save(0, plan('Private A'));
    await rejected(() => save(1, plan('Wrong owner'), PLAN, USER_B), '42501');
    await rejected(() => save(1, plan('Missing owner'), PLAN, null), '42501');
    await actor(USER_B);
    const originalB = await save(0, plan('Private B'));
    // An in-flight account A request must fail even if the SDK now sends B's
    // token and B happens to have the same revision number.
    await rejected(() => save(1, plan('Private A leaked'), PLAN, USER_A), '42501');
    assert.deepEqual((await save(0)).design, originalB.design);
    await actor(USER_A);
    assert.deepEqual((await save(0)).design, originalA.design);
  });

  test('an authenticated role without a user ID cannot save or see any rows', async () => {
    await save(0);
    await actor(null);
    assert.deepEqual((await db.query('select * from public.floorplan_designs')).rows, []);
    await rejected(() => save(0), '42501');
  });

  test('authenticated users cannot insert, update, delete, truncate, or alter rows directly', async () => {
    await save(0);
    for (const statement of [
      "insert into public.floorplan_designs values (auth.uid(), 'direct', 1, '{}', now())",
      "update public.floorplan_designs set revision = 99 where owner_id = auth.uid()",
      'delete from public.floorplan_designs where owner_id = auth.uid()',
      'truncate public.floorplan_designs',
      'alter table public.floorplan_designs disable row level security',
    ]) await rejected(() => db.exec(statement), '42501');
    assert.equal((await save(0)).design.revision, 1);
  });

  test('the service role receives no accidental table or RPC grants', async () => {
    await actor(USER_A, 'service_role');
    await rejected(() => db.query('select * from public.floorplan_designs'), '42501');
    await rejected(() => save(0), '42501');
  });

  test('anonymous users cannot write directly', async () => {
    await actor(null, 'anon');
    for (const statement of [
      `insert into public.floorplan_designs values ('${USER_A}', 'direct', 1, '{}', now())`,
      'update public.floorplan_designs set revision = 99',
      'delete from public.floorplan_designs',
    ]) await rejected(() => db.exec(statement), '42501');
  });

  test('RPC is security definer with an empty search path and restricted execute grants', async () => {
    const row = (await db.query(`
      select p.prosecdef, p.proconfig,
        has_function_privilege('anon', p.oid, 'execute') as anon_execute,
        has_function_privilege('service_role', p.oid, 'execute') as service_execute,
        has_function_privilege('authenticated', p.oid, 'execute') as authenticated_execute
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'save_floorplan'
    `)).rows[0];
    assert.equal(row.prosecdef, true);
    assert.ok(row.proconfig.includes('search_path=""'));
    assert.equal(row.anon_execute, false);
    assert.equal(row.service_execute, false);
    assert.equal(row.authenticated_execute, true);
  });

  test('rejects negative, null, and non-integer revision input', async () => {
    await rejected(() => save(-1), '22023');
    await rejected(() => save(null), '22023');
    await rejected(() => save('1.5'), '22P02');
    await rejected(() => save('not-a-number'), '22P02');
  });

  test('rejects missing, blank, overlong, or mismatched plan IDs', async () => {
    for (const id of [null, '', ' ', ' leading', 'trailing ', 'x'.repeat(161)]) {
      await rejected(() => save(0, plan('Invalid', id), id), '22023');
    }
    await rejected(() => save(0, plan('Wrong', 'different-plan')), '22023');
    await rejected(() => save(0, { ...plan(), planId: 123 }, '123'), '22023');
  });

  test('rejects missing or wrong content shapes without changing an existing design', async () => {
    const original = await save(0);
    const malformed = [null, [], 'text', 4, {},
      { ...plan(), furniture: {} }, { ...plan(), rooms: [] },
      { ...plan(), demolished: null }, { ...plan(), measures: {} },
    ];
    for (const key of ['planId', 'furniture', 'rooms', 'demolished', 'measures']) {
      const content = plan();
      delete content[key];
      malformed.push(content);
    }
    for (const content of malformed) await rejected(() => save(1, content), '22023');
    assert.deepEqual((await save(0)).design, original.design);
  });

  test('enforces content byte size and collection limits', async () => {
    await rejected(() => save(0, { ...plan(), furniture: Array(2001).fill({}) }), '22023');
    await rejected(() => save(0, { ...plan(), measures: Array(2001).fill({}) }), '22023');
    await rejected(() => save(0, { ...plan(), notes: 'x'.repeat(1048576) }), '22023');
    // UTF-8 bytes, not JavaScript character count, determine the database limit.
    await rejected(() => save(0, { ...plan(), notes: '家'.repeat(350000) }), '22023');
    const result = await save(0, { ...plan(), notes: 'x'.repeat(1000000) });
    assert.equal(result.applied, true);
  });

  test('deleting an account removes its designs without affecting other accounts', async () => {
    await save(0);
    await actor(USER_B);
    await save(0);
    await db.exec('reset role;');
    await db.query('delete from auth.users where id = $1', [USER_A]);
    const rows = (await db.query('select owner_id from public.floorplan_designs')).rows;
    assert.deepEqual(rows, [{ owner_id: USER_B }]);
    // Restore the fixture for any later tests.
    await db.query('insert into auth.users values ($1)', [USER_A]);
  });
});
