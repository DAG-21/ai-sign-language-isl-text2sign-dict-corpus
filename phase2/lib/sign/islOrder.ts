/**
 * Word order for ISL gloss, from the NIOS "Indian Sign Language" secondary course (230), Lesson 10 "Sentence Types" and Lesson 9 "Word-Level Structures".
 *
 * What the textbook shows, and what this module does with it:
 *   - time first, then place, subject, object, verb:      TONIGHT HOME COME NOT / I PLAN DELHI TRAIN GO / I TONIGHT HOME GO LATE (10.2)
 *   - NOT and the other negations at the end:             MORNING SLEEP LATE LIKE NOT (10.1)
 *   - HAVE at the end:                                    BROTHER/SISTER HAVE? (10.1)
 *   - MUST after the verb, at the end:                    CLASS STUDENTS SIT MUST (10.2)
 *   - question words at the end:                          YOU GO WHERE (10.2)
 *
 * The step is deliberately conservative. It works on one clause of gloss words and does not parse English, so it only does what is safe without knowing the
 * grammar: it moves time phrases to the front, the tail words (MUST, HAVE, negations, question words) to the end, and a clause's only verb to just before them. A
 * sentence with several clauses (IF, BECAUSE, two subjects...) is left exactly as it was. It never drops, adds or renames a word.
 *
 * Not done here: dropping English function words (WILL, IN, AT, YOUR), repetition (FRIDAY++), putting a place phrase first, or deciding between two verbs.
 */

export type OrderResult = {
  tokens: string[]
  /** True when the tokens changed. */
  changed: boolean
  /** One short line per rule that moved something, or the reason the sentence was left alone. */
  notes: string[]
}

const TIME_WORDS = new Set([
  'YESTERDAY', 'TODAY', 'TOMORROW', 'TONIGHT', 'NOW', 'MORNING', 'AFTERNOON', 'EVENING', 'NIGHT', 'DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY',
  'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY',
  'JANUARY', 'FEBRUARY', 'MARCH', 'APRIL', 'MAY_MONTH', 'JUNE', 'JULY', 'AUGUST', 'SEPTEMBER', 'OCTOBER', 'NOVEMBER', 'DECEMBER',
])
/** Units that, with a number or EVERY/LAST/NEXT before them, make a time phrase ("3 YEARS", "EVERY WEEK", "LAST MONTH"). */
const TIME_UNITS = new Set(['YEAR', 'YEARS', 'MONTH', 'MONTHS', 'WEEK', 'WEEKS', 'DAY', 'DAYS', 'HOUR', 'HOURS', 'MINUTE', 'MINUTES'])
const TIME_PREFIX = new Set(['EVERY', 'LAST', 'NEXT'])
const AGO = new Set(['AGO'])

const QUESTION_WORDS = new Set(['WHAT', 'WHERE', 'WHO', 'WHOM', 'WHEN', 'WHY', 'HOW', 'WHICH', 'HOW_MANY', 'HOW_MUCH', 'WHAT_TIME'])
const NEGATIONS = new Set(['NOT', 'NO', 'NEVER', 'NOTHING', 'NONE', 'DONT', "DON'T", 'CANNOT', 'NOT_POSSIBLE', 'DONT_WANT', "DON'T_WANT"])
const MODALS = new Set(['MUST'])
const HAVE_FORMS = new Set(['HAVE', 'HAS', 'HAD'])

/** Words that start a second clause: a sentence containing one is left alone, because clause boundaries need a parse. */
const CLAUSE_MARKERS = new Set(['IF', 'UNLESS', 'WHENEVER', 'WHILE', 'BECAUSE', 'BUT', 'AND', 'THEN', 'THAN', 'ALTHOUGH', 'SINCE'])
const SUBJECT_PRONOUNS = new Set(['I', 'WE', 'HE', 'SHE', 'THEY'])

/** Common action verbs in the gloss's base form. Only used to find "the one verb of the clause", so it errs toward missing a verb, which leaves order alone. */
const VERBS = new Set([
  'GO', 'COME', 'EAT', 'DRINK', 'SLEEP', 'LIKE', 'LOVE', 'WANT', 'NEED', 'KNOW', 'SEE', 'LOOK', 'WATCH', 'HEAR', 'LISTEN', 'SIT', 'STAND', 'RUN', 'WALK', 'PLAY', 'WORK',
  'READ', 'WRITE', 'TEACH', 'LEARN', 'STUDY', 'TAKE', 'GIVE', 'BUY', 'SELL', 'MAKE', 'COOK', 'CALL', 'HELP', 'MEET', 'FINISH', 'START', 'PASS', 'FAIL', 'PLAN', 'STAY', 'LIVE',
  'TALK', 'SAY', 'TELL', 'ASK', 'ANSWER', 'THINK', 'FEEL', 'OPEN', 'CLOSE', 'BRING', 'SEND', 'GET', 'FIND', 'LOSE', 'WIN', 'PAY', 'WAIT', 'STOP', 'TRY', 'USE', 'WEAR', 'WASH',
  'CLEAN', 'DRIVE', 'TRAVEL', 'ARRIVE', 'LEAVE', 'RETURN', 'REMEMBER', 'FORGET', 'UNDERSTAND', 'EXPLAIN', 'SHOW', 'KEEP', 'PUT', 'BUILD', 'BREAK', 'FIX', 'SING', 'DANCE',
  'LAUGH', 'CRY', 'RAIN', 'MARRY', 'BORN', 'DIE', 'SIGN', 'DECIDE', 'CHOOSE', 'JOIN', 'INVITE', 'WELCOME', 'THANK', 'SORRY', 'ENJOY', 'TOUCH', 'BELIEVE', 'AGREE', 'ATTEND',
])

