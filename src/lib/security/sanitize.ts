/**
 * Free-text sanitization at the boundary.
 *
 * The defenses in depth:
 *   - React escapes HTML on render, so stored text is not a markup-injection vector;
 *   - the agent treats every document and tool result as untrusted DATA;
 *   - this layer additionally removes the Unicode characters that can change the
 *     VISUAL ORDER of digits and labels (bidi overrides / isolates) and the C0/C1
 *     control characters, which are never legitimate in a name, reference or
 *     message. A bidi override can make "1500.00 USD" read as "DSU 00.0051" and
 *     is a documented financial-fraud technique, so it is stripped at ingress.
 */
import { z } from 'zod';

/** Bidi marks, formatting and isolates: U+200E..U+200F, U+202A..U+202E, U+2066..U+2069. */
const BIDI = new RegExp('[\\u200E-\\u200F\\u202A-\\u202E\\u2066-\\u2069]', 'g');
/** Zero-width characters: ZWSP, ZWNJ, ZWJ, BOM, soft hyphen, word joiner. */
const ZERO_WIDTH = new RegExp('[\\u200B-\\u200F\\u200D\\u200C\\uFEFF\\u00AD\\u2060]', 'g');
/** C0 controls except tab (0x09), LF (0x0A), CR (0x0D); plus the C1 range 0x80..0x9F. */
const CONTROLS = new RegExp('[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F-\\u009F]', 'g');

export function sanitizeFreeText(input: string): string {
  return input
    .replace(BIDI, '')
    .replace(ZERO_WIDTH, '')
    .replace(CONTROLS, '')
    // Collapse runs of whitespace/newlines and trim.
    .replace(/[\t ]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * A Zod string that first sanitizes. Use for every free-text field. The value
 * is transformed before length checks, so a string consisting only of control
 * characters becomes '' and then fails a `.min(1)` as it should.
 */
export function safeText(max: number, min = 1) {
  return z
    .string()
    .transform((s) => sanitizeFreeText(s))
    .refine((s) => s.length >= min, { message: 'text is required' })
    .pipe(z.string().min(min).max(max));
}
