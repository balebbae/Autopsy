"use client"

import * as React from "react"

import type { Run } from "@/lib/api"
import {
  attemptHadPreflightBlock,
  groupRunByAttempts,
  topPreflightHit,
  type Attempt,
} from "@/lib/timeline-grouping"

const STEP_WIDTH = 320
const SPINE_Y = 130
const SVG_HEIGHT = 460
const PADDING_X = 60

type Props = {
  run: Run
}

export function BranchedView({ run }: Props) {
  const grouped = React.useMemo(() => groupRunByAttempts(run), [run])
  const totalWidth = Math.max(
    PADDING_X * 2 + grouped.attempts.length * STEP_WIDTH,
    900,
  )

  // Run identity is announced by the run picker in the toolbar — keep this
  // chrome minimal so the SVG canvas dominates.
  return (
    <div className="flex h-full w-full flex-col gap-2 overflow-hidden p-3">
      <Legend />

      <div className="flex-1 min-h-0 overflow-x-auto overflow-y-auto rounded-xl border border-border bg-card/40 p-4">
        <svg
          width={totalWidth}
          height={SVG_HEIGHT}
          viewBox={`0 0 ${totalWidth} ${SVG_HEIGHT}`}
          className="block"
          role="img"
          aria-label="Branched run timeline"
        >
          <defs>
            <linearGradient id="aag-spine" x1="0" x2="1" y1="0" y2="0">
              <stop offset="0" stopColor="rgba(91,141,239,0)" />
              <stop offset="0.04" stopColor="rgba(91,141,239,0.85)" />
              <stop offset="0.96" stopColor="rgba(91,141,239,0.85)" />
              <stop offset="1" stopColor="rgba(91,141,239,0)" />
            </linearGradient>
          </defs>

          {/* Soft glow under the spine */}
          <line
            x1={PADDING_X}
            y1={SPINE_Y}
            x2={totalWidth - PADDING_X}
            y2={SPINE_Y}
            stroke="rgba(91,141,239,0.18)"
            strokeWidth={10}
            strokeLinecap="round"
            opacity={0.6}
          />
          {/* Main spine */}
          <line
            x1={PADDING_X}
            y1={SPINE_Y}
            x2={totalWidth - PADDING_X}
            y2={SPINE_Y}
            stroke="url(#aag-spine)"
            strokeWidth={3}
            strokeLinecap="round"
          />

          {grouped.attempts.map((att, i) => {
            const cx = PADDING_X + STEP_WIDTH / 2 + i * STEP_WIDTH
            const isLast = i === grouped.attempts.length - 1
            const nextCx = isLast
              ? totalWidth - PADDING_X
              : PADDING_X + STEP_WIDTH / 2 + (i + 1) * STEP_WIDTH
            return (
              <BranchedStep
                key={att.index}
                attempt={att}
                taskFallback={grouped.task}
                cx={cx}
                nextCx={nextCx}
              />
            )
          })}
        </svg>
      </div>
    </div>
  )
}

