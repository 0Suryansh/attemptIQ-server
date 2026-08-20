import { createPublicKey, createVerify, X509Certificate } from 'node:crypto'
import type { NextFunction, Request, Response } from 'express'
import { ApiError } from './app.js'
import { one, run } from './db.js'

/**
 * Firebase ID token verification, done here rather than through
 * `firebase-admin`.
 *
 * The admin SDK needs a service-account key -- a real secret to provision,
 * store and rotate -- purely to check a signature that Google publishes the
 * public half of. Verifying the JWT directly needs only the project id, which
 * is already public and already shipped to the browser, so there is no new
 * credential in the deployment at all.
 *
 * What is checked is exactly what Google documents for a session cookie's
 * poorer cousin, the ID token: RS256 over the signed header+payload against
 * the current securetoken certificates, then `aud`, `iss`, `exp`, `iat` and a
 * non-empty `sub`. Anything short of all of those is a rejected request.
 */

const PROJECT_ID = process.env.FIREBASE_PROJECT_ID ?? process.env.VITE_FIREBASE_PROJECT_ID ?? ''

/** False when no Firebase project is configured, which is a valid local
 *  setup -- the signed-out half of the site works without one. Routes that
 *  need a user answer 503 rather than pretending everyone is anonymous. */
export const authConfigured = Boolean(PROJECT_ID)

const CERT_URL =
  'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com'

interface CertCache {
  keys: Map<string, string>
  expiresAt: number
}
let certCache: CertCache | null = null

/**
 * Google's signing certificates, cached for exactly as long as the response
 * says they are good for. Keys rotate roughly daily; re-fetching per request
 * would put a network round trip in front of every authenticated call.
 */
async function signingKeys(): Promise<Map<string, string>> {
  if (certCache && certCache.expiresAt > Date.now()) return certCache.keys

  const res = await fetch(CERT_URL)
  if (!res.ok) throw new ApiError(503, 'could not reach the token verification service')

  const certs = (await res.json()) as Record<string, string>
  const keys = new Map<string, string>()
  for (const [kid, pem] of Object.entries(certs)) {
    // The endpoint serves X.509 certificates; the verifier wants the public
    // key inside them.
    keys.set(kid, new X509Certificate(pem).publicKey.export({ type: 'spki', format: 'pem' }).toString())
  }

  const maxAge = /max-age=(\d+)/.exec(res.headers.get('cache-control') ?? '')
  // A short floor rather than zero, so a response without the header cannot
  // turn every request into a fetch.
  const ttlSec = maxAge ? Number(maxAge[1]) : 300
  certCache = { keys, expiresAt: Date.now() + ttlSec * 1000 }
  return keys
}

function b64urlToBuffer(part: string): Buffer {
  return Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
}

export interface FirebaseClaims {
  sub: string
  email?: string
  email_verified?: boolean
  name?: string
  picture?: string
}

/** Verifies a Firebase ID token and returns its claims, or throws ApiError 401. */
export async function verifyIdToken(token: string): Promise<FirebaseClaims> {
  const parts = token.split('.')
  if (parts.length !== 3) throw new ApiError(401, 'malformed token')

  let header: { alg?: string; kid?: string }
  let claims: FirebaseClaims & { aud?: string; iss?: string; exp?: number; iat?: number }
  try {
    header = JSON.parse(b64urlToBuffer(parts[0]).toString('utf-8'))
    claims = JSON.parse(b64urlToBuffer(parts[1]).toString('utf-8'))
  } catch {
    throw new ApiError(401, 'malformed token')
  }

  if (header.alg !== 'RS256' || !header.kid) throw new ApiError(401, 'unsupported token algorithm')

  const key = (await signingKeys()).get(header.kid)
  // An unknown kid means the token was signed by something that is not
  // Google's current key set -- forged, or old enough that the key is gone.
  if (!key) throw new ApiError(401, 'unknown token signing key')

  const verifier = createVerify('RSA-SHA256')
  verifier.update(`${parts[0]}.${parts[1]}`)
  verifier.end()
  if (!verifier.verify(createPublicKey(key), b64urlToBuffer(parts[2]))) {
    throw new ApiError(401, 'bad token signature')
  }

  // A valid signature only proves Google minted it. These prove it was minted
  // for THIS project and is still live -- without them, a token from any other
  // Firebase project would be accepted.
  const nowSec = Math.floor(Date.now() / 1000)
  // A small allowance for clock drift between this host and Google's.
  const SKEW_SEC = 60
  if (claims.aud !== PROJECT_ID) throw new ApiError(401, 'token audience mismatch')
  if (claims.iss !== `https://securetoken.google.com/${PROJECT_ID}`) {
    throw new ApiError(401, 'token issuer mismatch')
  }
  if (typeof claims.exp !== 'number' || claims.exp + SKEW_SEC < nowSec) {
    throw new ApiError(401, 'token expired')
  }
  if (typeof claims.iat !== 'number' || claims.iat - SKEW_SEC > nowSec) {
    throw new ApiError(401, 'token issued in the future')
  }
  if (!claims.sub) throw new ApiError(401, 'token has no subject')

  return claims
}

