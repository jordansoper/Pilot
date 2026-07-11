import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

/** A minimal request shape — only headers matter for auth. */
type HeaderedRequest = Pick<IncomingMessage, 'headers'>;

const BEARER_PREFIX = 'bearer ';

/**
 * Constant-time hex-token comparison. Both sides are lowercased and decoded
 * to byte buffers so `timingSafeEqual` works on equal-length input. Used
 * for both the Authorization: Bearer header and the WebView-friendly
 * Sec-WebSocket-Protocol subprotocol.
 */
function matchHexToken(input: string, expected: string): boolean {
  const expectedHex = expected.toLowerCase();
  if (!/^[0-9a-f]+$/.test(expectedHex)) return false;
  const expectedBuf = Buffer.from(expectedHex, 'hex');

  const presented = input.toLowerCase();
  if (!/^[0-9a-f]+$/.test(presented)) return false;
  const presentedBuf = Buffer.from(presented, 'hex');
  if (presentedBuf.length !== expectedBuf.length) return false;
  try {
    return timingSafeEqual(presentedBuf, expectedBuf);
  } catch {
    /* length mismatch already guarded */
    return false;
  }
}

function commaList(input: string): string[] {
  return input
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Verifies a request's auth. Two paths:
 *
 *   1. `Authorization: Bearer <hex-token>` — used by Node `ws` clients and
 *      direct `fetch` calls from CLI tooling.
 *   2. `Sec-WebSocket-Protocol: <hex-token>` — required for browser /
 *      RN-WebView clients, which can't set custom headers on a WebSocket.
 *      The token is sent as the subprotocol entry; the server selects it
 *      and echoes it back in the handshake so the WS API accepts it.
 *
 * Both are checked in constant time. Multi-value headers are joined with
 * commas (RFC 7235) and each candidate tried in turn.
 */
export function checkBearer(req: HeaderedRequest, expected: string): boolean {
  // 1. Authorization: Bearer.
  const auth = req.headers.authorization;
  if (typeof auth === 'string') {
    for (const part of commaList(auth)) {
      if (part.toLowerCase().startsWith(BEARER_PREFIX)) {
        const token = part.slice(BEARER_PREFIX.length).trim();
        if (matchHexToken(token, expected)) return true;
      }
    }
  }

  // 2. Sec-WebSocket-Protocol. Subprotocol entries are the bare token; no
  //    "Bearer" prefix here.
  const proto = req.headers['sec-websocket-protocol'];
  if (typeof proto === 'string') {
    for (const candidate of commaList(proto)) {
      if (matchHexToken(candidate, expected)) return true;
    }
  }

  return false;
}

/**
 * Return the subprotocol entry that, when echoed on the WS upgrade,
 * satisfies {@link checkBearer}. Used by {@link handleUpgrade} so the
 * `WebSocketServer.handleUpgrade` call gets a syntactically valid
 * `protocol` argument rather than throwing on an unknown subprotocol.
 */
export function pickSubprotocol(req: HeaderedRequest): string | undefined {
  const proto = req.headers['sec-websocket-protocol'];
  if (typeof proto !== 'string') return undefined;
  for (const candidate of commaList(proto)) {
    if (/^[0-9a-f]+$/i.test(candidate)) return candidate;
  }
  return undefined;
}
