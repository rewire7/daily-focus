-- Daily Focus: Supabase 테이블 + 보안 규칙(RLS)
-- 사용법: Supabase 대시보드 → SQL Editor → New query → 이 파일 내용 전체를 붙여넣고 Run.
-- 여러 번 실행해도 안전하다.

-- 사용자 1명당 1행. 할 일 목록 전체를 JSON 한 덩어리로 저장한다.
create table if not exists public.todo_docs (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  data       jsonb not null default '{"version":1,"todos":[]}'::jsonb,
  updated_at timestamptz not null default now()
);

-- RLS: 로그인한 본인의 행만 읽고 쓸 수 있다. (다른 가족/사용자의 데이터는 보이지 않음)
alter table public.todo_docs enable row level security;

drop policy if exists "본인 데이터 조회" on public.todo_docs;
create policy "본인 데이터 조회" on public.todo_docs
  for select to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "본인 데이터 생성" on public.todo_docs;
create policy "본인 데이터 생성" on public.todo_docs
  for insert to authenticated
  with check ((select auth.uid()) = user_id);

drop policy if exists "본인 데이터 수정" on public.todo_docs;
create policy "본인 데이터 수정" on public.todo_docs
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

-- 자동 접속(GitHub Actions)용 함수. 로그인 없이 호출할 수 있지만 아무 데이터도 돌려주지 않는다.
-- 실제 DB 쿼리를 한 번 실행시켜 "활동 중인 프로젝트"로 인식되게 하는 것이 목적이다.
create or replace function public.keepalive()
returns text
language sql
stable
set search_path = ''
as $$
  select 'ok'::text;
$$;

grant execute on function public.keepalive() to anon;
