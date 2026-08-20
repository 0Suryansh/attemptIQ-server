import { Router } from 'express'
import { ApiError } from '../app.js'
import {
  authConfigured,
  findUser,
  requireUser,
  upsertUser,
  verifyIdToken,
  type UserRow,
} from '../auth.js'

export const userRouter = Router()

/** The account as the client should see it -- no internal row id, no
 *  provider uid, nothing the browser has any use for. */
export interface PublicUser {
  email: string | null
  displayName: string | null
  photoUrl: string | null
  createdAt: string
  lastSeenAt: string
  /** True the first time this account is seen, so the dashboard can greet a
   *  new account differently from a returning one. */
  isNew?: boolean
}

function toPublicUser(row: UserRow, isNew?: boolean): PublicUser {
  return {
    email: row.email,
    displayName: row.display_name,
    photoUrl: row.photo_url,
    createdAt: row.created_at.toISOString(),
    lastSeenAt: row.last_seen_at.toISOString(),
    ...(isNew ? { isNew: true } : {}),
  }
}

/**
 * Called once by the client the moment Firebase reports a signed-in user.
 *
 * This is what turns a Google sign-in into a row in our own database: the
 * token is verified here, and the profile it carries is written or refreshed.
 * Everything after this point works from `users.id`, not from Firebase.
 */
userRouter.post('/sync', async (req, res) => {
  if (!authConfigured) throw new ApiError(503, 'sign-in is not configured on this server')

  const header = req.get('authorization')
  const token = header?.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : null
  if (!token) throw new ApiError(401, 'sign in to do this')

  const claims = await verifyIdToken(token)
  // Whether the row already existed decides `isNew`, and it has to be asked
  // before the upsert -- afterwards the row exists either way.
  const before = await findUser(claims.sub)
  const row = await upsertUser(claims)
  res.json({ user: toPublicUser(row, !before) })
})

/** The signed-in account, for the dashboard's own load. */
userRouter.get('/me', requireUser, (req, res) => {
  res.json({ user: toPublicUser(req.user!) })
})
