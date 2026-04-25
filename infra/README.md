# Infra

Postgres + pgvector for the Agent Autopsy Graph service.

## Bring it up

```bash
make compose-up        # docker-compose -f infra/docker-compose.yml up -d
```

The first boot loads:

1. `infra/postgres/init.sql` → `CREATE EXTENSION vector;`
2. `contracts/db-schema.sql` → tables (raw trace, failure cases, graph, embeddings)

## Connect

```
host:     localhost
port:     5432
db:       aag
user:     aag
pass:     aag
```

Connection string for the service: `postgresql+asyncpg://aag:aag@localhost:5432/aag`

## Reset

```bash
make db-reset          # drops the volume; recreates from contracts/db-schema.sql
```
