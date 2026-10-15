CREATE DATABASE webtopup_pg_dev;
\connect webtopup_pg_dev
CREATE ROLE webtopup_migration_ddl LOGIN PASSWORD 'replace-at-runtime';
CREATE ROLE webtopup_migration_app LOGIN PASSWORD 'replace-at-runtime';
GRANT CONNECT ON DATABASE webtopup_pg_dev TO webtopup_migration_ddl, webtopup_migration_app;
GRANT CREATE ON DATABASE webtopup_pg_dev TO webtopup_migration_ddl;
GRANT USAGE, CREATE ON SCHEMA public TO webtopup_migration_ddl;
GRANT USAGE ON SCHEMA public TO webtopup_migration_app;
ALTER DEFAULT PRIVILEGES FOR ROLE webtopup_migration_ddl IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO webtopup_migration_app;
ALTER DEFAULT PRIVILEGES FOR ROLE webtopup_migration_ddl IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO webtopup_migration_app;
