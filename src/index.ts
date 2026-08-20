import 'dotenv/config'
import { createApp } from './app.js'
import { ensureSchema } from './db.js'

const port = Number(process.env.PORT ?? 4000)

async function main() {
  await ensureSchema()
  const app = createApp()
  app.listen(port, () => {
    console.log(`attemptIQ server listening on http://localhost:${port}`)
  })
}

main().catch((e) => {
  console.error('failed to start:', e.message)
  process.exit(1)
})
