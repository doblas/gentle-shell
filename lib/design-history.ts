import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { dirname, join, sep } from "node:path";
import { isArtboardPath, isDesignCommentId, locateDesignFile, readDesignFile, replaceDesignFile, serializeDesignWrite } from "./design-comments.ts";

// The single owner of design/<slug>/.history/: earlier versions of each artboard (S1). Version content lives in
// `.history/<artboard-file>/<n>.html` and `.history/index.json` lists them. The canvas server snapshots an
// artboard when it first sees it and whenever its content changes, and restores a version through this module.
// Like comments.json and handoffs.json, every write runs in a per-design in-process queue, re-reads the index
// just before writing and replaces files atomically (temp + rename). An index this module cannot parse is
// reported and never overwritten, and nothing here follows a symlink or leaves design/<slug>/.

export const DESIGN_HISTORY_DIR = ".history";
export const DESIGN_HISTORY_INDEX = "index.json";
/** The most versions kept per artboard; the oldest beyond it are dropped, never the newest. */
export const MAX_DESIGN_VERSIONS = 50;
/**
 * A stored version is at most this big; a larger artboard is skipped with a warning. Smaller than the served-file limit
 * on purpose: 50 versions of one artboard would otherwise keep up to 1.6 GB.
 */
export const MAX_DESIGN_VERSION_BYTES = 8 * 1024 * 1024;
export const DESIGN_VERSION_NOTE_LIMIT = 500;
const MAX_ARTBOARDS = 256;
const MAX_INDEX_BYTES = 4 * 1024 * 1024;

export type DesignVersionSource = "agent" | "hand" | "restore";

export type DesignVersion = {
	/** 1, 2, 3...: never reused, even after the oldest versions are dropped. */
	n: number;
	createdAt: string;
	/** The server cannot tell an agent edit from a hand edit: "hand" until a resolution tags it "agent". */
	source: DesignVersionSource;
	/** The comment this version applied, when known. */
	comment?: string;
	note?: string;
	/** SHA-256 of the content, so identical content is never stored twice. */
	sha256: string;
};

export type DesignHistoryDocument = { version: 1; artboards: Record<string, { versions: DesignVersion[] }> };

export type DesignHistoryErrorCode = "not-found" | "invalid-file" | "invalid-input" | "limit" | "too-large" | "unsafe";

export class DesignHistoryError extends Error {
	readonly code: DesignHistoryErrorCode;
	constructor(code: DesignHistoryErrorCode, message: string) {
		super(message);
		this.name = "DesignHistoryError";
		this.code = code;
	}
}

export type DesignObservation =
	| { status: "created"; version: DesignVersion }
	| { status: "unchanged" }
	/** The artboard file does not exist (yet, or any more). */
	| { status: "missing" }
	/** Too big to store: nothing was written. */
	| { status: "skipped"; reason: "too-large" | "unsafe"; message: string };

export type DesignRestoreResult = {
	/** The version whose content was written back. */
	restoredFrom: number;
	/** The version that saved the artboard's content before the restore, when it was not stored yet. */
	saved?: DesignVersion;
	/** The new `restore` version; absent when the artboard already had that content. */
	version?: DesignVersion;
};

export interface DesignHistoryStoreDeps {
	now?: () => Date;
	maxVersionBytes?: number;
	maxVersions?: number;
}

export interface DesignHistoryStore {
	/** The design's history; a missing .history is an empty document. */
	read(slug: string): Promise<DesignHistoryDocument>;
	/**
	 * Stores the artboard's current content as its next version, unless it equals the latest one.
	 * The first time an artboard is seen its content is v1. The caller checks `file` against the manifest.
	 */
	observe(slug: string, file: string, options?: { source?: "hand" | "agent" }): Promise<DesignObservation>;
	/** Saves the artboard's current content when it is not the latest version, then writes version `n` back and records it. */
	restore(slug: string, file: string, n: number): Promise<DesignRestoreResult>;
	/** The content of version `n`, only when the index lists it; undefined otherwise. */
	readVersion(slug: string, file: string, n: number): Promise<{ version: DesignVersion; data: Buffer } | undefined>;
	/** Tags an existing version: the agent that made it, the comment it applied, a one-line note. */
	annotate(slug: string, file: string, n: number, patch: { source?: "agent" | "hand"; comment?: string; note?: string }): Promise<DesignVersion>;
}

