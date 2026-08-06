create table if not exists public.tutor_mastery (
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  course_id text not null check (course_id in ('tom-spanish-1','liz-english-1')),
  lesson_id text not null,
  drill_id text not null,
  state text not null check (state in ('introduced','recognized','recalled-with-help','recalled-independently','spoken-acceptably','due','repeatedly-missed')),
  attempts integer not null default 0 check (attempts >= 0),
  misses integer not null default 0 check (misses >= 0 and misses <= attempts),
  last_score double precision,
  last_practiced_at timestamptz not null,
  next_review_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (user_id, course_id, lesson_id, drill_id)
);

alter table public.tutor_mastery enable row level security;

create policy "Users can read own tutor mastery"
on public.tutor_mastery for select
using (auth.uid() = user_id);

create policy "Users can insert own tutor mastery"
on public.tutor_mastery for insert
with check (auth.uid() = user_id);

create policy "Users can update own tutor mastery"
on public.tutor_mastery for update
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

create policy "Users can delete own tutor mastery"
on public.tutor_mastery for delete
using (auth.uid() = user_id);

create index if not exists tutor_mastery_user_course_review_idx
on public.tutor_mastery (user_id, course_id, next_review_at);

create or replace function public.touch_tutor_mastery_updated_at()
returns trigger language plpgsql security invoker set search_path = public as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists tutor_mastery_touch_updated_at on public.tutor_mastery;
create trigger tutor_mastery_touch_updated_at
before update on public.tutor_mastery
for each row execute function public.touch_tutor_mastery_updated_at();
