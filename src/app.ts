import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import compression from 'compression'
import cors from 'cors'
import express, { type Express, type NextFunction, type Request, type Response } from 'express'
import helmet from 'helmet'
import { attachUser } from './auth.js'
import { accuracyRouter } from './routes/accuracy.js'
import { analyticsRouter } from './routes/analytics.js'
import { mockRouter } from './routes/mock.js'
import { userRouter } from './routes/user.js'

const here = dirname(fileURLToPath(import.meta.url))
/** The prerendered site, if it has been built. */
const CLIENT_DIST = resolve(here, '..', '..', 'frontend', 'dist')

/**
 * URLs that moved when the site was restructured for search.
 *
 * Frozen historical paths, so they are written out here rather than imported
 * from the client. The same map is emitted to dist/_redirects at build time
 * for hosts that do their own redirecting.
 */
/** The Firebase auth domain, which hosts the Google sign-in popup and so has
 *  to be allowed as a frame source. Same value the client builds with. */
const AUTH_DOMAIN = process.env.VITE_FIREBASE_AUTH_DOMAIN
  ? `https://${process.env.VITE_FIREBASE_AUTH_DOMAIN}`
  : 'https://attemptiq.firebaseapp.com'

const REDIRECTS: Record<string, string> = {
  '/practice': '/jee-main-maths-mock-test',
  '/practice/mock': '/jee-main-maths-mock-test/full-length',
  '/practice/accuracy': '/jee-main-maths-mock-test/topic-drill',
}

/** Thrown by route handlers to produce a specific status + client-safe
 *  message instead of falling through to the generic 500 response. */
export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

/**
 * The Express app, kept separate from the listener so it can be imported by
 * tests later without binding a port.
 */
export function createApp(): Express {
  const app = express()
  app.disable('x-powered-by')

  // The default CSP is stricter than the prerendered pages can live with:
  // question figures come from the bank's source host and React writes inline
  // styles. Everything else is first-party -- the webfonts are self-hosted, so
  // no font or style origin is allowed beyond our own, and there is no
  // 'unsafe-inline' on script-src.
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          'default-src': ["'self'"],
          // apis.google.com carries the Google sign-in helper Firebase Auth
          // loads; googletagmanager is Analytics. Both are Google-hosted and
          // both are required by the SDKs -- there is no self-hosted variant.
          'script-src': ["'self'", 'https://apis.google.com', 'https://www.googletagmanager.com'],
          'style-src': ["'self'", "'unsafe-inline'"],
          'font-src': ["'self'"],
          // Google serves the avatar of a signed-in user. Not allowlisted:
          // the ~40 questions whose figure is a "Match List" table image,
          // hotlinked from the bank's source host -- those just won't load.
          'img-src': ["'self'", 'data:', 'https://lh3.googleusercontent.com'],
          // Firebase Auth: token exchange and the installations/config calls
          // its SDK makes on start-up.
          'connect-src': [
            "'self'",
            // Auth: token exchange and the installations/config calls the SDK
            // makes on start-up.
            'https://identitytoolkit.googleapis.com',
            'https://securetoken.googleapis.com',
            'https://firebaseinstallations.googleapis.com',
            'https://firebase.googleapis.com',
            'https://www.googleapis.com',
            // Analytics, when a measurement id is configured.
            'https://www.googletagmanager.com',
            'https://*.google-analytics.com',
            'https://*.analytics.google.com',
          ],
          // The Google sign-in popup runs on the project's auth domain, via an
          // iframe served from apis.google.com.
          'frame-src': [
            "'self'",
            'https://accounts.google.com',
            'https://apis.google.com',
            AUTH_DOMAIN,
          ].filter(Boolean),
          'object-src': ["'none'"],
          'base-uri': ["'self'"],
          'frame-ancestors': ["'none'"],
        },
      },
      // Would block the cross-origin question figures above.
      crossOriginEmbedderPolicy: false,
      // Helmet defaults this to `same-origin`, which severs the handle
      // between this page and the Google sign-in popup it opens -- the SDK
      // can then neither poll `window.closed` nor close the popup, and the
      // sign-in never completes. `same-origin-allow-popups` keeps the
      // cross-origin isolation this header exists for against everything
      // that did not open from here, while still permitting our own popup.
      crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' },
    }),
  )
  app.use(compression())

  // Ahead of everything else: a moved URL should never reach a handler that
  // might 404 it. 301 so the ranking signals follow the link to its new home.
  app.use((req, res, next) => {
    const target = REDIRECTS[req.path.replace(/\/+$/, '') || '/']
    if (target) return res.redirect(301, target)
    next()
  })
  app.use(cors())
  // Question bodies are small text/LaTeX -- a payload well under typical
  // upload limits, so a tight cap here is just cheap protection against a
  // malformed or hostile request body, not a real constraint on any route.
  app.use(express.json({ limit: '100kb' }))

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, service: 'attemptiq-server', time: new Date().toISOString() })
  })

  // Ahead of every API route: a request carrying a valid bearer token gets
  // its `req.user` filled in. An anonymous request passes straight through --
  // the practice routes are meant to work signed out.
  app.use('/api', attachUser)

  app.use('/api/user', userRouter)
  app.use('/api/user/analytics', analyticsRouter)
  app.use('/api/accuracy', accuracyRouter)
  app.use('/api/mock', mockRouter)

  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'not found' })
  })

  // The prerendered site, when it has been built. Each page is a real
  // directory index, so `extensions` is not needed -- express.static resolves
  // /some/path to /some/path/index.html on its own.
  if (existsSync(CLIENT_DIST)) {
    app.use(
      express.static(CLIENT_DIST, {
        // Never 301 /page to /page/. Every canonical this site publishes is
        // slash-less, so the default directory redirect would put the URL a
        // crawler is served permanently out of step with the URL that page
        // claims to be -- on all 5,700 of them.
        redirect: false,
        // Hashed assets are immutable; HTML must always be revalidated so a
        // content rebuild is picked up without waiting out a cache.
        setHeaders: (res, filePath) => {
          res.setHeader(
            'Cache-Control',
            /\/(assets|fonts)\//.test(filePath)
              ? 'public, max-age=31536000, immutable'
              : 'public, max-age=0, must-revalidate',
          )
          // llms.txt is Markdown by convention; express.static would call it
          // text/plain from the extension alone.
          if (filePath.endsWith('llms.txt')) {
            res.setHeader('Content-Type', 'text/markdown; charset=utf-8')
          }
        },
      }),
    )

    // Resolves /page to /page/index.html itself, since the redirect that
    // normally does that is switched off above.
    app.use((req, res, next) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') return next()

      const candidate = resolve(CLIENT_DIST, `.${req.path}`, 'index.html')
      // `req.path` is URL-decoded, so a crafted path could otherwise climb out
      // of the served directory.
      if (!candidate.startsWith(`${CLIENT_DIST}/`) || !existsSync(candidate)) return next()

      res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate')
      res.sendFile(candidate)
    })

    app.use((_req, res) => {
      res.status(404).sendFile(join(CLIENT_DIST, '404.html'))
    })
  }

  // Express 5 forwards rejected async handlers here automatically -- this is
  // the one place a raw error becomes the consistent { error } shape every
  // client-side call site already expects, instead of Express's default HTML
  // stack-trace page.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const status = err instanceof ApiError ? err.status : 500
    const message = err instanceof ApiError ? err.message : 'internal server error'
    if (status >= 500) console.error(err)
    res.status(status).json({ error: message })
  })

  return app
}