const SHA256 = /^[0-9a-f]{64}$/;

function invalid(message: string): DesignHistoryError {
	return new DesignHistoryError("invalid-file", message);
}

function isMissing(error: unknown): boolean {
	const code = (error as NodeJS.ErrnoException)?.code;
	return code === "ENOENT" || code === "ENOTDIR";
}

function sha256(data: Buffer): string {
	return createHash("sha256").update(data).digest("hex");
}

function isTimestamp(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= 64;
}

function noteProblem(value: unknown): string | undefined {
	if (typeof value !== "string") return "note must be a string";
	if (value.length > DESIGN_VERSION_NOTE_LIMIT) return `note must have at most ${DESIGN_VERSION_NOTE_LIMIT} characters`;
	return undefined;
}

/** The version with its keys in a stable order and no absent optional keys. */
function versionOf(fields: DesignVersion): DesignVersion {
	const version: DesignVersion = { n: fields.n, createdAt: fields.createdAt, source: fields.source } as DesignVersion;
	if (fields.comment !== undefined) version.comment = fields.comment;
	if (fields.note !== undefined) version.note = fields.note;
	version.sha256 = fields.sha256;
	return version;
}

function parseDocument(raw: string, maxVersions: number): DesignHistoryDocument {
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		throw invalid("history index.json is not valid JSON");
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid("history index.json must be a JSON object");
	const record = value as Record<string, unknown>;
	if (record.version !== 1) throw invalid("history index.json version must be 1");
	if (!record.artboards || typeof record.artboards !== "object" || Array.isArray(record.artboards)) throw invalid("history index.json artboards must be an object");
	const entries = Object.entries(record.artboards as Record<string, unknown>);
	if (entries.length > MAX_ARTBOARDS) throw invalid(`history index.json may hold at most ${MAX_ARTBOARDS} artboards`);
	const artboards: DesignHistoryDocument["artboards"] = {};
	for (const [file, entry] of entries) {
		const where = `artboards[${JSON.stringify(file)}]`;
		if (!isArtboardPath(file)) throw invalid(`history index.json key ${JSON.stringify(file)} must be a relative .html artboard path`);
		if (!entry || typeof entry !== "object" || Array.isArray(entry) || !Array.isArray((entry as { versions?: unknown }).versions)) throw invalid(`${where}.versions must be an array`);
		const list = (entry as { versions: unknown[] }).versions;
		if (list.length < 1 || list.length > maxVersions) throw invalid(`${where}.versions must have 1 to ${maxVersions} entries`);
		let previous = 0;
		const versions = list.map((item, index): DesignVersion => {
			const at = `${where}.versions[${index}]`;
			if (!item || typeof item !== "object" || Array.isArray(item)) throw invalid(`${at} must be an object`);
			const fields = item as Record<string, unknown>;
			if (!Number.isSafeInteger(fields.n) || (fields.n as number) <= previous) throw invalid(`${at}.n must be a whole number greater than the one before`);
			previous = fields.n as number;
			if (!isTimestamp(fields.createdAt)) throw invalid(`${at}.createdAt must be a timestamp`);
			if (fields.source !== "agent" && fields.source !== "hand" && fields.source !== "restore") throw invalid(`${at}.source must be "agent", "hand" or "restore"`);
			if (typeof fields.sha256 !== "string" || !SHA256.test(fields.sha256)) throw invalid(`${at}.sha256 must be a hex SHA-256`);
			if (fields.comment !== undefined && !isDesignCommentId(fields.comment)) throw invalid(`${at}.comment must be a comment id`);
			if (fields.note !== undefined) {
				const problem = noteProblem(fields.note);
				if (problem) throw invalid(`${at}.${problem}`);
			}
			return versionOf(fields as unknown as DesignVersion);
		});
		artboards[file] = { versions };
	}
	return { version: 1, artboards };
}

