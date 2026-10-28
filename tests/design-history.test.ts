import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, statSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { TestContext } from "node:test";
import test from "node:test";
import { DesignHistoryError, MAX_DESIGN_VERSIONS, MAX_DESIGN_VERSION_BYTES, createDesignHistoryStore } from "../lib/design-history.ts";

// design/<slug>/.history/ has one owner: lib/design-history.ts (S1, S4). Temp dirs only.

function scratch(t: TestContext, prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

function fixture(t: TestContext) {
	const root = join(scratch(t, "gentle-design-history-"), "design");
	const dir = join(root, "alpha");
	mkdirSync(join(dir, "sub"), { recursive: true });
	writeFileSync(join(dir, "01-a.html"), "<h1>one</h1>");
	writeFileSync(join(dir, "sub", "inner.html"), "<p>inner</p>");
	return { root, dir };
}

const FIXED = new Date("2026-10-28T10:00:00.000Z");
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const refused = (code: string) => (error: unknown) => error instanceof DesignHistoryError && error.code === code;
const indexPath = (dir: string) => join(dir, ".history", "index.json");
const readIndex = (dir: string) => JSON.parse(readFileSync(indexPath(dir), "utf8"));
const edit = (dir: string, text: string, file = "01-a.html") => writeFileSync(join(dir, file), text);

test("S1: the first time an artboard is seen its content is v1; nothing exists before", async (t) => {
	const { root, dir } = fixture(t);
	const store = createDesignHistoryStore(root, { now: () => FIXED });
	assert.deepEqual(await store.read("alpha"), { version: 1, artboards: {} });
	assert.equal(existsSync(join(dir, ".history")), false, "reading creates nothing");
	const seen = await store.observe("alpha", "01-a.html");
	assert.deepEqual(seen, { status: "created", version: { n: 1, createdAt: FIXED.toISOString(), source: "hand", sha256: sha("<h1>one</h1>") } });
	assert.equal(readFileSync(join(dir, ".history", "01-a.html", "1.html"), "utf8"), "<h1>one</h1>");
	assert.deepEqual(readIndex(dir), { version: 1, artboards: { "01-a.html": { versions: [seen.version] } } });
	assert.deepEqual(readdirSync(join(dir, ".history")).sort(), ["01-a.html", "index.json"], "no temp file is left behind");
	assert.deepEqual(readdirSync(join(dir, ".history", "01-a.html")), ["1.html"]);
});

test("S1: a changed artboard becomes the next version; identical content is never stored twice, also after A, B, A", async (t) => {
	const { root, dir } = fixture(t);
	const store = createDesignHistoryStore(root);
	await store.observe("alpha", "01-a.html");
	assert.deepEqual(await store.observe("alpha", "01-a.html"), { status: "unchanged" });
	edit(dir, "<h1>two</h1>");
	const two = await store.observe("alpha", "01-a.html");
	assert.equal(two.status === "created" && two.version.n, 2);
	assert.deepEqual(await store.observe("alpha", "01-a.html"), { status: "unchanged" });
	edit(dir, "<h1>one</h1>");
	const three = await store.observe("alpha", "01-a.html");
	assert.equal(three.status === "created" && three.version.n, 3, "the same as v1 but not as the latest: stored");
	assert.deepEqual((await store.read("alpha")).artboards["01-a.html"].versions.map((version) => version.n), [1, 2, 3]);
	assert.deepEqual(readdirSync(join(dir, ".history", "01-a.html")).sort(), ["1.html", "2.html", "3.html"]);
});

test("S1: artboards in folders have their own history, and observe tags an agent edit when asked", async (t) => {
	const { root, dir } = fixture(t);
	const store = createDesignHistoryStore(root);
	const inner = await store.observe("alpha", "sub/inner.html", { source: "agent" });
	assert.equal(inner.status === "created" && inner.version.source, "agent");
	assert.equal(readFileSync(join(dir, ".history", "sub", "inner.html", "1.html"), "utf8"), "<p>inner</p>");
	assert.deepEqual(Object.keys((await store.read("alpha")).artboards), ["sub/inner.html"]);
	await assert.rejects(store.observe("alpha", "01-a.html", { source: "restore" as never }), refused("invalid-input"));
});

test("S1: a missing artboard is not a version", async (t) => {
	const { root, dir } = fixture(t);
	const store = createDesignHistoryStore(root);
	assert.deepEqual(await store.observe("alpha", "gone.html"), { status: "missing" });
	assert.deepEqual(await store.observe("alpha", "nodir/gone.html"), { status: "missing" });
	assert.equal(existsSync(join(dir, ".history")), false);
});

test("S1: at most 50 versions are kept: the oldest are dropped with their files, the newest never, and n is never reused", async (t) => {
	const { root, dir } = fixture(t);
	const store = createDesignHistoryStore(root);
	assert.equal(MAX_DESIGN_VERSIONS, 50);
	for (let index = 1; index <= 53; index++) {
		edit(dir, `<h1>v${index}</h1>`);
		await store.observe("alpha", "01-a.html");
	}
	const { versions } = (await store.read("alpha")).artboards["01-a.html"];
	assert.equal(versions.length, 50);
	assert.deepEqual([versions[0].n, versions[49].n], [4, 53]);
	assert.equal(readFileSync(join(dir, ".history", "01-a.html", "53.html"), "utf8"), "<h1>v53</h1>", "the newest is kept");
	const files = readdirSync(join(dir, ".history", "01-a.html"));
	assert.equal(files.length, 50);
	assert.ok(!files.includes("1.html") && !files.includes("3.html") && files.includes("4.html"));
	edit(dir, "<h1>v54</h1>");
	const next = await store.observe("alpha", "01-a.html");
	assert.equal(next.status === "created" && next.version.n, 54);
	const small = createDesignHistoryStore(root, { maxVersions: 2 });
	await assert.rejects(small.read("alpha"), refused("invalid-file"), "an index with more versions than allowed is not trusted");
});

test("S1: a corrupt or invalid index is reported and left untouched", async (t) => {
	const { root, dir } = fixture(t);
	const store = createDesignHistoryStore(root);
	mkdirSync(join(dir, ".history"));
	const good = { n: 1, createdAt: FIXED.toISOString(), source: "hand", sha256: sha("x") };
	const bad = [
		"{ not json", "[]", JSON.stringify({ version: 2, artboards: {} }), JSON.stringify({ version: 1 }),
		JSON.stringify({ version: 1, artboards: { "../x.html": { versions: [good] } } }),
		JSON.stringify({ version: 1, artboards: { "a.txt": { versions: [good] } } }),
		JSON.stringify({ version: 1, artboards: { "a.html": { versions: [] } } }),
		JSON.stringify({ version: 1, artboards: { "a.html": { versions: [{ ...good, n: 0 }] } } }),
		JSON.stringify({ version: 1, artboards: { "a.html": { versions: [good, good] } } }),
		JSON.stringify({ version: 1, artboards: { "a.html": { versions: [{ ...good, source: "robot" }] } } }),
		JSON.stringify({ version: 1, artboards: { "a.html": { versions: [{ ...good, sha256: "abc" }] } } }),
		JSON.stringify({ version: 1, artboards: { "a.html": { versions: [{ ...good, comment: "../x" }] } } }),
		JSON.stringify({ version: 1, artboards: { "a.html": { versions: [{ ...good, note: "n".repeat(501) }] } } }),
	];
	for (const bytes of bad) {
		writeFileSync(indexPath(dir), bytes);
		await assert.rejects(store.read("alpha"), refused("invalid-file"), bytes);
		await assert.rejects(store.observe("alpha", "01-a.html"), refused("invalid-file"));
		await assert.rejects(store.restore("alpha", "01-a.html", 1), refused("invalid-file"));
		await assert.rejects(store.annotate("alpha", "01-a.html", 1, { note: "x" }), refused("invalid-file"));
		assert.equal(readFileSync(indexPath(dir), "utf8"), bytes, "bytes unchanged");
		assert.deepEqual(readdirSync(join(dir, ".history")), ["index.json"], "and nothing else written");
	}
	writeFileSync(indexPath(dir), JSON.stringify({ version: 1, artboards: { "a.html": { versions: [{ ...good, comment: "k3x9p2ab", note: "Shorter headline" }] } } }));
	assert.equal((await store.read("alpha")).artboards["a.html"].versions[0].note, "Shorter headline", "a valid index with optional fields reads");
});

test("S1: a symlinked .history, artboard folder, content file or index is refused and nothing is written through it", async (t) => {
	const { root, dir } = fixture(t);
	const store = createDesignHistoryStore(root);
	const outside = scratch(t, "gentle-design-history-outside-");
	symlinkSync(outside, join(dir, ".history"));
	await assert.rejects(store.observe("alpha", "01-a.html"), refused("invalid-file"));
	await assert.rejects(store.read("alpha"), refused("invalid-file"));
	assert.deepEqual(readdirSync(outside), []);
	rmSync(join(dir, ".history"));

	mkdirSync(join(dir, ".history"));
	symlinkSync(outside, join(dir, ".history", "01-a.html"));
	await assert.rejects(store.observe("alpha", "01-a.html"), refused("invalid-file"));
	assert.deepEqual(readdirSync(outside), []);
	rmSync(join(dir, ".history", "01-a.html"));

	await store.observe("alpha", "01-a.html");
	writeFileSync(join(outside, "secret.html"), "<p>secret</p>");
	rmSync(join(dir, ".history", "01-a.html", "1.html"));
	symlinkSync(join(outside, "secret.html"), join(dir, ".history", "01-a.html", "1.html"));
	await assert.rejects(store.readVersion("alpha", "01-a.html", 1), refused("invalid-file"), "a linked content file is never read");
	await assert.rejects(store.restore("alpha", "01-a.html", 1), refused("invalid-file"));
	assert.equal(readFileSync(join(dir, "01-a.html"), "utf8"), "<h1>one</h1>");
	rmSync(join(dir, ".history", "01-a.html", "1.html"));

	const index = readFileSync(indexPath(dir), "utf8");
	rmSync(indexPath(dir));
	writeFileSync(join(outside, "index.json"), index);
	symlinkSync(join(outside, "index.json"), indexPath(dir));
	await assert.rejects(store.read("alpha"), refused("invalid-file"));
	await assert.rejects(store.observe("alpha", "01-a.html"), refused("invalid-file"));
	assert.equal(readFileSync(join(outside, "index.json"), "utf8"), index, "the linked index is untouched");
});

test("S1: an artboard that is a link, or in a folder that is a link, is skipped for snapshots; nothing is stored", async (t) => {
	const { root, dir } = fixture(t);
	const store = createDesignHistoryStore(root);
	const outside = scratch(t, "gentle-design-history-outside-");
	writeFileSync(join(outside, "secret.html"), "<p>secret</p>");
	symlinkSync(join(outside, "secret.html"), join(dir, "evil.html"));
	assert.equal((await store.observe("alpha", "evil.html")).status, "skipped");
	symlinkSync(join(outside), join(dir, "linked"));
	assert.equal((await store.observe("alpha", "linked/secret.html")).status, "skipped");
	assert.equal(existsSync(join(dir, ".history")), false, "nothing was stored");
	// A link inside the design is refused too: restore must never write through it (see the restore tests).
	symlinkSync(join(dir, "01-a.html"), join(dir, "alias.html"));
	const alias = await store.observe("alpha", "alias.html");
	assert.equal(alias.status, "skipped");
	assert.match(alias.status === "skipped" ? alias.message : "", /alias\.html is a link/);
});

test("S1: file names must be artboard paths, and a slug outside the design root is not found", async (t) => {
	const { root, dir } = fixture(t);
	const store = createDesignHistoryStore(root);
	for (const file of ["../01-a.html", "/etc/passwd.html", "a.txt", ".history/index.json", ".hidden.html", "sub//x.html", "", 7]) {
		await assert.rejects(store.observe("alpha", file as string), refused("invalid-input"), String(file));
		await assert.rejects(store.restore("alpha", file as string, 1), refused("invalid-input"), String(file));
		assert.equal(await store.readVersion("alpha", file as string, 1).catch(() => "refused"), "refused");
	}
	for (const slug of ["Alpha", "../alpha", "", "missing"]) await assert.rejects(store.observe(slug, "01-a.html"), refused("not-found"), slug);
	assert.equal(existsSync(join(dir, ".history")), false);
});

test("S1: a file over the size limit is skipped with a warning and stores nothing; the limit is inclusive", async (t) => {
	const { root, dir } = fixture(t);
	assert.equal(MAX_DESIGN_VERSION_BYTES, 8 * 1024 * 1024, "stored versions are at most 8 MiB");
	const store = createDesignHistoryStore(root, { maxVersionBytes: 16 });
	edit(dir, "x".repeat(17));
	const skipped = await store.observe("alpha", "01-a.html");
	assert.equal(skipped.status, "skipped");
	assert.match(skipped.status === "skipped" ? skipped.message : "", /01-a\.html is larger than 16 bytes/);
	assert.equal(existsSync(join(dir, ".history")), false);
	edit(dir, "x".repeat(16));
	assert.equal((await store.observe("alpha", "01-a.html")).status, "created");
	edit(dir, "y".repeat(40));
	assert.equal((await store.observe("alpha", "01-a.html")).status, "skipped");
	assert.deepEqual((await store.read("alpha")).artboards["01-a.html"].versions.map((version) => version.n), [1], "the earlier version stays");
});

test("S1: concurrent observations of one change store it once", async (t) => {
	const { root, dir } = fixture(t);
	const store = createDesignHistoryStore(root);
	const results = await Promise.all(Array.from({ length: 8 }, () => store.observe("alpha", "01-a.html")));
	assert.equal(results.filter((result) => result.status === "created").length, 1);
	assert.equal(readIndex(dir).artboards["01-a.html"].versions.length, 1);
});

test("S4: restore saves the current content first, writes the version back and records a restore version", async (t) => {
	const { root, dir } = fixture(t);
	const store = createDesignHistoryStore(root);
	await store.observe("alpha", "01-a.html");
	edit(dir, "<h1>two</h1>");
	await store.observe("alpha", "01-a.html");
	edit(dir, "<h1>unsaved edit</h1>");
	const result = await store.restore("alpha", "01-a.html", 1);
	assert.equal(readFileSync(join(dir, "01-a.html"), "utf8"), "<h1>one</h1>");
	assert.equal(result.restoredFrom, 1);
	assert.equal(result.saved?.n, 3, "the content that was about to be lost");
	assert.equal(result.saved?.source, "hand");
	assert.equal(result.version?.n, 4);
	assert.equal(result.version?.source, "restore");
	const { versions } = (await store.read("alpha")).artboards["01-a.html"];
	assert.deepEqual(versions.map((version) => [version.n, version.source]), [[1, "hand"], [2, "hand"], [3, "hand"], [4, "restore"]]);
	assert.equal(readFileSync(join(dir, ".history", "01-a.html", "3.html"), "utf8"), "<h1>unsaved edit</h1>");
	assert.equal(readFileSync(join(dir, ".history", "01-a.html", "4.html"), "utf8"), "<h1>one</h1>");
	// The change event of the write finds the content already stored.
	assert.deepEqual(await store.observe("alpha", "01-a.html"), { status: "unchanged" });
	assert.deepEqual(readdirSync(dir).sort(), [".history", "01-a.html", "sub"], "no temp file is left behind");
});

test("S4: restoring when nothing changed since the latest version saves nothing extra; restoring the current content writes no version", async (t) => {
	const { root, dir } = fixture(t);
	const store = createDesignHistoryStore(root);
	await store.observe("alpha", "01-a.html");
	edit(dir, "<h1>two</h1>");
	await store.observe("alpha", "01-a.html");
	const result = await store.restore("alpha", "01-a.html", 1);
	assert.equal(result.saved, undefined, "v2 already holds the current content");
	assert.equal(result.version?.n, 3);
	const again = await store.restore("alpha", "01-a.html", 3);
	assert.deepEqual(again, { restoredFrom: 3 }, "the artboard already holds version 3");
	assert.equal((await store.read("alpha")).artboards["01-a.html"].versions.length, 3);
});

test("S4: a deleted artboard can be restored from its history", async (t) => {
	const { root, dir } = fixture(t);
	const store = createDesignHistoryStore(root);
	await store.observe("alpha", "01-a.html");
	edit(dir, "<h1>two</h1>");
	await store.observe("alpha", "01-a.html");
	rmSync(join(dir, "01-a.html"));
	const result = await store.restore("alpha", "01-a.html", 1);
	assert.equal(readFileSync(join(dir, "01-a.html"), "utf8"), "<h1>one</h1>");
	assert.equal(result.saved, undefined, "there is no content to save");
	assert.equal(result.version?.source, "restore");
});

test("S4: restore refuses unknown artboards and versions, damaged content and oversize current content, and changes nothing", async (t) => {
	const { root, dir } = fixture(t);
	const store = createDesignHistoryStore(root, { maxVersionBytes: 64 });
	await store.observe("alpha", "01-a.html");
	edit(dir, "<h1>two</h1>");
	await store.observe("alpha", "01-a.html");
	const snapshot = () => ({ index: readFileSync(indexPath(dir), "utf8"), page: readFileSync(join(dir, "01-a.html"), "utf8"), files: readdirSync(join(dir, ".history", "01-a.html")).sort() });
	const before = snapshot();
	await assert.rejects(store.restore("alpha", "01-a.html", 9), refused("not-found"));
	await assert.rejects(store.restore("alpha", "sub/inner.html", 1), refused("not-found"));
	for (const n of [0, -1, 1.5, "1", Number.NaN]) await assert.rejects(store.restore("alpha", "01-a.html", n as number), refused("invalid-input"), String(n));
	await assert.rejects(store.restore("missing", "01-a.html", 1), refused("not-found"));
	assert.deepEqual(snapshot(), before);

	writeFileSync(join(dir, ".history", "01-a.html", "1.html"), "<h1>tampered</h1>");
	await assert.rejects(store.restore("alpha", "01-a.html", 1), refused("invalid-file"), "content that no longer matches its hash");
	rmSync(join(dir, ".history", "01-a.html", "1.html"));
	await assert.rejects(store.restore("alpha", "01-a.html", 1), refused("invalid-file"), "missing content");
	assert.equal(readFileSync(join(dir, "01-a.html"), "utf8"), "<h1>two</h1>");

	edit(dir, "z".repeat(65));
	await assert.rejects(store.restore("alpha", "01-a.html", 2), refused("too-large"), "the content about to be replaced cannot be saved");
	assert.equal(readFileSync(join(dir, "01-a.html"), "utf8"), "z".repeat(65));
});

test("S1/S4: readVersion returns only versions the index lists", async (t) => {
	const { root, dir } = fixture(t);
	const store = createDesignHistoryStore(root);
	await store.observe("alpha", "01-a.html");
	const found = await store.readVersion("alpha", "01-a.html", 1);
	assert.equal(found?.data.toString("utf8"), "<h1>one</h1>");
	assert.equal(found?.version.n, 1);
	assert.equal(await store.readVersion("alpha", "01-a.html", 2), undefined);
	assert.equal(await store.readVersion("alpha", "sub/inner.html", 1), undefined);
	writeFileSync(join(dir, ".history", "01-a.html", "2.html"), "stray");
	assert.equal(await store.readVersion("alpha", "01-a.html", 2), undefined, "a file the index does not list is not served");
});

test("S1: annotate lets a later resolution tag a version as the agent's, with its comment and note", async (t) => {
	const { root, dir } = fixture(t);
	const store = createDesignHistoryStore(root);
	await store.observe("alpha", "01-a.html");
	edit(dir, "<h1>two</h1>");
	await store.observe("alpha", "01-a.html");
	const tagged = await store.annotate("alpha", "01-a.html", 2, { source: "agent", comment: "k3x9p2ab", note: "  Shortened the headline\r\n" });
	assert.deepEqual(tagged, { n: 2, createdAt: tagged.createdAt, source: "agent", comment: "k3x9p2ab", note: "Shortened the headline", sha256: sha("<h1>two</h1>") });
	assert.deepEqual((await store.read("alpha")).artboards["01-a.html"].versions[1], tagged);
	assert.equal((await store.read("alpha")).artboards["01-a.html"].versions[0].source, "hand");
	await store.restore("alpha", "01-a.html", 1);
	const restored = await store.annotate("alpha", "01-a.html", 3, { source: "agent" });
	assert.equal(restored.source, "restore", "a restore stays a restore");
	await assert.rejects(store.annotate("alpha", "01-a.html", 9, { note: "x" }), refused("not-found"));
	for (const patch of [{ source: "restore" }, { comment: "../x" }, { note: "n".repeat(501) }, { note: 4 }]) await assert.rejects(store.annotate("alpha", "01-a.html", 2, patch as never), refused("invalid-input"), JSON.stringify(patch));
	assert.equal(lstatSync(indexPath(dir)).isFile(), true);
});

test("S1: an artboard that does not exist yet in a folder that links out of the design is refused too", async (t) => {
	const { root, dir } = fixture(t);
	const store = createDesignHistoryStore(root);
	const outside = scratch(t, "gentle-design-history-outside-");
	symlinkSync(outside, join(dir, "linked"));
	assert.equal((await store.observe("alpha", "linked/new.html")).status, "skipped");
	// Restore must not write through that folder either, even with a hand-made index and content.
	mkdirSync(join(dir, ".history", "linked", "new.html"), { recursive: true });
	writeFileSync(join(dir, ".history", "linked", "new.html", "1.html"), "<p>planted</p>");
	writeFileSync(indexPath(dir), JSON.stringify({ version: 1, artboards: { "linked/new.html": { versions: [{ n: 1, createdAt: FIXED.toISOString(), source: "hand", sha256: sha("<p>planted</p>") }] } } }));
	await assert.rejects(store.restore("alpha", "linked/new.html", 1), refused("unsafe"));
	assert.deepEqual(readdirSync(outside), []);
});

test("S1/S4: files are replaced atomically (temp file + rename), never rewritten in place", async (t) => {
	const { root, dir } = fixture(t);
	const store = createDesignHistoryStore(root);
	await store.observe("alpha", "01-a.html");
	// A hard link keeps pointing at the old inode: an in-place write would change it, a rename leaves it alone.
	const alias = (path: string, name: string) => { const copy = join(dirname(dir), name); linkSync(path, copy); return copy; };
	const oldIndex = alias(indexPath(dir), "index.old");
	const oldIndexBytes = readFileSync(oldIndex, "utf8");
	edit(dir, "<h1>two</h1>");
	await store.observe("alpha", "01-a.html");
	assert.equal(readFileSync(oldIndex, "utf8"), oldIndexBytes, "the index was replaced, not rewritten");
	assert.notEqual(readFileSync(indexPath(dir), "utf8"), oldIndexBytes);
	const oldPage = alias(join(dir, "01-a.html"), "page.old");
	await store.restore("alpha", "01-a.html", 1);
	assert.equal(readFileSync(oldPage, "utf8"), "<h1>two</h1>", "the artboard was replaced, not rewritten");
	assert.equal(readFileSync(join(dir, "01-a.html"), "utf8"), "<h1>one</h1>");
	const oldContent = alias(join(dir, ".history", "01-a.html", "1.html"), "content.old");
	assert.equal(readFileSync(oldContent, "utf8"), "<h1>one</h1>");
	// A stored version is never rewritten: a restore of a stored version leaves its file's inode and bytes alone.
	await store.restore("alpha", "01-a.html", 2);
	assert.equal(readFileSync(oldContent, "utf8"), "<h1>one</h1>");
});

test("S1: when the index cannot be saved, the version content just written is taken back", { skip: process.getuid?.() === 0 }, async (t) => {
	const { root, dir } = fixture(t);
	const store = createDesignHistoryStore(root);
	await store.observe("alpha", "01-a.html");
	edit(dir, "<h1>two</h1>");
	chmodSync(join(dir, ".history"), 0o555);
	try {
		await assert.rejects(store.observe("alpha", "01-a.html"));
	} finally {
		chmodSync(join(dir, ".history"), 0o755);
	}
	assert.deepEqual(readdirSync(join(dir, ".history", "01-a.html")), ["1.html"], "no orphan 2.html");
	assert.equal(readIndex(dir).artboards["01-a.html"].versions.length, 1);
	assert.equal((await store.observe("alpha", "01-a.html")).status, "created", "and the change is picked up once saving works");
});

test("S1: a design holds history for at most 256 artboards; a new one is refused and the index stays as it was", async (t) => {
	const { root, dir } = fixture(t);
	const store = createDesignHistoryStore(root);
	const artboards = Object.fromEntries(Array.from({ length: 256 }, (_, index) => [`b${index}.html`, { versions: [{ n: 1, createdAt: FIXED.toISOString(), source: "hand", sha256: sha(`b${index}`) }] }]));
	mkdirSync(join(dir, ".history"));
	const bytes = JSON.stringify({ version: 1, artboards });
	writeFileSync(indexPath(dir), bytes);
	await assert.rejects(store.observe("alpha", "01-a.html"), refused("limit"));
	assert.equal(readFileSync(indexPath(dir), "utf8"), bytes);
	assert.equal(existsSync(join(dir, ".history", "01-a.html")), false, "and no content was written");
});

test("S1: a link planted where the next version file goes is replaced, never written through", async (t) => {
	const { root, dir } = fixture(t);
	const store = createDesignHistoryStore(root);
	const outside = scratch(t, "gentle-design-history-outside-");
	await store.observe("alpha", "01-a.html");
	writeFileSync(join(outside, "target.html"), "<p>precious</p>");
	symlinkSync(join(outside, "target.html"), join(dir, ".history", "01-a.html", "2.html"));
	edit(dir, "<h1>two</h1>");
	assert.equal((await store.observe("alpha", "01-a.html")).status, "created");
	assert.equal(readFileSync(join(outside, "target.html"), "utf8"), "<p>precious</p>");
	assert.equal(lstatSync(join(dir, ".history", "01-a.html", "2.html")).isFile(), true);
	assert.equal(readFileSync(join(dir, ".history", "01-a.html", "2.html"), "utf8"), "<h1>two</h1>");
});

// Verifier findings (L4).

test("S1/S4: restore never writes through an artboard that is a link, even to a file inside the design", async (t) => {
	const { root, dir } = fixture(t);
	const store = createDesignHistoryStore(root);
	writeFileSync(join(dir, "design.json"), '{"artboards":[]}');
	writeFileSync(join(dir, "comments.json"), '{"version":1,"comments":[]}\n');
	writeFileSync(join(dir, "02-b.html"), "<p>b</p>");
	await store.observe("alpha", "01-a.html");
	for (const target of ["design.json", "comments.json", "02-b.html"]) {
		rmSync(join(dir, "01-a.html"), { force: true });
		symlinkSync(target, join(dir, "01-a.html"));
		const before = readFileSync(join(dir, target));
		await store.restore("alpha", "01-a.html", 1).catch(() => {});
		assert.deepEqual(readFileSync(join(dir, target)), before, `${target} was written through the link`);
	}
});

test("S4: restore refuses a link artboard (inside or outside the design, or into .history) with a clear reason and writes nothing", async (t) => {
	const { root, dir } = fixture(t);
	const store = createDesignHistoryStore(root);
	const outside = scratch(t, "gentle-design-history-outside-");
	writeFileSync(join(outside, "secret.html"), "<p>outside</p>");
	await store.observe("alpha", "01-a.html");
	edit(dir, "<h1>two</h1>");
	await store.observe("alpha", "01-a.html");
	const targets = [join(outside, "secret.html"), "sub/inner.html", ".history/01-a.html/1.html", ".history/index.json", "01-a.html"];
	for (const target of targets) {
		rmSync(join(dir, "01-a.html"), { force: true });
		symlinkSync(target, join(dir, "01-a.html"));
		const watched = target.startsWith("/") ? join(outside, "secret.html") : join(dir, target);
		const index = readFileSync(indexPath(dir), "utf8");
		const before = target === "01-a.html" ? "" : readFileSync(watched);
		await assert.rejects(store.restore("alpha", "01-a.html", 1), (error: unknown) => error instanceof DesignHistoryError && error.code === "unsafe" && /01-a\.html is a link/.test(error.message), target);
		if (target !== "01-a.html") assert.deepEqual(readFileSync(watched), before, `${target} untouched`);
		assert.equal(readFileSync(indexPath(dir), "utf8"), index, "and the index too");
		assert.equal(lstatSync(join(dir, "01-a.html")).isSymbolicLink(), true, "the link itself is left as it was");
	}
});

test("S4: the artboard is replaced by renaming over its own path, so a link swapped in late is replaced, not followed", async (t) => {
	const { root, dir } = fixture(t);
	const store = createDesignHistoryStore(root);
	await store.observe("alpha", "01-a.html");
	edit(dir, "<h1>two</h1>");
	await store.observe("alpha", "01-a.html");
	await store.restore("alpha", "01-a.html", 1);
	assert.equal(lstatSync(join(dir, "01-a.html")).isFile(), true);
	assert.equal(readFileSync(join(dir, "01-a.html"), "utf8"), "<h1>one</h1>");
});

test("S1: an annotate that would push index.json past its read limit is refused and the index stays readable", async (t) => {
	const { root, dir } = fixture(t);
	const store = createDesignHistoryStore(root);
	await store.observe("alpha", "01-a.html");
	const doc = readIndex(dir);
	const hash = doc.artboards["01-a.html"].versions[0].sha256;
	for (let a = 0; a < 72; a++) doc.artboards[`x${a}.html`] = { versions: Array.from({ length: 50 }, (_, i) => ({ n: i + 1, createdAt: "2026-01-01T00:00:00.000Z", source: "hand", note: "é".repeat(500), sha256: hash })) };
	writeFileSync(join(dir, ".history", "index.json"), JSON.stringify(doc));
	await store.read("alpha");
	await store.annotate("alpha", "01-a.html", 1, { note: "y" }).catch(() => {});
	await store.read("alpha"); // must not throw "index.json is too large"
});

test("S1: an index that would be too big to read back is never written: the operation fails clearly and nothing changes", async (t) => {
	const { root, dir } = fixture(t);
	const store = createDesignHistoryStore(root);
	await store.observe("alpha", "01-a.html");
	const doc = readIndex(dir);
	const hash = doc.artboards["01-a.html"].versions[0].sha256;
	for (let a = 0; a < 72; a++) doc.artboards[`x${a}.html`] = { versions: Array.from({ length: 50 }, (_, i) => ({ n: i + 1, createdAt: "2026-01-01T00:00:00.000Z", source: "hand", note: "é".repeat(500), sha256: hash })) };
	const bytes = JSON.stringify(doc);
	writeFileSync(indexPath(dir), bytes);
	await assert.rejects(store.annotate("alpha", "01-a.html", 1, { note: "y" }), (error: unknown) => error instanceof DesignHistoryError && error.code === "limit" && /index\.json/.test(error.message));
	edit(dir, "<h1>two</h1>");
	await assert.rejects(store.observe("alpha", "01-a.html"), refused("limit"));
	assert.equal(readFileSync(indexPath(dir), "utf8"), bytes, "the index is as it was");
	assert.deepEqual(readdirSync(join(dir, ".history", "01-a.html")), ["1.html"], "and no version content was left behind");
	assert.deepEqual(readdirSync(join(dir, ".history")).filter((name) => name.endsWith(".tmp")), []);
	await store.read("alpha");
});

test("S4: restore keeps the artboard file's mode", { skip: process.platform === "win32" }, async (t) => {
	const { root, dir } = fixture(t);
	const store = createDesignHistoryStore(root);
	await store.observe("alpha", "01-a.html");
	edit(dir, "<h1>two</h1>");
	await store.observe("alpha", "01-a.html");
	chmodSync(join(dir, "01-a.html"), 0o600);
	await store.restore("alpha", "01-a.html", 1);
	assert.equal(readFileSync(join(dir, "01-a.html"), "utf8"), "<h1>one</h1>");
	assert.equal(statSync(join(dir, "01-a.html")).mode & 0o777, 0o600);
	chmodSync(join(dir, "01-a.html"), 0o664);
	await store.restore("alpha", "01-a.html", 2);
	assert.equal(statSync(join(dir, "01-a.html")).mode & 0o777, 0o664);
});

test("S1: a link artboard is skipped with a message that names it, while other artboards keep their history", async (t) => {
	const { root, dir } = fixture(t);
	const store = createDesignHistoryStore(root);
	symlinkSync("01-a.html", join(dir, "evil.html"));
	const skipped = await store.observe("alpha", "evil.html");
	assert.deepEqual(skipped.status === "skipped" ? skipped.reason : "", "unsafe");
	assert.match(skipped.status === "skipped" ? skipped.message : "", /evil\.html is a link or inside a linked folder, so its versions are not stored\./);
	assert.equal((await store.observe("alpha", "01-a.html")).status, "created");
});
