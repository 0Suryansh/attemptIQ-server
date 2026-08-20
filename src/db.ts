import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Pool, types, type PoolClient } from 'pg'

const here = dirname(fileURLToPath(import.meta.url))
// The seed source is the bank built by the Python prototype's scrape/tag
// pipeline -- this app reads it, it never writes it.
export const BANK_PATH = join(here, '..', '..', 'pipeline', 'data', 'cracku', 'jee_maths_cracku.jsonl')

if (!process.env.DATABASE_URL) {
  throw new Error(
    'DATABASE_URL is not set. Copy server/.env.example to server/.env and fill in the Supabase password.',
  )
}
if (process.env.DATABASE_URL.includes('[YOUR-PASSWORD]')) {
  throw new Error('server/.env still has the [YOUR-PASSWORD] placeholder -- put the real password in.')
}

// pg returns BIGINT (OID 20) as a string by default, since it can exceed
// JS's safe integer range in general -- but clock_deadline_ms is an epoch-ms
// timestamp, nowhere near that range, so every call site can treat it as a
// plain number instead of special-casing one column.
types.setTypeParser(20, (v) => Number(v))

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Supabase's pooler terminates TLS with a publicly-trusted cert, but many
  // Node environments' bundled CA lists still fail the chain check against
  // it -- this is the setting Supabase's own docs use for node-postgres.
  ssl: { rejectUnauthorized: false },
  max: 10,
})

// JEE marking, real across both modes: right +4, wrong -1, untouched 0.
export const MARK_CORRECT = 4
export const MARK_WRONG = -1

// Accuracy mode: three lives, a 25-question cap, and a clock that starts at
// one question's worth of time and gets topped up by the same amount every
// time a question is answered -- so unused time never evaporates, it just
// becomes buffer for a harder question later.
export const HEARTS_START = 3
export const ACCURACY_SESSION_CAP = 25
export const PER_QUESTION_MS = 3 * 60 * 1000

// The real JEE Main Maths section: 25 questions, 60 minutes, one shared clock.
export const MOCK_QUESTIONS = 25
export const MOCK_DURATION_SEC = 60 * 60

