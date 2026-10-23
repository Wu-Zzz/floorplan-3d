-- Apply in the Supabase SQL editor or through Supabase migrations.
-- The browser can read its own plans and write only through the CAS RPC below.
begin;

create table public.floorplan_designs (
  owner_id uuid not null references auth.users (id) on delete cascade,
  plan_id text not null check (char_length(plan_id) between 1 and 160),
  revision bigint not null check (revision > 0),
  content jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (owner_id, plan_id)
);

alter table public.floorplan_designs enable row level security;

revoke all on table public.floorplan_designs from public, anon, authenticated, service_role;
grant select on table public.floorplan_designs to authenticated;

create policy floorplan_designs_read_own
  on public.floorplan_designs
  for select
  to authenticated
  using (owner_id = (select auth.uid()));

create function public.save_floorplan(
  p_owner_id uuid,
  p_plan_id text,
  p_expected_revision bigint,
  p_content jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner uuid := auth.uid();
  v_design public.floorplan_designs%rowtype;
  v_applied boolean := false;
begin
  if v_owner is null or p_owner_id is null or p_owner_id is distinct from v_owner then
    raise exception 'The signed-in account does not match this save request.' using errcode = '42501';
  end if;

  if p_plan_id is null or char_length(p_plan_id) not between 1 and 160
     or p_plan_id <> btrim(p_plan_id) then
    raise exception 'Invalid plan ID.' using errcode = '22023';
  end if;
  if p_expected_revision is null or p_expected_revision < 0 then
    raise exception 'Expected revision must be a non-negative integer.' using errcode = '22023';
  end if;

  if jsonb_typeof(p_content) is distinct from 'object'
     or jsonb_typeof(p_content -> 'planId') is distinct from 'string'
     or p_content ->> 'planId' is distinct from p_plan_id
     or jsonb_typeof(p_content -> 'furniture') is distinct from 'array'
     or jsonb_typeof(p_content -> 'rooms') is distinct from 'object'
     or jsonb_typeof(p_content -> 'demolished') is distinct from 'array'
     or jsonb_typeof(p_content -> 'measures') is distinct from 'array' then
    raise exception 'Invalid plan content.' using errcode = '22023';
  end if;
  if octet_length(p_content::text) > 1048576
     or jsonb_array_length(p_content -> 'furniture') > 2000
     or jsonb_array_length(p_content -> 'measures') > 2000 then
    raise exception 'Plan content exceeds the storage limit.' using errcode = '22023';
  end if;

  if p_expected_revision = 0 then
    -- A new device must never replace an existing plan with its local default.
    insert into public.floorplan_designs (owner_id, plan_id, revision, content)
    values (v_owner, p_plan_id, 1, p_content)
    on conflict (owner_id, plan_id) do nothing
    returning * into v_design;
    v_applied := found;
  else
    -- PostgreSQL checks the revision against the locked row, so concurrent
    -- writers based on the same revision cannot both succeed.
    update public.floorplan_designs
       set revision = revision + 1,
           content = p_content,
           updated_at = clock_timestamp()
     where owner_id = v_owner
       and plan_id = p_plan_id
       and revision = p_expected_revision
    returning * into v_design;
    v_applied := found;
  end if;

  if not v_applied then
    select * into v_design
      from public.floorplan_designs
     where owner_id = v_owner and plan_id = p_plan_id;
  end if;

  return jsonb_build_object(
    'applied', v_applied,
    'design', case when v_design.owner_id is null then null else
      jsonb_build_object(
        'plan_id', v_design.plan_id,
        'revision', v_design.revision,
        'content', v_design.content,
        'updated_at', v_design.updated_at
      ) end
  );
end;
$$;

-- Remove PostgreSQL's PUBLIC grant and Supabase's default API-role grants.
revoke all on function public.save_floorplan(uuid, text, bigint, jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.save_floorplan(uuid, text, bigint, jsonb)
  to authenticated;

commit;
