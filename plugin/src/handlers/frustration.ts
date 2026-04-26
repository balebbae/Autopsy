// Shared frustration-detection utilities used by both the event and
// chat-message handlers. Extracted so the `firedSessions` dedup set
// is a single instance regardless of which code path fires first.

// ---------------------------------------------------------------------------
// Frustration patterns — organized by category.
//
// Each entry is a regex source string (case-insensitive, word-bounded).
// We only fire once per session so false positives are bounded, but we
// still avoid overly broad patterns ("no", "wrong", "fix") that would
// match normal instructions.
// ---------------------------------------------------------------------------

const PROFANITY = [
  "shit",
  "shitty",
  "fuck",
  "fucking",
  "fucked",
  "fucked\\s+up",
  "wtf",
  "ffs",
  "jfc",
  "fml",
  "stfu",
  "damn\\s+it",
  "dammit",
  "goddam(n|mit)",
  "hell\\s+no",
  "bs",
  "bullshit",
]

const INSULTS_AND_STRONG_NEGATIVES = [
  "trash",
  "garbage",
  "terrible",
  "horrible",
  "awful",
  "useless",
  "stupid",
  "idiot",
  "idiotic",
  "dumb",
  "crap",
  "crappy",
  "pathetic",
  "laughable",
  "embarrassing",
  "atrocious",
  "abysmal",
  "incompetent",
  "braindead",
  "brain\\s+dead",
  "moronic",
  "worthless",
  "hopeless",
  "pointless",
  "ridiculous",
  "absurd",
  "unacceptable",
  "inadequate",
]

const EXASPERATION = [
  "this\\s+sucks",
  "worst",
  "omg",
  "oh\\s+my\\s+god",
  "come\\s+on",
  "oh\\s+come\\s+on",
  "seriously\\??",
  "are\\s+you\\s+(kidding|serious|joking)",
  "you('re|\\s+are)\\s+(kidding|joking)",
  "got\\s+to\\s+be\\s+kidding",
  "unbelievable",
  "sigh",
  "ugh+",
  "bruh",
  "bro\\s+what",
  "smh",
  "for\\s+(fuck|god|christ)('?s|s?)\\s+sake",
  "what\\s+the\\s+(hell|heck|fuck)",
  "what\\s+on\\s+earth",
  "no+\\s+no+",
  "oh\\s+no",
  "good\\s+grief",
  "give\\s+me\\s+a\\s+break",
  "i\\s+can('t|not)\\s+(believe|even)",
]

const DIRECT_NEGATIVE_FEEDBACK = [
  "that('?s|\\s+is)\\s+(bad|wrong|broken|not\\s+right|incorrect|terrible|awful|horrible|trash|garbage|useless|worse)",
  "this\\s+is\\s+(bad|wrong|broken|not\\s+right|incorrect|terrible|awful|horrible|trash|garbage|useless|worse|a\\s+mess)",
  "that('?s|\\s+is)\\s+not\\s+what",
  "wasn'?t\\s+(great|good|right|correct|helpful|what\\s+i|even\\s+close)",
  "not\\s+(great|good|helpful|impressed|happy|satisfied|useful|correct|right|even\\s+close|what\\s+i)",
  "didn'?t\\s+(work|help|fix|do\\s+anything|change\\s+anything|do\\s+what\\s+i)",
  "doesn'?t\\s+(work|look\\s+right|seem\\s+right|make\\s+sense)",
  "isn'?t\\s+(right|correct|working|what\\s+i)",
  "not\\s+working",
  "still\\s+(wrong|broken|bad|not|failing|doesn'?t|isn'?t|the\\s+same)",
  "wrong\\s+again",
  "no\\s+good",
  "not\\s+good\\s+enough",
  "not\\s+even\\s+close",
  "way\\s+off",
  "completely\\s+off",
  "totally\\s+off",
  "missed\\s+the\\s+(point|mark)",
  "that('?s|\\s+is)\\s+the\\s+opposite",
]

const BLAME_AND_ACCUSATION = [
  "you\\s+(broke|messed\\s+up|ruined|fucked\\s+up|screwed\\s+up|destroyed|wrecked|botched|bungled)",
  "you\\s+made\\s+(it|this|that|things?)\\s+(worse|worst|broken)",
  "you('re|\\s+are)\\s+(wrong|not\\s+listening|ignoring|not\\s+reading|not\\s+paying\\s+attention)",
  "wh(y|at\\s+the\\s+hell|at\\s+the\\s+heck)\\s+(did|are|is|would)\\s+you",
  "what\\s+did\\s+you\\s+do",
  "what\\s+have\\s+you\\s+done",
  "how\\s+did\\s+you\\s+mess",
  "can\\s+you\\s+(even\\s+)?read",
  "did\\s+you\\s+(even\\s+)?(read|look|check|see|understand|listen)",
  "pay\\s+attention",
  "listen\\s+to\\s+me",
]

const NOT_WHAT_I_ASKED = [
  "not\\s+what\\s+i\\s+(asked|wanted|said|meant|described|requested|specified|told)",
  "i\\s+(already|literally|just|explicitly)\\s+(said|told|asked|mentioned|wrote|specified|explained)",
  "i\\s+said\\s+to",
  "read\\s+(the|my|what\\s+i)\\s+(instructions|prompt|message|request|description)",
  "follow\\s+(the\\s+)?instructions",
  "read\\s+what\\s+i\\s+(wrote|said|asked)",
  "that('?s|\\s+is)\\s+not\\s+what\\s+i",
  "i\\s+didn'?t\\s+(ask|want|say|mean)\\s+(for|you\\s+to|that|this)",
]