const SCHEMA = `
-- ------------------------------------------------------------------ people
-- One row per signed-in account. \`firebase_uid\` is the identity Google hands
-- back and the only thing a token proves; \`id\` is what the rest of the schema
-- points at, so the session tables never carry an auth provider's string.
--
-- Timestamps here are real TIMESTAMPTZ rather than the ISO TEXT the session
-- tables use, because these are the columns a dashboard actually sorts and
-- ranges over -- "signed up this week", "last seen" -- and a text column
-- cannot answer that without parsing every row.
CREATE TABLE IF NOT EXISTS users (
  id           INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  firebase_uid TEXT NOT NULL UNIQUE,
  email        TEXT,
  display_name TEXT,
  photo_url    TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

-- Supabase publishes every table in \`public\` through PostgREST, so without
-- this an anon API key could read the whole table -- names and email
-- addresses included. Enabling row security with no policy denies the
-- PostgREST roles outright; this server is unaffected, because it connects as
-- the owning role over a direct Postgres connection rather than through that
-- API. Note the Supabase project also has its own \`auth.users\`; this one is
-- \`public.users\` and the two never resolve to each other.
ALTER TABLE users ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS questions (
  id                   TEXT PRIMARY KEY,
  source_qid           TEXT,
  subject              TEXT,
  year                 INTEGER,
  exam                 TEXT,
  topic                TEXT,
  topic_slug           TEXT,
  subcategory          TEXT,
  subcategory_score    INTEGER,
  question_type        TEXT,
  question             TEXT,
  options              TEXT,
  correct_option_index INTEGER,
  answer               TEXT,
  images               TEXT,
  source_url           TEXT
);
CREATE INDEX IF NOT EXISTS idx_questions_topic ON questions(topic);
CREATE INDEX IF NOT EXISTS idx_questions_type ON questions(question_type);

-- ---------------------------------------------------------- accuracy mode
CREATE TABLE IF NOT EXISTS accuracy_sessions (
  id                  INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  topic               TEXT NOT NULL,           -- a real topic name, or 'mixed'
  created_at          TEXT NOT NULL,
  ended_at            TEXT,
  status              TEXT NOT NULL DEFAULT 'active',   -- active | ended
  end_reason          TEXT,                     -- hearts | time | completed
  hearts              INTEGER NOT NULL,
  streak_current      INTEGER NOT NULL DEFAULT 0,
  streak_best         INTEGER NOT NULL DEFAULT 0,
  answered_count      INTEGER NOT NULL DEFAULT 0,
  correct_count       INTEGER NOT NULL DEFAULT 0,
  -- epoch ms; BIGINT because a 32-bit INTEGER overflows on a value this large
  clock_deadline_ms   BIGINT NOT NULL,
  current_question_id TEXT
);

CREATE TABLE IF NOT EXISTS accuracy_attempts (
  session_id     INTEGER NOT NULL,
  seq            INTEGER NOT NULL,
  question_id    TEXT NOT NULL,
  selected_index INTEGER,
  numeric_answer TEXT,
  is_correct     BOOLEAN,
  answered_at    TEXT,
  PRIMARY KEY (session_id, seq)
);
-- Milliseconds spent on this one question -- added by ALTER, like time_ms on
-- mock_responses below, so a drill's review can show per-question pace the
-- same way a mock's already does.
ALTER TABLE accuracy_attempts ADD COLUMN IF NOT EXISTS time_ms INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_acc_attempts_session ON accuracy_attempts(session_id);

-- -------------------------------------------------------------- mock mode
CREATE TABLE IF NOT EXISTS mock_sessions (
  id           INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name         TEXT,
  created_at   TEXT NOT NULL,
  duration_sec INTEGER NOT NULL,
  started_at   TEXT,
  submitted_at TEXT,
  status       TEXT NOT NULL DEFAULT 'created'   -- created | running | submitted
);

CREATE TABLE IF NOT EXISTS mock_session_questions (
  session_id  INTEGER NOT NULL,
  seq         INTEGER NOT NULL,
  question_id TEXT NOT NULL,
  PRIMARY KEY (session_id, seq)
);

CREATE TABLE IF NOT EXISTS mock_responses (
  session_id     INTEGER NOT NULL,
  question_id    TEXT NOT NULL,
  selected_index INTEGER,
  numeric_answer TEXT,
  is_correct     BOOLEAN NOT NULL DEFAULT FALSE,
  time_ms        INTEGER NOT NULL DEFAULT 0,
  visits         INTEGER NOT NULL DEFAULT 0,
  status         TEXT NOT NULL DEFAULT 'unseen',  -- unseen | seen | answered | review | skipped
  PRIMARY KEY (session_id, question_id)
);
CREATE INDEX IF NOT EXISTS idx_mock_responses_session ON mock_responses(session_id);

-- ------------------------------------------------------------- ownership
-- Added by ALTER rather than in the CREATEs above because both session tables
-- already exist in every deployed database, and CREATE TABLE IF NOT EXISTS
-- would silently skip a changed definition.
--
-- Nullable on purpose: practising signed out is a supported path the site
-- advertises, and those runs still deserve a row. A session gets an owner the
-- moment it is started by somebody carrying a token.
ALTER TABLE accuracy_sessions ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id);
ALTER TABLE mock_sessions     ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id);
CREATE INDEX IF NOT EXISTS idx_acc_sessions_user ON accuracy_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_mock_sessions_user ON mock_sessions(user_id);
`

export async function ensureSchema() {
  await pool.query(SCHEMA)
}

// ------------------------------------------------------------ query helpers
// Mirror better-sqlite3's .all()/.get()/.run() shape closely, so the route
// files read the same way -- just with `await` and $1/$2 placeholders
// instead of `?`.
export async function all<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  const { rows } = await pool.query(sql, params)
  return rows
}
export async function one<T = Record<string, unknown>>(
  sql: string,
  params: unknown[] = [],
): Promise<T | undefined> {
  const rows = await all<T>(sql, params)
  return rows[0]
}
export async function run(sql: string, params: unknown[] = []): Promise<{ rowCount: number }> {
  const res = await pool.query(sql, params)
  return { rowCount: res.rowCount ?? 0 }
}

