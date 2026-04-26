import type { GraphEdge, GraphNode } from "./api"

// Derived from contracts/fixtures/run-rejected-schema.json so /graph is demoable
// without the R3 graph routes. Use when ?mock=1 or when the API returns 404.
export function buildMockGraph(): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const runId = "fixture-run-rejected-schema-001"

  const nodes: GraphNode[] = [
    {
      id: `run:${runId}`,
      type: "Run",
      name: "Add preferredName to user profile",
      properties: {
        run_id: runId,
        project: "demo-monorepo",
        status: "rejected",
      },
    },
    {
      id: "task:add-preferred-name",
      type: "Task",
      name: "Add preferredName to user profile API and UI",
      properties: { task_type: "feature" },
    },
    {
      id: "file:src/profile/profile.service.ts",
      type: "File",
      name: "src/profile/profile.service.ts",
      properties: { language: "typescript" },
    },
    {
      id: "file:src/profile/user.serializer.ts",
      type: "File",
      name: "src/profile/user.serializer.ts",
      properties: { language: "typescript" },
    },
    {
      id: "component:profile-service",
      type: "Component",
      name: "profile-service",
      properties: { area: "backend" },
    },
    {
      id: "component:user-serializer",
      type: "Component",
      name: "user-serializer",
      properties: { area: "backend" },
    },
    {
      id: "change:add-field",
      type: "ChangePattern",
      name: "add-optional-field",
      properties: {},
    },
    {
      id: "symptom:missed-migration",
      type: "Symptom",
      name: "missed-database-migration",
      properties: {},
    },
    {
      id: "symptom:no-frontend-types",
      type: "Symptom",
      name: "stale-frontend-types",
      properties: {},
    },
    {
      id: "failure:incomplete-schema-change",
      type: "FailureMode",
      name: "incomplete-schema-change",
      properties: {
        description: "Schema-shaped change without coordinated DB + client updates.",
      },
    },
    {
      id: "fix:rerun-codegen",
      type: "FixPattern",
      name: "regenerate-types-and-migrate",
      properties: {
        steps: [
          "Add a new migration that mirrors the schema change.",
          "Re-run the type-codegen for the frontend client.",
        ],
      },
    },
    {
      id: "outcome:rejected",
      type: "Outcome",
      name: "rejected",
      properties: {
        feedback:
          "Missed the database migration and didn't regenerate the frontend types.",
      },
    },
  ]

  const e = (
    id: string,
    source_id: string,
    target_id: string,
    type: string,
    confidence = 0.8,
  ): GraphEdge => ({
    id,
    source_id,
    target_id,
    type,
    confidence,
    evidence_run_id: runId,
  })

  // Edge vocabulary mirrors service/src/aag/graph/writer.py exactly so the
  // ?mock=1 demo renders identically to live data.
  const edges: GraphEdge[] = [
    e("e1", `run:${runId}`, "task:add-preferred-name", "ATTEMPTED", 1.0),
    e("e2", `run:${runId}`, "file:src/profile/profile.service.ts", "TOUCHED", 1.0),
    e("e3", `run:${runId}`, "file:src/profile/user.serializer.ts", "TOUCHED", 1.0),
    e("e4", "file:src/profile/profile.service.ts", "component:profile-service", "BELONGS_TO", 1.0),
    e("e5", "file:src/profile/user.serializer.ts", "component:user-serializer", "BELONGS_TO", 1.0),
    e("e6", `run:${runId}`, "change:add-field", "HAD_CHANGE_PATTERN", 1.0),
    e("e7", `run:${runId}`, "symptom:missed-migration", "EMITTED_SYMPTOM", 0.9),
    e("e8", `run:${runId}`, "symptom:no-frontend-types", "EMITTED_SYMPTOM", 0.85),
    e(
      "e9",
      "symptom:missed-migration",
      "failure:incomplete-schema-change",
      "INDICATES",
      0.92,
    ),
    e(
      "e10",
      "symptom:no-frontend-types",
      "failure:incomplete-schema-change",
      "INDICATES",
      0.78,
    ),
    e(
      "e11",
      "failure:incomplete-schema-change",
      "fix:rerun-codegen",
      "RESOLVED_BY",
      0.85,
    ),
    e("e12", `run:${runId}`, "outcome:rejected", "RESULTED_IN", 1.0),
  ]

  return { nodes, edges }
}