/** `path` when it is a real directory (never a link), created when `create` is set; undefined when missing and not created. */
async function realDirectory(path: string, create: boolean, name: string): Promise<string | undefined> {
	const refused = invalid(`${name} must be a directory, not a link`);
	try {
		if (!(await lstat(path)).isDirectory()) throw refused;
		return path;
	} catch (error) {
		if (error === refused || !isMissing(error)) throw error;
	}
	if (!create) return undefined;
	await mkdir(path).catch((error: NodeJS.ErrnoException) => { if (error?.code !== "EEXIST") throw error; });
	if (!(await lstat(path)).isDirectory()) throw refused;
	return path;
}

/** The bytes of a regular file (a link is refused) of at most `max` bytes; undefined when missing, "too-large" when over. */
async function readRegular(path: string, max: number): Promise<Buffer | undefined | "too-large"> {
	try {
		if (!(await lstat(path)).isFile()) throw invalid(`${path} must be a regular file`);
		// O_NOFOLLOW: a link swapped in after the lstat above is refused, not followed.
		const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
		try {
			const info = await handle.stat();
			if (!info.isFile()) throw invalid(`${path} must be a regular file`);
			if (info.size > max) return "too-large";
			return await handle.readFile();
		} finally {
			await handle.close();
		}
	} catch (error) {
		if (isMissing(error)) return undefined;
		throw error;
	}
}