/**
 * Every question this account's *most recent* attempt got wrong, across both
 * modes, most-recently-wrong first. "Most recent" rather than "any wrong
 * attempt ever" on purpose: a question later answered correctly (in a
 * different drill, or a retry of this very list) has already been fixed and
 * has nothing left to hook the student back in about.
 *
 * Shared by the analytics overview (which only needs the count) and the mock
 * router's mistake-retry session (which needs the actual ids), so the two
 * can never disagree about what counts as "still a mistake".
 */
export async function getCurrentMistakes(
  userId: number,
): Promise<{ question_id: string; last_attempt_at: string }[]> {
  return all(
    `WITH attempts AS (
       SELECT aa.question_id AS question_id, aa.answered_at AS at, aa.is_correct AS is_correct
       FROM accuracy_attempts aa
       JOIN accuracy_sessions s ON s.id = aa.session_id
       WHERE s.user_id = $1 AND aa.answered_at IS NOT NULL
       UNION ALL
       SELECT r.question_id AS question_id, ms.submitted_at AS at, r.is_correct AS is_correct
       FROM mock_responses r
       JOIN mock_sessions ms ON ms.id = r.session_id
       WHERE ms.user_id = $1 AND r.status = 'answered'
     ),
     latest AS (
       SELECT DISTINCT ON (question_id) question_id, at, is_correct
       FROM attempts
       ORDER BY question_id, at DESC
     )
     SELECT question_id, at AS last_attempt_at
     FROM latest
     WHERE is_correct = FALSE
     ORDER BY at DESC`,
    [userId],
  )
}

/** Runs `fn` inside a real BEGIN/COMMIT/ROLLBACK transaction on one checked-out client. */
export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const result = await fn(client)
    await client.query('COMMIT')
    return result
  } catch (e) {
    await client.query('ROLLBACK')
    throw e
  } finally {
    client.release()
  }
}

// ------------------------------------------------------------------ shapes
export interface QuestionRow {
  id: string
  source_qid: string | null
  subject: string | null
  year: number | null
  exam: string | null
  topic: string | null
  topic_slug: string | null
  subcategory: string | null
  subcategory_score: number | null
  question_type: 'mcq' | 'numerical'
  question: string
  options: string
  correct_option_index: number | null
  answer: string | null
  images: string
  source_url: string | null
}

export type PublicOption = { label: string; text: string }
export interface PublicQuestion {
  id: string
  topic: string | null
  subcategory: string | null
  year: number | null
  exam: string | null
  questionType: 'mcq' | 'numerical'
  question: string
  options: PublicOption[]
  images: string[]
}

/** The question as the client should see it before answering -- no answer key. */
export function toPublicQuestion(row: QuestionRow): PublicQuestion {
  return {
    id: row.id,
    topic: row.topic,
    subcategory: row.subcategory,
    year: row.year,
    exam: row.exam,
    questionType: row.question_type,
    question: row.question,
    options: JSON.parse(row.options || '[]'),
    images: JSON.parse(row.images || '[]'),
  }
}

/** Tolerant numeric compare -- keys carry stray text/units, answers carry commas. */
export function numericMatches(given: string, expected: string | null): boolean {
  if (!expected) return false
  const val = (s: string) => {
    const m = String(s).replace(/,/g, '').match(/-?\d+(?:\.\d+)?/)
    return m ? Number(m[0]) : null
  }
  const a = val(given)
  const b = val(expected)
  return a !== null && b !== null && Math.abs(a - b) < 1e-6
}

export function isAnswerCorrect(
  row: QuestionRow,
  selectedIndex: number | null | undefined,
  numericAnswer: string | null | undefined,
): boolean {
  if (row.question_type === 'mcq') {
    // Coerce defensively -- JSON normally preserves the number, but strict
    // `===` would silently mis-grade if a client ever sends "2" for 2.
    return selectedIndex != null && Number(selectedIndex) === row.correct_option_index
  }
  return numericAnswer != null && numericAnswer !== '' && numericMatches(numericAnswer, row.answer)
}

// Referenced by seed.ts to fail fast with a clear message instead of a raw ENOENT.
export function assertBankExists() {
  if (!existsSync(BANK_PATH)) {
    throw new Error(`bank not found at ${BANK_PATH}`)
  }
}
export function readBankLines(): string[] {
  return readFileSync(BANK_PATH, 'utf-8').split('\n').filter((l) => l.trim())
}