// ------------------------------------------------------------------- users

export interface UserRow {
  id: number
  firebase_uid: string
  email: string | null
  display_name: string | null
  photo_url: string | null
  created_at: Date
  last_seen_at: Date
}

/**
 * Creates the user row on first sight and refreshes the profile on every
 * later one, so a changed Google display name or avatar does not go stale.
 *
 * `firebase_uid` is the natural key and the row's own `id` is what the rest
 * of the schema points at -- session tables should not carry a foreign
 * identity provider's string around.
 */
export async function upsertUser(claims: FirebaseClaims): Promise<UserRow> {
  const row = await one<UserRow>(
    `INSERT INTO users (firebase_uid, email, display_name, photo_url)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (firebase_uid) DO UPDATE SET
       email        = EXCLUDED.email,
       display_name = EXCLUDED.display_name,
       photo_url    = EXCLUDED.photo_url,
       last_seen_at = now()
     RETURNING *`,
    [claims.sub, claims.email ?? null, claims.name ?? null, claims.picture ?? null],
  )
  if (!row) throw new ApiError(500, 'could not save the account')
  return row
}

/** Read-only lookup, for the per-request path that must not write. */
export function findUser(firebaseUid: string): Promise<UserRow | undefined> {
  return one<UserRow>('SELECT * FROM users WHERE firebase_uid = $1', [firebaseUid])
}

export async function touchUser(id: number): Promise<void> {
  await run('UPDATE users SET last_seen_at = now() WHERE id = $1', [id])
}

// -------------------------------------------------------------- middleware

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Set by `attachUser`; present only on a valid bearer token. */
      user?: UserRow
    }
  }
}

function bearer(req: Request): string | null {
  const header = req.get('authorization')
  if (!header) return null
  const [scheme, token] = header.split(' ')
  return scheme?.toLowerCase() === 'bearer' && token ? token : null
}

/**
 * Reads the bearer token if there is one and hangs the user off the request.
 *
 * Deliberately does not reject an anonymous request: practice works signed
 * out, and those routes want to record a session with no owner rather than
 * refuse it. A token that is present but *invalid* is still an error -- that
 * is a broken or hostile client, not an anonymous one.
 */
export async function attachUser(req: Request, _res: Response, next: NextFunction) {
  const token = bearer(req)
  if (!token || !authConfigured) return next()
  const claims = await verifyIdToken(token)
  // A lookup, not an upsert: this runs on every authenticated call, and
  // rewriting the profile each time would put a write in front of every read.
  // The insert path is POST /api/user/sync, which the client calls once on
  // sign-in -- but a missing row is still healed here rather than 500ing, so
  // a client that never synced is not permanently broken.
  req.user = (await findUser(claims.sub)) ?? (await upsertUser(claims))
  next()
}

/** For routes that have nothing to say without an account. */
export function requireUser(req: Request, _res: Response, next: NextFunction) {
  if (!authConfigured) throw new ApiError(503, 'sign-in is not configured on this server')
  if (!req.user) throw new ApiError(401, 'sign in to do this')
  next()
}
