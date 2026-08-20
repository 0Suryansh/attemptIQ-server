import { Router } from 'express'
import { ApiError } from '../app.js'
import { requireUser } from '../auth.js'
import {
  MARK_CORRECT,
  MARK_WRONG,
  MOCK_DURATION_SEC,
  MOCK_QUESTIONS,
  all,
  getCurrentMistakes,
  isAnswerCorrect,
  one,
  run,
  toPublicQuestion,
  withTransaction,
  type QuestionRow,
} from '../db.js'

export const mockRouter = Router()

/** `Number("")` is 0, not NaN -- this is what actually rejects a missing or
 *  non-numeric route param instead of quietly querying for id/seq 0. */
function intParam(raw: string, name: string): number {
  if (!/^\d+$/.test(raw)) throw new ApiError(400, `invalid ${name}`)
  return Number(raw)
}

interface MockSessionRow {
  id: number
  name: string | null
  created_at: string
  duration_sec: number
  started_at: string | null
  submitted_at: string | null
  status: 'created' | 'running' | 'submitted'
}

interface ResponseRow {
  session_id: number
  question_id: string
  selected_index: number | null
  numeric_answer: string | null
  is_correct: boolean
  time_ms: number
  visits: number
  status: 'unseen' | 'seen' | 'answered' | 'review' | 'skipped'
}

// A JEE Main Maths section runs Mixed across the whole syllabus -- this is
// the format that actually trains attempt rate, since the pressure to
// triage only shows up when the paper isn't sorted by topic for you.
//
// Signed in only: a mock only means anything if its score can land on a
// dashboard. The player gates the same way on the client (a sign-in dialog
// instead of a session start), so this is a backstop against calling the
// API directly, not the first line of defence.
mockRouter.post('/start', requireUser, async (req, res) => {
  const count = MOCK_QUESTIONS
  const durationSec = MOCK_DURATION_SEC

  const picked = await all<{ id: string }>('SELECT id FROM questions ORDER BY RANDOM() LIMIT $1', [
    count,
  ])
  if (picked.length < count) {
    res.status(500).json({ error: 'not enough questions in the bank' })
    return
  }

  const name = req.body?.name || `Mock — ${count}Q / ${Math.round(durationSec / 60)}min`
  const created = await one<{ id: number }>(
    `INSERT INTO mock_sessions (name, created_at, duration_sec, status, user_id)
     VALUES ($1, $2, $3, 'created', $4) RETURNING id`,
    [name, new Date().toISOString(), durationSec, req.user!.id],
  )
  const sessionId = created!.id

  await withTransaction(async (client) => {
    for (let i = 0; i < picked.length; i++) {
      await client.query(
        'INSERT INTO mock_session_questions (session_id, seq, question_id) VALUES ($1, $2, $3)',
        [sessionId, i, picked[i].id],
      )
      await client.query(
        "INSERT INTO mock_responses (session_id, question_id, status) VALUES ($1, $2, 'unseen')",
        [sessionId, picked[i].id],
      )
    }
  })

  res.json({ sessionId, count: picked.length, durationSec, name })
})

// A mock session, but seeded from this account's own current mistakes
// (`getCurrentMistakes` in db.ts) instead of a random draw from the bank --
// same tables, same player, same review screen, just a different question
// list. Capped at MOCK_QUESTIONS so the retry never runs longer than a real
// mock; duration scales down with it so the pace stays the same (~2.4
// min/question), with a floor so a two-question retry isn't over before the
// student's even settled in.
mockRouter.post('/start-mistakes', requireUser, async (req, res) => {
  const mistakes = await getCurrentMistakes(req.user!.id)
  if (!mistakes.length) {
    res.status(400).json({ error: 'No mistakes to retry -- nice work.' })
    return
  }

  const picked = mistakes.slice(0, MOCK_QUESTIONS)
  const durationSec = Math.max(300, Math.round((picked.length / MOCK_QUESTIONS) * MOCK_DURATION_SEC))
  const name = 'Retry your mistakes'

  const created = await one<{ id: number }>(
    `INSERT INTO mock_sessions (name, created_at, duration_sec, status, user_id)
     VALUES ($1, $2, $3, 'created', $4) RETURNING id`,
    [name, new Date().toISOString(), durationSec, req.user!.id],
  )
  const sessionId = created!.id

  await withTransaction(async (client) => {
    for (let i = 0; i < picked.length; i++) {
      await client.query(
        'INSERT INTO mock_session_questions (session_id, seq, question_id) VALUES ($1, $2, $3)',
        [sessionId, i, picked[i].question_id],
      )
      await client.query(
        "INSERT INTO mock_responses (session_id, question_id, status) VALUES ($1, $2, 'unseen')",
        [sessionId, picked[i].question_id],
      )
    }
  })

  res.json({ sessionId, count: picked.length, durationSec, name })
})

