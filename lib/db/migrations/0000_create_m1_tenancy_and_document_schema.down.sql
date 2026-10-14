-- Reverses 0000. Order matters: dependants before dependencies.
-- This is destructive -- it drops every M1 table and all data in them. Take a
-- snapshot before running it anywhere that has data (data.md, Backups).

DROP TABLE IF EXISTS audit_events;
DROP TABLE IF EXISTS documents;
DROP TABLE IF EXISTS client_assignments;
DROP TABLE IF EXISTS clients;
DROP TABLE IF EXISTS accounts;
DROP TABLE IF EXISTS sessions;
DROP TABLE IF EXISTS user_credentials;
DROP TABLE IF EXISTS users;
DROP TABLE IF EXISTS firms;
DROP TYPE IF EXISTS audit_outcome;
DROP TYPE IF EXISTS access_level;
DROP TYPE IF EXISTS firm_role;
