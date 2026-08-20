import { Router } from 'express'
import { ApiError } from '../app.js'
import { requireUser } from '../auth.js'
import {
  ACCURACY_SESSION_CAP,
  HEARTS_START,
  PER_QUESTION_MS,
  all,
  isAnswerCorrect,
  one,
  run,
  toPublicQuestion,
  type QuestionRow,
} from '../db.js'

export const accuracyRouter = Router()

function intParam(raw: string, name: string): number {
  if (!/^\d+$/.test(raw)) throw new ApiError(400, `invalid ${name}`)
  return Number(raw)
}

function now() {
  return Date.now()
}

interface SessionRow {
  id: number
  topic: string
  status: 'active' | 'ended'
  end_reason: string | null
  hearts: number
  streak_current: number
  streak_best: number
  answered_count: number
  correct_count: number
  clock_deadline_ms: number
  current_question_id: string | null
  user_id: number | null
}

function getSession(id: number) {
  return one<SessionRow>('SELECT * FROM accuracy_sessions WHERE id = $1', [id])
}

/**
 * A random question from the session's topic pool -- never one already used
 * in this session, and, signed in, never one this account has answered in
 * any drill before, until the account has worked through every question the
 * topic has. Once that pool of "never seen" questions runs dry, repeats are
 * allowed again (still never the same question twice inside one live
 * session) rather than ending the run early on a topic with a small bank.
 *
 * Signed-out sessions have no account to check history against, so they
 * keep the original behaviour: no repeats within the one session, nothing
 * remembered past it.
 */
async function pickNextQuestion(
  sessionId: number,
  topic: string,
  userId: number | null,
): Promise<QuestionRow | undefined> {
  const sessionUsed = await all<{ question_id: string }>(
    'SELECT question_id FROM accuracy_attempts WHERE session_id = $1',
    [sessionId],
  )
  const sessionUsedIds = sessionUsed.map((r) => r.question_id)

  const historyUsedIds = userId
    ? (
        await all<{ question_id: string }>(
          `SELECT DISTINCT aa.question_id
           FROM accuracy_attempts aa
           JOIN accuracy_sessions s ON s.id = aa.session_id
           WHERE s.user_id = $1 AND aa.answered_at IS NOT NULL`,
          [userId],
        )
      ).map((r) => r.question_id)
    : []

  // `id NOT IN (NULL)` is never true in SQL -- NOT IN against a list
  // containing NULL evaluates to NULL for every row, not TRUE -- so the
  // exclude clause has to be omitted entirely when there's nothing to
  // exclude yet, not filled with a placeholder NULL.
  const pick = async (excludeIds: string[]): Promise<QuestionRow | undefined> => {
    const params: unknown[] = []
    let where: string
    if (topic === 'mixed') {
      where = 'topic IS NOT NULL'
    } else {
      params.push(topic)
      where = `topic = $${params.length}`
    }
    let exclude = ''
    if (excludeIds.length) {
      exclude = `AND id NOT IN (${excludeIds.map((_, i) => `$${params.length + i + 1}`).join(',')})`
      params.push(...excludeIds)
    }
    return one<QuestionRow>(
      `SELECT * FROM questions WHERE ${where} ${exclude} ORDER BY RANDOM() LIMIT 1`,
      params,
    )
  }

  const neverSeen = await pick([...new Set([...sessionUsedIds, ...historyUsedIds])])
  if (neverSeen) return neverSeen

  // Exhausted (or signed out): fall back to repeats, still excluding only
  // what this exact session has already asked.
  return pick(sessionUsedIds)
}

function sessionSummary(s: SessionRow) {
  return {
    sessionId: s.id,
    topic: s.topic,
    hearts: s.hearts,
    streakCurrent: s.streak_current,
    streakBest: s.streak_best,
    answeredCount: s.answered_count,
    correctCount: s.correct_count,
    cap: ACCURACY_SESSION_CAP,
    clockDeadlineMs: s.clock_deadline_ms,
    now: now(),
    ended: s.status === 'ended',
    endReason: s.end_reason,
  }
}

// Every real topic in the bank, alphabetically -- the picker's whole list,
// not a curated subset. Ordering here rather than on the client so a search
// filter over the response never has to re-sort what it's given.
accuracyRouter.get('/topics', async (_req, res) => {
  const rows = await all<{ topic: string; n: number }>(
    `SELECT topic, COUNT(*) n FROM questions WHERE topic IS NOT NULL GROUP BY topic ORDER BY topic`,
  )
  const [{ n: total }] = await all<{ n: number }>('SELECT COUNT(*) n FROM questions')

  res.json({
    topics: rows.map((r) => ({ topic: r.topic, count: r.n })),
    mixed: { topic: 'mixed', count: total },
  })
})