const isNumber = (t: string) => /^\d+$/.test(t)

/** Indices of the time phrases in a clause, as runs of consecutive tokens: [start, end) pairs. */
function timeRuns(tokens: readonly string[]): [number, number][] {
  const runs: [number, number][] = []
  let i = 0
  while (i < tokens.length) {
    const t = tokens[i]
    let end = -1
    if (TIME_WORDS.has(t)) {
      end = i + 1
    } else if ((isNumber(t) || TIME_PREFIX.has(t)) && i + 1 < tokens.length && TIME_UNITS.has(tokens[i + 1])) {
      end = i + 2
    }
    if (end < 0) {
      i += 1
      continue
    }
    if (end < tokens.length && AGO.has(tokens[end])) end += 1
    // "EVERY FRIDAY": a prefix right before a time word belongs to the phrase.
    runs.push([i, end])
    i = end
  }
  // An EVERY/LAST/NEXT directly before a run that starts with a time word joins that run.
  for (let r = 0; r < runs.length; r += 1) {
    const [s, e] = runs[r]
    if (s > 0 && TIME_PREFIX.has(tokens[s - 1]) && TIME_WORDS.has(tokens[s])) runs[r] = [s - 1, e]
  }
  return runs
}

/** Moves the rule-based position words of one clause. Returns the new tokens and the notes; the input is never changed. */
export function reorderForIsl(input: readonly string[]): OrderResult {
  const tokens = [...input]
  const keep = (reason?: string): OrderResult => ({ tokens, changed: false, notes: reason ? [reason] : [] })
  if (tokens.length < 2) return keep()

  if (tokens.some((t) => CLAUSE_MARKERS.has(t))) return keep('Left in place: more than one clause')
  if (tokens.filter((t) => SUBJECT_PRONOUNS.has(t)).length >= 2) return keep('Left in place: more than one subject')

  const used = new Array<boolean>(tokens.length).fill(false)
  const take = (pred: (t: string) => boolean): string[] => {
    const out: string[] = []
    tokens.forEach((t, i) => {
      if (!used[i] && pred(t)) {
        used[i] = true
        out.push(t)
      }
    })
    return out
  }

  const notes: string[] = []

  // Time phrases first, in their original order.
  const time: string[] = []
  for (const [s, e] of timeRuns(tokens)) {
    if (used.slice(s, e).some(Boolean)) continue
    for (let i = s; i < e; i += 1) {
      used[i] = true
      time.push(tokens[i])
    }
  }

  // The tail, in the textbook's order: MUST, HAVE, negation, question word.
  const modal = take((t) => MODALS.has(t))
  const have = take((t) => HAVE_FORMS.has(t))
  const neg = take((t) => NEGATIONS.has(t))
  const question = take((t) => QUESTION_WORDS.has(t))

  // What is left is the core of the clause. If it has exactly one verb, that verb goes last.
  const coreIdx = tokens.map((_, i) => i).filter((i) => !used[i])
  const core = coreIdx.map((i) => tokens[i])
  const verbPositions = core.flatMap((t, i) => (VERBS.has(t) ? [i] : []))
  let orderedCore = core
  if (verbPositions.length === 1 && verbPositions[0] !== core.length - 1) {
    const v = verbPositions[0]
    orderedCore = [...core.slice(0, v), ...core.slice(v + 1), core[v]]
    notes.push(`Verb last: ${core[v]}`)
  } else if (verbPositions.length > 1) {
    notes.push('Verb position kept: several verbs')
  }

  const out = [...time, ...orderedCore, ...modal, ...have, ...neg, ...question]
  if (time.length && tokens.slice(0, time.length).join(' ') !== time.join(' ')) notes.unshift(`Time first: ${time.join(' ')}`)
  const tail = [...modal, ...have, ...neg, ...question]
  if (tail.length && tokens.slice(tokens.length - tail.length).join(' ') !== tail.join(' ')) {
    notes.push(`Last: ${tail.join(' ')}`)
  }

  const changed = out.join(' ') !== tokens.join(' ')
  return { tokens: changed ? out : tokens, changed, notes: changed ? notes.filter((n) => !n.startsWith('Verb position kept')) : notes.filter((n) => n.startsWith('Verb position kept')) }
}
