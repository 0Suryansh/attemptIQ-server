/**
 * Vercel serverless entry point.
 *
 * src/index.ts's app.listen() has no meaning here -- Vercel invokes this
 * function per request, cold-starting a fresh process every so often rather
 * than keeping one server up. The Express app itself is unchanged and still
 * does all the real routing; this just adapts it to that invocation model.
 *
 * ensureSchema() used to run once at server boot. Serverless has no boot
 * phase, so it runs lazily on this module's first invocation instead, cached
 * for the lifetime of the underlying container -- every table is
 * `CREATE TABLE IF NOT EXISTS`, so re-running it costs one cheap round trip
 * per cold start, never per request.
 *
 * vercel.json rewrites every path here, so this one function gets the whole
 * app's traffic; Express does its own internal routing from there by
 * req.url, same as it always has.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createApp } from '../src/app.js'
import { ensureSchema } from '../src/db.js'

const app = createApp()
let ready: Promise<void> | null = null

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  ready ??= ensureSchema()
  await ready
  app(req, res)
}
