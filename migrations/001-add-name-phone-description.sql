-- Run this once against the existing Neon database.
-- Safe to re-run. Existing rows get NULL for the new columns, which is fine:
-- the five contacts captured before this change simply have no name on file.

alter table contacts add column if not exists name        text;
alter table contacts add column if not exists phone       text;
alter table contacts add column if not exists description text;