function BranchedStep({
  attempt,
  taskFallback,
  cx,
  nextCx,
}: {
  attempt: Attempt
  taskFallback: string | null
  cx: number
  nextCx: number
}) {
  // Mirror timeline-view: when the run has no captured user message, fall
  // back to the task itself rather than stamping `Task: <task>` — the literal
  // prefix repeats verbatim across columns and reads as boilerplate.
  const userText =
    attempt.userMessage?.text ?? taskFallback ?? "Run started"
  const truncated = truncate(userText, 32)
  const blocked = attemptHadPreflightBlock(attempt)
  const hit = topPreflightHit(attempt)
  const o = attempt.outcome
  const labelColor =
    o.kind === "rejected"
      ? "rgba(239,68,68,0.55)"
      : o.kind === "approved"
        ? "rgba(34,197,94,0.55)"
        : "rgba(120,130,160,0.5)"

  return (
    <g>
      {/* Spine node + label above */}
      <text
        x={cx}
        y={SPINE_Y - 56}
        textAnchor="middle"
        fill="#f5f6fb"
        fontFamily="Geist, Inter, sans-serif"
        fontSize={13}
        fontWeight={600}
      >
        {truncated}
      </text>
      <text
        x={cx}
        y={SPINE_Y - 40}
        textAnchor="middle"
        fill="#9ea0b3"
        fontFamily="Geist, Inter, sans-serif"
        fontSize={11}
        letterSpacing={1.2}
      >
        USER · {attempt.index}
      </text>

      {/* Preflight callout above spine, if present */}
      {hit ? (
        <g>
          <rect
            x={cx - 130}
            y={SPINE_Y - 100}
            width={260}
            height={28}
            rx={6}
            fill={blocked ? "rgba(239,68,68,0.10)" : "rgba(245,158,11,0.10)"}
            stroke={blocked ? "rgba(239,68,68,0.5)" : "rgba(245,158,11,0.45)"}
          />
          <text
            x={cx - 116}
            y={SPINE_Y - 81}
            fill={blocked ? "#fca5a5" : "#fcd34d"}
            fontFamily="Geist, Inter, sans-serif"
            fontSize={10.5}
            fontWeight={700}
          >
            {blocked ? "PREFLIGHT · BLOCKED" : "PREFLIGHT"}
          </text>
          <text
            x={cx + 4}
            y={SPINE_Y - 81}
            fill="#c8cdde"
            fontFamily="Geist, Inter, sans-serif"
            fontSize={10.5}
          >
            {hit.top_failure_modes?.[0]?.name
              ? truncate(hit.top_failure_modes[0].name, 28)
              : `${attempt.preflight.length} hit${attempt.preflight.length === 1 ? "" : "s"}`}
          </text>
          <line
            x1={cx}
            y1={SPINE_Y - 72}
            x2={cx}
            y2={SPINE_Y - 16}
            stroke={blocked ? "rgba(239,68,68,0.55)" : "rgba(245,158,11,0.55)"}
            strokeWidth={1.5}
            strokeDasharray="3 3"
          />
        </g>
      ) : null}

      {/* Spine node */}
      <circle cx={cx} cy={SPINE_Y} r={16} fill="rgba(91,141,239,0.18)" />
      <circle cx={cx} cy={SPINE_Y} r={9} fill="#5b8def" />

      {/* Branch */}
      {o.kind === "rejected" ? (
        <RejectionBranch cx={cx} attempt={attempt} reason={o.reason} failureMode={o.failureMode} />
      ) : o.kind === "approved" ? (
        <ApprovalBranch cx={cx} mergeX={Math.min(nextCx, cx + STEP_WIDTH * 0.8)} attempt={attempt} />
      ) : (
        <ActiveBranch cx={cx} />
      )}

      {/* Faint indicator linking the spine through */}
      {/* (color is implicit from labelColor — keeps it visually in sync) */}
      <rect x={cx - 0.5} y={SPINE_Y} width={0.5} height={1} fill={labelColor} opacity={0} />
    </g>
  )
}

function RejectionBranch({
  cx,
  attempt,
  reason,
  failureMode,
}: {
  cx: number
  attempt: Attempt
  reason: string
  failureMode: string | null
}) {
  const tipX = cx + 40
  const tipY = SPINE_Y + 130
  const path = `M ${cx} ${SPINE_Y} C ${cx + 8} ${SPINE_Y + 60}, ${cx + 24} ${SPINE_Y + 90}, ${tipX} ${tipY}`
  const toolSummary = summarizeAttempt(attempt)
  return (
    <g>
      <path d={path} stroke="rgba(239,68,68,0.6)" strokeWidth={2} fill="none" strokeLinecap="round" />
      {toolSummary ? (
        <g>
          <rect
            x={cx - 80}
            y={SPINE_Y + 38}
            width={160}
            height={40}
            rx={8}
            fill="rgba(20,22,32,0.9)"
            stroke="rgba(120,130,160,0.25)"
          />
          <text
            x={cx}
            y={SPINE_Y + 56}
            textAnchor="middle"
            fill="#c8cdde"
            fontFamily="Geist, Inter, sans-serif"
            fontSize={11.5}
          >
            {truncate(toolSummary, 26)}
          </text>
          <text
            x={cx}
            y={SPINE_Y + 71}
            textAnchor="middle"
            fill="#9ea0b3"
            fontFamily="Geist, Inter, sans-serif"
            fontSize={10.5}
          >
            {attempt.toolCalls.length} tool call{attempt.toolCalls.length === 1 ? "" : "s"}
          </text>
        </g>
      ) : null}
      {/* ✕ marker */}
      <circle cx={tipX} cy={tipY} r={14} fill="rgba(239,68,68,0.18)" stroke="rgba(239,68,68,0.6)" strokeWidth={1.5} />
      <path
        d={`M ${tipX - 7} ${tipY - 7} L ${tipX + 7} ${tipY + 7} M ${tipX + 7} ${tipY - 7} L ${tipX - 7} ${tipY + 7}`}
        stroke="#fca5a5"
        strokeWidth={2.2}
        strokeLinecap="round"
      />
      <text
        x={tipX}
        y={tipY + 36}
        textAnchor="middle"
        fill="#fca5a5"
        fontFamily="Geist, Inter, sans-serif"
        fontSize={12}
        fontWeight={600}
      >
        rejected
      </text>
      <text
        x={tipX}
        y={tipY + 52}
        textAnchor="middle"
        fill="#9ea0b3"
        fontFamily="Geist, Inter, sans-serif"
        fontSize={11}
      >
        {truncate(reason || "see autopsy", 36)}
      </text>
      {failureMode ? (
        <g>
          <rect
            x={tipX - 88}
            y={tipY + 64}
            width={176}
            height={36}
            rx={6}
            fill="rgba(239,68,68,0.10)"
            stroke="rgba(239,68,68,0.4)"
            strokeDasharray="3 3"
          />
          <text
            x={tipX}
            y={tipY + 80}
            textAnchor="middle"
            fill="#fca5a5"
            fontFamily="Geist, Inter, sans-serif"
            fontSize={10.5}
            fontWeight={600}
          >
            FailureMode
          </text>
          <text
            x={tipX}
            y={tipY + 94}
            textAnchor="middle"
            fill="#fca5a5"
            fontFamily="Geist, Inter, sans-serif"
            fontSize={10.5}
          >
            {truncate(failureMode, 28)}
          </text>
        </g>
      ) : null}
    </g>
  )
}

