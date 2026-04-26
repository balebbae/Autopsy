// Shared frustration-detection utilities used by both the event and
// chat-message handlers. Extracted so the `firedSessions` dedup set
// is a single instance regardless of which code path fires first.

// Words / phrases that signal the user is unhappy with the agent's last
// action. Covers both explicit profanity and subtler negative sentiment
// ("wasn't great", "try again"). We only fire once per session so false
// positives are bounded.
export const FRUSTRATION_RE =
  /\b(shit|shitty|fuck|fucking|fucked|wtf|trash|garbage|terrible|horrible|awful|useless|stupid|idiot|dumb|crap|crappy|kill\s*(yourself|urself)|kys|this\s+sucks|worst|redo\s+(this|it|everything)|start\s+over|completely\s+wrong|totally\s+wrong|not\s+what\s+i\s+(asked|wanted|said)|that('?s| is)\s+(bad|wrong|broken|not\s+right|incorrect)|wh(y|at the hell|at the heck)\s+(did|are|is|would)\s+you|you\s+(broke|messed\s+up|ruined|fucked\s+up|screwed\s+up)|undo\s+(this|that|it)|revert\s+(this|that|it)|don'?t\s+do\s+that|do\s+not\s+do\s+that|stop\s+(it|that)|never\s+(do|did)\s+that|that('?s| is)\s+not\s+what|hate\s+(this|that|it)|wasn'?t\s+(great|good|right|correct|helpful|what\s+i)|not\s+(great|good|helpful|impressed|happy|satisfied)|try\s+again|do\s+(it|this|that)\s+(again|over)|disappointed|let\s+down|no+\s+no+|wrong\s+again|still\s+(wrong|broken|bad|not))\b/i

// Track sessions where we already fired a frustration rejection so we
// don't spam. Bounded LRU so long-running plugin processes don't leak.
const FIRED_SESSIONS_LIMIT = 1024
export const firedSessions = new Set<string>()
export const markSessionFired = (runId: string): boolean => {
  if (firedSessions.has(runId)) return false
  firedSessions.add(runId)
  if (firedSessions.size > FIRED_SESSIONS_LIMIT) {
    const oldest = firedSessions.values().next().value
    if (oldest !== undefined) firedSessions.delete(oldest)
  }
  return true
}
