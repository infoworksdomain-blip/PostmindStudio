import { randomUUID } from 'node:crypto';
import pino, { type Logger } from 'pino';

// Structured logger (BACKLOG 1.3). Always attach correlationId, organisationId and
// projectId when they are known (CLAUDE.md "Logging").

export const CORRELATION_ID_HEADER = 'x-correlation-id';

const REDACT_PATHS = [
  'authorization',
  'headers.authorization',
  'req.headers.authorization',
  '*.accessToken',
  '*.refreshToken',
  '*.token',
  '*.apiKey',
  '*.serviceToken',
];

export function createLogger(options: { level?: string } = {}): Logger {
  return pino({
    level: options.level ?? process.env.LOG_LEVEL ?? 'info',
    base: { service: 'postmind-studio' },
    redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}

export const logger: Logger = createLogger();

export interface LogContext {
  correlationId?: string;
  organisationId?: string;
  projectId?: string;
  userId?: string;
}

/** Child logger carrying request/job context. Undefined fields are dropped. */
export function withContext(context: LogContext, base: Logger = logger): Logger {
  const bindings = Object.fromEntries(
    Object.entries(context).filter(([, value]) => value !== undefined),
  );
  return base.child(bindings);
}

const SAFE_CORRELATION_ID = /^[A-Za-z0-9._-]{1,128}$/;

/** Reuse the caller's correlation id when it is well-formed; otherwise mint one. */
export function getCorrelationId(req: Pick<Request, 'headers'>): string {
  const incoming = req.headers.get(CORRELATION_ID_HEADER);
  return incoming && SAFE_CORRELATION_ID.test(incoming) ? incoming : randomUUID();
}
