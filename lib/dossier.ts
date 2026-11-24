// Launch Radar dossier builder: the makefun/dossier/v1 JSON for this entry's /output directory.
//
// The judge reads dossier.json: the screenshots, then a text of the dashboard's source. The gate's
// dossier_matches row requires the file to equal, byte for byte, what the scorer's own buildDossier
// writes from dashboard/ and screenshots/, so the shape and the cut rule below follow that library
// exactly. Node standard library only, erasable TypeScript.
//
//   schema   "makefun/dossier/v1"
//   cover    0: the first screenshot by name is the cover
//   images   the PNG and JPEG files in dir/screenshots/ (names starting with '.' skipped), in name
//            order, each {name, media_type, sha256, base64}
//   text     "## Dashboard" (file count, bytes, every file's path and size), then "## Source": each
//            text file's path, size and line count and its contents in a fenced block, in path order
//
// The text holds at most caps.text_max_bytes UTF-8 bytes: every file that fits goes in whole; the first
// that does not goes in up to its last complete line that fits (fence closed, then a line naming how many
// of its lines are not shown), or not at all when no line fits; nothing follows but one line naming how
// many whole files and bytes were left out. A file whose extension is not in TEXT_FILE is named in the
// Dashboard block and not shown. The caps on screenshots and dashboard files only refuse; only
// text_max_bytes shapes the bytes.

import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readSync } from 'node:fs';
import { join } from 'node:path';

export const DOSSIER_SCHEMA = 'makefun/dossier/v1';
/** The most bytes a dossier may hold: 1.5 MiB, the gate's dossier_matches limit. */
export const DOSSIER_MAX_BYTES = 1_572_864;
export const DOSSIER_MAX_IMAGES = 8;
/** A plain file's name: a letter, digit or _ first, then letters, digits and . _ -, 1 to 128 of them. */
export const PLAIN_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;
/** A dashboard file whose contents the dossier's text shows. */
export const TEXT_FILE = /\.(?:html|css|js|json|mjs|svg|md|txt)$/;

export interface DossierCaps {
  text_max_bytes: number;
  screenshots?: { max: number; max_bytes: number };
  dashboard?: { max_files: number; max_bytes: number };
}

export class DossierError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DossierError';
  }
}

const sha256Hex = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const byteLength = (s: string): number => Buffer.byteLength(s, 'utf8');
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG_MAGIC = [0xff, 0xd8, 0xff];
const opensWith = (bytes: Uint8Array, magic: readonly number[]): boolean => bytes.length >= magic.length && magic.every((b, i) => bytes[i] === b);

/** A cap object whose named members are all positive safe integers. */
function capsOf<K extends string>(value: unknown, name: string, keys: readonly K[]): Record<K, number> {
  if (typeof value !== 'object' || value === null) throw new DossierError(`buildDossier: caps.${name} must be an object {${keys.join(', ')}}`);
  const o = value as Record<string, unknown>;
  for (const k of keys) {
    const v = o[k];
    if (typeof v !== 'number' || !Number.isSafeInteger(v) || v <= 0) throw new DossierError(`buildDossier: caps.${name}.${k} must be a positive integer, not ${String(v)}`);
  }
  return o as Record<K, number>;
}

/** A regular file's bytes when it is at most `cap` long: never through a link, never more than `cap` bytes read. */
function readCapped(path: string, cap: number, what: string): Uint8Array {
  let size: number;
  try {
    const st = lstatSync(path);
    if (!st.isFile()) throw new DossierError(`buildDossier: ${what} is not a regular file`);
    size = st.size;
  } catch (err) {
    if (err instanceof DossierError) throw err;
    throw new DossierError(`buildDossier: ${what} cannot be read`);
  }
  if (size > cap) throw new DossierError(`buildDossier: ${what} is ${size} bytes, over the ${cap} a dossier reads`);
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    throw new DossierError(`buildDossier: ${what} is not a regular file`);
  }
  try {
    const now = fstatSync(fd).size;
    if (now > cap) throw new DossierError(`buildDossier: ${what} is ${now} bytes, over the ${cap} a dossier reads`);
    const buf = Buffer.alloc(now);
    let at = 0;
    while (at < buf.length) {
      const n = readSync(fd, buf, at, buf.length - at, at);
      if (n === 0) break;
      at += n;
    }
    return new Uint8Array(buf.buffer, buf.byteOffset, at);
  } finally {
    closeSync(fd);
  }
}

