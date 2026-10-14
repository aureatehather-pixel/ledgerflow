-- Reverses 0001. data.md: "Every migration must be reversible. Write an explicit
-- down migration even if you think you will never run it."

DROP TRIGGER IF EXISTS documents_set_updated_at ON documents;
DROP TRIGGER IF EXISTS client_assignments_set_updated_at ON client_assignments;
DROP TRIGGER IF EXISTS clients_set_updated_at ON clients;
DROP TRIGGER IF EXISTS accounts_set_updated_at ON accounts;
DROP TRIGGER IF EXISTS sessions_set_updated_at ON sessions;
DROP TRIGGER IF EXISTS user_credentials_set_updated_at ON user_credentials;
DROP TRIGGER IF EXISTS users_set_updated_at ON users;
DROP TRIGGER IF EXISTS firms_set_updated_at ON firms;
DROP FUNCTION IF EXISTS set_updated_at();
