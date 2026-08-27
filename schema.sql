-- Full schema. Safe to re-run: everything is "if not exists".
--   Neon dashboard -> SQL Editor -> paste -> Run

create table if not exists contacts (
  id            bigserial     primary key,
  email         text          not null unique,
  source        text,                              -- which page/section it came from
  ip_hash       text,                              -- salted hash, for rate limiting only
  seen_count    integer       not null default 1,  -- bumped if the same address submits again
  created_at    timestamptz   not null default now(),
  last_seen_at  timestamptz   not null default now()
);

create index if not exists contacts_created_at_idx on contacts (created_at desc);

-- Added 27 Aug 2026 alongside the expanded form.
alter table contacts add column if not exists name        text;
alter table contacts add column if not exists phone       text;  -- full international form, e.g. +49 15123456789
alter table contacts add column if not exists description text;
