# aag — Agent Autopsy Graph service

FastAPI ingestion + analyzer + graph + preflight, behind a single `/v1` API.

## Run

```bash
# from repo root
make compose-up        # postgres on :5432
make service-install   # uv sync
make service-dev       # uvicorn on :4000
```

Open <http://localhost:4000/docs> for the live OpenAPI spec.

## Layout

```
src/aag/
  main.py              FastAPI factory
  config.py            pydantic-settings (env-driven)
  db.py                async SQLAlchemy engine + session
  deps.py              FastAPI Depends helpers
  models/              SQLAlchemy ORM (matches contracts/db-schema.sql)
  schemas/             Pydantic v2 (matches contracts/openapi.yaml)
  routes/              HTTP routers (R2)
  ingestion/           run assembler + in-process pubsub (R2)
  analyzer/            rules-first failure classifier (R3)
  graph/               graph writer + traversal + embeddings (R3)
  workers/             background finalizer (R3)
```

## Smoke check

```bash
curl localhost:4000/v1/health
# {"ok":true}
```

## Tests

```bash
make service-test
# or:  cd service && uv run pytest -q
```

Don't run from the repo root — `service` has its own `pyproject.toml` and `tests/`.