function ApprovalBranch({
  cx,
  mergeX,
  attempt,
}: {
  cx: number
  mergeX: number
  attempt: Attempt
}) {
  const dipY = SPINE_Y + 110
  const path = `M ${cx} ${SPINE_Y} C ${cx + 16} ${SPINE_Y + 70}, ${cx + 60} ${dipY}, ${(cx + mergeX) / 2} ${dipY} C ${mergeX - 30} ${dipY}, ${mergeX - 12} ${SPINE_Y + 60}, ${mergeX} ${SPINE_Y + 4}`
  const summary = summarizeAttempt(attempt)
  return (
    <g>
      <path d={path} stroke="rgba(34,197,94,0.55)" strokeWidth={2} fill="none" strokeLinecap="round" />
      {summary ? (
        <g>
          <rect
            x={(cx + mergeX) / 2 - 90}
            y={dipY - 22}
            width={180}
            height={44}
            rx={9}
            fill="rgba(20,22,32,0.9)"
            stroke="rgba(120,130,160,0.25)"
          />
          <text
            x={(cx + mergeX) / 2}
            y={dipY - 5}
            textAnchor="middle"
            fill="#c8cdde"
            fontFamily="Geist, Inter, sans-serif"
            fontSize={11.5}
          >
            {truncate(summary, 28)}
          </text>
          <text
            x={(cx + mergeX) / 2}
            y={dipY + 12}
            textAnchor="middle"
            fill="#86efac"
            fontFamily="Geist, Inter, sans-serif"
            fontSize={10.5}
          >
            postflight green
          </text>
        </g>
      ) : null}
      {/* Merge node back on spine */}
      <circle cx={mergeX} cy={SPINE_Y + 2} r={7} fill="#22c55e" stroke="rgba(34,197,94,0.5)" strokeWidth={3} />
      <text
        x={mergeX}
        y={SPINE_Y - 12}
        textAnchor="middle"
        fill="#86efac"
        fontFamily="Geist, Inter, sans-serif"
        fontSize={11}
        fontWeight={600}
      >
        approved
      </text>
    </g>
  )
}

function ActiveBranch({ cx }: { cx: number }) {
  return (
    <g>
      <path
        d={`M ${cx} ${SPINE_Y} L ${cx + 12} ${SPINE_Y + 60}`}
        stroke="rgba(91,141,239,0.55)"
        strokeWidth={2}
        strokeDasharray="4 4"
        fill="none"
        strokeLinecap="round"
      />
      <text
        x={cx + 12}
        y={SPINE_Y + 80}
        textAnchor="middle"
        fill="#9ea0b3"
        fontFamily="Geist, Inter, sans-serif"
        fontSize={11}
      >
        in progress
      </text>
    </g>
  )
}

function summarizeAttempt(att: Attempt): string {
  if (att.toolCalls.length === 0 && att.fileEdits.length === 0) return ""
  const tools = Array.from(new Set(att.toolCalls.map((t) => t.tool)))
  return tools.slice(0, 3).join(" · ")
}

function truncate(s: string, n: number): string {
  if (!s) return ""
  return s.length <= n ? s : s.slice(0, n - 1) + "…"
}

function Legend() {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-2 text-[11px] text-muted-foreground">
      <span className="flex items-center gap-1.5">
        <span className="inline-block h-2 w-2 rounded-full bg-primary" /> user spine
      </span>
      <span className="flex items-center gap-1.5">
        <span className="inline-block h-2 w-2 rounded-full bg-amber-400" /> preflight warning
      </span>
      <span className="flex items-center gap-1.5">
        <span className="inline-block h-2 w-2 rounded-full bg-destructive" /> rejection (✕)
      </span>
      <span className="flex items-center gap-1.5">
        <span className="inline-block h-2 w-2 rounded-full bg-emerald-400" /> approved (merge)
      </span>
    </div>
  )
}
