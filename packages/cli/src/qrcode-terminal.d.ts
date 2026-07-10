/**
 * Ambient declaration for `qrcode-terminal` (which ships no types and whose
 * `@types` package hasn't kept pace with the library). Matches the API
 * surface we actually use.
 */
declare module 'qrcode-terminal' {
  export interface GenerateOptions {
    small?: boolean;
  }
  /**
   * Prints the QR encoding `input` directly to stdout. If `callback` is
   * provided, the ASCII string is passed to it (instead of/in addition to
   * the default behaviour, depending on the version).
   */
  export function generate(
    input: string,
    options?: GenerateOptions,
    callback?: (qr: string) => void,
  ): void;

  const _default: { generate: typeof generate };
  export default _default;
}