/** Lines of a text: 0 when empty, else its newlines plus one for a last line with none. */
function lineCount(bytes: Uint8Array): number {
  if (bytes.length === 0) return 0;
  let n = 0;
  for (const b of bytes) if (b === 0x0a) n++;
  return bytes[bytes.length - 1] === 0x0a ? n : n + 1;
}

/** A Markdown fence one backtick longer than the longest run in `body`, three at least. */
function fenceFor(body: string): string {
  let longest = 0;
  for (const run of body.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
  return '`'.repeat(Math.max(3, longest + 1));
}

/** JSON with every object's keys in code-unit order and no whitespace: one spelling per value. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`canonicalJson: ${value} is not a finite number`);
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(',')}]`;
  if (typeof value === 'object') {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) throw new TypeError('canonicalJson: only plain objects and arrays');
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o).sort(byCodeUnit).map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`;
  }
  throw new TypeError(`canonicalJson: a ${typeof value} has no JSON form`);
}

interface DashFile {
  path: string;
  size: number;
}

/** Every regular file under `root` in path order, refusing links, dot-directories, odd names and anything past the caps. */
function dashboardFiles(root: string, caps: { max_files: number; max_bytes: number } | null): DashFile[] {
  let st: ReturnType<typeof lstatSync>;
  try {
    st = lstatSync(root);
  } catch {
    throw new DossierError('buildDossier: no dashboard/ directory: the page and its source are what the judge reads');
  }
  if (!st.isDirectory()) throw new DossierError('buildDossier: dashboard is not a directory');
  const out: DashFile[] = [];
  let bytes = 0;
  const stack: string[] = [''];
  while (stack.length > 0) {
    const rel = stack.pop()!;
    for (const e of readdirSync(rel === '' ? root : join(root, rel), { withFileTypes: true })) {
      const p = rel === '' ? e.name : `${rel}/${e.name}`;
      if (e.isDirectory()) {
        if (e.name.startsWith('.')) throw new DossierError(`buildDossier: dashboard/${p} is a dot-directory`);
        stack.push(p);
      } else if (e.isFile()) {
        if (!PLAIN_NAME.test(e.name)) throw new DossierError(`buildDossier: dashboard/${p}: a file's name is letters, digits and . _ -, 1 to 128 characters, not starting with . or -`);
        const size = lstatSync(join(root, p)).size;
        out.push({ path: p, size });
        bytes += size;
        if (caps !== null && out.length > caps.max_files) throw new DossierError(`buildDossier: dashboard/ holds more than the ${caps.max_files} files it may`);
        if (caps !== null && bytes > caps.max_bytes) throw new DossierError(`buildDossier: dashboard/'s files come to more than the ${caps.max_bytes} bytes they may`);
      } else {
        throw new DossierError(`buildDossier: dashboard/${p} is neither a file nor a directory`);
      }
    }
  }
  return out.sort((a, b) => byCodeUnit(a.path, b.path));
}

/** One image of the dossier: the PNG or JPEG file, hashed and base64-encoded. */
function readImages(dir: string, maxImages: { n: number; whose: string }, maxBytes: { n: number }): object[] {
  const shotsDir = join(dir, 'screenshots');
  let names: string[];
  try {
    names = readdirSync(shotsDir, { withFileTypes: true })
      .filter((e) => e.isFile() && !e.name.startsWith('.'))
      .map((e) => e.name)
      .sort(byCodeUnit);
  } catch (err) {
    if ((err as { code?: string }).code === 'ENOENT') throw new DossierError('buildDossier: no screenshots/ directory: the first screenshot is the cover');
    throw new DossierError('buildDossier: screenshots/ cannot be read');
  }
  if (names.length === 0) throw new DossierError('buildDossier: screenshots/ holds no image: the first is the cover');
  if (names.length > maxImages.n) throw new DossierError(`buildDossier: screenshots/ holds ${names.length} files, over the ${maxImages.n} ${maxImages.whose}`);
  return names.map((name) => {
    if (!PLAIN_NAME.test(name)) throw new DossierError(`buildDossier: screenshots/${name}: a name is letters, digits and . _ -, 1 to 128 characters, not starting with . or -`);
    const bytes = readCapped(join(shotsDir, name), maxBytes.n, `screenshots/${name}`);
    const media_type = opensWith(bytes, PNG_MAGIC) ? 'image/png' : opensWith(bytes, JPEG_MAGIC) ? 'image/jpeg' : null;
    if (media_type === null) throw new DossierError(`buildDossier: screenshots/${name} is neither a PNG nor a JPEG`);
    return { name, media_type, sha256: sha256Hex(bytes), base64: Buffer.from(bytes).toString('base64') };
  });
}

/** A shown file's section: its heading, and (unless empty) its fenced contents. */
interface Section {
  heading: string;
  bytes: Uint8Array;
  text: string;
  fence: string;
  lang: string;
  lines: number;
  /** The whole section as it is written when it fits: heading, then the fenced block and a blank line. */
  whole: string;
}

function sectionOf(path: string, bytes: Uint8Array): Section {
  const lines = lineCount(bytes);
  const heading = `### ${path}\n\n${bytes.length} bytes, ${lines} line${lines === 1 ? '' : 's'}\n\n`;
  const text = new TextDecoder('utf-8').decode(bytes);
  const fence = fenceFor(text);
  const ext = path.slice(path.lastIndexOf('.') + 1);
  const lang = ext === 'mjs' ? 'js' : ext;
  const block = bytes.length === 0 ? '' : `${fence}${lang}\n${text}${text.endsWith('\n') ? '' : '\n'}${fence}\n\n`;
  return { heading, bytes, text, fence, lang, lines, whole: `${heading}${block}` };
}

/**
 * A section cut inside its contents: the heading, its first k lines in a closed fence, a line naming how
 * many lines are not shown, then tail(hidden). k is the most lines (at least one, fewer than all) whose
 * whole fits in `room` bytes; null when not one line fits. Cuts fall only after a line's LF.
 */
function sectionHead(s: Section, room: number, tail: (hiddenBytes: number) => string): string | null {
  if (s.bytes.length === 0) return null;
  const lines = s.text.split('\n');
  const open = `${s.fence}${s.lang}\n`;
  const close = `${s.fence}\n\n`;
  const note = (k: number): string => `[${s.lines - k} of this file's ${s.lines} lines not shown.]\n`;
  const fixed = byteLength(s.heading) + byteLength(open) + byteLength(close);
  let best = 0;
  let shown = 0;
  let raw = 0; // raw bytes through the end of line k
  let bestRaw = 0;
  for (let k = 1; k < s.lines; k++) {
    shown += byteLength(lines[k - 1]!) + 1;
    raw = s.bytes.indexOf(0x0a, raw) + 1;
    if (fixed + shown + byteLength(note(k)) + byteLength(tail(s.bytes.length - raw)) <= room) {
      best = k;
      bestRaw = raw;
    }
  }
  if (best === 0) return null;
  const head = lines.slice(0, best).map((l) => `${l}\n`).join('');
  return `${s.heading}${open}${head}${close}${note(best)}${tail(s.bytes.length - bestRaw)}`;
}

/**
 * The dossier of `dir` (its dashboard/ and screenshots/) as canonical JSON bytes. Throws DossierError on
 * caps it cannot keep and on a dashboard or screenshots directory it refuses.
 */
export function buildDossier(dir: string, caps: DossierCaps): Uint8Array {
  const max = caps.text_max_bytes;
  if (!Number.isSafeInteger(max) || max <= 0) throw new DossierError(`buildDossier: caps.text_max_bytes must be a positive integer, not ${String(max)}`);

  let maxImages = { n: DOSSIER_MAX_IMAGES, whose: 'a dossier holds' };
  let maxImageBytes = { n: DOSSIER_MAX_BYTES };
  if (caps.screenshots !== undefined) {
    const s = capsOf(caps.screenshots, 'screenshots', ['max', 'max_bytes'] as const);
    if (s.max < maxImages.n) maxImages = { n: s.max, whose: 'caps.screenshots.max allows' };
    if (s.max_bytes < maxImageBytes.n) maxImageBytes = { n: s.max_bytes };
  }
  const fileCaps = caps.dashboard === undefined ? null : capsOf(caps.dashboard, 'dashboard', ['max_files', 'max_bytes'] as const);

  const files = dashboardFiles(join(dir, 'dashboard'), fileCaps);
  const images = readImages(dir, maxImages, maxImageBytes);

  const head = [
    '## Dashboard',
    '',
    `Files: ${files.length} (${files.reduce((n, f) => n + f.size, 0)} bytes)`,
    ...files.map((f) => `- ${f.path} (${f.size} bytes)`),
    '',
    '## Source',
    '',
    '',
  ].join('\n');

  const sections = files
    .filter((f) => TEXT_FILE.test(f.path))
    .map((f) => sectionOf(f.path, readCapped(join(dir, 'dashboard', f.path), DOSSIER_MAX_BYTES, `dashboard/${f.path}`)));
  // after[k]: the raw bytes of the shown files after section k.
  const after = new Array<number>(sections.length + 1).fill(0);
  for (let k = sections.length - 1; k >= 0; k--) after[k] = after[k + 1]! + (k + 1 < sections.length ? sections[k + 1]!.bytes.length : 0);

  const cutLine = (count: number, bytes: number): string => `[Cut at ${max} bytes: ${count} file${count === 1 ? '' : 's'} and ${bytes} bytes left out.]\n`;
  if (byteLength(head) + byteLength(cutLine(0, 0)) > max) throw new DossierError(`buildDossier: caps.text_max_bytes ${max} cannot hold even the Dashboard block and the cut line`);

  let out = head;
  let used = byteLength(head);
  let kept = 0;
  for (; kept < sections.length; kept++) {
    const restCount = sections.length - kept - 1;
    const tail = restCount === 0 ? 0 : byteLength(cutLine(restCount, after[kept]!));
    const size = byteLength(sections[kept]!.whole);
    if (used + size + tail > max) break;
    out += sections[kept]!.whole;
    used += size;
  }
  if (kept < sections.length) {
    const first = sections[kept]!;
    const restCount = sections.length - kept - 1;
    const part = sectionHead(first, max - used, (hidden) => cutLine(restCount, after[kept]! + hidden));
    out += part ?? cutLine(restCount + 1, after[kept]! + first.bytes.length);
  }
  if (byteLength(out) > max) throw new DossierError(`buildDossier: caps.text_max_bytes ${max} cannot hold even the Dashboard block and the cut line`);

  const bytes = Buffer.from(canonicalJson({ schema: DOSSIER_SCHEMA, cover: 0, text: out.replace(/\n+$/, '\n'), images }), 'utf8');
  if (bytes.length > DOSSIER_MAX_BYTES) throw new DossierError(`buildDossier: the dossier is ${bytes.length} bytes, over the ${DOSSIER_MAX_BYTES} one holds`);
  return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.length);
}