// Signed in only: a drill run is only worth starting if it can end up on
// somebody's dashboard, and the picker gates the same way on the client (a
// sign-in dialog instead of a session start) so this is a backstop against
// calling the API directly, not the first line of defence.
accuracyRouter.post('/start', requireUser, async (req, res) => {
  const topic = String(req.body?.topic ?? '')
  // Any real topic in the bank is a legitimate drill -- the dashboard's own
  // picker (all ~25) relies on that same rule. 'mixed' is not a real topic
  // value so it is allowed on its own.
  if (topic !== 'mixed') {
    const exists = await one('SELECT 1 FROM questions WHERE topic = $1 LIMIT 1', [topic])
    if (!exists) {
      res.status(400).json({ error: 'unknown topic' })
      return
    }
  }

  const startedAtMs = now()
  const created = await one<{ id: number }>(
    `INSERT INTO accuracy_sessions
      (topic, created_at, status, hearts, clock_deadline_ms, current_question_id, user_id)
     VALUES ($1, $2, 'active', $3, $4, NULL, $5)
     RETURNING id`,
    [topic, new Date(startedAtMs).toISOString(), HEARTS_START, startedAtMs + PER_QUESTION_MS, req.user!.id],
  )
  const sessionId = created!.id

  const first = await pickNextQuestion(sessionId, topic, req.user!.id)
  if (!first) {
    res.status(400).json({ error: 'no questions available for that topic' })
    return
  }

  await run('INSERT INTO accuracy_attempts (session_id, seq, question_id) VALUES ($1, 1, $2)', [
    sessionId,
    first.id,
  ])
  await run('UPDATE accuracy_sessions SET current_question_id = $1 WHERE id = $2', [
    first.id,
    sessionId,
  ])

  const s = (await getSession(sessionId))!
  res.json({ ...sessionSummary(s), question: toPublicQuestion(first) })
})

accuracyRouter.post('/:id/answer', async (req, res) => {
  const sessionId = intParam(req.params.id, 'session id')
  const s = await getSession(sessionId)
  if (!s) {
    res.status(404).json({ error: 'no such session' })
    return
  }
  if (s.status === 'ended') {
    res.json(sessionSummary(s))
    return
  }

  const { questionId, selectedIndex, numericAnswer, elapsedMs } = req.body ?? {}
  if (questionId !== s.current_question_id) {
    res.status(409).json({ error: 'not the current question' })
    return
  }

  // The clock is the one thing the client cannot be trusted to enforce on
  // itself -- if time was already up when this arrived, end on time, not on
  // whatever answer just came in under the wire.
  if (now() > s.clock_deadline_ms) {
    await run(
      `UPDATE accuracy_sessions SET status='ended', end_reason='time', ended_at=$1, current_question_id=NULL WHERE id=$2`,
      [new Date().toISOString(), sessionId],
    )
    res.json(sessionSummary((await getSession(sessionId))!))
    return
  }

  const question = (await one<QuestionRow>('SELECT * FROM questions WHERE id = $1', [
    s.current_question_id,
  ]))!
  const correct = isAnswerCorrect(question, selectedIndex, numericAnswer)

  await run(
    `UPDATE accuracy_attempts SET selected_index=$1, numeric_answer=$2, is_correct=$3, answered_at=$4, time_ms=$5
     WHERE session_id=$6 AND question_id=$7`,
    [
      selectedIndex ?? null,
      numericAnswer ?? null,
      correct,
      new Date().toISOString(),
      Number(elapsedMs) || 0,
      sessionId,
      s.current_question_id,
    ],
  )

  const heartsAfter = correct ? s.hearts : s.hearts - 1
  const streakAfter = correct ? s.streak_current + 1 : 0
  const bestAfter = Math.max(s.streak_best, streakAfter)
  const answeredAfter = s.answered_count + 1
  const correctAfter = s.correct_count + (correct ? 1 : 0)

  let endReason: 'hearts' | 'completed' | null = null
  if (heartsAfter <= 0) endReason = 'hearts'
  else if (answeredAfter >= ACCURACY_SESSION_CAP) endReason = 'completed'

  const reveal = {
    isCorrect: correct,
    correctOptionIndex: question.question_type === 'mcq' ? question.correct_option_index : null,
    correctAnswer: question.answer,
  }

  if (endReason) {
    await run(
      `UPDATE accuracy_sessions
       SET hearts=$1, streak_current=$2, streak_best=$3, answered_count=$4, correct_count=$5,
           status='ended', end_reason=$6, ended_at=$7, current_question_id=NULL
       WHERE id=$8`,
      [heartsAfter, streakAfter, bestAfter, answeredAfter, correctAfter, endReason, new Date().toISOString(), sessionId],
    )
    res.json({ ...sessionSummary((await getSession(sessionId))!), reveal })
    return
  }

  // Still going: bank this question's fresh allocation on top of whatever
  // time is left, then hand out the next question.
  const nextDeadline = s.clock_deadline_ms + PER_QUESTION_MS
  const next = await pickNextQuestion(sessionId, s.topic, s.user_id)
  if (!next) {
    // Topic pool exhausted (only possible on 'mixed' after ~5000+ questions,
    // effectively never at cap 25, but handled rather than 500ing).
    await run(
      `UPDATE accuracy_sessions
       SET hearts=$1, streak_current=$2, streak_best=$3, answered_count=$4, correct_count=$5,
           status='ended', end_reason='completed', ended_at=$6, current_question_id=NULL
       WHERE id=$7`,
      [heartsAfter, streakAfter, bestAfter, answeredAfter, correctAfter, new Date().toISOString(), sessionId],
    )
    res.json({ ...sessionSummary((await getSession(sessionId))!), reveal })
    return
  }

  await run('INSERT INTO accuracy_attempts (session_id, seq, question_id) VALUES ($1, $2, $3)', [
    sessionId,
    answeredAfter + 1,
    next.id,
  ])
  await run(
    `UPDATE accuracy_sessions
     SET hearts=$1, streak_current=$2, streak_best=$3, answered_count=$4, correct_count=$5,
         clock_deadline_ms=$6, current_question_id=$7
     WHERE id=$8`,
    [heartsAfter, streakAfter, bestAfter, answeredAfter, correctAfter, nextDeadline, next.id, sessionId],
  )

  res.json({
    ...sessionSummary((await getSession(sessionId))!),
    reveal,
    question: toPublicQuestion(next),
  })
})

