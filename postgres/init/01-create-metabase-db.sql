-- Create a dedicated database for Metabase's application data.
-- Runs only on first initialization of the Postgres data volume.
SELECT 'CREATE DATABASE metabase'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'metabase')\gexec