// Only the palette metadata for the sidebar/nav grid -- seq, id and status
// per slot -- never the question text or options. The full 25-question set
// used to ship in this one response; a mock's worth of LaTeX-heavy question
// bodies is a multi-hundred-KB payload the player only ever shows one slide
// of at a time, so it's fetched lazily instead via GET /:id/question/:seq.
mockRouter.get('/:id', async (req, res) => {
  const sessionId = intParam(req.params.id, 'session id')
  let session = await one<MockSessionRow>('SELECT * FROM mock_sessions WHERE id = $1', [sessionId])
  if (!session) {
    res.status(404).json({ error: 'no such session' })
    return
  }

  if (!session.started_at) {
    await run(`UPDATE mock_sessions SET started_at = $1, status = 'running' WHERE id = $2`, [
      new Date().toISOString(),
      sessionId,
    ])
    session = (await one<MockSessionRow>('SELECT * FROM mock_sessions WHERE id = $1', [sessionId]))!
  }

  const rows = await all<{ seq: number; question_id: string } & ResponseRow>(
    `SELECT mq.seq, mq.question_id, r.selected_index, r.numeric_answer, r.is_correct,
            r.time_ms, r.visits, r.status
     FROM mock_session_questions mq
     JOIN mock_responses r ON r.session_id = mq.session_id AND r.question_id = mq.question_id
     WHERE mq.session_id = $1 ORDER BY mq.seq`,
    [sessionId],
  )

  res.json({
    session,
    palette: rows.map((r) => ({
      seq: r.seq,
      questionId: r.question_id,
      status: r.status,
      answered: r.selected_index != null || (r.numeric_answer != null && r.numeric_answer !== ''),
    })),
  })
})

/** One question's public content by its position in the session -- fetched
 *  on demand as the player navigates to it, never in bulk. */
mockRouter.get('/:id/question/:seq', async (req, res) => {
  const sessionId = intParam(req.params.id, 'session id')
  const seq = intParam(req.params.seq, 'seq')

  const row = await one<{ question_id: string } & ResponseRow>(
    `SELECT mq.question_id, r.selected_index, r.numeric_answer, r.is_correct, r.time_ms, r.visits, r.status
     FROM mock_session_questions mq
     JOIN mock_responses r ON r.session_id = mq.session_id AND r.question_id = mq.question_id
     WHERE mq.session_id = $1 AND mq.seq = $2`,
    [sessionId, seq],
  )
  if (!row) {
    res.status(404).json({ error: 'no such question' })
    return
  }
  const question = (await one<QuestionRow>('SELECT * FROM questions WHERE id = $1', [row.question_id]))!

  res.json({
    seq,
    question: { ...toPublicQuestion(question), response: row },
  })
})

mockRouter.post('/:id/answer', async (req, res) => {
  const sessionId = intParam(req.params.id, 'session id')
  const session = await one<{ status: string }>('SELECT status FROM mock_sessions WHERE id = $1', [
    sessionId,
  ])
  if (!session || session.status === 'submitted') {
    res.status(400).json({ error: 'session already submitted' })
    return
  }

  const { questionId, selectedIndex, numericAnswer, elapsedMs, visit, status } = req.body ?? {}
  const question = await one<QuestionRow>('SELECT * FROM questions WHERE id = $1', [questionId])
  if (!question) {
    res.status(404).json({ error: 'no such question' })
    return
  }

  const answered = selectedIndex != null || (numericAnswer != null && numericAnswer !== '')
  const isCorrect = answered
    ? isAnswerCorrect(question, selectedIndex ?? null, numericAnswer ?? null)
    : false
  const nextStatus = status || (answered ? 'answered' : 'seen')

  await run(
    `UPDATE mock_responses
     SET selected_index=$1, numeric_answer=$2, is_correct=$3,
         time_ms = time_ms + $4, visits = visits + $5, status=$6
     WHERE session_id=$7 AND question_id=$8`,
    [
      selectedIndex ?? null,
      numericAnswer ?? null,
      isCorrect,
      Number(elapsedMs) || 0,
      Number(visit) || 0,
      nextStatus,
      sessionId,
      questionId,
    ],
  )

  res.json({ ok: true })
})

