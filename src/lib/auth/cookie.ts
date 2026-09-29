// Edge-safe constants shared by the Better Auth config and src/middleware.ts (which must not import
// the server config: Prisma and argon2 do not run on the edge).

/** Cookies are `studio.session_token` (`__Secure-` prefixed over HTTPS), Phase 18 §2.3. */
export const AUTH_COOKIE_PREFIX = 'studio';
