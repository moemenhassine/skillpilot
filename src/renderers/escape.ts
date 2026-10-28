// C0/C1 controls (incl. ESC, so ANSI/OSC sequences), DEL, and Unicode bidi/invisible format controls.
// eslint-disable-next-line no-control-regex
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;

/** Makes untrusted text inert for single-line terminal display. */
export function escapeText(text: string): string {
  return text.replace(UNSAFE, (ch) => `\\u{${ch.codePointAt(0)!.toString(16)}}`);
}
