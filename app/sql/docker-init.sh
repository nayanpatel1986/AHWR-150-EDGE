#!/bin/sh
# Docker first-start hook (mounted into /docker-entrypoint-initdb.d): applies
# 01-roles.sql and 02-schema.sql with the passwords from the environment.
set -eu
psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d postgres \
     -v tg_pw="$TELEGRAF_DB_PASSWORD" -v app_pw="$APP_DB_PASSWORD" \
     -f /ahwr-sql/01-roles.sql
psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d ahwr_edge -f /ahwr-sql/02-schema.sql
