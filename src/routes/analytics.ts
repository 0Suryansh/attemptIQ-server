import { Router } from 'express'
import { requireUser } from '../auth.js'
import { MARK_CORRECT, MARK_WRONG, MOCK_QUESTIONS, all, getCurrentMistakes } from '../db.js'

export const analyticsRouter = Router()

// ------------------------------------------------------------------- goal
// The target this whole app is built around: 80% accuracy and 80% attempt
// rate on a mock. Surfaced to the client rather than hardcoded there too, so
// the goal and the nudges read from this one place.
const GOAL_ACCURACY = 0.8
const GOAL_ATTEMPT_RATE = 0.8

/**
 * The whole paper, if Physics and Chemistry went the same way as the Maths
 * mock section did.
 *
 * Mirrors `projectTotal` in frontend/src/lib/jeeScore.ts, which the landing
 * page's score simulator uses -- kept identical so a mock's actual average
 * score and a hypothetical one produce comparable percentiles.
 */
function projectTotal(sectionScore: number): number {
  return sectionScore * 3
}

/**
 * Total marks (out of 300) -> percentile.
 *
 * Mirrors `percentileFor` in frontend/src/lib/jeeScore.ts exactly (same
 * anchors, same interpolation), so the dashboard's estimate and the landing
 * page simulator's estimate agree for the same underlying performance
 * instead of the two drifting apart under separate curves. See that file for
 * where the anchor table comes from and its caveats.
 */
const PERCENTILE_ANCHORS: readonly (readonly [marks: number, percentile: number])[] = [
  [0, 0],
  [10, 6.6],
  [20, 20.95],
  [30, 40.35],
  [40, 59.84],
  [50, 73.29],
  [60, 82.02],
  [70, 87.51],
  [80, 91.07],
  [90, 93.47],
  [100, 95.0],
  [110, 96.2],
  [120, 97.14],
  [130, 97.81],
  [140, 98.32],
  [150, 98.73],
  [160, 99.03],
  [170, 99.27],
  [180, 99.46],
  [190, 99.6],
  [200, 99.71],
  [210, 99.8],
  [220, 99.85],
  [230, 99.9],
  [240, 99.94],
  [250, 99.95],
  [260, 99.98],
  [270, 99.99],
  [280, 99.994],
  [290, 99.999],
  [300, 100],
]

function percentileFor(totalMarks: number): number {
  const marks = Math.max(0, Math.min(300, totalMarks))

  for (let i = 1; i < PERCENTILE_ANCHORS.length; i++) {
    const [upperMarks, upperPercentile] = PERCENTILE_ANCHORS[i]
    if (marks > upperMarks) continue

    const [lowerMarks, lowerPercentile] = PERCENTILE_ANCHORS[i - 1]
    const span = upperMarks - lowerMarks
    const ratio = span === 0 ? 0 : (marks - lowerMarks) / span
    return Math.round((lowerPercentile + ratio * (upperPercentile - lowerPercentile)) * 10) / 10
  }

  return 100
}

interface TopicSourceRow {
  topic: string
  source: 'mock' | 'drill'
  attempted: number
  correct: number
  time_ms: number
}

interface MockRow {
  id: number
  name: string | null
  submitted_at: string
  attempted: number
  correct: number
  wrong: number
}

interface DrillRow {
  id: number
  topic: string
  status: 'active' | 'ended'
  end_reason: string | null
  streak_best: number
  answered_count: number
  correct_count: number
  created_at: string
  ended_at: string | null
}

/** One scope's worth of stats for a topic -- "scope" meaning mocks, drills,
 *  or both pooled together, since a student may want to know "am I weak
 *  here" for either mode on its own as well as combined. */
export interface TopicScopeStat {
  attempted: number
  correct: number
  wrong: number
  accuracy: number
  timeMs: number
  /** Average seconds spent per attempted question. */
  avgSec: number
  /** Marks per minute under +4/-1 marking -- accuracy and pace folded into
   *  the one number that actually decides solve-first/second-pass/leave, the
   *  same metric the landing page's sample card and simulator use. 0 with no
   *  timed data yet, rather than a divide-by-zero. */
  marksPerMin: number
}

export interface TopicStat {
  topic: string
  all: TopicScopeStat
  mock: TopicScopeStat
  drill: TopicScopeStat
}

/** The dashboard's full drill-topic picker: every topic in the bank against
 *  its own attempted/correct, independent of `TopicStat` above -- this one
 *  has no per-scope or timing breakdown, just enough to answer "what have I
 *  covered and what's left". */
export interface DrillTopicStat {
  topic: string
  attempted: number
  correct: number
  wrong: number
  accuracy: number
  /** How many questions exist in the bank for this topic -- shown next to
   *  the attempted count so "6 attempted" reads against something. */
  bankCount: number
}

export interface RecentActivity {
  type: 'mock' | 'drill'
  id: number
  label: string
  when: string
  attempted: number
  correct: number
  wrong: number
  accuracy: number
  /** Only present for a mock: the JEE-marked score, +4/-1. */
  score?: number
}

