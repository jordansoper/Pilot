/**
 * Cross-package constants. Bump PROTOCOL_VERSION when the REST/WS contract
 * changes in a backwards-incompatible way; PairingPayloadSchema enforces
 * the version on the wire.
 */
export const PROTOCOL_VERSION = 1;
export const DEFAULT_PORT = 7117;
/** Default bind address when neither Tailscale nor --bind is specified. */
export const DEFAULT_BIND = '0.0.0.0';

/** HTTP routes exposed by the CLI daemon. */
export const HEALTH_PATH = '/api/health';
export const FS_PATH = '/api/fs';
export const TOOLS_PATH = '/api/tools';
export const SESSIONS_PATH = '/api/sessions';
export const SETTINGS_PATH = '/api/settings';
export const WS_PATH = '/ws/pty';

/** Deep-link scheme used by the QR pairing flow. */
export const PAIRING_SCHEME = 'pilot';

/** Length of the bearer token generated per CLI startup (bytes, hex-encoded). */
export const TOKEN_BYTES = 32;

/** Default allowlist root for `/api/fs` — server prevents escape from this. */
export const FS_ALLOWLIST_ROOT_ENV = 'PILOT_FS_ROOT';
