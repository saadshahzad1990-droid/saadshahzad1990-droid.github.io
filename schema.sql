-- Run this once against your Neon database.
--   Neon dashboard -> SQL Editor -> paste -> Run
-- Or:  psql "$DATABASE_URL" -f schema.sql

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