/**
 * Every response this account has ever given, topic by topic.
 *
 * Pooled across both modes, the same way the reference analytics page pools
 * across attempts -- a wrong answer in a mock and a wrong answer in a drill
 * are the same signal about the same topic. `answered_at IS NOT NULL` /
 * `status = 'answered'` both mean the same thing in their own table: a
 * response actually given, not a slot the player never reached.
 */
/**
 * Every topic in the bank, not just the ones this account has touched --
 * the picker the dashboard's drill tab shows needs the full 25, each with
 * its own attempted/correct so "0 attempted" is a real, visible option next
 * to the topics already underway. A left join against the same pooled
 * `combined` this file already computes, rather than a second round trip.
 */
async function allTopicsWithStats(userId: number): Promise<DrillTopicStat[]> {
  interface Row {
    topic: string
    bank_count: number
    attempted: number
    correct: number
  }
  const rows = await all<Row>(
    `WITH combined AS (
       SELECT q.topic AS topic, aa.is_correct AS is_correct
       FROM accuracy_attempts aa
       JOIN accuracy_sessions s ON s.id = aa.session_id
       JOIN questions q ON q.id = aa.question_id
       WHERE s.user_id = $1 AND aa.answered_at IS NOT NULL
       UNION ALL
       SELECT q.topic AS topic, r.is_correct AS is_correct
       FROM mock_responses r
       JOIN mock_sessions s ON s.id = r.session_id
       JOIN questions q ON q.id = r.question_id
       WHERE s.user_id = $1 AND r.status = 'answered'
     ),
     agg AS (
       SELECT topic, COUNT(*)::int AS attempted, COUNT(*) FILTER (WHERE is_correct)::int AS correct
       FROM combined
       GROUP BY topic
     )
     SELECT q.topic,
            COUNT(*)::int AS bank_count,
            MAX(COALESCE(a.attempted, 0))::int AS attempted,
            MAX(COALESCE(a.correct, 0))::int AS correct
     FROM questions q
     LEFT JOIN agg a ON a.topic = q.topic
     WHERE q.topic IS NOT NULL
     GROUP BY q.topic
     ORDER BY q.topic`,
    [userId],
  )

  return rows.map((r) => ({
    topic: r.topic,
    bankCount: r.bank_count,
    attempted: r.attempted,
    correct: r.correct,
    wrong: r.attempted - r.correct,
    accuracy: r.attempted ? r.correct / r.attempted : 0,
  }))
}

function scopeStat(attempted: number, correct: number, timeMs: number): TopicScopeStat {
  const wrong = attempted - correct
  return {
    attempted,
    correct,
    wrong,
    accuracy: attempted ? correct / attempted : 0,
    timeMs,
    avgSec: attempted ? Math.round((timeMs / 1000 / attempted) * 10) / 10 : 0,
    marksPerMin:
      timeMs > 0 ? Math.round(((correct * MARK_CORRECT + wrong * MARK_WRONG) / (timeMs / 60000)) * 10) / 10 : 0,
  }
}

async function topicBreakdown(userId: number): Promise<TopicStat[]> {
  const rows = await all<TopicSourceRow>(
    `WITH combined AS (
       SELECT q.topic AS topic, aa.is_correct AS is_correct, aa.time_ms AS time_ms, 'drill' AS source
       FROM accuracy_attempts aa
       JOIN accuracy_sessions s ON s.id = aa.session_id
       JOIN questions q ON q.id = aa.question_id
       WHERE s.user_id = $1 AND aa.answered_at IS NOT NULL
       UNION ALL
       SELECT q.topic AS topic, r.is_correct AS is_correct, r.time_ms AS time_ms, 'mock' AS source
       FROM mock_responses r
       JOIN mock_sessions s ON s.id = r.session_id
       JOIN questions q ON q.id = r.question_id
       WHERE s.user_id = $1 AND r.status = 'answered'
     )
     SELECT topic, source,
            COUNT(*)::int AS attempted,
            COUNT(*) FILTER (WHERE is_correct)::int AS correct,
            COALESCE(SUM(time_ms), 0)::bigint AS time_ms
     FROM combined
     WHERE topic IS NOT NULL
     GROUP BY topic, source`,
    [userId],
  )

  const bySource = new Map<string, { mock: TopicSourceRow[]; drill: TopicSourceRow[] }>()
  for (const r of rows) {
    const entry = bySource.get(r.topic) ?? { mock: [], drill: [] }
    entry[r.source].push(r)
    bySource.set(r.topic, entry)
  }

  const sum = (rs: TopicSourceRow[], key: 'attempted' | 'correct' | 'time_ms') =>
    rs.reduce((s, r) => s + r[key], 0)

  return [...bySource.entries()]
    .map(([topic, { mock, drill }]) => {
      const mockStat = scopeStat(sum(mock, 'attempted'), sum(mock, 'correct'), sum(mock, 'time_ms'))
      const drillStat = scopeStat(sum(drill, 'attempted'), sum(drill, 'correct'), sum(drill, 'time_ms'))
      const allStat = scopeStat(
        mockStat.attempted + drillStat.attempted,
        mockStat.correct + drillStat.correct,
        mockStat.timeMs + drillStat.timeMs,
      )
      return { topic, all: allStat, mock: mockStat, drill: drillStat }
    })
    .sort((a, b) => a.all.accuracy - b.all.accuracy || b.all.attempted - a.all.attempted)
}