accuracyRouter.get('/:id', async (req, res) => {
  const s = await getSession(intParam(req.params.id, 'session id'))
  if (!s) {
    res.status(404).json({ error: 'no such session' })
    return
  }
  const current = s.current_question_id
    ? await one<QuestionRow>('SELECT * FROM questions WHERE id = $1', [s.current_question_id])
    : undefined
  res.json({ ...sessionSummary(s), question: current ? toPublicQuestion(current) : undefined })
})

interface AccuracyReviewRow extends QuestionRow {
  seq: number
  selected_index: number | null
  numeric_answer: string | null
  is_correct: boolean | null
  time_ms: number
}

/** Every question this drill run actually answered, in order -- the same
 *  shape the dashboard's history and a past mock's review both use, so a
 *  past attempt (mock or drill) reviews the same way regardless of which
 *  mode it came from. Per-question timing rides along the same way a mock's
 *  review already carries it, so "how long did I spend on this" reads the
 *  same regardless of which mode produced the run. */
accuracyRouter.get('/:id/review', async (req, res) => {
  const sessionId = intParam(req.params.id, 'session id')
  const s = await getSession(sessionId)
  if (!s) {
    res.status(404).json({ error: 'no such session' })
    return
  }

  const rows = await all<AccuracyReviewRow>(
    `SELECT q.*, aa.seq, aa.selected_index, aa.numeric_answer, aa.is_correct, aa.time_ms
     FROM accuracy_attempts aa
     JOIN questions q ON q.id = aa.question_id
     WHERE aa.session_id = $1 AND aa.answered_at IS NOT NULL
     ORDER BY aa.seq`,
    [sessionId],
  )

  const totalTimeMs = rows.reduce((a, r) => a + r.time_ms, 0)
  const seconds = rows.map((r) => r.time_ms / 1000).sort((a, b) => a - b)
  const correct = rows.filter((r) => r.is_correct)
  const wrong = rows.filter((r) => r.is_correct === false)

  res.json({
    session: sessionSummary(s),
    summary: {
      totalTimeMs,
      avgSecPerQuestion: rows.length ? Math.round((totalTimeMs / 1000 / rows.length) * 10) / 10 : 0,
      medianSec: seconds.length ? Math.round(seconds[Math.floor(seconds.length / 2)] * 10) / 10 : 0,
      fastestSec: seconds.length ? Math.round(seconds[0] * 10) / 10 : 0,
      slowestSec: seconds.length ? Math.round(seconds[seconds.length - 1] * 10) / 10 : 0,
      minutesOnWrong: Math.round((wrong.reduce((a, r) => a + r.time_ms, 0) / 60000) * 10) / 10,
      minutesOnCorrect: Math.round((correct.reduce((a, r) => a + r.time_ms, 0) / 60000) * 10) / 10,
    },
    questions: rows.map((r) => ({
      ...toPublicQuestion(r),
      correctOptionIndex: r.question_type === 'mcq' ? r.correct_option_index : null,
      answer: r.answer,
      selectedIndex: r.selected_index,
      numericAnswer: r.numeric_answer,
      isCorrect: !!r.is_correct,
      seconds: Math.round(r.time_ms / 1000),
      minutes: Math.round((r.time_ms / 60000) * 100) / 100,
    })),
  })
})