async function buildReview(sessionId: number) {
  const session = (await one<MockSessionRow>('SELECT * FROM mock_sessions WHERE id = $1', [
    sessionId,
  ]))!
  const rows = await all<QuestionRow & ResponseRow & { seq: number }>(
    `SELECT q.*, r.selected_index, r.numeric_answer, r.is_correct, r.time_ms, r.visits, r.status, mq.seq
     FROM mock_session_questions mq
     JOIN questions q ON q.id = mq.question_id
     JOIN mock_responses r ON r.session_id = mq.session_id AND r.question_id = q.id
     WHERE mq.session_id = $1 ORDER BY mq.seq`,
    [sessionId],
  )

  const attempted = rows.filter((r) => r.status === 'answered')
  const correct = attempted.filter((r) => r.is_correct)
  const wrong = attempted.filter((r) => !r.is_correct)
  const skipped = rows.filter((r) => r.status !== 'answered')
  const totalTimeMs = rows.reduce((a, r) => a + r.time_ms, 0)

  const budgetSec = session.duration_sec / rows.length
  const times = rows.map((r) => r.time_ms / 1000).sort((a, b) => a - b)
  const median = times.length ? times[Math.floor(times.length / 2)] : 0
  const over = rows.filter((r) => r.time_ms / 1000 > budgetSec * 2)

  // Fastest/slowest over attempted questions only -- an unopened question
  // has 0ms on it and would win "fastest" without ever having been read.
  const attemptedSecs = attempted.map((r) => r.time_ms / 1000).sort((a, b) => a - b)

  const summary = {
    questions: rows.length,
    attempted: attempted.length,
    correct: correct.length,
    wrong: wrong.length,
    skipped: skipped.length,
    score: correct.length * MARK_CORRECT + wrong.length * MARK_WRONG,
    maxScore: rows.length * MARK_CORRECT,
    accuracy: attempted.length ? correct.length / attempted.length : 0,
    attemptRate: attempted.length / rows.length,
    avgSecPerQuestion: Math.round((totalTimeMs / 1000 / rows.length) * 10) / 10,
    minutesOnWrong: Math.round((wrong.reduce((a, r) => a + r.time_ms, 0) / 60000) * 10) / 10,
    minutesOnCorrect: Math.round((correct.reduce((a, r) => a + r.time_ms, 0) / 60000) * 10) / 10,
    fastestSec: attemptedSecs.length ? Math.round(attemptedSecs[0] * 10) / 10 : 0,
    slowestSec: attemptedSecs.length ? Math.round(attemptedSecs[attemptedSecs.length - 1] * 10) / 10 : 0,
  }
  const pacing = {
    budgetSecPerQuestion: Math.round(budgetSec * 10) / 10,
    medianSec: Math.round(median * 10) / 10,
    overDoubleBudget: over.length,
    minutesInOverruns: Math.round((over.reduce((a, r) => a + r.time_ms, 0) / 60000) * 10) / 10,
  }

  return {
    session,
    summary,
    pacing,
    questions: rows.map((r) => ({
      ...toPublicQuestion(r),
      correctOptionIndex: r.correct_option_index,
      answer: r.answer,
      selectedIndex: r.selected_index,
      numericAnswer: r.numeric_answer,
      isCorrect: !!r.is_correct,
      status: r.status,
      seconds: Math.round(r.time_ms / 1000),
      minutes: Math.round((r.time_ms / 60000) * 100) / 100,
      marks: r.status === 'answered' ? (r.is_correct ? MARK_CORRECT : MARK_WRONG) : 0,
    })),
  }
}

mockRouter.post('/:id/submit', async (req, res) => {
  const sessionId = intParam(req.params.id, 'session id')
  await run(`UPDATE mock_sessions SET submitted_at = $1, status = 'submitted' WHERE id = $2`, [
    new Date().toISOString(),
    sessionId,
  ])
  await run(
    `UPDATE mock_responses SET status = 'skipped' WHERE session_id = $1 AND status IN ('unseen','seen')`,
    [sessionId],
  )
  res.json(await buildReview(sessionId))
})

mockRouter.get('/:id/review', async (req, res) => {
  res.json(await buildReview(intParam(req.params.id, 'session id')))
})
