-- Agent Autopsy Graph — base DDL.
-- Loaded into postgres on first boot via infra/docker-compose mounting this file
-- into /docker-entrypoint-initdb.d/.
-- Apply order: 00-init.sql (extensions) -> 10-schema.sql (this file).

-- =========================================================================
-- Raw trace
-- =========================================================================

CREATE TABLE IF NOT EXISTS runs (
    run_id           TEXT PRIMARY KEY,
    project          TEXT,
    worktree         TEXT,
    task             TEXT,
    started_at       BIGINT NOT NULL,
    ended_at         BIGINT,
    status           TEXT NOT NULL DEFAULT 'active'
                     CHECK (status IN ('active','approved','rejected','aborted')),
    rejection_reason TEXT,
    rejection_count  INTEGER NOT NULL DEFAULT 0,
    files_touched    INTEGER NOT NULL DEFAULT 0,
    tool_calls       INTEGER NOT NULL DEFAULT 0,
    summary          TEXT,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Idempotent migration: add rejection_count to existing dev databases.
ALTER TABLE runs ADD COLUMN IF NOT EXISTS rejection_count INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS runs_project_idx     ON runs(project);
CREATE INDEX IF NOT EXISTS runs_status_idx      ON runs(status);
CREATE INDEX IF NOT EXISTS runs_started_at_idx  ON runs(started_at DESC);

-- =========================================================================
-- Rejections (one row per user-filed rejection during a thread)
-- A run may accumulate many rejections without ending; the run only flips to
-- a terminal status when /v1/runs/{run_id}/outcome is explicitly called.
-- =========================================================================

CREATE TABLE IF NOT EXISTS rejections (
    id              BIGSERIAL PRIMARY KEY,
    run_id          TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
    ts              BIGINT NOT NULL,
    reason          TEXT NOT NULL,
    failure_mode    TEXT,
    symptoms        TEXT,                                 -- comma-separated, plugin-supplied
    source          TEXT NOT NULL DEFAULT 'plugin'
                    CHECK (source IN ('plugin','dashboard','manual')),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS rejections_run_ts_idx ON rejections(run_id, ts);

-- =========================================================================
-- Preflight hits (one row per /v1/preflight call that returned non-none risk)
-- Persisted so the dashboard can render "Autopsy caught something" badges
-- on run rows and we can measure preflight effectiveness over time.
-- =========================================================================

CREATE TABLE IF NOT EXISTS preflight_hits (
    id                  BIGSERIAL PRIMARY KEY,
    run_id              TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
    ts                  BIGINT NOT NULL,                  -- ms since epoch (event-time)
    task                TEXT NOT NULL,                    -- the task string we evaluated
    risk_level          TEXT NOT NULL
                        CHECK (risk_level IN ('low','medium','high')),
    top_failure_score   REAL NOT NULL,
    blocked             BOOLEAN NOT NULL DEFAULT false,
    tool                TEXT,                              -- null when from system.transform
    args                JSONB,                             -- tool args when blocked / inspected
    similar_runs        TEXT[] NOT NULL DEFAULT '{}',
    top_failure_modes   JSONB NOT NULL DEFAULT '[]'::jsonb, -- [{name, score}, ...]
    top_fix_patterns    JSONB NOT NULL DEFAULT '[]'::jsonb, -- [{name, score}, ...]
    addendum            TEXT,                              -- prose injected into system prompt
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS preflight_hits_run_ts_idx ON preflight_hits(run_id, ts);
CREATE INDEX IF NOT EXISTS preflight_hits_risk_idx   ON preflight_hits(risk_level);

CREATE TABLE IF NOT EXISTS run_events (
    id          BIGSERIAL PRIMARY KEY,
    event_id    TEXT,
    run_id      TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
    ts          BIGINT NOT NULL,
    type        TEXT NOT NULL,
    properties  JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (run_id, event_id)
);

CREATE INDEX IF NOT EXISTS run_events_run_ts_idx ON run_events(run_id, ts);
CREATE INDEX IF NOT EXISTS run_events_type_idx   ON run_events(type);

CREATE TABLE IF NOT EXISTS artifacts (
    id          BIGSERIAL PRIMARY KEY,
    run_id      TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
    kind        TEXT NOT NULL,                 -- 'diff' | 'tool_output' | 'log' | ...
    captured_at BIGINT NOT NULL,
    content     JSONB NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS artifacts_run_kind_idx ON artifacts(run_id, kind);

-- =========================================================================
-- Failure cases (analyzer output, one per analyzed run)
-- =========================================================================

CREATE TABLE IF NOT EXISTS failure_cases (
    run_id          TEXT PRIMARY KEY REFERENCES runs(run_id) ON DELETE CASCADE,
    task_type       TEXT,
    failure_mode    TEXT NOT NULL,
    fix_pattern     TEXT,
    components      TEXT[] NOT NULL DEFAULT '{}',
    change_patterns TEXT[] NOT NULL DEFAULT '{}',
    symptoms        JSONB NOT NULL DEFAULT '[]'::jsonb,   -- [{name, evidence[], confidence}]
    summary         TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS failure_cases_mode_idx ON failure_cases(failure_mode);

-- =========================================================================
-- Graph (Run, Task, File, Component, ChangePattern, Symptom, FailureMode, FixPattern, Outcome)
-- =========================================================================

CREATE TABLE IF NOT EXISTS graph_nodes (
    id          TEXT PRIMARY KEY,                -- e.g. "FailureMode:incomplete_schema_change"
    type        TEXT NOT NULL,
    name        TEXT NOT NULL,
    properties  JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (type, name)
);

CREATE INDEX IF NOT EXISTS graph_nodes_type_idx ON graph_nodes(type);

CREATE TABLE IF NOT EXISTS graph_edges (
    id              BIGSERIAL PRIMARY KEY,
    source_id       TEXT NOT NULL REFERENCES graph_nodes(id) ON DELETE CASCADE,
    target_id       TEXT NOT NULL REFERENCES graph_nodes(id) ON DELETE CASCADE,
    type            TEXT NOT NULL,
    confidence      REAL NOT NULL DEFAULT 0.5,
    evidence_run_id TEXT REFERENCES runs(run_id) ON DELETE SET NULL,
    properties      JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (source_id, target_id, type, evidence_run_id)
);

CREATE INDEX IF NOT EXISTS graph_edges_source_idx ON graph_edges(source_id);
CREATE INDEX IF NOT EXISTS graph_edges_target_idx ON graph_edges(target_id);
CREATE INDEX IF NOT EXISTS graph_edges_type_idx   ON graph_edges(type);

-- =========================================================================
-- Embeddings (pgvector)
-- The vector dimension is set for sentence-transformers/all-MiniLM-L6-v2 (384).
-- Change to 768 for EMBED_PROVIDER=gemini (text-embedding-004) or 1536
-- for EMBED_PROVIDER=openai (text-embedding-3-small).  After changing the
-- provider, run `make embed-reset` to drop and recreate this table.
-- =========================================================================

CREATE TABLE IF NOT EXISTS embeddings (
    id           BIGSERIAL PRIMARY KEY,
    entity_type  TEXT NOT NULL,                 -- 'task' | 'failure' | 'fix' | 'run_summary'
    entity_id    TEXT NOT NULL,                 -- e.g. run_id, FailureCase.run_id, GraphNode.id
    text         TEXT NOT NULL,
    vector       vector(384) NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (entity_type, entity_id)
);

-- Approximate-NN index. Adjust lists when the table grows.
CREATE INDEX IF NOT EXISTS embeddings_vector_idx
    ON embeddings USING ivfflat (vector vector_cosine_ops) WITH (lists = 100);
