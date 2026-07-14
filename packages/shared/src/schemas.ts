import { z } from 'zod';
import { PAIRING_SCHEME, PROTOCOL_VERSION, TOKEN_BYTES } from './constants.js';

/**
 * QR payload the CLI prints and the app scans to register a machine.
 * `version` is locked to PROTOCOL_VERSION so we can evolve the contract.
 */
export const PairingPayloadSchema = z.object({
  version: z.literal(PROTOCOL_VERSION),
  /** Primary host (kept for back-compat + display); always also in `hosts`. */
  host: z.string().min(1).max(253),
  /**
   * All addresses the daemon is reachable at (Tailscale IP, LAN IP, …). The
   * app tries each and uses whichever answers, so one QR works both on the
   * same Wi-Fi (direct/fast) and remotely over Tailscale. Optional for
   * back-compat with v1 QRs that only carried `host`.
   */
  hosts: z.array(z.string().min(1).max(253)).min(1).max(6).optional(),
  /** TCP port the daemon listens on. */
  port: z.number().int().positive().max(65535),
  /**
   * Hex-encoded bearer token, generated per CLI startup.
   * Length must equal TOKEN_BYTES * 2 (i.e. 64 chars for 32 bytes).
   */
  token: z
    .string()
    .length(TOKEN_BYTES * 2, `token must be ${TOKEN_BYTES * 2} hex chars`)
    .regex(/^[0-9a-f]+$/i, 'token must be hex'),
  /** Friendly human name shown in the app's machines list. */
  name: z.string().min(1).max(100),
});

/** One entry in an `/api/fs` response. */
export const FsEntrySchema = z.object({
  name: z.string().min(1).max(255),
  type: z.enum(['dir', 'file']),
  /**
   * Absolute path of the entry, joined SERVER-side so clients never build
   * paths themselves (separators differ per host OS: `/` vs `\`).
   */
  path: z.string().min(1),
  /** Bytes, present for files where stat() succeeded. */
  size: z.number().int().nonnegative().optional(),
  /** Unix epoch ms. */
  mtime: z.number().int().nonnegative().optional(),
});

/** One breadcrumb segment from the allowlist root down to the current dir. */
export const FsSegmentSchema = z.object({
  /** Display name (basename; the root segment may be e.g. `/` or `C:\`). */
  name: z.string().min(1),
  /** Absolute path to navigate to when the crumb is tapped. */
  path: z.string().min(1),
});

/**
 * Response payload of `GET /api/fs?path=…`.
 *
 * All navigation targets (`parent`, `segments[].path`, `entries[].path`) are
 * absolute paths computed by the host, so clients treat paths as opaque
 * strings and work identically against macOS, Linux, and Windows daemons.
 */
export const FsResponseSchema = z.object({
  path: z.string().min(1),
  /** Absolute path of the parent dir, or null at the allowlist root. */
  parent: z.string().min(1).nullable(),
  /** Host path separator — for display only, never for joining. */
  sep: z.enum(['/', '\\']),
  /** Breadcrumb trail, allowlist root first, current dir last. */
  segments: z.array(FsSegmentSchema).min(1),
  entries: z.array(FsEntrySchema),
});

/** Description of a single AI launcher exposed by the CLI. */
export const ToolInfoSchema = z.object({
  /** Stable, URL-safe tool id. Lowercase letters, digits, dashes only. */
  id: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9-]+$/, 'id must match /^[a-z0-9-]+$/'),
  label: z.string().min(1).max(100),
  /** Whether `which <bin>` succeeded for this tool on the host. */
  available: z.boolean(),
});

/** Response payload of `GET /api/tools`. */
export const ToolsResponseSchema = z.object({
  tools: z.array(ToolInfoSchema),
});

/** One running terminal session on the daemon. */
export const SessionInfoSchema = z.object({
  /** Session id (UUID) — pass as `?session=` on `/ws/pty` to re-attach. */
  id: z.string().uuid(),
  /** Working directory the session was launched in. */
  cwd: z.string().min(1),
  /** Tool id the session runs (e.g. "bash"). */
  tool: z.string().min(1),
  /** Unix epoch ms when the session was created. */
  createdMs: z.number().int().nonnegative(),
  /** Whether a client is currently attached. */
  attached: z.boolean(),
  /** User-assigned display name, set via `PUT /api/sessions/:id`. */
  name: z.string().min(1).max(100).optional(),
});

/** Response payload of `GET /api/sessions`. */
export const SessionsResponseSchema = z.object({
  sessions: z.array(SessionInfoSchema),
});

/** Response payload of `GET /api/health`. */
export const HealthResponseSchema = z.object({
  /** The cli package version. */
  version: z.string().min(1),
  /** Process uptime in milliseconds. */
  uptimeMs: z.number().int().nonnegative(),
  /** Resolved Tailscale IP, or null if not on a tailnet. */
  tailscaleIp: z.string().nullable(),
  /** TCP port the daemon listens on. */
  port: z.number().int().positive(),
});