const REDO_AND_REVERT = [
  "redo\\s+(this|it|everything|that|the\\s+whole)",
  "start\\s+over",
  "try\\s+again",
  "do\\s+(it|this|that)\\s+(again|over|properly|correctly|right)",
  "undo\\s+(this|that|it|everything|all)",
  "revert\\s+(this|that|it|everything|all|the\\s+changes?)",
  "roll\\s*(it\\s+)?back",
  "change\\s+(it|this|that)\\s+back",
  "put\\s+(it|this|that)\\s+back",
  "go\\s+back\\s+to",
  "restore\\s+(it|this|that|the)",
  "bring\\s+(it|this|that)\\s+back",
  "take\\s+(it|that|this)\\s+back",
]

const STOP_AND_DONT = [
  "don'?t\\s+do\\s+that",
  "do\\s+not\\s+do\\s+that",
  "stop\\s+(it|that|doing|this|changing|breaking)",
  "never\\s+(do|did)\\s+that",
  "quit\\s+(it|that|doing)",
  "enough\\s+(already|of\\s+this|with\\s+this|!)?",
  "just\\s+stop",
  "please\\s+stop",
  "cut\\s+it\\s+out",
]

const GIVING_UP = [
  "forget\\s*(it|this|that|about\\s+it)",
  "never\\s*mind",
  "nevermind",
  "i('ll|\\s+will)\\s+(just\\s+)?do\\s+it\\s+(myself|my\\s+own)",
  "let\\s+me\\s+do\\s+it",
  "i\\s+give\\s+up",
  "i('m|\\s+am)\\s+done\\s+(with\\s+(this|you|it)|trying)",
  "waste\\s+of\\s+(time|my\\s+time|effort)",
  "wasting\\s+(my\\s+)?time",
  "thanks\\s+for\\s+nothing",
  "this\\s+is\\s+(a\\s+)?waste",
  "i('ll|\\s+will)\\s+find\\s+(someone|something)\\s+else",
]

const WORSE_THAN_BEFORE = [
  "worse\\s+than\\s+(before|it\\s+was|earlier|the\\s+original)",
  "even\\s+worse",
  "it\\s+was\\s+(working|fine|better|correct|right)\\s+before",
  "now\\s+(it('?s|\\s+is)|you('ve|\\s+have))\\s+(broken|worse|messed|ruined)",
  "you\\s+just\\s+made\\s+it\\s+worse",
  "went\\s+(from\\s+bad\\s+to\\s+worse|backwards|backward)",
  "regression",
]

const REPEATED_FAILURE = [
  "same\\s+(mistake|error|problem|issue|bug|thing)",
  "keeps?\\s+happening",
  "happening\\s+again",
  "you\\s+keep\\s+(doing|making|breaking|ignoring|missing|getting\\s+it\\s+wrong)",
  "every\\s+(single\\s+)?time",
  "over\\s+and\\s+over",
  "how\\s+many\\s+times",
  "already\\s+told\\s+you",
  "told\\s+you\\s+(this|that|before|already)",
  "we('ve|\\s+have)\\s+been\\s+over\\s+this",
  "again\\s+and\\s+again",
]

const QUESTIONING_ABILITY = [
  "how\\s+hard\\s+(can\\s+it|is\\s+(it|this)|could\\s+it)\\s+be",
  "it('?s|\\s+is)\\s+not\\s+(that\\s+)?(hard|complicated|difficult|complex|rocket\\s+science)",
  "this\\s+should\\s+(be\\s+)?(simple|easy|straightforward|trivial|obvious)",
  "a\\s+(simple|basic|trivial|easy)\\s+task",
  "even\\s+(a\\s+)?(beginner|junior|child|kid|intern)\\s+(could|would|can)",
  "do\\s+you\\s+(even\\s+)?(understand|know|get)",
]

const DISAPPOINTMENT = [
  "disappointed",
  "let\\s+(me\\s+)?down",
  "expected\\s+(better|more|it\\s+to)",
  "i\\s+expected",
  "thought\\s+you\\s+(could|would|were)",
  "so\\s+much\\s+for",
  "what\\s+a\\s+(mess|disaster|joke|waste|letdown|disappointment)",
]

const HATE = [
  "hate\\s+(this|that|it)",
  "can'?t\\s+stand\\s+(this|that|it)",
  "sick\\s+of\\s+(this|that|it)",
  "tired\\s+of\\s+(this|that|it)",
  "fed\\s+up",
  "had\\s+enough",
  "had\\s+it\\s+with",
  "annoying",
  "infuriating",
  "frustrating",
  "maddening",
  "aggravating",
  "irritating",
]

const THREATS = [
  "kill\\s*(yourself|urself)",
  "kys",
]

// Build the combined pattern from all categories.
const ALL_PATTERNS = [
  ...PROFANITY,
  ...INSULTS_AND_STRONG_NEGATIVES,
  ...EXASPERATION,
  ...DIRECT_NEGATIVE_FEEDBACK,
  ...BLAME_AND_ACCUSATION,
  ...NOT_WHAT_I_ASKED,
  ...REDO_AND_REVERT,
  ...STOP_AND_DONT,
  ...GIVING_UP,
  ...WORSE_THAN_BEFORE,
  ...REPEATED_FAILURE,
  ...QUESTIONING_ABILITY,
  ...DISAPPOINTMENT,
  ...HATE,
  ...THREATS,
]

export const FRUSTRATION_RE = new RegExp(
  `\\b(${ALL_PATTERNS.join("|")})\\b`,
  "i",
)

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
