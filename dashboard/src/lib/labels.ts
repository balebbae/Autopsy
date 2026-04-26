// Human-readable labels for the snake_case strings the analyzer/classifier
// emits. Keep this list in sync with:
//   - service/src/aag/analyzer/classifier.py (SYMPTOM_TO_MODE, MODE_TO_FIX)
//   - service/src/aag/analyzer/rules/*.py (Symptom name=…)
//   - service/src/aag/analyzer/rules/rejection_reason.py (PATTERNS)
//   - plugin/src/handlers/event.ts (postRejection failure_mode strings)

const FAILURE_MODE_LABELS: Record<string, string> = {
  user_permission_denied: "User rejected tool",
  permission_rejected: "Permission denied",
  frustrated_user: "User expressed frustration",
  user_dissatisfaction: "User dissatisfied",
  incomplete_schema_change: "Incomplete schema change",
  missing_test_coverage: "Missing test coverage",
  frontend_backend_drift: "Frontend/backend drift",
  regression: "Regression",
  wrong_target: "Wrong target",
  security_concern: "Security concern",
  performance_concern: "Performance concern",
  manual_rejection: "Manual rejection",
  automated_check_failed: "Automated check failed",
}

const SYMPTOM_LABELS: Record<string, string> = {
  schema_field_addition: "Schema field addition",
  missing_migration: "Missing migration",
  missing_test: "Missing tests",
  frontend_type_drift: "Frontend type drift",
  regression: "Regression",
  wrong_target: "Wrong target",
  security_concern: "Security concern",
  performance_concern: "Performance concern",
  user_frustration: "User frustration",
  manual_rejection: "Manual rejection",
  manual_permission_denial: "Manual permission denial",
  llm_finding: "LLM finding",
}

// Generic snake_case / kebab-case → "Title Case" fallback for anything not
// in the explicit maps. Acronyms like "llm" are uppercased.
const ACRONYMS = new Set(["llm", "api", "ui", "ux", "url", "id", "ssr"])

function titleCase(value: string): string {
  return value
    .split(/[_\-\s]+/)
    .filter(Boolean)
    .map((word, idx) => {
      const lower = word.toLowerCase()
      if (ACRONYMS.has(lower)) return lower.toUpperCase()
      if (idx === 0) return lower.charAt(0).toUpperCase() + lower.slice(1)
      return lower
    })
    .join(" ")
}

export function humanizeFailureMode(mode: string | null | undefined): string {
  if (!mode) return ""
  return FAILURE_MODE_LABELS[mode] ?? titleCase(mode)
}

export function humanizeSymptom(name: string | null | undefined): string {
  if (!name) return ""
  return SYMPTOM_LABELS[name] ?? titleCase(name)
}

// For change_patterns / components / generic snake_case strings.
export function humanize(value: string | null | undefined): string {
  if (!value) return ""
  return SYMPTOM_LABELS[value] ?? FAILURE_MODE_LABELS[value] ?? titleCase(value)
}