/** Response payload of `GET /api/settings`. */
export const SettingsResponseSchema = z.object({
  /** Current listen port. */
  port: z.number().int().positive().max(65535),
  /** Current bind address. */
  bind: z.string().min(1),
  /** Friendly machine name shown in the QR. */
  name: z.string().min(1).max(100),
  /** Folder-browser allowlist root (absolute path). */
  fsRoot: z.string().min(1),
  /** Resolved Tailscale IP, or null if not on a tailnet (read-only). */
  tailscaleIp: z.string().nullable(),
});

/** Request body for `PUT /api/settings` — all fields optional. */
export const SettingsUpdateSchema = z.object({
  /** New listen port (requires daemon restart to take effect). */
  port: z.number().int().positive().max(65535).optional(),
  /** New bind address (requires daemon restart to take effect). */
  bind: z.string().min(1).optional(),
  /** New machine name (takes effect immediately). */
  name: z.string().min(1).max(100).optional(),
  /** New folder-browser allowlist root (takes effect immediately). */
  fsRoot: z.string().min(1).optional(),
});

/** Response payload of `PUT /api/settings`. */
export const SettingsUpdateResponseSchema = z.object({
  /** Updated settings after applying the patch. */
  settings: SettingsResponseSchema,
  /** Whether the daemon needs to be restarted for some changes to apply. */
  needsRestart: z.boolean(),
  /** Human-readable list of fields that triggered the restart requirement. */
  restartReasons: z.array(z.string()),
});

/** Request body for `PUT /api/sessions/:id` — rename a session. */
export const SessionUpdateSchema = z.object({
  name: z.string().min(1).max(100),
});

/**
 * Query parameters for `WS /ws/pty` handshake. Server-side this is parsed
 * from the URL; client-side the app builds it from user choices.
 */
export const PtyHelloQuerySchema = z.object({
  /** Absolute working directory for the spawned process. */
  cwd: z.string().min(1).max(4096),
  /** Tool id from `GET /api/tools` — must match the same regex as ToolInfo.id. */
  tool: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9-]+$/, 'tool id must match /^[a-z0-9-]+$/'),
  /** Optional model name (used by `ollama run <model>`). */
  model: z.string().min(1).max(100).optional(),
  /**
   * Existing session id to re-attach to (kept alive on the daemon across
   * disconnects). Omitted/unknown → a fresh session is created and its id is
   * returned to the client. UUID v4.
   */
  session: z.string().uuid().optional(),
  /** Initial PTY columns. */
  cols: z.coerce.number().int().positive().max(1000).default(80),
  /** Initial PTY rows. */
  rows: z.coerce.number().int().positive().max(1000).default(24),
});

/**
 * Build a `pilot://pair?v=1&p=<base64url JSON>` URL from a {@link PairingPayload}.
 * Lives in shared so the CLI can mint the URL it prints AND the App can
 * assert against the same shape in tests. Uses base64url so the URL is
 * safe inside a QR (no URL-unsafe characters).
 */
export function buildPairingUrl(
  payload: Pick<
    z.infer<typeof PairingPayloadSchema>,
    'host' | 'hosts' | 'port' | 'token' | 'name'
  >,
): string {
  const json = JSON.stringify({
    version: PROTOCOL_VERSION,
    host: payload.host,
    ...(payload.hosts ? { hosts: payload.hosts } : {}),
    port: payload.port,
    token: payload.token,
    name: payload.name,
  });
  const encoded = base64UrlEncode(json);
  return `${PAIRING_SCHEME}://pair?v=${PROTOCOL_VERSION}&p=${encoded}`;
}

/** Encode a UTF-8 string to base64url (no padding, URL-safe alphabet). */
function base64UrlEncode(input: string): string {
  // Node: Buffer is available globally when running JS in Node.
  const b64 =
    typeof Buffer !== 'undefined'
      ? Buffer.from(input, 'utf8').toString('base64')
      : // React Native / browser fallback (atob/btoa polyfilled).
        btoa(unescape(encodeURIComponent(input)));
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Helper — build a PairingPayload ready to be QR-encoded. The CLI uses this
 * to keep the same defaults (version 1, port default, token supplied) in one
 * place; the app uses it in tests to construct sample payloads.
 *
 * Return type uses `z.infer<typeof PairingPayloadSchema>` (not a cycle back
 * through `./types.js`) so there is exactly one source of truth: the schema.
 */
export function buildPairingPayload(input: {
  host: string;
  hosts?: string[];
  port: number;
  token: string;
  name: string;
}): z.infer<typeof PairingPayloadSchema> {
  return PairingPayloadSchema.parse({
    version: PROTOCOL_VERSION,
    host: input.host,
    ...(input.hosts ? { hosts: input.hosts } : {}),
    port: input.port,
    token: input.token,
    name: input.name,
  });
}
