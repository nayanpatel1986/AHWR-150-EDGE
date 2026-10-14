#!/bin/sh
# Docker schema upgrade (service db-migrate): applies 01-roles.sql and
# 02-schema.sql on every "docker compose up". Both are idempotent, so an
# existing database is brought to the current schema before the backend starts.
set -eu
export PGPASSWORD="$POSTGRES_PASSWORD"
psql -v ON_ERROR_STOP=1 -h "$PGHOST" -U postgres -d postgres -q \
     -v tg_pw="$TELEGRAF_DB_PASSWORD" -v app_pw="$APP_DB_PASSWORD" \
     -f /ahwr-sql/01-roles.sql
psql -v ON_ERROR_STOP=1 -h "$PGHOST" -U postgres -d ahwr_edge -q -f /ahwr-sql/02-schema.sql
psql -h "$PGHOST" -U postgres -d ahwr_edge -At -c "SELECT 'schema version ' || max(version) FROM edge_schema"
