import * as React from "react"
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  FileDiff,
  GitBranch,
  Hammer,
  ListChecks,
  MessageSquare,
  Moon,
  Play,
  Shield,
  ShieldAlert,
  Sparkles,
  StopCircle,
  Wrench,
  XCircle,
  Zap,
  type LucideIcon,
} from "lucide-react"

import { cn } from "@/lib/utils"

type EventMeta = { Icon: LucideIcon; tone: string }

const map: Record<string, EventMeta> = {
  "session.created": { Icon: Play, tone: "text-sky-500" },
  "session.updated": { Icon: ArrowRight, tone: "text-muted-foreground" },
  "session.idle": { Icon: Moon, tone: "text-muted-foreground" },
  "session.diff": { Icon: GitBranch, tone: "text-violet-500" },
  "tool.execute.before": { Icon: Wrench, tone: "text-muted-foreground" },
  "tool.execute.after": { Icon: Hammer, tone: "text-emerald-500" },
  "file.edited": { Icon: FileDiff, tone: "text-emerald-500" },
  "permission.asked": { Icon: Shield, tone: "text-amber-500" },
  "permission.replied": { Icon: ShieldAlert, tone: "text-amber-500" },
  "message.part.updated": { Icon: MessageSquare, tone: "text-muted-foreground" },
  "message.created": { Icon: MessageSquare, tone: "text-muted-foreground" },
  "message.updated": { Icon: MessageSquare, tone: "text-muted-foreground" },
  "chat.message": { Icon: MessageSquare, tone: "text-sky-500" },
  "aag.preflight.warned": { Icon: AlertTriangle, tone: "text-amber-500" },
  "aag.preflight.blocked": { Icon: StopCircle, tone: "text-red-500" },
  "aag.system.injected": { Icon: Sparkles, tone: "text-primary" },
  "aag.postflight.started": { Icon: ListChecks, tone: "text-muted-foreground" },
  "aag.postflight.completed": { Icon: CheckCircle2, tone: "text-emerald-500" },
  "aag.postflight.failed": { Icon: XCircle, tone: "text-red-500" },
}

export function EventIcon({ type, className }: { type: string; className?: string }) {
  const meta = map[type] ?? { Icon: Zap, tone: "text-muted-foreground" }
  const Icon = meta.Icon
  return <Icon className={cn("h-4 w-4 shrink-0", meta.tone, className)} aria-hidden="true" />
}

export function eventTone(type: string): string {
  return (map[type] ?? { tone: "text-muted-foreground" }).tone
}