export function createDesignHistoryStore(designRoot: string, deps: DesignHistoryStoreDeps = {}): DesignHistoryStore {
	const now = deps.now ?? (() => new Date());
	const maxBytes = deps.maxVersionBytes ?? MAX_DESIGN_VERSION_BYTES;
	const maxVersions = deps.maxVersions ?? MAX_DESIGN_VERSIONS;

	/** The real design directory; design.json is only the existing locator's file name. */
	async function locate(slug: string): Promise<string> {
		return (await locateDesignFile(designRoot, slug, "design.json", (message) => new DesignHistoryError("not-found", message))).dir;
	}

	function checkFile(file: unknown): asserts file is string {
		if (!isArtboardPath(file)) throw new DesignHistoryError("invalid-input", "file must be a relative .html path inside the design");
	}

	function checkVersion(n: unknown): asserts n is number {
		if (!Number.isSafeInteger(n) || (n as number) < 1) throw new DesignHistoryError("invalid-input", "n must be a whole number from 1");
	}

	/** `.history` of the design, as a real directory. */
	const historyDir = (dir: string, create: boolean) => realDirectory(join(dir, DESIGN_HISTORY_DIR), create, `design/${DESIGN_HISTORY_DIR}`);

	/** `.history/<artboard-file>/`, every segment a real directory. */
	async function artboardDir(dir: string, file: string, create: boolean): Promise<string | undefined> {
		let current = await historyDir(dir, create);
		for (const segment of file.split("/")) {
			if (current === undefined) return undefined;
			current = await realDirectory(join(current, segment), create, `${DESIGN_HISTORY_DIR}/${file}`);
		}
		return current;
	}

	async function loadIndex(dir: string): Promise<DesignHistoryDocument> {
		const history = await historyDir(dir, false);
		if (history === undefined) return { version: 1, artboards: {} };
		const path = join(history, DESIGN_HISTORY_INDEX);
		try {
			if (!(await lstat(path)).isFile()) throw invalid("history index.json must be a regular file");
		} catch (error) {
			if (isMissing(error)) return { version: 1, artboards: {} };
			throw error;
		}
		const raw = await readDesignFile(path, MAX_INDEX_BYTES, () => invalid("history index.json is too large"));
		if (raw === undefined) return { version: 1, artboards: {} };
		return parseDocument(raw, maxVersions);
	}

	async function saveIndex(dir: string, document: DesignHistoryDocument): Promise<void> {
		const history = (await historyDir(dir, true))!;
		const path = join(history, DESIGN_HISTORY_INDEX);
		try {
			if (!(await lstat(path)).isFile()) throw invalid("history index.json must be a regular file");
		} catch (error) {
			if (!isMissing(error)) throw error;
		}
		const text = `${JSON.stringify(document, null, 2)}\n`;
		// An index this module could not read back would lock the history: refuse it and keep the one on disk.
		if (Buffer.byteLength(text) > MAX_INDEX_BYTES) throw new DesignHistoryError("limit", `design/${DESIGN_HISTORY_DIR}/${DESIGN_HISTORY_INDEX} would be larger than ${MAX_INDEX_BYTES} bytes, so this change was not recorded. Delete old versions from .history to make room.`);
		await replaceDesignFile(history, path, DESIGN_HISTORY_INDEX, text);
	}

	/** Runs `task` after every earlier history task of this design. */
	async function queued<T>(slug: string, task: (dir: string) => Promise<T>): Promise<T> {
		const dir = await locate(slug);
		return serializeDesignWrite(join(dir, DESIGN_HISTORY_DIR, DESIGN_HISTORY_INDEX), () => task(dir));
	}

	/**
	 * The artboard file's path inside the design: the file itself, or where it would be (`exists: false`); undefined
	 * when its folder is missing. Every folder segment and the file must be what they claim to be: a link is refused
	 * ("unsafe"), so nothing is read or written through one, and the path returned is the lexical one, never a realpath.
	 */
	async function artboardPath(dir: string, file: string): Promise<{ path: string; exists: boolean } | undefined> {
		const unsafe = () => new DesignHistoryError("unsafe", `${file} is a link or inside a linked folder, so its versions are not stored and it cannot be restored.`);
		const segments = file.split("/");
		let current = dir;
		for (const segment of segments.slice(0, -1)) {
			current = join(current, segment);
			try {
				const info = await lstat(current);
				if (info.isSymbolicLink() || !info.isDirectory()) throw unsafe();
			} catch (error) {
				if (isMissing(error)) return undefined;
				throw error;
			}
		}
		const path = join(current, segments[segments.length - 1]);
		try {
			const info = await lstat(path);
			if (info.isSymbolicLink()) throw unsafe();
			if (!info.isFile()) throw new DesignHistoryError("invalid-file", `${file} must be a regular file.`);
			return { path, exists: true };
		} catch (error) {
			if (!isMissing(error)) throw error;
		}
		return { path, exists: false };
	}

	/** Replaces the artboard at `path` by renaming a synced temp file over it, keeping the file's mode when it has one. */
	async function replaceArtboard(path: string, content: Buffer, existing: boolean): Promise<void> {
		const mode = existing ? (await lstat(path)).mode & 0o777 : 0o644;
		const temp = join(dirname(path), `.${randomBytes(6).toString("hex")}.tmp`);
		const handle = await open(temp, "wx", mode);
		try {
			await handle.writeFile(content);
			await chmod(temp, mode);
			await handle.sync();
		} finally {
			await handle.close();
		}
		try {
			await rename(temp, path);
		} catch (error) {
			await unlink(temp).catch(() => {});
			throw error;
		}
	}

	async function readArtboard(dir: string, file: string): Promise<Buffer | undefined | "too-large"> {
		const located = await artboardPath(dir, file);
		return located?.exists ? readRegular(located.path, maxBytes) : undefined;
	}

	/** Appends a version with `data` as its content; returns the version and the ones dropped for retention. */
	async function addVersion(dir: string, document: DesignHistoryDocument, file: string, data: Buffer, fields: { source: DesignVersionSource; comment?: string; note?: string }): Promise<{ version: DesignVersion; dropped: number[] }> {
		if (!Object.hasOwn(document.artboards, file) && Object.keys(document.artboards).length >= MAX_ARTBOARDS) {
			throw new DesignHistoryError("limit", `design/${DESIGN_HISTORY_DIR} already has ${MAX_ARTBOARDS} artboards, the most a design can hold.`);
		}
		const entry = Object.hasOwn(document.artboards, file) ? document.artboards[file] : { versions: [] as DesignVersion[] };
		const n = entry.versions.length === 0 ? 1 : entry.versions[entry.versions.length - 1].n + 1;
		const folder = (await artboardDir(dir, file, true))!;
		const name = `${n}.html`;
		await replaceDesignFile(folder, join(folder, name), name, data);
		const version = versionOf({ n, createdAt: now().toISOString(), source: fields.source, comment: fields.comment, note: fields.note, sha256: sha256(data) });
		entry.versions.push(version);
		const dropped: number[] = [];
		while (entry.versions.length > maxVersions) dropped.push(entry.versions.shift()!.n);
		document.artboards[file] = entry;
		return { version, dropped };
	}

	/** Deletes the content files of dropped versions, after the index no longer lists them; failures only leave a stray file. */
	async function removeFiles(dir: string, file: string, numbers: readonly number[]): Promise<void> {
		const folder = await artboardDir(dir, file, false).catch(() => undefined);
		if (!folder) return;
		for (const n of numbers) {
			const path = join(folder, `${n}.html`);
			try {
				if ((await lstat(path)).isFile()) await unlink(path);
			} catch { /* a missing or unreadable file is already gone from the index */ }
		}
	}

	/** Saves the index; when that fails, the content file written for `version` is taken back. */
	async function commit(dir: string, document: DesignHistoryDocument, file: string, added: { version: DesignVersion; dropped: number[] } | undefined): Promise<void> {
		try {
			await saveIndex(dir, document);
		} catch (error) {
			if (added) await removeFiles(dir, file, [added.version.n]);
			throw error;
		}
		if (added && added.dropped.length > 0) await removeFiles(dir, file, added.dropped);
	}

	const latestOf = (document: DesignHistoryDocument, file: string): DesignVersion | undefined => {
		if (!Object.hasOwn(document.artboards, file)) return undefined;
		const versions = document.artboards[file].versions;
		return versions[versions.length - 1];
	};

	return {
		async read(slug) {
			return loadIndex(await locate(slug));
		},

		async observe(slug, file, options) {
			checkFile(file);
			const source = options?.source ?? "hand";
			if (source !== "hand" && source !== "agent") throw new DesignHistoryError("invalid-input", 'source must be "hand" or "agent"');
			return queued(slug, async (dir) => {
				let data: Buffer | undefined | "too-large";
				try {
					data = await readArtboard(dir, file);
				} catch (error) {
					// One bad artboard must not block the design's history: it is skipped, and says why.
					if (error instanceof DesignHistoryError && error.code === "unsafe") return { status: "skipped", reason: "unsafe", message: error.message.replace(/, so its versions are not stored and it cannot be restored\./, ", so its versions are not stored.") };
					throw error;
				}
				if (data === undefined) return { status: "missing" };
				if (data === "too-large") return { status: "skipped", reason: "too-large", message: `${file} is larger than ${maxBytes} bytes, so its versions are not stored.` };
				const document = await loadIndex(dir);
				if (latestOf(document, file)?.sha256 === sha256(data)) return { status: "unchanged" };
				const added = await addVersion(dir, document, file, data, { source });
				await commit(dir, document, file, added);
				return { status: "created", version: added.version };
			});
		},

		async restore(slug, file, n) {
			checkFile(file);
			checkVersion(n);
			return queued(slug, async (dir) => {
				const document = await loadIndex(dir);
				const version = Object.hasOwn(document.artboards, file) ? document.artboards[file].versions.find((candidate) => candidate.n === n) : undefined;
				if (!version) throw new DesignHistoryError("not-found", `${file} has no version ${n}.`);
				const folder = await artboardDir(dir, file, false);
				const stored = folder ? await readRegular(join(folder, `${n}.html`), maxBytes) : undefined;
				if (stored === undefined) throw invalid(`The content of ${file} version ${n} is missing.`);
				if (stored === "too-large" || sha256(stored) !== version.sha256) throw invalid(`The content of ${file} version ${n} does not match the history index.`);
				const located = await artboardPath(dir, file);
				if (!located) throw new DesignHistoryError("not-found", `${file} has no folder in the design.`);
				const result: DesignRestoreResult = { restoredFrom: n };
				// Nothing is lost: what the artboard holds now is saved first, unless it is already the latest version.
				const current = located.exists ? await readRegular(located.path, maxBytes) : undefined;
				if (current === "too-large") throw new DesignHistoryError("too-large", `${file} is larger than ${maxBytes} bytes, so its current content cannot be saved before the restore.`);
				if (current !== undefined && latestOf(document, file)?.sha256 !== sha256(current)) {
					const saved = await addVersion(dir, document, file, current, { source: "hand" });
					await commit(dir, document, file, saved);
					result.saved = saved.version;
				}
				if (current !== undefined && sha256(current) === version.sha256) return result;
				await replaceArtboard(located.path, stored, located.exists);
				if (latestOf(document, file)?.sha256 !== version.sha256) {
					const added = await addVersion(dir, document, file, stored, { source: "restore" });
					await commit(dir, document, file, added);
					result.version = added.version;
				}
				return result;
			});
		},

		async readVersion(slug, file, n) {
			checkFile(file);
			checkVersion(n);
			const dir = await locate(slug);
			const document = await loadIndex(dir);
			const version = Object.hasOwn(document.artboards, file) ? document.artboards[file].versions.find((candidate) => candidate.n === n) : undefined;
			if (!version) return undefined;
			const folder = await artboardDir(dir, file, false);
			const data = folder ? await readRegular(join(folder, `${n}.html`), maxBytes) : undefined;
			return typeof data === "string" || data === undefined ? undefined : { version, data };
		},

		async annotate(slug, file, n, patch) {
			checkFile(file);
			checkVersion(n);
			if (patch.source !== undefined && patch.source !== "agent" && patch.source !== "hand") throw new DesignHistoryError("invalid-input", 'source must be "hand" or "agent"');
			if (patch.comment !== undefined && !isDesignCommentId(patch.comment)) throw new DesignHistoryError("invalid-input", "comment must be a comment id");
			if (patch.note !== undefined) {
				const problem = noteProblem(patch.note);
				if (problem) throw new DesignHistoryError("invalid-input", problem);
			}
			return queued(slug, async (dir) => {
				const document = await loadIndex(dir);
				const entry = Object.hasOwn(document.artboards, file) ? document.artboards[file] : undefined;
				const index = entry ? entry.versions.findIndex((candidate) => candidate.n === n) : -1;
				if (!entry || index === -1) throw new DesignHistoryError("not-found", `${file} has no version ${n}.`);
				const current = entry.versions[index];
				// A restore version stays a restore; only an edit's attribution can be refined.
				const source = current.source === "restore" || patch.source === undefined ? current.source : patch.source;
				const note = patch.note === undefined ? current.note : patch.note.replace(/\r\n?/g, "\n").trim() || undefined;
				entry.versions[index] = versionOf({ ...current, source, comment: patch.comment ?? current.comment, note });
				await saveIndex(dir, document);
				return entry.versions[index];
			});
		},
	};
}