/** One row per submitted mock, with the counts needed to score it -- the
 *  score itself is never stored, only derived, so it is computed here from
 *  the same +4/-1 marking every other view of a mock uses. */
async function mockHistory(userId: number): Promise<MockRow[]> {
  return all<MockRow>(
    `SELECT ms.id, ms.name, ms.submitted_at,
            COUNT(*) FILTER (WHERE r.status = 'answered')::int AS attempted,
            COUNT(*) FILTER (WHERE r.status = 'answered' AND r.is_correct)::int AS correct,
            COUNT(*) FILTER (WHERE r.status = 'answered' AND NOT r.is_correct)::int AS wrong
     FROM mock_sessions ms
     JOIN mock_responses r ON r.session_id = ms.id
     WHERE ms.user_id = $1 AND ms.status = 'submitted'
     GROUP BY ms.id
     ORDER BY ms.submitted_at DESC`,
    [userId],
  )
}

async function drillHistory(userId: number): Promise<DrillRow[]> {
  return all<DrillRow>(
    `SELECT id, topic, status, end_reason, streak_best, answered_count, correct_count,
            created_at, ended_at
     FROM accuracy_sessions
     WHERE user_id = $1 AND answered_count > 0
     ORDER BY created_at DESC`,
    [userId],
  )
}

/**
 * The signed-in account's whole practice history, boiled down to what a
 * dashboard shows: an overview, a topic-by-topic weak/strong breakdown, and
 * a merged activity feed. One call so the dashboard has everything on load
 * rather than waterfalling several requests.
 */
analyticsRouter.get('/', requireUser, async (req, res) => {
  const userId = req.user!.id

  const [topics, drillTopics, mocks, drills, mistakes] = await Promise.all([
    topicBreakdown(userId),
    allTopicsWithStats(userId),
    mockHistory(userId),
    drillHistory(userId),
    getCurrentMistakes(userId),
  ])

  const totalAttempted = topics.reduce((s, t) => s + t.all.attempted, 0)
  const totalCorrect = topics.reduce((s, t) => s + t.all.correct, 0)
  const totalWrong = totalAttempted - totalCorrect

  const mockScores = mocks.map((m) => m.correct * MARK_CORRECT + m.wrong * MARK_WRONG)
  const avgMockScoreRaw = mockScores.length
    ? mockScores.reduce((a, b) => a + b, 0) / mockScores.length
    : null
  const avgAttemptRate = mocks.length
    ? mocks.reduce((s, m) => s + m.attempted / MOCK_QUESTIONS, 0) / mocks.length
    : null
  // Needs at least one mock: a percentile is only meaningful for a full-paper
  // score, and only a mock's average section score projects to one (see
  // `projectTotal`/`percentileFor` above).
  const estimatedPercentile = avgMockScoreRaw != null ? percentileFor(projectTotal(avgMockScoreRaw)) : null

  const recent: RecentActivity[] = [
    ...mocks.map((m, i) => ({
      type: 'mock' as const,
      id: m.id,
      label: m.name ?? 'Mock test',
      when: m.submitted_at,
      attempted: m.attempted,
      correct: m.correct,
      wrong: m.wrong,
      accuracy: m.attempted ? m.correct / m.attempted : 0,
      score: mockScores[i],
    })),
    ...drills.map((d) => ({
      type: 'drill' as const,
      id: d.id,
      label: d.topic === 'mixed' ? 'Mixed topics' : d.topic,
      when: d.ended_at ?? d.created_at,
      attempted: d.answered_count,
      correct: d.correct_count,
      wrong: d.answered_count - d.correct_count,
      accuracy: d.answered_count ? d.correct_count / d.answered_count : 0,
    })),
  ]
    .sort((a, b) => new Date(b.when).getTime() - new Date(a.when).getTime())
    .slice(0, 15)

  res.json({
    drillTopics,
    overview: {
      questionsAttempted: totalAttempted,
      correct: totalCorrect,
      wrong: totalWrong,
      accuracy: totalAttempted ? totalCorrect / totalAttempted : 0,
      topicsCovered: topics.length,
      mocksTaken: mocks.length,
      drillsTaken: drills.length,
      bestMockScore: mockScores.length ? Math.max(...mockScores) : null,
      avgMockScore: avgMockScoreRaw != null ? Math.round(avgMockScoreRaw * 10) / 10 : null,
      bestDrillStreak: drills.length ? Math.max(...drills.map((d) => d.streak_best)) : 0,
      mistakesToFix: mistakes.length,
      avgAttemptRate,
      estimatedPercentile,
      goalAccuracy: GOAL_ACCURACY,
      goalAttemptRate: GOAL_ATTEMPT_RATE,
    },
    topics,
    recent,
  })
})
