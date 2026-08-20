/**
 * Loads the question bank JSONL into Supabase. Safe to re-run -- each row is
 * an upsert keyed on id, so re-seeding after the bank changes just refreshes
 * it in place.
 *
 * Run with: npm run db:seed
 */
import 'dotenv/config'
import {
  all,
  assertBankExists,
  ensureSchema,
  pool,
  readBankLines,
  withTransaction,
} from './db.js'

interface BankRow {
  id: string
  source_qid: string | null
  subject: string
  year: number | null
  exam: string | null
  topic: string | null
  topic_slug: string | null
  subcategory: string | null
  subcategory_score: number | null
  question_type: 'mcq' | 'numerical'
  question: string
  options: { label: string; text: string }[]
  correct_option_index: number | null
  answer: string | null
  images: string[]
  source_url: string | null
}

const UPSERT = `
  INSERT INTO questions (
    id, source_qid, subject, year, exam, topic, topic_slug, subcategory,
    subcategory_score, question_type, question, options, correct_option_index,
    answer, images, source_url
  ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
  ON CONFLICT (id) DO UPDATE SET
    source_qid=excluded.source_qid, subject=excluded.subject, year=excluded.year,
    exam=excluded.exam, topic=excluded.topic, topic_slug=excluded.topic_slug,
    subcategory=excluded.subcategory, subcategory_score=excluded.subcategory_score,
    question_type=excluded.question_type, question=excluded.question,
    options=excluded.options, correct_option_index=excluded.correct_option_index,
    answer=excluded.answer, images=excluded.images, source_url=excluded.source_url
`

async function main() {
  assertBankExists()
  const rows: BankRow[] = readBankLines().map((l) => JSON.parse(l))

  await ensureSchema()

  // One transaction per chunk rather than one giant transaction or one
  // transaction per row -- keeps a single failed batch small to retry
  // without holding a 5000-row transaction open against a pooled connection.
  const CHUNK = 250
  let done = 0
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK)
    await withTransaction(async (client) => {
      for (const r of chunk) {
        await client.query(UPSERT, [
          r.id.replace(/^cracku_/, 'attemptIQ_'),
          r.source_qid ?? null,
          r.subject ?? 'Mathematics',
          r.year ?? null,
          r.exam ?? null,
          r.topic ?? null,
          r.topic_slug ?? null,
          r.subcategory ?? null,
          r.subcategory_score ?? null,
          r.question_type,
          r.question,
          JSON.stringify(r.options ?? []),
          r.correct_option_index ?? null,
          r.answer ?? null,
          JSON.stringify(r.images ?? []),
          r.source_url ?? null,
        ])
      }
    })
    done += chunk.length
    console.log(`  ${done}/${rows.length}`)
  }

  const [{ n: total }] = await all<{ n: number }>('SELECT COUNT(*) n FROM questions')
  const byTopic = await all<{ topic: string; n: number }>(
    `SELECT topic, COUNT(*) n FROM questions WHERE topic IS NOT NULL GROUP BY topic ORDER BY n DESC`,
  )

  console.log(`seeded ${rows.length} rows -> ${total} questions in db`)
  console.log(`${byTopic.length} topics`)
  for (const t of byTopic.slice(0, 8)) console.log(`  ${String(t.n).padStart(4)}  ${t.topic}`)

  await pool.end()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
