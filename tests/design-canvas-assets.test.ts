import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

// The canvas scripts run in the browser; these tests evaluate them in a minimal
// fake DOM so the focus-mode message contract is checked without a browser.

const ASSET_DIR = fileURLToPath(new URL("../assets/design-canvas/", import.meta.url));
const read = (name: string) => readFileSync(join(ASSET_DIR, name), "utf8");

type Listener = (event: any) => void;
// postMessage clones its message; the copy also leaves the vm realm's prototypes behind.
const structuredCopy = (message: unknown) => JSON.parse(JSON.stringify(message));
type Rect = { left: number; top: number; width: number; height: number };

class FakeElement {
	localName: string;
	id = "";
	children: FakeElement[] = [];
	// Back-references are non-enumerable (set in the constructor): a failing assert would otherwise print the whole document over and over.
	declare parentElement: FakeElement | null;
	attributes = new Map<string, string>();
	classes = new Set<string>();
	listeners = new Map<string, Listener[]>();
	style: Record<string, any> = { setProperty(name: string, value: string) { this[name] = value; } };
	dataset: Record<string, string> = {};
	textContent = "";
	title = "";
	hidden = false;
	disabled = false;
	inert = false;
	value = "";
	// Set by the canvas on iframes, the Open in new tab link and the Scale to fit checkbox.
	src = "";
	href = "";
	checked = false;
	// Set by the canvas on buttons and inputs.
	type = "";
	rect: Rect = { left: 0, top: 0, width: 0, height: 0 };
	contentWindow: { posted: any[]; postMessage(message: any): void } | null = null;
	declare doc: FakeDocument;

	constructor(tag: string, doc: FakeDocument) {
		Object.defineProperties(this, { parentElement: { value: null, writable: true }, doc: { value: doc, writable: true } });
		this.localName = tag;
		doc.all.push(this);
		if (tag === "iframe") {
			const posted: any[] = [];
			this.contentWindow = { posted, postMessage: (message) => posted.push(structuredCopy(message)) };
		}
	}

	get className() { return [...this.classes].join(" "); }
	set className(value: string) { this.classes = new Set(value.split(/\s+/).filter(Boolean)); }
	get classList() {
		const classes = this.classes;
		return {
			add: (name: string) => classes.add(name),
			remove: (name: string) => classes.delete(name),
			contains: (name: string) => classes.has(name),
			toggle: (name: string, force?: boolean) => {
				const on = force === undefined ? !classes.has(name) : force;
				if (on) classes.add(name);
				else classes.delete(name);
				return on;
			},
		};
	}

	// Layout offsets inside the offset parent; unlike rects, the world's transform never changes them.
	offsetLeft = 0;
	offsetTop = 0;
	get offsetWidth() { return 0; }
	get offsetHeight() { return 0; }
	setAttribute(name: string, value: unknown) {
		this.attributes.set(name, String(value));
		if (name === "class") this.className = String(value);
	}
	getAttribute(name: string) { return this.attributes.get(name) ?? null; }
	hasAttribute(name: string) { return this.attributes.has(name); }
	removeAttribute(name: string) { this.attributes.delete(name); }
	append(...nodes: FakeElement[]) {
		for (const node of nodes) {
			node.parentElement = this;
			this.children.push(node);
		}
	}
	replaceChildren(...nodes: FakeElement[]) {
		for (const child of this.children) child.parentElement = null;
		this.children = [];
		this.append(...nodes);
	}
	remove() {
		const parent = this.parentElement;
		if (!parent) return;
		parent.children = parent.children.filter((child) => child !== this);
		this.parentElement = null;
	}
	contains(node: FakeElement | null) {
		for (let current = node; current; current = current.parentElement) if (current === this) return true;
		return false;
	}
	matches(selector: string) {
		return selector.startsWith(".") ? this.classes.has(selector.slice(1)) : this.localName === selector;
	}
	closest(selector: string) {
		for (let current: FakeElement | null = this; current; current = current.parentElement) if (current.matches(selector)) return current;
		return null;
	}
	querySelector() { return null; }
	addEventListener(type: string, listener: Listener) {
		this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
	}
	/** Bubbles from this element through its ancestors, like a DOM event. */
	dispatch(type: string, init: Record<string, unknown> = {}) {
		const event: any = { type, target: this, defaultPrevented: false, ...init, preventDefault() { event.defaultPrevented = true; }, stopPropagation() {}, stopImmediatePropagation() {} };
		for (let current: FakeElement | null = this; current; current = current.parentElement) {
			for (const listener of current.listeners.get(type) ?? []) listener(event);
		}
		return event;
	}
	focus() { this.doc.activeElement = this; }
	getBoundingClientRect() { return this.rect; }
	setPointerCapture() {}
	scrollLeft = 0;
	scrollIntoView(_options?: unknown): unknown { return undefined; }
}

class FakeDocument {
	activeElement: FakeElement | null = null;
	body: FakeElement;
	documentElement: FakeElement;
	title = "";
	byId = new Map<string, FakeElement>();
	listeners = new Map<string, Listener[]>();
	// Every element ever created, so querySelectorAll can find the ones that carry a data attribute.
	all: FakeElement[] = [];

	constructor() {
		Object.defineProperty(this, "all", { enumerable: false });
		this.documentElement = new FakeElement("html", this);
		this.body = new FakeElement("body", this);
		this.documentElement.append(this.body);
		this.activeElement = this.body;
	}
	createElement(tag: string) { return new FakeElement(tag, this); }
	createElementNS(_namespace: string, tag: string) { return new FakeElement(tag, this); }
	getElementById(id: string) {
		let element = this.byId.get(id);
		if (!element) {
			element = new FakeElement(id === "gd-back" ? "button" : "div", this);
			element.id = id;
			this.byId.set(id, element);
		}
		return element;
	}
	addEventListener(type: string, listener: Listener) {
		this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
	}
	/** Only `[attribute]` selectors (the canvas's data-i18n lookups); anything else finds nothing. */
	querySelectorAll(selector: string) {
		const match = /^\[([\w-]+)\]$/.exec(selector);
		return match ? this.all.filter((element) => element.attributes.has(match[1])) : [];
	}
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * index.html is not parsed by the fake DOM. With `hydrate`, every element of index.html that carries a data-i18n attribute is
 * created (by id when it has one) with its attributes and its English text, so the canvas's language pass can find it.
 */
function hydrateStatic(document: FakeDocument) {
	const html = read("index.html").replace(/<script[^]*?<\/script>/g, "");
	for (const match of html.matchAll(/<([a-z0-9]+)\b((?:"[^"]*"|[^>"])*)>([^<]*)/g)) {
		const attributes = [...match[2].matchAll(/([\w:-]+)(?:="([^"]*)")?/g)].map((entry) => [entry[1], entry[2] ?? ""] as const);
		if (!attributes.some(([name]) => name.startsWith("data-i18n"))) continue;
		const id = attributes.find(([name]) => name === "id")?.[1];
		const element = id ? document.getElementById(id) : document.createElement(match[1]);
		Object.defineProperty(element, "hydrated", { value: true, enumerable: false });
		for (const [name, value] of attributes) {
			if (name === "title") element.title = value;
			else if (name !== "id" && name !== "class") element.setAttribute(name, value);
		}
		if (attributes.some(([name]) => name === "data-i18n")) element.textContent = match[3].trim();
	}
}

async function loadCanvas(firstHeight = 300, extraReplies: Record<string, unknown> = {}, config: Record<string, unknown> = {}, extraContext: Record<string, unknown> = {}, options: { hydrate?: boolean; script?: string } = {}) {
	const document = new FakeDocument();
	if (options.hydrate) hydrateStatic(document);
	document.getElementById("gd-config").textContent = JSON.stringify({ base: "/t/", slug: "alpha", ...config });
	// Hidden in index.html until a delivery problem is shown.
	for (const id of ["gd-send-note", "gd-send-alert", "gd-inspector", "gd-history", "gd-versions"]) document.getElementById(id).hidden = true;
	// index.html nests the inspector panel's parts; the fake DOM does not parse it, so nest them here.
	const inspectorPanel = document.getElementById("gd-inspector");
	for (const id of ["gd-inspector-title", "gd-inspector-selector", "gd-inspector-list", "gd-inspector-note", "gd-inspector-fix", "gd-inspector-copy"]) inspectorPanel.append(document.getElementById(id));
	// The version comparison overlay nests its bar and stage the same way.
	const versionsPanel = document.getElementById("gd-versions");
	for (const id of ["gd-versions-title", "gd-versions-mode-slider", "gd-versions-mode-side", "gd-versions-close", "gd-versions-stage"]) versionsPanel.append(document.getElementById(id));
	const viewport = document.getElementById("gd-viewport");
	const world = document.getElementById("gd-world");
	viewport.append(world);
	viewport.rect = { left: 0, top: 50, width: 1000, height: 700 };
	const windowListeners = new Map<string, Listener[]>();
	const replies: Record<string, unknown> = {
		"/t/api/system": { exists: false },
		"/t/api/designs": { designs: [{ slug: "alpha", title: "Alpha", valid: true }] },
		"/t/api/designs/alpha": {
			slug: "alpha",
			title: "Alpha",
			brief: "",
			artboards: [
				{ file: "01-a.html", title: "First", tradeoff: "", width: 400, height: firstHeight },
				{ file: "02-b.html", title: "Second", tradeoff: "", width: 400, height: 300 },
			],
		},
		"/t/api/designs/alpha/comments": { comments: [] },
		"/t/api/designs/alpha/handoffs": { version: 1, chosen: null, handoffs: {} },
		"/t/api/designs/beta": {
			slug: "beta",
			title: "Beta",
			brief: "",
			artboards: [{ file: "01-only.html", title: "Only", tradeoff: "", width: 500, height: 400 }],
		},
		"/t/api/designs/beta/comments": { comments: [] },
		"/t/api/designs/beta/handoffs": { version: 1, chosen: null, handoffs: {} },
		...extraReplies,
	};
	const fetched: string[] = [];
	const posts: Array<{ url: string; body: unknown }> = [];
	const urls: string[] = [];
	const sourceListeners = new Map<string, Listener[]>();
	const context: Record<string, any> = {
		document,
		console,
		// Canvas timers (toasts, the preview load timeout) must not keep the test process alive.
		setTimeout: (callback: () => void, ms?: number) => { const timer = setTimeout(callback, ms); timer.unref(); return timer; },
		clearTimeout,
		location: { port: "4100", origin: "http://127.0.0.1:4100" },
		URL,
		innerWidth: 1200,
		innerHeight: 800,
		CSS: { escape: (value: string) => value },
		history: { replaceState(_state: unknown, _title: string, url: string) { urls.push(url); } },
		localStorage: { getItem: () => null, setItem() {} },
		requestAnimationFrame: (callback: () => void) => { callback(); return 0; },
		fetch: async (url: string, init?: { method?: string; body?: string }) => {
			if (init?.method === "POST") posts.push({ url, body: JSON.parse(init.body ?? "null") });
			fetched.push(url);
			// `__throw` makes the request itself fail; `__http` sets the status of the reply.
			const reply = replies[url] as Record<string, unknown> | undefined;
			if (reply && "__throw" in reply) throw new TypeError(String(reply.__throw));
			const status = reply && typeof reply.__http === "number" ? reply.__http : url in replies ? 200 : 404;
			return { ok: status < 400, status, json: async () => reply ?? {}, text: async () => String(reply?.__text ?? "") };
		},
		EventSource: class {
			addEventListener(type: string, listener: Listener) {
				sourceListeners.set(type, [...(sourceListeners.get(type) ?? []), listener]);
			}
		},
		addEventListener(type: string, listener: Listener) {
			windowListeners.set(type, [...(windowListeners.get(type) ?? []), listener]);
		},
		...extraContext,
	};
	context.window = context;
	vm.runInNewContext(options.script ?? read("canvas.js"), context);
	for (let i = 0; i < 10; i++) await flush();
	const boards = world.children.map((wrapper) => {
		const box = wrapper.children.find((child) => child.classes.has("gd-frame-box"))!;
		const frame = box.children.find((child) => child.localName === "iframe")!;
		const shield = box.children.find((child) => child.classes.has("gd-shield"));
		return { wrapper, frame, shield };
	});
	const message = (source: unknown, data: unknown) => {
		for (const listener of windowListeners.get("message") ?? []) listener({ source, data });
	};
	const windowEvent = (type: string) => {
		for (const listener of windowListeners.get(type) ?? []) listener({ type });
	};
	/** A server-sent event on the canvas's live-reload stream, then the async work it starts. */
	const serverEvent = async (type: string, data: unknown) => {
		for (const listener of sourceListeners.get(type) ?? []) listener({ type, data: JSON.stringify(data) });
		for (let i = 0; i < 10; i++) await flush();
	};
	const frames = () => world.children.map((wrapper) => wrapper.children.find((child) => child.classes.has("gd-frame-box"))!.children.find((child) => child.localName === "iframe")!);
	return { document, viewport, world, boards, message, windowEvent, serverEvent, frames, fetched, posts, urls, replies, zoomLevel: document.getElementById("gd-zoom-level"), navMode: document.getElementById("gd-nav-mode") };
}

function click(target: FakeElement, x: number, y: number) {
	target.dispatch("pointerdown", { button: 0, pointerId: 1, clientX: x, clientY: y });
	target.dispatch("pointerup", { button: 0, pointerId: 1, clientX: x, clientY: y });
}

test("a click on an artboard's shield enters focus mode at 100% and only that artboard can end it", async () => {
	const canvas = await loadCanvas();
	assert.equal(canvas.boards.length, 2);
	const [first, second] = canvas.boards;
	assert.ok(first.shield && second.shield, "every artboard has an interaction shield");
	assert.equal(canvas.navMode.textContent, "Navigating");

	// Start from a non-default view so restoring it is observable.
	canvas.viewport.dispatch("wheel", { deltaX: 0, deltaY: 40, deltaMode: 0, ctrlKey: true, metaKey: false, shiftKey: false, clientX: 300, clientY: 300 });
	canvas.viewport.dispatch("wheel", { deltaX: 30, deltaY: 20, deltaMode: 0, ctrlKey: false, metaKey: false, shiftKey: false, clientX: 300, clientY: 300 });
	const before = canvas.world.style.transform;
	const zoomBefore = canvas.zoomLevel.textContent;
	assert.notEqual(zoomBefore, "100%");

	first.frame.rect = { left: 120, top: 140, width: 268, height: 201 };
	click(first.shield!, 200, 200);
	assert.equal(canvas.zoomLevel.textContent, "100%");
	assert.match(canvas.world.style.transform, /scale\(1\)$/);
	assert.equal(first.shield!.hidden, true, "the focused artboard loses its shield");
	assert.equal(second.shield!.hidden, false);
	assert.equal(second.wrapper.inert, true, "the other artboards are inert");
	assert.equal(canvas.document.activeElement, first.frame, "keyboard focus moves into the artboard");
	assert.match(canvas.navMode.textContent, /^Using: First · Shift\+Esc to exit$/);
	assert.deepEqual(first.frame.contentWindow!.posted.at(-1), { type: "gd:focus", enabled: true });

	// Canvas pan and zoom are off while focused.
	const focusedTransform = canvas.world.style.transform;
	canvas.viewport.dispatch("wheel", { deltaX: 0, deltaY: 80, deltaMode: 0, ctrlKey: false, metaKey: false, shiftKey: false, clientX: 10, clientY: 10 });
	canvas.message(first.frame.contentWindow, { type: "gd:wheel", deltaX: 0, deltaY: 80, deltaMode: 0, zoom: true, shift: false, x: 5, y: 5 });
	assert.equal(canvas.world.style.transform, focusedTransform);

	// gd:exit-focus is accepted only from the focused artboard's own window.
	canvas.message(second.frame.contentWindow, { type: "gd:exit-focus" });
	canvas.message({}, { type: "gd:exit-focus" });
	assert.equal(canvas.zoomLevel.textContent, "100%");
	canvas.message(first.frame.contentWindow, { type: "gd:exit-focus" });
	assert.equal(canvas.world.style.transform, before, "the previous zoom and pan return exactly");
	assert.equal(canvas.zoomLevel.textContent, zoomBefore);
	assert.equal(first.shield!.hidden, false);
	assert.equal(second.wrapper.inert, false);
	assert.equal(canvas.navMode.textContent, "Navigating");
});

test("a taller artboard is top-aligned and clipped to the viewport while focused, then restored", async () => {
	const canvas = await loadCanvas(1600);
	const [first] = canvas.boards;
	assert.equal(first.frame.style.height, "1600px");
	// In world coordinates the frame box sits at (480, 20), under a 20 px label.
	first.frame.parentElement!.offsetLeft = 480;
	first.frame.parentElement!.offsetTop = 20;
	click(first.shield!, 200, 200);
	// The 700 px viewport keeps a 16 px margin, the 20 px label and a 64 px band for the Back button.
	assert.equal(first.frame.style.height, "600px");
	// x centers the 400 px board in 1000 px: 300 - 480; y puts its top 16 + 20 px down: 36 - 20.
	assert.equal(canvas.world.style.transform, "translate(-180px, 16px) scale(1)");
	// Re-centering (window resize, panel toggle) is idempotent.
	canvas.windowEvent("resize");
	assert.equal(canvas.world.style.transform, "translate(-180px, 16px) scale(1)");
	canvas.document.getElementById("gd-back").dispatch("click");
	assert.equal(first.frame.style.height, "1600px");
});

test("entering focus hides an open panel and exiting restores it; a closed panel stays closed", async () => {
	const canvas = await loadCanvas();
	const [first] = canvas.boards;
	const panel = canvas.document.getElementById("gd-panel");
	const toggle = canvas.document.getElementById("gd-panel-toggle");
	assert.equal(panel.hidden, false);
	click(first.shield!, 200, 200);
	assert.equal(panel.hidden, true, "focus mode hides the open panel to gain width");
	assert.equal(toggle.getAttribute("aria-pressed"), "false");
	canvas.message(first.frame.contentWindow, { type: "gd:exit-focus" });
	assert.equal(panel.hidden, false, "exiting reopens it");
	assert.equal(toggle.getAttribute("aria-pressed"), "true");

	toggle.dispatch("click");
	assert.equal(panel.hidden, true);
	click(first.shield!, 200, 200);
	assert.equal(panel.hidden, true);
	canvas.document.getElementById("gd-back").dispatch("click");
	assert.equal(panel.hidden, true, "a closed panel stays closed");
	assert.equal(toggle.getAttribute("aria-pressed"), "false");
});

test("the Back to canvas button and Shift+Esc in the canvas both leave focus mode", async () => {
	const canvas = await loadCanvas();
	const [first] = canvas.boards;
	const back = canvas.document.getElementById("gd-back");
	assert.equal(back.hidden, true);
	click(first.shield!, 200, 200);
	assert.equal(back.hidden, false);
	back.dispatch("click");
	assert.equal(canvas.navMode.textContent, "Navigating");
	assert.equal(back.hidden, true);

	click(first.shield!, 200, 200);
	const keydown = canvas.document.listeners.get("keydown") ?? [];
	const plain: any = { key: "Escape", shiftKey: false, target: back, defaultPrevented: false, preventDefault() { plain.defaultPrevented = true; } };
	keydown.forEach((listener) => listener(plain));
	assert.match(canvas.navMode.textContent, /^Using:/, "plain Esc does not leave focus mode");
	const chord: any = { key: "Escape", shiftKey: true, target: back, defaultPrevented: false, preventDefault() { chord.defaultPrevented = true; } };
	keydown.forEach((listener) => listener(chord));
	assert.equal(canvas.navMode.textContent, "Navigating");
});

test("a drag over an artboard pans the canvas, and in comment mode a click opens the artboard in focus instead of picking", async () => {
	const canvas = await loadCanvas();
	const [first] = canvas.boards;
	first.frame.rect = { left: 100, top: 100, width: 200, height: 150 };
	const before = canvas.world.style.transform;
	first.shield!.dispatch("pointerdown", { button: 0, pointerId: 1, clientX: 150, clientY: 150 });
	first.shield!.dispatch("pointermove", { pointerId: 1, clientX: 190, clientY: 170 });
	first.shield!.dispatch("pointerup", { button: 0, pointerId: 1, clientX: 190, clientY: 170 });
	assert.notEqual(canvas.world.style.transform, before, "the drag panned");
	assert.equal(canvas.navMode.textContent, "Navigating", "a drag never enters focus mode");

	canvas.document.getElementById("gd-comment").dispatch("click");
	click(first.shield!, 150, 130);
	// canvas-ux-quick-wins S1: in the overview a click opens the direction; the element is picked inside it.
	assert.equal(canvas.navMode.textContent, "Using: First · Shift+Esc to exit", "comment mode focuses instead of picking");
	assert.ok(!first.frame.contentWindow!.posted.some((message) => message.type === "gd:pick-at"));
});

// S14: `open` while a canvas page is connected sends it a show event instead of opening a tab.

test("a show event for the same design re-fetches its manifest and reloads its artboards, keeping zoom, pan and focus", async () => {
	const canvas = await loadCanvas();
	// A laid-out world, so a fit() during the refresh would visibly change the view.
	Object.defineProperty(canvas.world, "offsetWidth", { get: () => 2000 });
	Object.defineProperty(canvas.world, "offsetHeight", { get: () => 900 });
	canvas.viewport.dispatch("wheel", { deltaX: 0, deltaY: 40, deltaMode: 0, ctrlKey: true, metaKey: false, shiftKey: false, clientX: 300, clientY: 300 });
	const view = canvas.world.style.transform;
	const zoom = canvas.zoomLevel.textContent;
	const before = canvas.frames();
	const manifestFetches = canvas.fetched.filter((url) => url === "/t/api/designs/alpha").length;
	// A file written while the page missed the change event: the refresh must still pick it up.
	(canvas.replies["/t/api/designs/alpha"] as { artboards: unknown[] }).artboards.push({ file: "03-c.html", title: "Third", tradeoff: "", width: 400, height: 300 });
	await canvas.serverEvent("show", { slug: "alpha" });
	assert.equal(canvas.fetched.filter((url) => url === "/t/api/designs/alpha").length, manifestFetches + 1, "the manifest is fetched again");
	const after = canvas.frames();
	assert.equal(after.length, 3, "the new artboard appears");
	assert.ok(after.every((frame) => !before.includes(frame)), "every artboard is reloaded");
	assert.equal(canvas.world.style.transform, view, "pan and zoom stay");
	assert.equal(canvas.zoomLevel.textContent, zoom);
	assert.equal(canvas.urls.at(-1), "/t/d/alpha/");

	// Focus mode survives a refresh of the same design, on the same artboard.
	const shield = canvas.frames()[0].parentElement!.children.find((child) => child.classes.has("gd-shield"))!;
	click(shield, 200, 200);
	assert.match(canvas.navMode.textContent, /^Using: First/);
	await canvas.serverEvent("show", { slug: "alpha" });
	assert.match(canvas.navMode.textContent, /^Using: First/, "focus stays on the same artboard");
	assert.equal(canvas.zoomLevel.textContent, "100%");
});

test("a show event for another design leaves focus, loads that design and replaces the URL", async () => {
	const canvas = await loadCanvas();
	const [first] = canvas.boards;
	click(first.shield!, 200, 200);
	assert.match(canvas.navMode.textContent, /^Using:/);
	await canvas.serverEvent("show", { slug: "beta" });
	assert.ok(canvas.fetched.includes("/t/api/designs/beta"), "the other design's manifest is loaded");
	assert.ok(canvas.fetched.includes("/t/api/designs/beta/comments"), "and its comments");
	assert.equal(canvas.urls.at(-1), "/t/d/beta/");
	assert.equal(canvas.document.title, "Beta · Gentle Design", "the design's title moves to the tab title; the breadcrumb keeps Gentle Design");
	assert.equal(canvas.document.getElementById("gd-design").value, "beta", "the design selector follows");
	assert.equal(canvas.navMode.textContent, "Navigating", "focus mode ends when the design changes");
	assert.deepEqual(canvas.frames().map((frame) => frame.title), ["Only artboard"]);

	await canvas.serverEvent("show", { slug: null });
	assert.equal(canvas.urls.at(-1), "/t/", "null shows the system-only view at the root URL");
	assert.equal(canvas.document.title, "Gentle Design");
	assert.deepEqual(canvas.frames(), []);

	const fetches = canvas.fetched.length;
	for (const data of [{ slug: 3 }, {}, "beta", { slug: "../x" }]) await canvas.serverEvent("show", data);
	assert.equal(canvas.fetched.length, fetches, "a malformed show event is ignored");
});

function loadInspector() {
	const posted: any[] = [];
	// requestAnimationFrame callbacks wait here until a test runs them.
	const frames: Array<() => void> = [];
	// setTimeout callbacks wait here too, with the delay they asked for.
	const timeouts: Array<{ run: () => void; ms: number }> = [];
	const listeners = new Map<string, Listener[]>();
	class Element {}
	const style = () => ({ cursor: "" });
	const makeNode = () => Object.assign(new Element(), {
		style: style(),
		isConnected: false,
		setAttribute() {},
		hasAttribute: () => false,
		getBoundingClientRect: () => ({ left: 0, top: 0, width: 10, height: 10 }),
	});
	const button = Object.assign(new Element(), {
		id: "cta",
		localName: "button",
		innerText: "Buy now",
		parentElement: null,
		hasAttribute: () => false,
		getAttribute: () => null,
		getBoundingClientRect: () => ({ left: 4, top: 8, width: 60, height: 20 }),
	});
	const scrolling = { scrollTop: 0, scrollLeft: 0, clientHeight: 100, scrollHeight: 100, clientWidth: 100, scrollWidth: 100, parentElement: null };
	const documentElement = Object.assign(makeNode(), { append() {} });
	const document = {
		documentElement,
		body: makeNode(),
		scrollingElement: scrolling,
		createElement: makeNode,
		elementFromPoint: () => button,
		querySelectorAll: (selector: string) => (selector === "#cta" ? [button] : []),
		querySelector: () => null,
	};
	const parent = { postMessage: (message: any) => posted.push(structuredCopy(message)) };
	const context: Record<string, any> = {
		document,
		Element,
		CSS: { escape: (value: string) => value },
		getComputedStyle: () => ({ overflowX: "hidden", overflowY: "hidden" }),
		requestAnimationFrame: (callback: () => void) => frames.push(callback),
		setTimeout: (run: () => void, ms = 0) => timeouts.push({ run, ms }),
		clearTimeout: (id: number) => { if (id > 0 && id <= timeouts.length) timeouts[id - 1] = { run: () => {}, ms: 0 }; },
		MutationObserver: class { observe() {} },
		innerWidth: 400,
		parent,
		addEventListener(type: string, listener: Listener) {
			listeners.set(type, [...(listeners.get(type) ?? []), listener]);
		},
	};
	context.window = context;
	vm.runInNewContext(read("inspector.js"), context);
	const fire = (type: string, init: Record<string, unknown>) => {
		const event: any = { defaultPrevented: false, propagationStopped: false, ...init, preventDefault() { event.defaultPrevented = true; }, stopPropagation() { event.propagationStopped = true; }, stopImmediatePropagation() { event.propagationStopped = true; } };
		for (const listener of listeners.get(type) ?? []) listener(event);
		return event;
	};
	const fromParent = (data: unknown) => fire("message", { source: parent, data });
	const runFrames = () => { while (frames.length > 0) frames.shift()!(); };
	const runTimeouts = () => { while (timeouts.length > 0) timeouts.shift()!.run(); runFrames(); };
	return { posted, fire, fromParent, document, context, runFrames, runTimeouts, timeouts, button, Element };
}

test("the inspector posts gd:exit-focus on Shift+Esc and keeps plain Esc for the design", () => {
	const inspector = loadInspector();
	const plain = inspector.fire("keydown", { key: "Escape", shiftKey: false });
	assert.deepEqual(inspector.posted, []);
	assert.equal(plain.defaultPrevented, false);
	const chord = inspector.fire("keydown", { key: "Escape", shiftKey: true });
	assert.deepEqual(inspector.posted, [{ type: "gd:exit-focus" }]);
	assert.equal(chord.defaultPrevented, true);
	inspector.fire("keydown", { key: "Enter", shiftKey: true });
	assert.equal(inspector.posted.length, 1);
});

test("the inspector picks the element under a routed point only in comment mode", () => {
	const inspector = loadInspector();
	inspector.fromParent({ type: "gd:pick-at", x: 10, y: 12 });
	assert.deepEqual(inspector.posted, [], "no pick outside comment mode");
	inspector.fromParent({ type: "gd:mode", enabled: true });
	inspector.fromParent({ type: "gd:pick-at", x: 10, y: 12 });
	assert.deepEqual(inspector.posted, [{ type: "gd:pick", selector: "#cta", excerpt: "Buy now", rect: { x: 4, y: 8, width: 60, height: 20 } }]);
	inspector.fromParent({ type: "gd:pick-at", x: "10", y: 12 });
	assert.equal(inspector.posted.length, 1, "non-numeric points are ignored");
});

test("in focus mode the inspector leaves the wheel to the artboard and never pans the canvas", () => {
	const inspector = loadInspector();
	const wheel = { deltaX: 0, deltaY: 50, deltaMode: 0, shiftKey: false, clientX: 1, clientY: 1, target: null };
	const unfocused = inspector.fire("wheel", { ...wheel, ctrlKey: false, metaKey: false });
	assert.equal(unfocused.defaultPrevented, true);
	assert.equal(inspector.posted.at(-1).type, "gd:wheel");
	inspector.posted.length = 0;
	inspector.fromParent({ type: "gd:focus", enabled: true });
	const plain = inspector.fire("wheel", { ...wheel, ctrlKey: false, metaKey: false });
	assert.equal(plain.defaultPrevented, false, "the artboard scrolls natively");
	const zoom = inspector.fire("wheel", { ...wheel, ctrlKey: true, metaKey: false });
	assert.equal(zoom.defaultPrevented, true, "Ctrl/Cmd+wheel never zooms the browser page");
	assert.deepEqual(inspector.posted, []);
});

test("canvas assets keep the sandbox, the source check and no remote URLs", () => {
	const canvas = read("canvas.js");
	assert.match(canvas, /frame\.setAttribute\("sandbox", "allow-scripts"\)/);
	assert.match(canvas, /candidate\.frame\.contentWindow === event\.source/);
	// Only the Compare preview of the running app (another loopback origin) may keep its own origin.
	assert.equal(canvas.split("allow-same-origin").length - 1, 1);
	assert.match(canvas, /const PREVIEW_SANDBOX = "allow-scripts allow-same-origin allow-forms allow-popups";/);
	for (const name of ["index.html", "canvas.css", "canvas.js", "inspector.js"]) {
		const source = read(name);
		assert.ok(!source.includes("allow-top-navigation"), `${name} must not grant top navigation`);
		if (name !== "canvas.js") assert.ok(!source.includes("allow-same-origin"), `${name} must not grant allow-same-origin`);
		assert.ok(!/https?:\/\//i.test(source), `${name} must not reference remote URLs`);
		assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML/.test(source), `${name} must not parse HTML strings`);
	}
	const html = read("index.html");
	assert.match(html, /id="gd-back"[^>]*>Back to canvas</);
	assert.match(html, /id="gd-nav-mode"[^>]*>Navigating</);
});

// S15: handoff badges, the chosen artboard, and Compare.

/** Every element under `root` (itself included) that matches `test`. */
function findAll(root: FakeElement, test: (element: FakeElement) => boolean): FakeElement[] {
	const found: FakeElement[] = test(root) ? [root] : [];
	for (const child of root.children) found.push(...findAll(child, test));
	return found;
}

const withClass = (root: FakeElement, name: string) => findAll(root, (element) => element.classes.has(name));
const texts = (root: FakeElement, name: string) => withClass(root, name).map((element) => element.textContent);

function handoffDoc(chosen: string | null, handoffs: Record<string, Record<string, unknown>>) {
	const entries = Object.fromEntries(Object.entries(handoffs).map(([file, entry]) => [file, { status: "sent", queued: false, sentAt: "2026-10-26T10:00:00.000Z", startedAt: null, implementedAt: null, ...entry }]));
	return { version: 1, chosen, handoffs: entries };
}

async function setHandoffs(canvas: Awaited<ReturnType<typeof loadCanvas>>, document: unknown) {
	canvas.replies["/t/api/designs/alpha/handoffs"] = document;
	await canvas.serverEvent("change", { slug: "alpha", file: "handoffs.json" });
}

const boardsOf = (canvas: Awaited<ReturnType<typeof loadCanvas>>) => canvas.world.children;

test("the handoff badge follows the state live, and shows the linked feature document", async () => {
	const canvas = await loadCanvas(300, { "/t/api/designs/alpha/handoffs": handoffDoc("01-a.html", { "01-a.html": { queued: true, feature: "odd/tasks/login.md" } }) });
	const [first, second] = boardsOf(canvas);
	assert.deepEqual(texts(first, "gd-handoff-badge"), ["Queued"]);
	assert.deepEqual(texts(first, "gd-handoff-feature"), ["odd/tasks/login.md"]);
	assert.deepEqual(texts(second, "gd-handoff-badge"), [], "an artboard never handed off has no badge");
	const states: Array<[Record<string, unknown>, string]> = [
		[{ queued: false }, "Implementing…"],
		[{ status: "in_progress", startedAt: "2026-10-26T10:01:00.000Z" }, "In progress"],
		[{ status: "implemented", implementedAt: "2026-10-26T10:02:00.000Z", note: "Done with the header" }, "Implemented ✓"],
	];
	for (const [entry, label] of states) {
		await setHandoffs(canvas, handoffDoc("01-a.html", { "01-a.html": { feature: "odd/tasks/login.md", ...entry } }));
		assert.deepEqual(texts(boardsOf(canvas)[0], "gd-handoff-badge"), [label], label);
	}
	assert.deepEqual(texts(boardsOf(canvas)[0], "gd-handoff-note"), ["Done with the header"]);
	assert.ok(canvas.fetched.filter((url) => url === "/t/api/designs/alpha/handoffs").length >= 4, "every handoffs.json change is fetched");
	assert.equal(boardsOf(canvas)[0], first, "a handoffs.json change does not reload the artboards");
});

test("the chosen artboard gets a Chosen badge and an accent frame; the others are labeled Discarded", async () => {
	const canvas = await loadCanvas(300, { "/t/api/designs/alpha/handoffs": handoffDoc(null, {}) });
	for (const board of boardsOf(canvas)) {
		assert.deepEqual(texts(board, "gd-choice"), [], "nothing is chosen yet");
		assert.equal(board.classes.has("gd-chosen"), false);
	}
	await setHandoffs(canvas, handoffDoc("02-b.html", { "02-b.html": {} }));
	const [first, second] = boardsOf(canvas);
	assert.deepEqual(texts(second, "gd-choice"), ["Chosen"]);
	assert.equal(second.classes.has("gd-chosen"), true);
	assert.deepEqual(texts(first, "gd-choice"), ["Discarded"]);
	assert.equal(first.classes.has("gd-chosen"), false);
	await setHandoffs(canvas, handoffDoc("01-a.html", { "02-b.html": {}, "01-a.html": {} }));
	assert.deepEqual(boardsOf(canvas).map((board) => texts(board, "gd-choice")[0]), ["Chosen", "Discarded"], "a new handoff moves Chosen");
});

test("Compare appears only on an implemented artboard with a loopback previewUrl other than the canvas", async () => {
	const canvas = await loadCanvas();
	const compareButtons = () => boardsOf(canvas).map((board) => withClass(board, "gd-compare-start").length);
	const cases: Array<[Record<string, unknown>, number]> = [
		[{ status: "implemented" }, 0],
		[{ status: "in_progress", previewUrl: "http://localhost:3000/" }, 0],
		[{ status: "implemented", previewUrl: "http://example.com/" }, 0],
		[{ status: "implemented", previewUrl: "http://localhost:4100/" }, 0],
		[{ status: "implemented", previewUrl: "javascript:alert(1)" }, 0],
		[{ status: "implemented", previewUrl: "http://localhost:3000/" }, 1],
		[{ status: "implemented", previewUrl: "http://[::1]:3000/" }, 1],
	];
	for (const [entry, count] of cases) {
		await setHandoffs(canvas, handoffDoc("01-a.html", { "01-a.html": entry }));
		assert.deepEqual(compareButtons(), [count, 0], JSON.stringify(entry));
	}
});

test("Compare shows the artboard and the sandboxed app side by side at the artboard size, and Shift+Esc or Back exits", async () => {
	const canvas = await loadCanvas(300, { "/t/api/designs/alpha/handoffs": handoffDoc("01-a.html", { "01-a.html": { status: "implemented", previewUrl: "http://localhost:5173/login" } }) });
	const overlay = canvas.document.getElementById("gd-compare");
	const panes = canvas.document.getElementById("gd-compare-panes");
	const open = () => withClass(boardsOf(canvas)[0], "gd-compare-start")[0].dispatch("click");
	open();
	assert.equal(overlay.hidden, false);
	const frames = findAll(panes, (element) => element.localName === "iframe");
	assert.equal(frames.length, 2);
	const [artboard, preview] = frames;
	assert.equal(artboard.getAttribute("sandbox"), "allow-scripts", "the artboard stays sandboxed as on the canvas");
	assert.equal(artboard.src, "/t/files/alpha/01-a.html");
	assert.equal(preview.getAttribute("sandbox"), "allow-scripts allow-same-origin allow-forms allow-popups");
	assert.equal(preview.getAttribute("referrerpolicy"), "no-referrer");
	assert.equal(preview.src, "http://localhost:5173/login");
	for (const frame of frames) assert.deepEqual([frame.style.width, frame.style.height], ["400px", "300px"]);
	const link = canvas.document.getElementById("gd-compare-open");
	assert.equal(link.href, "http://localhost:5173/login");
	assert.equal(link.getAttribute("rel"), "noopener noreferrer");
	assert.equal(link.getAttribute("target"), "_blank");
	assert.equal(canvas.viewport.inert, true, "the canvas underneath is inert");

	const keydown = canvas.document.listeners.get("keydown") ?? [];
	const press = (shiftKey: boolean) => {
		const event: any = { key: "Escape", shiftKey, target: canvas.document.body, defaultPrevented: false, preventDefault() { event.defaultPrevented = true; } };
		keydown.forEach((listener) => listener(event));
	};
	press(false);
	assert.equal(overlay.hidden, false, "plain Esc stays");
	press(true);
	assert.equal(overlay.hidden, true, "Shift+Esc exits Compare");
	assert.deepEqual(panes.children, [], "the app frame is removed");
	assert.equal(canvas.viewport.inert, false);

	open();
	canvas.document.getElementById("gd-compare-back").dispatch("click");
	assert.equal(overlay.hidden, true, "Back to canvas exits Compare");

	open();
	const [shownArtboard] = findAll(panes, (element) => element.localName === "iframe");
	canvas.message({}, { type: "gd:exit-focus" });
	assert.equal(overlay.hidden, false, "only the compared artboard may ask to exit");
	canvas.message(shownArtboard.contentWindow, { type: "gd:exit-focus" });
	assert.equal(overlay.hidden, true, "Shift+Esc inside the artboard exits Compare");
});

test("Compare offers scale to fit when the pair is wider than the window", async () => {
	const canvas = await loadCanvas(300, { "/t/api/designs/alpha/handoffs": handoffDoc("01-a.html", { "01-a.html": { status: "implemented", previewUrl: "http://localhost:3000/" } }) });
	const stage = canvas.document.getElementById("gd-compare-stage");
	stage.rect = { left: 0, top: 0, width: 500, height: 600 };
	withClass(boardsOf(canvas)[0], "gd-compare-start")[0].dispatch("click");
	const fit = canvas.document.getElementById("gd-compare-fit");
	const field = canvas.document.getElementById("gd-compare-fit-field");
	const panes = canvas.document.getElementById("gd-compare-panes");
	assert.equal(field.hidden, false, "two 400 px boards do not fit in 500 px");
	assert.equal(panes.style.transform, "none", "Compare starts at 100%");
	fit.checked = true;
	fit.dispatch("change");
	assert.match(panes.style.transform, /^scale\(0\.\d+\)$/);
	canvas.document.getElementById("gd-compare-back").dispatch("click");
	stage.rect = { left: 0, top: 0, width: 2000, height: 600 };
	withClass(boardsOf(canvas)[0], "gd-compare-start")[0].dispatch("click");
	assert.equal(field.hidden, true, "no toggle when the pair fits");
	assert.equal(panes.style.transform, "none");
});

test("Implement this shows a toast and the badge at once: Queued when busy, Implementing… when idle", async () => {
	const canvas = await loadCanvas(300, { "/t/api/designs/alpha/implement": { ok: true, slug: "alpha", file: "01-a.html", queued: true } });
	const toast = canvas.document.getElementById("gd-toast");
	assert.match(read("index.html"), /<div id="gd-toast" class="gd-toast" role="status" aria-live="polite" hidden><\/div>/, "the toast starts hidden");
	const send = async () => {
		const [control] = withClass(boardsOf(canvas)[0], "gd-implement");
		withClass(control, "gd-implement-start")[0].dispatch("click");
		const yes = withClass(control, "gd-primary")[0];
		yes.dispatch("click");
		for (let i = 0; i < 10; i++) await flush();
	};
	await send();
	assert.deepEqual(canvas.posts.at(-1), { url: "/t/api/designs/alpha/implement", body: { file: "01-a.html" } });
	assert.equal(toast.hidden, false);
	assert.equal(toast.textContent, "Queued: the session will implement First after its current task.");
	assert.deepEqual(texts(boardsOf(canvas)[0], "gd-handoff-badge"), ["Queued"]);
	assert.deepEqual(texts(boardsOf(canvas)[0], "gd-choice"), ["Chosen"]);
	assert.deepEqual(texts(boardsOf(canvas)[1], "gd-choice"), ["Discarded"]);

	canvas.replies["/t/api/designs/alpha/implement"] = { ok: true, slug: "alpha", file: "01-a.html", queued: false };
	await send();
	assert.equal(toast.textContent, "Sent: the session is implementing First now.");
	assert.deepEqual(texts(boardsOf(canvas)[0], "gd-handoff-badge"), ["Implementing…"]);
});

test("an [::1] preview says browsers refuse to frame it, and keeps Open in new tab", async () => {
	const canvas = await loadCanvas(300, { "/t/api/designs/alpha/handoffs": handoffDoc("01-a.html", { "01-a.html": { status: "implemented", previewUrl: "http://[::1]:3000/" } }) });
	withClass(boardsOf(canvas)[0], "gd-compare-start")[0].dispatch("click");
	const message = canvas.document.getElementById("gd-compare-message");
	assert.equal(message.textContent, "Browsers do not frame [::1] under the canvas policy (CSP has no IPv6 sources): use Open in new tab, or report the preview on localhost.");
	assert.equal(canvas.document.getElementById("gd-compare-open").href, "http://[::1]:3000/");
});

// Brand rail (S1-S5, S10, S11): tool rail, shortcuts, mode chip.

type Canvas = Awaited<ReturnType<typeof loadCanvas>>;

/** The fake DOM starts every element visible; index.html starts the popover hidden. */
async function loadRail(firstHeight = 300, extraReplies: Record<string, unknown> = {}, config: Record<string, unknown> = {}, extraContext: Record<string, unknown> = {}) {
	const canvas = await loadCanvas(firstHeight, extraReplies, config, extraContext);
	canvas.document.getElementById("gd-popover").hidden = true;
	return canvas;
}

/** A key press delivered to the document's keydown listeners, as the browser would from `target`. */
function press(canvas: Canvas, key: string, init: Record<string, unknown> = {}, target?: FakeElement) {
	const event: any = { key, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, target: target ?? canvas.document.body, defaultPrevented: false, preventDefault() { event.defaultPrevented = true; }, ...init };
	for (const listener of canvas.document.listeners.get("keydown") ?? []) listener(event);
	return event;
}

const pressed = (canvas: Canvas, id: string) => canvas.document.getElementById(id).getAttribute("aria-pressed");
const COMMENT_CHIP = "Click a direction to open it and comment · Esc";

test("the rail's Navigate and Comment form a pressed pair over the comment mode, and the chip says which", async () => {
	const canvas = await loadRail();
	const navigate = canvas.document.getElementById("gd-tool-navigate");
	const comment = canvas.document.getElementById("gd-comment");
	assert.equal(pressed(canvas, "gd-tool-navigate"), "true");
	assert.equal(pressed(canvas, "gd-comment"), "false");
	assert.equal(canvas.navMode.textContent, "Navigating");

	comment.dispatch("click");
	assert.equal(pressed(canvas, "gd-comment"), "true");
	assert.equal(pressed(canvas, "gd-tool-navigate"), "false");
	assert.equal(canvas.navMode.textContent, COMMENT_CHIP);
	assert.ok(canvas.world.classes.has("gd-commenting"));
	assert.deepEqual(canvas.frames()[0].contentWindow!.posted.at(-1), { type: "gd:mode", enabled: true });

	navigate.dispatch("click");
	assert.equal(pressed(canvas, "gd-comment"), "false");
	assert.equal(pressed(canvas, "gd-tool-navigate"), "true");
	assert.equal(canvas.navMode.textContent, "Navigating");
	assert.ok(!canvas.world.classes.has("gd-commenting"));
	assert.deepEqual(canvas.frames()[0].contentWindow!.posted.at(-1), { type: "gd:mode", enabled: false });

	// The Comment tool keeps toggling, and Navigate while navigating changes nothing.
	comment.dispatch("click");
	comment.dispatch("click");
	assert.equal(pressed(canvas, "gd-comment"), "false");
	navigate.dispatch("click");
	assert.equal(pressed(canvas, "gd-tool-navigate"), "true");
	assert.equal(canvas.navMode.textContent, "Navigating");
});

test("the mode chip names focus mode over comment mode, and returns to the right text on exit", async () => {
	const canvas = await loadRail();
	const [first] = canvas.boards;
	canvas.document.getElementById("gd-comment").dispatch("click");
	assert.equal(canvas.navMode.textContent, COMMENT_CHIP);
	canvas.document.getElementById("gd-back").dispatch("click");
	click(first.shield!, 200, 200);
	// canvas-ux-quick-wins S1: comment mode opens the direction too, and stays on.
	assert.equal(canvas.navMode.textContent, "Using: First · Shift+Esc to exit", "focus, not a routed pick, in comment mode");
	canvas.document.getElementById("gd-back").dispatch("click");
	canvas.document.getElementById("gd-comment").dispatch("click");
	click(first.shield!, 200, 200);
	assert.equal(canvas.navMode.textContent, "Using: First · Shift+Esc to exit");
	canvas.document.getElementById("gd-comment").dispatch("click");
	assert.equal(canvas.navMode.textContent, "Using: First · Shift+Esc to exit", "focus text wins while focused");
	canvas.document.getElementById("gd-back").dispatch("click");
	assert.equal(canvas.navMode.textContent, COMMENT_CHIP);
});

test("V, C, F, [, ] and ? drive the tools from the keyboard", async () => {
	const canvas = await loadRail();
	Object.defineProperty(canvas.world, "offsetWidth", { value: 2000 });
	Object.defineProperty(canvas.world, "offsetHeight", { value: 400 });
	const nav = canvas.document.getElementById("gd-nav");
	const panel = canvas.document.getElementById("gd-panel");
	const dialog = canvas.document.getElementById("gd-shortcuts");
	let modal = 0;
	(dialog as any).showModal = () => { modal++; dialog.setAttribute("open", ""); };

	assert.equal(press(canvas, "c").defaultPrevented, true);
	assert.equal(pressed(canvas, "gd-comment"), "true");
	assert.equal(canvas.navMode.textContent, COMMENT_CHIP);
	press(canvas, "v");
	assert.equal(pressed(canvas, "gd-comment"), "false");
	assert.equal(canvas.navMode.textContent, "Navigating");
	press(canvas, "C");
	assert.equal(pressed(canvas, "gd-comment"), "true", "the shortcuts ignore letter case");
	press(canvas, "V");

	canvas.viewport.dispatch("wheel", { deltaX: 0, deltaY: 40, deltaMode: 0, ctrlKey: true, metaKey: false, shiftKey: false, clientX: 300, clientY: 300 });
	assert.notEqual(canvas.zoomLevel.textContent, "45%");
	press(canvas, "f");
	assert.equal(canvas.zoomLevel.textContent, "45%");

	assert.equal(nav.hidden, false);
	press(canvas, "[");
	assert.equal(nav.hidden, true);
	assert.equal(pressed(canvas, "gd-nav-toggle"), "false");
	press(canvas, "[");
	assert.equal(nav.hidden, false);
	assert.equal(pressed(canvas, "gd-nav-toggle"), "true");

	press(canvas, "]");
	assert.equal(panel.hidden, true);
	assert.equal(pressed(canvas, "gd-panel-toggle"), "false");
	press(canvas, "]");
	assert.equal(panel.hidden, false);

	press(canvas, "?", { shiftKey: true });
	assert.equal(modal, 1);
	assert.ok(dialog.hasAttribute("open"));
});

test("shortcuts with a modifier, and the buttons of the rail, reach the same tools", async () => {
	const canvas = await loadRail();
	const dialog = canvas.document.getElementById("gd-shortcuts");
	(dialog as any).showModal = () => dialog.setAttribute("open", "");
	press(canvas, "c", { ctrlKey: true });
	press(canvas, "c", { metaKey: true });
	press(canvas, "c", { altKey: true });
	assert.equal(pressed(canvas, "gd-comment"), "false", "browser chords are left alone");

	canvas.document.getElementById("gd-nav-toggle").dispatch("click");
	assert.equal(canvas.document.getElementById("gd-nav").hidden, true);
	assert.equal(pressed(canvas, "gd-nav-toggle"), "false");
	canvas.document.getElementById("gd-shortcuts-open").dispatch("click");
	assert.ok(dialog.hasAttribute("open"));
	// Single keys do nothing while the dialog is open, except ? which closes it.
	press(canvas, "c");
	assert.equal(pressed(canvas, "gd-comment"), "false");
});

test("single-key shortcuts are ignored while typing, with the popover open, and in focus mode, except Shift+Esc", async () => {
	const canvas = await loadRail();
	const [first] = canvas.boards;
	const typing = ["input", "textarea", "select"].map((tag) => canvas.document.createElement(tag));
	for (const field of typing) {
		for (const key of ["c", "v", "f", "[", "]", "?"]) press(canvas, key, {}, field);
	}
	assert.equal(pressed(canvas, "gd-comment"), "false", "typing never switches tools");
	assert.equal(canvas.document.getElementById("gd-nav").hidden, false);
	assert.equal(canvas.document.getElementById("gd-panel").hidden, false);

	const popover = canvas.document.getElementById("gd-popover");
	popover.hidden = false;
	press(canvas, "c");
	press(canvas, "]");
	assert.equal(pressed(canvas, "gd-comment"), "false", "no shortcuts while the popover is open");
	assert.equal(canvas.document.getElementById("gd-panel").hidden, false);
	popover.hidden = true;

	click(first.shield!, 200, 200);
	const transform = canvas.world.style.transform;
	for (const key of ["c", "v", "f", "[", "]", "?", "0", "+", "-"]) {
		const event = press(canvas, key);
		assert.equal(event.defaultPrevented, false, `${key} is left alone in focus mode`);
	}
	assert.equal(pressed(canvas, "gd-comment"), "false");
	assert.equal(canvas.document.getElementById("gd-nav").hidden, false);
	assert.equal(canvas.world.style.transform, transform);
	assert.match(canvas.navMode.textContent, /^Using:/);
	press(canvas, "Escape", { shiftKey: true });
	assert.equal(canvas.navMode.textContent, "Navigating", "Shift+Esc still leaves focus mode");
	press(canvas, "c");
	assert.equal(pressed(canvas, "gd-comment"), "true", "shortcuts work again outside focus mode");
});

test("the Design system tool is disabled without a system board and focuses it when there is one", async () => {
	const without = await loadRail();
	assert.equal(without.document.getElementById("gd-rail-system").disabled, true);

	const canvas = await loadRail(300, { "/t/api/system": { exists: true, file: "system.html", width: 1440, height: 1200 } });
	const system = canvas.document.getElementById("gd-rail-system");
	assert.equal(system.disabled, false);
	system.dispatch("click");
	assert.equal(canvas.navMode.textContent, "Using: Design system · Shift+Esc to exit");
	// Overview is off while focused, and back on after.
	const fit = canvas.document.getElementById("gd-rail-fit");
	assert.equal(fit.disabled, true);
	canvas.document.getElementById("gd-back").dispatch("click");
	assert.equal(fit.disabled, false);
});

test("the rail Fit and the artboard count follow the canvas", async () => {
	const canvas = await loadRail();
	Object.defineProperty(canvas.world, "offsetWidth", { value: 2000 });
	Object.defineProperty(canvas.world, "offsetHeight", { value: 400 });
	canvas.viewport.dispatch("wheel", { deltaX: 0, deltaY: 40, deltaMode: 0, ctrlKey: true, metaKey: false, shiftKey: false, clientX: 300, clientY: 300 });
	canvas.document.getElementById("gd-rail-fit").dispatch("click");
	assert.equal(canvas.zoomLevel.textContent, "45%");
	assert.equal(canvas.document.getElementById("gd-nav-title").textContent, "Directions · 2");
});

test("index.html: one sprite, named icon buttons with shortcut titles, a shortcuts dialog and a labeled rail", () => {
	const html = read("index.html");
	assert.equal(html.split("<symbol ").length - 1, new Set(html.match(/<symbol id="[^"]+"/g)).size, "sprite ids are unique");
	assert.equal(html.split("<svg ").filter((part) => /aria-hidden="true"/.test(part.split(">")[0]) && /<symbol/.test(part)).length, 1, "a single sprite");
	for (const match of html.matchAll(/<use href="#([^"]+)"/g)) assert.ok(html.includes(`<symbol id="${match[1]}"`), `${match[1]} exists in the sprite`);
	const iconButtons = [...html.matchAll(/<button\b([^>]*)>\s*<svg[^>]*><use [^>]*\/><\/svg>\s*<\/button>/g)];
	assert.ok(iconButtons.length >= 8);
	for (const [, attributes] of iconButtons) {
		assert.match(attributes, /aria-label="[^"]+"/);
		assert.match(attributes, /title="[^"]+"/);
	}
	for (const [id, shortcut] of [["gd-tool-navigate", "V"], ["gd-comment", "C"], ["gd-rail-fit", "F"], ["gd-nav-toggle", "["], ["gd-shortcuts-open", "?"]] as const) {
		assert.match(html, new RegExp(`id="${id.replace(/[[\]]/g, "\\$&")}"[^>]*title="[^"]*\\(${shortcut.replace(/[[\]?]/g, "\\$&")}\\)"`), `${id} names ${shortcut}`);
	}
	assert.match(html, /<nav class="gd-rail" aria-label="Tools"/);
	assert.match(html, /<dialog id="gd-shortcuts"[^>]*aria-labelledby=/);
	assert.match(html, /<aside id="gd-nav"[^>]*aria-labelledby="gd-nav-title"/);
	assert.match(html, /id="gd-nav-list"/);
	assert.ok(!/[\u{1F300}-\u{1FAFF}\u2600-\u27BF]/u.test(html), "no emoji icons");
});

test("canvas.css takes its colors from the brand tokens: no raw hex outside :root, except the artboard's white", () => {
	const css = read("canvas.css");
	const root = css.match(/:root\s*{[^}]*}/)![0];
	for (const [token, value] of [["--bg", "#1a1218"], ["--bg-deep", "#000000"], ["--surface", "#20161e"], ["--surface-1", "#241822"], ["--surface-2", "#342230"], ["--border", "#342230"], ["--border-soft", "#ffffff17"], ["--text", "#f6eff3"], ["--text-muted", "#a78e9b"], ["--text-faint", "#76616b"], ["--accent", "#f095c8"], ["--accent-strong", "#ff76c3"], ["--accent-soft", "#ffb1dd"], ["--success", "#b4e7c7"], ["--warning", "#e0c27a"], ["--error", "#ff718f"], ["--info", "#a9c7ee"]] as const) {
		assert.ok(root.includes(`${token}: ${value}`), `${token} is ${value}`);
	}
	assert.match(root, /--font-sans: Inter,/);
	assert.match(root, /--font-mono: "IosevkaTerm NF"/);
	const outside = css.replace(root, "");
	assert.deepEqual([...outside.matchAll(/#[0-9a-fA-F]{3,8}\b(?![\w-])/g)].map((match) => match[0]).filter((value) => value !== "#fff"), []);
	assert.match(css, /prefers-reduced-motion: no-preference/);
	assert.match(css, /outline: 2px solid var\(--accent\)/);
});

// Brand rail, review workspace (S6-S9, S10 header): navigator, Compare with app, tabs, Brief, handoff timeline.

const comment = (id: string, file: string, status = "open", extra: Record<string, unknown> = {}) => ({ id, slug: "alpha", file, selector: `main > .${id}`, excerpt: "", comment: `Text of ${id}`, status, sentAt: null, ...extra });
const commentsDoc = (...comments: Array<Record<string, unknown>>) => ({ "/t/api/designs/alpha/comments": { comments } });
const navItems = (canvas: Canvas) => withClass(canvas.document.getElementById("gd-nav-list"), "gd-nav-item");
const navTexts = (canvas: Canvas, name: string) => texts(canvas.document.getElementById("gd-nav-list"), name);
const setComments = async (canvas: Canvas, ...comments: Array<Record<string, unknown>>) => {
	canvas.replies["/t/api/designs/alpha/comments"] = { comments };
	await canvas.serverEvent("change", { slug: "alpha", file: "comments.json" });
};

test("the navigator lists the artboards with a number, a comment summary and a title for the count", async () => {
	const canvas = await loadRail(300, commentsDoc(comment("a1", "01-a.html"), comment("a2", "01-a.html"), comment("a3", "01-a.html", "resolved"), comment("b1", "02-b.html", "resolved")));
	assert.equal(canvas.document.getElementById("gd-nav-title").textContent, "Directions · 2");
	assert.deepEqual(navTexts(canvas, "gd-nav-item-title"), ["01 First", "02 Second"]);
	// Open comments first, then resolved; either alone stands alone; none says so.
	assert.deepEqual(navTexts(canvas, "gd-nav-summary"), ["2 open comments · 1 resolved", "1 resolved"]);
	assert.equal(withClass(navItems(canvas)[0], "gd-nav-thumb").length, 1, "each item has a thumbnail block");

	await setComments(canvas, comment("a1", "01-a.html"));
	assert.deepEqual(navTexts(canvas, "gd-nav-summary"), ["1 open comment", "No comments"], "the summary follows comments.json live");
	await setComments(canvas);
	assert.deepEqual(navTexts(canvas, "gd-nav-summary"), ["No comments", "No comments"]);
});

test("the navigator tags Chosen and Discarded only once an artboard is chosen, live", async () => {
	const canvas = await loadRail();
	assert.deepEqual(navTexts(canvas, "gd-nav-tag"), [], "no tags without a chosen artboard");
	await setHandoffs(canvas, handoffDoc("02-b.html", { "02-b.html": {} }));
	assert.deepEqual(navTexts(canvas, "gd-nav-tag"), ["Discarded", "Chosen"]);
	const [first, second] = withClass(canvas.document.getElementById("gd-nav-list"), "gd-nav-tag");
	assert.ok(second.classes.has("gd-nav-tag-chosen") && !first.classes.has("gd-nav-tag-chosen"));
	await setHandoffs(canvas, handoffDoc(null, {}));
	assert.deepEqual(navTexts(canvas, "gd-nav-tag"), []);
});

test("activating a navigator item enters focus mode on it and marks it aria-current", async () => {
	const canvas = await loadRail();
	assert.deepEqual(navItems(canvas).map((item) => item.getAttribute("aria-current")), [null, null]);
	navItems(canvas)[1].dispatch("click");
	assert.equal(canvas.navMode.textContent, "Using: Second · Shift+Esc to exit");
	assert.deepEqual(navItems(canvas).map((item) => item.getAttribute("aria-current")), [null, "true"]);
	// Another item moves focus mode to that artboard.
	navItems(canvas)[0].dispatch("click");
	assert.equal(canvas.navMode.textContent, "Using: First · Shift+Esc to exit");
	assert.deepEqual(navItems(canvas).map((item) => item.getAttribute("aria-current")), ["true", null]);
	canvas.document.getElementById("gd-back").dispatch("click");
	assert.deepEqual(navItems(canvas).map((item) => item.getAttribute("aria-current")), [null, null]);
});

test("the navigator footer note appears only when a system board exists", async () => {
	const without = await loadRail();
	assert.equal(without.document.getElementById("gd-nav-note").hidden, true);
	const withSystem = await loadRail(300, { "/t/api/system": { exists: true, file: "system.html", width: 1440, height: 1200 } });
	const note = withSystem.document.getElementById("gd-nav-note");
	assert.equal(note.hidden, false);
	assert.equal(withSystem.document.getElementById("gd-nav-title").textContent, "Directions · 2", "the system board is not counted");
	assert.deepEqual(navTexts(withSystem, "gd-nav-item-title"), ["01 First", "02 Second"], "nor listed");
});

// Live thumbnails (T2): the artboard list shows each artboard rendered, not a placeholder.

const thumbOf = (canvas: Canvas, index: number) => withClass(navItems(canvas)[index], "gd-nav-thumb")[0];
const thumbFrame = (canvas: Canvas, index: number) => findAll(thumbOf(canvas, index), (element) => element.localName === "iframe")[0];

test("S6: each artboard-list item shows a sandboxed, inert, hidden, unfocusable live render of its artboard", async () => {
	const canvas = await loadRail();
	assert.equal(navItems(canvas).length, 2);
	for (const [index, file] of ["01-a.html", "02-b.html"].entries()) {
		const thumb = thumbOf(canvas, index);
		assert.equal(thumb.getAttribute("aria-hidden"), "true", "hidden from assistive technology");
		const frames = findAll(thumb, (element) => element.localName === "iframe");
		assert.equal(frames.length, 1);
		const frame = frames[0];
		assert.equal(frame.src, `/t/files/alpha/${file}`);
		assert.equal(frame.getAttribute("sandbox"), "allow-scripts", "scripts only, like the artboards");
		assert.equal(frame.getAttribute("referrerpolicy"), "no-referrer");
		assert.equal(frame.getAttribute("aria-hidden"), "true");
		assert.equal(frame.getAttribute("tabindex"), "-1", "never focusable");
		assert.equal(frame.inert, true, "inert");
		assert.equal(frame.getAttribute("loading"), "lazy", "a long list does not load every artboard at once");
		assert.equal(frame.title, `${index === 0 ? "First" : "Second"} preview`);
	}
});

test("S6: the thumbnail shows the artboard at its true size, scaled down to the thumbnail's width", async () => {
	const canvas = await loadRail(300, { "/t/api/designs/alpha": { slug: "alpha", title: "Alpha", brief: "", artboards: [
		{ file: "01-a.html", title: "First", tradeoff: "", width: 1200, height: 800 },
		{ file: "02-b.html", title: "Second", tradeoff: "", width: 400, height: 300 },
	] } });
	const first = thumbFrame(canvas, 0);
	assert.deepEqual([first.style.width, first.style.height], ["1200px", "800px"]);
	assert.equal(first.style.transform, `scale(${56 / 1200})`);
	const second = thumbFrame(canvas, 1);
	assert.deepEqual([second.style.width, second.style.height], ["400px", "300px"]);
	assert.equal(second.style.transform, `scale(${56 / 400})`);
});

test("S6: thumbnails keep their iframes when the list re-renders, so comment and handoff changes never reload them", async () => {
	const canvas = await loadRail();
	const frames = [thumbFrame(canvas, 0), thumbFrame(canvas, 1)];
	const items = navItems(canvas);
	const srcs = frames.map((frame) => frame.src);
	await setComments(canvas, comment("a1", "01-a.html"));
	await setHandoffs(canvas, handoffDoc("02-b.html", { "02-b.html": {} }));
	navItems(canvas)[1].dispatch("click");
	canvas.document.getElementById("gd-back").dispatch("click");
	assert.deepEqual(navItems(canvas), items, "the same list items");
	assert.deepEqual([thumbFrame(canvas, 0), thumbFrame(canvas, 1)], frames, "with the same iframes");
	assert.deepEqual(frames.map((frame) => frame.src), srcs, "that were not reloaded");
	assert.deepEqual(navTexts(canvas, "gd-nav-summary"), ["1 open comment", "No comments"], "while the text still follows the state");
	assert.deepEqual(navTexts(canvas, "gd-nav-tag"), ["Discarded", "Chosen"]);
	assert.equal(canvas.document.getElementById("gd-nav-list").children.length, 2);
});

test("S6: a thumbnail reloads when its artboard file changes, a shared asset reloads all, comments and handoffs reload none", async () => {
	const canvas = await loadRail();
	const [a, b] = [thumbFrame(canvas, 0), thumbFrame(canvas, 1)];
	await canvas.serverEvent("change", { slug: "alpha", file: "comments.json" });
	await canvas.serverEvent("change", { slug: "alpha", file: "handoffs.json" });
	assert.deepEqual([a.src, b.src], ["/t/files/alpha/01-a.html", "/t/files/alpha/02-b.html"]);

	await canvas.serverEvent("change", { slug: "alpha", file: "01-a.html" });
	assert.match(a.src, /^\/t\/files\/alpha\/01-a\.html\?v=\d+$/);
	assert.equal(b.src, "/t/files/alpha/02-b.html", "only the changed artboard");

	await canvas.serverEvent("change", { slug: "alpha", file: "shared.css" });
	assert.match(a.src, /^\/t\/files\/alpha\/01-a\.html\?v=\d+$/);
	assert.match(b.src, /^\/t\/files\/alpha\/02-b\.html\?v=\d+$/);
	await canvas.serverEvent("change", { slug: "beta", file: "01-a.html" });
	assert.match(a.src, /\?v=\d+$/);
});

test("S6: a thumbnail's window is not an artboard: nothing it posts is trusted", async () => {
	const canvas = await loadRail(300, commentsDoc(comment("a1", "01-a.html")));
	const [first] = canvas.boards;
	const popover = canvas.document.getElementById("gd-popover");
	canvas.document.getElementById("gd-comment").dispatch("click");
	const thumb = thumbFrame(canvas, 0).contentWindow;
	canvas.message(thumb, { type: "gd:pick", selector: "#cta", excerpt: "", rect: { x: 0, y: 0, width: 1, height: 1 } });
	assert.equal(popover.hidden, true);
	navItems(canvas)[0].dispatch("click");
	canvas.message(thumb, { type: "gd:exit-focus" });
	assert.match(canvas.navMode.textContent, /^Using:/, "a thumbnail cannot end focus mode");
	canvas.message(thumb, { type: "gd:pin-rects", rects: [{ id: "a1", rect: { x: 5, y: 5, width: 5, height: 5 } }] });
	assert.equal(withClass(first.wrapper, "gd-pin").length, 0);
	assert.equal(thumb!.posted.length, 0, "and the canvas sends it no mode, focus or pins");
});

test("S6: a new design's list gets its own thumbnails", async () => {
	const canvas = await loadRail();
	await canvas.serverEvent("show", { slug: "beta" });
	assert.equal(navItems(canvas).length, 1);
	assert.equal(thumbFrame(canvas, 0).src, "/t/files/beta/01-only.html");
	assert.deepEqual([thumbFrame(canvas, 0).style.width, thumbFrame(canvas, 0).style.height], ["500px", "400px"]);
});

test("S6: canvas.css drops the placeholder and makes the thumbnail frame non-interactive", () => {
	const css = read("canvas.css");
	assert.ok(!css.includes(".gd-nav-thumb::before") && !css.includes(".gd-nav-thumb::after"), "no placeholder drawing");
	const frameRule = css.match(/\.gd-nav-thumb-frame\s*{[^}]*}/)![0];
	assert.match(frameRule, /pointer-events:\s*none/);
	assert.match(frameRule, /border:\s*0/);
	assert.match(frameRule, /transform-origin:\s*0 0/);
	assert.match(css, /\.gd-nav-thumb\s*{[^}]*overflow:\s*hidden/);
	assert.match(css, /grid-template-columns:\s*56px minmax\(0, 1fr\)/);
});

test("the top bar shows the feature as a chip with its separator, and hides both without one", async () => {
	const without = await loadRail();
	assert.equal(without.document.getElementById("gd-feature").hidden, true);
	assert.equal(without.document.getElementById("gd-feature-sep").hidden, true);
	assert.match(read("index.html"), /<h1 class="gd-title" id="gd-title">Gentle Design<\/h1>/);
	assert.equal(without.document.getElementById("gd-title").textContent, "", "the breadcrumb is static: the design's title is never written into it");

	const canvas = await loadRail(300, { "/t/api/designs/alpha": { slug: "alpha", title: "Alpha", brief: "Make a checkout.", feature: "odd/tasks/checkout.md", artboards: [{ file: "01-a.html", title: "First", tradeoff: "", width: 400, height: 300 }] } });
	assert.equal(canvas.document.getElementById("gd-feature").textContent, "odd/tasks/checkout.md");
	assert.equal(canvas.document.getElementById("gd-feature").hidden, false);
	assert.equal(canvas.document.getElementById("gd-feature-sep").hidden, false);
	assert.equal(canvas.document.getElementById("gd-title").textContent, "");
});

test("Compare with app shows only for the chosen artboard when implemented with a loopback previewUrl, and opens Compare", async () => {
	const button = (canvas: Canvas) => canvas.document.getElementById("gd-compare-app");
	const implemented = (previewUrl: unknown, extra: Record<string, unknown> = {}) => ({ status: "implemented", previewUrl, ...extra });
	const canvas = await loadRail(300, { "/t/api/designs/alpha/handoffs": handoffDoc("01-a.html", { "01-a.html": { status: "sent" } }) });
	assert.equal(button(canvas).hidden, true, "not implemented yet");
	await setHandoffs(canvas, handoffDoc("01-a.html", { "01-a.html": implemented(undefined) }));
	assert.equal(button(canvas).hidden, true, "no previewUrl");
	for (const url of ["http://example.com:3000/", "javascript:alert(1)", "http://127.0.0.1:4100/", "http://user:pw@localhost:3000/"]) {
		await setHandoffs(canvas, handoffDoc("01-a.html", { "01-a.html": implemented(url) }));
		assert.equal(button(canvas).hidden, true, `${url} is refused`);
	}
	await setHandoffs(canvas, handoffDoc("02-b.html", { "01-a.html": implemented("http://localhost:3000/"), "02-b.html": { status: "sent" } }));
	assert.equal(button(canvas).hidden, true, "an implemented alternative does not count");

	await setHandoffs(canvas, handoffDoc("01-a.html", { "01-a.html": implemented("http://localhost:3000/") }));
	assert.equal(button(canvas).hidden, false);
	button(canvas).dispatch("click");
	assert.equal(canvas.document.getElementById("gd-compare").hidden, false);
	assert.equal(canvas.document.getElementById("gd-compare-open").href, "http://localhost:3000/");
	assert.equal(button(canvas).disabled, true, "off while Compare is open");
	canvas.document.getElementById("gd-compare-back").dispatch("click");
	assert.equal(canvas.document.getElementById("gd-compare").hidden, true);
	assert.equal(button(canvas).disabled, false);
});

test("the review side has Comments (with its Open / Resolved filter), History, Checks, Mix and Original request tabs that drive the list", async () => {
	const canvas = await loadRail(300, { ...commentsDoc(comment("a1", "01-a.html"), comment("a2", "02-b.html", "resolved", { sentAt: "2026-10-26T10:00:00.000Z" })), "/t/api/designs/alpha": { slug: "alpha", title: "Alpha", brief: "Make a checkout.", feature: "odd/tasks/checkout.md", artboards: [{ file: "01-a.html", title: "First", tradeoff: "", width: 400, height: 300 }, { file: "02-b.html", title: "Second", tradeoff: "", width: 400, height: 300 }] } });
	const doc = canvas.document;
	// canvas-ux-quick-wins S4: one Comments tab; open and resolved are a filter inside it.
	const tabs = ["gd-tab-comments", "gd-tab-history", "gd-tab-checks", "gd-tab-mix", "gd-tab-brief"];
	const selected = () => tabs.map((id) => doc.getElementById(id).getAttribute("aria-selected"));
	const list = doc.getElementById("gd-comment-list");
	const brief = doc.getElementById("gd-brief");
	assert.deepEqual(selected(), ["true", "false", "false", "false", "false"]);
	assert.equal(doc.getElementById("gd-count-open").textContent, "1");
	assert.equal(doc.getElementById("gd-filter-resolved").textContent, "Resolved (1)");
	assert.equal(brief.hidden, true);
	assert.deepEqual(texts(list, "gd-comment-text"), ["Text of a1"]);

	doc.getElementById("gd-filter-resolved").dispatch("click");
	assert.deepEqual(selected(), ["true", "false", "false", "false", "false"]);
	assert.deepEqual(texts(list, "gd-comment-text"), ["Text of a2"]);

	doc.getElementById("gd-tab-brief").dispatch("click");
	assert.deepEqual(selected(), ["false", "false", "false", "false", "true"]);
	assert.equal(brief.hidden, false);
	assert.equal(list.hidden, true);
	assert.equal(doc.getElementById("gd-panel-empty").hidden, true);
	assert.equal(doc.getElementById("gd-brief-title").textContent, "Alpha");
	assert.equal(doc.getElementById("gd-brief-text").textContent, "Make a checkout.");
	assert.equal(doc.getElementById("gd-brief-feature").textContent, "odd/tasks/checkout.md");
	assert.equal(doc.getElementById("gd-brief-feature").hidden, false);
	assert.equal(doc.getElementById("gd-tabpanel").getAttribute("aria-labelledby"), "gd-tab-brief");

	// Arrow keys move between tabs (roving tabindex), wrapping around.
	const tablist = doc.getElementById("gd-tabs");
	tablist.dispatch("keydown", { key: "ArrowRight" });
	assert.deepEqual(selected(), ["true", "false", "false", "false", "false"]);
	assert.equal(doc.activeElement, doc.getElementById("gd-tab-comments"));
	assert.equal(doc.getElementById("gd-tab-comments").getAttribute("tabindex"), "0");
	assert.equal(doc.getElementById("gd-tab-brief").getAttribute("tabindex"), "-1");
	tablist.dispatch("keydown", { key: "End" });
	assert.deepEqual(selected(), ["false", "false", "false", "false", "true"]);
	tablist.dispatch("keydown", { key: "ArrowLeft" });
	assert.deepEqual(selected(), ["false", "false", "false", "true", "false"], "Mix sits between Checks and Brief");
	assert.equal(doc.getElementById("gd-mix").hidden, false);
	tablist.dispatch("keydown", { key: "ArrowLeft" });
	assert.deepEqual(selected(), ["false", "false", "true", "false", "false"], "Checks sits between History and Mix");
	assert.equal(brief.hidden, true);
	assert.equal(doc.getElementById("gd-checks").hidden, false);
});

test("the Brief tab says so when the design has no brief, and keeps the Send footer", async () => {
	const canvas = await loadRail();
	canvas.document.getElementById("gd-tab-brief").dispatch("click");
	assert.equal(canvas.document.getElementById("gd-brief-title").textContent, "Alpha");
	assert.equal(canvas.document.getElementById("gd-brief-text").textContent, "No original request written.");
	assert.equal(canvas.document.getElementById("gd-brief-feature").hidden, true);
	assert.equal(canvas.document.getElementById("gd-send-all").disabled, true, "the footer stays under every tab");
});

test("a comment card shows its number, selector chip, waiting or sent state, text and actions", async () => {
	const canvas = await loadRail(300, commentsDoc(comment("a1", "01-a.html"), comment("a2", "01-a.html", "open", { sentAt: "2026-10-26T10:00:00.000Z", screenshot: { path: "x.png", mimeType: "image/png" } })));
	// canvas-ux-quick-wins S2: the selector chip shows with Technical details on.
	canvas.document.getElementById("gd-technical").dispatch("click");
	const list = canvas.document.getElementById("gd-comment-list");
	assert.deepEqual(texts(list, "gd-comment-number"), ["1", "2"]);
	assert.deepEqual(texts(list, "gd-comment-selector"), ["main > .a1", "main > .a2"]);
	assert.deepEqual(texts(list, "gd-badge"), ["Waiting", "Sent"]);
	assert.deepEqual(texts(list, "gd-comment-text"), ["Text of a1", "Text of a2"]);
	assert.equal(withClass(list, "gd-comment-shot").length, 1);
	assert.equal(withClass(list, "gd-comment-actions").length, 2);
	assert.equal(canvas.document.getElementById("gd-send-all").textContent, "Send all (1)");
	// Resolving still goes through the same action.
	findAll(list, (element) => element.localName === "button" && element.textContent === "Resolve")[0].dispatch("click");
	await flush();
	assert.ok(canvas.posts.some((post) => post.url.endsWith("/comments/a1/status")));
});

test("the handoff timeline is hidden until an artboard is chosen, then names it", async () => {
	const canvas = await loadRail();
	const panel = canvas.document.getElementById("gd-handoff-panel");
	assert.equal(panel.hidden, true);
	await setHandoffs(canvas, handoffDoc("02-b.html", {}));
	assert.equal(panel.hidden, false);
	assert.equal(canvas.document.getElementById("gd-handoff-title").textContent, "Handoff · Second");
	await setHandoffs(canvas, handoffDoc(null, {}));
	assert.equal(panel.hidden, true);
});

const steps = (canvas: Canvas) => withClass(canvas.document.getElementById("gd-timeline"), "gd-step");
const stepStates = (canvas: Canvas) => steps(canvas).map((step) => `${texts(step, "gd-step-label")[0]}=${step.dataset.state}`);

test("timeline steps: chosen only; queued; sent; in progress with a note; implemented", async () => {
	const canvas = await loadRail();
	await setHandoffs(canvas, handoffDoc("01-a.html", {}));
	assert.deepEqual(stepStates(canvas), ["Chosen=done", "Sent to the session=pending", "In progress=pending", "Implemented=pending"]);

	await setHandoffs(canvas, handoffDoc("01-a.html", { "01-a.html": { status: "sent", queued: true } }));
	assert.deepEqual(stepStates(canvas), ["Chosen=done", "Sent to the session=current", "In progress=pending", "Implemented=pending"]);
	assert.match(texts(steps(canvas)[1], "gd-step-detail")[0], /^Queued · /, "a queued send says Queued on the Sent step");

	await setHandoffs(canvas, handoffDoc("01-a.html", { "01-a.html": { status: "sent", queued: false } }));
	assert.deepEqual(stepStates(canvas), ["Chosen=done", "Sent to the session=done", "In progress=current", "Implemented=pending"]);
	assert.doesNotMatch(texts(steps(canvas)[1], "gd-step-detail").join("|"), /Queued/);

	await setHandoffs(canvas, handoffDoc("01-a.html", { "01-a.html": { status: "in_progress", startedAt: "2026-10-26T10:05:00.000Z", note: "Building the summary block" } }));
	assert.deepEqual(stepStates(canvas), ["Chosen=done", "Sent to the session=done", "In progress=current", "Implemented=pending"]);
	assert.ok(texts(steps(canvas)[2], "gd-step-detail").includes("“Building the summary block”"), "the note sits under In progress");
	assert.equal(steps(canvas)[2].getAttribute("aria-current"), "step");
	assert.equal(steps(canvas)[1].getAttribute("aria-current"), null);

	await setHandoffs(canvas, handoffDoc("01-a.html", { "01-a.html": { status: "implemented", implementedAt: "2026-10-26T11:00:00.000Z", previewUrl: "http://localhost:3000/" } }));
	assert.deepEqual(stepStates(canvas), ["Chosen=done", "Sent to the session=done", "In progress=done", "Implemented=done"]);
	assert.equal(steps(canvas).filter((step) => step.getAttribute("aria-current") === "step").length, 0);
	for (const step of steps(canvas)) assert.ok(texts(step, "gd-step-state").length === 1, "every state also has a text label");
});

test("timeline timestamps are short local times: Today HH:MM, otherwise month day, with the year when it differs", async () => {
	const canvas = await loadRail();
	const old = new Date(2020, 2, 4, 9, 5);
	const now = new Date();
	await setHandoffs(canvas, handoffDoc("01-a.html", { "01-a.html": { status: "implemented", sentAt: old.toISOString(), startedAt: now.toISOString(), implementedAt: "not a date" } }));
	assert.deepEqual(texts(steps(canvas)[1], "gd-step-detail"), ["Mar 4 2020, 09:05"]);
	const started = texts(steps(canvas)[2], "gd-step-detail")[0];
	assert.match(started, /^Today \d\d:\d\d$/);
	assert.equal(started, `Today ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`);
	assert.deepEqual(texts(steps(canvas)[3], "gd-step-detail"), [], "an unreadable timestamp shows nothing");
});

test("the timeline follows a handoff accepted by Implement this before handoffs.json changes", async () => {
	const canvas = await loadRail(300, { "/t/api/designs/alpha/implement": { ok: true, slug: "alpha", file: "01-a.html", queued: true } });
	const wrapper = boardsOf(canvas)[0];
	const implement = findAll(wrapper, (element) => element.classes.has("gd-implement-start"))[0];
	implement.dispatch("click");
	findAll(wrapper, (element) => element.localName === "button" && element.textContent === "Send")[0].dispatch("click");
	for (let i = 0; i < 5; i++) await flush();
	assert.equal(canvas.document.getElementById("gd-handoff-panel").hidden, false);
	assert.deepEqual(stepStates(canvas), ["Chosen=done", "Sent to the session=current", "In progress=pending", "Implemented=pending"]);
});

test("the focused artboard header shows its number, title and handoff state chip", async () => {
	const canvas = await loadRail(300, { "/t/api/system": { exists: true, file: "system.html", width: 1440, height: 1200 }, "/t/api/designs/alpha/handoffs": handoffDoc("02-b.html", { "02-b.html": { status: "in_progress" } }) });
	const [system, first, second] = boardsOf(canvas);
	assert.deepEqual(texts(first, "gd-artboard-num"), ["01"]);
	assert.deepEqual(texts(second, "gd-artboard-num"), ["02"]);
	assert.deepEqual(texts(second, "gd-artboard-title"), ["Second"]);
	assert.deepEqual(texts(system, "gd-artboard-num"), [], "the system board has no number");
	const chip = withClass(second, "gd-artboard-state")[0];
	assert.equal(chip.textContent, "In progress");
	assert.equal(chip.dataset.status, "in_progress");
	assert.equal(chip.hidden, false);
	assert.equal(withClass(first, "gd-artboard-state")[0].hidden, true, "no state, no chip");
	await setHandoffs(canvas, handoffDoc("02-b.html", { "02-b.html": { status: "implemented" } }));
	assert.equal(chip.textContent, "Implemented ✓");
	assert.equal(chip.dataset.status, "implemented");
});

test("the T2 markup: tablist with five tabs (canvas-ux S4: no Resolved tab), tabpanel, timeline region, Compare with app and the navigator note", () => {
	const html = read("index.html");
	assert.match(html, /role="tablist"/);
	assert.equal([...html.matchAll(/role="tab"/g)].length, 5);
	assert.match(html, /id="gd-tab-comments"[^>]*role="tab"|role="tab"[^>]*id="gd-tab-comments"/);
	assert.match(html, /role="tabpanel"/);
	assert.match(html, /<section id="gd-handoff-panel"[^>]*aria-labelledby="gd-handoff-title"/);
	assert.match(html, /id="gd-compare-app"[^>]*hidden>.*Compare with app<\/span><\/button>/);
	assert.match(html, /Design system board is always first in Overview\./);
	assert.match(html, /<code id="gd-feature"/);
});

test("zoomed out, each artboard collapses its handoff row and Implement this so they never overlap; zoomed in they return", async () => {
	const canvas = await loadCanvas();
	const wheel = (deltaY: number) => canvas.viewport.dispatch("wheel", { deltaX: 0, deltaY, deltaMode: 0, ctrlKey: true, metaKey: false, shiftKey: false, clientX: 300, clientY: 300 });
	const compact = () => canvas.boards.map((board) => board.wrapper.classes.has("gd-compact"));
	for (let step = 0; step < 8; step += 1) wheel(50);
	assert.deepEqual(compact(), [true, true]);
	for (let step = 0; step < 8; step += 1) wheel(-50);
	assert.deepEqual(compact(), [false, false]);
});

// Readable errors, feedback next to the action, status line scope, delivery capabilities (S12-S15).

const SEND_ALL = "/t/api/designs/alpha/comments/send-all";
const IMPLEMENT = "/t/api/designs/alpha/implement";
const unsentComment = comment("u1", "01-a.html");
const alertOf = (canvas: Canvas, prefix: string) => ({
	root: canvas.document.getElementById(`${prefix}`),
	text: canvas.document.getElementById(`${prefix}-text`),
	detail: canvas.document.getElementById(`${prefix}-detail`),
	dismiss: canvas.document.getElementById(`${prefix}-dismiss`),
});
const sendAllFails = async (canvas: Canvas, reply: Record<string, unknown>) => {
	canvas.replies[SEND_ALL] = reply;
	canvas.document.getElementById("gd-send-all").dispatch("click");
	for (let i = 0; i < 5; i++) await flush();
	return alertOf(canvas, "gd-send-alert");
};
const statusLine = (canvas: Canvas) => canvas.document.getElementById("gd-status");

// Every code the canvas routes can answer, with the sentence's cause and way out.
const CODES: Array<[string, number, RegExp]> = [
	["batch-delivery-unavailable", 501, /not connected to a Pi session[^]*saved[^]*\/gentle:design open/],
	["implement-unavailable", 501, /not connected to a Pi session[^]*\/gentle:design open/],
	["delivery-failed", 500, /session did not accept[^]*saved[^]*try/i],
	["too-many-comments", 409, /too many comments[^]*resolve/i],
	["too-many-handoffs", 409, /too many handoffs/i],
	["invalid-comments", 422, /comments\.json[^]*not valid/i],
	["invalid-handoffs", 422, /handoffs\.json[^]*not valid/i],
	["invalid-comment", 400, /comment[^]*rejected/i],
	["invalid-handoff", 400, /handoff[^]*rejected/i],
	["invalid-screenshot", 400, /screenshot[^]*PNG, JPEG, WebP or GIF/i],
	["body-too-large", 413, /too large[^]*smaller/i],
	["file-too-large", 413, /too large/i],
	["not-found", 404, /no longer exists[^]*reload/i],
	["too-many-streams", 503, /too many canvas tabs[^]*close/i],
	["internal", 500, /unexpected error[^]*canvas server/i],
	["invalid-status", 400, /rejected the request as invalid/i],
	["forbidden", 403, /refused[^]*reload/i],
];

test("S12: every reason code becomes a sentence with its cause and way out, and the raw code stays as the detail", async () => {
	const seen = new Set<string>();
	for (const [code, status, pattern] of CODES) {
		const canvas = await loadRail(300, commentsDoc(unsentComment));
		const alert = await sendAllFails(canvas, { __http: status, error: code });
		assert.equal(alert.root.hidden, false, code);
		assert.match(alert.text.textContent, pattern, code);
		assert.doesNotMatch(alert.text.textContent, /Something went wrong/, `${code} is mapped, not a fallback`);
		assert.ok(alert.detail.textContent.includes(code), `${code} stays as the small detail`);
		assert.ok(alert.root.title.includes(code), `${code} stays in the title`);
		assert.ok(!seen.has(alert.text.textContent) || code.startsWith("invalid-s") || code === "implement-unavailable", `${code} has its own sentence`);
		seen.add(alert.text.textContent);
	}
});

test("S12: the server's own reason text is kept in the detail, an unknown code falls back to a generic sentence with it, and a network failure says so", async () => {
	const withReason = await loadRail(300, commentsDoc(unsentComment));
	const reasoned = await sendAllFails(withReason, { __http: 409, error: "too-many-comments", reason: "comments.json has 500 comments" });
	assert.ok(reasoned.detail.textContent.includes("comments.json has 500 comments"));

	const unknown = await loadRail(300, commentsDoc(unsentComment));
	const generic = await sendAllFails(unknown, { __http: 418, error: "teapot" });
	assert.match(generic.text.textContent, /^Something went wrong/);
	assert.match(generic.text.textContent, /\/gentle:design open/);
	assert.ok(generic.detail.textContent.includes("teapot"));

	const bare = await loadRail(300, commentsDoc(unsentComment));
	const status = await sendAllFails(bare, { __http: 502 });
	assert.match(status.text.textContent, /^Something went wrong/);
	assert.ok(status.detail.textContent.includes("502"), "an answer without a code names its HTTP status");

	const offline = await loadRail(300, commentsDoc(unsentComment));
	const network = await sendAllFails(offline, { __throw: "Failed to fetch" });
	assert.match(network.text.textContent, /could not reach[^]*\/gentle:design open/i);
	assert.ok(network.detail.textContent.includes("Failed to fetch"));
});

test("S13: a failed Send all shows an alert above the button, dismissible, cleared on the next attempt, and a success is a toast", async () => {
	const html = read("index.html");
	assert.match(html, /<div id="gd-send-alert" class="gd-alert" role="alert" hidden>[^]*<use href="#i-alert"\/>[^]*id="gd-send-alert-dismiss"[^>]*aria-label="Dismiss/);
	assert.ok(html.indexOf('id="gd-send-alert"') < html.indexOf('id="gd-send-all"'), "above Send all");
	assert.match(html, /<symbol id="i-alert"/);
	assert.match(html, /<symbol id="i-x"/);

	const canvas = await loadRail(300, commentsDoc(unsentComment));
	const alert = alertOf(canvas, "gd-send-alert");
	assert.equal(alert.root.hidden, true, "no alert before an attempt");
	await sendAllFails(canvas, { __http: 501, error: "batch-delivery-unavailable" });
	assert.equal(alert.root.hidden, false);
	alert.dismiss.dispatch("click");
	assert.equal(alert.root.hidden, true, "the dismiss button closes it");

	await sendAllFails(canvas, { __http: 501, error: "batch-delivery-unavailable" });
	assert.equal(alert.root.hidden, false);
	canvas.replies[SEND_ALL] = { ok: true, sent: 1, ids: ["u1"] };
	canvas.document.getElementById("gd-send-all").dispatch("click");
	assert.equal(alert.root.hidden, true, "the next attempt clears it at once");
	for (let i = 0; i < 5; i++) await flush();
	assert.equal(alert.root.hidden, true);
	const toast = canvas.document.getElementById("gd-toast");
	assert.equal(toast.hidden, false);
	assert.equal(toast.textContent, "Sent 1 comment to the session");
	assert.equal(statusLine(canvas).textContent, "", "S14: no result in the status line");
});

test("S13: a failed resolve shows the alert inside that comment's card, dismissible and cleared by the next attempt", async () => {
	const canvas = await loadRail(300, commentsDoc(comment("c1", "01-a.html"), comment("c2", "01-a.html")));
	const list = canvas.document.getElementById("gd-comment-list");
	const visible = () => withClass(list, "gd-alert").filter((alert) => !alert.hidden).length;
	const resolve = (index: number) => findAll(list, (element) => element.localName === "button" && element.textContent === "Resolve")[index];
	canvas.replies["/t/api/designs/alpha/comments/c1/status"] = { __http: 404, error: "not-found" };
	resolve(0).dispatch("click");
	for (let i = 0; i < 5; i++) await flush();
	const cards = withClass(list, "gd-comment-item");
	assert.equal(withClass(cards[0], "gd-alert").length, 1, "the alert is in the failing card");
	assert.equal(withClass(cards[1], "gd-alert").length, 0, "and only there");
	const alert = withClass(cards[0], "gd-alert")[0];
	assert.equal(alert.getAttribute("role"), "alert");
	assert.match(texts(alert, "gd-alert-text")[0], /no longer exists/i);
	assert.ok(texts(alert, "gd-alert-detail")[0].includes("not-found"));
	assert.equal(withClass(alert, "gd-i").length, 2, "an error icon and the dismiss icon, from the sprite");
	assert.equal(statusLine(canvas).textContent, "", "S14");

	// Re-rendering the list (a comments.json change) keeps the alert until it is dismissed.
	await canvas.serverEvent("change", { slug: "alpha", file: "comments.json" });
	assert.equal(withClass(withClass(list, "gd-comment-item")[0], "gd-alert").length, 1);
	findAll(withClass(list, "gd-comment-item")[0], (element) => element.classes.has("gd-alert-dismiss"))[0].dispatch("click");
	assert.equal(visible(), 0, "dismissed");

	resolve(0).dispatch("click");
	for (let i = 0; i < 5; i++) await flush();
	assert.equal(visible(), 1);
	canvas.replies["/t/api/designs/alpha/comments/c1/status"] = { ok: true };
	resolve(0).dispatch("click");
	assert.equal(visible(), 0, "the next attempt clears it");
	for (let i = 0; i < 5; i++) await flush();
	assert.equal(canvas.document.getElementById("gd-toast").textContent, "Comment resolved");
});

test("S13: a failed Implement this shows the alert in that artboard's implement control, without repeating it in a toast", async () => {
	const canvas = await loadRail();
	const [control] = withClass(boardsOf(canvas)[0], "gd-implement");
	const attempt = async () => {
		withClass(control, "gd-implement-start")[0].dispatch("click");
		withClass(control, "gd-primary")[0].dispatch("click");
		for (let i = 0; i < 5; i++) await flush();
	};
	canvas.replies[IMPLEMENT] = { __http: 501, error: "implement-unavailable" };
	await attempt();
	const alerts = withClass(control, "gd-alert");
	assert.equal(alerts.length, 1);
	assert.equal(alerts[0].getAttribute("role"), "alert");
	assert.equal(alerts[0].hidden, false);
	assert.match(texts(control, "gd-alert-text")[0], /not connected to a Pi session/);
	assert.equal(withClass(boardsOf(canvas)[1], "gd-alert").length, 1, "each artboard has its own, hidden until it fails");
	assert.equal(withClass(boardsOf(canvas)[1], "gd-alert")[0].hidden, true);
	assert.equal(canvas.document.getElementById("gd-toast").textContent, "", "the alert is in view, so no toast repeats it");
	assert.equal(statusLine(canvas).textContent, "", "S14");
	withClass(control, "gd-alert-dismiss")[0].dispatch("click");
	assert.equal(alerts[0].hidden, true);

	await attempt();
	assert.equal(alerts[0].hidden, false);
	canvas.replies[IMPLEMENT] = { ok: true, slug: "alpha", file: "01-a.html", queued: false };
	await attempt();
	assert.equal(alerts[0].hidden, true, "the next attempt clears it");
	assert.equal(canvas.document.getElementById("gd-toast").textContent, "Sent: the session is implementing First now.");
});

test("S12/S13: the comment popover keeps its message line, in S12 wording", async () => {
	const canvas = await loadRail();
	const [first] = canvas.boards;
	canvas.document.getElementById("gd-comment").dispatch("click");
	canvas.message(first.frame.contentWindow, { type: "gd:pick", selector: "#cta", excerpt: "", rect: { x: 1, y: 2, width: 3, height: 4 } });
	const message = canvas.document.getElementById("gd-popover-message");
	canvas.document.getElementById("gd-popover-text").value = "Bigger";
	canvas.replies["/t/api/comments"] = { __http: 400, error: "invalid-screenshot", reason: "too big" };
	canvas.document.getElementById("gd-popover-form").dispatch("submit");
	for (let i = 0; i < 5; i++) await flush();
	assert.match(message.textContent, /screenshot[^]*PNG, JPEG, WebP or GIF/i);
	assert.ok(message.classes.has("gd-error"));
	assert.ok(message.title.includes("invalid-screenshot"));
	assert.equal(canvas.document.getElementById("gd-popover").hidden, false, "the popover stays open to retry");
	assert.equal(statusLine(canvas).textContent, "", "S14");

	canvas.replies["/t/api/comments"] = { __throw: "Failed to fetch" };
	canvas.document.getElementById("gd-popover-form").dispatch("submit");
	for (let i = 0; i < 5; i++) await flush();
	assert.match(message.textContent, /could not reach/i);

	canvas.replies["/t/api/comments"] = { __http: 500, error: "delivery-failed", saved: true, sent: false };
	canvas.document.getElementById("gd-popover-form").dispatch("submit");
	for (let i = 0; i < 5; i++) await flush();
	assert.match(message.textContent, /^Saved, but not sent/);
	assert.ok(message.classes.has("gd-error"));
	assert.equal(statusLine(canvas).textContent, "", "S14");
});

test("S14: the top status line keeps canvas state (live reload) and Comment mode no longer wipes it", async () => {
	const canvas = await loadRail();
	await canvas.serverEvent("error", {});
	assert.equal(statusLine(canvas).textContent, "Live reload disconnected, retrying…");
	assert.ok(statusLine(canvas).classes.has("gd-error"));
	canvas.document.getElementById("gd-comment").dispatch("click");
	canvas.document.getElementById("gd-comment").dispatch("click");
	assert.equal(statusLine(canvas).textContent, "Live reload disconnected, retrying…", "toggling Comment mode leaves canvas state alone");
	await canvas.serverEvent("open", {});
	assert.equal(statusLine(canvas).textContent, "", "reconnecting clears it");
});

test("S15: without batch delivery Send all is disabled up front and the footer explains why; Implement this explains too", async () => {
	const delivery = { comment: true, batch: false, implement: false };
	const canvas = await loadRail(300, commentsDoc(unsentComment), { delivery });
	const sendAll = canvas.document.getElementById("gd-send-all");
	const note = canvas.document.getElementById("gd-send-note");
	assert.equal(sendAll.disabled, true, "an unsent comment does not enable it");
	assert.equal(note.hidden, false);
	assert.match(note.textContent, /not connected to a Pi session[^]*\/gentle:design open/);
	assert.ok(note.title.includes("batch-delivery-unavailable"));
	assert.match(read("index.html"), /id="gd-send-all"[^>]*aria-describedby="gd-send-note"/);
	assert.equal(canvas.document.getElementById("gd-send-alert").hidden, true);

	const [control] = withClass(boardsOf(canvas)[0], "gd-implement");
	const start = withClass(control, "gd-implement-start")[0];
	assert.equal(start.disabled, true);
	assert.match(texts(control, "gd-implement-note")[0], /not connected to a Pi session/);
	// The visible line stays short so it never runs over the artboard header; the full way out is in its tooltip.
	assert.match(withClass(control, "gd-implement-note")[0].title, /\/gentle:design open/);
	assert.ok(start.title.includes("implement-unavailable"));
	assert.equal(start.getAttribute("aria-describedby"), withClass(control, "gd-implement-note")[0].id);
	start.dispatch("click");
	assert.equal(canvas.fetched.filter((url) => url === IMPLEMENT).length, 0, "nothing is sent");
});

test("S15: with every delivery available, or no capabilities in the config, nothing is disabled or explained", async () => {
	for (const config of [{}, { delivery: { comment: true, batch: true, implement: true } }]) {
		const canvas = await loadRail(300, commentsDoc(unsentComment), config);
		assert.equal(canvas.document.getElementById("gd-send-all").disabled, false);
		assert.equal(canvas.document.getElementById("gd-send-note").hidden, true);
		const [control] = withClass(boardsOf(canvas)[0], "gd-implement");
		assert.equal(withClass(control, "gd-implement-start")[0].disabled, false);
		assert.deepEqual(texts(control, "gd-implement-note"), []);
	}
});

test("S15: only the missing delivery is disabled", async () => {
	const canvas = await loadRail(300, commentsDoc(unsentComment), { delivery: { comment: true, batch: true, implement: false } });
	assert.equal(canvas.document.getElementById("gd-send-all").disabled, false);
	assert.equal(withClass(withClass(boardsOf(canvas)[0], "gd-implement")[0], "gd-implement-start")[0].disabled, true);
});

test("S12: a handoff the session refuses is explained as a handoff that was not recorded, never as unsent comments", async () => {
	const canvas = await loadRail();
	const [control] = withClass(boardsOf(canvas)[0], "gd-implement");
	canvas.replies[IMPLEMENT] = { __http: 500, error: "delivery-failed" };
	withClass(control, "gd-implement-start")[0].dispatch("click");
	withClass(control, "gd-primary")[0].dispatch("click");
	for (let i = 0; i < 5; i++) await flush();
	const text = texts(control, "gd-alert-text")[0];
	assert.match(text, /did not accept the handoff[^]*not recorded[^]*Implement this again/);
	assert.doesNotMatch(text, /comments/i);
	assert.equal(texts(control, "gd-alert-detail")[0], "delivery-failed");
	assert.equal(canvas.document.getElementById("gd-toast").textContent, "", "no toast while the alert is in view");
});

test("a failed Implement this toasts only while its artboard is collapsed by zoom and the alert cannot be seen", async () => {
	const canvas = await loadRail();
	const toast = canvas.document.getElementById("gd-toast");
	const [control] = withClass(boardsOf(canvas)[0], "gd-implement");
	canvas.replies[IMPLEMENT] = { __http: 500, error: "delivery-failed" };
	// Open the confirm step at full size, then zoom out until the artboard collapses before confirming.
	withClass(control, "gd-implement-start")[0].dispatch("click");
	for (let step = 0; step < 8; step += 1) canvas.viewport.dispatch("wheel", { deltaX: 0, deltaY: 50, deltaMode: 0, ctrlKey: true, metaKey: false, shiftKey: false, clientX: 300, clientY: 300 });
	assert.equal(boardsOf(canvas)[0].classes.has("gd-compact"), true);
	withClass(control, "gd-primary")[0].dispatch("click");
	for (let i = 0; i < 5; i++) await flush();
	assert.equal(toast.hidden, false);
	assert.equal(toast.textContent, texts(control, "gd-alert-text")[0]);
});

test("focus mode hides the artboard list only when the focused artboard would not fit beside it, and restores it on exit", async () => {
	const canvas = await loadRail();
	const nav = canvas.document.getElementById("gd-nav");
	const [first] = canvas.boards;
	assert.equal(nav.hidden, false);

	click(first.shield!, 200, 200);
	assert.equal(nav.hidden, false, "a 400 px artboard fits a 1000 px canvas: the list stays");
	canvas.document.getElementById("gd-back").dispatch("click");

	canvas.viewport.rect = { left: 0, top: 50, width: 380, height: 700 };
	click(first.shield!, 200, 200);
	assert.equal(nav.hidden, true, "too narrow: the list gives its room to the artboard");
	assert.equal(canvas.document.getElementById("gd-nav-toggle").getAttribute("aria-pressed"), "false");
	canvas.document.getElementById("gd-back").dispatch("click");
	assert.equal(nav.hidden, false, "exit restores it");

	canvas.document.getElementById("gd-nav-toggle").dispatch("click");
	click(first.shield!, 200, 200);
	canvas.document.getElementById("gd-back").dispatch("click");
	assert.equal(nav.hidden, true, "a list the user had hidden stays hidden");
});

// Screen sizes (T1): the size control, one size at a time, All sizes, comments and pins per size, the overflow flag.

/** First artboard 1200 x 800 so Desktop is wider than the 1000 px test viewport. */
const wideAlpha = { "/t/api/designs/alpha": { slug: "alpha", title: "Alpha", brief: "", artboards: [
	{ file: "01-a.html", title: "First", tradeoff: "", width: 1200, height: 800 },
	{ file: "02-b.html", title: "Second", tradeoff: "", width: 400, height: 300 },
] } };
const focusOn = (canvas: Canvas, index = 0) => click(canvas.boards[index].shield!, 200, 200);
const sizeButtons = (canvas: Canvas, index = 0) => withClass(canvas.boards[index].wrapper, "gd-size-button");
const sizeButton = (canvas: Canvas, size: string, index = 0) => sizeButtons(canvas, index).find((button) => button.dataset.size === size)!;
const pressedSizes = (canvas: Canvas, index = 0) => sizeButtons(canvas, index).filter((button) => button.getAttribute("aria-pressed") === "true").map((button) => button.dataset.size);
const readout = (canvas: Canvas, index = 0) => withClass(canvas.boards[index].wrapper, "gd-size-readout")[0].textContent;
const customInput = (canvas: Canvas, index = 0) => withClass(canvas.boards[index].wrapper, "gd-size-input")[0];
const sizeError = (canvas: Canvas, index = 0) => withClass(canvas.boards[index].wrapper, "gd-size-error")[0];
const tallViewport = (canvas: Canvas) => { canvas.viewport.rect = { left: 0, top: 50, width: 1000, height: 1400 }; };
const sizeSections = (canvas: Canvas) => withClass(canvas.viewport, "gd-size-frame");
const iframeOf = (root: FakeElement) => findAll(root, (element) => element.localName === "iframe")[0];
const overflowChip = (root: FakeElement) => withClass(root, "gd-overflow-flag")[0];
const report = (width: number, scrollWidth: number) => ({ type: "gd:overflow", overflow: scrollWidth > width, width, scrollWidth });

test("S1: the focused artboard's header offers Phone, Tablet, Desktop, All sizes and a custom width, Desktop selected", async () => {
	const canvas = await loadRail();
	const wrapper = canvas.boards[0].wrapper;
	assert.equal(wrapper.classes.has("gd-focus-board"), false, "the control belongs to focus mode");
	focusOn(canvas);
	assert.equal(wrapper.classes.has("gd-focus-board"), true);
	const group = withClass(wrapper, "gd-devices")[0];
	assert.equal(group.getAttribute("role"), "group");
	assert.equal(group.getAttribute("aria-label"), "Preview size");
	const buttons = sizeButtons(canvas);
	assert.deepEqual(buttons.map((button) => button.dataset.size), ["phone", "tablet", "desktop", "all"]);
	assert.deepEqual(buttons.map((button) => texts(button, "gd-size-label")[0]), ["Phone", "Tablet", "Desktop", "All sizes"]);
	assert.deepEqual(buttons.map((button) => button.title), ["Phone 390 × 844", "Tablet 820 × 1180", "Desktop 400 × 300", "All sizes: Phone, Tablet and Desktop side by side"]);
	assert.ok(buttons.every((button) => button.type === "button"));
	assert.deepEqual(pressedSizes(canvas), ["desktop"], "Desktop is selected when focus mode starts");
	for (const button of buttons.slice(0, 3)) assert.equal(withClass(button, "gd-i")[0].getAttribute("aria-hidden"), "true", "icons are decoration");
	const input = customInput(canvas);
	assert.equal(input.getAttribute("aria-label"), "Custom width in pixels");
	assert.deepEqual([input.type, input.getAttribute("min"), input.getAttribute("max"), input.getAttribute("step")], ["number", "240", "2560", "1"]);
	assert.equal(readout(canvas), "400 × 300", "the current size reads width × height");
});

test("S1: Desktop is the artboard's own manifest size, and each focus session starts at Desktop", async () => {
	const canvas = await loadRail(300, wideAlpha);
	focusOn(canvas);
	assert.equal(readout(canvas), "1200 × 800");
	assert.equal(sizeButton(canvas, "desktop").title, "Desktop 1200 × 800");
	sizeButton(canvas, "phone").dispatch("click");
	canvas.document.getElementById("gd-back").dispatch("click");
	focusOn(canvas);
	assert.deepEqual(pressedSizes(canvas), ["desktop"]);
	assert.equal(readout(canvas), "1200 × 800");
});

test("S2: Phone, Tablet and Desktop resize the focused iframe in place, centered at 100%", async () => {
	const canvas = await loadRail();
	tallViewport(canvas);
	const [first] = canvas.boards;
	const src = first.frame.src;
	focusOn(canvas);
	sizeButton(canvas, "phone").dispatch("click");
	assert.equal(first.frame.style.width, "390px");
	assert.equal(first.frame.style.height, "844px");
	assert.equal(canvas.world.style.transform, "translate(305px, 278px) scale(1)");
	assert.equal(canvas.zoomLevel.textContent, "100%");
	assert.deepEqual(pressedSizes(canvas), ["phone"]);
	assert.equal(readout(canvas), "390 × 844");

	sizeButton(canvas, "tablet").dispatch("click");
	assert.equal(first.frame.style.width, "820px");
	assert.equal(first.frame.style.height, "1180px");
	assert.equal(canvas.world.style.transform, "translate(90px, 110px) scale(1)");
	assert.deepEqual(pressedSizes(canvas), ["tablet"]);
	assert.equal(readout(canvas), "820 × 1180");

	sizeButton(canvas, "desktop").dispatch("click");
	assert.equal(first.frame.style.width, "400px");
	assert.equal(first.frame.style.height, "300px");
	assert.deepEqual(pressedSizes(canvas), ["desktop"]);
	assert.equal(readout(canvas), "400 × 300");
	assert.equal(first.frame.src, src, "the artboard is not reloaded");
	assert.equal(canvas.frames()[0], first.frame, "and keeps its iframe");
});

test("S2: a size taller than the viewport keeps today's clip, and one wider than it starts at the left margin", async () => {
	const canvas = await loadRail(300, wideAlpha);
	const [first] = canvas.boards;
	first.frame.parentElement!.offsetLeft = 480;
	first.frame.parentElement!.offsetTop = 20;
	focusOn(canvas);
	// Desktop is 1200 wide in a 1000 px viewport: the left margin, 16 - 480.
	assert.match(canvas.world.style.transform, /^translate\(-464px, /);
	sizeButton(canvas, "phone").dispatch("click");
	assert.equal(first.frame.style.height, "600px", "844 px does not fit the 700 px viewport (less the 16 px margin, the 20 px label and the 64 px band): clipped like a tall artboard");
	assert.equal(readout(canvas), "390 × 844", "the readout keeps the preset height");
	assert.equal(canvas.world.style.transform, "translate(-175px, 16px) scale(1)");
});

test("S2: a custom width resizes the iframe with the manifest height; the field accepts whole px from 240 to 2560 only", async () => {
	const canvas = await loadRail();
	tallViewport(canvas);
	const [first] = canvas.boards;
	focusOn(canvas);
	const input = customInput(canvas);
	input.value = "600";
	input.dispatch("change");
	assert.equal(first.frame.style.width, "600px");
	assert.equal(first.frame.style.height, "300px", "height keeps the artboard's manifest height");
	assert.deepEqual(pressedSizes(canvas), [], "no preset is selected");
	assert.equal(readout(canvas), "600 × 300");
	assert.ok(withClass(canvas.boards[0].wrapper, "gd-size-custom")[0].classes.has("gd-selected"));
	assert.equal(canvas.world.style.transform, "translate(200px, 550px) scale(1)");

	for (const bad of ["239", "2561", "abc", "500.5", "", "-300", "1e3"]) {
		input.value = bad;
		input.dispatch("change");
		assert.equal(first.frame.style.width, "600px", `${JSON.stringify(bad)} is refused`);
		assert.equal(readout(canvas), "600 × 300");
		assert.equal(input.getAttribute("aria-invalid"), "true");
		assert.equal(sizeError(canvas).hidden, false);
		assert.match(sizeError(canvas).textContent, /whole number from 240 to 2560/);
	}
	for (const edge of ["240", "2560"]) {
		input.value = edge;
		input.dispatch("keydown", { key: "Enter" });
		assert.equal(first.frame.style.width, `${edge}px`, `${edge} is accepted with Enter`);
		assert.equal(input.getAttribute("aria-invalid"), null);
		assert.equal(sizeError(canvas).hidden, true);
	}
	// A wider size than the viewport starts at the left margin, like a wide artboard.
	assert.match(canvas.world.style.transform, /^translate\(16px, /);
	sizeButton(canvas, "phone").dispatch("click");
	assert.equal(input.value, "", "a preset clears the custom field");
	assert.ok(!withClass(canvas.boards[0].wrapper, "gd-size-custom")[0].classes.has("gd-selected"));
});

test("S2: leaving focus mode, or focusing another artboard, restores the manifest size", async () => {
	const canvas = await loadRail();
	tallViewport(canvas);
	const [first, second] = canvas.boards;
	focusOn(canvas);
	sizeButton(canvas, "tablet").dispatch("click");
	canvas.document.getElementById("gd-back").dispatch("click");
	assert.equal(first.frame.style.width, "400px");
	assert.equal(first.frame.style.height, "300px");

	focusOn(canvas);
	sizeButton(canvas, "phone").dispatch("click");
	navItems(canvas)[1].dispatch("click");
	assert.equal(first.frame.style.width, "400px", "the artboard left behind is restored");
	assert.equal(first.frame.style.height, "300px");
	assert.deepEqual(pressedSizes(canvas, 1), ["desktop"], "the new focus starts at Desktop");
	assert.equal(second.frame.style.width, "400px");
	canvas.message(second.frame.contentWindow, { type: "gd:exit-focus" });
	assert.equal(second.frame.style.width, "400px");
});

test("S2: the size survives a manifest refresh of the focused artboard", async () => {
	const canvas = await loadRail();
	tallViewport(canvas);
	focusOn(canvas);
	sizeButton(canvas, "phone").dispatch("click");
	await canvas.serverEvent("show", { slug: "alpha" });
	assert.equal(canvas.frames()[0].style.width, "390px");
	assert.deepEqual(pressedSizes(canvas), ["phone"]);
	assert.equal(readout(canvas), "390 × 844");
});

test("S3: All sizes shows Phone, Tablet and Desktop as real iframes at their true widths, scaled to fit together and labeled", async () => {
	const canvas = await loadRail(300, wideAlpha);
	const [first] = canvas.boards;
	focusOn(canvas);
	const src = first.frame.src;
	sizeButton(canvas, "all").dispatch("click");
	assert.deepEqual(pressedSizes(canvas), ["all"]);
	assert.equal(readout(canvas), "All sizes");
	assert.ok(first.wrapper.classes.has("gd-all-sizes"));
	const sections = sizeSections(canvas);
	assert.deepEqual(sections.map((section) => section.getAttribute("aria-label")), ["Phone 390 by 844", "Tablet 820 by 1180", "Desktop 1200 by 800"]);
	const frames = sections.map(iframeOf);
	assert.deepEqual(frames.map((frame) => [frame.style.width, frame.style.height]), [["390px", "844px"], ["820px", "1180px"], ["1200px", "800px"]]);
	for (const frame of frames) {
		assert.equal(frame.getAttribute("sandbox"), "allow-scripts");
		assert.equal(frame.getAttribute("referrerpolicy"), "no-referrer");
		assert.equal(frame.src, "/t/files/alpha/01-a.html");
	}
	assert.deepEqual(frames.map((frame) => frame.title), ["First artboard at Phone 390 × 844", "First artboard at Tablet 820 × 1180", "First artboard at Desktop 1200 × 800"]);

	// One scale for the three, small enough that they fit the viewport together.
	const stages = sections.map((section) => withClass(section, "gd-size-stage")[0]);
	const scales = stages.map((stage) => Number(/^scale\(([\d.]+)\)$/.exec(stage.style.transform)![1]));
	assert.ok(scales.every((scale) => scale === scales[0] && scale > 0 && scale < 1));
	const boxes = sections.map((section) => withClass(section, "gd-size-scaled")[0]);
	const widths = boxes.map((box, index) => Number.parseInt(box.style.width, 10));
	const heights = boxes.map((box) => Number.parseInt(box.style.height, 10));
	assert.deepEqual(widths, [390, 820, 1200].map((width) => Math.round(width * scales[0])));
	assert.deepEqual(heights, [844, 1180, 800].map((height) => Math.round(height * scales[0])));
	assert.ok(widths.reduce((sum, width) => sum + width, 0) <= 1000 - 32, "side by side within the viewport width");
	assert.ok(Math.max(...heights) <= 700 - 64 - 16 - 28, "and above the Back to canvas band");
	const percent = Math.round(scales[0] * 100);
	assert.deepEqual(sections.map((section) => texts(section, "gd-size-name")[0]), ["Phone", "Tablet", "Desktop"]);
	assert.deepEqual(sections.map((section) => texts(section, "gd-size-dim")[0]), ["390 × 844", "820 × 1180", "1200 × 800"]);
	assert.deepEqual(sections.map((section) => texts(section, "gd-size-scale")[0]), [`· ${percent}%`, `· ${percent}%`, `· ${percent}%`]);
	assert.equal(withClass(sections[0], "gd-i").length, 1, "each label carries its icon");

	assert.equal(first.frame.src, src, "the artboard's own iframe is not reloaded");
	sizeButton(canvas, "desktop").dispatch("click");
	assert.equal(sizeSections(canvas).length, 0, "leaving All sizes removes the extra frames");
	assert.ok(!first.wrapper.classes.has("gd-all-sizes"));
	assert.equal(first.frame.style.width, "1200px");
	assert.equal(first.frame.src, src);
});

test("S3: Back to canvas and focusing another artboard leave All sizes and restore the manifest size", async () => {
	const canvas = await loadRail(300, wideAlpha);
	const [first] = canvas.boards;
	focusOn(canvas);
	sizeButton(canvas, "all").dispatch("click");
	assert.equal(sizeSections(canvas).length, 3);
	canvas.document.getElementById("gd-back").dispatch("click");
	assert.equal(sizeSections(canvas).length, 0);
	assert.equal(first.frame.style.width, "1200px");
	assert.ok(!first.wrapper.classes.has("gd-all-sizes"));

	focusOn(canvas);
	sizeButton(canvas, "all").dispatch("click");
	navItems(canvas)[1].dispatch("click");
	assert.equal(sizeSections(canvas).length, 0, "another artboard starts at Desktop");
	assert.ok(!first.wrapper.classes.has("gd-all-sizes"));
	assert.deepEqual(pressedSizes(canvas, 1), ["desktop"]);
});

test("S3: All sizes follows the viewport and a manifest refresh, and live reload reloads the size frames", async () => {
	const canvas = await loadRail(300, wideAlpha);
	focusOn(canvas);
	sizeButton(canvas, "all").dispatch("click");
	const scaleOf = () => Number(/^scale\(([\d.]+)\)$/.exec(withClass(sizeSections(canvas)[0], "gd-size-stage")[0].style.transform)![1]);
	const before = scaleOf();
	canvas.viewport.rect = { left: 0, top: 50, width: 700, height: 700 };
	canvas.windowEvent("resize");
	assert.ok(scaleOf() < before, "a narrower viewport scales the sizes down");

	await canvas.serverEvent("change", { slug: "alpha", file: "01-a.html" });
	assert.ok(sizeSections(canvas).map(iframeOf).every((frame) => /^\/t\/files\/alpha\/01-a\.html\?v=\d+$/.test(frame.src)), "every size frame reloads");
	assert.equal(sizeSections(canvas).length, 3);

	await canvas.serverEvent("show", { slug: "alpha" });
	assert.equal(sizeSections(canvas).length, 3, "a refresh keeps All sizes, with no orphaned frames");
	assert.equal(canvas.viewport.children.filter((child) => child.classes.has("gd-sizes-all")).length, 1);
});

test("S3/S4: size frames are registered like the artboard's frame: they get focus, mode and pins when they load", async () => {
	const canvas = await loadRail(300, { ...wideAlpha, ...commentsDoc(comment("a1", "01-a.html")) });
	focusOn(canvas);
	sizeButton(canvas, "all").dispatch("click");
	const frames = sizeSections(canvas).map(iframeOf);
	for (const frame of frames) {
		frame.dispatch("load");
		const posted = frame.contentWindow!.posted;
		assert.deepEqual(posted.filter((message) => message.type === "gd:focus").at(-1), { type: "gd:focus", enabled: true });
		assert.deepEqual(posted.filter((message) => message.type === "gd:mode").at(-1), { type: "gd:mode", enabled: false });
		assert.deepEqual(posted.filter((message) => message.type === "gd:pins").at(-1), { type: "gd:pins", pins: [{ id: "a1", selector: "main > .a1" }] });
	}
	canvas.document.getElementById("gd-comment").dispatch("click");
	for (const frame of frames) assert.deepEqual(frame.contentWindow!.posted.at(-1), { type: "gd:mode", enabled: true });
	assert.ok(withClass(canvas.viewport, "gd-sizes-all")[0].classes.has("gd-commenting"), "the frames wear the comment-mode outline");
	canvas.document.getElementById("gd-tool-navigate").dispatch("click");
	for (const frame of frames) assert.deepEqual(frame.contentWindow!.posted.at(-1), { type: "gd:mode", enabled: false });
});

test("S4: in All sizes every size frame takes picks; the popover opens beside the picked element in that frame", async () => {
	const canvas = await loadRail(300, wideAlpha);
	focusOn(canvas);
	sizeButton(canvas, "all").dispatch("click");
	const [phone, tablet, desktop] = sizeSections(canvas).map(iframeOf);
	const popover = canvas.document.getElementById("gd-popover");
	const pick = { type: "gd:pick", selector: "#cta", excerpt: "Buy", rect: { x: 30, y: 40, width: 60, height: 20 } };

	canvas.message(phone.contentWindow, pick);
	assert.equal(popover.hidden, true, "a pick needs Comment mode");
	canvas.document.getElementById("gd-comment").dispatch("click");
	canvas.message({}, pick);
	assert.equal(popover.hidden, true, "a stranger window is ignored");

	phone.rect = { left: 100, top: 200, width: 150, height: 325 };
	canvas.message(phone.contentWindow, pick);
	assert.equal(popover.hidden, false);
	assert.equal(canvas.document.getElementById("gd-popover-target").textContent, "01-a.html · #cta");
	// The frame is shown at 150/390 of its width.
	assert.equal(popover.style.left, `${100 + 30 * (150 / 390)}px`);
	assert.equal(popover.style.top, `${200 + (40 + 20) * (150 / 390) + 8}px`);

	canvas.document.getElementById("gd-popover-text").value = "Tighter";
	canvas.document.getElementById("gd-popover-form").dispatch("submit");
	await flush();
	assert.deepEqual(canvas.posts.map((post) => [post.url, (post.body as any).file, (post.body as any).selector]), [["/t/api/comments", "01-a.html", "#cta"]]);

	canvas.document.getElementById("gd-popover-cancel").dispatch("click");
	assert.deepEqual(phone.contentWindow!.posted.at(-1), { type: "gd:clear" }, "the frame that was picked clears its outline");
	desktop.rect = { left: 300, top: 100, width: 400, height: 267 };
	canvas.message(desktop.contentWindow, pick);
	assert.equal(popover.hidden, false, "the Desktop frame takes picks too");
	assert.equal(popover.style.left, `${300 + 30 * (400 / 1200)}px`);
	assert.match(canvas.navMode.textContent, /^Using:/);
	canvas.message(tablet.contentWindow, { type: "gd:exit-focus" });
	assert.doesNotMatch(canvas.navMode.textContent, /^Using:/, "Shift+Esc from a size frame leaves focus mode");
	assert.equal(sizeSections(canvas).length, 0);
});

test("S4: at a single size the artboard's own frame takes picks at that size's scale", async () => {
	const canvas = await loadRail();
	tallViewport(canvas);
	const [first] = canvas.boards;
	focusOn(canvas);
	sizeButton(canvas, "phone").dispatch("click");
	canvas.document.getElementById("gd-comment").dispatch("click");
	first.frame.rect = { left: 100, top: 100, width: 195, height: 422 };
	canvas.message(first.frame.contentWindow, { type: "gd:pick", selector: "#cta", excerpt: "", rect: { x: 40, y: 10, width: 20, height: 20 } });
	const popover = canvas.document.getElementById("gd-popover");
	assert.equal(popover.hidden, false);
	assert.equal(popover.style.left, `${100 + 40 * (195 / 390)}px`, "scaled against the 390 px frame, not the manifest width");
});

test("S4: a pick from another artboard is refused while one is focused, also from its size frames", async () => {
	const canvas = await loadRail(300, wideAlpha);
	focusOn(canvas);
	sizeButton(canvas, "all").dispatch("click");
	canvas.document.getElementById("gd-comment").dispatch("click");
	canvas.message(canvas.boards[1].frame.contentWindow, { type: "gd:pick", selector: "#x", excerpt: "", rect: { x: 0, y: 0, width: 1, height: 1 } });
	assert.equal(canvas.document.getElementById("gd-popover").hidden, true);
});

test("S4: the pins of the artboard show on every size frame at their element's position in that frame", async () => {
	const canvas = await loadRail(300, { ...wideAlpha, ...commentsDoc(comment("a1", "01-a.html"), comment("b1", "02-b.html")) });
	focusOn(canvas);
	sizeButton(canvas, "all").dispatch("click");
	const sections = sizeSections(canvas);
	const [phone, tablet, desktop] = sections.map(iframeOf);
	const pinsOf = (section: FakeElement) => withClass(section, "gd-pin");
	assert.deepEqual(sections.map((section) => pinsOf(section).length), [0, 0, 0], "none until a frame reports where the element is");

	canvas.message(phone.contentWindow, { type: "gd:pin-rects", rects: [{ id: "a1", rect: { x: 30, y: 40, width: 60, height: 20 } }] });
	canvas.message(desktop.contentWindow, { type: "gd:pin-rects", rects: [{ id: "a1", rect: { x: 300, y: 10, width: 60, height: 20 } }] });
	assert.deepEqual(pinsOf(sections[0]).map((pin) => [pin.style.left, pin.style.top, pin.textContent]), [["30px", "40px", "1"]]);
	assert.deepEqual(pinsOf(sections[1]), [], "the Tablet frame has not reported yet");
	assert.deepEqual(pinsOf(sections[2]).map((pin) => [pin.style.left, pin.style.top]), [["300px", "10px"]]);
	assert.match(pinsOf(sections[0])[0].getAttribute("aria-label")!, /^Comment 1 \(open\): Text of a1$/);

	// An element outside the frame at that size has no pin there; the other artboard's comments never show.
	canvas.message(tablet.contentWindow, { type: "gd:pin-rects", rects: [{ id: "a1", rect: { x: 900, y: 10, width: 60, height: 20 } }, { id: "b1", rect: { x: 5, y: 5, width: 5, height: 5 } }] });
	assert.deepEqual(pinsOf(sections[1]), []);
	canvas.message(phone.contentWindow, { type: "gd:pin-rects", rects: [{ id: "a1", rect: { x: 500, y: 40, width: 60, height: 20 } }] });
	assert.deepEqual(pinsOf(sections[0]), [], "x 500 is outside the 390 px frame");
	canvas.message(phone.contentWindow, { type: "gd:pin-rects", rects: [{ id: "a1", rect: { x: 30, y: 40, width: 60, height: 20 } }] });

	// Selecting a pin highlights the element in every frame.
	pinsOf(sections[0])[0].dispatch("click");
	for (const frame of [phone, tablet, desktop, canvas.boards[0].frame]) assert.deepEqual(frame.contentWindow!.posted.at(-1), { type: "gd:highlight", id: "a1" });

	// New comments reach every frame.
	await setComments(canvas, comment("a1", "01-a.html"), comment("a2", "01-a.html"));
	for (const frame of [phone, tablet, desktop]) assert.equal((frame.contentWindow!.posted.filter((message) => message.type === "gd:pins").at(-1)).pins.length, 2);
});

test("S4: at a single size the pins follow the resized frame and hide when outside it", async () => {
	const canvas = await loadRail(300, commentsDoc(comment("a1", "01-a.html")));
	tallViewport(canvas);
	const [first] = canvas.boards;
	focusOn(canvas);
	sizeButton(canvas, "phone").dispatch("click");
	const pins = () => withClass(first.wrapper, "gd-pin");
	canvas.message(first.frame.contentWindow, { type: "gd:pin-rects", rects: [{ id: "a1", rect: { x: 300, y: 20, width: 40, height: 20 } }] });
	assert.deepEqual(pins().map((pin) => pin.style.left), ["300px"]);
	canvas.message(first.frame.contentWindow, { type: "gd:pin-rects", rects: [{ id: "a1", rect: { x: 500, y: 20, width: 40, height: 20 } }] });
	assert.deepEqual(pins(), [], "outside the 390 px frame");
	sizeButton(canvas, "tablet").dispatch("click");
	canvas.message(first.frame.contentWindow, { type: "gd:pin-rects", rects: [{ id: "a1", rect: { x: 500, y: 20, width: 40, height: 20 } }] });
	assert.deepEqual(pins().map((pin) => pin.style.left), ["500px"], "inside the 820 px frame");
});

test("S5: a size whose page is wider than its frame shows an Overflows chip titled with the width; none when it fits", async () => {
	const canvas = await loadRail();
	tallViewport(canvas);
	const [first] = canvas.boards;
	const chip = overflowChip(first.wrapper);
	assert.equal(chip.hidden, true);
	focusOn(canvas);
	sizeButton(canvas, "phone").dispatch("click");
	assert.equal(chip.hidden, true, "no chip before the page reports");

	canvas.message(first.frame.contentWindow, report(390, 520));
	assert.equal(chip.hidden, false);
	assert.deepEqual(texts(chip, "gd-overflow-text"), ["Overflows"]);
	assert.match(chip.title, /wider than 390 px/);
	assert.match(texts(chip, "gd-visually-hidden")[0], /wider than 390 px/, "the explanation reaches assistive technology too");

	canvas.message(first.frame.contentWindow, report(390, 390));
	assert.equal(chip.hidden, true, "no chip when it fits");
	canvas.message(first.frame.contentWindow, report(390, 520));
	assert.equal(chip.hidden, false);

	// Reports for another width are stale; strangers and malformed reports are ignored.
	sizeButton(canvas, "tablet").dispatch("click");
	assert.equal(chip.hidden, true, "a new size clears the chip until the page reports again");
	canvas.message(first.frame.contentWindow, report(390, 520));
	assert.equal(chip.hidden, true, "a late report for the previous width is ignored");
	canvas.message({}, report(820, 900));
	assert.equal(chip.hidden, true);
	canvas.message(first.frame.contentWindow, { type: "gd:overflow", overflow: true, width: "820", scrollWidth: 900 });
	canvas.message(first.frame.contentWindow, { type: "gd:overflow", overflow: "yes", width: 820, scrollWidth: 900 });
	assert.equal(chip.hidden, true);
	canvas.message(first.frame.contentWindow, report(820, 900));
	assert.match(chip.title, /wider than 820 px/);
	first.frame.dispatch("load");
	assert.equal(chip.hidden, true, "a reloaded artboard reports again");
});

test("S5: in All sizes each size frame has its own chip", async () => {
	const canvas = await loadRail(300, wideAlpha);
	focusOn(canvas);
	sizeButton(canvas, "all").dispatch("click");
	const sections = sizeSections(canvas);
	const [phone, tablet, desktop] = sections.map(iframeOf);
	assert.deepEqual(sections.map((section) => overflowChip(section).hidden), [true, true, true]);
	canvas.message(tablet.contentWindow, report(820, 1010));
	assert.deepEqual(sections.map((section) => overflowChip(section).hidden), [true, false, true]);
	assert.match(overflowChip(sections[1]).title, /wider than 820 px/);
	canvas.message(phone.contentWindow, report(390, 390));
	canvas.message(desktop.contentWindow, report(1200, 1200));
	assert.deepEqual(sections.map((section) => overflowChip(section).hidden), [true, false, true]);
	canvas.message(tablet.contentWindow, report(820, 820));
	assert.deepEqual(sections.map((section) => overflowChip(section).hidden), [true, true, true]);
});

test("S5: the artboard's own chip shows only while focused at a single size, and a report made earlier shows on focus", async () => {
	const canvas = await loadRail();
	const [first] = canvas.boards;
	const chip = overflowChip(first.wrapper);
	canvas.message(first.frame.contentWindow, report(400, 450));
	assert.equal(chip.hidden, true, "not on the canvas overview");
	focusOn(canvas);
	assert.equal(chip.hidden, false, "Desktop is 400 px wide: the earlier report applies");
	sizeButton(canvas, "all").dispatch("click");
	assert.equal(chip.hidden, true, "All sizes has a chip per frame instead");
	canvas.document.getElementById("gd-back").dispatch("click");
	assert.equal(chip.hidden, true);
});

test("S1-S5: the chrome is in index.html and canvas.css: icons, focus ring, hidden outside focus, no inline script or style", () => {
	const html = read("index.html");
	for (const id of ["i-phone", "i-tablet", "i-monitor"]) assert.match(html, new RegExp(`<symbol id="${id}"`));
	const css = read("canvas.css");
	assert.match(css, /\.gd-sizebar\s*{[^}]*display:\s*none/);
	assert.match(css, /\.gd-focus-board \.gd-sizebar\s*{[^}]*display:\s*flex/);
	for (const selector of [".gd-size-button", ".gd-size-input", ".gd-size-frame", ".gd-sizes-all", ".gd-overflow-flag", ".gd-size-scaled", ".gd-size-stage"]) assert.ok(css.includes(`${selector} {`) || css.includes(`${selector},`), `${selector} is styled`);
	assert.match(css, /\.gd-size-button\[aria-pressed="true"\]/);
	assert.match(css, /\.gd-size-input:focus-visible|:focus-visible\s*{/);
	const js = read("canvas.js");
	assert.ok(!/setAttribute\("style"|\.cssText/.test(js), "the CSP forbids inline style attributes: size styles go through the CSSOM");
	const sandboxes = [...js.matchAll(/setAttribute\("sandbox", ([^)]+)\)/g)].map((match) => match[1]);
	assert.ok(sandboxes.filter((value) => value === '"allow-scripts"').length >= 3, "the board frame, the size frames and Compare's artboard keep the scripts-only sandbox");
	assert.ok(sandboxes.every((value) => value === '"allow-scripts"' || value === "PREVIEW_SANDBOX"), "no other sandbox flags");
	assert.equal(js.split("allow-same-origin").length - 1, 1, "only the Compare preview of the running app keeps its own origin");
});

test("the inspector reports whether its page is wider than the frame, once per change", () => {
	const inspector = loadInspector();
	const root = inspector.document.documentElement as any;
	inspector.context.innerWidth = 390;
	root.clientWidth = 375;
	root.scrollWidth = 520;
	inspector.fire("load", {});
	assert.deepEqual(inspector.posted, [], "reports wait for the next frame");
	inspector.runFrames();
	assert.deepEqual(inspector.posted, [{ type: "gd:overflow", overflow: true, width: 390, scrollWidth: 520 }]);
	inspector.fire("resize", {});
	inspector.runFrames();
	assert.equal(inspector.posted.length, 1, "an unchanged report is not repeated");
	root.scrollWidth = 375;
	inspector.fire("resize", {});
	inspector.runFrames();
	assert.deepEqual(inspector.posted.at(-1), { type: "gd:overflow", overflow: false, width: 390, scrollWidth: 375 });
	inspector.context.innerWidth = 820;
	root.clientWidth = 805;
	root.scrollWidth = 805;
	inspector.fire("resize", {});
	inspector.runFrames();
	assert.deepEqual(inspector.posted.at(-1), { type: "gd:overflow", overflow: false, width: 820, scrollWidth: 805 }, "a new frame width is reported even when the page still fits");
});

// S7: the size a comment was made at.

const submitComment = async (canvas: Canvas, text = "Tighter") => {
	canvas.document.getElementById("gd-popover-text").value = text;
	canvas.document.getElementById("gd-popover-form").dispatch("submit");
	await flush();
	return canvas.posts.at(-1)!.body as Record<string, any>;
};
const PICK = { type: "gd:pick", selector: "#cta", excerpt: "Buy", rect: { x: 30, y: 40, width: 60, height: 20 } };

test("S7: a comment made at the manifest size, unfocused or at Desktop, carries no viewport", async () => {
	const canvas = await loadRail();
	tallViewport(canvas);
	const [first] = canvas.boards;
	canvas.document.getElementById("gd-comment").dispatch("click");
	first.frame.rect = { left: 0, top: 0, width: 400, height: 300 };
	canvas.message(first.frame.contentWindow, PICK);
	assert.ok(!("viewport" in await submitComment(canvas)), "not focused");
	focusOn(canvas);
	canvas.message(first.frame.contentWindow, PICK);
	assert.ok(!("viewport" in await submitComment(canvas)), "Desktop");
	// A custom width equal to the manifest width is the manifest size too.
	customInput(canvas).value = "400";
	customInput(canvas).dispatch("change");
	canvas.message(first.frame.contentWindow, PICK);
	assert.ok(!("viewport" in await submitComment(canvas)));
});

test("S7: a comment at a preset or custom width carries the viewport of that size, with the manifest height for a custom width", async () => {
	const canvas = await loadRail();
	tallViewport(canvas);
	const [first] = canvas.boards;
	focusOn(canvas);
	canvas.document.getElementById("gd-comment").dispatch("click");
	first.frame.rect = { left: 0, top: 0, width: 390, height: 844 };
	sizeButton(canvas, "phone").dispatch("click");
	canvas.message(first.frame.contentWindow, PICK);
	assert.deepEqual((await submitComment(canvas)).viewport, { width: 390, height: 844 });
	sizeButton(canvas, "tablet").dispatch("click");
	canvas.message(first.frame.contentWindow, PICK);
	assert.deepEqual((await submitComment(canvas)).viewport, { width: 820, height: 1180 });
	customInput(canvas).value = "720";
	customInput(canvas).dispatch("change");
	canvas.message(first.frame.contentWindow, PICK);
	assert.deepEqual((await submitComment(canvas)).viewport, { width: 720, height: 300 });
	// The size is the one at the pick: back at Desktop the next comment has none.
	sizeButton(canvas, "desktop").dispatch("click");
	canvas.message(first.frame.contentWindow, PICK);
	assert.ok(!("viewport" in await submitComment(canvas)));
});

test("S7: in All sizes the comment carries the size of the frame that was picked; the Desktop frame is the manifest size", async () => {
	const canvas = await loadRail();
	focusOn(canvas);
	sizeButton(canvas, "all").dispatch("click");
	canvas.document.getElementById("gd-comment").dispatch("click");
	const [phone, tablet, desktop] = sizeSections(canvas).map(iframeOf);
	for (const [frame, viewport] of [[phone, { width: 390, height: 844 }], [tablet, { width: 820, height: 1180 }], [desktop, undefined]] as const) {
		frame.rect = { left: 100, top: 100, width: 100, height: 100 };
		canvas.message(frame.contentWindow, PICK);
		const body = await submitComment(canvas);
		if (viewport) assert.deepEqual(body.viewport, viewport);
		else assert.ok(!("viewport" in body), "Desktop = manifest size");
	}
});

test("S7: a viewport the server would refuse is left out of the request instead of failing the comment", async () => {
	const canvas = await loadRail(30000);
	tallViewport(canvas);
	const [first] = canvas.boards;
	focusOn(canvas);
	canvas.document.getElementById("gd-comment").dispatch("click");
	customInput(canvas).value = "600";
	customInput(canvas).dispatch("change");
	first.frame.rect = { left: 0, top: 0, width: 600, height: 700 };
	canvas.message(first.frame.contentWindow, PICK);
	assert.ok(!("viewport" in await submitComment(canvas)), "30000 px is beyond the 20000 px the file accepts");
});

test("S7: the comment card shows the size it was made at: Phone, Tablet or width × height, and nothing without one", async () => {
	const canvas = await loadRail(300, commentsDoc(
		comment("a1", "01-a.html", "open", { viewport: { width: 390, height: 844 } }),
		comment("a2", "01-a.html", "open", { viewport: { width: 820, height: 1180 } }),
		comment("a3", "01-a.html", "open", { viewport: { width: 720, height: 820 } }),
		comment("a4", "01-a.html"),
	));
	const list = canvas.document.getElementById("gd-comment-list");
	const items = list.children;
	assert.equal(items.length, 4);
	assert.deepEqual(items.map((item) => texts(item, "gd-comment-viewport")), [["Phone 390 × 844"], ["Tablet 820 × 1180"], ["720 × 820"], []]);
	assert.equal(withClass(items[0], "gd-comment-viewport")[0].title, "Made at Phone 390 × 844");
	await setComments(canvas, comment("a1", "01-a.html", "resolved", { viewport: { width: 390, height: 844 } }));
	canvas.document.getElementById("gd-filter-resolved").dispatch("click");
	assert.deepEqual(list.children.map((item) => texts(item, "gd-comment-viewport")), [["Phone 390 × 844"]]);
});

test("S7: canvas.css styles the viewport chip with tokens", () => {
	assert.match(read("canvas.css"), /\.gd-comment-viewport\s*{[^}]*font:[^}]*var\(--font-mono\)/);
});

// S5: the Resolved tab shows what the agent did for a comment.

test("S5: a resolved comment with a resolution shows Agent: and the note as text in the Resolved tab, and nowhere else", async () => {
	const note = "Made the title <b>32px</b> & bolder.";
	const canvas = await loadRail(300, commentsDoc(
		comment("a1", "01-a.html", "resolved", { resolution: note }),
		comment("a2", "01-a.html", "resolved"),
		comment("a3", "01-a.html", "open", { resolution: "stale" }),
	));
	const list = canvas.document.getElementById("gd-comment-list");
	assert.equal(list.children.length, 1, "the Open tab lists only a3");
	assert.equal(withClass(list, "gd-comment-reply").length, 0, "an open comment never shows a reply");
	canvas.document.getElementById("gd-filter-resolved").dispatch("click");
	const [first, second] = list.children;
	assert.equal(list.children.length, 2);
	assert.equal(withClass(first, "gd-comment-reply").length, 1);
	assert.deepEqual(texts(first, "gd-comment-reply-label"), ["Agent:"]);
	assert.deepEqual(texts(first, "gd-comment-reply-text"), [note]);
	assert.equal(withClass(second, "gd-comment-reply").length, 0, "no resolution, no reply");
});

test("S5: the reply follows the comment when it is resolved with a note and disappears when it is reopened", async () => {
	const canvas = await loadRail(300, commentsDoc(comment("a1", "01-a.html", "resolved")));
	canvas.document.getElementById("gd-filter-resolved").dispatch("click");
	const list = canvas.document.getElementById("gd-comment-list");
	assert.equal(withClass(list, "gd-comment-reply").length, 0);
	await setComments(canvas, comment("a1", "01-a.html", "resolved", { resolution: "Shortened the headline" }));
	assert.deepEqual(texts(list, "gd-comment-reply-text"), ["Shortened the headline"]);
	await setComments(canvas, comment("a1", "01-a.html", "open"));
	assert.equal(withClass(list, "gd-comment-reply").length, 0);
});

test("S5: canvas.css styles the comment reply like the version reply, with tokens", () => {
	const css = read("canvas.css");
	assert.match(css, /\.gd-comment-reply\s*{[^}]*border-left:[^}]*var\(--success\)/);
	assert.match(css, /\.gd-comment-reply-label\s*{[^}]*var\(--success\)/);
	const block = css.match(/\.gd-comment-reply\s*{[^}]*}/)![0];
	assert.ok(!/#[0-9a-fA-F]{3,8}\b|rgba?\(/.test(block), "tokens only");
});

// Token inspector (T1): the page loads the project's tokens and reloads them when design/system.md changes.

const TOKENS_URL = "/t/api/system/tokens";

test("S1: the canvas loads the tokens at start and again when design/system.md changes, in a design or the system-only view", async () => {
	const tokens = { exists: true, tokens: [{ name: "--bg", value: "#1a1218", section: "Colors", group: "color" }] };
	const canvas = await loadRail(300, { [TOKENS_URL]: tokens });
	assert.equal(canvas.fetched.filter((url) => url === TOKENS_URL).length, 1, "loaded once at start");
	await canvas.serverEvent("change", { slug: null, file: "system.md" });
	assert.equal(canvas.fetched.filter((url) => url === TOKENS_URL).length, 2, "and again when system.md changes");
	await canvas.serverEvent("change", { slug: null, file: "system.html" });
	assert.equal(canvas.fetched.filter((url) => url === TOKENS_URL).length, 2, "system.html is the board, not the tokens");
	await canvas.serverEvent("change", { slug: "alpha", file: "system.md" });
	assert.equal(canvas.fetched.filter((url) => url === TOKENS_URL).length, 2, "only the root file");
});

test("S1: a missing, failing or malformed tokens reply never shows an error or breaks the canvas", async () => {
	for (const reply of [undefined, { __http: 500 }, { __throw: "down" }, { exists: true, tokens: "nope" }, { exists: true, tokens: [{ name: 3 }, null, { name: "--a", value: "#fff" }] }]) {
		const canvas = await loadRail(300, reply === undefined ? {} : { [TOKENS_URL]: reply });
		assert.equal(canvas.document.getElementById("gd-status").textContent, "", JSON.stringify(reply));
		assert.equal(canvas.boards.length, 2);
		await canvas.serverEvent("change", { slug: null, file: "system.md" });
		assert.equal(canvas.document.getElementById("gd-status").textContent, "");
	}
});

// Token inspector (T2): the inspector measures the hovered element, the canvas compares and renders.

/** Style values the inspector reads, as a browser reports them (computed: rgb() colors, px lengths). */
function styles(extra: Record<string, string> = {}) {
	return {
		color: "rgb(118, 97, 107)", backgroundColor: "rgba(0, 0, 0, 0)", backgroundImage: "none",
		fontFamily: 'Inter, "SF Pro Text", system-ui, sans-serif', fontSize: "11px", fontWeight: "400", lineHeight: "15.4px",
		marginTop: "10px", marginRight: "0px", marginBottom: "10px", marginLeft: "0px",
		paddingTop: "0px", paddingRight: "0px", paddingBottom: "0px", paddingLeft: "0px",
		borderTopLeftRadius: "0px", borderTopRightRadius: "0px", borderBottomRightRadius: "0px", borderBottomLeftRadius: "0px",
		overflowX: "hidden", overflowY: "hidden", display: "block", visibility: "visible", opacity: "1",
		...extra,
	};
}

/** A parent element of the fake inspector page. */
function fakeAncestor(inspector: ReturnType<typeof loadInspector>, computed: Record<string, string>) {
	const parent: any = { localName: "main", parentElement: null, hasAttribute: () => false, getAttribute: () => null, childNodes: [], getBoundingClientRect: () => ({ left: 0, top: 0, width: 300, height: 300 }) };
	Object.setPrototypeOf(parent, inspector.button.constructor.prototype);
	inspector.button.parentElement = parent;
	return { parent, computed };
}

function hoverInspector(computedFor: (element: any) => Record<string, string>) {
	const inspector = loadInspector();
	const button: any = inspector.button;
	button.childNodes = [{ nodeType: 3, textContent: "Buy now" }];
	inspector.context.getComputedStyle = computedFor;
	inspector.fromParent({ type: "gd:mode", enabled: true });
	return inspector;
}

test("S2: hovering a routed point posts the element's measured styles once, in Comment mode only", () => {
	const inspector = hoverInspector(() => styles({ backgroundColor: "rgb(255, 255, 255)", fontSize: "11px", borderTopLeftRadius: "8px", borderTopRightRadius: "8px", borderBottomRightRadius: "8px", borderBottomLeftRadius: "8px", paddingTop: "4px", paddingBottom: "4px" }));
	inspector.fromParent({ type: "gd:hover-at", x: 5, y: 9 });
	assert.deepEqual(inspector.posted, [{
		type: "gd:inspect",
		element: {
			selector: "#cta", label: "button#cta", text: "Buy now", hasText: true,
			rect: { x: 4, y: 8, width: 60, height: 20 },
			color: { r: 118, g: 97, b: 107, a: 1 }, background: { r: 255, g: 255, b: 255 },
			fontFamily: 'Inter, "SF Pro Text", system-ui, sans-serif', fontSize: 11, fontWeight: 400, lineHeight: 15.4,
			margin: [10, 0, 10, 0], padding: [4, 0, 4, 0], radius: [8, 8, 8, 8],
		},
	}]);
	inspector.fromParent({ type: "gd:hover-at", x: 6, y: 9 });
	assert.equal(inspector.posted.length, 1, "the same element is not reported again");
	inspector.fromParent({ type: "gd:hover-at", x: null, y: null });
	assert.deepEqual(inspector.posted.at(-1), { type: "gd:inspect", element: null }, "leaving says so");
	inspector.fromParent({ type: "gd:hover-at", x: 5, y: 9 });
	assert.equal(inspector.posted.length, 3);
	inspector.fromParent({ type: "gd:mode", enabled: false });
	assert.deepEqual(inspector.posted.at(-1), { type: "gd:inspect", element: null }, "leaving Comment mode clears it");

	const idle = loadInspector();
	idle.fromParent({ type: "gd:hover-at", x: 5, y: 9 });
	idle.fire("pointerover", { target: idle.button });
	assert.deepEqual(idle.posted, [], "nothing is measured outside Comment mode");
});

test("S2: a pointer over the artboard itself (focus mode) is measured too, and leaving the window clears it", () => {
	const inspector = hoverInspector(() => styles());
	inspector.fire("pointerover", { target: inspector.button });
	assert.equal(inspector.posted.length, 1);
	assert.equal((inspector.posted[0].element as any).selector, "#cta");
	inspector.fire("pointerout", { target: inspector.button, relatedTarget: inspector.button });
	assert.equal(inspector.posted.length, 1, "moving between elements of the page is not leaving");
	inspector.fire("pointerout", { target: inspector.button, relatedTarget: null });
	assert.deepEqual(inspector.posted.at(-1), { type: "gd:inspect", element: null });
});

test("S2: the background is the first opaque ancestor's, translucent layers are composited, an image makes it unknown, text color alpha is kept", () => {
	const inspector = loadInspector();
	const button: any = inspector.button;
	button.childNodes = [{ nodeType: 3, textContent: "Buy" }];
	const { parent } = fakeAncestor(inspector, {});
	const layers = new Map<any, Record<string, string>>([
		[button, styles({ color: "rgba(0, 0, 0, 0.5)", backgroundColor: "rgba(0, 0, 0, 0.5)" })],
		[parent, styles({ backgroundColor: "rgb(200, 100, 0)" })],
	]);
	inspector.context.getComputedStyle = (element: any) => layers.get(element) ?? styles();
	inspector.fromParent({ type: "gd:mode", enabled: true });
	inspector.fromParent({ type: "gd:hover-at", x: 5, y: 9 });
	let element = inspector.posted.at(-1).element;
	assert.deepEqual(element.background, { r: 100, g: 50, b: 0 }, "50% black over rgb(200, 100, 0)");
	assert.deepEqual(element.color, { r: 0, g: 0, b: 0, a: 0.5 });

	layers.set(parent, styles({ backgroundColor: "rgba(0, 0, 0, 0)" }));
	inspector.fromParent({ type: "gd:hover-at", x: null, y: null });
	inspector.fromParent({ type: "gd:hover-at", x: 5, y: 9 });
	element = inspector.posted.at(-1).element;
	assert.deepEqual(element.background, { r: 128, g: 128, b: 128 }, "no opaque ancestor: the white page");

	layers.set(parent, styles({ backgroundColor: "rgb(10, 10, 10)", backgroundImage: "linear-gradient(red, blue)" }));
	inspector.fromParent({ type: "gd:hover-at", x: null, y: null });
	inspector.fromParent({ type: "gd:hover-at", x: 5, y: 9 });
	assert.equal(inspector.posted.at(-1).element.background, null, "a background image: unknown");
});

test("S2: the inspector measures defensively: line-height normal, percent radius, odd colors, no text", () => {
	const inspector = hoverInspector(() => styles({ lineHeight: "normal", borderTopLeftRadius: "50%", borderTopRightRadius: "50%", borderBottomRightRadius: "50%", borderBottomLeftRadius: "50%", color: "color(display-p3 1 0 0)", fontWeight: "bold" }));
	(inspector.button as any).childNodes = [{ nodeType: 3, textContent: "  \n " }, { nodeType: 1, textContent: "child" }];
	inspector.fromParent({ type: "gd:hover-at", x: 5, y: 9 });
	const element = inspector.posted.at(-1).element;
	assert.equal(element.lineHeight, null);
	assert.deepEqual(element.radius, [10, 10, 10, 10], "50% of the smaller side (20 px)");
	assert.equal(element.color, null, "an unreadable color is unknown, not guessed");
	assert.equal(element.hasText, false, "whitespace and child elements are not the element's own text");
	assert.equal(element.fontWeight, 700);
});

test("S2: a scroll re-reports the hovered element's new box", () => {
	const inspector = hoverInspector(() => styles());
	inspector.fromParent({ type: "gd:hover-at", x: 5, y: 9 });
	(inspector.button as any).getBoundingClientRect = () => ({ left: 4, top: -12, width: 60, height: 20 });
	inspector.fire("scroll", {});
	assert.deepEqual(inspector.posted.at(-1).element.rect, { x: 4, y: -12, width: 60, height: 20 });
});

// ---- the canvas side

const TOKEN_SET = { exists: true, tokens: [
	{ name: "--bg", value: "#1a1218", section: "Colors", group: "color" },
	{ name: "--surface-2", value: "#342230", section: "Colors", group: "color" },
	{ name: "--border", value: "#342230", section: "Colors", group: "color" },
	{ name: "--text", value: "#f6eff3", section: "Colors", group: "color" },
	{ name: "--text-muted", value: "#a78e9b", section: "Colors", group: "color" },
	{ name: "--text-faint", value: "#76616b", section: "Colors", group: "color" },
	{ name: "--paper", value: "#ffffff", section: "Colors", group: "color" },
	{ name: "--border-soft", value: "#ffffff17", section: "Colors", group: "color" },
	{ name: "--font-sans", value: 'Inter, "SF Pro Text", system-ui, sans-serif', section: "Typography", group: "font" },
	{ name: "--font-mono", value: '"IosevkaTerm NF", monospace', section: "Typography", group: "font" },
	{ name: "--radius-sm", value: "8px", section: "Radius", group: "radius" },
	{ name: "--radius-md", value: "12px", section: "Radius", group: "radius" },
	{ name: "--rail-width", value: "60px", section: "Layout", group: "layout" },
] };

const EXTRA_TOKENS = { exists: true, tokens: [...TOKEN_SET.tokens,
	{ name: "--space-2", value: "8px", section: "Spacing", group: "spacing" },
	{ name: "--space-4", value: "16px", section: "Spacing", group: "spacing" },
	{ name: "--text-sm", value: "12px", section: "Typography", group: "font" },
	{ name: "--text-md", value: "14px", section: "Typography", group: "font" },
] };

const MEASURE = {
	selector: "main > p.or", label: "p.or", text: "or pay with card", hasText: true,
	rect: { x: 30, y: 40, width: 200, height: 20 },
	color: { r: 118, g: 97, b: 107, a: 1 }, background: { r: 255, g: 255, b: 255 },
	fontFamily: 'Inter, "SF Pro Text", system-ui, sans-serif', fontSize: 14, fontWeight: 400, lineHeight: 21,
	margin: [8, 0, 8, 0], padding: [0, 0, 0, 0], radius: [0, 0, 0, 0],
};

const panelOf = (canvas: Canvas) => canvas.document.getElementById("gd-inspector");
const panelText = (canvas: Canvas) => allText(panelOf(canvas));
function allText(element: FakeElement): string {
	return [element.textContent, ...element.children.map(allText)].filter(Boolean).join(" ");
}
const rowOf = (canvas: Canvas, label: string) => withClass(panelOf(canvas), "gd-inspector-row").find((row) => texts(row, "gd-inspector-label")[0] === label);
const rowText = (canvas: Canvas, label: string) => { const row = rowOf(canvas, label); return row ? allText(withClass(row, "gd-inspector-value")[0]) : undefined; };
const rowLabels = (canvas: Canvas) => withClass(panelOf(canvas), "gd-inspector-row").map((row) => texts(row, "gd-inspector-label")[0]);

async function inspecting(tokens: unknown = TOKEN_SET, extraContext: Record<string, unknown> = {}) {
	const canvas = await loadRail(300, { [TOKENS_URL]: tokens }, {}, extraContext);
	tallViewport(canvas);
	canvas.document.getElementById("gd-comment").dispatch("click");
	// canvas-ux-quick-wins S2: the token inspector shows with Technical details on.
	canvas.document.getElementById("gd-technical").dispatch("click");
	return canvas;
}
function inspect(canvas: Canvas, surface: { contentWindow: unknown }, element: unknown = MEASURE) {
	canvas.message(surface.contentWindow, { type: "gd:inspect", element });
}

test("S2: in Comment mode the panel shows the selector, the values and the token each one matches", async () => {
	const canvas = await inspecting();
	const [first] = canvas.boards;
	first.frame.rect = { left: 100, top: 120, width: 400, height: 300 };
	assert.equal(panelOf(canvas).hidden, true);
	inspect(canvas, first.frame, { ...MEASURE, color: { r: 246, g: 239, b: 243, a: 1 }, background: { r: 26, g: 18, b: 24 }, radius: [8, 8, 8, 8] });
	assert.equal(panelOf(canvas).hidden, false);
	assert.equal(canvas.document.getElementById("gd-inspector-title").textContent, "p.or");
	assert.equal(canvas.document.getElementById("gd-inspector-selector").textContent, "main > p.or");
	assert.deepEqual(rowLabels(canvas), ["Color", "Background", "Contrast", "Font", "Size", "Line height", "Spacing", "Radius"]);
	assert.match(rowText(canvas, "Color")!, /#f6eff3/);
	assert.match(rowText(canvas, "Color")!, /--text/);
	assert.match(rowText(canvas, "Background")!, /#1a1218[^]*--bg/);
	assert.match(rowText(canvas, "Font")!, /Inter[^]*--font-sans/);
	assert.match(rowText(canvas, "Radius")!, /8 px[^]*--radius-sm/);
	assert.equal(withClass(rowOf(canvas, "Color")!, "gd-inspector-bad").length, 0, "nothing flagged");
	assert.match(rowText(canvas, "Size")!, /14 px/);
	assert.match(rowText(canvas, "Line height")!, /21 px/);
	assert.match(rowText(canvas, "Spacing")!, /margin 8 0 8 0/);
	assert.equal(withClass(panelOf(canvas), "gd-inspector-swatch").length, 2, "a swatch for the text and the background color");
	assert.equal(withClass(panelOf(canvas), "gd-inspector-swatch")[0].style.background, "rgb(246, 239, 243)");
});

test("S2: a value with several matching tokens names them all, and the panel has a named heading and real buttons", async () => {
	const canvas = await inspecting();
	const [first] = canvas.boards;
	inspect(canvas, first.frame, { ...MEASURE, color: { r: 52, g: 34, b: 48, a: 1 } });
	assert.match(rowText(canvas, "Color")!, /--surface-2[^]*--border/);
	const html = read("index.html");
	assert.match(html, /<button type="button" id="gd-inspector-fix"/);
	assert.match(html, /<button type="button" id="gd-inspector-copy"/);
	assert.match(html, /<h2 id="gd-inspector-title"/);
});

test("S2: a color off the system shows ⚠ no token and the nearest token by perceptual distance", async () => {
	const canvas = await inspecting();
	const [first] = canvas.boards;
	// #77616b is one step from --text-faint; #b09aa6 is closest to --text-muted, not to --text.
	inspect(canvas, first.frame, { ...MEASURE, color: { r: 119, g: 97, b: 107, a: 1 } });
	assert.match(rowText(canvas, "Color")!, /⚠ no token/);
	assert.match(rowText(canvas, "Color")!, /Nearest[^]*--text-faint[^]*#76616b/);
	assert.equal(withClass(rowOf(canvas, "Color")!, "gd-inspector-bad").length >= 1, true);
	inspect(canvas, first.frame, { ...MEASURE, color: { r: 176, g: 154, b: 166, a: 1 } });
	assert.match(rowText(canvas, "Color")!, /Nearest[^]*--text-muted/);
	// Perceptual distance: a dark reddish background is nearest the dark plum --bg.
	inspect(canvas, first.frame, { ...MEASURE, background: { r: 40, g: 10, b: 20 } });
	assert.match(rowText(canvas, "Background")!, /Nearest[^]*--bg/);
});

test("S2: contrast is the WCAG ratio, flagged under AA: 4.5 : 1 for normal text, 3 : 1 for large text", async () => {
	const canvas = await inspecting();
	const [first] = canvas.boards;
	const grey = (value: number) => ({ r: value, g: value, b: value, a: 1 });
	inspect(canvas, first.frame, { ...MEASURE, color: grey(0x76) });
	assert.match(rowText(canvas, "Contrast")!, /4\.54 : 1/);
	assert.equal(withClass(rowOf(canvas, "Contrast")!, "gd-inspector-bad").length, 0, "#767676 on white passes AA");
	inspect(canvas, first.frame, { ...MEASURE, color: grey(0x77) });
	assert.match(rowText(canvas, "Contrast")!, /4\.47 : 1/, "4.478 is shown as 4.47, never rounded up toward a pass");
	assert.match(rowText(canvas, "Contrast")!, /⚠[^]*needs 4\.5 : 1/);
	assert.equal(withClass(rowOf(canvas, "Contrast")!, "gd-inspector-bad").length >= 1, true);
	// 24 px, or 18.66 px and bold, is large text: 3 : 1.
	inspect(canvas, first.frame, { ...MEASURE, color: grey(0x77), fontSize: 24 });
	assert.equal(withClass(rowOf(canvas, "Contrast")!, "gd-inspector-bad").length, 0);
	assert.match(rowText(canvas, "Contrast")!, /large text/);
	inspect(canvas, first.frame, { ...MEASURE, color: grey(0x77), fontSize: 18.66, fontWeight: 700 });
	assert.equal(withClass(rowOf(canvas, "Contrast")!, "gd-inspector-bad").length, 0);
	inspect(canvas, first.frame, { ...MEASURE, color: grey(0x77), fontSize: 18.66, fontWeight: 400 });
	assert.equal(withClass(rowOf(canvas, "Contrast")!, "gd-inspector-bad").length >= 1, true, "18.66 px regular is not large");
	inspect(canvas, first.frame, { ...MEASURE, color: grey(0xaa), fontSize: 24 });
	assert.match(rowText(canvas, "Contrast")!, /⚠[^]*needs 3 : 1/);
	// Black on white is 21 : 1; semi-transparent text is composited over its background first.
	inspect(canvas, first.frame, { ...MEASURE, color: { r: 0, g: 0, b: 0, a: 1 } });
	assert.match(rowText(canvas, "Contrast")!, /21 : 1/);
	inspect(canvas, first.frame, { ...MEASURE, color: { r: 0, g: 0, b: 0, a: 0.5 } });
	assert.match(rowText(canvas, "Contrast")!, /3\.94 : 1/);
});

test("S2: an element with no text, or an unknown background, shows no contrast ratio", async () => {
	const canvas = await inspecting();
	const [first] = canvas.boards;
	inspect(canvas, first.frame, { ...MEASURE, hasText: false, text: "" });
	assert.equal(rowText(canvas, "Contrast"), "—");
	inspect(canvas, first.frame, { ...MEASURE, background: null });
	assert.match(rowText(canvas, "Contrast")!, /unknown background/);
	assert.match(rowText(canvas, "Background")!, /image or gradient/);
	inspect(canvas, first.frame, { ...MEASURE, color: null });
	assert.match(rowText(canvas, "Color")!, /unreadable/);
});

test("S2: font family, font size and radius off the system are flagged; sizes use the nearest token by numeric distance", async () => {
	const canvas = await inspecting(EXTRA_TOKENS);
	const [first] = canvas.boards;
	inspect(canvas, first.frame, { ...MEASURE, fontFamily: "Arial, sans-serif", fontSize: 13, radius: [10, 10, 10, 10], margin: [8, 0, 12, 0], padding: [0, 16, 0, 16] });
	assert.match(rowText(canvas, "Font")!, /Arial[^]*⚠ no token/);
	assert.match(rowText(canvas, "Size")!, /13 px[^]*⚠ no token[^]*Nearest[^]*--text-(sm|md)/);
	assert.match(rowText(canvas, "Radius")!, /10 px[^]*⚠ no token[^]*--radius-(sm|md)/);
	assert.match(rowText(canvas, "Spacing")!, /margin 8 0 12 0/);
	assert.match(rowText(canvas, "Spacing")!, /padding 0 16 0 16/);
	assert.match(rowText(canvas, "Spacing")!, /⚠[^]*12 px[^]*--space-/, "12 is off the 8/16 scale");
	// 13 is as near 12 as 14 is far; 13.4 is nearer 14.
	inspect(canvas, first.frame, { ...MEASURE, fontSize: 13.4 });
	assert.match(rowText(canvas, "Size")!, /Nearest[^]*--text-md/);
	// On the scale, nothing is flagged.
	inspect(canvas, first.frame, { ...MEASURE, fontSize: 12, margin: [8, 0, 16, 0] });
	assert.match(rowText(canvas, "Size")!, /--text-sm/);
	assert.equal(withClass(rowOf(canvas, "Spacing")!, "gd-inspector-bad").length, 0);
	assert.match(rowText(canvas, "Spacing")!, /on scale/);
	// A font whose first family is a token's counts as that token.
	inspect(canvas, first.frame, { ...MEASURE, fontFamily: 'Inter, Arial, sans-serif' });
	assert.match(rowText(canvas, "Font")!, /--font-sans/);
	assert.equal(withClass(rowOf(canvas, "Font")!, "gd-inspector-bad").length, 0);
});

test("S1/S2: without design tokens (or without tokens of a kind) the panel still shows values and contrast and compares nothing", async () => {
	for (const tokens of [null, { exists: false, tokens: [] }]) {
		const canvas = await inspecting(tokens);
		const [first] = canvas.boards;
		inspect(canvas, first.frame);
		assert.equal(panelOf(canvas).hidden, false);
		assert.match(rowText(canvas, "Color")!, /#76616b/);
		assert.match(rowText(canvas, "Contrast")!, /⚠[^]*needs 4\.5 : 1|\d : 1/);
		assert.ok(!/no token/.test(panelText(canvas)), "no 'no token' without tokens");
		assert.equal(canvas.document.getElementById("gd-inspector-note").hidden, false);
		assert.match(canvas.document.getElementById("gd-inspector-note").textContent, /No design\/system\.md tokens/);
	}
	// Tokens exist but none of a kind: that row shows its value only.
	const canvas = await inspecting();
	inspect(canvas, canvas.boards[0].frame, { ...MEASURE, fontSize: 13, margin: [10, 0, 10, 0] });
	assert.ok(!/no token/.test(rowText(canvas, "Size")!));
	assert.ok(!/no token|off scale/.test(rowText(canvas, "Spacing")!));
	assert.equal(canvas.document.getElementById("gd-inspector-note").hidden, true);
});

test("S2: tokens reload live: a changed system.md changes the next comparison", async () => {
	const canvas = await inspecting();
	const [first] = canvas.boards;
	inspect(canvas, first.frame, { ...MEASURE, color: { r: 1, g: 2, b: 3, a: 1 } });
	assert.doesNotMatch(rowText(canvas, "Color")!, /--ink/);
	canvas.replies[TOKENS_URL] = { exists: true, tokens: [{ name: "--ink", value: "#010203", section: "Colors", group: "color" }] };
	await canvas.serverEvent("change", { slug: null, file: "system.md" });
	inspect(canvas, first.frame, { ...MEASURE, color: { r: 1, g: 2, b: 3, a: 1 } });
	assert.match(rowText(canvas, "Color")!, /--ink/);
});

test("S2: the panel appears only in Comment mode, from a trusted frame of the focused artboard, and leaves with the mode", async () => {
	const canvas = await loadRail(300, { [TOKENS_URL]: TOKEN_SET });
	const [first, second] = canvas.boards;
	canvas.document.getElementById("gd-technical").dispatch("click");
	inspect(canvas, first.frame);
	assert.equal(panelOf(canvas).hidden, true, "not in Navigate mode");
	canvas.document.getElementById("gd-comment").dispatch("click");
	canvas.message({}, { type: "gd:inspect", element: MEASURE });
	canvas.message(thumbFrame(canvas, 0).contentWindow, { type: "gd:inspect", element: MEASURE });
	assert.equal(panelOf(canvas).hidden, true, "a stranger or a thumbnail is not trusted");
	for (const bad of [undefined, 3, "x", {}, { ...MEASURE, rect: null }, { ...MEASURE, margin: [1] }, { ...MEASURE, selector: "" }, { ...MEASURE, fontSize: "big" }, { ...MEASURE, color: { r: 999, g: 0, b: 0, a: 1 } }]) {
		canvas.message(first.frame.contentWindow, { type: "gd:inspect", element: bad });
		assert.equal(panelOf(canvas).hidden, true, JSON.stringify(bad));
	}
	inspect(canvas, first.frame);
	assert.equal(panelOf(canvas).hidden, false);
	canvas.document.getElementById("gd-tool-navigate").dispatch("click");
	assert.equal(panelOf(canvas).hidden, true, "leaving Comment mode closes it");
	canvas.document.getElementById("gd-comment").dispatch("click");
	navItems(canvas)[0].dispatch("click");
	inspect(canvas, second.frame);
	assert.equal(panelOf(canvas).hidden, true, "another artboard than the focused one is inert");
	inspect(canvas, first.frame);
	assert.equal(panelOf(canvas).hidden, false);
	canvas.document.getElementById("gd-back").dispatch("click");
	assert.equal(panelOf(canvas).hidden, true, "leaving focus mode closes it");
});

test("S2: the panel stays while the pointer is on it or focus is in it, and leaves shortly after the element is left", async () => {
	const timers: Array<() => void> = [];
	const canvas = await inspecting(TOKEN_SET, { setTimeout: (callback: () => void) => { timers.push(callback); return timers.length; } });
	const [first] = canvas.boards;
	inspect(canvas, first.frame);
	inspect(canvas, first.frame, null);
	assert.equal(panelOf(canvas).hidden, false, "not at once: the pointer may be on its way to the buttons");
	timers.splice(0).forEach((run) => run());
	assert.equal(panelOf(canvas).hidden, true);

	inspect(canvas, first.frame);
	panelOf(canvas).dispatch("pointerenter");
	inspect(canvas, first.frame, null);
	timers.splice(0).forEach((run) => run());
	assert.equal(panelOf(canvas).hidden, false, "the pointer is on the panel");
	panelOf(canvas).dispatch("pointerleave");
	timers.splice(0).forEach((run) => run());
	assert.equal(panelOf(canvas).hidden, true, "and leaves when it leaves");

	inspect(canvas, first.frame);
	canvas.document.getElementById("gd-inspector-copy").focus();
	inspect(canvas, first.frame, null);
	timers.splice(0).forEach((run) => run());
	assert.equal(panelOf(canvas).hidden, false, "keyboard focus inside keeps it");
	canvas.document.activeElement = canvas.document.body;
	inspect(canvas, first.frame);
	inspect(canvas, first.frame, null);
	inspect(canvas, first.frame);
	timers.splice(0).forEach((run) => run());
	assert.equal(panelOf(canvas).hidden, false, "hovering again cancels the pending hide");
});

test("S2: moving the pointer over the panel does not clear the hovered element's outline", async () => {
	const canvas = await inspecting();
	const [first] = canvas.boards;
	first.frame.rect = { left: 100, top: 120, width: 400, height: 300 };
	inspect(canvas, first.frame);
	const posted = first.frame.contentWindow!.posted.length;
	canvas.viewport.dispatch("pointermove", { pointerId: 1, clientX: 600, clientY: 200, target: panelOf(canvas) });
	assert.equal(first.frame.contentWindow!.posted.length, posted, "no hover-at null reached the artboard");
});

test("S2: the panel sits beside the artboard, not over the hovered element", async () => {
	const canvas = await inspecting();
	const [first] = canvas.boards;
	const place = () => {
		const panel = panelOf(canvas);
		const left = Number.parseFloat(panel.style.left);
		const top = Number.parseFloat(panel.style.top) + 50;
		return { left, top, right: left + 280 };
	};
	// The element at (30, 40, 200 x 20) in a 400 px frame at (100, 120): client box 130..330 x 160..180.
	first.frame.rect = { left: 100, top: 120, width: 400, height: 300 };
	inspect(canvas, first.frame);
	assert.deepEqual([place().left, place().top], [512, 160], "right of the frame, level with the element");
	assert.ok(place().left >= 500, "clear of the frame, so of the element");
	// No room on the right: it goes to the left of the frame.
	first.frame.rect = { left: 560, top: 120, width: 400, height: 300 };
	inspect(canvas, first.frame);
	assert.equal(place().left, 560 - 12 - 280);
	assert.ok(place().right <= 560);
	// No room on either side: below the element, kept inside the viewport.
	canvas.viewport.rect = { left: 0, top: 50, width: 420, height: 1400 };
	first.frame.rect = { left: 10, top: 120, width: 400, height: 300 };
	inspect(canvas, first.frame);
	assert.equal(place().top, 160 + 20 + 8 - 0, "below the element's bottom (180) plus a gap");
	assert.ok(place().left >= 12 && place().right <= 420 - 12);
});

test("S2: the panel is placed against the frame the element is in: a scaled size frame of All sizes", async () => {
	const canvas = await loadRail(300, { ...wideAlpha, [TOKENS_URL]: TOKEN_SET });
	tallViewport(canvas);
	focusOn(canvas);
	sizeButton(canvas, "all").dispatch("click");
	canvas.document.getElementById("gd-comment").dispatch("click");
	canvas.document.getElementById("gd-technical").dispatch("click");
	const [phone] = sizeSections(canvas).map(iframeOf);
	phone.rect = { left: 100, top: 200, width: 195, height: 422 };
	inspect(canvas, phone, { ...MEASURE, rect: { x: 40, y: 100, width: 100, height: 40 } });
	assert.equal(panelOf(canvas).hidden, false, "size frames are registered frames");
	assert.equal(Number.parseFloat(panelOf(canvas).style.left), 295 + 12, "right of the 195 px frame");
	assert.equal(Number.parseFloat(panelOf(canvas).style.top) + 50, 200 + 100 * 0.5);
});

test("S3: Ask the agent to fix opens the comment popover on that element, prefilled and editable, listing the flagged values and nearest tokens", async () => {
	const canvas = await inspecting();
	const [first] = canvas.boards;
	first.frame.rect = { left: 100, top: 120, width: 400, height: 300 };
	const popover = canvas.document.getElementById("gd-popover");
	// #96828c is off the system and 3.6 : 1 on white.
	inspect(canvas, first.frame, { ...MEASURE, color: { r: 150, g: 130, b: 140, a: 1 }, radius: [10, 10, 10, 10] });
	canvas.document.getElementById("gd-inspector-fix").dispatch("click");
	assert.equal(popover.hidden, false);
	assert.equal(panelOf(canvas).hidden, true, "the popover takes the panel's place");
	assert.equal(canvas.document.getElementById("gd-popover-target").textContent, "01-a.html · main > p.or");
	const text = canvas.document.getElementById("gd-popover-text").value;
	assert.match(text, /^Fix the values on main > p\.or that are off the design system \(design\/system\.md\):\n/);
	assert.match(text, /\n- Text color #96828c is not a token; nearest is --text-(faint|muted) \(#[0-9a-f]{6}\)\./);
	assert.match(text, /\n- Contrast 3\.\d+:1 is below WCAG AA \(4\.5:1 for normal text\)\./);
	assert.match(text, /\n- Border radius 10px is not a token; nearest is --radius-(sm|md) \(\d+px\)\./);
	assert.ok(!text.includes("Background"), "values that match a token are not listed");
	assert.equal(canvas.document.activeElement, canvas.document.getElementById("gd-popover-text"));
	// Editable, and it follows Send now / Collect: it is a normal comment.
	canvas.document.getElementById("gd-popover-text").value = `${text}\nAlso check the hover state.`;
	canvas.document.getElementById("gd-mode-collect").dispatch("change");
	canvas.document.getElementById("gd-popover-form").dispatch("submit");
	await flush();
	const post = canvas.posts.at(-1)!;
	assert.equal(post.url, "/t/api/comments");
	assert.deepEqual({ ...(post.body as any), comment: undefined }, { slug: "alpha", file: "01-a.html", selector: "main > p.or", excerpt: "or pay with card", comment: undefined, mode: "collect" });
	assert.match((post.body as any).comment, /Also check the hover state\.$/);
});

test("S3: Send now sends the prefilled comment; at another size it records that size", async () => {
	const canvas = await inspecting();
	const [first] = canvas.boards;
	navItems(canvas)[0].dispatch("click");
	sizeButton(canvas, "phone").dispatch("click");
	first.frame.rect = { left: 100, top: 120, width: 390, height: 600 };
	inspect(canvas, first.frame, { ...MEASURE, color: { r: 119, g: 97, b: 107, a: 1 } });
	canvas.document.getElementById("gd-inspector-fix").dispatch("click");
	canvas.document.getElementById("gd-popover-form").dispatch("submit");
	await flush();
	const body = canvas.posts.at(-1)!.body as any;
	assert.equal(body.mode, "send");
	assert.deepEqual(body.viewport, { width: 390, height: 844 });
	assert.ok(body.comment.length <= 2000);
});

test("S3: when nothing is flagged Ask the agent to fix is disabled and says why; Copy still works", async () => {
	const canvas = await inspecting();
	const [first] = canvas.boards;
	inspect(canvas, first.frame, { ...MEASURE, color: { r: 246, g: 239, b: 243, a: 1 }, background: { r: 26, g: 18, b: 24 } });
	const fix = canvas.document.getElementById("gd-inspector-fix");
	assert.equal(fix.disabled, true);
	assert.match(fix.title, /Nothing is off the design system/);
	assert.equal(canvas.document.getElementById("gd-inspector-copy").disabled, false);
	fix.dispatch("click");
	assert.equal(canvas.document.getElementById("gd-popover").hidden, true);
	inspect(canvas, first.frame, { ...MEASURE, color: { r: 119, g: 97, b: 107, a: 1 } });
	assert.equal(canvas.document.getElementById("gd-inspector-fix").disabled, false);
	assert.equal(canvas.document.getElementById("gd-inspector-fix").title, "");
});

test("S3: a very long list of flags still fits the comment limit", async () => {
	const canvas = await inspecting();
	const [first] = canvas.boards;
	inspect(canvas, first.frame, { ...MEASURE, selector: `main > ${"div > ".repeat(80)}p`, color: { r: 119, g: 97, b: 107, a: 1 }, radius: [10, 10, 10, 10] });
	canvas.document.getElementById("gd-inspector-fix").dispatch("click");
	assert.ok(canvas.document.getElementById("gd-popover-text").value.length <= 2000);
});

test("S3: Copy puts the same text on the clipboard, and falls back when the clipboard API is missing or refuses", async () => {
	const written: string[] = [];
	const canvas = await inspecting(TOKEN_SET, { navigator: { clipboard: { writeText: async (text: string) => { written.push(text); } } } });
	const [first] = canvas.boards;
	inspect(canvas, first.frame, { ...MEASURE, color: { r: 119, g: 97, b: 107, a: 1 } });
	canvas.document.getElementById("gd-inspector-copy").dispatch("click");
	await flush();
	assert.equal(written.length, 1);
	assert.match(written[0], /^Fix the values on main > p\.or that are off the design system/);
	assert.equal(canvas.document.getElementById("gd-toast").textContent, "Copied");
	// What Copy copies is what Ask the agent to fix prefills.
	canvas.document.getElementById("gd-inspector-fix").dispatch("click");
	assert.equal(canvas.document.getElementById("gd-popover-text").value, written[0]);

	// A refusing clipboard falls back to a hidden text area and the browser's copy command.
	const commands: string[] = [];
	const refused = await inspecting(TOKEN_SET, { navigator: { clipboard: { writeText: async () => { throw new Error("denied"); } } } });
	(refused.document as any).execCommand = (command: string) => { commands.push(command); return true; };
	inspect(refused, refused.boards[0].frame, { ...MEASURE, color: { r: 119, g: 97, b: 107, a: 1 } });
	refused.document.getElementById("gd-inspector-copy").dispatch("click");
	await flush();
	assert.deepEqual(commands, ["copy"]);
	assert.equal(refused.document.getElementById("gd-toast").textContent, "Copied");
	assert.equal(refused.document.body.children.filter((child) => child.localName === "textarea").length, 0, "the helper text area is removed");

	// No way to copy: say so, and keep the text reachable through Ask the agent to fix.
	const none = await inspecting();
	inspect(none, none.boards[0].frame, { ...MEASURE, color: { r: 119, g: 97, b: 107, a: 1 } });
	none.document.getElementById("gd-inspector-copy").dispatch("click");
	await flush();
	assert.match(none.document.getElementById("gd-toast").textContent, /^Could not copy/);
	assert.equal(none.document.getElementById("gd-toast").classes.has("gd-error"), true);
});

test("S2/S3: the panel is in index.html and canvas.css with tokens only, focus rings and no inline script or style", () => {
	const html = read("index.html");
	assert.match(html, /<section id="gd-inspector" class="gd-inspector"[^>]*aria-labelledby="gd-inspector-title"[^>]*hidden>/);
	assert.match(html, /id="gd-inspector-fix"[^>]*>[^]*?Ask the agent to fix</);
	assert.match(html, /id="gd-inspector-copy"[^>]*>Copy</);
	assert.match(html, /<symbol id="i-target"/);
	const css = read("canvas.css");
	for (const selector of [".gd-inspector", ".gd-inspector-row", ".gd-inspector-swatch", ".gd-inspector-ok", ".gd-inspector-bad"]) assert.ok(css.includes(`${selector} {`) || css.includes(`${selector},`), `${selector} is styled`);
	assert.match(css, /\.gd-inspector\s*{[^}]*position:\s*absolute[^}]*box-shadow:\s*var\(--shadow-panel\)/);
	assert.match(css, /\.gd-inspector-bad\s*{[^}]*color:\s*var\(--warning\)/);
	assert.match(css, /\.gd-inspector-ok\s*{[^}]*color:\s*var\(--success\)/);
	assert.ok(!/<style|<script[^>]*>[^<]/.test(html.replace(/<script[^>]*src=[^>]*><\/script>|<script id="gd-config"[^>]*>[^<]*<\/script>/g, "")), "no inline script or style");
});

// Accessibility checks (T3): the inspector checks the page after load; the canvas shows the results.

type PageSpec = { tag: string; attrs?: Record<string, string>; style?: Record<string, string>; size?: [number, number]; at?: [number, number]; text?: string; kids?: PageSpec[] };

/** A small page for the inspector: elements in document order, with computed styles and boxes. */
function checkPage(specs: PageSpec[]) {
	const inspector = loadInspector();
	const Element = inspector.Element as new () => any;
	const all: any[] = [];
	const build = (spec: PageSpec, parent: any): any => {
		const node = new Element();
		all.push(node);
		const attrs = spec.attrs ?? {};
		Object.assign(node, {
			localName: spec.tag, parentElement: parent, id: attrs.id ?? "", className: attrs.class ?? "", attrs, styleSpec: spec.style ?? {},
			size: spec.size ?? [100, 24], childNodes: [], children: [], isConnected: true, scrolled: 0,
			getAttribute: (name: string) => attrs[name] ?? null,
			hasAttribute: (name: string) => name in attrs,
			scrollIntoView() { node.scrolled += 1; },
			contains: (other: any) => { for (let current = other; current; current = current.parentElement) if (current === node) return true; return false; },
		});
		node.index = all.length;
		Object.defineProperty(node, "textContent", { get: () => node.childNodes.map((child: any) => child.textContent).join("") });
		Object.defineProperty(node, "innerText", { get: () => node.textContent });
		// `at` places the box (left, top); without it the elements stack down the page.
		node.getBoundingClientRect = () => ({ left: spec.at?.[0] ?? 8, top: spec.at?.[1] ?? 8 + node.index * 30, width: node.size[0], height: node.size[1] });
		if (spec.text) node.childNodes.push({ nodeType: 3, textContent: spec.text });
		for (const kid of spec.kids ?? []) {
			const child = build(kid, node);
			child.nodeType = 1;
			node.children.push(child);
			node.childNodes.push(child);
		}
		return node;
	};
	const body = build({ tag: "body", kids: specs }, null);
	const doc = inspector.document as any;
	doc.body = body;
	doc.querySelectorAll = (selector: string) => (selector === "*" ? all : selector.startsWith("#") ? all.filter((node) => node.id === selector.slice(1)) : []);
	doc.querySelector = (selector: string) => (selector.startsWith("#") ? all.find((node) => node.id === selector.slice(1)) ?? null : null);
	doc.getElementById = (id: string) => all.find((node) => node.id === id) ?? null;
	inspector.context.getComputedStyle = (element: any) => ({ ...styles(), ...(element.styleSpec ?? {}) });
	const reports = () => inspector.posted.filter((message) => message.type === "gd:checks");
	const run = () => {
		inspector.fire("load", {});
		inspector.runTimeouts();
		return reports().at(-1) as { checks: Array<{ id: string; label: string; count: number; advice: number }>; issues: Array<Record<string, any>> };
	};
	return { inspector, all, run, reports, body };
}

const issuesOf = (report: { issues: Array<Record<string, any>> }, check: string, severity?: string) => report.issues.filter((issue) => issue.check === check && (severity === undefined || issue.severity === severity));
const gray = (value: number) => ({ color: `rgb(${value}, ${value}, ${value})` });

test("S4: the inspector checks text contrast against AA: 4.5 : 1, 3 : 1 for large text, with the real background", () => {
	const page = checkPage([
		{ tag: "p", attrs: { id: "low" }, text: "or pay with card", style: gray(119) },
		{ tag: "p", attrs: { id: "ok" }, text: "fine", style: gray(118) },
		{ tag: "p", attrs: { id: "large-ok" }, text: "Big", style: { ...gray(119), fontSize: "24px" } },
		{ tag: "p", attrs: { id: "large-low" }, text: "Big", style: { ...gray(170), fontSize: "24px" } },
		{ tag: "p", attrs: { id: "bold-ok" }, text: "Bold", style: { ...gray(119), fontSize: "19px", fontWeight: "700" } },
		{ tag: "p", attrs: { id: "bold-low" }, text: "Not bold", style: { ...gray(119), fontSize: "19px", fontWeight: "400" } },
		{ tag: "p", attrs: { id: "alpha" }, text: "Faint", style: { color: "rgba(0, 0, 0, 0.2)" } },
		{ tag: "p", attrs: { id: "dark" }, text: "Light on dark", style: { color: "rgb(246, 239, 243)", backgroundColor: "rgb(26, 18, 24)" } },
		{ tag: "div", style: { backgroundColor: "rgb(0, 0, 0)" }, kids: [{ tag: "p", attrs: { id: "inherits" }, text: "Dark text on a dark parent", style: gray(40) }] },
		{ tag: "div", style: { backgroundImage: "linear-gradient(red, blue)" }, kids: [{ tag: "p", attrs: { id: "on-image" }, text: "Unknown", style: gray(200) }] },
		{ tag: "p", attrs: { id: "hidden" }, text: "Hidden", style: { ...gray(200), display: "none" } },
		{ tag: "p", attrs: { id: "invisible" }, text: "Hidden", style: { ...gray(200), visibility: "hidden" } },
		{ tag: "p", attrs: { id: "empty" }, text: "Zero", style: gray(200), size: [0, 0] },
		{ tag: "button", attrs: { id: "off", disabled: "" }, text: "Disabled", style: gray(200), size: [100, 40] },
		{ tag: "p", attrs: { id: "no-text" }, text: "   ", style: gray(200) },
		{ tag: "script", text: "var x", style: gray(255) },
	]);
	const report = page.run();
	assert.deepEqual(issuesOf(report, "contrast").map((issue) => issue.selector), ["#low", "#large-low", "#bold-low", "#alpha", "#inherits"]);
	const low = issuesOf(report, "contrast")[0];
	assert.deepEqual({ ...low, rect: undefined }, {
		check: "contrast", severity: "fail", title: "Low contrast", selector: "#low", label: "p#low", rect: undefined,
		detail: '"or pay with card" is 4.47 : 1 (#777777 on #ffffff); WCAG AA needs 4.5 : 1.',
	});
	assert.deepEqual(low.rect, { x: 8, y: 68, width: 100, height: 24 });
	assert.match(issuesOf(report, "contrast")[1].detail, /WCAG AA needs 3 : 1 for large text/);
	assert.match(issuesOf(report, "contrast")[3].detail, /\(#cccccc on #ffffff\)/, "translucent text is judged as composited over its background");
	assert.deepEqual(report.checks.find((check) => check.id === "contrast"), { id: "contrast", label: "Text contrast", count: 5, advice: 0 });
});

test("S4: the inspector flags interactive elements under 24 × 24 px, and advises 44 px for the rest", () => {
	const page = checkPage([
		{ tag: "button", attrs: { id: "tiny" }, text: "Go", size: [20, 20] },
		{ tag: "button", attrs: { id: "narrow" }, text: "Go", size: [100, 23] },
		{ tag: "a", attrs: { id: "advice", href: "/pay" }, text: "Pay", size: [100, 28], style: { display: "block" } },
		{ tag: "button", attrs: { id: "edge" }, text: "Edge", size: [24, 24] },
		{ tag: "button", attrs: { id: "big" }, text: "Big", size: [120, 48] },
		{ tag: "a", attrs: { id: "no-href" }, text: "Not a link", size: [10, 10] },
		{ tag: "a", attrs: { id: "inline", href: "/x" }, text: "inline link", size: [60, 14], style: { display: "inline" } },
		{ tag: "button", attrs: { id: "disabled", disabled: "" }, text: "Off", size: [10, 10] },
		{ tag: "input", attrs: { id: "hidden", type: "hidden" }, size: [0, 0] },
		{ tag: "div", attrs: { id: "tab0", tabindex: "0" }, size: [20, 20] },
		{ tag: "div", attrs: { id: "tab-1", tabindex: "-1" }, size: [10, 10] },
		{ tag: "div", attrs: { id: "role-button", role: "button", "aria-label": "Close" }, size: [12, 12] },
		{ tag: "select", attrs: { id: "pick", "aria-label": "Size" }, size: [80, 22] },
		{ tag: "textarea", attrs: { id: "area", "aria-label": "Note" }, size: [200, 80] },
		{ tag: "button", attrs: { id: "gone" }, text: "Hidden", size: [0, 0] },
	]);
	const report = page.run();
	assert.deepEqual(issuesOf(report, "target", "fail").map((issue) => issue.selector), ["#tiny", "#narrow", "#tab0", "#role-button", "#pick"]);
	assert.deepEqual(issuesOf(report, "target", "advice").map((issue) => issue.selector), ["#advice", "#edge"]);
	const tiny = issuesOf(report, "target")[0];
	assert.equal(tiny.title, "Small touch target");
	assert.equal(tiny.detail, '"Go" is 20 × 20 px; WCAG 2.2 needs at least 24 × 24 px.');
	assert.equal(issuesOf(report, "target", "advice")[0].title, "Touch target under 44 px");
	assert.equal(issuesOf(report, "target", "advice")[0].detail, '"Pay" is 100 × 28 px; 44 × 44 px is recommended for touch.');
	assert.equal(issuesOf(report, "target").find((issue) => issue.selector === "#role-button")!.detail.startsWith('"Close"'), true, "named by aria-label");
	assert.deepEqual(report.checks.find((check) => check.id === "target"), { id: "target", label: "Target size", count: 5, advice: 2 });
});

test("S4: the inspector flags images without an alt attribute; alt=\"\" and presentation are fine", () => {
	const page = checkPage([
		{ tag: "img", attrs: { id: "bad", src: "https://example.invalid/img/hero-photo.png?x=1" } },
		{ tag: "img", attrs: { id: "empty", src: "a.png", alt: "" } },
		{ tag: "img", attrs: { id: "named", src: "b.png", alt: "A cup" } },
		{ tag: "img", attrs: { id: "role", src: "c.png", role: "presentation" } },
		{ tag: "img", attrs: { id: "none", src: "d.png", role: "none" } },
		{ tag: "img", attrs: { id: "aria", src: "e.png", "aria-hidden": "true" } },
		{ tag: "input", attrs: { id: "btn", type: "image", src: "f.png" } },
		{ tag: "input", attrs: { id: "btn-ok", type: "image", src: "f.png", alt: "Go" } },
	]);
	const report = page.run();
	assert.deepEqual(issuesOf(report, "alt").map((issue) => issue.selector), ["#bad", "#btn"]);
	assert.equal(issuesOf(report, "alt")[0].title, "Image without alt text");
	assert.equal(issuesOf(report, "alt")[0].detail, 'hero-photo.png has no alt attribute. Describe it, or use alt="" if it is decorative.');
	assert.deepEqual(report.checks.find((check) => check.id === "alt")?.count, 2);
});

test("S4: the inspector flags form fields without an accessible label, and accepts each way of labeling", () => {
	const page = checkPage([
		{ tag: "input", attrs: { id: "aria", type: "text", "aria-label": "Email" } },
		{ tag: "label", attrs: { for: "for" }, text: "Street" },
		{ tag: "input", attrs: { id: "for", type: "text" } },
		{ tag: "label", text: "City", kids: [{ tag: "input", attrs: { id: "wrapped", type: "text" } }] },
		{ tag: "span", attrs: { id: "name" }, text: "Postal code" },
		{ tag: "input", attrs: { id: "by", type: "text", "aria-labelledby": "missing name" } },
		{ tag: "input", attrs: { id: "title", type: "text", title: "Phone" } },
		{ tag: "input", attrs: { id: "placeholder", type: "text", placeholder: "Search" } },
		{ tag: "select", attrs: { id: "select" } },
		{ tag: "textarea", attrs: { id: "area" } },
		{ tag: "input", attrs: { id: "blank", type: "text", "aria-label": "  " } },
		{ tag: "label", attrs: { for: "empty-label" }, text: " " },
		{ tag: "input", attrs: { id: "empty-label", type: "text" } },
		{ tag: "input", attrs: { id: "dangling", type: "text", "aria-labelledby": "nowhere" } },
		{ tag: "input", attrs: { id: "submit", type: "submit", value: "Pay" } },
		{ tag: "input", attrs: { id: "button", type: "button" } },
		{ tag: "input", attrs: { id: "reset", type: "reset" } },
		{ tag: "input", attrs: { id: "hidden", type: "hidden" } },
		{ tag: "input", attrs: { id: "invisible", type: "text" }, style: { display: "none" } },
		{ tag: "input", attrs: { id: "no-type" } },
	]);
	const report = page.run();
	assert.deepEqual(issuesOf(report, "label").map((issue) => issue.selector), ["#placeholder", "#select", "#area", "#blank", "#empty-label", "#dangling", "#no-type"]);
	assert.equal(issuesOf(report, "label")[0].title, "Form field without a label");
	assert.equal(issuesOf(report, "label")[0].detail, 'The text field "Search" has no label. Add a <label for>, aria-label or aria-labelledby; a placeholder is not a label.');
	assert.equal(issuesOf(report, "label")[1].detail, "The select has no label. Add a <label for>, aria-label or aria-labelledby; a placeholder is not a label.");
	assert.deepEqual(report.checks.find((check) => check.id === "label")?.count, 7);
});

test("S4: the inspector flags headings that skip a level, in document order", () => {
	const page = checkPage([
		{ tag: "h1", text: "Title" }, { tag: "h2", text: "A" },
		{ tag: "h4", attrs: { id: "skip1" }, text: "Detail" },
		{ tag: "h2", text: "B" }, { tag: "h3", text: "B1" }, { tag: "h3", text: "B2" },
		{ tag: "h6", attrs: { id: "skip2" }, text: "Fine print" },
		{ tag: "h1", text: "Again" }, { tag: "h2", text: "Ok" },
		{ tag: "div", attrs: { id: "aria", role: "heading", "aria-level": "4" }, text: "ARIA heading" },
		{ tag: "h5", attrs: { id: "hidden" }, text: "Hidden", style: { display: "none" } },
	]);
	const report = page.run();
	assert.deepEqual(issuesOf(report, "heading").map((issue) => issue.selector), ["#skip1", "#skip2", "#aria"]);
	assert.equal(issuesOf(report, "heading")[0].title, "Heading level skipped");
	assert.equal(issuesOf(report, "heading")[0].detail, 'h4 "Detail" follows h2: h3 is missing.');
	assert.equal(issuesOf(report, "heading")[1].detail, 'h6 "Fine print" follows h3: h4, h5 are missing.');
	const clean = checkPage([{ tag: "h2", text: "Starts at two" }, { tag: "h3", text: "x" }, { tag: "h2", text: "y" }]);
	assert.deepEqual(clean.run().issues, [], "the first heading may be any level; going back up is fine");
});

test("S4: a clean page reports every check passed; reports run after load, wait for the page to settle, and are not repeated", () => {
	const page = checkPage([{ tag: "h1", text: "Hello" }, { tag: "p", text: "World" }, { tag: "button", text: "Go", size: [120, 48] }]);
	page.inspector.fire("load", {});
	assert.deepEqual(page.reports(), [], "nothing before the page has settled");
	assert.ok(page.inspector.timeouts.every((timer) => timer.ms >= 100), "after a short delay, so late images and scripts are in");
	page.inspector.runTimeouts();
	assert.equal(page.reports().length, 1);
	const first = page.reports()[0];
	assert.equal(first.type, "gd:checks");
	assert.deepEqual(first.checks.map((check: { id: string; count: number; advice: number }) => [check.id, check.count, check.advice]), [["contrast", 0, 0], ["target", 0, 0], ["alt", 0, 0], ["label", 0, 0], ["heading", 0, 0]]);
	assert.deepEqual(first.checks.map((check: { label: string }) => check.label), ["Text contrast", "Target size", "Images have alt text", "Form fields have labels", "Headings in order"]);
	assert.deepEqual(first.issues, []);
	page.inspector.fire("resize", {});
	page.inspector.runTimeouts();
	assert.equal(page.reports().length, 1, "an unchanged result is not sent again");
	page.all.find((node) => node.localName === "button").size = [10, 10];
	page.inspector.fire("resize", {});
	page.inspector.runTimeouts();
	assert.equal(page.reports().length, 2, "a resize that changes the result sends it");
	assert.equal(page.reports()[1].issues[0].selector, "body > button");
});

test("S4: many findings are capped per check, with the full count reported", () => {
	const page = checkPage(Array.from({ length: 45 }, (_, index) => ({ tag: "p", attrs: { id: `p${index}` }, text: `text ${index}`, style: gray(200) })));
	const report = page.run();
	assert.equal(issuesOf(report, "contrast").length, 20);
	assert.equal(report.checks.find((check) => check.id === "contrast")!.count, 45);
	const advice = checkPage(Array.from({ length: 30 }, (_, index) => ({ tag: "button", attrs: { id: `b${index}` }, text: "x", size: [30, 30] as [number, number] }))).run();
	assert.equal(issuesOf(advice, "target", "advice").length, 10);
	assert.equal(advice.checks.find((check) => check.id === "target")!.advice, 30);
});

test("S4: Show highlights the element by selector through the existing highlight message; a pin id still works", () => {
	const page = checkPage([{ tag: "p", attrs: { id: "low" }, text: "x" }, { tag: "p", attrs: { id: "other" }, text: "y" }]);
	const low = page.all.find((node) => node.id === "low");
	page.inspector.fromParent({ type: "gd:highlight", selector: "#low" });
	assert.equal(low.scrolled, 1);
	page.inspector.fromParent({ type: "gd:highlight", selector: "#missing" });
	page.inspector.fromParent({ type: "gd:highlight", selector: "x".repeat(501) });
	page.inspector.fromParent({ type: "gd:highlight", selector: 5 });
	assert.equal(low.scrolled, 1, "an unknown, oversized or non-string selector highlights nothing");
	page.inspector.fromParent({ type: "gd:pins", pins: [{ id: "c1", selector: "#other" }] });
	page.inspector.fromParent({ type: "gd:highlight", id: "c1" });
	assert.equal(page.all.find((node) => node.id === "other").scrolled, 1);
});

// Accessibility checks (T3): the canvas side: the Checks tab, the artboard list tags, Show and Ask the agent to fix.

const CHECK_LABELS: Array<[string, string]> = [["contrast", "Text contrast"], ["target", "Target size"], ["alt", "Images have alt text"], ["label", "Form fields have labels"], ["heading", "Headings in order"]];
const finding = (extra: Record<string, unknown> = {}) => ({ check: "contrast", severity: "fail", title: "Low contrast", detail: '"or pay with card" is 3.1 : 1 (#999999 on #ffffff); WCAG AA needs 4.5 : 1.', selector: "main > p.or", label: "p.or", rect: { x: 30, y: 40, width: 200, height: 20 }, ...extra });
function checksReport(issues: Array<Record<string, any>> = [], extra: Record<string, unknown> = {}) {
	const checks = CHECK_LABELS.map(([id, label]) => ({
		id, label,
		count: issues.filter((entry) => entry.check === id && entry.severity === "fail").length,
		advice: issues.filter((entry) => entry.check === id && entry.severity === "advice").length,
	}));
	return { type: "gd:checks", checks, issues, ...extra };
}
const report_ = (canvas: Canvas, surface: { contentWindow: unknown }, issues: Array<Record<string, any>> = [], extra: Record<string, unknown> = {}) => canvas.message(surface.contentWindow, checksReport(issues, extra));
const checksPanel = (canvas: Canvas) => canvas.document.getElementById("gd-checks");
const checkCards = (canvas: Canvas) => withClass(checksPanel(canvas), "gd-check");
const navA11y = (canvas: Canvas) => withClass(canvas.document.getElementById("gd-nav-list"), "gd-nav-a11y");
const openChecks = (canvas: Canvas) => canvas.document.getElementById("gd-tab-checks").dispatch("click");

test("S4: the Checks tab sits before Brief with a count, and says when nothing has been checked yet", async () => {
	const canvas = await loadRail();
	const tab = canvas.document.getElementById("gd-tab-checks");
	assert.equal(tab.getAttribute("aria-selected"), "false");
	assert.equal(canvas.document.getElementById("gd-count-checks").textContent, "0");
	openChecks(canvas);
	assert.equal(tab.getAttribute("aria-selected"), "true");
	assert.equal(checksPanel(canvas).hidden, false);
	assert.equal(canvas.document.getElementById("gd-comment-list").hidden, true);
	assert.equal(canvas.document.getElementById("gd-brief").hidden, true);
	assert.equal(canvas.document.getElementById("gd-panel-empty").hidden, true, "the empty comment notice is not shown here");
	assert.equal(canvas.document.getElementById("gd-tabpanel").getAttribute("aria-labelledby"), "gd-tab-checks");
	assert.match(allText(checksPanel(canvas)), /Checks run when an artboard loads\./);
	canvas.document.getElementById("gd-filter-open").dispatch("click");
	assert.equal(checksPanel(canvas).hidden, true);
});

test("S4: results from an artboard's frame fill the tab: count, an issue card per finding, and the passed groups once", async () => {
	const canvas = await loadRail();
	const [first] = canvas.boards;
	report_(canvas, first.frame, [
		finding(),
		finding({ check: "label", title: "Form field without a label", detail: "The select has no label.", selector: "#size", label: "select#size" }),
		finding({ check: "target", severity: "advice", title: "Touch target under 44 px", detail: '"Pay" is 100 × 28 px; 44 × 44 px is recommended for touch.', selector: "#pay", label: "button#pay" }),
	]);
	assert.equal(canvas.document.getElementById("gd-count-checks").textContent, "2", "advice does not count");
	// canvas-ux-quick-wins S2: the selector shows with Technical details on.
	canvas.document.getElementById("gd-technical").dispatch("click");
	openChecks(canvas);
	const groups = withClass(checksPanel(canvas), "gd-check-group");
	assert.equal(groups.length, 1, "one group per checked artboard");
	assert.equal(texts(groups[0], "gd-check-heading")[0], "01 First");
	assert.equal(texts(groups[0], "gd-check-summary")[0], "2 checks");
	assert.deepEqual(checkCards(canvas).map((card) => texts(card, "gd-check-title")[0]), ["Low contrast", "Form field without a label", "Touch target under 44 px"]);
	assert.deepEqual(checkCards(canvas).map((card) => card.classes.has("gd-check-fail")), [true, true, false]);
	assert.deepEqual(checkCards(canvas).map((card) => card.classes.has("gd-check-advice")), [false, false, true]);
	assert.equal(texts(checkCards(canvas)[0], "gd-check-detail")[0], finding().detail);
	assert.equal(texts(checkCards(canvas)[0], "gd-check-selector")[0], "main > p.or");
	assert.equal(texts(checkCards(canvas)[0], "gd-check-kind")[0], "Problem");
	assert.equal(texts(checkCards(canvas)[2], "gd-check-kind")[0], "Advice");
	// Passed groups are listed once: Target size has advice only, so it passed; Text contrast and Form fields failed.
	const passed = texts(groups[0], "gd-check-passed");
	assert.equal(passed.length, 1);
	assert.equal(passed[0], "Passed: Target size · Images have alt text · Headings in order");
});

test("S4: an artboard with no findings reads as passed, and a message from anything else is ignored", async () => {
	const canvas = await loadRail();
	const [first, second] = canvas.boards;
	report_(canvas, first.frame, []);
	openChecks(canvas);
	assert.equal(checkCards(canvas).length, 0);
	assert.equal(texts(checksPanel(canvas), "gd-check-passed")[0], "Passed: Text contrast · Target size · Images have alt text · Form fields have labels · Headings in order");
	assert.match(texts(checksPanel(canvas), "gd-check-summary")[0], /Accessible ✓/);
	// Strangers, thumbnails and malformed reports change nothing.
	canvas.message({}, checksReport([finding()]));
	canvas.message(thumbFrame(canvas, 1).contentWindow, checksReport([finding()]));
	for (const bad of [null, "x", { ...checksReport(), checks: "no" }, { ...checksReport(), issues: "no" }, checksReport([finding({ rect: null })]), checksReport([finding({ selector: "" })]), checksReport([finding({ severity: "boom" })]), checksReport([finding({ check: "unknown" })]), { ...checksReport(), checks: [{ id: "contrast", label: "x", count: -1, advice: 0 }] }]) {
		canvas.message(second.frame.contentWindow, bad);
	}
	assert.equal(withClass(checksPanel(canvas), "gd-check-group").length, 1, "only the first artboard has a result");
	assert.equal(canvas.document.getElementById("gd-count-checks").textContent, "0");
});

test("S4: the system board is excluded from checks", async () => {
	const withSystem = await loadRail(300, { "/t/api/system": { exists: true, file: "system.html", width: 1440, height: 1200 } });
	const system = withSystem.world.children[0].children.find((child) => child.classes.has("gd-frame-box"))!.children.find((child) => child.localName === "iframe")!;
	assert.equal(system.src.includes("system.html"), true);
	report_(withSystem, system, [finding()]);
	assert.equal(withSystem.document.getElementById("gd-count-checks").textContent, "0");
	openChecks(withSystem);
	assert.equal(withClass(checksPanel(withSystem), "gd-check-group").length, 0);
});

test("S4: size frames do not report checks; the artboard's own frame does, whatever its size", async () => {
	const canvas = await loadRail(300, wideAlpha);
	const [first] = canvas.boards;
	focusOn(canvas);
	sizeButton(canvas, "all").dispatch("click");
	for (const frame of sizeSections(canvas).map(iframeOf)) report_(canvas, frame, [finding()]);
	assert.equal(canvas.document.getElementById("gd-count-checks").textContent, "0", "size frames are not the artboard");
	report_(canvas, first.frame, [finding()]);
	assert.equal(canvas.document.getElementById("gd-count-checks").textContent, "1");
});

test("S4: each artboard's list item carries Accessible ✓ (canvas-ux S3, was A11y ✓) or N checks; none before the artboard has reported", async () => {
	const canvas = await loadRail();
	const [first, second] = canvas.boards;
	assert.deepEqual(navA11y(canvas), []);
	report_(canvas, first.frame, []);
	report_(canvas, second.frame, [finding(), finding({ selector: "#b" }), finding({ check: "target", severity: "advice", selector: "#c" })]);
	assert.deepEqual(navA11y(canvas).map((tag) => tag.textContent), ["Accessible ✓", "2 checks"]);
	assert.deepEqual(navA11y(canvas).map((tag) => tag.dataset.state), ["ok", "warn"]);
	assert.match(navA11y(canvas)[1].title, /Checks tab/);
	assert.match(navA11y(canvas)[0].title, /heuristics/i);
	report_(canvas, second.frame, [finding()]);
	assert.equal(navA11y(canvas)[1].textContent, "1 check", "singular");
	// A chosen tag and the checks tag live side by side.
	await setHandoffs(canvas, handoffDoc("02-b.html", { "02-b.html": {} }));
	assert.deepEqual(navTexts(canvas, "gd-nav-tag"), ["Discarded", "Chosen"]);
	assert.equal(navA11y(canvas).length, 2);
});

test("S4: results are refreshed on reload: a reloading artboard drops its result until it reports again", async () => {
	const canvas = await loadRail();
	const [first] = canvas.boards;
	report_(canvas, first.frame, [finding()]);
	assert.equal(navA11y(canvas)[0].textContent, "1 check");
	await canvas.serverEvent("change", { slug: "alpha", file: "01-a.html" });
	first.frame.dispatch("load");
	assert.deepEqual(navA11y(canvas), [], "stale tag gone");
	assert.equal(canvas.document.getElementById("gd-count-checks").textContent, "0");
	openChecks(canvas);
	assert.equal(withClass(checksPanel(canvas), "gd-check-group").length, 0);
	report_(canvas, first.frame, []);
	assert.equal(navA11y(canvas)[0].textContent, "Accessible ✓");
	// A frame that resizes (a size picked) re-reports through the same channel and replaces the result.
	report_(canvas, first.frame, [finding(), finding({ selector: "#b" })]);
	assert.equal(navA11y(canvas)[0].textContent, "2 checks");
});

test("S4: Show highlights the element in the artboard's frame through gd:highlight with its selector", async () => {
	const canvas = await loadRail();
	const [first] = canvas.boards;
	first.frame.rect = { left: 100, top: 120, width: 400, height: 300 };
	report_(canvas, first.frame, [finding()]);
	openChecks(canvas);
	const show = withClass(checkCards(canvas)[0], "gd-check-show")[0];
	assert.equal(allText(show).includes("Show"), true);
	assert.match(show.getAttribute("aria-label")!, /^Show Low contrast on p\.or in 01 First$/);
	const before = canvas.world.style.transform;
	show.dispatch("click");
	assert.deepEqual(first.frame.contentWindow!.posted.at(-1), { type: "gd:highlight", selector: "main > p.or" });
	assert.notEqual(canvas.world.style.transform, before, "the canvas centers the element when the artboard is not in focus");
});

test("S4: Show works in focus mode (no pan) and across artboards (leaves focus on another), and reaches every size frame", async () => {
	const canvas = await loadRail(300, wideAlpha);
	const [first, second] = canvas.boards;
	report_(canvas, first.frame, [finding()]);
	report_(canvas, second.frame, [finding({ selector: "#second" })]);
	navItems(canvas)[0].dispatch("click");
	openChecks(canvas);
	const transform = canvas.world.style.transform;
	withClass(checkCards(canvas)[0], "gd-check-show")[0].dispatch("click");
	assert.equal(canvas.world.style.transform, transform, "the focused artboard stays put");
	assert.deepEqual(first.frame.contentWindow!.posted.at(-1), { type: "gd:highlight", selector: "main > p.or" });
	// Another artboard's issue leaves focus mode first.
	withClass(checkCards(canvas)[1], "gd-check-show")[0].dispatch("click");
	assert.doesNotMatch(canvas.navMode.textContent, /^Using:/);
	assert.deepEqual(second.frame.contentWindow!.posted.at(-1), { type: "gd:highlight", selector: "#second" });
	// In All sizes the highlight reaches each size frame.
	navItems(canvas)[0].dispatch("click");
	sizeButton(canvas, "all").dispatch("click");
	withClass(checkCards(canvas)[0], "gd-check-show")[0].dispatch("click");
	for (const frame of sizeSections(canvas).map(iframeOf)) assert.deepEqual(frame.contentWindow!.posted.at(-1), { type: "gd:highlight", selector: "main > p.or" });
});

test("S4: Ask the agent to fix on an issue opens the comment popover on that element, prefilled and editable, following Send now / Collect", async () => {
	const canvas = await loadRail();
	const [first] = canvas.boards;
	first.frame.rect = { left: 100, top: 120, width: 400, height: 300 };
	report_(canvas, first.frame, [finding()]);
	openChecks(canvas);
	const fix = withClass(checkCards(canvas)[0], "gd-check-fix")[0];
	assert.equal(allText(fix).includes("Ask the agent to fix"), true);
	fix.dispatch("click");
	const popover = canvas.document.getElementById("gd-popover");
	assert.equal(popover.hidden, false);
	assert.equal(canvas.document.getElementById("gd-popover-target").textContent, "01-a.html · main > p.or");
	const text = canvas.document.getElementById("gd-popover-text").value;
	assert.equal(text, `Accessibility check on main > p.or: Low contrast.\n${finding().detail}\nFix it so it meets WCAG 2.2 AA, keeping the design's tokens.`);
	canvas.document.getElementById("gd-mode-collect").dispatch("change");
	canvas.document.getElementById("gd-popover-text").value = `${text}\nAlso on hover.`;
	canvas.document.getElementById("gd-popover-form").dispatch("submit");
	await flush();
	const body = canvas.posts.at(-1)!.body as any;
	assert.deepEqual({ ...body, comment: undefined }, { slug: "alpha", file: "01-a.html", selector: "main > p.or", excerpt: "p.or", comment: undefined, mode: "collect" });
	assert.match(body.comment, /Also on hover\.$/);
	// Advice reads "Consider" instead of a failure.
	report_(canvas, first.frame, [finding({ check: "target", severity: "advice", title: "Touch target under 44 px", detail: "x", selector: "#pay", label: "button#pay" })]);
	withClass(checkCards(canvas)[0], "gd-check-fix")[0].dispatch("click");
	assert.match(canvas.document.getElementById("gd-popover-text").value, /^Accessibility advice on #pay: Touch target under 44 px\.\nx\nConsider /);
});

test("S4: an issue in another artboard than the focused one leaves that focus before asking", async () => {
	const canvas = await loadRail();
	const [first, second] = canvas.boards;
	report_(canvas, second.frame, [finding({ selector: "#second" })]);
	navItems(canvas)[0].dispatch("click");
	openChecks(canvas);
	second.frame.rect = { left: 100, top: 120, width: 400, height: 300 };
	withClass(checkCards(canvas)[0], "gd-check-fix")[0].dispatch("click");
	assert.equal(canvas.document.getElementById("gd-popover").hidden, false);
	assert.equal(canvas.document.getElementById("gd-popover-target").textContent, "02-b.html · #second");
	assert.equal(first.shield!.hidden, false);
});

test("S4: the Checks tab follows the design: results of the old design never show under a new one", async () => {
	const canvas = await loadRail();
	report_(canvas, canvas.boards[0].frame, [finding()]);
	await canvas.serverEvent("show", { slug: "beta" });
	assert.equal(canvas.document.getElementById("gd-count-checks").textContent, "0");
	openChecks(canvas);
	assert.equal(withClass(checksPanel(canvas), "gd-check-group").length, 0);
	assert.deepEqual(navA11y(canvas), []);
});

test("S4: index.html and canvas.css carry the Checks tab, the issue cards and the list tag with tokens only", () => {
	const html = read("index.html");
	assert.match(html, /<button type="button" role="tab" id="gd-tab-checks" class="gd-tab" aria-selected="false" aria-controls="gd-tabpanel" tabindex="-1"><span data-i18n="tab.checks">Checks<\/span> <span id="gd-count-checks" class="gd-count">0<\/span><\/button>/);
	assert.ok(html.indexOf('id="gd-tab-history"') < html.indexOf('id="gd-tab-checks"') && html.indexOf('id="gd-tab-checks"') < html.indexOf('id="gd-tab-brief"'));
	assert.match(html, /<div id="gd-checks" class="gd-checks" hidden>/);
	const css = read("canvas.css");
	for (const selector of [".gd-checks", ".gd-check-group", ".gd-check", ".gd-check-fail", ".gd-check-advice", ".gd-check-passed", ".gd-nav-a11y"]) assert.ok(css.includes(`${selector} {`) || css.includes(`${selector},`) || css.includes(`${selector}[`), `${selector} is styled`);
	assert.match(css, /\.gd-nav-a11y\[data-state="ok"\]\s*{[^}]*color:\s*var\(--success\)/);
	assert.match(css, /\.gd-nav-a11y\[data-state="warn"\]\s*{[^}]*color:\s*var\(--warning\)/);
	assert.match(css, /\.gd-check-passed[^{]*{[^}]*border-style:\s*dashed/);
});

// Version history (T2): the History tab, comparing a version with the current artboard, restoring.

const HISTORY_URL = "/t/api/designs/alpha/history";
const RESTORE_URL = "/t/api/designs/alpha/history/restore";
const stamp = (hour: number, minute: number) => new Date(2020, 2, 4, hour, minute).toISOString();
const shownTime = (hour: number, minute: number) => `Mar 4 2020, ${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
const SHA = "0".repeat(64);
const version = (n: number, source: string, hour: number, minute: number, extra: Record<string, unknown> = {}) => ({ n, createdAt: stamp(hour, minute), source, sha256: SHA, ...extra });
const historyDoc = (artboards: Record<string, unknown[]>, warnings: string[] = []) => ({ version: 1, artboards: Object.fromEntries(Object.entries(artboards).map(([file, versions]) => [file, { versions }])), warnings });
const FIRST_VERSIONS = [version(1, "hand", 9, 1, { note: "Edited by hand" }), version(2, "agent", 9, 2, { comment: "a1", note: "Shortened the headline" }), version(3, "restore", 9, 3), version(4, "hand", 9, 4)];
const HISTORY = historyDoc({ "01-a.html": FIRST_VERSIONS, "02-b.html": [version(1, "hand", 9, 10), version(2, "hand", 9, 11)] });

async function withHistory(doc: unknown = HISTORY, extra: Record<string, unknown> = {}, extraContext: Record<string, unknown> = {}) {
	const canvas = await loadRail(300, { [HISTORY_URL]: doc, ...commentsDoc(comment("a1", "01-a.html", "resolved")), ...extra }, {}, extraContext);
	tallViewport(canvas);
	return canvas;
}
const historyTab = (canvas: Canvas) => canvas.document.getElementById("gd-tab-history");
const historyPanel = (canvas: Canvas) => canvas.document.getElementById("gd-history");
const openHistory = (canvas: Canvas) => historyTab(canvas).dispatch("click");
const historyCount = (canvas: Canvas) => canvas.document.getElementById("gd-count-history").textContent;
const versionCards = (canvas: Canvas) => withClass(historyPanel(canvas), "gd-version");
const cardOf = (canvas: Canvas, n: number) => versionCards(canvas).find((card) => card.dataset.n === String(n))!;
const cardButton = (canvas: Canvas, className: string, n: number) => withClass(cardOf(canvas, n), className)[0];
const historyAlert = (canvas: Canvas) => withClass(historyPanel(canvas), "gd-alert")[0];
const fetchCount = (canvas: Canvas, url: string) => canvas.fetched.filter((entry) => entry === url).length;

test("S2: the History tab sits after Comments (canvas-ux S4: no Resolved tab) with its own count, and arrow keys reach it", async () => {
	const canvas = await withHistory();
	assert.equal(historyTab(canvas).getAttribute("aria-selected"), "false");
	assert.equal(historyTab(canvas).getAttribute("tabindex"), "-1");
	assert.equal(historyPanel(canvas).hidden, true);
	assert.equal(historyCount(canvas), "4", "the first artboard's four versions");
	openHistory(canvas);
	assert.equal(historyTab(canvas).getAttribute("aria-selected"), "true");
	assert.equal(historyTab(canvas).getAttribute("tabindex"), "0");
	assert.equal(historyPanel(canvas).hidden, false);
	assert.equal(canvas.document.getElementById("gd-comment-list").hidden, true);
	assert.equal(canvas.document.getElementById("gd-checks").hidden, true);
	assert.equal(canvas.document.getElementById("gd-brief").hidden, true);
	assert.equal(canvas.document.getElementById("gd-panel-empty").hidden, true);
	assert.equal(canvas.document.getElementById("gd-tabpanel").getAttribute("aria-labelledby"), "gd-tab-history");
	const tablist = canvas.document.getElementById("gd-tabs");
	tablist.dispatch("keydown", { key: "ArrowRight" });
	assert.equal(canvas.document.getElementById("gd-tab-checks").getAttribute("aria-selected"), "true");
	tablist.dispatch("keydown", { key: "ArrowLeft" });
	assert.equal(historyTab(canvas).getAttribute("aria-selected"), "true");
	assert.equal(canvas.document.activeElement, historyTab(canvas));
	tablist.dispatch("keydown", { key: "ArrowLeft" });
	assert.equal(canvas.document.getElementById("gd-tab-comments").getAttribute("aria-selected"), "true");
	assert.equal(historyPanel(canvas).hidden, true, "leaving the tab hides it");
});

test("S2: the History tab shows the focused artboard's versions, else the chosen one's, else the first's", async () => {
	const canvas = await withHistory();
	openHistory(canvas);
	assert.equal(texts(historyPanel(canvas), "gd-history-title")[0], "01 First");
	assert.equal(historyCount(canvas), "4");
	await setHandoffs(canvas, handoffDoc("02-b.html", { "02-b.html": {} }));
	assert.equal(texts(historyPanel(canvas), "gd-history-title")[0], "02 Second", "the chosen artboard when none is focused");
	assert.equal(historyCount(canvas), "2");
	assert.deepEqual(versionCards(canvas).map((card) => card.dataset.n), ["2", "1"]);
	navItems(canvas)[0].dispatch("click");
	assert.equal(texts(historyPanel(canvas), "gd-history-title")[0], "01 First", "the focused artboard beats the chosen one");
	assert.equal(historyCount(canvas), "4");
	canvas.document.getElementById("gd-back").dispatch("click");
	assert.equal(texts(historyPanel(canvas), "gd-history-title")[0], "02 Second", "and the choice returns when focus ends");
});

test("S2: focus on the design system board does not change the History artboard", async () => {
	const canvas = await withHistory(HISTORY, { "/t/api/system": { exists: true, file: "system.html", width: 1440, height: 1200 } });
	openHistory(canvas);
	canvas.document.getElementById("gd-rail-system").dispatch("click");
	assert.equal(texts(historyPanel(canvas), "gd-history-title")[0], "01 First");
	assert.equal(historyCount(canvas), "4");
});

test("S2: versions are listed newest first with Current, who, time, the applied comment and the note", async () => {
	const canvas = await withHistory();
	openHistory(canvas);
	assert.deepEqual(versionCards(canvas).map((card) => card.dataset.n), ["4", "3", "2", "1"]);
	assert.deepEqual(versionCards(canvas).map((card) => texts(card, "gd-version-number")[0]), ["v4", "v3", "v2", "v1"]);
	assert.deepEqual(versionCards(canvas).map((card) => texts(card, "gd-version-tag")), [["Current"], [], [], ["Original"]]);
	assert.deepEqual(versionCards(canvas).map((card) => texts(card, "gd-version-meta")[0]), [`You · ${shownTime(9, 4)}`, `Restore · ${shownTime(9, 3)}`, `Agent · ${shownTime(9, 2)}`, `You · ${shownTime(9, 1)}`], "hand shows as You");
	assert.ok(cardOf(canvas, 4).classes.has("gd-version-current"));
	assert.ok(!cardOf(canvas, 3).classes.has("gd-version-current"));
	// The comment this version applied, by its number in the Comments list.
	assert.deepEqual(versionCards(canvas).map((card) => texts(card, "gd-version-applied")), [[], [], ["Applied #1"], []]);
	// An agent's note is its reply; a hand edit's note is plain text.
	assert.equal(withClass(cardOf(canvas, 2), "gd-version-reply").length, 1);
	assert.equal(texts(cardOf(canvas, 2), "gd-version-reply-label")[0], "Agent:");
	assert.equal(texts(cardOf(canvas, 2), "gd-version-reply-text")[0], "Shortened the headline");
	assert.equal(withClass(cardOf(canvas, 1), "gd-version-reply").length, 0);
	assert.equal(texts(cardOf(canvas, 1), "gd-version-note")[0], "Edited by hand");
	assert.equal(withClass(cardOf(canvas, 3), "gd-version-note").length + withClass(cardOf(canvas, 3), "gd-version-reply").length, 0);
	assert.match(texts(historyPanel(canvas), "gd-history-note")[0], /design\/alpha\/\.history\/.*Restore saves the current one first, so nothing is lost\./);
	assert.equal(historyAlert(canvas).hidden, true);
});

test("S2: older versions offer Compare with current and Restore; the current one offers View", async () => {
	const canvas = await withHistory();
	openHistory(canvas);
	const actions = (n: number) => withClass(cardOf(canvas, n), "gd-version-actions")[0].children.map((button) => button.className.split(" ").find((name) => /^gd-version-(compare|restore|view)$/.test(name)));
	assert.deepEqual(actions(4), ["gd-version-view"]);
	for (const n of [3, 2, 1]) assert.deepEqual(actions(n), ["gd-version-compare", "gd-version-restore"], `v${n}`);
	assert.equal(allText(cardButton(canvas, "gd-version-compare", 3)).includes("Compare with current"), true);
	assert.equal(cardButton(canvas, "gd-version-compare", 3).getAttribute("aria-label"), "Compare v3 with the current version");
	assert.equal(cardButton(canvas, "gd-version-restore", 3).getAttribute("aria-label"), "Restore v3");
	assert.equal(cardButton(canvas, "gd-version-view", 4).getAttribute("aria-label"), "View the current version, v4");
	assert.ok(withClass(historyPanel(canvas), "gd-version").every((card) => card.localName === "article"));
});

test("S2: warnings of the history reply show as muted lines, and an artboard with no versions says so", async () => {
	const canvas = await withHistory(historyDoc({ "02-b.html": [version(1, "hand", 9, 10)] }, ["evil.html is a link or inside a linked folder, so its versions are not stored.", "big.html is larger than 8388608 bytes, so its versions are not stored."]));
	openHistory(canvas);
	assert.deepEqual(texts(historyPanel(canvas), "gd-history-warning"), ["evil.html is a link or inside a linked folder, so its versions are not stored.", "big.html is larger than 8388608 bytes, so its versions are not stored."]);
	assert.equal(texts(historyPanel(canvas), "gd-history-empty")[0], "No versions of this artboard yet. The canvas keeps one when it first sees an artboard and whenever its file changes.");
	assert.equal(versionCards(canvas).length, 0);
	assert.equal(historyCount(canvas), "0");
});

test("S2: a malformed history reply never breaks the canvas and shows no versions", async () => {
	for (const doc of [{ version: 1, artboards: "no" }, { version: 1, artboards: { "01-a.html": { versions: [{ n: "x" }, null, { n: 0, createdAt: "x", source: "hand" }, { n: 1, createdAt: "x", source: "robot" }] } } }, null]) {
		const canvas = await withHistory(doc);
		assert.equal(historyCount(canvas), "0", JSON.stringify(doc));
		openHistory(canvas);
		assert.equal(versionCards(canvas).length, 0);
		assert.equal(canvas.document.getElementById("gd-status").textContent, "");
	}
});

test("S2: an event: history refreshes the list; events for another design or malformed ones do not", async () => {
	const canvas = await withHistory();
	openHistory(canvas);
	const before = fetchCount(canvas, HISTORY_URL);
	assert.ok(before >= 1, "loaded when the design was");
	canvas.replies[HISTORY_URL] = historyDoc({ "01-a.html": [...FIRST_VERSIONS, version(5, "agent", 9, 5)], "02-b.html": [version(1, "hand", 9, 10)] });
	await canvas.serverEvent("history", { slug: "beta", file: "01-a.html", n: 5 });
	for (const data of [null, "x", { slug: 3 }, {}, { slug: "../x" }]) await canvas.serverEvent("history", data);
	assert.equal(fetchCount(canvas, HISTORY_URL), before, "no refresh for them");
	await canvas.serverEvent("history", { slug: "alpha", file: "01-a.html", n: 5 });
	assert.equal(fetchCount(canvas, HISTORY_URL), before + 1);
	assert.equal(historyCount(canvas), "5");
	assert.deepEqual(versionCards(canvas).map((card) => card.dataset.n), ["5", "4", "3", "2", "1"]);
	assert.deepEqual(texts(cardOf(canvas, 5), "gd-version-tag"), ["Current"]);
	assert.deepEqual(texts(cardOf(canvas, 4), "gd-version-tag"), [], "the old current one is no longer current");
	assert.equal(withClass(cardOf(canvas, 4), "gd-version-view").length, 0);
	assert.equal(withClass(cardOf(canvas, 4), "gd-version-compare").length, 1);
});

test("S2: the count follows the design: another design starts empty, then loads its own history", async () => {
	const canvas = await withHistory(HISTORY, { "/t/api/designs/beta/history": historyDoc({ "01-only.html": [version(1, "hand", 9, 1)] }) });
	await canvas.serverEvent("show", { slug: "beta" });
	assert.equal(historyCount(canvas), "1");
	assert.ok(canvas.fetched.includes("/t/api/designs/beta/history"));
});

test("S2/S4: a failing history load shows the S12-style alert in the tab, and a good reload clears it", async () => {
	const canvas = await withHistory({ __http: 422, error: "invalid-history", reason: "history index.json is not valid JSON" });
	assert.equal(canvas.document.getElementById("gd-status").textContent, "", "the status line is not used");
	openHistory(canvas);
	assert.equal(historyAlert(canvas).hidden, false);
	assert.match(texts(historyAlert(canvas), "gd-alert-text")[0], /version history of this design cannot be used/);
	assert.doesNotMatch(texts(historyAlert(canvas), "gd-alert-text")[0], /Something went wrong/);
	assert.equal(texts(historyAlert(canvas), "gd-alert-detail")[0], "invalid-history: history index.json is not valid JSON");
	assert.equal(historyAlert(canvas).getAttribute("role"), "alert");
	assert.equal(versionCards(canvas).length, 0);
	canvas.replies[HISTORY_URL] = HISTORY;
	await canvas.serverEvent("history", { slug: "alpha", file: "01-a.html", n: 1 });
	assert.equal(historyAlert(canvas).hidden, true);
	assert.equal(versionCards(canvas).length, 4);
	// The index being full is explained too, and the old list stays while it fails.
	canvas.replies[HISTORY_URL] = { __http: 409, error: "history-limit", reason: "index too big" };
	await canvas.serverEvent("history", { slug: "alpha", file: "01-a.html", n: 2 });
	assert.match(texts(historyAlert(canvas), "gd-alert-text")[0], /history index is full[^]*Delete old versions/);
	assert.equal(versionCards(canvas).length, 4, "the last good list stays");
});

test("S2: the alert can be dismissed", async () => {
	const canvas = await withHistory({ __http: 409, error: "history-limit" });
	openHistory(canvas);
	assert.equal(historyAlert(canvas).hidden, false);
	withClass(historyAlert(canvas), "gd-alert-dismiss")[0].dispatch("click");
	assert.equal(historyAlert(canvas).hidden, true);
});

// ---- Compare

const versionsPanel = (canvas: Canvas) => canvas.document.getElementById("gd-versions");
const compareFrames = (canvas: Canvas) => findAll(versionsPanel(canvas), (element) => element.localName === "iframe");
const compareLabels = (canvas: Canvas) => texts(versionsPanel(canvas), "gd-versions-label");
const sliderHandle = (canvas: Canvas) => withClass(versionsPanel(canvas), "gd-versions-handle")[0];
const compareBox = (canvas: Canvas) => withClass(versionsPanel(canvas), "gd-versions-compare")[0];
const compareShield = (canvas: Canvas) => withClass(versionsPanel(canvas), "gd-versions-shield")[0];
const modeButton = (canvas: Canvas, mode: "slider" | "side") => canvas.document.getElementById(`gd-versions-mode-${mode}`);
async function comparing(n = 3, doc: unknown = HISTORY) {
	const canvas = await withHistory(doc);
	openHistory(canvas);
	cardButton(canvas, "gd-version-compare", n).dispatch("click");
	return canvas;
}

test("S3: Compare with current enters focus mode and puts the old version and the current artboard in two sandboxed frames", async () => {
	const canvas = await comparing(3);
	assert.equal(canvas.navMode.textContent, "Using: First · Shift+Esc to exit", "focus mode is entered when needed");
	assert.equal(versionsPanel(canvas).hidden, false);
	assert.equal(canvas.world.inert, true, "the artboards under the comparison are out of reach");
	const [older, current] = compareFrames(canvas);
	assert.equal(compareFrames(canvas).length, 2);
	assert.equal(older.src, "/t/history/alpha/3/01-a.html");
	assert.equal(current.src, "/t/files/alpha/01-a.html");
	for (const frame of [older, current]) {
		assert.equal(frame.getAttribute("sandbox"), "allow-scripts");
		assert.equal(frame.getAttribute("referrerpolicy"), "no-referrer");
		assert.equal(frame.getAttribute("tabindex"), "-1");
		assert.equal([frame.style.width, frame.style.height].join(" "), "400px 300px", "at the artboard's size");
	}
	assert.equal(older.title, "First artboard, v3");
	assert.equal(current.title, "First artboard, current version");
	assert.deepEqual(compareLabels(canvas), [`v3 · ${shownTime(9, 3)}`, "v4 · Current"]);
	assert.equal(texts(versionsPanel(canvas), "gd-versions-title")[0] ?? canvas.document.getElementById("gd-versions-title").textContent, "Compare versions · First");
	assert.equal(modeButton(canvas, "slider").getAttribute("aria-pressed"), "true");
	assert.equal(modeButton(canvas, "side").getAttribute("aria-pressed"), "false");
	assert.ok(cardOf(canvas, 3).classes.has("gd-version-comparing"));
	assert.deepEqual(texts(cardOf(canvas, 3), "gd-version-comparing-chip"), ["Comparing"]);
	assert.equal(canvas.document.activeElement, sliderHandle(canvas), "the slider takes the keyboard");
});

test("S3: a version of an artboard in a folder gets an encoded path; the compared board's file is the one compared", async () => {
	const canvas = await loadRail(300, {
		"/t/api/designs/alpha": { slug: "alpha", title: "Alpha", brief: "", artboards: [{ file: "sub dir/01 a.html", title: "Inner", tradeoff: "", width: 400, height: 300 }] },
		[HISTORY_URL]: historyDoc({ "sub dir/01 a.html": [version(1, "hand", 9, 1), version(2, "hand", 9, 2)] }),
	});
	openHistory(canvas);
	cardButton(canvas, "gd-version-compare", 1).dispatch("click");
	assert.deepEqual(compareFrames(canvas).map((frame) => frame.src), ["/t/history/alpha/1/sub%20dir/01%20a.html", "/t/files/alpha/sub%20dir/01%20a.html"]);
});

test("S3: the slider starts in the middle, is a named slider with a value, and follows the pointer", async () => {
	const canvas = await comparing(3);
	const handle = sliderHandle(canvas);
	assert.equal(handle.getAttribute("role"), "slider");
	assert.equal(handle.getAttribute("tabindex"), "0");
	assert.equal(handle.getAttribute("aria-label"), "Comparison position");
	assert.equal(handle.getAttribute("aria-orientation"), "horizontal");
	assert.deepEqual([handle.getAttribute("aria-valuemin"), handle.getAttribute("aria-valuemax"), handle.getAttribute("aria-valuenow")], ["0", "100", "50"]);
	assert.match(handle.getAttribute("aria-valuetext")!, /^50%: v3 on the left, v4 \(current\) on the right$/);
	const newer = withClass(versionsPanel(canvas), "gd-versions-box")[1];
	assert.equal(newer.style.clipPath, "inset(0 0 0 50%)");
	assert.equal(handle.style.left, "50%");
	compareBox(canvas).rect = { left: 100, top: 150, width: 400, height: 300 };
	const shield = compareShield(canvas);
	shield.dispatch("pointerdown", { button: 0, pointerId: 1, clientX: 200 });
	assert.equal(handle.getAttribute("aria-valuenow"), "25");
	assert.equal(newer.style.clipPath, "inset(0 0 0 25%)");
	assert.equal(handle.style.left, "25%");
	shield.dispatch("pointermove", { pointerId: 1, clientX: 450 });
	assert.equal(handle.getAttribute("aria-valuenow"), "87.5");
	shield.dispatch("pointermove", { pointerId: 2, clientX: 120 });
	assert.equal(handle.getAttribute("aria-valuenow"), "87.5", "another pointer is not this drag");
	shield.dispatch("pointerup", { button: 0, pointerId: 1, clientX: 450 });
	shield.dispatch("pointermove", { pointerId: 1, clientX: 120 });
	assert.equal(handle.getAttribute("aria-valuenow"), "87.5", "moves after the drag are ignored");
	shield.dispatch("pointerdown", { button: 0, pointerId: 3, clientX: 900 });
	assert.equal(handle.getAttribute("aria-valuenow"), "100", "clamped to the frame");
	shield.dispatch("pointermove", { pointerId: 3, clientX: -50 });
	assert.equal(handle.getAttribute("aria-valuenow"), "0");
	shield.dispatch("pointerdown", { button: 2, pointerId: 4, clientX: 300 });
	assert.equal(handle.getAttribute("aria-valuenow"), "0", "only the main button drags");
	assert.equal(canvas.document.activeElement, handle, "dragging puts the keyboard on the slider");
});

test("S3: arrow keys move the slider 2%, Shift+arrows 10%, Home and End jump, and it stops at the ends", async () => {
	const canvas = await comparing(3);
	const handle = sliderHandle(canvas);
	const value = () => handle.getAttribute("aria-valuenow");
	const key = (name: string, shiftKey = false) => handle.dispatch("keydown", { key: name, shiftKey });
	key("ArrowRight");
	assert.equal(value(), "52");
	key("ArrowRight", true);
	assert.equal(value(), "62");
	key("ArrowLeft");
	assert.equal(value(), "60");
	key("ArrowLeft", true);
	assert.equal(value(), "50");
	key("End");
	assert.equal(value(), "100");
	key("ArrowRight", true);
	assert.equal(value(), "100");
	key("Home");
	assert.equal(value(), "0");
	key("ArrowLeft");
	assert.equal(value(), "0");
	key("ArrowRight");
	assert.match(handle.getAttribute("aria-valuetext")!, /^2%: v3 on the left/);
	const other = handle.dispatch("keydown", { key: "a" });
	assert.equal(other.defaultPrevented, false, "other keys are left alone");
	key("ArrowRight");
	assert.equal(value(), "4");
});

test("S3: Side by side shows both frames next to each other without reloading them, and Slider returns", async () => {
	const canvas = await comparing(3);
	const frames = compareFrames(canvas);
	const srcs = frames.map((frame) => frame.src);
	sliderHandle(canvas).dispatch("keydown", { key: "ArrowRight", shiftKey: true });
	modeButton(canvas, "side").dispatch("click");
	assert.equal(modeButton(canvas, "side").getAttribute("aria-pressed"), "true");
	assert.equal(modeButton(canvas, "slider").getAttribute("aria-pressed"), "false");
	assert.equal(canvas.document.getElementById("gd-versions-stage").dataset.mode, "side");
	assert.equal(sliderHandle(canvas).hidden, true, "no handle in side by side");
	assert.equal(compareShield(canvas).hidden, true);
	assert.deepEqual(compareFrames(canvas), frames, "the same frames: nothing reloads");
	assert.deepEqual(frames.map((frame) => frame.src), srcs);
	assert.deepEqual(compareLabels(canvas), [`v3 · ${shownTime(9, 3)}`, "v4 · Current"], "both labels stay");
	const newer = withClass(versionsPanel(canvas), "gd-versions-box")[1];
	assert.equal(newer.style.clipPath, "", "the newer one is not clipped any more");
	modeButton(canvas, "slider").dispatch("click");
	assert.equal(canvas.document.getElementById("gd-versions-stage").dataset.mode, "slider");
	assert.equal(sliderHandle(canvas).hidden, false);
	assert.equal(sliderHandle(canvas).getAttribute("aria-valuenow"), "60", "the slider position was kept");
	assert.equal(newer.style.clipPath, "inset(0 0 0 60%)");
	assert.deepEqual(compareFrames(canvas), frames);
});

test("S3: frames are scaled to fit under the bar and above Back to canvas; side by side fits both", async () => {
	const canvas = await loadRail(300, { [HISTORY_URL]: HISTORY, "/t/api/designs/alpha": { slug: "alpha", title: "Alpha", brief: "", artboards: [{ file: "01-a.html", title: "First", tradeoff: "", width: 1200, height: 800 }, { file: "02-b.html", title: "Second", tradeoff: "", width: 400, height: 300 }] } });
	canvas.viewport.rect = { left: 0, top: 50, width: 1000, height: 700 };
	openHistory(canvas);
	cardButton(canvas, "gd-version-compare", 3).dispatch("click");
	const scaleOf = () => Number(/^scale\(([\d.]+)\)$/.exec(withClass(versionsPanel(canvas), "gd-versions-scale")[0].style.transform)![1]);
	// 968 px wide, 700 - 72 (bar) - 64 (Back to canvas) = 564 px high.
	assert.equal(scaleOf(), 564 / 800);
	const box = withClass(versionsPanel(canvas), "gd-versions-box")[0];
	assert.deepEqual([box.style.width, box.style.height], [`${Math.round(1200 * (564 / 800))}px`, "564px"]);
	assert.deepEqual([compareBox(canvas).style.width, compareBox(canvas).style.height], [box.style.width, box.style.height], "the slider box is the size of one frame");
	modeButton(canvas, "side").dispatch("click");
	assert.equal(scaleOf(), (968 - 20) / 2400, "two frames and a gap across 968 px");
	assert.equal(compareBox(canvas).style.width, "", "side by side lets the frames set the width");
	canvas.viewport.rect = { left: 0, top: 50, width: 700, height: 700 };
	canvas.windowEvent("resize");
	assert.ok(scaleOf() < (968 - 20) / 2400, "a narrower viewport scales it down");
	modeButton(canvas, "slider").dispatch("click");
	assert.equal(scaleOf(), 668 / 1200);
	const small = await comparing(3);
	assert.match(withClass(versionsPanel(small), "gd-versions-scale")[0].style.transform, /^scale\(1\)$/, "an artboard that fits stays at 100%");
});

test("S3: Close comparison, Esc and Shift+Esc close it; entering focus mode for it is undone, an earlier focus stays", async () => {
	for (const how of ["button", "escape", "shift-escape"] as const) {
		const canvas = await comparing(3);
		const [older, current] = compareFrames(canvas);
		if (how === "button") canvas.document.getElementById("gd-versions-close").dispatch("click");
		else press(canvas, "Escape", { shiftKey: how === "shift-escape" }, sliderHandle(canvas));
		assert.equal(versionsPanel(canvas).hidden, true, how);
		assert.equal(canvas.world.inert, false, how);
		assert.equal(canvas.navMode.textContent, "Navigating", `${how}: focus mode entered for the comparison ends with it`);
		assert.deepEqual(compareFrames(canvas), [], how);
		assert.ok(older && current);
		assert.equal(cardOf(canvas, 3).classes.has("gd-version-comparing"), false);
		assert.equal(canvas.document.activeElement, cardButton(canvas, "gd-version-compare", 3), `${how}: focus returns to the button that opened it`);
	}
	const canvas = await withHistory();
	navItems(canvas)[0].dispatch("click");
	openHistory(canvas);
	cardButton(canvas, "gd-version-compare", 2).dispatch("click");
	canvas.document.getElementById("gd-versions-close").dispatch("click");
	assert.match(canvas.navMode.textContent, /^Using: First/, "the artboard was already in focus mode: it stays");
	assert.equal(versionsPanel(canvas).hidden, true);
	// Plain Esc in Comment mode closes the comparison first and leaves Comment mode on.
	const commenting = await comparing(3);
	commenting.document.getElementById("gd-comment").dispatch("click");
	press(commenting, "Escape", {}, sliderHandle(commenting));
	assert.equal(versionsPanel(commenting).hidden, true);
	assert.equal(pressed(commenting, "gd-comment"), "true");
});

test("S3: Back to canvas, another artboard and a new design end the comparison", async () => {
	const back = await comparing(3);
	back.document.getElementById("gd-back").dispatch("click");
	assert.equal(versionsPanel(back).hidden, true);
	assert.equal(back.world.inert, false);
	const other = await comparing(3);
	navItems(other)[1].dispatch("click");
	assert.equal(versionsPanel(other).hidden, true);
	assert.match(other.navMode.textContent, /^Using: Second/);
	const design = await comparing(3);
	await design.serverEvent("show", { slug: "beta" });
	assert.equal(versionsPanel(design).hidden, true);
	assert.deepEqual(compareFrames(design), []);
});

test("S3: the comparison follows the history and the artboard: new current version, reload on change, version dropped closes it", async () => {
	const canvas = await comparing(3);
	canvas.replies[HISTORY_URL] = historyDoc({ "01-a.html": [...FIRST_VERSIONS, version(5, "agent", 9, 5)], "02-b.html": [version(1, "hand", 9, 10)] });
	await canvas.serverEvent("history", { slug: "alpha", file: "01-a.html", n: 5 });
	assert.deepEqual(compareLabels(canvas), [`v3 · ${shownTime(9, 3)}`, "v5 · Current"]);
	assert.match(sliderHandle(canvas).getAttribute("aria-valuetext")!, /v5 \(current\)/);
	const [older, current] = compareFrames(canvas);
	await canvas.serverEvent("change", { slug: "alpha", file: "01-a.html" });
	assert.match(current.src, /^\/t\/files\/alpha\/01-a\.html\?v=\d+$/, "the current artboard reloads");
	assert.equal(older.src, "/t/history/alpha/3/01-a.html", "a stored version never changes");
	assert.equal(versionsPanel(canvas).hidden, false);
	canvas.replies[HISTORY_URL] = historyDoc({ "01-a.html": [version(4, "hand", 9, 4), version(5, "agent", 9, 5)], "02-b.html": [version(1, "hand", 9, 10)] });
	await canvas.serverEvent("history", { slug: "alpha", file: "01-a.html", n: 6 });
	assert.equal(versionsPanel(canvas).hidden, true, "v3 is no longer kept");
	assert.equal(canvas.document.getElementById("gd-toast").textContent, "v3 is no longer kept, so the comparison was closed.");
});

test("S3: frames of a comparison are never trusted: they cannot pick, end focus mode, report checks or pins, and get no messages", async () => {
	const canvas = await comparing(3);
	const frames = compareFrames(canvas);
	canvas.document.getElementById("gd-comment").dispatch("click");
	const popover = canvas.document.getElementById("gd-popover");
	for (const frame of frames) {
		canvas.message(frame.contentWindow, { type: "gd:pick", selector: "#cta", excerpt: "", rect: { x: 0, y: 0, width: 1, height: 1 } });
		canvas.message(frame.contentWindow, { type: "gd:exit-focus" });
		canvas.message(frame.contentWindow, checksReport([finding()]));
		canvas.message(frame.contentWindow, { type: "gd:pin-rects", rects: [{ id: "a1", rect: { x: 1, y: 1, width: 1, height: 1 } }] });
		canvas.message(frame.contentWindow, { type: "gd:inspect", element: MEASURE });
		canvas.message(frame.contentWindow, { type: "gd:wheel", deltaX: 0, deltaY: 40, deltaMode: 0, zoom: false, shift: false, x: 1, y: 1 });
	}
	assert.equal(popover.hidden, true);
	assert.match(canvas.navMode.textContent, /^Using:/, "focus mode stays");
	assert.equal(canvas.document.getElementById("gd-count-checks").textContent, "0");
	assert.equal(canvas.document.getElementById("gd-inspector").hidden, true);
	assert.equal(withClass(canvas.boards[0].wrapper, "gd-pin").length, 0);
	await setComments(canvas, comment("a1", "01-a.html"));
	canvas.document.getElementById("gd-tool-navigate").dispatch("click");
	for (const frame of frames) assert.deepEqual(frame.contentWindow!.posted, [], "no mode, focus or pins are sent to them");
	assert.ok(read("canvas.js").includes("history/"), "the version URL is built by the canvas");
});

test("S3: View on the current version brings the artboard into focus and closes a comparison", async () => {
	const canvas = await withHistory();
	openHistory(canvas);
	cardButton(canvas, "gd-version-view", 4).dispatch("click");
	assert.equal(canvas.navMode.textContent, "Using: First · Shift+Esc to exit");
	cardButton(canvas, "gd-version-compare", 3).dispatch("click");
	assert.equal(versionsPanel(canvas).hidden, false);
	cardButton(canvas, "gd-version-view", 4).dispatch("click");
	assert.equal(versionsPanel(canvas).hidden, true);
	assert.match(canvas.navMode.textContent, /^Using: First/);
});

// ---- Restore

async function restoring(restoreReply: Record<string, unknown> = { ok: true, slug: "alpha", file: "01-a.html", restoredFrom: 2, saved: 5, version: 6 }) {
	const canvas = await withHistory(HISTORY, { [RESTORE_URL]: restoreReply });
	openHistory(canvas);
	return canvas;
}
const confirmOf = (canvas: Canvas, n: number) => withClass(cardOf(canvas, n), "gd-version-confirm")[0];

test("S4: Restore asks first: the question, Restore and Cancel; nothing is sent until it is confirmed", async () => {
	const canvas = await restoring();
	assert.equal(confirmOf(canvas, 2), undefined);
	cardButton(canvas, "gd-version-restore", 2).dispatch("click");
	const confirm = confirmOf(canvas, 2);
	assert.equal(confirm.getAttribute("role"), "group");
	assert.equal(confirm.getAttribute("aria-label"), "Confirm restoring v2");
	assert.equal(texts(confirm, "gd-version-confirm-text")[0], "Restore v2? The current version is saved first, so nothing is lost.");
	assert.equal(withClass(cardOf(canvas, 2), "gd-version-actions")[0].hidden, true, "the buttons make room for the question");
	assert.equal(canvas.document.activeElement, withClass(confirm, "gd-version-confirm-restore")[0], "the keyboard moves to the question");
	assert.equal(allText(withClass(confirm, "gd-version-confirm-restore")[0]), "Restore");
	assert.equal(allText(withClass(confirm, "gd-version-confirm-cancel")[0]), "Cancel");
	assert.deepEqual(canvas.posts, []);
	// Cancel, and Esc, close it and return to the Restore button.
	withClass(confirm, "gd-version-confirm-cancel")[0].dispatch("click");
	assert.equal(confirmOf(canvas, 2), undefined);
	assert.equal(canvas.document.activeElement, cardButton(canvas, "gd-version-restore", 2));
	cardButton(canvas, "gd-version-restore", 2).dispatch("click");
	const escape = confirmOf(canvas, 2).dispatch("keydown", { key: "Escape" });
	assert.equal(escape.defaultPrevented, true);
	assert.equal(confirmOf(canvas, 2), undefined);
	assert.deepEqual(canvas.posts, [], "cancelled: nothing was sent");
	// Asking about another version moves the question.
	cardButton(canvas, "gd-version-restore", 2).dispatch("click");
	cardButton(canvas, "gd-version-restore", 3).dispatch("click");
	assert.equal(confirmOf(canvas, 2), undefined);
	assert.equal(texts(confirmOf(canvas, 3), "gd-version-confirm-text")[0], "Restore v3? The current version is saved first, so nothing is lost.");
});

test("S4: confirming posts the file and version, toasts the new version, reloads the artboard and refreshes the list", async () => {
	const canvas = await restoring();
	const [first] = canvas.boards;
	const before = first.frame.src;
	canvas.replies[HISTORY_URL] = historyDoc({ "01-a.html": [...FIRST_VERSIONS, version(5, "hand", 9, 5), version(6, "restore", 9, 6)], "02-b.html": [version(1, "hand", 9, 10)] });
	cardButton(canvas, "gd-version-restore", 2).dispatch("click");
	withClass(confirmOf(canvas, 2), "gd-version-confirm-restore")[0].dispatch("click");
	await flush();
	await flush();
	assert.deepEqual(canvas.posts.filter((post) => post.url === RESTORE_URL).map((post) => post.body), [{ file: "01-a.html", n: 2 }]);
	assert.equal(canvas.document.getElementById("gd-toast").textContent, "Restored v2 as v6");
	assert.equal(canvas.document.getElementById("gd-toast").classes.has("gd-error"), false);
	assert.notEqual(first.frame.src, before, "the artboard reloads");
	assert.match(first.frame.src, /^\/t\/files\/alpha\/01-a\.html\?v=\d+$/);
	assert.equal(historyCount(canvas), "6", "the list is refreshed");
	assert.deepEqual(versionCards(canvas).map((card) => card.dataset.n), ["6", "5", "4", "3", "2", "1"]);
	assert.equal(confirmOf(canvas, 2), undefined);
	assert.equal(historyAlert(canvas).hidden, true);
});

test("S4: restoring what the artboard already holds says so", async () => {
	const canvas = await restoring({ ok: true, slug: "alpha", file: "01-a.html", restoredFrom: 3 });
	cardButton(canvas, "gd-version-restore", 3).dispatch("click");
	withClass(confirmOf(canvas, 3), "gd-version-confirm-restore")[0].dispatch("click");
	await flush();
	assert.equal(canvas.document.getElementById("gd-toast").textContent, "v3 already has the current content, so nothing changed.");
});

test("S4: a refused restore is an alert inside the tab with the S12 sentence and the raw code, not a toast", async () => {
	const cases: Array<[Record<string, unknown>, RegExp, string]> = [
		[{ __http: 422, error: "invalid-history", reason: "01-a.html is a link or inside a linked folder, so its versions are not stored and it cannot be restored." }, /version history of this design cannot be used[^]*nothing was changed/, "invalid-history: 01-a.html is a link or inside a linked folder, so its versions are not stored and it cannot be restored."],
		[{ __http: 409, error: "history-limit", reason: "index too big" }, /history index is full[^]*Delete old versions from \.history/, "history-limit: index too big"],
		[{ __http: 413, error: "file-too-large", reason: "01-a.html is larger than 8388608 bytes" }, /too large to save a copy before restoring[^]*8 MB/, "file-too-large: 01-a.html is larger than 8388608 bytes"],
		[{ __http: 404, error: "not-found" }, /version is no longer kept/, "not-found"],
		[{ __throw: "down" }, /could not reach its server/, "network: down"],
	];
	for (const [reply, sentence, detail] of cases) {
		const canvas = await restoring(reply);
		const index = canvas.document.getElementById("gd-toast").textContent;
		cardButton(canvas, "gd-version-restore", 2).dispatch("click");
		withClass(confirmOf(canvas, 2), "gd-version-confirm-restore")[0].dispatch("click");
		await flush();
		await flush();
		assert.equal(historyAlert(canvas).hidden, false, detail);
		assert.match(texts(historyAlert(canvas), "gd-alert-text")[0], sentence, detail);
		assert.doesNotMatch(texts(historyAlert(canvas), "gd-alert-text")[0], /Something went wrong/);
		assert.equal(texts(historyAlert(canvas), "gd-alert-detail")[0], detail);
		assert.equal(canvas.document.getElementById("gd-toast").textContent, index, "no toast");
		assert.equal(confirmOf(canvas, 2), undefined, "the question closes");
		assert.equal(canvas.document.activeElement, cardButton(canvas, "gd-version-restore", 2), "focus returns to Restore");
		assert.equal(canvas.boards[0].frame.src, "/t/files/alpha/01-a.html", "the artboard is not reloaded");
		assert.equal(historyCount(canvas), "4");
		// The alert is dismissible and the next attempt clears it.
		withClass(historyAlert(canvas), "gd-alert-dismiss")[0].dispatch("click");
		assert.equal(historyAlert(canvas).hidden, true);
	}
	const again = await restoring({ __http: 422, error: "invalid-history" });
	cardButton(again, "gd-version-restore", 2).dispatch("click");
	withClass(confirmOf(again, 2), "gd-version-confirm-restore")[0].dispatch("click");
	await flush();
	assert.equal(historyAlert(again).hidden, false);
	again.replies[RESTORE_URL] = { ok: true, version: 5 };
	cardButton(again, "gd-version-restore", 2).dispatch("click");
	assert.equal(historyAlert(again).hidden, true, "asking again clears the old alert");
});

test("S4: the restore question survives a refresh of the list while it is open", async () => {
	const canvas = await restoring();
	cardButton(canvas, "gd-version-restore", 2).dispatch("click");
	await canvas.serverEvent("history", { slug: "alpha", file: "01-a.html", n: 4 });
	assert.notEqual(confirmOf(canvas, 2), undefined);
	assert.equal(canvas.document.activeElement, withClass(confirmOf(canvas, 2), "gd-version-confirm-restore")[0], "and so does the keyboard focus");
});

test("S2-S4: the History tab and the comparison are in index.html and canvas.css with tokens only, focus rings and no inline script or style", () => {
	const html = read("index.html");
	assert.match(html, /<button type="button" role="tab" id="gd-tab-history" class="gd-tab" aria-selected="false" aria-controls="gd-tabpanel" tabindex="-1"><span data-i18n="tab.history">History<\/span> <span id="gd-count-history" class="gd-count">0<\/span><\/button>/);
	assert.ok(html.indexOf('id="gd-tab-comments"') < html.indexOf('id="gd-tab-history"') && html.indexOf('id="gd-tab-history"') < html.indexOf('id="gd-tab-checks"'));
	assert.match(html, /<div id="gd-history" class="gd-history" hidden><\/div>/);
	assert.match(html, /<section id="gd-versions" class="gd-versions" aria-labelledby="gd-versions-title" hidden>/);
	assert.match(html, /<div class="gd-devices gd-versions-mode" role="group" aria-label="Comparison mode" data-i18n-aria-label="versions.group">/);
	assert.match(html, /id="gd-versions-mode-slider"[^>]*aria-pressed="true"[^>]*>Slider</);
	assert.match(html, /id="gd-versions-mode-side"[^>]*aria-pressed="false"[^>]*>Side by side</);
	assert.match(html, /id="gd-versions-close"[^>]*>[^]*?Close comparison</);
	assert.ok(html.indexOf('id="gd-versions"') < html.indexOf('id="gd-back"'), "the Back to canvas button stays above the comparison");
	for (const id of ["i-eye", "i-restore"]) assert.match(html, new RegExp(`<symbol id="${id}"`));
	const css = read("canvas.css");
	for (const selector of [".gd-version", ".gd-version-current", ".gd-version-comparing", ".gd-version-reply", ".gd-history-warning", ".gd-versions", ".gd-versions-bar", ".gd-versions-compare", ".gd-versions-pane", ".gd-versions-box", ".gd-versions-handle", ".gd-versions-knob", ".gd-versions-shield", ".gd-versions-label"]) assert.ok(css.includes(`${selector} {`) || css.includes(`${selector},`) || css.includes(`${selector}[`), `${selector} is styled`);
	assert.match(css, /\.gd-versions\s*{[^}]*position:\s*absolute[^}]*inset:\s*0[^}]*z-index:\s*4/);
	assert.match(css, /\.gd-versions-handle:focus-visible/);
	assert.match(css, /\.gd-version-current::before\s*{[^}]*var\(--accent\)/);
	assert.match(css, /\.gd-version-reply\s*{[^}]*border-left:[^}]*var\(--success\)/);
});

test("S2: five tabs never squeeze their labels into each other and stay on one row: the tab row scrolls", () => {
	const css = read("canvas.css");
	assert.match(css, /\.gd-tabs\s*{[^}]*overflow-x:\s*auto/);
	assert.ok(!/\.gd-tabs\s*{[^}]*flex-wrap:\s*wrap/.test(css), "never stacked on two rows");
	assert.match(css, /\.gd-tab\s*{[^}]*flex:\s*none/);
});

test("Tabs: arrows show only on an edge with tabs behind it, and each scrolls the row toward its side", async () => {
	const canvas = await loadCanvas();
	const tabs = canvas.document.getElementById("gd-tabs");
	const prev = canvas.document.getElementById("gd-tabs-prev");
	const next = canvas.document.getElementById("gd-tabs-next");
	const shown = () => [prev.hidden ? "" : "prev", next.hidden ? "" : "next"].filter(Boolean).join(" ");
	Object.assign(tabs, { scrollWidth: 359, clientWidth: 359, scrollLeft: 0 });
	tabs.dispatch("scroll");
	assert.equal(shown(), "", "a row that fits has no arrows");
	Object.assign(tabs, { scrollWidth: 503, clientWidth: 359, scrollLeft: 0 });
	tabs.dispatch("scroll");
	assert.equal(shown(), "next", "at the start only the right arrow");
	next.dispatch("click");
	assert.ok(tabs.scrollLeft > 0, "the right arrow scrolls toward the end");
	tabs.scrollLeft = 144;
	tabs.dispatch("scroll");
	assert.equal(shown(), "prev", "at the end only the left arrow");
	prev.dispatch("click");
	assert.ok(tabs.scrollLeft < 144, "the left arrow scrolls toward the start");
	tabs.scrollLeft = 60;
	tabs.dispatch("scroll");
	assert.equal(shown(), "prev next", "in the middle both arrows");
});

test("Tabs: the arrows are outside the tablist, pointer helpers named from the catalog, and the keyboard path stays the tabs", () => {
	const html = read("index.html");
	const tablist = html.slice(html.indexOf('<div id="gd-tabs"'), html.indexOf("</div>", html.indexOf('<div id="gd-tabs"')));
	assert.ok(!tablist.includes("gd-tabs-prev") && !tablist.includes("gd-tabs-next"), "only tabs inside the tablist");
	for (const [id, key] of [["gd-tabs-prev", "tabs.prev"], ["gd-tabs-next", "tabs.next"]]) {
		const tag = html.match(new RegExp(`<button[^>]*id="${id}"[^>]*>`))?.[0] ?? "";
		assert.match(tag, /tabindex="-1"/, `${id} is not a tab stop`);
		assert.match(tag, /aria-hidden="true"/, `${id} is hidden from assistive technology, which moves with the arrow keys`);
		assert.ok(tag.includes(`data-i18n-title="${key}"`), `${id} title from the catalog`);
		assert.match(tag, / hidden[ >]/, `${id} starts hidden`);
	}
});

test("L10 (A2): the tab row hides its scrollbar and fades only the edges that have more tabs behind them", async () => {
	const css = read("canvas.css");
	assert.match(css, /\.gd-tabs\s*{[^}]*scrollbar-width:\s*none/);
	assert.match(css, /\.gd-tabs::-webkit-scrollbar\s*{[^}]*display:\s*none/);
	for (const name of ["gd-tabs-more-start", "gd-tabs-more-end"]) {
		const block = css.match(new RegExp(`\\.${name}[^{]*{[^}]*}`))?.[0] ?? "";
		assert.match(block, /mask-image:\s*linear-gradient/, `${name} fades its edge`);
		assert.ok(!/#[0-9a-fA-F]{3,8}\b|rgba?\(/.test(block), `${name}: tokens only`);
	}
	const canvas = await loadCanvas();
	const tabs = canvas.document.getElementById("gd-tabs");
	const fades = () => ["gd-tabs-more-start", "gd-tabs-more-end"].filter((name) => tabs.classes.has(name)).join(" ");
	Object.assign(tabs, { scrollWidth: 503, clientWidth: 359, scrollLeft: 0 });
	tabs.dispatch("scroll");
	assert.equal(fades(), "gd-tabs-more-end", "at the start only the right edge fades");
	tabs.scrollLeft = 60;
	tabs.dispatch("scroll");
	assert.equal(fades(), "gd-tabs-more-start gd-tabs-more-end", "in the middle both edges fade");
	tabs.scrollLeft = 144;
	tabs.dispatch("scroll");
	assert.equal(fades(), "gd-tabs-more-start", "at the end only the left edge fades");
	// Counts change the row's width: choosing a tab re-renders and re-checks, without a scroll event.
	Object.assign(tabs, { scrollWidth: 359, scrollLeft: 0 });
	canvas.document.getElementById("gd-filter-resolved").dispatch("click");
	assert.equal(fades(), "", "a row that fits has no fade");
});

test("L10 (A2): the fade is right from the first layout: the tab row is watched for size changes", async () => {
	const observed: Array<{ target: any; callback: () => void }> = [];
	class FakeResizeObserver {
		callback: () => void;
		constructor(callback: () => void) { this.callback = callback; }
		observe(target: any) { observed.push({ target, callback: this.callback }); }
	}
	const canvas = await loadCanvas(300, {}, {}, { ResizeObserver: FakeResizeObserver });
	const tabs = canvas.document.getElementById("gd-tabs");
	const watch = observed.find((entry) => entry.target === tabs);
	assert.ok(watch, "the tab row is observed");
	// A browser calls the observer once when it starts observing, and again whenever fonts or the panel change the size.
	Object.assign(tabs, { scrollWidth: 503, clientWidth: 359, scrollLeft: 0 });
	watch!.callback();
	assert.equal(tabs.classes.has("gd-tabs-more-end"), true);
	assert.equal(tabs.classes.has("gd-tabs-more-start"), false);
});

test("L10 (A2): moving between tabs with the keyboard scrolls the chosen tab into view", async () => {
	const canvas = await loadCanvas();
	const doc = canvas.document;
	const scrolled: Array<[string, unknown]> = [];
	for (const id of ["gd-tab-comments", "gd-tab-history", "gd-tab-checks", "gd-tab-brief"]) {
		// The options object comes from the canvas's own realm: compare its content.
		doc.getElementById(id).scrollIntoView = (options: unknown) => scrolled.push([id, JSON.parse(JSON.stringify(options))]);
	}
	doc.getElementById("gd-tabs").dispatch("keydown", { key: "End" });
	assert.deepEqual(scrolled, [["gd-tab-brief", { block: "nearest", inline: "nearest" }]]);
});

// ---- Compare modes (canvas-compare-overlay T1): Side by side, Overlay and Slider over the artboard and the running app

const PREVIEW = "http://localhost:5173/login";
const CMP_REPLIES = { "/t/api/designs/alpha/handoffs": handoffDoc("01-a.html", { "01-a.html": { status: "implemented", previewUrl: PREVIEW } }) };
const cmpEl = (canvas: Canvas, id: string) => canvas.document.getElementById(`gd-compare-${id}`);
const cmpPanes = (canvas: Canvas) => cmpEl(canvas, "panes");
const cmpFrames = (canvas: Canvas) => findAll(cmpPanes(canvas), (element) => element.localName === "iframe");
const cmpFigures = (canvas: Canvas) => withClass(cmpPanes(canvas), "gd-compare-pane");
const cmpHandle = (canvas: Canvas) => withClass(cmpPanes(canvas), "gd-versions-handle")[0];
const cmpShield = (canvas: Canvas) => withClass(cmpPanes(canvas), "gd-versions-shield")[0];
const cmpMode = (canvas: Canvas, mode: "side" | "overlay" | "slider") => cmpEl(canvas, `mode-${mode}`);
const cmpPressed = (canvas: Canvas) => (["side", "overlay", "slider"] as const).filter((mode) => cmpMode(canvas, mode).getAttribute("aria-pressed") === "true");
const openCompareView = (canvas: Canvas) => withClass(boardsOf(canvas)[0], "gd-compare-start")[0].dispatch("click");
async function compareView(stageWidth = 2000) {
	const canvas = await loadCanvas(300, CMP_REPLIES);
	cmpEl(canvas, "stage").rect = { left: 0, top: 0, width: stageWidth, height: 600 };
	openCompareView(canvas);
	return canvas;
}

test("T1/S1: Compare opens in Side by side with a segmented mode control, and Overlay and Slider switch without reloading the frames", async () => {
	const canvas = await compareView();
	assert.deepEqual(cmpPressed(canvas), ["side"], "Side by side is the default");
	assert.equal(cmpPanes(canvas).dataset.mode, "side");
	const frames = cmpFrames(canvas);
	const srcs = frames.map((frame) => frame.src);
	assert.equal(cmpHandle(canvas).hidden, true, "no handle in side by side");
	assert.equal(cmpShield(canvas).hidden, true);
	assert.equal(cmpEl(canvas, "opacity-field").hidden, true, "the opacity belongs to Overlay");
	cmpMode(canvas, "overlay").dispatch("click");
	assert.deepEqual(cmpPressed(canvas), ["overlay"]);
	assert.equal(cmpPanes(canvas).dataset.mode, "overlay");
	assert.equal(cmpEl(canvas, "opacity-field").hidden, false);
	assert.equal(cmpHandle(canvas).hidden, true);
	assert.equal(cmpShield(canvas).hidden, true);
	cmpMode(canvas, "slider").dispatch("click");
	assert.deepEqual(cmpPressed(canvas), ["slider"]);
	assert.equal(cmpPanes(canvas).dataset.mode, "slider");
	assert.equal(cmpEl(canvas, "opacity-field").hidden, true);
	assert.equal(cmpHandle(canvas).hidden, false);
	assert.equal(cmpShield(canvas).hidden, false);
	cmpMode(canvas, "side").dispatch("click");
	assert.deepEqual(cmpPressed(canvas), ["side"]);
	assert.equal(cmpPanes(canvas).dataset.mode, "side");
	const after = cmpFrames(canvas);
	assert.equal(after.length, 2);
	after.forEach((frame, i) => assert.ok(frame === frames[i], "the same frames: nothing reloads"));
	assert.deepEqual(after.map((frame) => frame.src), srcs);
});

test("T1/S1: the last mode is remembered while the canvas runs", async () => {
	const canvas = await compareView();
	cmpMode(canvas, "slider").dispatch("click");
	cmpEl(canvas, "back").dispatch("click");
	openCompareView(canvas);
	assert.deepEqual(cmpPressed(canvas), ["slider"], "reopening keeps the last mode");
	assert.equal(cmpPanes(canvas).dataset.mode, "slider");
	assert.equal(cmpHandle(canvas).hidden, false);
	cmpMode(canvas, "overlay").dispatch("click");
	cmpEl(canvas, "back").dispatch("click");
	openCompareView(canvas);
	assert.deepEqual(cmpPressed(canvas), ["overlay"]);
	assert.equal(cmpEl(canvas, "opacity-field").hidden, false);
	cmpMode(canvas, "side").dispatch("click");
	cmpEl(canvas, "back").dispatch("click");
	openCompareView(canvas);
	assert.deepEqual(cmpPressed(canvas), ["side"]);
	const fresh = await compareView();
	assert.deepEqual(cmpPressed(fresh), ["side"], "a new canvas starts in Side by side");
});

test("T1/S1: side by side keeps today's captions; the stacked modes label the sides Design and App", async () => {
	const canvas = await compareView();
	const captions = () => texts(cmpPanes(canvas), "gd-compare-caption");
	assert.deepEqual(captions(), ["Design: 01-a.html", `Implementation: ${PREVIEW}`]);
	cmpMode(canvas, "slider").dispatch("click");
	assert.deepEqual(captions(), ["Design", "App"]);
	cmpMode(canvas, "overlay").dispatch("click");
	assert.deepEqual(captions(), ["Design", "App"]);
	cmpMode(canvas, "side").dispatch("click");
	assert.deepEqual(captions(), ["Design: 01-a.html", `Implementation: ${PREVIEW}`]);
});

test("T1/S2: Overlay starts at 50% App opacity and follows the input, clamped to 0-100%", async () => {
	const canvas = await compareView();
	cmpMode(canvas, "overlay").dispatch("click");
	const input = cmpEl(canvas, "opacity");
	const output = cmpEl(canvas, "opacity-value");
	const [design, app] = cmpFrames(canvas);
	assert.equal(input.value, "50");
	assert.equal(output.textContent, "50%");
	assert.equal(input.getAttribute("aria-valuetext"), "50%");
	assert.equal(app.style.opacity, "0.5");
	assert.equal(design.style.opacity ?? "", "", "the design stays opaque");
	const set = (value: string) => { input.value = value; input.dispatch("input"); };
	set("30");
	assert.deepEqual([app.style.opacity, output.textContent, input.getAttribute("aria-valuetext")], ["0.3", "30%", "30%"]);
	set("0");
	assert.deepEqual([app.style.opacity, output.textContent], ["0", "0%"]);
	set("100");
	assert.deepEqual([app.style.opacity, output.textContent], ["1", "100%"]);
	set("250");
	assert.deepEqual([app.style.opacity, output.textContent, input.value], ["1", "100%", "100"], "clamped to 100");
	set("-4");
	assert.deepEqual([app.style.opacity, output.textContent, input.value], ["0", "0%", "0"], "clamped to 0");
	set("42");
	set("not a number");
	assert.deepEqual([app.style.opacity, output.textContent, input.value], ["0.42", "42%", "42"], "garbage leaves the opacity alone");
	cmpMode(canvas, "slider").dispatch("click");
	assert.equal(app.style.opacity, "", "the app is opaque outside Overlay");
	cmpMode(canvas, "side").dispatch("click");
	assert.equal(app.style.opacity, "");
	cmpMode(canvas, "overlay").dispatch("click");
	assert.equal(app.style.opacity, "0.42", "Overlay returns to the opacity it had");
});

test("T1/S2: a new Compare starts at 50% App opacity again, and the input is a range from 0 to 100", async () => {
	const canvas = await compareView();
	cmpMode(canvas, "overlay").dispatch("click");
	const input = cmpEl(canvas, "opacity");
	input.value = "10";
	input.dispatch("input");
	cmpEl(canvas, "back").dispatch("click");
	openCompareView(canvas);
	assert.equal(input.value, "50");
	assert.equal(cmpEl(canvas, "opacity-value").textContent, "50%");
	assert.equal(cmpFrames(canvas)[1].style.opacity, "0.5");
	assert.match(read("index.html"), /<input type="range" id="gd-compare-opacity" min="0" max="100" step="1" value="50"/);
});

test("T1/S2-S3: the stacked modes size the pair as one artboard, and Scale to fit shrinks the stack", async () => {
	const canvas = await compareView(600);
	const panes = cmpPanes(canvas);
	const fit = cmpEl(canvas, "fit");
	const field = cmpEl(canvas, "fit-field");
	assert.equal(field.hidden, false, "two 400 px boards do not fit in 552 px");
	assert.deepEqual([panes.style.width ?? "", panes.style.height ?? ""], ["", ""], "side by side lets the panes set the size");
	for (const mode of ["overlay", "slider"] as const) {
		cmpMode(canvas, mode).dispatch("click");
		assert.deepEqual([panes.style.width, panes.style.height], ["400px", "300px"], `${mode}: one board's size`);
		assert.equal(field.hidden, true, `${mode}: a 400 px stack fits in 552 px`);
		assert.equal(panes.style.transform, "none");
	}
	cmpEl(canvas, "stage").rect = { left: 0, top: 0, width: 300, height: 600 };
	canvas.windowEvent("resize");
	assert.equal(field.hidden, false, "a 300 px window cannot show 400 px");
	assert.equal(panes.style.transform, "none", "still 100% until Scale to fit is on");
	fit.checked = true;
	fit.dispatch("change");
	// 300 - 2 * 24 = 252 px for a 400 px stack.
	assert.equal(panes.style.transform, "scale(0.630)");
	assert.equal(cmpEl(canvas, "sizer").style.width, `${Math.ceil(400 * (252 / 400))}px`);
	assert.equal(cmpEl(canvas, "sizer").style.height, `${Math.ceil(300 * (252 / 400))}px`);
	cmpMode(canvas, "overlay").dispatch("click");
	assert.equal(panes.style.transform, "scale(0.630)", "the same stack in Overlay");
	cmpMode(canvas, "side").dispatch("click");
	assert.equal(panes.style.transform, `scale(${(252 / 824).toFixed(3)})`, "the pair side by side needs 824 px");
	assert.notEqual(cmpEl(canvas, "sizer").style.height, `${Math.ceil(300 * (252 / 824))}px`, "side by side measures the panes, not the artboard");
});

test("T1/S3: the Slider handle is a named slider with a value, starting in the middle, revealing Design on the left and App on the right", async () => {
	const canvas = await compareView();
	cmpMode(canvas, "slider").dispatch("click");
	const handle = cmpHandle(canvas);
	assert.equal(handle.getAttribute("role"), "slider");
	assert.equal(handle.getAttribute("tabindex"), "0");
	assert.equal(handle.getAttribute("aria-label"), "Comparison position");
	assert.equal(handle.getAttribute("aria-orientation"), "horizontal");
	assert.deepEqual([handle.getAttribute("aria-valuemin"), handle.getAttribute("aria-valuemax"), handle.getAttribute("aria-valuenow")], ["0", "100", "50"]);
	assert.equal(handle.getAttribute("aria-valuetext"), "50%: Design on the left, App on the right");
	assert.equal(handle.style.left, "50%");
	const [design, app] = cmpFigures(canvas);
	assert.equal(app.style.clipPath, "inset(0 0 0 50%)", "the app shows right of the line");
	assert.equal(design.style.clipPath ?? "", "", "the design is whole underneath");
	assert.equal(cmpPanes(canvas).getAttribute("role"), "group");
	assert.equal(cmpPanes(canvas).getAttribute("aria-label"), "Design and running app, split at 50%");
	cmpMode(canvas, "overlay").dispatch("click");
	assert.equal(app.style.clipPath, "", "Overlay does not clip");
	cmpMode(canvas, "side").dispatch("click");
	assert.equal(app.style.clipPath, "");
	assert.equal(cmpPanes(canvas).hasAttribute("role"), false, "side by side is not a group");
	assert.equal(cmpPanes(canvas).hasAttribute("aria-label"), false);
});

test("T1/S3: dragging the shield moves the Slider with the pointer, clamped to the frame, and puts the keyboard on the handle", async () => {
	const canvas = await compareView();
	cmpMode(canvas, "slider").dispatch("click");
	const handle = cmpHandle(canvas);
	const shield = cmpShield(canvas);
	const [, app] = cmpFigures(canvas);
	cmpPanes(canvas).rect = { left: 100, top: 150, width: 400, height: 300 };
	shield.dispatch("pointerdown", { button: 0, pointerId: 1, clientX: 200 });
	assert.equal(handle.getAttribute("aria-valuenow"), "25");
	assert.equal(handle.getAttribute("aria-valuetext"), "25%: Design on the left, App on the right");
	assert.equal(app.style.clipPath, "inset(0 0 0 25%)");
	assert.equal(handle.style.left, "25%");
	shield.dispatch("pointermove", { pointerId: 1, clientX: 450 });
	assert.equal(handle.getAttribute("aria-valuenow"), "87.5");
	shield.dispatch("pointermove", { pointerId: 2, clientX: 120 });
	assert.equal(handle.getAttribute("aria-valuenow"), "87.5", "another pointer is not this drag");
	shield.dispatch("pointerup", { button: 0, pointerId: 1, clientX: 450 });
	shield.dispatch("pointermove", { pointerId: 1, clientX: 120 });
	assert.equal(handle.getAttribute("aria-valuenow"), "87.5", "moves after the drag are ignored");
	shield.dispatch("pointerdown", { button: 0, pointerId: 3, clientX: 900 });
	assert.equal(handle.getAttribute("aria-valuenow"), "100");
	shield.dispatch("pointermove", { pointerId: 3, clientX: -50 });
	assert.equal(handle.getAttribute("aria-valuenow"), "0");
	shield.dispatch("pointerdown", { button: 2, pointerId: 4, clientX: 300 });
	assert.equal(handle.getAttribute("aria-valuenow"), "0", "only the main button drags");
	assert.ok(canvas.document.activeElement === handle, "dragging puts the keyboard on the slider");
});

test("T1/S3: arrow keys move the Slider 2%, Shift+arrows 10%, Home and End jump, and it stops at the ends", async () => {
	const canvas = await compareView();
	cmpMode(canvas, "slider").dispatch("click");
	const handle = cmpHandle(canvas);
	const [, app] = cmpFigures(canvas);
	const value = () => handle.getAttribute("aria-valuenow");
	const key = (name: string, shiftKey = false) => handle.dispatch("keydown", { key: name, shiftKey });
	key("ArrowRight");
	assert.equal(value(), "52");
	assert.equal(app.style.clipPath, "inset(0 0 0 52%)");
	key("ArrowRight", true);
	assert.equal(value(), "62");
	key("ArrowLeft");
	assert.equal(value(), "60");
	key("ArrowLeft", true);
	assert.equal(value(), "50");
	key("ArrowUp");
	assert.equal(value(), "52");
	key("ArrowDown", true);
	assert.equal(value(), "42");
	key("End");
	assert.equal(value(), "100");
	key("ArrowRight", true);
	assert.equal(value(), "100");
	key("Home");
	assert.equal(value(), "0");
	key("ArrowLeft");
	assert.equal(value(), "0");
	key("ArrowRight");
	assert.equal(handle.getAttribute("aria-valuetext"), "2%: Design on the left, App on the right");
	const other = key("a");
	assert.equal(other.defaultPrevented, false, "other keys are left alone");
	assert.equal(key("ArrowRight").defaultPrevented, true);
	assert.equal(value(), "4");
	cmpMode(canvas, "overlay").dispatch("click");
	cmpMode(canvas, "slider").dispatch("click");
	assert.equal(value(), "4", "the position survives a mode change");
});

test("T1/S4: both frames keep their sandbox, referrer policy and source in every mode", async () => {
	const canvas = await compareView();
	const [design, app] = cmpFrames(canvas);
	for (const mode of ["overlay", "slider", "side", "slider", "overlay"] as const) {
		cmpMode(canvas, mode).dispatch("click");
		assert.equal(cmpPanes(canvas).dataset.mode, mode, "the mode is on");
		assert.equal(cmpFrames(canvas).length, 2, mode);
		assert.ok(cmpFrames(canvas)[0] === design && cmpFrames(canvas)[1] === app, `${mode}: same frames`);
		assert.equal(design.getAttribute("sandbox"), "allow-scripts", mode);
		assert.equal(app.getAttribute("sandbox"), "allow-scripts allow-same-origin allow-forms allow-popups", mode);
		for (const frame of [design, app]) {
			assert.equal(frame.getAttribute("referrerpolicy"), "no-referrer", mode);
			assert.deepEqual([frame.style.width, frame.style.height], ["400px", "300px"], mode);
		}
		assert.equal(design.src, "/t/files/alpha/01-a.html", mode);
		assert.equal(app.src, PREVIEW, mode);
	}
	cmpEl(canvas, "back").dispatch("click");
	assert.deepEqual(cmpPanes(canvas).children, [], "leaving removes the frames, the handle and the shield");
});

test("T1/S4: the loopback hints and the Open in new tab link do not change with the mode", async () => {
	const canvas = await loadCanvas(300, { "/t/api/designs/alpha/handoffs": handoffDoc("01-a.html", { "01-a.html": { status: "implemented", previewUrl: "http://[::1]:3000/" } }) });
	openCompareView(canvas);
	const message = cmpEl(canvas, "message").textContent;
	assert.match(message, /\[::1\]/);
	for (const mode of ["overlay", "slider", "side"] as const) {
		cmpMode(canvas, mode).dispatch("click");
		assert.equal(cmpPanes(canvas).dataset.mode, mode, "the mode is on");
		assert.equal(cmpEl(canvas, "message").textContent, message, mode);
		assert.equal(cmpEl(canvas, "open").href, "http://[::1]:3000/", mode);
		assert.equal(cmpEl(canvas, "open").getAttribute("rel"), "noopener noreferrer", mode);
	}
});

test("T1/S4: the canvas never reads either Compare frame's pixels or document", () => {
	const js = read("canvas.js");
	const compare = js.slice(js.indexOf("// ---- compare ---"), js.indexOf("// ---- live reload ---"));
	assert.ok(!/contentDocument|getImageData|toDataURL|toBlob|drawImage|createImageBitmap|captureStream/.test(compare), "no pixel or DOM access to a frame");
});

test("T1/S1-S3: index.html has the mode control and the opacity field in the Compare bar, with no Difference mode", () => {
	const html = read("index.html");
	const bar = html.slice(html.indexOf('<section id="gd-compare"'), html.indexOf('<p id="gd-compare-message"'));
	assert.match(bar, /<div id="gd-compare-mode" class="gd-devices gd-compare-mode" role="group" aria-label="Compare mode" data-i18n-aria-label="compare.modeGroup">/);
	assert.match(bar, /<button type="button" id="gd-compare-mode-side" class="gd-size-button" aria-pressed="true" data-i18n="compare.side">Side by side<\/button>/);
	assert.match(bar, /<button type="button" id="gd-compare-mode-overlay" class="gd-size-button" aria-pressed="false" data-i18n="compare.overlay">Overlay<\/button>/);
	assert.match(bar, /<button type="button" id="gd-compare-mode-slider" class="gd-size-button" aria-pressed="false" data-i18n="compare.slider">Slider<\/button>/);
	assert.match(bar, /<label id="gd-compare-opacity-field" class="gd-compare-opacity" hidden><span data-i18n="compare.opacity">App opacity<\/span><input type="range" id="gd-compare-opacity" min="0" max="100" step="1" value="50" aria-valuetext="50%"><output id="gd-compare-opacity-value" for="gd-compare-opacity">50%<\/output><\/label>/);
	assert.ok(bar.indexOf("gd-compare-mode") < bar.indexOf("gd-compare-opacity-field") && bar.indexOf("gd-compare-opacity-field") < bar.indexOf("gd-compare-fit-field"));
	assert.ok(!/difference/i.test(bar), "no Difference mode (L2)");
	assert.ok(!/areas differ/i.test(html));
});

test("T1/S5: canvas.css styles the Compare modes with tokens only, a visible focus ring and no animation", () => {
	const css = read("canvas.css");
	const block = (selector: string) => {
		const start = css.indexOf(`${selector} {`);
		assert.ok(start >= 0, `${selector} is styled`);
		return css.slice(start, css.indexOf("}", start) + 1);
	};
	const selectors = [
		".gd-compare-panes[data-mode=\"overlay\"], .gd-compare-panes[data-mode=\"slider\"]",
		".gd-compare-panes[data-mode=\"overlay\"] .gd-compare-pane, .gd-compare-panes[data-mode=\"slider\"] .gd-compare-pane",
		".gd-compare-panes[data-mode=\"overlay\"] .gd-compare-caption, .gd-compare-panes[data-mode=\"slider\"] .gd-compare-caption",
		".gd-compare-opacity",
		".gd-compare-opacity input",
	];
	for (const selector of selectors) {
		const text = block(selector);
		assert.ok(!/#[0-9a-fA-F]{3,8}\b|rgba?\(/.test(text), `${selector}: tokens only`);
		assert.ok(!/transition|animation/.test(text), `${selector}: no motion`);
	}
	assert.match(block(selectors[0]), /position:\s*relative/);
	assert.match(block(selectors[1]), /position:\s*absolute[^}]*inset:\s*0/);
	assert.match(block(selectors[2]), /position:\s*absolute/);
	assert.match(css, /\.gd-compare-opacity input:focus-visible\s*{[^}]*outline:\s*2px solid var\(--accent\)/);
	assert.match(css, /\.gd-compare-mode\s*{/);
	assert.match(css, /\.gd-compare-opacity\[hidden\]\s*{[^}]*display:\s*none/);
});

test("T1/S5: docs/gentle-shell.md describes the Compare modes and says the canvas cannot detect differences", () => {
	const docs = readFileSync(join(ASSET_DIR, "..", "..", "docs", "gentle-shell.md"), "utf8");
	const line = docs.split("\n").find((candidate) => candidate.includes("**Compare** shows the artboard and the app"))!;
	assert.ok(line, "the Compare paragraph is there");
	for (const needle of ["**Side by side**", "**Overlay**", "**App opacity**", "**Slider**", "**Design**", "**App**", "`Shift`", "remembers"]) assert.ok(line.includes(needle), needle);
	assert.match(line, /cannot detect differences[^.]*each frame is its own origin/);
});

// ---- Minimap (canvas-minimap-variants-export T1/S1)

const SYSTEM_REPLY = { "/t/api/system": { exists: true, file: "system.html", width: 800, height: 600 } };
const miniPanel = (canvas: Canvas) => canvas.document.getElementById("gd-minimap");
const miniMap = (canvas: Canvas) => canvas.document.getElementById("gd-minimap-map");
const miniView = (canvas: Canvas) => canvas.document.getElementById("gd-minimap-view");
const miniBlocks = (canvas: Canvas) => withClass(miniMap(canvas), "gd-minimap-block");
const miniBox = (element: FakeElement) => ["left", "top", "width", "height"].map((key) => Number.parseFloat(element.style[key]));
const near = (actual: number[], expected: number[]) => {
	assert.equal(actual.length, expected.length);
	actual.forEach((value, index) => assert.ok(Math.abs(value - expected[index]) < 0.05, `${JSON.stringify(actual)} is not ${JSON.stringify(expected)}`));
};
/** The fake DOM has no layout: give each world child its box in world px (the real page reads offsets). */
function layoutWorld(canvas: Canvas, rects: number[][]) {
	canvas.world.children.forEach((wrapper, index) => {
		const [x, y, width, height] = rects[index];
		wrapper.offsetLeft = x;
		wrapper.offsetTop = y;
		Object.defineProperty(wrapper, "offsetWidth", { value: width, configurable: true });
		Object.defineProperty(wrapper, "offsetHeight", { value: height, configurable: true });
	});
}
// 1920 x 840 world bounds into the 204 x 96 map with a 6 px pad: a scale of exactly 0.1 and a 6 px offset.
const MINI_RECTS = [[0, 0, 800, 600], [880, 0, 400, 300], [1360, 0, 560, 840]];
async function minimapCanvas(extraReplies: Record<string, unknown> = {}) {
	const canvas = await loadRail(300, { ...SYSTEM_REPLY, ...extraReplies });
	layoutWorld(canvas, MINI_RECTS);
	// The map sits at (1000, 600) on the page.
	miniMap(canvas).rect = { left: 1000, top: 600, width: 204, height: 96 };
	canvas.windowEvent("resize");
	return canvas;
}
const mapPointer = (canvas: Canvas, type: string, worldX: number, worldY: number, init: Record<string, unknown> = {}) =>
	miniMap(canvas).dispatch(type, { button: 0, pointerId: 7, clientX: 1000 + 6 + worldX * 0.1, clientY: 600 + 6 + worldY * 0.1, ...init });

test("T1/S1: the minimap draws every board as a block at its relative position and size, the system board first", async () => {
	const canvas = await minimapCanvas();
	const blocks = miniBlocks(canvas);
	assert.equal(blocks.length, 3, "the system board and both artboards");
	near(miniBox(blocks[0]), [6, 6, 80, 60]);
	near(miniBox(blocks[1]), [94, 6, 40, 30]);
	near(miniBox(blocks[2]), [142, 6, 56, 84]);
	assert.ok(blocks[0].classes.has("gd-minimap-system"), "the first block is the system board");
	assert.ok(!blocks[1].classes.has("gd-minimap-system") && !blocks[2].classes.has("gd-minimap-system"));
	assert.equal(miniPanel(canvas).hidden, false);
});

test("T1/S1: blocks keep the world's aspect and are centered in the map", async () => {
	const canvas = await loadRail(300, SYSTEM_REPLY);
	// Wide and short bounds (4000 x 400): the width limits the scale to 0.048 and the height is centered.
	layoutWorld(canvas, [[0, 0, 2000, 400], [2200, 0, 800, 400], [3200, 0, 800, 400]]);
	canvas.windowEvent("resize");
	const blocks = miniBlocks(canvas);
	near(miniBox(blocks[0]), [6, 38.4, 96, 19.2]);
	near(miniBox(blocks[2]), [159.6, 38.4, 38.4, 19.2]);
});

test("T1/S1: the chosen artboard's block is the accent one, live, and the others are not", async () => {
	const canvas = await minimapCanvas();
	assert.deepEqual(miniBlocks(canvas).map((block) => block.classes.has("gd-minimap-chosen")), [false, false, false]);
	await setHandoffs(canvas, handoffDoc("02-b.html", { "02-b.html": {} }));
	assert.deepEqual(miniBlocks(canvas).map((block) => block.classes.has("gd-minimap-chosen")), [false, false, true]);
	await setHandoffs(canvas, handoffDoc(null, {}));
	assert.deepEqual(miniBlocks(canvas).map((block) => block.classes.has("gd-minimap-chosen")), [false, false, false]);
});

test("T1/S1: a placeholder board in the world is a dashed block, not an artboard", async () => {
	const canvas = await minimapCanvas();
	const placeholder = canvas.document.createElement("section");
	placeholder.classList.add("gd-placeholder");
	canvas.world.append(placeholder);
	// Bounds grow to 2400 wide: the scale is 0.08.
	layoutWorld(canvas, [...MINI_RECTS, [1960, 100, 440, 300]]);
	canvas.windowEvent("resize");
	const blocks = miniBlocks(canvas);
	assert.equal(blocks.length, 4);
	assert.ok(blocks[3].classes.has("gd-minimap-placeholder"));
	assert.ok(blocks.slice(0, 3).every((block) => !block.classes.has("gd-minimap-placeholder")));
	near(miniBox(blocks[3]), [162.8, 22.4, 35.2, 24]);
});

test("T1/S1: a board with no laid-out size draws no block", async () => {
	const canvas = await loadRail(300, SYSTEM_REPLY);
	canvas.windowEvent("resize");
	assert.equal(miniBlocks(canvas).length, 0);
	assert.equal(miniPanel(canvas).hidden, false, "the panel itself still shows while boards exist");
});

test("T1/S1: the visible area is an outlined rectangle that follows pan and zoom", async () => {
	const canvas = await minimapCanvas();
	// Initial view: world offset (48, 48) at 100% in a 1000 x 700 viewport shows world x -48..952, y -48..652.
	canvas.viewport.dispatch("keydown", { key: "ArrowRight" });
	canvas.viewport.dispatch("keydown", { key: "ArrowLeft" });
	near(miniBox(miniView(canvas)), [1.2, 1.2, 100, 70]);
	// A key pan of 50 px to the left moves the view 50 world px right.
	canvas.viewport.dispatch("keydown", { key: "ArrowRight" });
	near(miniBox(miniView(canvas)), [6.2, 1.2, 100, 70]);
	canvas.viewport.dispatch("keydown", { key: "ArrowLeft" });
	// Zoom in 25% around the center: x = -65, y = -27.5 shows world x 52..852, y 22..582.
	canvas.viewport.dispatch("keydown", { key: "+" });
	near(miniBox(miniView(canvas)), [11.2, 8.2, 80, 56]);
	assert.equal(miniView(canvas).getAttribute("aria-hidden"), null, "the rectangle lives inside the map, which carries the name");
});

test("T1/S1: the visible-area rectangle is clipped to the map when the view is away from the boards", async () => {
	const canvas = await minimapCanvas();
	for (let i = 0; i < 40; i++) canvas.viewport.dispatch("keydown", { key: "ArrowRight", shiftKey: true });
	const [left, top, width, height] = miniBox(miniView(canvas));
	assert.ok(left >= 0 && top >= 0 && left + width <= 204.01 && top + height <= 96.01, "never outside the map");
	assert.ok(left + width > 203.9 && width < 1, "pinned to the right edge, pointing to where the view went");
	assert.ok(height > 60);
});

test("T1/S1: a click in the minimap centers the view on that world point; zoom stays", async () => {
	const canvas = await minimapCanvas();
	canvas.viewport.dispatch("keydown", { key: "+" });
	const zoom = canvas.zoomLevel.textContent;
	// Click world point (400, 300): at 125% the viewport's center (500, 350) goes there.
	mapPointer(canvas, "pointerdown", 400, 300);
	assert.equal(canvas.world.style.transform, "translate(0px, -25px) scale(1.25)");
	mapPointer(canvas, "pointerup", 400, 300);
	assert.equal(canvas.zoomLevel.textContent, zoom);
	near(miniBox(miniView(canvas)), [6 + 0.1 * 0, 6 + 0.1 * 20, 80, 56]);
	assert.equal(canvas.navMode.textContent, "Navigating", "a click in the map never focuses an artboard");
});

test("T1/S1: dragging in the minimap pans with the pointer until it is released", async () => {
	const canvas = await minimapCanvas();
	mapPointer(canvas, "pointerdown", 400, 300);
	assert.equal(canvas.world.style.transform, "translate(100px, 50px) scale(1)");
	mapPointer(canvas, "pointermove", 600, 400);
	assert.equal(canvas.world.style.transform, "translate(-100px, -50px) scale(1)");
	near(miniBox(miniView(canvas)), [16, 11, 100, 70]);
	mapPointer(canvas, "pointerup", 600, 400);
	mapPointer(canvas, "pointermove", 1000, 700);
	assert.equal(canvas.world.style.transform, "translate(-100px, -50px) scale(1)", "moves after the release do nothing");
});

test("T1/S1: only the primary button pans, and another pointer's moves are ignored", async () => {
	const canvas = await minimapCanvas();
	const before = canvas.world.style.transform;
	mapPointer(canvas, "pointerdown", 400, 300, { button: 2 });
	assert.equal(canvas.world.style.transform, before);
	mapPointer(canvas, "pointerdown", 400, 300);
	const after = canvas.world.style.transform;
	mapPointer(canvas, "pointermove", 900, 500, { pointerId: 8 });
	assert.equal(canvas.world.style.transform, after);
	mapPointer(canvas, "pointercancel", 400, 300);
	mapPointer(canvas, "pointermove", 900, 500);
	assert.equal(canvas.world.style.transform, after, "a cancelled drag ends too");
});

test("T1/S1: the minimap follows the view for every kind of pan, a resize and a change of boards", async () => {
	const canvas = await minimapCanvas();
	const view = () => miniBox(miniView(canvas));
	canvas.viewport.dispatch("wheel", { deltaX: 100, deltaY: 0, deltaMode: 0, ctrlKey: false, metaKey: false, shiftKey: false, clientX: 300, clientY: 300 });
	near(view(), [1.2 + 10, 1.2, 100, 70]);
	canvas.viewport.rect = { left: 0, top: 50, width: 500, height: 700 };
	canvas.windowEvent("resize");
	near(view(), [11.2, 1.2, 50, 70]);
	// A third artboard widens the world to 2400: everything is redrawn at 0.08.
	(canvas.replies["/t/api/designs/alpha"] as { artboards: unknown[] }).artboards.push({ file: "03-c.html", title: "Third", tradeoff: "", width: 400, height: 300 });
	await canvas.serverEvent("show", { slug: "alpha" });
	// The reload replaced the artboards: the old blocks are gone and the new boards draw once the page has laid them out.
	assert.equal(miniBlocks(canvas).length, 1, "only the system board, which survives the reload");
	layoutWorld(canvas, [...MINI_RECTS, [1960, 0, 440, 300]]);
	canvas.windowEvent("resize");
	assert.equal(miniBlocks(canvas).length, 4);
	near(miniBox(miniBlocks(canvas)[3]), [162.8, 14.4, 35.2, 24]);
	assert.match(miniMap(canvas).getAttribute("aria-label")!, /among 3 directions/);
});

test("T1/S1: M toggles the minimap with the other single keys' rules", async () => {
	const canvas = await minimapCanvas();
	assert.equal(press(canvas, "m").defaultPrevented, true);
	assert.equal(miniPanel(canvas).hidden, true);
	press(canvas, "M");
	assert.equal(miniPanel(canvas).hidden, false, "case does not matter");
	press(canvas, "m");
	assert.equal(miniPanel(canvas).hidden, true);
	press(canvas, "m");
	assert.equal(miniPanel(canvas).hidden, false);
	// Drawing continues while it was hidden, so it is right when it comes back.
	press(canvas, "m");
	canvas.viewport.dispatch("keydown", { key: "+" });
	press(canvas, "m");
	near(miniBox(miniView(canvas)), [11.2, 8.2, 80, 56]);
});

test("T1/S1: M is ignored while typing, with a chord, with the comment box or the shortcuts open, and in focus mode", async () => {
	const canvas = await minimapCanvas();
	for (const tag of ["input", "textarea", "select"]) press(canvas, "m", {}, canvas.document.createElement(tag));
	for (const chord of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }]) press(canvas, "m", chord);
	assert.equal(miniPanel(canvas).hidden, false, "typing and browser chords never toggle it");
	canvas.document.getElementById("gd-popover").hidden = false;
	press(canvas, "m");
	canvas.document.getElementById("gd-popover").hidden = true;
	canvas.document.getElementById("gd-shortcuts").setAttribute("open", "");
	press(canvas, "m");
	canvas.document.getElementById("gd-shortcuts").removeAttribute("open");
	assert.equal(miniPanel(canvas).hidden, false, "the open comment box and shortcuts list leave it alone");

	click(canvas.boards[1].shield!, 200, 200);
	const event = press(canvas, "m");
	assert.equal(event.defaultPrevented, false, "the focused artboard owns the keyboard");
	canvas.document.getElementById("gd-back").dispatch("click");
	assert.equal(miniPanel(canvas).hidden, false, "M in focus mode did not switch it off behind the scenes");
});

test("T1/S1: the minimap is hidden in focus mode and comes back, as it was, on Back to canvas", async () => {
	const canvas = await minimapCanvas();
	click(canvas.boards[1].shield!, 200, 200);
	assert.equal(miniPanel(canvas).hidden, true);
	canvas.document.getElementById("gd-back").dispatch("click");
	assert.equal(miniPanel(canvas).hidden, false);
	press(canvas, "m");
	click(canvas.boards[1].shield!, 200, 200);
	canvas.document.getElementById("gd-back").dispatch("click");
	assert.equal(miniPanel(canvas).hidden, true, "a minimap switched off with M stays off after focus");
});

test("T1/S1: the minimap is hidden while Compare is open and returns when it closes", async () => {
	const canvas = await loadRail(300, { ...SYSTEM_REPLY, "/t/api/designs/alpha/handoffs": handoffDoc("01-a.html", { "01-a.html": { status: "implemented", previewUrl: "http://localhost:5173/login" } }) });
	layoutWorld(canvas, MINI_RECTS);
	canvas.windowEvent("resize");
	assert.equal(miniPanel(canvas).hidden, false);
	withClass(canvas.world.children[1], "gd-compare-start")[0].dispatch("click");
	assert.equal(canvas.document.getElementById("gd-compare").hidden, false);
	assert.equal(miniPanel(canvas).hidden, true);
	canvas.document.getElementById("gd-compare-back").dispatch("click");
	assert.equal(miniPanel(canvas).hidden, false);
});

test("T1/S1: the minimap is hidden while a version comparison is open and returns when it closes", async () => {
	const canvas = await withHistory(HISTORY, SYSTEM_REPLY);
	layoutWorld(canvas, MINI_RECTS);
	canvas.windowEvent("resize");
	assert.equal(miniPanel(canvas).hidden, false);
	openHistory(canvas);
	cardButton(canvas, "gd-version-compare", 3).dispatch("click");
	assert.equal(versionsPanel(canvas).hidden, false);
	assert.equal(miniPanel(canvas).hidden, true);
	canvas.document.getElementById("gd-versions-close").dispatch("click");
	assert.equal(versionsPanel(canvas).hidden, true);
	// The comparison put the artboard in focus mode and closing it leaves it again.
	assert.equal(miniPanel(canvas).hidden, false);
});

test("T1/S1: the minimap is hidden when there is nothing to show", async () => {
	const canvas = await loadRail(300, { "/t/api/designs": { designs: [] } }, { slug: null });
	assert.equal(miniPanel(canvas).hidden, true);
});

test("T1/S1: the map carries an accessible name with the artboard count, blocks are not focusable and the artboard list stays the keyboard path", async () => {
	const canvas = await minimapCanvas();
	const map = miniMap(canvas);
	assert.match(map.getAttribute("aria-label")!, /^Position of the visible area among 2 directions\. Click or drag to move the view; use the direction list with the keyboard\.$/);
	for (const block of miniBlocks(canvas)) {
		assert.equal(block.getAttribute("tabindex"), null);
		assert.notEqual(block.localName, "button");
		assert.equal(block.getAttribute("role"), null);
		assert.equal(block.getAttribute("aria-hidden"), "true");
	}
	assert.notEqual(miniView(canvas).localName, "button");
	assert.equal(miniView(canvas).getAttribute("tabindex"), null);
	assert.equal(navItems(canvas).length, 2, "the artboard list is still there");
	await setHandoffs(canvas, handoffDoc(null, {}));
	assert.equal(withClass(canvas.world, "gd-minimap-block").length, 0, "blocks live in the minimap, not in the world");
});

test("T1/S1: the label says 1 artboard in the singular", async () => {
	const canvas = await loadRail(300, { "/t/api/designs/alpha": { slug: "alpha", title: "Alpha", brief: "", artboards: [{ file: "01-a.html", title: "First", tradeoff: "", width: 400, height: 300 }] } });
	layoutWorld(canvas, [[0, 0, 400, 300]]);
	canvas.windowEvent("resize");
	assert.match(miniMap(canvas).getAttribute("aria-label")!, /among 1 direction\./);
});

test("T1/S1: a ResizeObserver on the viewport redraws the minimap too", async () => {
	const observers: Array<() => void> = [];
	class FakeResizeObserver {
		constructor(callback: () => void) { observers.push(callback); }
		observe() {}
	}
	const canvas = await loadRail(300, SYSTEM_REPLY, {}, { ResizeObserver: FakeResizeObserver });
	layoutWorld(canvas, MINI_RECTS);
	miniMap(canvas).rect = { left: 1000, top: 600, width: 204, height: 96 };
	assert.equal(miniBlocks(canvas).length, 0, "nothing was drawn before a layout existed");
	for (const callback of observers) callback();
	assert.equal(miniBlocks(canvas).length, 3);
});

test("T1/S1: the shortcuts dialog lists M, and the markup carries the minimap", () => {
	const html = read("index.html");
	assert.match(html, /<dt><kbd>M<\/kbd><\/dt><dd data-i18n="keys.minimap">Show or hide the minimap<\/dd>/);
	const section = html.match(/<section id="gd-minimap"[^>]*>[^]*?<\/section>/)![0];
	assert.match(section, /^<section id="gd-minimap" class="gd-minimap" aria-labelledby="gd-minimap-title">/);
	assert.match(section, /<h2 id="gd-minimap-title" class="gd-minimap-title"><span data-i18n="minimap.title">Minimap<\/span><kbd[^>]*>M<\/kbd><\/h2>/);
	assert.match(section, /<div id="gd-minimap-map" class="gd-minimap-map" role="img" aria-label="[^"]+"[^>]*>/);
	assert.match(section, /<b id="gd-minimap-view" class="gd-minimap-view"><\/b>/);
	assert.ok(!/tabindex|<button/.test(section), "nothing in the minimap takes the keyboard");
	const viewport = html.slice(html.indexOf('<main id="gd-viewport"'), html.indexOf("</main>"));
	assert.ok(viewport.includes('id="gd-minimap"'), "the minimap is inside the viewport, at its bottom right");
	assert.ok(html.indexOf('id="gd-minimap"') < html.indexOf('id="gd-nav-mode"'), "before the mode chip, so the sibling rule can make room for it");
	assert.ok(html.indexOf('id="gd-minimap"') < html.indexOf('id="gd-inspector"'), "the inspector panel paints over it");
});

test("T1/S1: canvas.css styles the minimap with tokens only, clear of the mode chip and the Back button, with no motion", () => {
	const css = read("canvas.css");
	const block = (selector: string) => {
		const start = css.indexOf(`${selector} {`);
		assert.ok(start >= 0, `${selector} is styled`);
		return css.slice(start, css.indexOf("}", start) + 1);
	};
	for (const selector of [".gd-minimap", ".gd-minimap-title", ".gd-minimap-map", ".gd-minimap-block", ".gd-minimap-system", ".gd-minimap-chosen", ".gd-minimap-placeholder", ".gd-minimap-view"]) {
		const text = block(selector);
		assert.ok(!/#[0-9a-fA-F]{3,8}\b|rgba?\(/.test(text), `${selector}: tokens only`);
		assert.ok(!/transition|animation/.test(text), `${selector}: no motion`);
	}
	assert.match(block(".gd-minimap"), /position:\s*absolute[^}]*right:\s*16px[^}]*bottom:\s*16px/);
	assert.match(block(".gd-minimap"), /background:\s*var\(--surface\)/);
	assert.match(block(".gd-minimap-map"), /width:\s*204px[^}]*height:\s*96px/);
	assert.match(block(".gd-minimap-map"), /overflow:\s*hidden/);
	assert.match(block(".gd-minimap-map"), /touch-action:\s*none/);
	assert.match(block(".gd-minimap-chosen"), /var\(--accent\)/);
	assert.match(block(".gd-minimap-placeholder"), /dashed var\(--accent\)/);
	assert.match(block(".gd-minimap-view"), /var\(--warning\)/);
	assert.match(block(".gd-minimap-view"), /pointer-events:\s*none/);
	// The centered mode chip gives way to the minimap while it shows.
	assert.match(css, /\.gd-minimap:not\(\[hidden\]\) ~ \.gd-nav-mode\s*{[^}]*max-width:/);
});

// ---- Artboard menu and another direction (canvas-minimap-variants-export T2/S2, S3)

const VARIANT_URL = "/t/api/designs/alpha/variant";
const menuEl = (canvas: Canvas) => canvas.document.getElementById("gd-menu");
const menuItems = (canvas: Canvas) => findAll(menuEl(canvas), (element) => element.getAttribute("role") === "menuitem");
const itemLabels = (canvas: Canvas) => menuItems(canvas).map((item) => texts(item, "gd-menu-label")[0]);
const menuButtonOf = (wrapper: FakeElement) => withClass(wrapper, "gd-menu-button")[0];
const keyOn = (target: FakeElement, key: string, init: Record<string, unknown> = {}) => target.dispatch("keydown", { key, shiftKey: false, ...init });
const openMenu = (canvas: Canvas, index = 0) => {
	const button = menuButtonOf(boardsOf(canvas)[index]);
	button.dispatch("click");
	return button;
};
const itemNamed = (canvas: Canvas, label: string) => menuItems(canvas).find((item) => texts(item, "gd-menu-label")[0] === label)!;
const dialogEl = (canvas: Canvas) => canvas.document.getElementById("gd-variant");
const variantField = (canvas: Canvas) => canvas.document.getElementById("gd-variant-text");
const variantMessage = (canvas: Canvas) => canvas.document.getElementById("gd-variant-message");
const submitVariant = async (canvas: Canvas) => {
	canvas.document.getElementById("gd-variant-form").dispatch("submit");
	for (let i = 0; i < 5; i++) await flush();
};
/** Opens the menu of the artboard at `index` of the world and chooses Try another direction from this…. */
async function openVariant(canvas: Canvas, index = 0) {
	const button = openMenu(canvas, index);
	itemNamed(canvas, "Try another direction from this…").dispatch("click");
	return button;
}
const implementedDoc = (file = "01-a.html") => handoffDoc(file, { [file]: { status: "implemented", previewUrl: "http://localhost:3000/" } });

test("T2/S2: each design artboard has a ⋯ menu button named after it, collapsed; the system board has none", async () => {
	const canvas = await loadRail(300, SYSTEM_REPLY);
	const [system, first, second] = boardsOf(canvas);
	assert.equal(withClass(system, "gd-menu-button").length, 0, "the system board has no menu");
	for (const [wrapper, title] of [[first, "First"], [second, "Second"]] as const) {
		const buttons = withClass(wrapper, "gd-menu-button");
		assert.equal(buttons.length, 1);
		const button = buttons[0];
		assert.equal(button.localName, "button");
		assert.equal(button.type, "button");
		assert.equal(button.getAttribute("aria-label"), `More actions for ${title}`);
		assert.equal(button.getAttribute("aria-haspopup"), "menu");
		assert.equal(button.getAttribute("aria-expanded"), "false");
		assert.equal(button.textContent, "", "an icon, not text");
		assert.ok(withClass(wrapper, "gd-artboard-head")[0].contains(button), "in the artboard header");
	}
	assert.equal(menuEl(canvas).hidden, true);
});

test("T2/S2: opening the menu lists the actions, marks the button expanded and focuses the first item", async () => {
	const canvas = await loadRail();
	const button = openMenu(canvas, 1);
	assert.equal(menuEl(canvas).hidden, false);
	assert.equal(button.getAttribute("aria-expanded"), "true");
	assert.equal(menuEl(canvas).getAttribute("aria-label"), "Second actions");
	// Compare with app is offered only when the app can be compared.
	assert.deepEqual(itemLabels(canvas), ["Try another direction from this…", "Export as PNG", "Export as PNG at 2×", "Export as PDF", "Download HTML", "Implement this"]);
	assert.ok(menuItems(canvas).every((item) => item.localName === "button" && item.getAttribute("tabindex") === "-1"));
	assert.ok(canvas.document.activeElement === menuItems(canvas)[0]);
	assert.equal(menuEl(canvas).style.left, "0px", "placed at the button");
	// The button toggles it.
	button.dispatch("click");
	assert.equal(menuEl(canvas).hidden, true);
	assert.equal(button.getAttribute("aria-expanded"), "false");
	assert.ok(canvas.document.activeElement === button, "closing with the button keeps focus on it");
});

test("T2/S2: Compare with app is in the menu only for an implemented artboard with a preview, and opens Compare", async () => {
	const canvas = await loadRail(300, { "/t/api/designs/alpha/handoffs": implementedDoc("01-a.html") });
	openMenu(canvas, 0);
	assert.deepEqual(itemLabels(canvas), ["Try another direction from this…", "Compare with app", "Export as PNG", "Export as PNG at 2×", "Export as PDF", "Download HTML", "Implement this"]);
	itemNamed(canvas, "Compare with app").dispatch("click");
	assert.equal(menuEl(canvas).hidden, true, "choosing closes the menu");
	assert.equal(canvas.document.getElementById("gd-compare").hidden, false, "Compare is open");
	const other = await loadRail(300, { "/t/api/designs/alpha/handoffs": implementedDoc("01-a.html") });
	openMenu(other, 1);
	assert.ok(!itemLabels(other).includes("Compare with app"), "the other artboard has no running app");
});

test("T2/S2: the keyboard opens the menu with Enter, Space or the arrows, and moves with arrows, Home and End", async () => {
	const canvas = await loadRail();
	const button = menuButtonOf(boardsOf(canvas)[0]);
	// Enter and Space on the button are its click; ArrowDown and ArrowUp open it on the first or the last item.
	const down = keyOn(button, "ArrowDown");
	assert.equal(down.defaultPrevented, true);
	assert.equal(menuEl(canvas).hidden, false);
	assert.ok(canvas.document.activeElement === menuItems(canvas)[0]);
	keyOn(button, "Escape");
	assert.equal(menuEl(canvas).hidden, true);
	keyOn(button, "ArrowUp");
	const items = menuItems(canvas);
	assert.ok(canvas.document.activeElement === items[items.length - 1], "ArrowUp opens on the last item");

	const at = () => items.findIndex((item) => item === canvas.document.activeElement);
	keyOn(items[at()], "ArrowDown");
	assert.equal(at(), 0, "ArrowDown wraps to the first");
	keyOn(items[at()], "ArrowUp");
	assert.equal(at(), items.length - 1, "ArrowUp wraps to the last");
	keyOn(items[at()], "Home");
	assert.equal(at(), 0);
	keyOn(items[at()], "ArrowDown");
	assert.equal(at(), 1);
	keyOn(items[at()], "End");
	assert.equal(at(), items.length - 1);
	assert.equal(menuEl(canvas).hidden, false, "moving never closes it");
});

test("T2/S2: Enter and Space on an item choose it; Escape returns focus to the button; Tab closes", async () => {
	const canvas = await loadRail();
	const button = openMenu(canvas, 0);
	const escape = keyOn(menuItems(canvas)[1], "Escape");
	assert.equal(escape.defaultPrevented, true);
	assert.equal(menuEl(canvas).hidden, true);
	assert.equal(button.getAttribute("aria-expanded"), "false");
	assert.ok(canvas.document.activeElement === button, "Esc returns focus to the button");

	for (const key of ["Enter", " "]) {
		openMenu(canvas, 0);
		const chosen = keyOn(itemNamed(canvas, "Try another direction from this…"), key);
		assert.equal(chosen.defaultPrevented, true, key);
		assert.equal(menuEl(canvas).hidden, true, key);
		assert.equal(dialogEl(canvas).hasAttribute("open"), true, `${key} chose the item`);
		dialogEl(canvas).removeAttribute("open");
	}

	openMenu(canvas, 0);
	const tab = keyOn(menuItems(canvas)[0], "Tab");
	assert.equal(tab.defaultPrevented, false, "Tab keeps its move");
	assert.equal(menuEl(canvas).hidden, true);
	assert.equal(button.getAttribute("aria-expanded"), "false");
});

test("T2/S2: a click outside, a pan or zoom, or opening another menu closes it; a click inside does not", async () => {
	const canvas = await loadRail();
	const first = openMenu(canvas, 0);
	const pointerdown = (target: FakeElement) => (canvas.document.listeners.get("pointerdown") ?? []).forEach((listener) => listener({ target, button: 0 }));
	pointerdown(menuEl(canvas));
	pointerdown(menuItems(canvas)[0]);
	assert.equal(menuEl(canvas).hidden, false, "inside the menu");
	pointerdown(first);
	assert.equal(menuEl(canvas).hidden, false, "the button toggles on its own click, not on pointerdown");
	pointerdown(canvas.viewport);
	assert.equal(menuEl(canvas).hidden, true, "outside");
	assert.equal(first.getAttribute("aria-expanded"), "false");

	openMenu(canvas, 0);
	canvas.viewport.dispatch("keydown", { key: "+" });
	assert.equal(menuEl(canvas).hidden, true, "a zoom closes it");

	const one = openMenu(canvas, 0);
	const two = openMenu(canvas, 1);
	assert.equal(one.getAttribute("aria-expanded"), "false");
	assert.equal(two.getAttribute("aria-expanded"), "true");
	assert.equal(menuEl(canvas).getAttribute("aria-label"), "Second actions");
});

test("T2/S2: single-key shortcuts stay off while the menu is open", async () => {
	const canvas = await loadRail();
	openMenu(canvas, 0);
	const before = pressed(canvas, "gd-comment");
	press(canvas, "c", {}, menuItems(canvas)[0]);
	press(canvas, "m", {}, menuItems(canvas)[0]);
	assert.equal(pressed(canvas, "gd-comment"), before, "C did nothing");
	assert.equal(miniPanel(canvas).hidden, false, "M did nothing");
	keyOn(menuItems(canvas)[0], "Escape");
	press(canvas, "m");
	assert.equal(miniPanel(canvas).hidden, true, "back to normal after it closes");
});

test("T2/S2: Implement this stays visible in the header and the menu item opens the same confirm step", async () => {
	const canvas = await loadRail();
	const wrapper = boardsOf(canvas)[0];
	const control = withClass(wrapper, "gd-implement")[0];
	const start = withClass(control, "gd-implement-start")[0];
	const confirm = withClass(control, "gd-implement-confirm")[0];
	assert.equal(start.hidden, false);
	assert.equal(start.textContent, "Implement this");
	assert.ok(!menuEl(canvas).contains(start), "the header button is not moved into the menu");
	assert.equal(confirm.hidden, true);
	openMenu(canvas, 0);
	itemNamed(canvas, "Implement this").dispatch("click");
	assert.equal(menuEl(canvas).hidden, true);
	assert.equal(confirm.hidden, false, "the confirm step is open");
	assert.equal(start.hidden, true);
	assert.equal(canvas.fetched.filter((url) => url === IMPLEMENT).length, 0, "nothing is sent before confirming");
	withClass(control, "gd-primary")[0].dispatch("click");
	for (let i = 0; i < 5; i++) await flush();
	assert.deepEqual(canvas.posts.filter((post) => post.url === IMPLEMENT), [{ url: IMPLEMENT, body: { file: "01-a.html" } }]);
});

for (const [name, navigator] of [
	["missing", {}],
	["denied", { mediaDevices: { getDisplayMedia: async () => { throw new Error("denied"); } } }],
] as const) test(`T3/S4: ${name} tab capture reports an inline alert and suggests the browser screenshot tool`, async () => {
	const canvas = await loadRail(300, {}, {}, { navigator, confirm: () => true });
	openMenu(canvas, 0);
	itemNamed(canvas, "Export as PNG").dispatch("click");
	await flush();
	await flush();
	const alerts = withClass(canvas.world, "gd-alert");
	assert.ok(alerts.some((alert) => !alert.hidden && texts(alert, "gd-alert-text").some((text) => /screenshot/i.test(text))));
	assert.equal(canvas.posts.length, 0);
});

for (const scale of [1, 2]) test(`T3/S4: export ${scale}× crops the selected tab and stops its track`, async () => {
	const calls: string[] = [];
	const draw: number[][] = [];
	const names: string[] = [];
	const during: Array<{ exporting: boolean; transform: string }> = [];
	let output: any;
	const stream = { getTracks: () => [{ stop: () => calls.push("stop") }] };
	const canvas = await loadRail(300, {}, {}, {
		confirm: (message: string) => { calls.push(message); return true; },
		navigator: { mediaDevices: { getDisplayMedia: async () => { calls.push("capture"); return stream; } } },
		URL: { createObjectURL: () => "blob:test", revokeObjectURL: () => calls.push("revoke") },
	});
	canvas.boards[0].frame.rect = { left: 100, top: 100, width: 400, height: 300, right: 500, bottom: 400 } as Rect;
	const create = canvas.document.createElement.bind(canvas.document);
	canvas.document.createElement = ((tag: string) => {
		if (tag === "video") return { videoWidth: 1200, videoHeight: 800, play: async () => { calls.push("play"); }, requestVideoFrameCallback: (done: () => void) => { calls.push("frame"); done(); } };
		if (tag === "canvas") return output = { getContext: () => ({ drawImage: (_video: unknown, ...args: number[]) => {
			draw.push(args);
			during.push({ exporting: canvas.document.body.classList.contains("gd-exporting"), transform: canvas.world.style.transform });
			calls.push("draw");
		} }), toBlob: (done: (blob: object) => void) => { calls.push("encode"); done({}); } };
		if (tag === "a") return { click() { names.push(this.download); }, href: "", download: "" };
		return create(tag);
	}) as typeof canvas.document.createElement;
	const before = canvas.world.style.transform;
	openMenu(canvas, 0);
	itemNamed(canvas, scale === 1 ? "Export as PNG" : "Export as PNG at 2×").dispatch("click");
	for (let i = 0; i < 8; i++) await flush();
	assert.match(calls[0], /choose this canvas tab/i);
	assert.equal(calls[1], "capture");
	assert.deepEqual(draw, [[100, 100, 400, 300, 0, 0, 400 * scale, 300 * scale]]);
	assert.deepEqual(names, [`01-a${scale === 2 ? "@2x" : ""}.png`]);
	assert.equal(output.width, 400 * scale);
	assert.equal(output.height, 300 * scale);
	assert.equal(calls.filter((c) => c === "stop").length, 1);
	assert.ok(calls.indexOf("stop") < calls.indexOf("encode"), "capture stops immediately after grabbing the frame");
	assert.ok(calls.indexOf("frame") > calls.indexOf("play") && calls.indexOf("frame") < calls.indexOf("draw"), "the frame is drawn after a new video frame, not the first one");
	assert.equal(during.length, 1);
	assert.equal(during[0].exporting, true, "the canvas chrome is hidden while the frame is grabbed");
	assert.match(during[0].transform, /scale\(1\)/, "the artboard is at 100%");
	assert.equal(canvas.document.body.classList.contains("gd-exporting"), false, "the chrome comes back");
	assert.equal(canvas.world.style.transform, before);
	assert.equal(canvas.posts.length, 0);
	if (scale === 2) assert.match(canvas.document.getElementById("gd-toast").textContent, /upscaled/i);
});

test("T3/S4: an artboard bigger than the window names the window size it needs and grabs nothing", async () => {
	let stopped = 0;
	let drawn = 0;
	const canvas = await loadRail(300, {}, {}, {
		confirm: () => true,
		navigator: { mediaDevices: { getDisplayMedia: async () => ({ getTracks: () => [{ stop: () => stopped++ }] }) } },
	});
	canvas.boards[0].frame.rect = { left: 0, top: 0, width: 1440, height: 900, right: 1440, bottom: 900 } as Rect;
	const create = canvas.document.createElement.bind(canvas.document);
	canvas.document.createElement = ((tag: string) => tag === "canvas" ? { getContext: () => ({ drawImage: () => drawn++ }) } : create(tag)) as typeof canvas.document.createElement;
	const before = canvas.world.style.transform;
	openMenu(canvas, 0);
	itemNamed(canvas, "Export as PNG").dispatch("click");
	for (let i = 0; i < 8; i++) await flush();
	assert.equal(drawn, 0);
	assert.equal(stopped, 1);
	const shown = withClass(canvas.world, "gd-alert").filter((alert) => !alert.hidden);
	assert.equal(shown.length, 1);
	assert.match(texts(shown[0], "gd-alert-detail").join(" "), /1440 × 900/);
	assert.match(texts(shown[0], "gd-alert-detail").join(" "), /F11/);
	assert.equal(canvas.document.body.classList.contains("gd-exporting"), false);
	assert.equal(canvas.world.style.transform, before);
	assert.equal(canvas.posts.length, 0);
});

test("T3/S4: canvas.css hides the canvas chrome and pins the viewport to the window while exporting", () => {
	const css = read("canvas.css");
	const rules = css.slice(css.indexOf(".gd-exporting"));
	assert.match(rules, /\.gd-exporting \.gd-viewport\s*\{[^}]*position:\s*fixed;[^}]*inset:\s*0;/);
	assert.match(rules, /\.gd-exporting \.gd-viewport > :not\(\.gd-world\)/);
	for (const hidden of ["gd-pins", "gd-overflow-flag", "gd-artboard:not(.gd-focus-board)"]) assert.ok(rules.includes(`.gd-exporting .${hidden}`), hidden);
});

test("T3: the artboard menu is measured at a neutral position, so a stale position cannot push it off the right edge", async () => {
	const canvas = await loadRail(300);
	const menu = canvas.document.getElementById("gd-menu");
	// Like a fixed box without a width: it shrinks to the room left of its left edge, up to its content width.
	Object.defineProperty(menu, "offsetWidth", { get: () => Math.min(500, 1200 - (parseFloat(menu.style.left) || 0)) });
	menu.style.left = "1100px";
	const button = withClass(canvas.world, "gd-menu-button")[0];
	button.rect = { left: 1150, top: 40, width: 28, height: 28, right: 1178, bottom: 68 } as Rect;
	button.dispatch("click");
	const left = parseFloat(menu.style.left);
	assert.equal(left, 1200 - 500 - 12);
	assert.ok(left + menu.offsetWidth <= 1200 - 12);
});

for (const surface of ["window", "monitor"]) test(`T3/S4: sharing a ${surface} instead of the tab exports nothing and explains it`, async () => {
	let stopped = 0;
	let drawn = 0;
	const track = { stop: () => stopped++, getSettings: () => ({ displaySurface: surface }) };
	const canvas = await loadRail(300, {}, {}, {
		confirm: () => true,
		navigator: { mediaDevices: { getDisplayMedia: async () => ({ getTracks: () => [track], getVideoTracks: () => [track] }) } },
	});
	canvas.boards[0].frame.rect = { left: 100, top: 100, width: 400, height: 300, right: 500, bottom: 400 } as Rect;
	const create = canvas.document.createElement.bind(canvas.document);
	canvas.document.createElement = ((tag: string) => tag === "canvas" ? { getContext: () => ({ drawImage: () => drawn++ }) } : create(tag)) as typeof canvas.document.createElement;
	const before = canvas.world.style.transform;
	openMenu(canvas, 0);
	itemNamed(canvas, "Export as PNG").dispatch("click");
	for (let i = 0; i < 8; i++) await flush();
	assert.equal(drawn, 0);
	assert.equal(stopped, 1);
	const shown = withClass(canvas.world, "gd-alert").filter((alert) => !alert.hidden);
	assert.equal(shown.length, 1);
	assert.match(texts(shown[0], "gd-alert-text").join(" "), /screenshot/i);
	assert.match(texts(shown[0], "gd-alert-detail").join(" "), /not this tab/i);
	assert.equal(canvas.document.body.classList.contains("gd-exporting"), false);
	assert.equal(canvas.world.style.transform, before);
	assert.equal(canvas.posts.length, 0);
});

test("PDF: Export as PDF prints the artboard alone at its size once its frame has loaded, then cleans up", async () => {
	let printed = 0;
	const canvas = await loadRail(300, {}, {}, { print: () => printed++ });
	openMenu(canvas, 0);
	itemNamed(canvas, "Export as PDF").dispatch("click");
	const body = canvas.document.body;
	const holder = withClass(body, "gd-print")[0];
	assert.ok(holder, "a print container is added to the page");
	assert.equal(body.classList.contains("gd-printing"), true);
	const frame = holder.children[0];
	assert.equal(frame.localName, "iframe");
	assert.equal(frame.getAttribute("src"), "/t/files/alpha/01-a.html");
	assert.equal(frame.getAttribute("sandbox"), "allow-scripts", "sandboxed like the canvas frames");
	assert.equal(frame.style.width, canvas.boards[0].frame.style.width);
	assert.match(frame.style.height, /^\d+px$/);
	assert.equal(printed, 0, "printing waits for the artboard");
	frame.dispatch("load");
	assert.equal(printed, 1);
	canvas.windowEvent("afterprint");
	assert.equal(withClass(body, "gd-print").length, 0, "the container is removed after printing");
	assert.equal(body.classList.contains("gd-printing"), false);
	assert.equal(canvas.posts.length, 0, "nothing is sent to the server");
});

test("HTML: Download HTML saves the artboard file without the injected inspector", async () => {
	const names: string[] = [];
	const blobs: unknown[][] = [];
	const original = "<!doctype html><title>A</title><p>Hello</p></body></html>";
	const served = original.replace("</body>", '<script src="/t/assets/inspector.js"></script></body>');
	const canvas = await loadRail(300, { "/t/files/alpha/01-a.html": { __text: served } }, {}, {
		Blob: class { constructor(parts: unknown[]) { blobs.push(parts); } },
		URL: { createObjectURL: () => "blob:test", revokeObjectURL: () => {} },
	});
	const create = canvas.document.createElement.bind(canvas.document);
	canvas.document.createElement = ((tag: string) => tag === "a" ? { click() { names.push(this.download); }, href: "", download: "" } : create(tag)) as typeof canvas.document.createElement;
	openMenu(canvas, 0);
	itemNamed(canvas, "Download HTML").dispatch("click");
	for (let i = 0; i < 4; i++) await flush();
	assert.deepEqual(names, ["01-a.html"]);
	assert.deepEqual(JSON.parse(JSON.stringify(blobs)), [[original]]);
	assert.equal(canvas.posts.length, 0);
});

test("HTML: a failed Download HTML shows an inline alert and downloads nothing", async () => {
	const names: string[] = [];
	const canvas = await loadRail(300);
	const create = canvas.document.createElement.bind(canvas.document);
	canvas.document.createElement = ((tag: string) => tag === "a" ? { click() { names.push(this.download); }, href: "", download: "" } : create(tag)) as typeof canvas.document.createElement;
	openMenu(canvas, 0);
	itemNamed(canvas, "Download HTML").dispatch("click");
	for (let i = 0; i < 4; i++) await flush();
	assert.deepEqual(names, []);
	const shown = withClass(canvas.world, "gd-alert").filter((alert) => !alert.hidden);
	assert.equal(shown.length, 1);
	assert.match(texts(shown[0], "gd-alert-text").join(" "), /Could not download the artboard/);
});

test("brand: the rail mark is the Gentle rose of the startup banner, dot for dot, decorative", () => {
	const html = read("index.html");
	// The same rose as the terminal banner: every raised braille dot becomes one 1x1 square of a 2x4 grid per character.
	const banner = readFileSync(join(import.meta.dirname, "..", "extensions", "startup-banner.ts"), "utf8");
	const rows = [...banner.match(/const ROSE_LARGE_RAW = \[([^]*?)\];/)![1].matchAll(/"([^"]*)"/g)].map((match) => match[1]);
	const bits: Array<[number, number, number]> = [[0x01, 0, 0], [0x02, 0, 1], [0x04, 0, 2], [0x40, 0, 3], [0x08, 1, 0], [0x10, 1, 1], [0x20, 1, 2], [0x80, 1, 3]];
	let path = "";
	rows.forEach((line, row) => [...line].forEach((char, column) => {
		const code = char.codePointAt(0)! - 0x2800;
		if (code > 0 && code <= 0xff) for (const [bit, dx, dy] of bits) if (code & bit) path += `M${column * 2 + dx} ${row * 4 + dy}h1v1h-1z`;
	}));
	const width = Math.max(...rows.map((line) => [...line].length)) * 2;
	assert.ok(html.includes(`<symbol id="i-rose" viewBox="0 0 ${width} ${rows.length * 4}"><path d="${path}"/></symbol>`));
	assert.match(html, /<span class="gd-mark" aria-hidden="true"><svg class="gd-i gd-rose"><use href="#i-rose"\/><\/svg><\/span>/);
	assert.ok(!/<span class="gd-mark"[^>]*>GD<\/span>/.test(html), "no GD letters");
});

test("PDF: canvas.css prints only the print container, with no page margin", () => {
	const css = read("canvas.css");
	assert.match(css, /@media print\s*\{[^]*body\.gd-printing > :not\(\.gd-print\)\s*\{\s*display:\s*none/);
	assert.match(css, /@page\s*\{\s*margin:\s*0/);
});

test("T3/S4: cancelling the tab-selection warning does not start a capture", async () => {
	let captures = 0;
	const canvas = await loadRail(300, {}, {}, {
		confirm: () => false,
		navigator: { mediaDevices: { getDisplayMedia: async () => { captures++; } } },
	});
	const before = canvas.world.style.transform;
	openMenu(canvas, 0);
	itemNamed(canvas, "Export as PNG").dispatch("click");
	await flush();
	assert.equal(captures, 0);
	assert.equal(canvas.world.style.transform, before);
	assert.equal(canvas.posts.length, 0);
});

test("T3/S4: a capture failure stops the stream and restores the canvas view", async () => {
	let stopped = 0;
	const canvas = await loadRail(300, {}, {}, {
		confirm: () => true,
		navigator: { mediaDevices: { getDisplayMedia: async () => ({ getTracks: () => [{ stop: () => stopped++ }] }) } },
	});
	canvas.boards[0].frame.rect = { left: 100, top: 100, width: 400, height: 300, right: 500, bottom: 400 } as Rect;
	const create = canvas.document.createElement.bind(canvas.document);
	canvas.document.createElement = ((tag: string) => tag === "video" ? { play: async () => { throw new Error("capture failed"); } } : create(tag)) as typeof canvas.document.createElement;
	const before = canvas.world.style.transform;
	openMenu(canvas, 0);
	itemNamed(canvas, "Export as PNG").dispatch("click");
	for (let i = 0; i < 8; i++) await flush();
	assert.equal(stopped, 1);
	assert.equal(canvas.world.style.transform, before);
	assert.match(canvas.navMode.textContent, /Navigating/);
	assert.ok(withClass(canvas.world, "gd-alert").some((alert) => !alert.hidden && texts(alert, "gd-alert-text").some((text) => /screenshot/i.test(text))));
	assert.equal(canvas.posts.length, 0);
});

test("T2/S3: Try another direction opens a dialog named after the source artboard, empty, with the field focused", async () => {
	const canvas = await loadRail();
	assert.equal(dialogEl(canvas).hasAttribute("open"), false);
	await openVariant(canvas, 1);
	assert.equal(dialogEl(canvas).hasAttribute("open"), true);
	assert.equal(canvas.document.getElementById("gd-variant-source").textContent, "Second");
	assert.match(canvas.document.getElementById("gd-variant-note").textContent, /new artboard, 03, and keeps the others/);
	assert.equal(variantField(canvas).value, "");
	assert.ok(canvas.document.activeElement === variantField(canvas));
	assert.equal(variantMessage(canvas).textContent, "");
	assert.deepEqual(texts(canvas.document.getElementById("gd-variant-chips"), "gd-suggestion"), ["More compact", "Bolder", "Mobile first", "Calmer colors"]);
	assert.equal(canvas.posts.length, 0, "opening sends nothing");
});

test("T2/S3: a suggestion chip fills the field, and a later one adds to it", async () => {
	const canvas = await loadRail();
	await openVariant(canvas);
	const chips = withClass(canvas.document.getElementById("gd-variant-chips"), "gd-suggestion");
	chips[1].dispatch("click");
	assert.equal(variantField(canvas).value, "Bolder");
	assert.ok(canvas.document.activeElement === variantField(canvas), "focus goes back to the field");
	chips[3].dispatch("click");
	assert.equal(variantField(canvas).value, "Bolder, calmer colors");
	chips[3].dispatch("click");
	assert.equal(variantField(canvas).value, "Bolder, calmer colors", "the same suggestion is not added twice");
	variantField(canvas).value = "x".repeat(1995);
	chips[0].dispatch("click");
	assert.equal(variantField(canvas).value, "x".repeat(1995), "a suggestion that would pass 2000 characters is not added");
	variantField(canvas).value = "";
	chips[0].dispatch("click");
	assert.equal(variantField(canvas).value, "More compact");
});

test("T2/S3: an empty, blank or over-long instruction is refused in the dialog and nothing is sent", async () => {
	const canvas = await loadRail();
	await openVariant(canvas);
	for (const value of ["", "   \n\t ", "x".repeat(2001), `  ${"x".repeat(2001)}`]) {
		variantField(canvas).value = value;
		await submitVariant(canvas);
		assert.match(variantMessage(canvas).textContent, /1 to 2000 characters/, JSON.stringify(value.slice(0, 5)));
		assert.ok(variantMessage(canvas).classes.has("gd-error"));
		assert.equal(variantField(canvas).getAttribute("aria-invalid"), "true");
		assert.equal(dialogEl(canvas).hasAttribute("open"), true, "the dialog stays open");
		assert.ok(canvas.document.activeElement === variantField(canvas));
	}
	assert.equal(canvas.posts.length, 0);
	// Exactly 2000 characters, padded with blanks, is fine; typing clears the complaint.
	canvas.replies[VARIANT_URL] = { ok: true, slug: "alpha", file: "01-a.html", queued: false };
	variantField(canvas).value = `  ${"x".repeat(2000)}  `;
	variantField(canvas).dispatch("input");
	assert.equal(variantMessage(canvas).textContent, "");
	assert.equal(variantField(canvas).getAttribute("aria-invalid"), null);
	await submitVariant(canvas);
	assert.equal(canvas.posts.length, 1);
	assert.equal((canvas.posts[0].body as { instruction: string }).instruction.length, 2000);
});

test("T2/S3: Send posts the source file and the trimmed instruction, closes the dialog and shows the placeholder", async () => {
	const canvas = await loadRail(300, SYSTEM_REPLY);
	canvas.replies[VARIANT_URL] = { ok: true, slug: "alpha", file: "02-b.html", queued: false };
	assert.equal(withClass(canvas.world, "gd-placeholder").length, 0);
	const button = await openVariant(canvas, 2);
	variantField(canvas).value = "  Same layout,\nbut calmer  ";
	await submitVariant(canvas);
	assert.deepEqual(canvas.posts, [{ url: VARIANT_URL, body: { file: "02-b.html", instruction: "Same layout,\nbut calmer" } }]);
	assert.equal(dialogEl(canvas).hasAttribute("open"), false, "the dialog closes");
	assert.ok(canvas.document.activeElement === button, "focus returns to the menu button");
	assert.equal(canvas.document.getElementById("gd-toast").textContent, "Sent: the session is adding a new direction based on Second now.");

	const placeholders = withClass(canvas.world, "gd-placeholder");
	assert.equal(placeholders.length, 1);
	assert.ok(canvas.world.children[canvas.world.children.length - 1] === placeholders[0], "after the last artboard");
	assert.equal(placeholders[0].getAttribute("aria-label"), "03 · New direction");
	assert.deepEqual(texts(placeholders[0], "gd-artboard-num"), ["03"]);
	assert.deepEqual(texts(placeholders[0], "gd-artboard-title"), ["New direction"]);
	assert.deepEqual(texts(placeholders[0], "gd-placeholder-state"), ["Designing…"]);
	assert.equal(withClass(placeholders[0], "gd-placeholder-state")[0].getAttribute("role"), "status");
	assert.equal(withClass(placeholders[0], "gd-menu-button").length, 0, "a placeholder has no menu");
	assert.equal(withClass(placeholders[0], "gd-shield").length, 0, "nor can it be used");
	await openVariant(canvas, 2);
	assert.equal(variantField(canvas).value, "", "the field is empty the next time");
});

test("T2/S3: a queued request says so in the toast", async () => {
	const canvas = await loadRail();
	canvas.replies[VARIANT_URL] = { ok: true, slug: "alpha", file: "01-a.html", queued: true };
	await openVariant(canvas);
	variantField(canvas).value = "Bolder";
	await submitVariant(canvas);
	assert.equal(canvas.document.getElementById("gd-toast").textContent, "Queued: the session will add a new direction based on First after its current task.");
	assert.equal(withClass(canvas.world, "gd-placeholder").length, 1);
});

test("T2/S3: a refused request keeps the dialog open with the reason, adds no placeholder and can be retried", async () => {
	const canvas = await loadRail();
	await openVariant(canvas);
	variantField(canvas).value = "Bolder";
	const send = canvas.document.getElementById("gd-variant-send");
	const cases: Array<[Record<string, unknown>, RegExp, string]> = [
		[{ __http: 501, error: "variant-unavailable" }, /not connected to a Pi session[^]*\/gentle:design open/, "variant-unavailable"],
		[{ __http: 500, error: "delivery-failed" }, /did not accept the request[^]*nothing was sent/, "delivery-failed"],
		[{ __http: 400, error: "invalid-instruction", reason: "instruction must have 1 to 2000 characters" }, /Write 1 to 2000 characters/, "invalid-instruction: instruction must have 1 to 2000 characters"],
		[{ __throw: "Failed to fetch" }, /could not reach/i, "network: Failed to fetch"],
	];
	for (const [reply, text, detail] of cases) {
		canvas.replies[VARIANT_URL] = reply;
		await submitVariant(canvas);
		assert.match(variantMessage(canvas).textContent, text, detail);
		assert.equal(variantMessage(canvas).title, detail);
		assert.ok(variantMessage(canvas).classes.has("gd-error"));
		assert.equal(dialogEl(canvas).hasAttribute("open"), true);
		assert.equal(send.disabled, false, "Send works again");
		assert.equal(variantField(canvas).value, "Bolder", "what was typed is kept");
		assert.equal(withClass(canvas.world, "gd-placeholder").length, 0);
	}
	canvas.replies[VARIANT_URL] = { ok: true, slug: "alpha", file: "01-a.html", queued: false };
	await submitVariant(canvas);
	assert.equal(dialogEl(canvas).hasAttribute("open"), false);
	assert.equal(variantMessage(canvas).textContent, "", "the complaint does not outlive the dialog");
	assert.equal(withClass(canvas.world, "gd-placeholder").length, 1);
});

test("T2/S3: Send is disabled while the request is in flight, so a double click sends once", async () => {
	const canvas = await loadRail();
	await openVariant(canvas);
	variantField(canvas).value = "Bolder";
	canvas.replies[VARIANT_URL] = { ok: true, slug: "alpha", file: "01-a.html", queued: false };
	const form = canvas.document.getElementById("gd-variant-form");
	form.dispatch("submit");
	assert.equal(canvas.document.getElementById("gd-variant-send").disabled, true);
	form.dispatch("submit");
	for (let i = 0; i < 5; i++) await flush();
	assert.equal(canvas.posts.length, 1);
});

test("T2/S3: Cancel and a closed dialog (Esc) send nothing and return focus to the menu button", async () => {
	const canvas = await loadRail();
	const button = await openVariant(canvas, 1);
	variantField(canvas).value = "Bolder";
	canvas.document.getElementById("gd-variant-cancel").dispatch("click");
	assert.equal(dialogEl(canvas).hasAttribute("open"), false);
	assert.ok(canvas.document.activeElement === button);
	assert.equal(canvas.posts.length, 0);
	assert.equal(withClass(canvas.world, "gd-placeholder").length, 0);

	await openVariant(canvas, 1);
	assert.equal(variantField(canvas).value, "", "a cancelled instruction is not kept");
	// The browser closes a modal dialog on Esc and reports it with a close event.
	dialogEl(canvas).removeAttribute("open");
	canvas.document.body.focus();
	dialogEl(canvas).dispatch("close");
	assert.ok(canvas.document.activeElement === button);
	assert.equal(canvas.posts.length, 0);
});

test("T2/S3: single-key shortcuts stay off while the dialog is open", async () => {
	const canvas = await loadRail();
	await openVariant(canvas);
	press(canvas, "m", {}, withClass(canvas.document.getElementById("gd-variant-chips"), "gd-suggestion")[0]);
	assert.equal(miniPanel(canvas).hidden, false);
});

test("T2/S3: without delivery.variant the menu item is disabled and explained like Implement this", async () => {
	const canvas = await loadRail(300, {}, { delivery: { comment: true, batch: true, implement: true, variant: false } });
	openMenu(canvas, 0);
	const item = itemNamed(canvas, "Try another direction from this…");
	assert.equal(item.getAttribute("aria-disabled"), "true");
	assert.ok(item.title.includes("variant-unavailable"));
	const note = withClass(item, "gd-menu-note")[0];
	assert.match(note.textContent, /not connected to a Pi session/);
	assert.match(note.title, /\/gentle:design open/);
	assert.equal(item.getAttribute("aria-describedby"), note.id);
	assert.ok(menuItems(canvas).includes(item), "still in the menu, still reachable with the arrows");
	item.dispatch("click");
	keyOn(item, "Enter");
	assert.equal(dialogEl(canvas).hasAttribute("open"), false, "it opens nothing");
	assert.equal(canvas.posts.length, 0);
	// The other actions are not affected.
	assert.equal(itemNamed(canvas, "Implement this").getAttribute("aria-disabled"), null);
	assert.equal(itemNamed(canvas, "Export as PNG").getAttribute("aria-disabled"), null);
});

test("T2/S3: without delivery.implement the menu's Implement this is disabled and explained too", async () => {
	const canvas = await loadRail(300, {}, { delivery: { comment: true, batch: true, implement: false, variant: true } });
	openMenu(canvas, 0);
	const item = itemNamed(canvas, "Implement this");
	assert.equal(item.getAttribute("aria-disabled"), "true");
	assert.match(withClass(item, "gd-menu-note")[0].textContent, /not connected to a Pi session/);
	item.dispatch("click");
	assert.equal(withClass(withClass(boardsOf(canvas)[0], "gd-implement")[0], "gd-implement-confirm")[0].hidden, true);
	assert.equal(itemNamed(canvas, "Try another direction from this…").getAttribute("aria-disabled"), null);
});

test("T2/S3: a page config without variant leaves the action available", async () => {
	const canvas = await loadRail(300, {}, { delivery: { comment: true, batch: true, implement: true } });
	openMenu(canvas, 0);
	assert.equal(itemNamed(canvas, "Try another direction from this…").getAttribute("aria-disabled"), null);
});

test("T2/S3: the placeholder goes when the manifest changes, and only one is shown", async () => {
	const canvas = await loadRail();
	canvas.replies[VARIANT_URL] = { ok: true, slug: "alpha", file: "01-a.html", queued: false };
	for (let round = 0; round < 2; round++) {
		await openVariant(canvas, round);
		variantField(canvas).value = "Bolder";
		await submitVariant(canvas);
	}
	assert.equal(withClass(canvas.world, "gd-placeholder").length, 1, "a second request reuses the one placeholder");
	assert.equal(canvas.world.children.length, 3);
	(canvas.replies["/t/api/designs/alpha"] as { artboards: unknown[] }).artboards.push({ file: "03-c.html", title: "Third", tradeoff: "", width: 400, height: 300 });
	await canvas.serverEvent("change", { slug: "alpha", file: "design.json" });
	assert.equal(withClass(canvas.world, "gd-placeholder").length, 0, "the new artboard replaces it");
	assert.equal(canvas.world.children.length, 3);
	assert.equal(withClass(canvas.world.children[2], "gd-menu-button").length, 1, "the new artboard is a real one");

	// A placeholder also goes with any other manifest reload (a show event, a change of design).
	await openVariant(canvas, 0);
	variantField(canvas).value = "Bolder";
	await submitVariant(canvas);
	assert.equal(withClass(canvas.world, "gd-placeholder").length, 1);
	await canvas.serverEvent("show", { slug: "alpha" });
	assert.equal(withClass(canvas.world, "gd-placeholder").length, 0);
});

test("T2/S3: a placeholder is not added when the design changed while the request was in flight", async () => {
	const canvas = await loadRail();
	await openVariant(canvas);
	variantField(canvas).value = "Bolder";
	canvas.replies[VARIANT_URL] = { ok: true, slug: "alpha", file: "01-a.html", queued: false };
	const form = canvas.document.getElementById("gd-variant-form");
	form.dispatch("submit");
	canvas.document.getElementById("gd-design").value = "beta";
	canvas.document.getElementById("gd-design").dispatch("change");
	for (let i = 0; i < 12; i++) await flush();
	assert.equal(withClass(canvas.world, "gd-placeholder").length, 0);
});

test("T2/S3: the minimap draws the placeholder as the dashed block and drops it with the placeholder", async () => {
	const canvas = await minimapCanvas();
	canvas.replies[VARIANT_URL] = { ok: true, slug: "alpha", file: "02-b.html", queued: false };
	await openVariant(canvas, 2);
	variantField(canvas).value = "Bolder";
	await submitVariant(canvas);
	assert.equal(canvas.world.children.length, 4);
	layoutWorld(canvas, [...MINI_RECTS, [1960, 100, 440, 300]]);
	canvas.windowEvent("resize");
	const blocks = miniBlocks(canvas);
	assert.equal(blocks.length, 4);
	assert.ok(blocks[3].classes.has("gd-minimap-placeholder"));
	assert.ok(blocks.slice(0, 3).every((block) => !block.classes.has("gd-minimap-placeholder")));
	(canvas.replies["/t/api/designs/alpha"] as { artboards: unknown[] }).artboards.push({ file: "03-c.html", title: "Third", tradeoff: "", width: 400, height: 300 });
	await canvas.serverEvent("change", { slug: "alpha", file: "design.json" });
	layoutWorld(canvas, [...MINI_RECTS, [1960, 100, 400, 300]]);
	canvas.windowEvent("resize");
	assert.equal(miniBlocks(canvas).length, 4);
	assert.ok(miniBlocks(canvas).every((block) => !block.classes.has("gd-minimap-placeholder")), "no dashed block once the manifest has the artboard");
});

test("T2/S2/S3: index.html carries the menu and the dialog with their names, field and actions", () => {
	const html = read("index.html");
	assert.match(html, /<div id="gd-menu" class="gd-menu" role="menu" hidden><\/div>/);
	assert.match(html, /<div id="gd-variant-chips" class="gd-suggestions" role="group" aria-label="Suggestions" data-i18n-aria-label="variant.suggestions"><\/div>/);
	const dialog = html.match(/<dialog id="gd-variant"[^>]*>[^]*?<\/dialog>/)![0];
	assert.match(dialog, /^<dialog id="gd-variant" class="gd-dialog gd-variant" aria-labelledby="gd-variant-title">/);
	assert.match(dialog, /<h2 id="gd-variant-title"[^>]*>[^]*Another direction from<\/span> <strong id="gd-variant-source"><\/strong><\/h2>/);
	assert.match(dialog, /<label[^>]*for="gd-variant-text"[^>]*>What should change\?<\/label>/);
	assert.match(dialog, /<textarea id="gd-variant-text"[^>]*maxlength="2000"[^>]*aria-describedby="[^"]*gd-variant-message[^"]*"/);
	assert.match(dialog, /id="gd-variant-message"[^>]*role="status"/);
	assert.match(dialog, /<button type="button" id="gd-variant-cancel"[^>]*>Cancel<\/button>/);
	assert.match(dialog, /<button type="submit" id="gd-variant-send" class="gd-primary"[^>]*>[^]*Send to the session<\/span><\/button>/);
	assert.ok(html.indexOf('id="gd-variant"') > html.indexOf('id="gd-shortcuts"') || html.indexOf('id="gd-variant"') > 0);
	for (const icon of ["i-more", "i-sparkles"]) assert.match(html, new RegExp(`<symbol id="${icon}"`));
});

test("T2/S2/S3: canvas.css styles the menu, the dialog and the placeholder with tokens only, focus rings and no motion", () => {
	const css = read("canvas.css");
	const block = (selector: string) => {
		const start = css.indexOf(`${selector} {`);
		assert.ok(start >= 0, `${selector} is styled`);
		return css.slice(start, css.indexOf("}", start) + 1);
	};
	for (const selector of [".gd-menu", ".gd-menu-item", ".gd-menu-note", ".gd-menu-separator", ".gd-menu-button", ".gd-variant-field", ".gd-suggestions", ".gd-suggestion", ".gd-placeholder-frame", ".gd-placeholder-state"]) {
		const text = block(selector);
		assert.ok(!/#[0-9a-fA-F]{3,8}\b|rgba?\(/.test(text), `${selector}: tokens only`);
		assert.ok(!/transition|animation/.test(text), `${selector}: no motion`);
	}
	assert.match(block(".gd-menu"), /position:\s*fixed/);
	assert.match(block(".gd-menu"), /background:\s*var\(--surface\)/);
	assert.match(block(".gd-menu-item"), /min-height:\s*(3[4-9]|[4-9]\d)px/, "a comfortable target");
	assert.match(css, /\.gd-menu-item:focus-visible[^{]*{[^}]*outline:\s*2px solid var\(--accent\)/);
	assert.match(css, /\.gd-menu-item\[aria-disabled="true"\][^{]*{[^}]*cursor:\s*not-allowed/);
	assert.match(css, /\.gd-menu-button:focus-visible[^{]*{[^}]*outline:\s*2px solid var\(--accent\)/);
	assert.match(css, /\.gd-suggestion:focus-visible[^{]*{[^}]*outline:\s*2px solid var\(--accent\)/);
	assert.match(block(".gd-placeholder-frame"), /dashed var\(--accent\)|1px solid var\(--accent-line\)/);
});

// ---- Language (canvas-language T1): one catalog, English and Spanish, a switch in the top bar ----

const LANG_KEY = "gentle-design:language";

type LangOptions = { browser?: string | string[]; stored?: string | null; replies?: Record<string, unknown>; config?: Record<string, unknown>; extra?: Record<string, unknown>; script?: string };

/** The canvas with index.html's static text hydrated, a browser language and a stored choice; `saved()` lists what it wrote. */
async function loadLang(options: LangOptions = {}) {
	const writes: Array<[string, string]> = [];
	const { browser } = options;
	const navigator = browser === undefined ? undefined : Array.isArray(browser) ? { language: browser[0], languages: browser } : { language: browser, languages: [browser] };
	const context = {
		...(navigator ? { navigator } : {}),
		localStorage: { getItem: (key: string) => (key === LANG_KEY ? options.stored ?? null : null), setItem: (key: string, value: string) => { writes.push([key, value]); } },
		...options.extra,
	};
	const canvas = await loadCanvas(300, options.replies ?? {}, options.config ?? {}, context, { hydrate: true, script: options.script });
	canvas.document.getElementById("gd-popover").hidden = true;
	return { ...canvas, saved: () => writes.filter(([key]) => key === LANG_KEY) };
}
type LangCanvas = Awaited<ReturnType<typeof loadLang>>;

const langButton = (canvas: LangCanvas) => canvas.document.getElementById("gd-lang");
const langMenu = (canvas: LangCanvas) => canvas.document.getElementById("gd-lang-menu");
const langItems = (canvas: LangCanvas) => findAll(langMenu(canvas), (element) => element.getAttribute("role") === "menuitemradio");
const langItem = (canvas: LangCanvas, code: string) => langItems(canvas).find((item) => item.dataset.lang === code)!;
const chooseLang = (canvas: LangCanvas, code: string) => {
	langButton(canvas).dispatch("click");
	langItem(canvas, code).dispatch("click");
};
const htmlLang = (canvas: LangCanvas) => (canvas.document.documentElement as unknown as { lang: string }).lang;
const staticText = (canvas: LangCanvas) => canvas.document.querySelectorAll("[data-i18n]").map((element) => element.textContent);
const modeChip = (canvas: LangCanvas) => canvas.document.getElementById("gd-nav-mode").textContent;

test("S1: the language starts from the browser: es* is Spanish, anything else (or nothing) is English, and <html lang> follows", async () => {
	const cases: Array<[string | string[] | undefined, string, string]> = [
		["es", "es", "Navegando"], ["es-MX", "es", "Navegando"], ["ES-ar", "es", "Navegando"], [["es-ES", "en"], "es", "Navegando"],
		["en-US", "en", "Navigating"], ["fr-FR", "en", "Navigating"], ["", "en", "Navigating"], [["en-US", "es"], "en", "Navigating"], [undefined, "en", "Navigating"],
	];
	for (const [browser, lang, chip] of cases) {
		const canvas = await loadLang({ browser });
		assert.equal(htmlLang(canvas), lang, JSON.stringify(browser));
		assert.equal(modeChip(canvas), chip, JSON.stringify(browser));
		assert.equal(canvas.document.getElementById("gd-lang-code").textContent, lang.toUpperCase());
		assert.deepEqual(canvas.saved(), [], "reading the default never writes the choice");
	}
});

test("S1: a stored choice beats the browser; auto, an unknown value and unreadable storage follow the browser", async () => {
	assert.equal(htmlLang(await loadLang({ browser: "en-US", stored: "es" })), "es");
	assert.equal(htmlLang(await loadLang({ browser: "es-ES", stored: "en" })), "en");
	assert.equal(htmlLang(await loadLang({ browser: "es-ES", stored: "auto" })), "es");
	assert.equal(htmlLang(await loadLang({ browser: "en-US", stored: "auto" })), "en");
	assert.equal(htmlLang(await loadLang({ browser: "es-ES", stored: "klingon" })), "es");
	const broken = await loadLang({ browser: "es-ES", extra: { localStorage: { getItem() { throw new Error("denied"); }, setItem() { throw new Error("denied"); } } } });
	assert.equal(htmlLang(broken), "es", "storage that throws is ignored");
	chooseLang(broken, "en");
	assert.equal(htmlLang(broken), "en", "and the choice still applies for this page");
});

test("S1: the top bar has a globe button with the code that opens a menu of three radio items, the current choice checked", async () => {
	const english = await loadLang({ browser: "en-US" });
	const button = langButton(english);
	assert.equal(button.getAttribute("aria-haspopup"), "menu");
	assert.equal(button.getAttribute("aria-expanded"), "false");
	assert.equal(button.getAttribute("aria-controls"), "gd-lang-menu");
	assert.equal(button.title, "Language / Idioma");
	assert.match(button.getAttribute("aria-label")!, /EN/);
	assert.equal(langMenu(english).hidden, true);
	assert.equal(langMenu(english).getAttribute("role"), "menu");
	button.dispatch("click");
	assert.equal(langMenu(english).hidden, false);
	assert.equal(button.getAttribute("aria-expanded"), "true");
	assert.deepEqual(langItems(english).map((item) => [item.dataset.lang, texts(item, "gd-menu-label")[0], item.getAttribute("aria-checked")]), [["es", "Español", "false"], ["en", "English", "false"], ["auto", "Match the browser", "true"]]);
	assert.match(allText(langMenu(english)), /messages to the agent stay in English/);

	const spanish = await loadLang({ browser: "es-ES", stored: "es" });
	langButton(spanish).dispatch("click");
	assert.deepEqual(langItems(spanish).map((item) => [texts(item, "gd-menu-label")[0], item.getAttribute("aria-checked")]), [["Español", "true"], ["English", "false"], ["Igual que el navegador", "false"]]);
	assert.match(allText(langMenu(spanish)), /mensajes al agente siguen en inglés/);
	assert.match(langButton(spanish).getAttribute("aria-label")!, /ES/);
});

test("S1/S2: choosing a language applies at once, saves the choice and leaves the artboards loaded as they were", async () => {
	const canvas = await loadLang({ browser: "en-US" });
	const frames = canvas.frames();
	const sources = frames.map((frame) => frame.src);
	assert.equal(canvas.document.getElementById("gd-back").textContent, "Back to canvas");
	chooseLang(canvas, "es");
	assert.equal(htmlLang(canvas), "es");
	assert.equal(modeChip(canvas), "Navegando");
	assert.equal(canvas.document.getElementById("gd-lang-code").textContent, "ES");
	assert.equal(canvas.document.getElementById("gd-back").textContent, "Volver al canvas");
	assert.equal(canvas.document.getElementById("gd-back").title, "Volver al canvas (Shift+Esc)");
	assert.equal(canvas.document.getElementById("gd-panel-toggle").title, "Panel de revisión (])");
	assert.equal(canvas.document.getElementById("gd-zoom-out").getAttribute("aria-label"), "Alejar");
	assert.equal(canvas.document.getElementById("gd-send-all").textContent, "Enviar todo (0)");
	assert.equal(canvas.document.getElementById("gd-nav-title").textContent, "Propuestas · 2");
	assert.ok(staticText(canvas).includes("Mostrar u ocultar el minimapa"), "the shortcuts dialog follows");
	assert.deepEqual(canvas.saved(), [[LANG_KEY, "es"]]);
	assert.deepEqual(canvas.frames(), frames, "the same iframes");
	assert.deepEqual(canvas.frames().map((frame) => frame.src), sources, "none of them reloaded");
	assert.equal(langMenu(canvas).hidden, true, "choosing closes the menu");
	assert.ok(canvas.document.activeElement === langButton(canvas), "and returns focus to the button");

	chooseLang(canvas, "en");
	assert.equal(htmlLang(canvas), "en");
	assert.equal(modeChip(canvas), "Navigating");
	assert.equal(canvas.document.getElementById("gd-back").textContent, "Back to canvas");
	assert.equal(canvas.document.getElementById("gd-lang-code").textContent, "EN");
	assert.deepEqual(canvas.saved(), [[LANG_KEY, "es"], [LANG_KEY, "en"]]);
});

test("S1: Match the browser saves auto and resolves the browser's language again", async () => {
	const canvas = await loadLang({ browser: "es-ES", stored: "en" });
	assert.equal(htmlLang(canvas), "en");
	langButton(canvas).dispatch("click");
	assert.equal(langItem(canvas, "en").getAttribute("aria-checked"), "true");
	langItem(canvas, "auto").dispatch("click");
	assert.equal(htmlLang(canvas), "es");
	assert.deepEqual(canvas.saved(), [[LANG_KEY, "auto"]]);
	langButton(canvas).dispatch("click");
	assert.equal(langItem(canvas, "auto").getAttribute("aria-checked"), "true");
	assert.equal(langItem(canvas, "es").getAttribute("aria-checked"), "false", "the choice is auto, not the language it resolved to");
});

test("S1: the language menu opens with the arrows, moves with the arrows, Home and End, and closes with Escape, Tab or a click outside", async () => {
	const canvas = await loadLang({ browser: "en-US" });
	const button = langButton(canvas);
	const down = keyOn(button, "ArrowDown");
	assert.equal(down.defaultPrevented, true);
	assert.equal(langMenu(canvas).hidden, false);
	const items = langItems(canvas);
	assert.ok(canvas.document.activeElement === items[0], "ArrowDown opens on the first item");
	assert.equal(keyOn(button, "Escape").defaultPrevented, true);
	assert.equal(langMenu(canvas).hidden, true);
	assert.equal(button.getAttribute("aria-expanded"), "false");
	keyOn(button, "ArrowUp");
	const last = langItems(canvas);
	assert.ok(canvas.document.activeElement === last[last.length - 1], "ArrowUp opens on the last item");

	const at = () => last.findIndex((item) => item === canvas.document.activeElement);
	keyOn(last[at()], "ArrowDown");
	assert.equal(at(), 0, "ArrowDown wraps to the first");
	keyOn(last[at()], "ArrowUp");
	assert.equal(at(), 2, "ArrowUp wraps to the last");
	keyOn(last[at()], "Home");
	assert.equal(at(), 0);
	keyOn(last[at()], "End");
	assert.equal(at(), 2);
	assert.equal(langMenu(canvas).hidden, false, "moving never closes it");

	const escape = keyOn(last[1], "Escape");
	assert.equal(escape.defaultPrevented, true);
	assert.equal(langMenu(canvas).hidden, true);
	assert.ok(canvas.document.activeElement === button, "Esc returns focus to the button");

	button.dispatch("click");
	const tab = keyOn(langItems(canvas)[0], "Tab");
	assert.equal(tab.defaultPrevented, false, "Tab keeps its move");
	assert.equal(langMenu(canvas).hidden, true);

	button.dispatch("click");
	const pointerdown = (target: FakeElement) => (canvas.document.listeners.get("pointerdown") ?? []).forEach((listener) => listener({ target, button: 0 }));
	pointerdown(langMenu(canvas));
	pointerdown(langItems(canvas)[0]);
	assert.equal(langMenu(canvas).hidden, false, "a press inside does not close it");
	pointerdown(button);
	assert.equal(langMenu(canvas).hidden, false, "the button toggles on its own click");
	pointerdown(canvas.viewport);
	assert.equal(langMenu(canvas).hidden, true, "a press outside closes it");
	button.dispatch("click");
	button.dispatch("click");
	assert.equal(langMenu(canvas).hidden, true, "the button closes it again");
});

test("S1: Enter and Space choose the focused item; single-key shortcuts stay off while the menu is open", async () => {
	for (const key of ["Enter", " "]) {
		const canvas = await loadLang({ browser: "en-US" });
		langButton(canvas).dispatch("click");
		const chosen = keyOn(langItem(canvas, "es"), key);
		assert.equal(chosen.defaultPrevented, true, key);
		assert.equal(htmlLang(canvas), "es", key);
		assert.equal(langMenu(canvas).hidden, true, key);
		assert.deepEqual(canvas.saved(), [[LANG_KEY, "es"]], key);
	}
	const canvas = await loadLang({ browser: "en-US" });
	langButton(canvas).dispatch("click");
	const before = pressed(canvas as unknown as Canvas, "gd-comment");
	press(canvas as unknown as Canvas, "c", {}, langItems(canvas)[0]);
	assert.equal(pressed(canvas as unknown as Canvas, "gd-comment"), before, "C did nothing");
	keyOn(langItems(canvas)[0], "Escape");
	press(canvas as unknown as Canvas, "c");
	assert.equal(pressed(canvas as unknown as Canvas, "gd-comment"), "true", "back to normal after it closes");
});

test("S1: opening the artboard menu closes the language menu, and the other way around", async () => {
	const canvas = await loadLang({ browser: "en-US" });
	langButton(canvas).dispatch("click");
	menuButtonOf(boardsOf(canvas)[0]).dispatch("click");
	assert.equal(langMenu(canvas).hidden, true);
	assert.equal(langButton(canvas).getAttribute("aria-expanded"), "false");
	assert.equal(menuEl(canvas as unknown as Canvas).hidden, false);
	langButton(canvas).dispatch("click");
	assert.equal(menuEl(canvas as unknown as Canvas).hidden, true);
	assert.equal(langMenu(canvas).hidden, false);
});

const withOpen = (id: string, extra: Record<string, unknown> = {}) => comment(id, "01-a.html", "open", extra);

test("S2: the navigator, tabs, cards and Send all speak Spanish with plural counts, and English by default", async () => {
	const replies = {
		...commentsDoc(withOpen("c1"), withOpen("c2", { sentAt: "2026-10-26T10:00:00.000Z" }), comment("c3", "01-a.html", "resolved"), comment("c4", "02-b.html")),
		"/t/api/designs/alpha/handoffs": handoffDoc("01-a.html", { "01-a.html": { status: "in_progress", startedAt: stamp(9, 5), sentAt: stamp(9, 1) } }),
	};
	const spanish = await loadLang({ browser: "es", replies });
	const summaries = withClass(spanish.document.getElementById("gd-nav-list"), "gd-nav-summary").map((element) => element.textContent);
	assert.deepEqual(summaries, ["2 comentarios abiertos · 1 resuelto", "1 comentario abierto"]);
	assert.deepEqual(withClass(spanish.document.getElementById("gd-nav-list"), "gd-nav-tag").map((element) => element.textContent), ["Elegido", "Descartada"]);
	assert.equal(spanish.document.getElementById("gd-send-all").textContent, "Enviar todo (2)", "c1 and c4 are open and unsent");
	const badges = withClass(spanish.document.getElementById("gd-comment-list"), "gd-badge").map((element) => element.textContent);
	assert.deepEqual(badges.slice(0, 2), ["Esperando", "Enviado"]);
	assert.deepEqual(withClass(spanish.document.getElementById("gd-comment-list"), "gd-comment-toggle").map((element) => [element.textContent, element.getAttribute("aria-label")]).slice(0, 1), [["Resolver", "Resolver comentario 1"]]);
	assert.deepEqual(withClass(boardsOf(spanish)[0], "gd-handoff-badge").map((element) => element.textContent), ["En curso"]);
	assert.deepEqual(texts(spanish.document.getElementById("gd-timeline"), "gd-step-label"), ["Elegido", "Enviado a la sesión", "En curso", "Implementado"]);
	assert.equal(spanish.document.getElementById("gd-handoff-title").textContent, "Handoff · First");
	spanish.document.getElementById("gd-filter-resolved").dispatch("click");
	assert.equal(withClass(spanish.document.getElementById("gd-comment-list"), "gd-comment-toggle")[0].textContent, "Reabrir");

	const english = await loadLang({ browser: "en", replies });
	assert.deepEqual(withClass(english.document.getElementById("gd-nav-list"), "gd-nav-summary").map((element) => element.textContent), ["2 open comments · 1 resolved", "1 open comment"]);
	assert.equal(english.document.getElementById("gd-send-all").textContent, "Send all (2)");

	// A comment-less artboard reads "Sin comentarios", and Resolved empty says so.
	const empty = await loadLang({ browser: "es" });
	assert.deepEqual(withClass(empty.document.getElementById("gd-nav-list"), "gd-nav-summary").map((element) => element.textContent), ["Sin comentarios", "Sin comentarios"]);
	assert.equal(empty.document.getElementById("gd-panel-empty").textContent, "Aún no hay comentarios. Activa el modo Comentar y haz clic en un elemento.");
});

test("S2: switching language re-renders what is already on screen: lists, badges, the timeline and the chip, without a reload", async () => {
	const replies = {
		...commentsDoc(withOpen("c1"), comment("c3", "01-a.html", "resolved")),
		"/t/api/designs/alpha/handoffs": handoffDoc("01-a.html", { "01-a.html": { status: "implemented", implementedAt: stamp(9, 9), startedAt: stamp(9, 5), sentAt: stamp(9, 1), previewUrl: "http://localhost:3000/" } }),
	};
	const canvas = await loadLang({ browser: "en", replies });
	const summary = () => withClass(canvas.document.getElementById("gd-nav-list"), "gd-nav-summary")[0].textContent;
	assert.equal(summary(), "1 open comment · 1 resolved");
	assert.deepEqual(withClass(boardsOf(canvas)[0], "gd-handoff-badge").map((element) => element.textContent), ["Implemented ✓"]);
	canvas.document.getElementById("gd-comment").dispatch("click");
	assert.equal(modeChip(canvas), COMMENT_CHIP);
	chooseLang(canvas, "es");
	assert.equal(summary(), "1 comentario abierto · 1 resuelto");
	assert.deepEqual(withClass(boardsOf(canvas)[0], "gd-handoff-badge").map((element) => element.textContent), ["Implementado ✓"]);
	assert.equal(withClass(boardsOf(canvas)[0], "gd-compare-start")[0].textContent, "Comparar");
	assert.equal(modeChip(canvas), "Haz clic en una propuesta para abrirla y comentar · Esc");
	assert.equal(canvas.document.getElementById("gd-comment-list").children[0].children[0].children[0].children[2]?.textContent ?? "Esperando", "Esperando");
	canvas.document.getElementById("gd-tool-navigate").dispatch("click");
	click(canvas.boards[0].shield!, 200, 200);
	assert.equal(modeChip(canvas), "Usando: First · Shift+Esc para salir");
	chooseLang(canvas, "en");
	assert.equal(modeChip(canvas), "Using: First · Shift+Esc to exit");
});

test("S2: dates use Today/Hoy and the month names of the language, with the year only when it differs", async () => {
	const now = new Date();
	const sentAt = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 9, 5).toISOString();
	const replies = {
		"/t/api/designs/alpha/handoffs": handoffDoc("01-a.html", { "01-a.html": { status: "in_progress", sentAt, startedAt: stamp(9, 6) } }),
		[HISTORY_URL]: HISTORY,
	};
	const spanish = await loadLang({ browser: "es", replies });
	const details = () => texts(spanish.document.getElementById("gd-timeline"), "gd-step-detail");
	assert.deepEqual(details().slice(0, 2), ["Hoy 09:05", "4 mar 2020, 09:06"]);
	chooseLang(spanish, "en");
	assert.deepEqual(details().slice(0, 2), ["Today 09:05", "Mar 4 2020, 09:06"]);
	chooseLang(spanish, "es");
	spanish.document.getElementById("gd-tab-history").dispatch("click");
	const meta = texts(spanish.document.getElementById("gd-history"), "gd-version-meta");
	assert.deepEqual(meta, ["Tú · 4 mar 2020, 09:04", "Restauración · 4 mar 2020, 09:03", "Agente · 4 mar 2020, 09:02", "Tú · 4 mar 2020, 09:01"]);
});

test("S2: history cards, tags and buttons are Spanish, and restoring asks in Spanish", async () => {
	const canvas = await loadLang({ browser: "es", replies: { [HISTORY_URL]: HISTORY, ...commentsDoc(comment("a1", "01-a.html", "resolved")) } });
	canvas.document.getElementById("gd-tab-history").dispatch("click");
	const panel = canvas.document.getElementById("gd-history");
	assert.deepEqual(texts(panel, "gd-version-tag"), ["Actual", "Original"]);
	assert.deepEqual(texts(panel, "gd-version-applied"), ["Aplicado #1"]);
	assert.deepEqual(texts(panel, "gd-version-reply-label"), ["Agente:"]);
	const labels = withClass(panel, "gd-version-actions")[1].children.map((button) => [allText(button), button.getAttribute("aria-label")]);
	assert.deepEqual(labels, [["Comparar con la actual", "Comparar v3 con la versión actual"], ["Restaurar", "Restaurar v3"]]);
	assert.match(allText(panel), /Las versiones se guardan en design\/alpha\/\.history\/; Restaurar guarda antes la actual, así que no se pierde nada\./);
	withClass(panel, "gd-version-restore")[0].dispatch("click");
	assert.match(texts(panel, "gd-version-confirm-text")[0], /^¿Restaurar v3\? La versión actual se guarda antes, así que no se pierde nada\.$/);
});

test("S2: failures speak Spanish with their cause and way out, keep the raw code, and follow the language while shown", async () => {
	const replies = {
		...commentsDoc(withOpen("c1")),
		"/t/api/designs/alpha/comments/send-all": { __http: 500, error: "delivery-failed" },
	};
	const canvas = await loadLang({ browser: "es", replies });
	canvas.document.getElementById("gd-send-all").dispatch("click");
	for (let i = 0; i < 6; i++) await flush();
	const alert = canvas.document.getElementById("gd-send-alert");
	assert.equal(alert.hidden, false);
	assert.equal(canvas.document.getElementById("gd-send-alert-text").textContent, "La sesión no aceptó el mensaje. Tus comentarios quedan guardados y sin enviar; comprueba que la sesión esté en marcha y vuelve a intentarlo.");
	assert.equal(canvas.document.getElementById("gd-send-alert-detail").textContent, "delivery-failed", "the code is never translated");
	chooseLang(canvas, "en");
	assert.match(canvas.document.getElementById("gd-send-alert-text").textContent, /^The session did not accept the message\./);
	assert.equal(canvas.document.getElementById("gd-send-alert-detail").textContent, "delivery-failed");

	// A success is a Spanish toast with its plural.
	canvas.replies["/t/api/designs/alpha/comments/send-all"] = { sent: 2 };
	chooseLang(canvas, "es");
	canvas.document.getElementById("gd-send-all").dispatch("click");
	for (let i = 0; i < 6; i++) await flush();
	assert.equal(canvas.document.getElementById("gd-toast").textContent, "Se enviaron 2 comentarios a la sesión");
	// A network failure and an unknown code have sentences too.
	canvas.replies["/t/api/designs/alpha/comments/send-all"] = { __throw: "offline" };
	canvas.document.getElementById("gd-send-all").dispatch("click");
	for (let i = 0; i < 6; i++) await flush();
	assert.match(canvas.document.getElementById("gd-send-alert-text").textContent, /^El canvas no pudo conectar con su servidor/);
	assert.equal(canvas.document.getElementById("gd-send-alert-detail").textContent, "network: offline");
});

test("S2: empty states and status lines are Spanish, and the status follows a switch", async () => {
	const none = await loadLang({ browser: "es", config: { slug: null }, replies: { "/t/api/designs": { designs: [] } } });
	assert.equal(none.document.getElementById("gd-empty").textContent, "Aún no hay diseños. Ejecuta /gentle:design con una petición para crear uno.");
	chooseLang(none, "en");
	assert.equal(none.document.getElementById("gd-empty").textContent, "No designs yet. Run /gentle:design with a brief to create one.");

	const broken = await loadLang({ browser: "es", replies: { "/t/api/designs/alpha": { __http: 500, reason: "boom" } } });
	assert.equal(broken.document.getElementById("gd-empty").textContent, "No se puede mostrar el diseño «alpha»: boom");
	assert.equal(broken.document.getElementById("gd-status").textContent, "design.json de alpha no es válido");
	chooseLang(broken, "en");
	assert.equal(broken.document.getElementById("gd-status").textContent, "design.json for alpha is invalid");
	assert.equal(broken.document.getElementById("gd-empty").textContent, 'Design "alpha" cannot be shown: boom');

	const brief = await loadLang({ browser: "es", replies: { "/t/api/designs/alpha": { slug: "alpha", title: "Alpha", brief: "", artboards: [] } } });
	assert.equal(brief.document.getElementById("gd-brief-text").textContent, "Aún no se ha escrito la petición original.");
});

test("S2: the focused artboard's size control, the artboard header and the mode chip are Spanish", async () => {
	const canvas = await loadLang({ browser: "es" });
	const [first] = canvas.boards;
	assert.equal(withClass(first.wrapper, "gd-implement-start")[0].textContent, "Implementar esto");
	assert.equal(withClass(first.wrapper, "gd-implement-start")[0].getAttribute("aria-label"), "Implementar First en el proyecto");
	assert.equal(first.shield!.getAttribute("aria-label"), "Usar First");
	assert.equal(withClass(first.wrapper, "gd-shield-hint")[0].textContent, "Haz clic para usar este diseño");
	assert.equal(menuButtonOf(first.wrapper).getAttribute("aria-label"), "Más acciones de First");
	assert.equal(first.frame.title, "Artboard First");
	click(first.shield!, 200, 200);
	assert.deepEqual(texts(first.wrapper, "gd-size-label"), ["Móvil", "Tablet", "Escritorio", "Todos los tamaños"]);
	assert.equal(texts(first.wrapper, "gd-size-custom-label")[0], "Personalizado");
	assert.equal(withClass(first.wrapper, "gd-size-readout")[0].textContent, "400 × 300");
	const buttons = withClass(first.wrapper, "gd-size-button");
	assert.equal(buttons[0].title, "Móvil 390 × 844");
	buttons[3].dispatch("click");
	assert.equal(withClass(first.wrapper, "gd-size-readout")[0].textContent, "Todos los tamaños");
	assert.equal(canvas.document.getElementById("gd-nav-mode").textContent, "Usando: First · Shift+Esc para salir");
	chooseLang(canvas, "en");
	assert.equal(withClass(first.wrapper, "gd-size-readout")[0].textContent, "All sizes");
	assert.equal(first.frame.title, "First artboard");
	assert.deepEqual(texts(first.wrapper, "gd-size-label"), ["Phone", "Tablet", "Desktop", "All sizes"]);
	assert.equal(first.shield!.getAttribute("aria-label"), "Use First");
});

test("S2: the artboard menu, the variant dialog and its suggestions are Spanish", async () => {
	const canvas = await loadLang({ browser: "es" });
	const button = menuButtonOf(boardsOf(canvas)[0]);
	button.dispatch("click");
	assert.deepEqual(itemLabels(canvas as unknown as Canvas), ["Probar otra dirección a partir de esta…", "Exportar como PNG", "Exportar como PNG a 2×", "Exportar como PDF", "Descargar HTML", "Implementar esto"]);
	assert.equal(menuEl(canvas as unknown as Canvas).getAttribute("aria-label"), "Acciones de First");
	itemNamed(canvas as unknown as Canvas, "Probar otra dirección a partir de esta…").dispatch("click");
	assert.equal(canvas.document.getElementById("gd-variant-note").textContent, "La sesión escribe un nuevo artboard, 03, y conserva los demás.");
	const chips = withClass(canvas.document.getElementById("gd-variant-chips"), "gd-suggestion");
	assert.deepEqual(chips.map((chip) => chip.textContent), ["Más compacto", "Más atrevido", "Primero móvil", "Colores más calmados"]);
	chips[0].dispatch("click");
	assert.equal(variantField(canvas as unknown as Canvas).value, "Más compacto", "a chip fills the field with its own label");
	variantField(canvas as unknown as Canvas).value = "";
	await submitVariant(canvas as unknown as Canvas);
	assert.equal(variantMessage(canvas as unknown as Canvas).textContent, "Escribe de 1 a 2000 caracteres sobre lo que debería cambiar.");
	// The raw dialog-level message of an unavailable session is explained in Spanish too.
	const offline = await loadLang({ browser: "es", config: { delivery: { variant: false, implement: false, batch: false } } });
	menuButtonOf(boardsOf(offline)[0]).dispatch("click");
	const item = menuItems(offline as unknown as Canvas)[0];
	assert.equal(texts(item, "gd-menu-note")[0], "El canvas no está conectado a una sesión de Pi.");
	assert.match(item.getAttribute("aria-describedby") ? allText(withClass(item, "gd-menu-note")[0]) : "", /Este canvas no está conectado a una sesión de Pi, así que no puede pedir otra dirección\./);
	assert.match(offline.document.getElementById("gd-send-note").textContent, /^Este canvas no está conectado a una sesión de Pi, así que no se pueden enviar los comentarios\./);
	chooseLang(offline, "en");
	assert.match(offline.document.getElementById("gd-send-note").textContent, /^This canvas is not connected to a Pi session, so comments cannot be sent\./);
});

test("S2: the minimap, the checks and the inspector are Spanish; what is sent to the session stays English", async () => {
	const canvas = await loadLang({ browser: "es", replies: { [TOKENS_URL]: TOKEN_SET } });
	const [first] = canvas.boards;
	layoutWorld(canvas as unknown as Canvas, [[0, 0, 400, 300], [480, 0, 400, 300]]);
	canvas.windowEvent("resize");
	assert.equal(miniMap(canvas as unknown as Canvas).getAttribute("aria-label"), "Posición del área visible entre 2 propuestas. Haz clic o arrastra para mover la vista; usa la lista de propuestas con el teclado.");
	assert.equal(miniBlocks(canvas as unknown as Canvas)[0].title, "01 · First");

	report_(canvas as unknown as Canvas, first.frame, [finding(), finding({ check: "label", title: "Form field without a label", detail: 'The text field "Search" has no label. Add a <label for>, aria-label or aria-labelledby; a placeholder is not a label.', selector: "main > input", label: "input" })]);
	openChecks(canvas as unknown as Canvas);
	const panel = checksPanel(canvas as unknown as Canvas);
	assert.deepEqual(texts(panel, "gd-check-title"), ["Contraste bajo", "Campo de formulario sin etiqueta"]);
	assert.deepEqual(texts(panel, "gd-check-detail"), [
		'"or pay with card" tiene 3.1 : 1 (#999999 sobre #ffffff); WCAG AA exige 4.5 : 1.',
		'Falta etiqueta en campo de texto "Search". Añade un <label for>, aria-label o aria-labelledby; un placeholder no es una etiqueta.',
	]);
	assert.deepEqual(texts(panel, "gd-check-kind"), ["Problema", "Problema"]);
	assert.deepEqual(texts(panel, "gd-check-summary"), ["2 comprobaciones"]);
	assert.match(texts(panel, "gd-check-passed")[0], /^Superadas: Tamaño de los objetivos táctiles · Imágenes con texto alternativo · Encabezados en orden$/);
	assert.equal(withClass(panel, "gd-check-show")[0].getAttribute("aria-label"), "Mostrar Contraste bajo en p.or de 01 First");
	assert.equal(withClass(panel, "gd-check-fix")[0].getAttribute("aria-label"), "Pedir al agente que corrija Contraste bajo en p.or");
	withClass(panel, "gd-check-fix")[0].dispatch("click");
	assert.match(canvas.document.getElementById("gd-popover-text").value, /^Accessibility check on main > p\.or: Low contrast\.\n/, "the comment sent to the session stays English");
	canvas.document.getElementById("gd-popover-cancel").dispatch("click");
	chooseLang(canvas, "en");
	assert.deepEqual(texts(panel, "gd-check-title"), ["Low contrast", "Form field without a label"]);
	assert.deepEqual(texts(panel, "gd-check-summary"), ["2 checks"]);

	// The inspector panel compares in Spanish, but its Ask the agent to fix text is for the agent: English.
	chooseLang(canvas, "es");
	canvas.document.getElementById("gd-comment").dispatch("click");
	canvas.document.getElementById("gd-technical").dispatch("click");
	tallViewport(canvas as unknown as Canvas);
	first.frame.rect = { left: 100, top: 120, width: 400, height: 300 };
	inspect(canvas as unknown as Canvas, first.frame, { ...MEASURE, color: { r: 10, g: 20, b: 30, a: 1 } });
	assert.deepEqual(rowLabels(canvas as unknown as Canvas), ["Color", "Fondo", "Contraste", "Fuente", "Tamaño", "Interlineado", "Espaciado", "Radio"]);
	assert.match(rowText(canvas as unknown as Canvas, "Color")!, /sin token/);
	assert.match(rowText(canvas as unknown as Canvas, "Color")!, /Más cercano: --/);
	assert.match(rowText(canvas as unknown as Canvas, "Tamaño")!, /peso 400/);
	assert.equal(canvas.document.getElementById("gd-inspector-fix").title, "");
	canvas.document.getElementById("gd-inspector-fix").dispatch("click");
	assert.match(canvas.document.getElementById("gd-popover-text").value, /^Fix the values on main > p\.or that are off the design system/);
});

test("S2: Compare is Spanish and follows a switch while it is open", async () => {
	const canvas = await loadLang({ browser: "es", replies: { "/t/api/designs/alpha/handoffs": implementedDoc("01-a.html") } });
	withClass(boardsOf(canvas)[0], "gd-compare-start")[0].dispatch("click");
	assert.equal(canvas.document.getElementById("gd-compare-title").textContent, "Comparar: First");
	const captions = () => texts(canvas.document.getElementById("gd-compare-panes"), "gd-compare-caption");
	assert.deepEqual(captions(), ["Diseño: 01-a.html", "Implementación: http://localhost:3000/"]);
	assert.equal(canvas.document.getElementById("gd-compare-message").textContent, "Si el panel de la app se queda vacío, puede que la app no esté en marcha en http://localhost:3000 o que no permita mostrarse en un marco: arráncala o usa Abrir en una pestaña nueva.");
	canvas.document.getElementById("gd-compare-mode-slider").dispatch("click");
	assert.deepEqual(captions(), ["Diseño", "App"]);
	assert.equal(canvas.document.getElementById("gd-compare-panes").getAttribute("aria-label"), "Diseño y app en ejecución, divididos al 50%");
	chooseLang(canvas, "en");
	assert.equal(canvas.document.getElementById("gd-compare-title").textContent, "Compare: First");
	assert.deepEqual(captions(), ["Design", "App"]);
	assert.equal(canvas.document.getElementById("gd-compare-panes").getAttribute("aria-label"), "Design and running app, split at 50%");
	assert.equal(canvas.document.getElementById("gd-compare-message").textContent, "If the app pane stays empty, the app may not be running at http://localhost:3000 or may refuse to be framed: start it, or use Open in new tab.");
});

test("S2: popover messages, screenshot errors and the Send/Save label are Spanish", async () => {
	const canvas = await loadLang({ browser: "es" });
	const [first] = canvas.boards;
	canvas.document.getElementById("gd-comment").dispatch("click");
	canvas.message(first.frame.contentWindow, { type: "gd:pick", selector: "main > h1", excerpt: "Hi", rect: { x: 10, y: 10, width: 50, height: 20 } });
	assert.equal(canvas.document.getElementById("gd-popover-send").textContent, "Enviar");
	canvas.document.getElementById("gd-mode-collect").dispatch("change");
	assert.equal(canvas.document.getElementById("gd-popover-send").textContent, "Guardar");
	canvas.document.getElementById("gd-popover-form").dispatch("submit");
	assert.equal(canvas.document.getElementById("gd-popover-message").textContent, "Escribe un comentario de 1 a 2000 caracteres.");
	chooseLang(canvas, "en");
	assert.equal(canvas.document.getElementById("gd-popover-send").textContent, "Save", "the label keeps the send mode");
});

test("S3: the messages the canvas sends and what the user wrote are never translated", async () => {
	const replies = commentsDoc(withOpen("c1", { comment: "Hazlo más grande" }));
	const canvas = await loadLang({ browser: "es", replies });
	assert.equal(withClass(canvas.document.getElementById("gd-comment-list"), "gd-comment-text")[0].textContent, "Hazlo más grande");
	assert.equal(texts(boardsOf(canvas)[0], "gd-artboard-title")[0], "First");
	canvas.document.getElementById("gd-comment").dispatch("click");
	canvas.message(canvas.boards[0].frame.contentWindow, { type: "gd:pick", selector: "main > h1", excerpt: "Hi", rect: { x: 10, y: 10, width: 50, height: 20 } });
	canvas.document.getElementById("gd-popover-text").value = "Texto del usuario";
	canvas.document.getElementById("gd-popover-form").dispatch("submit");
	for (let i = 0; i < 6; i++) await flush();
	assert.deepEqual(canvas.posts.map((post) => post.body), [{ slug: "alpha", file: "01-a.html", selector: "main > h1", excerpt: "Hi", comment: "Texto del usuario", mode: "send" }]);
});

test("S4: a Spanish key that is missing falls back to the English text", async () => {
	const source = read("canvas.js");
	const line = '"nav.note": "El tablero del design system siempre va primero en Ver todo.",';
	assert.ok(source.includes(line), "the Spanish entry is on its own line");
	const canvas = await loadLang({ browser: "es", script: source.replace(line, ""), replies: SYSTEM_REPLY });
	assert.equal(canvas.document.getElementById("gd-nav-note").textContent, "Design system board is always first in Overview.");
	assert.equal(canvas.document.getElementById("gd-back").textContent, "Volver al canvas", "the other keys stay Spanish");
});

// ---- The catalog: one dictionary per language, complete, and the only source of canvas text (S4) ----

function loadCatalog(): { en: Record<string, string>; es: Record<string, string> } {
	const source = read("canvas.js");
	const start = source.indexOf("/* catalog:start */");
	const end = source.indexOf("/* catalog:end */");
	assert.ok(start >= 0 && end > start, "canvas.js marks its catalog with /* catalog:start */ and /* catalog:end */");
	return structuredCopy(vm.runInNewContext(`${source.slice(start, end)}\nCATALOG`));
}

const placeholdersOf = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();

/** canvas.js without its catalog, with comments blanked: what is left is code. */
function codeOutsideCatalog(): string {
	const source = read("canvas.js");
	const start = source.indexOf("/* catalog:start */");
	const end = source.indexOf("/* catalog:end */") + "/* catalog:end */".length;
	return blankComments(source.slice(0, start) + source.slice(end));
}

/** Blanks // and /* *​/ comments (and leaves strings alone) so a scan sees code only. */
function blankComments(source: string): string {
	let out = "";
	for (let i = 0; i < source.length; i++) {
		const char = source[i];
		if (char === '"' || char === "'" || char === "`") {
			const end = skipLiteral(source, i);
			out += source.slice(i, end + 1);
			i = end;
		} else if (char === "/" && source[i + 1] === "/") {
			const end = source.indexOf("\n", i);
			i = end < 0 ? source.length : end - 1;
		} else if (char === "/" && source[i + 1] === "*") {
			const end = source.indexOf("*/", i + 2);
			out += " ".repeat(end + 2 - i);
			i = end + 1;
		} else out += char;
	}
	return out;
}

/** The index of the closing quote of the literal that opens at `open`; template `${}` may nest literals. */
function skipLiteral(source: string, open: number): number {
	const quote = source[open];
	for (let i = open + 1; i < source.length; i++) {
		if (source[i] === "\\") i++;
		else if (source[i] === quote) return i;
		else if (quote === "`" && source[i] === "$" && source[i + 1] === "{") {
			let depth = 0;
			for (i = i + 1; i < source.length; i++) {
				if (source[i] === '"' || source[i] === "'" || source[i] === "`") i = skipLiteral(source, i);
				else if (source[i] === "{") depth++;
				else if (source[i] === "}" && --depth === 0) break;
			}
		}
	}
	throw new Error(`unterminated literal at ${open}`);
}

/** The text of every literal in `code`, with `${}` of templates cut out. `code` is scanned as code, never as text. */
function literalsIn(code: string): string[] {
	const found: string[] = [];
	for (let i = 0; i < code.length; i++) {
		const char = code[i];
		if (char !== '"' && char !== "'" && char !== "`") continue;
		const end = skipLiteral(code, i);
		let text = code.slice(i + 1, end);
		if (char === "`") {
			let cut = "";
			for (let j = 0; j < text.length; j++) {
				if (text[j] === "$" && text[j + 1] === "{") {
					const from = j + 2;
					let depth = 0;
					for (j = j + 1; j < text.length; j++) {
						if (text[j] === '"' || text[j] === "'" || text[j] === "`") j = skipLiteral(text, j);
						else if (text[j] === "{") depth++;
						else if (text[j] === "}" && --depth === 0) break;
					}
					found.push(...literalsIn(text.slice(from, j)));
					cut += "\u0000";
				} else cut += text[j];
			}
			text = cut;
		}
		found.push(text);
		i = end;
	}
	return found;
}

/** The argument texts of the call whose "(" is at `open`. */
function callArguments(code: string, open: number): string[] {
	const args: string[] = [];
	let depth = 0;
	let start = open + 1;
	for (let i = open; i < code.length; i++) {
		const char = code[i];
		if (char === '"' || char === "'" || char === "`") i = skipLiteral(code, i);
		else if ("([{".includes(char)) depth++;
		else if (")]}".includes(char)) {
			if (--depth === 0) {
				args.push(code.slice(start, i));
				return args;
			}
		} else if (char === "," && depth === 1) {
			args.push(code.slice(start, i));
			start = i + 1;
		}
	}
	throw new Error(`unterminated call at ${open}`);
}

/** `code` with the calls of the named functions blanked out: what they hold is not text the canvas shows (keys, or text for the agent). */
function withoutCalls(code: string, names: string[]): string {
	let rest = code;
	for (;;) {
		const call = new RegExp(`(?<![\\w.])(?:${names.join("|")})\\(`).exec(rest);
		if (!call) return rest;
		const open = call.index + call[0].length - 1;
		const length = callArguments(rest, open).join(",").length;
		rest = `${rest.slice(0, call.index)} ${rest.slice(open + length + 2)}`;
	}
}

/** The expression after `=` up to the end of its statement. */
function assignedExpression(code: string, from: number): string {
	let depth = 0;
	for (let i = from; i < code.length; i++) {
		const char = code[i];
		if (char === '"' || char === "'" || char === "`") i = skipLiteral(code, i);
		else if ("([{".includes(char)) depth++;
		else if (")]}".includes(char)) depth--;
		else if ((char === ";" || char === "\n") && depth === 0) return code.slice(from, i);
	}
	return code.slice(from);
}

/** Literal text that is words a person reads (not a class, a selector, a URL, a key name or a unit). */
const isHumanText = (text: string) => /[A-Za-z]{2,}/.test(text.replace(/\u0000/g, " "));

test("S4: the English and Spanish dictionaries have the same keys, the same placeholders and no empty text", () => {
	const { en, es } = loadCatalog();
	assert.deepEqual(Object.keys(es).sort(), Object.keys(en).sort(), "a key in one language and not the other");
	assert.ok(Object.keys(en).length > 250, "the whole canvas is in the catalog");
	for (const [key, text] of Object.entries(en)) {
		assert.equal(typeof text, "string", key);
		assert.ok(text.length > 0 && es[key].length > 0, `${key} is empty`);
		assert.deepEqual(placeholdersOf(es[key]), placeholdersOf(text), `${key}: the placeholders differ`);
	}
	const same = Object.keys(en).filter((key) => en[key] === es[key] && /[a-z]{4,}/i.test(en[key]));
	assert.ok(same.length < Object.keys(en).length * 0.15, `too many keys left in English in the Spanish dictionary: ${same.join(", ")}`);
	assert.notEqual(es["nav.note"], en["nav.note"]);
});

test("S4: plural keys come in pairs, one and other, in both languages", () => {
	const { en, es } = loadCatalog();
	for (const dictionary of [en, es]) {
		for (const key of Object.keys(dictionary)) {
			if (key.endsWith(".one")) assert.ok(`${key.slice(0, -4)}.other` in dictionary, `${key} has no .other`);
			if (key.endsWith(".other")) assert.ok(`${key.slice(0, -6)}.one` in dictionary, `${key} has no .one`);
		}
	}
});

test("S2: the Spanish is neutral and professional: tú forms, no voseo", () => {
	const { es } = loadCatalog();
	const voseo = /\b(vos|tenés|podés|querés|sabés|hacé|hacés|mirá|elegí|enviá|tocá|aprobá|fijate|andá|vení|decí|escribí|usá|abrí|cerrá|guardá|volvé|probá|revisá)\b/i;
	for (const [key, text] of Object.entries(es)) assert.ok(!voseo.test(text), `${key}: voseo in "${text}"`);
	const all = Object.values(es).join("\n");
	for (const term of ["Comentar", "Ver todo", "Elegido", "Descartada", "En curso", "Implementado", "Enviar todo", "Guardar para enviar luego", "Petición original"]) assert.ok(all.includes(term), `the Spanish uses ${term}`);
	assert.ok(/\bHaz clic\b/.test(all) && /\bEscribe\b/.test(all), "imperatives are tú forms");
});

test("S4: every key the code or index.html names exists in both dictionaries, and every key is used", () => {
	const { en, es } = loadCatalog();
	const code = codeOutsideCatalog();
	const html = read("index.html");
	const named = new Set<string>();
	// A literal in code that has the shape of a key (area.name) is a key, except file names.
	for (const text of literalsIn(code)) if (/^[a-z][A-Za-z0-9]*(\.[A-Za-z0-9_-]+)+$/.test(text) && !/\.(json|md|html|css|js|png)$/.test(text)) named.add(text);
	for (const match of html.matchAll(/data-i18n(?:-[a-z-]+)?="([^"]+)"/g)) if (!match[1].startsWith("{")) named.add(match[1]);
	// A plural base (nav.summary.open) stands for its .one and .other.
	const known = (dictionary: Record<string, string>, key: string) => key in dictionary || `${key}.one` in dictionary;
	for (const key of named) {
		assert.ok(known(en, key), `${key} is not in the English dictionary`);
		assert.ok(known(es, key), `${key} is not in the Spanish dictionary`);
	}
	// Keys built from a prefix (`reason.${code}`) count as used by that prefix.
	const prefixes = [...code.matchAll(/`([A-Za-z][\w.-]*\.)\$\{/g)].map((match) => match[1]);
	const unused = Object.keys(en).filter((key) => !named.has(key) && !named.has(key.replace(/\.(one|other)$/, "")) && !prefixes.some((prefix) => key.startsWith(prefix)));
	assert.deepEqual(unused, [], "keys nothing uses");
});

test("S4: canvas.js shows no text of its own: every visible string comes from the catalog", () => {
	const code = codeOutsideCatalog();
	const problems: string[] = [];
	const check = (where: string, expression: string) => {
		// Keys are literals too: take out the calls that fetch from the catalog, then nothing human may remain.
		const rest = withoutCalls(expression, ["t", "tn", "ref", "toSession"]);
		for (const text of literalsIn(rest)) {
			if (/^[a-z][A-Za-z0-9]*(\.[A-Za-z0-9_-]+)+$/.test(text)) continue; // a catalog key: the test above checks it exists
			const plain = text.replace(/\u0000/g, " ").replace(/[·\s]+/g, " ").trim();
			if (isHumanText(text) && !ALLOWED_LITERALS.has(plain)) problems.push(`${where}: "${text}"`);
		}
	};
	// Assignments and calls that put text in front of the user (the second argument for the two-argument helpers).
	for (const match of code.matchAll(/\.(textContent|title|placeholder|alt)\s*=(?!=)/g)) check(`.${match[1]} =`, assignedExpression(code, match.index! + match[0].length));
	const calls: Array<[string, number[]]> = [
		["chip", [1]], ["span", [1]], ["okChip", [0]], ["badChip", [0]], ["showToast", [0]], ["shotError", [0]], ["variantProblem", [0, 1]],
		["setCompareMessage", [0]], ["setStatus", [0]], ["showEmpty", [0]], ["row", [0]], ["comparePane", [0]], ["compareFrame", [2]], ["versionFrame", [2]],
		["versionPane", [3]], ["splitHandle", [0]], ["Error", [0]], ["confirm", [0]], ["loc", [2]], ["badge", [0]], ["addButton", [1, 3]], ["button", [1, 3]],
	];
	for (const [name, positions] of calls) {
		for (const match of code.matchAll(new RegExp(`(?<![\\w.])${name === "confirm" ? "(?:window\\.)?" : name === "Error" ? "new " : ""}${name}\\(`, "g"))) {
			const open = match.index! + match[0].length - 1;
			const args = callArguments(code, open);
			for (const position of positions) if (args[position] !== undefined) check(`${name}() #${position}`, args[position]);
		}
	}
	for (const match of code.matchAll(/\.setAttribute\(\s*"(aria-label|title|placeholder|alt|aria-valuetext)"\s*,/g)) {
		const open = code.indexOf("(", match.index!);
		check(`setAttribute(${match[1]})`, callArguments(code, open)[1]);
	}
	assert.deepEqual(problems, [], "text that bypasses the catalog");
	// Beyond those sinks, no multi-word sentence hides in a literal either.
	const sentences = literalsIn(withoutCalls(code, ["t", "tn", "ref", "toSession"])).filter((text) => {
		const plain = text.replace(/\u0000/g, " ").replace(/[·\s]+/g, " ").trim();
		return /(^|\s)[A-Za-z]{2,}[.,;:!?]?\s+[A-Za-z]{2,}(\s|[.,;:!?]|$)/.test(plain) && !ALLOWED_LITERALS.has(plain);
	});
	assert.deepEqual(sentences, [], "sentences in code");
});

/** Literals that read like words but are not canvas text: browser values, protocol names and the agent-bound messages. */
const ALLOWED_LITERALS = new Set([
	"px", "HTTP", "Gentle Design", "use strict", "noopener noreferrer", "The image", "text area", "Escape", "Enter", "Tab", "Home", "End", "ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Shift", "send", "collect", "open", "resolved", "readonly", "browser", "monitor",
	"normal", "none", "desktop", "tablet", "phone", "custom", "all", "side", "overlay", "slider", "Files", "image", "allow-scripts", "no-referrer", "lazy", "button", "menu", "group", "status", "alert", "tab",
	"slider", "step", "img", "text", "numeric", "horizontal", "true", "false", "iframe", "textarea", "input", "select", "section", "div", "span", "article", "figure", "figcaption", "label", "code", "small",
	"video", "canvas", "a", "p", "li", "h2", "h3", "h4", "b", "i", "dt", "dd", "dl", "svg", "use", "output", "http", "https",
]);

test("index.html: every visible text and accessible name carries a catalog key", () => {
	const { en, es } = loadCatalog();
	const html = read("index.html").replace(/<!--[^]*?-->/g, "");
	const body = html.slice(html.indexOf("<body"));
	const stack: Array<{ tag: string; translated: boolean }> = [];
	const problems: string[] = [];
	const VOID = new Set(["meta", "link", "input", "img", "br", "use", "path", "circle", "rect", "hr"]);
	const token = /<(\/?)([a-z0-9]+)\b((?:"[^"]*"|[^>"])*?)(\/?)>|([^<]+)/gi;
	for (const match of body.matchAll(token)) {
		if (match[5] !== undefined) {
			const text = match[5].replace(/&[a-z]+;/g, "").trim();
			const top = stack[stack.length - 1];
			if (!/[A-Za-z]{2,}/.test(text) || !top || ["GD", "EN"].includes(text)) continue; // the brand mark and the code of the language
			if (stack.some((entry) => entry.translated || entry.tag === "kbd" || entry.tag === "script" || entry.tag === "style")) continue;
			problems.push(`text "${text}" in <${top.tag}>`);
			continue;
		}
		const [, closing, tag, attributes, selfClosing] = match;
		if (closing) {
			stack.pop();
			continue;
		}
		const attrs = new Map([...attributes.matchAll(/([\w:-]+)(?:="([^"]*)")?/g)].map((entry) => [entry[1], entry[2] ?? ""] as const));
		for (const attribute of ["title", "aria-label", "placeholder", "alt"]) {
			if (attrs.has(attribute) && !attrs.has(`data-i18n-${attribute}`) && attrs.get(attribute) !== "Gentle Design") problems.push(`<${tag}> ${attribute}="${attrs.get(attribute)}" has no data-i18n-${attribute}`);
		}
		for (const [name, value] of attrs) {
			if (!name.startsWith("data-i18n") || name.endsWith("-args")) continue;
			assert.ok(value in en && value in es, `${name}="${value}" is not in both dictionaries`);
		}
		if (!VOID.has(tag.toLowerCase()) && !selfClosing) stack.push({ tag: tag.toLowerCase(), translated: attrs.has("data-i18n") || (tag === "h1" && attrs.get("id") === "gd-title") });
	}
	assert.deepEqual(problems, []);
});

test("S4/S5: every language-bearing element keeps the English text in index.html as its first paint and its key beside it", () => {
	const { en } = loadCatalog();
	const html = read("index.html");
	for (const match of html.matchAll(/<([a-z0-9]+)\b[^>]*\bdata-i18n="([^"]+)"[^>]*>([^<]*)</g)) {
		const [, , key, text] = match;
		if (!text.trim() || placeholdersOf(en[key]).length > 0) continue;
		assert.equal(text.trim(), en[key], `${key}: the markup shows the English dictionary text`);
	}
});

test("S5: the markup and styles of the language switch use tokens, a visible focus ring and no motion", () => {
	const html = read("index.html");
	assert.match(html, /<button type="button" id="gd-lang" class="gd-lang-button"[^>]*aria-haspopup="menu"[^>]*aria-expanded="false"[^>]*aria-controls="gd-lang-menu"/);
	assert.match(html, /<span id="gd-lang-code"/);
	assert.match(html, /<div id="gd-lang-menu" class="gd-menu gd-lang-menu" role="menu"[^>]*hidden><\/div>/);
	for (const icon of ["i-globe", "i-check"]) assert.match(html, new RegExp(`<symbol id="${icon}"`));
	assert.ok(html.indexOf('id="gd-lang"') > html.indexOf('class="gd-spacer"') && html.indexOf('id="gd-lang"') < html.indexOf('id="gd-zoom-out"'), "between the spacer and the zoom, as in the artboard");
	const css = read("canvas.css");
	const block = (selector: string) => {
		const start = css.indexOf(`${selector} {`);
		assert.ok(start >= 0, `${selector} is styled`);
		return css.slice(start, css.indexOf("}", start) + 1);
	};
	for (const selector of [".gd-lang-menu", ".gd-lang-item", ".gd-lang-check", ".gd-lang-note"]) {
		const text = block(selector);
		assert.ok(!/#[0-9a-fA-F]{3,8}\b|rgba?\(/.test(text), `${selector}: tokens only`);
		assert.ok(!/transition|animation/.test(text), `${selector}: no motion`);
	}
	assert.match(block(".gd-lang-menu"), /width:\s*300px/);
	assert.match(css, /\.gd-lang-item\[aria-checked="true"\][^{]*{[^}]*background:\s*var\(--surface-2\)/);
	assert.match(css, /\.gd-lang-item\[aria-checked="true"\] \.gd-lang-check[^{]*{[^}]*visibility:\s*visible/);
	assert.match(css, /\.gd-lang-button:focus-visible[^{]*{[^}]*outline:\s*2px solid var\(--accent\)|:focus-visible\s*{[^}]*outline:\s*2px solid var\(--accent\)/);
});

test("S5: the docs describe the language switch and what is not translated", () => {
	const docs = readFileSync(fileURLToPath(new URL("../docs/gentle-shell.md", import.meta.url)), "utf8");
	const section = docs.slice(docs.indexOf("### Gentle Design"));
	assert.match(section, /Match the browser/);
	assert.match(section, /localStorage|saved in the browser|this browser/i);
	assert.match(section, /Spanish/);
	assert.match(section, /not translated|stay (as written|in English)/i);
	assert.match(section, /messages (the canvas sends )?to the (agent|session)/i);
});

// ---- A switch leaves nothing behind in the old language ----

/** The words each language shows for each key, as patterns (a {name} matches anything), for the keys whose two texts differ. */
function languagePatterns() {
	const { en, es } = loadCatalog();
	const pattern = (text: string) => new RegExp(`^\\s*${text.split(/\{\w+\}/).map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[^]*")}\\s*$`);
	const entries = (dictionary: Record<string, string>, other: Record<string, string>) => Object.keys(dictionary)
		.filter((key) => dictionary[key] !== other[key] && dictionary[key].replace(/\{\w+\}/g, "").trim().length > 2)
		.map((key) => ({ key, text: dictionary[key], regex: pattern(dictionary[key]) }));
	return { en: entries(en, es), es: entries(es, en) };
}

/** Every text, title and accessible name the canvas shows now: elements still in the page and not hidden, never ones a render replaced. */
function shownWords(canvas: LangCanvas): Array<{ words: string; where: string }> {
	// A toast is a few seconds of news, not state: it keeps the language it was written in.
	const live = (element: FakeElement) => {
		let root = element;
		for (let node: FakeElement | null = element; node; node = node.parentElement) {
			if (node.hidden || node.id === "gd-toast") return false;
			root = node;
		}
		return Boolean(root.id) || (root as unknown as { hydrated?: boolean }).hydrated === true || root.localName === "html";
	};
	const found: Array<{ words: string; where: string }> = [];
	for (const element of canvas.document.all) {
		if (!live(element)) continue;
		const where = `<${element.localName}${element.id ? ` #${element.id}` : element.className ? ` .${element.className.split(" ")[0]}` : ""}>`;
		const values = [element.textContent, element.title, element.getAttribute("aria-label"), element.getAttribute("aria-valuetext"), element.getAttribute("placeholder"), element.getAttribute("alt")];
		for (const words of values) if (words && /[A-Za-zÁ-ú]{3,}/.test(words)) found.push({ words, where });
	}
	return found;
}

/** What still reads in `old` after the page switched to the other language. */
function leftovers(canvas: LangCanvas, old: "en" | "es") {
	const all = languagePatterns();
	const now = all[old === "en" ? "es" : "en"];
	// Words that the current language's own entries also match (Artboard {title}, next to Artboard list) are not leftovers.
	return shownWords(canvas)
		.filter(({ words }) => all[old].some((entry) => entry.regex.test(words)) && !now.some((entry) => entry.regex.test(words)))
		.map(({ words, where }) => `${where}: ${words.slice(0, 80)}`);
}

test("S2: after a switch no text, title or accessible name of the old language is left in the panel, the artboards or the navigator", async () => {
	const replies = {
		...commentsDoc(withOpen("c1"), withOpen("c2", { sentAt: "2026-10-26T10:00:00.000Z", viewport: { width: 390, height: 844 } }), comment("c3", "01-a.html", "resolved", { resolution: "Done" }), comment("c4", "02-b.html")),
		"/t/api/designs/alpha/handoffs": handoffDoc("01-a.html", { "01-a.html": { status: "implemented", implementedAt: stamp(9, 9), startedAt: stamp(9, 5), sentAt: stamp(9, 1), previewUrl: "http://localhost:3000/" } }),
		[HISTORY_URL]: HISTORY,
		...SYSTEM_REPLY,
	};
	for (const [from, to] of [["en", "es"], ["es", "en"]] as const) {
		const canvas = await loadLang({ browser: from, replies });
		const [system, first] = canvas.boards;
		assert.ok(shownWords(canvas).length > 40, "the walker sees the page");
		assert.ok(shownWords(canvas).some(({ words }) => words === (from === "en" ? "Comments" : "Comentarios")), "including the static text of index.html");
		report_(canvas as unknown as Canvas, first.frame, [finding(), finding({ check: "target", title: "Small touch target", detail: '"Go" is 20 × 20 px; WCAG 2.2 needs at least 24 × 24 px.', selector: "button", label: "button" })]);
		canvas.message(first.frame.contentWindow, { type: "gd:overflow", overflow: true, width: 400, scrollWidth: 900 });
		layoutWorld(canvas as unknown as Canvas, [[0, 0, 800, 600], [880, 0, 400, 300], [1360, 0, 400, 300]]);
		canvas.windowEvent("resize");
		void system;
		for (const tab of ["gd-filter-open", "gd-filter-resolved", "gd-tab-history", "gd-tab-checks", "gd-tab-brief"]) {
			canvas.document.getElementById(tab).dispatch("click");
			chooseLang(canvas, to);
			assert.deepEqual(leftovers(canvas, from), [], `${from} -> ${to} on ${tab}`);
			chooseLang(canvas, from);
			assert.deepEqual(leftovers(canvas, to), [], `${to} -> ${from} on ${tab}`);
		}
	}
});

test("S2: after a switch nothing of the old language is left in focus mode with All sizes, the inspector, the comment box and the variant dialog", async () => {
	for (const [from, to] of [["en", "es"], ["es", "en"]] as const) {
		const canvas = await loadLang({ browser: from, replies: { [TOKENS_URL]: TOKEN_SET, ...commentsDoc(withOpen("c1")) }, config: { delivery: { implement: false, variant: false } } });
		const [first] = canvas.boards;
		tallViewport(canvas as unknown as Canvas);
		click(first.shield!, 200, 200);
		withClass(first.wrapper, "gd-size-button")[3].dispatch("click");
		canvas.message(first.frame.contentWindow, { type: "gd:overflow", overflow: true, width: 400, scrollWidth: 900 });
		for (const surface of sizeSections(canvas as unknown as Canvas)) {
			const frame = iframeOf(surface);
			canvas.message(frame.contentWindow, { type: "gd:overflow", overflow: true, width: Number(frame.style.width.replace("px", "")), scrollWidth: 2000 });
		}
		canvas.document.getElementById("gd-comment").dispatch("click");
		canvas.document.getElementById("gd-technical").dispatch("click");
		first.frame.rect = { left: 100, top: 120, width: 400, height: 300 };
		inspect(canvas as unknown as Canvas, sizeSections(canvas as unknown as Canvas).length ? { contentWindow: iframeOf(sizeSections(canvas as unknown as Canvas)[2]).contentWindow } : first.frame, { ...MEASURE, color: { r: 10, g: 20, b: 30, a: 1 } });
		chooseLang(canvas, to);
		assert.deepEqual(leftovers(canvas, from), [], `${from} -> ${to} in focus mode`);
		chooseLang(canvas, from);
		assert.deepEqual(leftovers(canvas, to), [], `${to} -> ${from} in focus mode`);
	}
});

test("S2: after a switch nothing of the old language is left in Compare, a version comparison or a placeholder board", async () => {
	for (const [from, to] of [["en", "es"], ["es", "en"]] as const) {
		const compare = await loadLang({ browser: from, replies: { "/t/api/designs/alpha/handoffs": implementedDoc("01-a.html") } });
		withClass(boardsOf(compare)[0], "gd-compare-start")[0].dispatch("click");
		compare.document.getElementById("gd-compare-mode-overlay").dispatch("click");
		chooseLang(compare, to);
		assert.deepEqual(leftovers(compare, from), [], `${from} -> ${to} in Compare`);
		chooseLang(compare, from);
		assert.deepEqual(leftovers(compare, to), [], `${to} -> ${from} in Compare`);

		const versions = await loadLang({ browser: from, replies: { [HISTORY_URL]: HISTORY, ...commentsDoc(comment("a1", "01-a.html", "resolved")) } });
		versions.document.getElementById("gd-tab-history").dispatch("click");
		withClass(versions.document.getElementById("gd-history"), "gd-version-compare")[0].dispatch("click");
		chooseLang(versions, to);
		assert.deepEqual(leftovers(versions, from), [], `${from} -> ${to} in a version comparison`);
		chooseLang(versions, from);
		assert.deepEqual(leftovers(versions, to), [], `${to} -> ${from} in a version comparison`);

		const variant = await loadLang({ browser: from, replies: { "/t/api/designs/alpha/variant": { queued: false } } });
		menuButtonOf(boardsOf(variant)[0]).dispatch("click");
		menuItems(variant as unknown as Canvas)[0].dispatch("click");
		variantField(variant as unknown as Canvas).value = "Calmer";
		await submitVariant(variant as unknown as Canvas);
		chooseLang(variant, to);
		assert.deepEqual(leftovers(variant, from), [], `${from} -> ${to} with a placeholder board`);
	}
});

// ---- Chosen direction: top-bar status and discarded alternatives (canvas-chosen-direction T1/S1-S2)

const workBar = (canvas: Canvas) => canvas.document.getElementById("gd-work");
const workTexts = (canvas: Canvas) => ({
	lead: texts(workBar(canvas), "gd-work-lead"),
	title: texts(workBar(canvas), "gd-work-title"),
	state: texts(workBar(canvas), "gd-work-state"),
	note: texts(workBar(canvas), "gd-work-note"),
});
/** Today at hh:mm, local time, as the ISO string handoffs.json stores. */
const todayAt = (hours: number, minutes: number) => { const date = new Date(); date.setHours(hours, minutes, 0, 0); return date.toISOString(); };

test("chosen-direction S1: the top bar names the chosen direction with its state, time and note, live", async () => {
	const canvas = await loadRail();
	assert.equal(workBar(canvas).hidden, true, "hidden while nothing is chosen");

	await setHandoffs(canvas, handoffDoc("02-b.html", { "02-b.html": { status: "sent", queued: true, sentAt: todayAt(9, 47) } }));
	assert.equal(workBar(canvas).hidden, false);
	assert.deepEqual(workTexts(canvas), { lead: ["Implementing"], title: ["“Second”"], state: ["Queued since 09:47"], note: [] });

	await setHandoffs(canvas, handoffDoc("02-b.html", { "02-b.html": { status: "in_progress", sentAt: todayAt(9, 47), startedAt: todayAt(9, 48), note: "Exploring the current code (navigation and the Usage screen) before planning." } }));
	assert.deepEqual(workTexts(canvas), { lead: ["Implementing"], title: ["“Second”"], state: ["In progress since 09:48"], note: ["Exploring the current code (navigation and the Usage screen) before planning."] });
	const [note] = withClass(workBar(canvas), "gd-work-note");
	assert.equal(note.title, "Exploring the current code (navigation and the Usage screen) before planning.", "the full note is in the tooltip");
	assert.equal(withClass(workBar(canvas), "gd-work-dot")[0].dataset.status, "in_progress");

	await setHandoffs(canvas, handoffDoc("02-b.html", { "02-b.html": { status: "implemented", implementedAt: "2020-03-04T09:05:00.000Z", previewUrl: "http://localhost:3000/" } }));
	assert.deepEqual(workTexts(canvas).lead, ["Implemented ✓"]);
	assert.match(workTexts(canvas).state[0], /^at Mar 4 2020, \d\d:\d\d$/, "another day keeps its date");
	assert.equal(canvas.document.getElementById("gd-compare-app").hidden, false, "Compare with app stays the way to compare");

	await setHandoffs(canvas, handoffDoc("01-a.html", {}));
	assert.deepEqual(workTexts(canvas), { lead: ["Chosen"], title: ["“First”"], state: ["Not sent yet"], note: [] });

	await setHandoffs(canvas, handoffDoc(null, {}));
	assert.equal(workBar(canvas).hidden, true, "hidden again when nothing is chosen");
});

test("chosen-direction S1: Show opens the chosen artboard in focus mode and keeps keyboard focus on the bar across updates", async () => {
	const canvas = await loadRail();
	await setHandoffs(canvas, handoffDoc("02-b.html", { "02-b.html": { status: "in_progress" } }));
	const [show] = withClass(workBar(canvas), "gd-work-show");
	assert.equal(show.textContent, "Show");
	assert.equal(show.getAttribute("aria-label"), "Show Second on the canvas");
	show.dispatch("click");
	assert.equal(navItems(canvas)[1].getAttribute("aria-current"), "true", "the chosen artboard is focused");
	assert.equal(navItems(canvas)[0].getAttribute("aria-current"), null);
	canvas.document.getElementById("gd-back").dispatch("click");

	const [again] = withClass(workBar(canvas), "gd-work-show");
	again.focus();
	await setHandoffs(canvas, handoffDoc("02-b.html", { "02-b.html": { status: "in_progress", note: "Next step" } }));
	assert.equal(canvas.document.activeElement, withClass(workBar(canvas), "gd-work-show")[0], "an update does not drop keyboard focus");
});

test("chosen-direction S1: index.html puts the status in the bar after the breadcrumb, as a polite live region", () => {
	const html = read("index.html");
	assert.match(html, /<div id="gd-work" class="gd-work" role="status" aria-live="polite" hidden><\/div>/);
	assert.ok(html.indexOf('class="gd-crumbs"') < html.indexOf('id="gd-work"') && html.indexOf('id="gd-work"') < html.indexOf('class="gd-spacer"'));
});

test("chosen-direction S1/S2: the status and the discarded labels are in Spanish too", async () => {
	const canvas = await loadLang({ browser: "es", replies: { "/t/api/designs/alpha/handoffs": handoffDoc("02-b.html", { "02-b.html": { status: "in_progress", startedAt: todayAt(9, 48) } }) } });
	const c = canvas as unknown as Canvas;
	assert.deepEqual(workTexts(c), { lead: ["Implementando"], title: ["«Second»"], state: ["En curso desde 09:48"], note: [] });
	assert.equal(withClass(workBar(c), "gd-work-show")[0].textContent, "Ver");
	assert.deepEqual(texts(boardsOf(c)[0], "gd-choice"), ["Descartada"]);
	assert.equal(withClass(boardsOf(c)[0], "gd-implement-start")[0].textContent, "Cambiar a esta…");
	assert.deepEqual(navTexts(c, "gd-nav-tag"), ["Descartada", "Elegido"]);
});

test("chosen-direction S2: once one is chosen the others are Discarded and dimmed, and offer Switch to this… instead of Implement this", async () => {
	const canvas = await loadRail(300, { [IMPLEMENT]: { ok: true, slug: "alpha", file: "01-a.html", queued: false } });
	const start = (index: number) => withClass(boardsOf(canvas)[index], "gd-implement-start")[0];
	for (const index of [0, 1]) {
		assert.equal(boardsOf(canvas)[index].classes.has("gd-discarded"), false, "nothing is discarded before a choice");
		assert.equal(start(index).textContent, "Implement this");
	}

	await setHandoffs(canvas, handoffDoc("02-b.html", { "02-b.html": { status: "in_progress" } }));
	const [first, second] = boardsOf(canvas);
	assert.deepEqual(texts(first, "gd-choice"), ["Discarded"]);
	assert.equal(first.classes.has("gd-discarded"), true);
	assert.equal(second.classes.has("gd-discarded"), false);
	assert.deepEqual(navTexts(canvas, "gd-nav-tag"), ["Discarded", "Chosen"]);
	assert.equal(start(1).textContent, "Implement this", "the chosen artboard keeps Implement this");
	assert.equal(start(0).textContent, "Switch to this…");
	assert.equal(start(0).getAttribute("aria-label"), "Switch the implementation to First");
	assert.equal(start(0).classes.has("gd-implement-switch"), true);

	start(0).dispatch("click");
	const [control] = withClass(first, "gd-implement");
	const question = withClass(control, "gd-implement-question")[0];
	assert.equal(question.textContent, "Move the implementation to this direction? The session gets it as a new handoff.");
	withClass(control, "gd-primary")[0].dispatch("click");
	for (let i = 0; i < 10; i++) await flush();
	assert.deepEqual(canvas.posts.at(-1), { url: IMPLEMENT, body: { file: "01-a.html" } }, "switching is a handoff of this artboard");
	assert.deepEqual(boardsOf(canvas).map((board) => texts(board, "gd-choice")[0]), ["Chosen", "Discarded"], "the choice moves at once");
	assert.equal(start(0).textContent, "Implement this");
	assert.equal(start(1).textContent, "Switch to this…");

	await setHandoffs(canvas, handoffDoc(null, {}));
	assert.deepEqual(boardsOf(canvas).map((board) => board.classes.has("gd-discarded")), [false, false]);
	assert.deepEqual([start(0).textContent, start(1).textContent], ["Implement this", "Implement this"]);
	start(1).dispatch("click");
	assert.equal(withClass(withClass(boardsOf(canvas)[1], "gd-implement")[0], "gd-implement-question")[0].textContent, "Send it to the session to implement?", "an undecided design asks the usual question");
});

test("chosen-direction S2: a discarded artboard's menu says Switch to this…, the chosen one's Implement this", async () => {
	const canvas = await loadRail();
	await setHandoffs(canvas, handoffDoc("02-b.html", { "02-b.html": {} }));
	openMenu(canvas, 0);
	assert.ok(itemLabels(canvas).includes("Switch to this…"));
	assert.ok(!itemLabels(canvas).includes("Implement this"));
	keyOn(menuEl(canvas), "Escape");
	openMenu(canvas, 1);
	assert.ok(itemLabels(canvas).includes("Implement this"));
});

test("chosen-direction S2: the minimap dims discarded blocks, never the system board", async () => {
	const canvas = await minimapCanvas();
	assert.deepEqual(miniBlocks(canvas).map((block) => block.classes.has("gd-minimap-discarded")), [false, false, false]);
	await setHandoffs(canvas, handoffDoc("02-b.html", { "02-b.html": {} }));
	assert.deepEqual(miniBlocks(canvas).map((block) => block.classes.has("gd-minimap-discarded")), [false, true, false]);
	await setHandoffs(canvas, handoffDoc(null, {}));
	assert.deepEqual(miniBlocks(canvas).map((block) => block.classes.has("gd-minimap-discarded")), [false, false, false]);
});

test("chosen-direction S2: canvas.css dims a discarded artboard and restores it on hover or keyboard focus, with tokens only", () => {
	const css = read("canvas.css");
	const rule = (selector: string) => {
		const start = css.indexOf(`${selector} {`);
		assert.ok(start >= 0, `${selector} is styled`);
		return css.slice(start, css.indexOf("}", start) + 1);
	};
	assert.match(rule(".gd-discarded .gd-frame-box"), /opacity:\s*\.45/);
	assert.match(rule(".gd-discarded .gd-frame-box"), /filter:\s*grayscale\(\.6\)/);
	assert.match(css, /\.gd-discarded:hover \.gd-frame-box,\s*\.gd-discarded:focus-within \.gd-frame-box \{[^}]*opacity:\s*1[^}]*filter:\s*none/);
	for (const selector of [".gd-discarded .gd-frame-box", ".gd-choice-discarded", ".gd-minimap-discarded", ".gd-work"]) assert.ok(!/#[0-9a-fA-F]{3,8}\b|rgba?\(/.test(rule(selector)), `${selector}: tokens only`);
	assert.match(css, /@media \(prefers-reduced-motion: no-preference\) \{[^]*\.gd-discarded \.gd-frame-box \{ transition:/, "the fade only animates without reduced motion");
});

// ---- Chosen direction: the chosen artboard's stepper and pulse, the navigator's accent, dim and toggle (canvas-chosen-direction T2/S3-S5)

/** The chosen artboard's mini stepper: each step's label and state, and the position in words for assistive technology. */
const ministep = (board: FakeElement) => {
	const [root] = withClass(board, "gd-ministep");
	if (!root) return null;
	const steps = withClass(root, "gd-ministep-step");
	return {
		labels: steps.map((step) => texts(step, "gd-ministep-label")[0]),
		states: steps.map((step) => step.dataset.state),
		words: texts(root, "gd-ministep-words"),
		hiddenList: withClass(root, "gd-ministep-list").map((list) => list.getAttribute("aria-hidden")),
	};
};
const navToggle = (canvas: Canvas) => canvas.document.getElementById("gd-nav-discarded");
const navLis = (canvas: Canvas) => canvas.document.getElementById("gd-nav-list").children;

test("chosen-direction S3: the chosen artboard's handoff row has a 4-step mini stepper that follows the handoff, with the step in words", async () => {
	const canvas = await loadRail();
	assert.deepEqual(boardsOf(canvas).map(ministep), [null, null], "no stepper before a choice");

	await setHandoffs(canvas, handoffDoc("02-b.html", {}));
	const [first, second] = boardsOf(canvas);
	assert.equal(ministep(first), null, "a discarded artboard has no stepper");
	assert.deepEqual(ministep(second), { labels: ["Chosen", "Sent", "In progress", "Implemented"], states: ["done", "pending", "pending", "pending"], words: ["Step 1 of 4: Chosen"], hiddenList: ["true"] });

	const cases: Array<[Record<string, unknown>, string[], string]> = [
		[{ status: "sent", queued: true }, ["done", "current", "pending", "pending"], "Step 2 of 4: Sent"],
		[{ status: "sent" }, ["done", "done", "current", "pending"], "Step 3 of 4: In progress"],
		[{ status: "in_progress", note: "Wiring the header" }, ["done", "done", "current", "pending"], "Step 3 of 4: In progress"],
		[{ status: "implemented" }, ["done", "done", "done", "done"], "Step 4 of 4: Implemented"],
	];
	for (const [entry, states, words] of cases) {
		await setHandoffs(canvas, handoffDoc("02-b.html", { "02-b.html": entry }));
		const stepper = ministep(boardsOf(canvas)[1])!;
		assert.deepEqual([stepper.states, stepper.words], [states, [words]], JSON.stringify(entry));
	}
	// The timeline in the review side reads the same steps.
	await setHandoffs(canvas, handoffDoc("02-b.html", { "02-b.html": { status: "in_progress", note: "Wiring the header" } }));
	assert.deepEqual(withClass(canvas.document.getElementById("gd-timeline"), "gd-step").map((step) => step.dataset.state), ["done", "done", "current", "pending"]);
	const [note] = withClass(boardsOf(canvas)[1], "gd-handoff-note");
	assert.equal(note.title, "Wiring the header", "the note keeps its full text in the tooltip");

	await setHandoffs(canvas, handoffDoc(null, {}));
	assert.deepEqual(boardsOf(canvas).map(ministep), [null, null], "gone again when nothing is chosen");
});

test("chosen-direction S3: canvas.css pulses the sent and in-progress dot only without reduced motion, and the note reads in one plain line", () => {
	const css = read("canvas.css");
	// The rule of the selector alone, not a list that names it.
	const rule = (selector: string) => {
		const start = css.indexOf(`\n${selector} {`);
		assert.ok(start >= 0, `${selector} is styled`);
		return css.slice(start, css.indexOf("}", start) + 1);
	};
	assert.match(css, /\.gd-handoff-badge\[data-status="sent"\]::before,\s*\.gd-handoff-badge\[data-status="in_progress"\]::before \{[^}]*border-radius:\s*50%[^}]*background:\s*var\(--info\)/, "a dot leads the sent and in-progress badge");
	assert.match(css, /@keyframes gd-pulse \{/);
	const motion = css.slice(css.indexOf("@media (prefers-reduced-motion: no-preference) {"));
	assert.match(motion.slice(0, motion.indexOf("\n}\n")), /\.gd-handoff-badge\[data-status="sent"\]::before,\s*\.gd-handoff-badge\[data-status="in_progress"\]::before \{ animation: gd-pulse/, "the pulse runs only without reduced motion");
	const outsideMotion = css.replace(/@media \(prefers-reduced-motion: no-preference\) \{[^]*?\n\}\n/g, "");
	assert.ok(!/animation:\s*gd-pulse/.test(outsideMotion), "nothing pulses under reduced motion");
	const note = rule(".gd-handoff-note");
	assert.ok(!/italic/.test(note), "the note is not italic");
	assert.match(note, /max-width:\s*(\d+)ch/);
	assert.ok(Number(/max-width:\s*(\d+)ch/.exec(note)![1]) >= 48, "the note is wider than before");
	for (const selector of [".gd-handoff-note", ".gd-ministep", ".gd-ministep-list", ".gd-ministep-step", ".gd-ministep-dot"]) assert.ok(!/#[0-9a-fA-F]{3,8}\b|rgba?\(/.test(rule(selector)), `${selector}: tokens only`);
	assert.match(css, /\.gd-ministep-step\[data-state="done"\] \.gd-ministep-dot \{[^}]*var\(--success\)/);
	assert.match(css, /\.gd-ministep-step\[data-state="current"\] \.gd-ministep-dot \{[^}]*var\(--info\)/);
});

test("chosen-direction S4: the navigator marks the chosen item with an accent and dims the discarded ones, without moving any item", async () => {
	const canvas = await loadRail();
	const items = [...navLis(canvas)];
	const frames = [thumbFrame(canvas, 0), thumbFrame(canvas, 1)];
	const marks = () => navItems(canvas).map((button) => [button.classes.has("gd-nav-item-chosen"), button.classes.has("gd-nav-item-discarded")]);
	assert.deepEqual(marks(), [[false, false], [false, false]], "nothing is marked before a choice");

	await setHandoffs(canvas, handoffDoc("02-b.html", { "02-b.html": { status: "in_progress" } }));
	assert.deepEqual(marks(), [[false, true], [true, false]]);
	assert.deepEqual([...navLis(canvas)], items, "the chosen item is not moved first: same items, same order");
	assert.deepEqual([thumbFrame(canvas, 0), thumbFrame(canvas, 1)], frames, "so no thumbnail reloads");

	await setHandoffs(canvas, handoffDoc("01-a.html", { "01-a.html": {} }));
	assert.deepEqual(marks(), [[true, false], [false, true]], "the marks follow a switch");
	await setHandoffs(canvas, handoffDoc(null, {}));
	assert.deepEqual(marks(), [[false, false], [false, false]]);
});

test("chosen-direction S4: Hide discarded (N) hides the discarded items in place and Show discarded (N) brings them back; it hides with the choice", async () => {
	const canvas = await loadRail();
	const toggle = navToggle(canvas);
	assert.equal(toggle.hidden, true, "hidden while nothing is chosen");

	await setHandoffs(canvas, handoffDoc("02-b.html", { "02-b.html": { status: "in_progress" } }));
	const items = [...navLis(canvas)];
	const frames = [thumbFrame(canvas, 0), thumbFrame(canvas, 1)];
	assert.equal(toggle.hidden, false);
	assert.equal(toggle.textContent, "Hide discarded (1)");
	assert.equal(toggle.getAttribute("aria-expanded"), "true");

	toggle.focus();
	toggle.dispatch("click");
	assert.deepEqual(items.map((item) => item.hidden), [true, false], "the discarded item is hidden");
	assert.equal(toggle.textContent, "Show discarded (1)");
	assert.equal(toggle.getAttribute("aria-expanded"), "false");
	assert.equal(canvas.document.activeElement, toggle, "focus stays on the toggle");
	assert.deepEqual([...navLis(canvas)], items, "hidden in place, never removed or moved");
	assert.deepEqual([thumbFrame(canvas, 0), thumbFrame(canvas, 1)], frames);

	await setComments(canvas, comment("a1", "01-a.html"));
	assert.deepEqual(items.map((item) => item.hidden), [true, false], "a re-render keeps them hidden");
	await setHandoffs(canvas, handoffDoc("01-a.html", { "01-a.html": {} }));
	assert.deepEqual(items.map((item) => item.hidden), [false, true], "a switch hides the newly discarded one");

	toggle.dispatch("click");
	assert.deepEqual(items.map((item) => item.hidden), [false, false]);
	assert.equal(toggle.textContent, "Hide discarded (1)");

	toggle.dispatch("click");
	await setHandoffs(canvas, handoffDoc(null, {}));
	assert.deepEqual(items.map((item) => item.hidden), [false, false], "clearing the choice shows everything");
	assert.equal(toggle.hidden, true, "and hides the toggle");
	await setHandoffs(canvas, handoffDoc("02-b.html", {}));
	assert.deepEqual([items.map((item) => item.hidden), toggle.textContent], [[false, false], "Hide discarded (1)"], "a new choice starts with everything shown");
});

test("chosen-direction S4: index.html puts the toggle under the navigator title, outside the list, hidden at first", () => {
	const html = read("index.html");
	assert.match(html, /<button type="button" id="gd-nav-discarded" class="gd-nav-discarded" aria-expanded="true" aria-controls="gd-nav-list" data-i18n="nav.hideDiscarded" hidden>Hide discarded \(0\)<\/button>/);
	assert.ok(html.indexOf('id="gd-nav-title"') < html.indexOf('id="gd-nav-discarded"') && html.indexOf('id="gd-nav-discarded"') < html.indexOf('id="gd-nav-list"'));
	const css = read("canvas.css");
	const rule = (selector: string) => {
		const start = css.indexOf(`${selector} {`);
		assert.ok(start >= 0, `${selector} is styled`);
		return css.slice(start, css.indexOf("}", start) + 1);
	};
	assert.match(rule(".gd-nav-item-chosen"), /var\(--accent\)/);
	assert.match(rule(".gd-nav-item-discarded .gd-nav-thumb"), /opacity:\s*\.45/);
	assert.match(css, /\.gd-nav-item-discarded:hover \.gd-nav-thumb,\s*\.gd-nav-item-discarded:focus-visible \.gd-nav-thumb \{[^}]*opacity:\s*1/, "restored on hover or keyboard focus");
	for (const selector of [".gd-nav-item-chosen", ".gd-nav-item-discarded .gd-nav-thumb", ".gd-nav-discarded"]) assert.ok(!/#[0-9a-fA-F]{3,8}\b|rgba?\(/.test(rule(selector)), `${selector}: tokens only`);
	assert.match(css, /\.gd-nav-discarded\[hidden\] \{ display: none; \}/);
});

test("chosen-direction S3/S4: the stepper and the navigator toggle speak Spanish", async () => {
	const canvas = await loadLang({ browser: "es", replies: { "/t/api/designs/alpha/handoffs": handoffDoc("02-b.html", { "02-b.html": { status: "in_progress" } }) } });
	const c = canvas as unknown as Canvas;
	assert.deepEqual(ministep(boardsOf(c)[1]), { labels: ["Elegido", "Enviado", "En curso", "Implementado"], states: ["done", "done", "current", "pending"], words: ["Paso 3 de 4: En curso"], hiddenList: ["true"] });
	assert.equal(navToggle(c).textContent, "Ocultar descartadas (1)");
	navToggle(c).dispatch("click");
	assert.equal(navToggle(c).textContent, "Mostrar descartadas (1)");
	chooseLang(canvas, "en");
	assert.equal(navToggle(c).textContent, "Show discarded (1)", "a switch of language rewrites it");
	assert.deepEqual(ministep(boardsOf(c)[1])!.words, ["Step 3 of 4: In progress"]);
});

test("chosen-direction S5: the docs describe the stepper, the pulsing dot, the readable note and the navigator toggle", () => {
	const docs = readFileSync(fileURLToPath(new URL("../docs/gentle-shell.md", import.meta.url)), "utf8");
	const section = docs.slice(docs.indexOf("### Gentle Design"));
	assert.match(section, /mini stepper/i);
	assert.match(section, /\*\*Chosen\*\* → \*\*Sent\*\* → \*\*In progress\*\* → \*\*Implemented\*\*/);
	assert.match(section, /puls/i);
	assert.match(section, /reduced motion/i);
	assert.match(section, /\*\*Hide discarded \(N\)\*\*/);
	assert.match(section, /\*\*Show discarded \(N\)\*\*/);
});

// ---- canvas-check-highlight: Show marks the element of a check on the canvas, zooms, and links the card ----

const marks = (canvas: Canvas) => withClass(canvas.viewport, "gd-check-mark");
const showCard = (canvas: Canvas, index: number) => withClass(checkCards(canvas)[index], "gd-check-show")[0].dispatch("click");
const activeCards = (canvas: Canvas) => checkCards(canvas).map((card, index) => (card.classes.has("gd-check-active") ? index : -1)).filter((index) => index >= 0);
const worldView = (canvas: Canvas) => {
	const match = /^translate\((-?[\d.e+-]+)px, (-?[\d.e+-]+)px\) scale\(([\d.e+-]+)\)$/.exec(canvas.world.style.transform)!;
	return { x: Number(match[1]), y: Number(match[2]), zoom: Number(match[3]) };
};
const advice = (extra: Record<string, unknown> = {}) => finding({ check: "target", severity: "advice", title: "Touch target under 44 px", detail: '"Pay" is 100 × 28 px; 44 × 44 px is recommended for touch.', selector: "#pay", label: "button#pay", rect: { x: 10, y: 250, width: 4, height: 2 }, ...extra });
const markBox = (ring: FakeElement) => [ring.style.left, ring.style.top, ring.style["--gd-mark-w"], ring.style["--gd-mark-h"]];
/** A still click (no movement) on the canvas at a point, from `target`. */
const stillClick = (target: FakeElement) => click(target, 500, 400);

test("check-highlight S1: Show draws one canvas ring over the element, at its rect, in the severity color, labeled with the check", async () => {
	const canvas = await loadRail();
	const [first, second] = canvas.boards;
	first.frame.rect = { left: 100, top: 120, width: 400, height: 300 };
	second.frame.rect = { left: 600, top: 120, width: 400, height: 300 };
	report_(canvas, first.frame, [finding(), advice()]);
	report_(canvas, second.frame, [finding({ selector: "#second" })]);
	openChecks(canvas);
	assert.deepEqual(marks(canvas), [], "nothing is marked before Show");
	showCard(canvas, 0);
	assert.equal(marks(canvas).length, 1);
	const ring = marks(canvas)[0];
	assert.equal(ring.parentElement, first.frame.parentElement, "drawn by the canvas beside the artboard's frame, in the transformed world");
	assert.ok(canvas.world.contains(ring), "it follows zoom and pan with the artboard");
	assert.equal(ring.getAttribute("aria-hidden"), "true", "the card is the accessible path; the ring is only drawn");
	assert.ok(ring.classes.has("gd-check-mark-fail") && !ring.classes.has("gd-check-mark-advice"), "red for a problem");
	assert.deepEqual(markBox(ring), ["130px", "50px", "200px", "20px"], "centered on the element's rect, in artboard CSS px");
	assert.deepEqual(texts(ring, "gd-check-mark-label"), ["Low contrast"]);
	assert.deepEqual(first.frame.contentWindow!.posted.at(-1), { type: "gd:highlight", selector: "main > p.or" }, "the page gets the same highlight as before, nothing else");
	// Another Show replaces it: one mark at a time.
	showCard(canvas, 1);
	assert.equal(marks(canvas).length, 1);
	const amber = marks(canvas)[0];
	assert.ok(amber.classes.has("gd-check-mark-advice") && !amber.classes.has("gd-check-mark-fail"), "amber for advice");
	assert.deepEqual(markBox(amber), ["12px", "251px", "4px", "2px"]);
	assert.deepEqual(texts(amber, "gd-check-mark-label"), ["Touch target under 44 px"]);
	// Zooming keeps the same ring in place in world coordinates.
	canvas.document.getElementById("gd-zoom-in").dispatch("click");
	assert.deepEqual(marks(canvas), [amber]);
	assert.deepEqual(markBox(amber), ["12px", "251px", "4px", "2px"]);
	// A finding of another artboard moves the ring there.
	showCard(canvas, 2);
	assert.equal(marks(canvas).length, 1);
	assert.equal(marks(canvas)[0].parentElement, second.frame.parentElement);
});

test("check-highlight S1/S5: canvas.css keeps the ring a fixed size on screen with tokens, and animates it only with motion allowed", () => {
	const css = read("canvas.css");
	const rule = (selector: string) => css.match(new RegExp(`(?:^|\\n)${selector.replace(/[.-]/g, (char) => `\\${char}`)} \\{([^}]*)\\}`))?.[1] ?? "";
	const mark = rule(".gd-check-mark");
	assert.ok(mark, ".gd-check-mark is styled");
	assert.match(mark, /pointer-events:\s*none/);
	assert.match(mark, /border:\s*calc\(2px \* var\(--gd-inv-zoom, 1\)\) solid var\(--gd-mark-color\)/, "the stroke keeps its screen width at any zoom");
	assert.match(mark, /width:\s*max\(calc\(var\(--gd-mark-w\)[^;]*calc\(\d+px \* var\(--gd-inv-zoom, 1\)\)\)/, "a minimum on-screen size, so a tiny element stays visible");
	assert.match(mark, /height:\s*max\(calc\(var\(--gd-mark-h\)[^;]*calc\(\d+px \* var\(--gd-inv-zoom, 1\)\)\)/);
	assert.match(mark, /--gd-mark-color:\s*var\(--warning\)/, "amber for advice");
	assert.match(rule(".gd-check-mark-fail"), /--gd-mark-color:\s*var\(--error\)/, "red for a problem");
	assert.match(rule(".gd-check-mark-label"), /transform:\s*scale\(var\(--gd-inv-zoom, 1\)\)/, "the label keeps its screen size like the pins");
	assert.match(rule(".gd-check-active"), /var\(--/, "the linked card is styled with tokens");
	const motion = css.slice(css.indexOf("@media (prefers-reduced-motion: no-preference)"));
	const block = motion.slice(0, motion.indexOf("\n}\n"));
	assert.match(block, /\.gd-check-mark \{[^}]*animation:/, "the ring pulses only when motion is allowed");
	assert.doesNotMatch(css.replace(block, ""), /\.gd-check-mark[^{]*\{[^}]*animation/, "and nowhere else");
	assert.match(css, /\.gd-exporting \.gd-check-mark/, "an export never includes the ring");
});

test("check-highlight S1: Esc clears the ring, after what already owns Esc; commenting and focus mode keep their Esc", async () => {
	const canvas = await loadRail();
	const [first] = canvas.boards;
	first.frame.rect = { left: 100, top: 120, width: 400, height: 300 };
	report_(canvas, first.frame, [finding()]);
	openChecks(canvas);
	showCard(canvas, 0);
	// Something that handled Esc first (the comment box, a menu, a confirm step) keeps the ring.
	press(canvas, "Escape", { defaultPrevented: true });
	assert.equal(marks(canvas).length, 1);
	const event = press(canvas, "Escape");
	assert.equal(event.defaultPrevented, true);
	assert.deepEqual(marks(canvas), []);
	assert.deepEqual(activeCards(canvas), []);
	// In comment mode the first Esc clears the ring, the next one leaves comment mode, as before.
	canvas.document.getElementById("gd-comment").dispatch("click");
	showCard(canvas, 0);
	press(canvas, "Escape");
	assert.deepEqual(marks(canvas), []);
	assert.equal(pressed(canvas, "gd-comment"), "true");
	press(canvas, "Escape");
	assert.equal(pressed(canvas, "gd-comment"), "false");
	// Esc forwarded by the artboard while commenting does the same.
	canvas.document.getElementById("gd-comment").dispatch("click");
	showCard(canvas, 0);
	canvas.message(first.frame.contentWindow, { type: "gd:escape" });
	assert.deepEqual(marks(canvas), []);
	assert.equal(pressed(canvas, "gd-comment"), "true");
	canvas.message(first.frame.contentWindow, { type: "gd:escape" });
	assert.equal(pressed(canvas, "gd-comment"), "false");
	// A dialog open over the canvas keeps its own Esc.
	showCard(canvas, 0);
	canvas.document.getElementById("gd-shortcuts").setAttribute("open", "");
	press(canvas, "Escape");
	assert.equal(marks(canvas).length, 1);
	canvas.document.getElementById("gd-shortcuts").removeAttribute("open");
	// Focus mode: the ring is drawn on the focused artboard and Shift+Esc still leaves focus mode.
	navItems(canvas)[0].dispatch("click");
	showCard(canvas, 0);
	assert.equal(marks(canvas).length, 1);
	assert.equal(marks(canvas)[0].parentElement, first.frame.parentElement);
	press(canvas, "Escape", { shiftKey: true });
	assert.doesNotMatch(canvas.navMode.textContent, /^Using:/);
});

test("check-highlight S1: a still click on the canvas clears the ring; a drag pans and keeps it", async () => {
	const canvas = await loadRail();
	const [first] = canvas.boards;
	first.frame.rect = { left: 100, top: 120, width: 400, height: 300 };
	report_(canvas, first.frame, [finding()]);
	openChecks(canvas);
	showCard(canvas, 0);
	canvas.viewport.dispatch("pointerdown", { button: 0, pointerId: 1, clientX: 500, clientY: 400 });
	canvas.viewport.dispatch("pointermove", { pointerId: 1, clientX: 560, clientY: 430 });
	canvas.viewport.dispatch("pointerup", { button: 0, pointerId: 1, clientX: 560, clientY: 430 });
	assert.equal(marks(canvas).length, 1, "a drag is a pan, not a click");
	stillClick(canvas.viewport);
	assert.deepEqual(marks(canvas), []);
	assert.deepEqual(activeCards(canvas), []);
	// A click on an artboard (its shield) is a click on the canvas too.
	showCard(canvas, 0);
	stillClick(canvas.boards[1].shield!);
	assert.deepEqual(marks(canvas), []);
});

test("check-highlight S1: the ring goes when its artboard reloads or the design changes, and follows a new report of the same finding", async () => {
	const canvas = await loadRail();
	const [first] = canvas.boards;
	first.frame.rect = { left: 100, top: 120, width: 400, height: 300 };
	report_(canvas, first.frame, [finding(), advice()]);
	openChecks(canvas);
	showCard(canvas, 0);
	// A resize re-reports: the same finding (same check, kind and element) keeps the ring at its new rect, and its card stays linked.
	report_(canvas, first.frame, [advice(), finding({ rect: { x: 0, y: 0, width: 50, height: 10 } })]);
	assert.equal(marks(canvas).length, 1);
	assert.deepEqual(markBox(marks(canvas)[0]), ["25px", "5px", "50px", "10px"]);
	assert.deepEqual(activeCards(canvas), [1]);
	// A report without it drops the ring.
	report_(canvas, first.frame, [advice()]);
	assert.deepEqual(marks(canvas), []);
	assert.deepEqual(activeCards(canvas), []);
	// A reload drops it.
	report_(canvas, first.frame, [finding()]);
	showCard(canvas, 0);
	first.frame.dispatch("load");
	assert.deepEqual(marks(canvas), []);
	// Another design drops it.
	report_(canvas, first.frame, [finding()]);
	showCard(canvas, 0);
	assert.equal(marks(canvas).length, 1);
	await canvas.serverEvent("show", { slug: "beta" });
	assert.deepEqual(marks(canvas), []);
});

test("check-highlight S2: under 100% Show zooms in about the element and centers it; it never zooms out", async () => {
	const canvas = await loadRail();
	const [first] = canvas.boards;
	report_(canvas, first.frame, [finding(), finding({ selector: "#hero", rect: { x: 0, y: 0, width: 1000, height: 100 } }), finding({ selector: "#page", rect: { x: 0, y: 0, width: 2000, height: 100 } })]);
	openChecks(canvas);
	const zoomOut = () => canvas.document.getElementById("gd-zoom-out").dispatch("click");
	/** Show at the current zoom, with the frame where that zoom puts it; returns the view before and after. */
	const showAt = (index: number) => {
		const before = worldView(canvas);
		first.frame.rect = { left: 100, top: 120, width: 400 * before.zoom, height: 300 * before.zoom };
		showCard(canvas, index);
		return { before, after: worldView(canvas) };
	};
	/** Where the element's center lands in the viewport (1000 × 700, 50 px down the page) after Show. */
	const landed = ({ before, after }: ReturnType<typeof showAt>, rect: { x: number; y: number; width: number; height: number }) => {
		const worldX = (100 + (rect.x + rect.width / 2) * before.zoom - before.x) / before.zoom;
		const worldY = (120 - 50 + (rect.y + rect.height / 2) * before.zoom - before.y) / before.zoom;
		return [after.x + worldX * after.zoom, after.y + worldY * after.zoom];
	};
	zoomOut(); zoomOut(); zoomOut();
	assert.ok(Math.abs(worldView(canvas).zoom - 0.512) < 1e-9);
	const small = showAt(0);
	assert.equal(small.after.zoom, 1, "a small element: up to 100%");
	near(landed(small, finding().rect), [500, 350]);
	assert.equal(canvas.zoomLevel.textContent, "100%");
	// A wide element gets the zoom at which it fills most of the view, still a zoom in.
	zoomOut(); zoomOut(); zoomOut();
	const wide = showAt(1);
	assert.ok(Math.abs(wide.after.zoom - 0.8) < 1e-9, `0.8, got ${wide.after.zoom}`);
	near(landed(wide, { x: 0, y: 0, width: 1000, height: 100 }), [500, 350]);
	// Wider than that at the current zoom: the zoom stays; it never zooms out.
	zoomOut(); zoomOut();
	const zoom = worldView(canvas).zoom;
	const huge = showAt(2);
	assert.equal(huge.after.zoom, zoom);
	// At 100% or more the zoom stays.
	canvas.document.getElementById("gd-zoom-in").dispatch("click");
	canvas.document.getElementById("gd-zoom-in").dispatch("click");
	canvas.document.getElementById("gd-zoom-in").dispatch("click");
	canvas.document.getElementById("gd-zoom-in").dispatch("click");
	const above = worldView(canvas).zoom;
	assert.ok(above > 1);
	assert.equal(showAt(0).after.zoom, above, "Show never zooms out");
	// Ask the agent to fix only pans, as before.
	zoomOut(); zoomOut(); zoomOut(); zoomOut(); zoomOut();
	const asked = worldView(canvas).zoom;
	withClass(checkCards(canvas)[0], "gd-check-fix")[0].dispatch("click");
	assert.equal(worldView(canvas).zoom, asked);
});

test("check-highlight S2: in focus mode Show keeps the artboard where it is and adds the ring; in All sizes the ring is on the Desktop frame", async () => {
	const canvas = await loadRail(300, wideAlpha);
	const [first] = canvas.boards;
	report_(canvas, first.frame, [finding()]);
	navItems(canvas)[0].dispatch("click");
	openChecks(canvas);
	const transform = canvas.world.style.transform;
	showCard(canvas, 0);
	assert.equal(canvas.world.style.transform, transform, "no zoom and no pan while focused");
	assert.equal(marks(canvas).length, 1);
	assert.equal(marks(canvas)[0].parentElement, first.frame.parentElement);
	// Picking a size changes the frame the ring was measured in: it goes.
	sizeButton(canvas, "all").dispatch("click");
	assert.deepEqual(marks(canvas), []);
	showCard(canvas, 0);
	const desktop = sizeSections(canvas).at(-1)!;
	assert.equal(marks(canvas).length, 1);
	assert.ok(desktop.contains(marks(canvas)[0]), "the Desktop frame is the size the checks ran at");
	assert.equal(marks(canvas)[0].parentElement, iframeOf(desktop).parentElement);
});

test("check-highlight S3: the card being shown is marked current until the ring goes, across re-renders", async () => {
	const canvas = await loadRail();
	const [first] = canvas.boards;
	first.frame.rect = { left: 100, top: 120, width: 400, height: 300 };
	report_(canvas, first.frame, [finding(), advice(), finding({ selector: "#third" })]);
	openChecks(canvas);
	assert.deepEqual(activeCards(canvas), []);
	showCard(canvas, 1);
	assert.deepEqual(activeCards(canvas), [1]);
	assert.deepEqual(checkCards(canvas).map((card) => card.getAttribute("aria-current")), [null, "true", null]);
	showCard(canvas, 0);
	assert.deepEqual(activeCards(canvas), [0]);
	assert.deepEqual(checkCards(canvas).map((card) => card.getAttribute("aria-current")), ["true", null, null]);
	// The panel re-renders (another tab and back): the same card stays linked to the ring.
	canvas.document.getElementById("gd-filter-open").dispatch("click");
	openChecks(canvas);
	assert.deepEqual(activeCards(canvas), [0]);
	assert.equal(checkCards(canvas)[0].getAttribute("aria-current"), "true");
	// Ask the agent to fix on the shown finding keeps the ring; on another finding it clears it.
	withClass(checkCards(canvas)[0], "gd-check-fix")[0].dispatch("click");
	assert.equal(marks(canvas).length, 1);
	canvas.document.getElementById("gd-popover-cancel").dispatch("click");
	withClass(checkCards(canvas)[2], "gd-check-fix")[0].dispatch("click");
	assert.deepEqual(marks(canvas), []);
	assert.deepEqual(activeCards(canvas), []);
	assert.deepEqual(checkCards(canvas).map((card) => card.getAttribute("aria-current")), [null, null, null]);
});

test("check-highlight S4: the inspector flags a finding whose element is hidden or off-screen, and leaves the flag out otherwise", () => {
	const page = checkPage([
		{ tag: "a", attrs: { id: "skip", href: "#main" }, text: "Skip to content", size: [120, 20], style: { display: "block" }, at: [-9999, 8] },
		{ tag: "a", attrs: { id: "above", href: "#top" }, text: "Back up", size: [120, 20], style: { display: "block" }, at: [8, -200] },
		{ tag: "button", attrs: { id: "clipped" }, text: "Go", size: [20, 20], style: { clip: "rect(0px, 0px, 0px, 0px)" } },
		{ tag: "button", attrs: { id: "inset" }, text: "Go", size: [20, 20], style: { clipPath: "inset(50%)" } },
		{ tag: "img", attrs: { id: "dot", src: "dot.png" }, size: [0, 0] },
		{ tag: "button", attrs: { id: "speck" }, text: "Go", size: [1, 1] },
		{ tag: "div", style: { overflowX: "hidden", overflowY: "hidden" }, size: [100, 100], at: [0, 0], kids: [{ tag: "button", attrs: { id: "cut" }, text: "Go", size: [20, 20], at: [300, 0] }] },
		{ tag: "div", style: { overflowX: "visible", overflowY: "visible" }, size: [100, 100], at: [0, 0], kids: [{ tag: "button", attrs: { id: "spills" }, text: "Go", size: [20, 20], at: [300, 0] }] },
		{ tag: "button", attrs: { id: "tiny" }, text: "Go", size: [20, 20] },
		{ tag: "button", attrs: { id: "below" }, text: "Go", size: [20, 20], at: [8, 5000] },
	]);
	const report = page.run();
	const flags = (selector: string) => report.issues.filter((issue) => issue.selector === selector).map((issue) => ("hidden" in issue ? issue.hidden : "absent"));
	for (const selector of ["#skip", "#above", "#clipped", "#inset", "#dot", "#speck", "#cut"]) {
		assert.ok(flags(selector).length > 0, `${selector} has a finding`);
		assert.ok(flags(selector).every((flag) => flag === true), `${selector} is hidden or off-screen: ${flags(selector)}`);
	}
	for (const selector of ["#spills", "#tiny", "#below"]) {
		assert.ok(flags(selector).length > 0, `${selector} has a finding`);
		assert.ok(flags(selector).every((flag) => flag === "absent"), `${selector} is visible (below the fold can be scrolled to): no flag, as before`);
	}
});

test("check-highlight S4: a hidden finding's card says so, Show draws no ring and does not zoom; a missing flag reads as visible", async () => {
	const canvas = await loadRail();
	const [first] = canvas.boards;
	first.frame.rect = { left: 100, top: 120, width: 400, height: 300 };
	report_(canvas, first.frame, [
		finding({ selector: "body > a", label: "a", hidden: true, rect: { x: -9999, y: 8, width: 120, height: 20 } }),
		finding(),
		finding({ selector: "#off", hidden: false }),
		finding({ selector: "#odd", hidden: "yes" }),
	]);
	openChecks(canvas);
	const cards = checkCards(canvas);
	assert.deepEqual(cards.map((card) => texts(card, "gd-check-hidden")), [["This element is hidden or off-screen; it appears when it receives focus"], [], [], []]);
	const note = withClass(cards[0], "gd-check-hidden")[0];
	assert.ok(note.id, "the note has an id");
	assert.equal(withClass(cards[0], "gd-check-show")[0].getAttribute("aria-describedby"), note.id, "Show is described by the note");
	assert.equal(withClass(cards[1], "gd-check-show")[0].getAttribute("aria-describedby"), null);
	// Show on the visible one first, then on the hidden one: the ring goes and none is drawn.
	showCard(canvas, 1);
	assert.equal(marks(canvas).length, 1);
	canvas.document.getElementById("gd-zoom-out").dispatch("click");
	const before = worldView(canvas);
	first.frame.rect = { left: 100, top: 120, width: 400 * before.zoom, height: 300 * before.zoom };
	showCard(canvas, 0);
	assert.deepEqual(marks(canvas), []);
	assert.deepEqual(activeCards(canvas), []);
	assert.deepEqual(first.frame.contentWindow!.posted.at(-1), { type: "gd:highlight", selector: "body > a" }, "the page still gets the highlight");
	const after = worldView(canvas);
	assert.equal(after.zoom, before.zoom, "nothing to zoom to");
	// It centers the artboard, not a point thousands of px away.
	near([after.x - before.x, after.y - before.y], [500 - (100 + 200 * before.zoom), 400 - (120 + 150 * before.zoom)]);
	// hidden: false and a malformed flag draw the ring like a finding without the flag.
	showCard(canvas, 2);
	assert.equal(marks(canvas).length, 1);
	showCard(canvas, 3);
	assert.equal(marks(canvas).length, 1);
});

test("check-highlight S5: the hidden note and the ring's label are Spanish, and follow a switch of language", async () => {
	const canvas = await loadLang({ browser: "es" });
	const [first] = canvas.boards;
	first.frame.rect = { left: 100, top: 120, width: 400, height: 300 };
	report_(canvas as unknown as Canvas, first.frame, [finding({ hidden: true, selector: "body > a" }), finding()]);
	openChecks(canvas as unknown as Canvas);
	const panel = checksPanel(canvas as unknown as Canvas);
	assert.deepEqual(texts(panel, "gd-check-hidden"), ["Este elemento está oculto o fuera de pantalla; aparece al recibir foco"]);
	showCard(canvas as unknown as Canvas, 1);
	const ring = marks(canvas as unknown as Canvas)[0];
	assert.deepEqual(texts(ring, "gd-check-mark-label"), ["Contraste bajo"]);
	chooseLang(canvas, "en");
	assert.deepEqual(texts(ring, "gd-check-mark-label"), ["Low contrast"]);
	assert.deepEqual(texts(panel, "gd-check-hidden"), ["This element is hidden or off-screen; it appears when it receives focus"]);
	assert.equal(activeCards(canvas as unknown as Canvas).length, 1, "the switch keeps the card linked");
});

test("check-highlight S5: the docs describe the ring, the zoom, the linked card and the hidden note", () => {
	const docs = readFileSync(fileURLToPath(new URL("../docs/gentle-shell.md", import.meta.url)), "utf8");
	const line = docs.split("\n").find((candidate) => candidate.startsWith("- Accessibility checks:"))!;
	assert.ok(line, "the Accessibility checks paragraph is there");
	assert.match(line, /\*\*Show\*\*[^.]*ring/i);
	assert.match(line, /amber[^.]*advice|advice[^.]*amber/i);
	assert.match(line, /red[^.]*problem|problem[^.]*red/i);
	assert.match(line, /100 %|100%/);
	assert.match(line, /never zooms out/i);
	assert.match(line, /`Esc`/);
	assert.match(line, /This element is hidden or off-screen; it appears when it receives focus/);
	assert.match(line, /reduced motion/i);
});

// ---- canvas-mix: pick what you like from several artboards and ask for one combined direction (S1-S4, S6) ----

const MIX_KEY = "gentle-design:mix:alpha";
const MIX_URL = "/t/api/designs/alpha/mix";
type StoredPick = { id: string; file: string; selector: string; excerpt: string; note: string; used: boolean };

/** The canvas with a working (or a throwing) localStorage; `stored` is what `gentle-design:mix:alpha` holds at start. */
async function loadMix(options: { stored?: unknown; broken?: boolean; config?: Record<string, unknown>; replies?: Record<string, unknown>; hydrate?: boolean; browser?: string } = {}) {
	const data = new Map<string, string>();
	if (options.stored !== undefined) data.set(MIX_KEY, typeof options.stored === "string" ? options.stored : JSON.stringify(options.stored));
	const localStorage = options.broken
		? { getItem() { throw new Error("denied"); }, setItem() { throw new Error("denied"); } }
		: { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, String(value)); } };
	const navigator = options.browser ? { language: options.browser, languages: [options.browser] } : undefined;
	const canvas = await loadCanvas(300, { [MIX_URL]: { ok: true, slug: "alpha", queued: false }, ...options.replies }, options.config ?? {}, { localStorage, ...(navigator ? { navigator } : {}) }, { hydrate: options.hydrate });
	canvas.document.getElementById("gd-popover").hidden = true;
	return { ...canvas, data };
}
type MixCanvas = Awaited<ReturnType<typeof loadMix>>;

const storedPicks = (canvas: MixCanvas): StoredPick[] => JSON.parse(canvas.data.get(MIX_KEY) ?? "null")?.picks ?? null;
const pickFields = (picks: StoredPick[]) => picks.map(({ file, selector, excerpt, note, used }) => ({ file, selector, excerpt, note, used }));
const mixEl = (canvas: MixCanvas, id: string) => canvas.document.getElementById(id);
const mixItems = (canvas: MixCanvas) => withClass(mixEl(canvas, "gd-mix-groups"), "gd-mix-item");
const mixGroups = (canvas: MixCanvas) => withClass(mixEl(canvas, "gd-mix-groups"), "gd-mix-group");
const mixPins = (canvas: MixCanvas, index = 0) => withClass(canvas.boards[index].wrapper, "gd-pin-mix");
const lastPins = (frame: FakeElement) => frame.contentWindow!.posted.filter((message) => message.type === "gd:pins").at(-1)?.pins;
const toastText = (canvas: MixCanvas) => canvas.document.getElementById("gd-toast").textContent;

/** Comment mode on, a pick in artboard `index`, the note typed, then Add to the mix. */
function addToMix(canvas: MixCanvas, index: number, pick: { selector: string; excerpt?: string }, note = "") {
	if (canvas.document.getElementById("gd-comment").getAttribute("aria-pressed") !== "true") canvas.document.getElementById("gd-comment").dispatch("click");
	canvas.message(canvas.boards[index].frame.contentWindow, { type: "gd:pick", selector: pick.selector, excerpt: pick.excerpt ?? "", rect: { x: 10, y: 20, width: 30, height: 40 } });
	canvas.document.getElementById("gd-popover-text").value = note;
	canvas.document.getElementById("gd-popover-mix").dispatch("click");
}

const openMixTab = (canvas: MixCanvas) => canvas.document.getElementById("gd-tab-mix").dispatch("click");

test("canvas-mix S1: the comment popover's Add to the mix keeps the artboard, selector, excerpt and optional note in this browser, sending nothing", async () => {
	const canvas = await loadMix();
	addToMix(canvas, 0, { selector: "body > header", excerpt: "Acme" }, "  me gusta la cabecera  ");
	assert.deepEqual(pickFields(storedPicks(canvas)), [{ file: "01-a.html", selector: "body > header", excerpt: "Acme", note: "me gusta la cabecera", used: false }]);
	assert.equal(canvas.posts.length, 0, "a pick is not sent to the server");
	assert.equal(canvas.document.getElementById("gd-popover-message").textContent, "Added to the mix (1)");
	assert.equal(canvas.document.getElementById("gd-popover-text").value, "", "the field is cleared");
	assert.equal(mixEl(canvas, "gd-count-mix").textContent, "1");
	// The note is optional; an element of another artboard joins the same mix.
	addToMix(canvas, 1, { selector: ".chart" });
	assert.deepEqual(pickFields(storedPicks(canvas)).map((pick) => [pick.file, pick.selector, pick.note]), [["01-a.html", "body > header", "me gusta la cabecera"], ["02-b.html", ".chart", ""]]);
	assert.equal(mixEl(canvas, "gd-count-mix").textContent, "2");
	assert.ok(storedPicks(canvas).every((pick) => /^[A-Za-z0-9]{1,16}$/.test(pick.id)), "each pick has a short id");
});

test("canvas-mix S1: a note over the comment limit is refused in the popover and nothing is added; picking the same element again updates its note", async () => {
	const canvas = await loadMix();
	addToMix(canvas, 0, { selector: "#cta" }, "x".repeat(2001));
	const message = canvas.document.getElementById("gd-popover-message");
	assert.equal(message.textContent, "Write a note of at most 2000 characters.");
	assert.ok(message.classes.has("gd-error"));
	assert.equal(canvas.data.has(MIX_KEY), false, "nothing stored");
	assert.equal(mixEl(canvas, "gd-count-mix").textContent, "0");
	addToMix(canvas, 0, { selector: "#cta" }, "x".repeat(2000));
	addToMix(canvas, 0, { selector: "#cta" }, "solo el color");
	assert.deepEqual(pickFields(storedPicks(canvas)).map((pick) => pick.note), ["solo el color"], "one pick per element");
});

test("canvas-mix S1: the mix holds at most 20 picks; the 21st is refused with the reason", async () => {
	const canvas = await loadMix();
	for (let i = 0; i < 20; i++) addToMix(canvas, 0, { selector: `#p${i}` });
	assert.equal(storedPicks(canvas).length, 20);
	addToMix(canvas, 1, { selector: "#one-more" });
	assert.equal(canvas.document.getElementById("gd-popover-message").textContent, "The mix holds up to 20 picks. Remove one first.");
	assert.equal(storedPicks(canvas).length, 20);
});

test("canvas-mix S2: a pick gets a pin of its own color on its artboard, beside the comment pins, and the pin opens the Mix tab", async () => {
	const canvas = await loadMix({ replies: commentsDoc(comment("a1", "01-a.html")) });
	const [first, second] = canvas.boards;
	addToMix(canvas, 0, { selector: "body > header" }, "la cabecera");
	const [pick] = storedPicks(canvas);
	assert.deepEqual(lastPins(first.frame), [{ id: `mix:${pick.id}`, selector: "body > header" }, { id: "a1", selector: "main > .a1" }], "the artboard locates the pick like a comment");
	assert.deepEqual(lastPins(second.frame) ?? [], [], "another artboard's pick is not sent to this one");
	canvas.message(first.frame.contentWindow, { type: "gd:pin-rects", rects: [{ id: `mix:${pick.id}`, rect: { x: 10, y: 20, width: 30, height: 40 } }, { id: "a1", rect: { x: 50, y: 60, width: 10, height: 10 } }] });
	const pins = withClass(first.wrapper, "gd-pin");
	assert.deepEqual(pins.map((pin) => [pin.classes.has("gd-pin-mix"), pin.textContent, pin.style.left]), [[false, "1", "50px"], [true, "1", "10px"]]);
	assert.equal(mixPins(canvas)[0].getAttribute("aria-label"), "Mix pick 1: body > header");
	assert.equal(withClass(first.wrapper, "gd-pin").find((pin) => !pin.classes.has("gd-pin-mix"))!.getAttribute("aria-label"), "Comment 1 (open): Text of a1", "comment pins keep their label");
	mixPins(canvas)[0].dispatch("click");
	assert.equal(mixEl(canvas, "gd-tab-mix").getAttribute("aria-selected"), "true");
	assert.equal(mixEl(canvas, "gd-mix").hidden, false);
	assert.equal(canvas.document.activeElement, mixItems(canvas)[0], "keyboard focus lands on that pick");
});

test("canvas-mix S2: the Mix tab sits before Brief with its count and lists the picks grouped by artboard, each removable", async () => {
	const canvas = await loadMix();
	const tabs = ["gd-tab-comments", "gd-tab-history", "gd-tab-checks", "gd-tab-mix", "gd-tab-brief"];
	const selected = () => tabs.map((id) => canvas.document.getElementById(id).getAttribute("aria-selected"));
	assert.equal(mixEl(canvas, "gd-mix").hidden, true);
	openMixTab(canvas);
	assert.deepEqual(selected(), ["false", "false", "false", "true", "false"]);
	assert.equal(mixEl(canvas, "gd-mix").hidden, false);
	assert.equal(canvas.document.getElementById("gd-comment-list").hidden, true);
	assert.equal(canvas.document.getElementById("gd-panel-empty").hidden, true);
	assert.equal(canvas.document.getElementById("gd-tabpanel").getAttribute("aria-labelledby"), "gd-tab-mix");
	assert.equal(mixEl(canvas, "gd-mix-empty").hidden, false, "an empty tray explains how to add picks");
	assert.match(mixEl(canvas, "gd-mix-empty").textContent, /Comment mode[^]*Add to the mix/);
	// Arrow keys reach it between Checks and Brief.
	const tablist = canvas.document.getElementById("gd-tabs");
	tablist.dispatch("keydown", { key: "ArrowRight" });
	assert.equal(canvas.document.getElementById("gd-tab-brief").getAttribute("aria-selected"), "true");
	tablist.dispatch("keydown", { key: "ArrowLeft" });
	assert.equal(canvas.document.activeElement, mixEl(canvas, "gd-tab-mix"));

	addToMix(canvas, 1, { selector: ".chart", excerpt: "Weekly" }, "el gráfico semanal");
	addToMix(canvas, 0, { selector: "body > header", excerpt: "Acme" }, "la cabecera");
	addToMix(canvas, 0, { selector: "aside" });
	// canvas-ux-quick-wins S2: the selectors show with Technical details on.
	canvas.document.getElementById("gd-technical").dispatch("click");
	assert.equal(mixEl(canvas, "gd-mix-empty").hidden, true);
	assert.deepEqual(mixGroups(canvas).map((group) => texts(group, "gd-mix-group-title")[0]), ["01 · First", "02 · Second"], "grouped in artboard order");
	assert.deepEqual(mixItems(canvas).map((item) => [texts(item, "gd-mix-number")[0], texts(item, "gd-mix-excerpt")[0] ?? "", texts(item, "gd-mix-selector")[0], texts(item, "gd-mix-note")[0] ?? ""]), [
		["1", "“Acme”", "body > header", "la cabecera"],
		["2", "", "aside", ""],
		["3", "“Weekly”", ".chart", "el gráfico semanal"],
	]);
	const remove = withClass(mixItems(canvas)[1], "gd-mix-remove")[0];
	assert.equal(remove.textContent, "Remove");
	assert.equal(remove.getAttribute("aria-label"), "Remove pick 2 from the mix");
	remove.dispatch("click");
	assert.deepEqual(pickFields(storedPicks(canvas)).map((pick) => pick.selector), [".chart", "body > header"]);
	assert.equal(mixEl(canvas, "gd-count-mix").textContent, "2");
	assert.equal(canvas.document.activeElement, withClass(mixItems(canvas)[1], "gd-mix-remove")[0], "focus moves to the next pick's Remove");
});

test("canvas-mix S2: picks survive a reload of the page and of an artboard, and picks whose artboard is gone are dropped", async () => {
	const stored = { version: 1, picks: [
		{ id: "k1", file: "01-a.html", selector: "header", excerpt: "", note: "", used: false },
		{ id: "k2", file: "09-gone.html", selector: "main", excerpt: "", note: "", used: false },
		{ id: "k3", file: "02-b.html", selector: ".chart", excerpt: "Weekly", note: "colors", used: false },
	] };
	const canvas = await loadMix({ stored });
	assert.deepEqual(storedPicks(canvas).map((pick) => pick.id), ["k1", "k3"], "the gone artboard's pick is dropped and the store rewritten");
	assert.equal(mixEl(canvas, "gd-count-mix").textContent, "2");
	assert.deepEqual(lastPins(canvas.boards[1].frame), [{ id: "mix:k3", selector: ".chart" }]);
	// The artboard reloads (a file change): its frame asks again where the pick is.
	await canvas.serverEvent("change", { slug: "alpha", file: "02-b.html" });
	canvas.boards[1].frame.dispatch("load");
	assert.deepEqual(lastPins(canvas.boards[1].frame), [{ id: "mix:k3", selector: ".chart" }]);
	// The design loses an artboard: its picks go.
	canvas.replies["/t/api/designs/alpha"] = { slug: "alpha", title: "Alpha", brief: "", artboards: [{ file: "02-b.html", title: "Second", tradeoff: "", width: 400, height: 300 }] };
	await canvas.serverEvent("change", { slug: "alpha", file: "design.json" });
	assert.deepEqual(storedPicks(canvas).map((pick) => pick.id), ["k3"]);
	assert.equal(mixEl(canvas, "gd-count-mix").textContent, "1");
});

test("canvas-mix S2: a malformed store is ignored, and storage that throws keeps the mix in memory only", async () => {
	for (const stored of ["{ not json", JSON.stringify({ picks: "x" }), JSON.stringify({ picks: [{ id: 7 }, null, { id: "ok", file: "01-a.html", selector: "", excerpt: "", note: "" }] })]) {
		const canvas = await loadMix({ stored });
		assert.equal(mixEl(canvas, "gd-count-mix").textContent, "0", stored.slice(0, 20));
	}
	const canvas = await loadMix({ broken: true });
	addToMix(canvas, 0, { selector: "header" });
	assert.equal(mixEl(canvas, "gd-count-mix").textContent, "1", "the canvas keeps working");
	assert.equal(canvas.document.getElementById("gd-popover-message").textContent, "Added to the mix (1)");
});

test("canvas-mix S3: Structure from lists every artboard, defaults to the one with most picks (the first on a tie), and keeps a choice", async () => {
	const canvas = await loadMix();
	openMixTab(canvas);
	const base = mixEl(canvas, "gd-mix-base");
	assert.deepEqual(base.children.map((option) => [option.value, option.textContent]), [["01-a.html", "01 · First"], ["02-b.html", "02 · Second"]]);
	addToMix(canvas, 1, { selector: ".chart" });
	assert.equal(base.value, "02-b.html", "the only artboard with picks");
	addToMix(canvas, 0, { selector: "header" });
	assert.equal(base.value, "01-a.html", "a tie goes to the first artboard");
	addToMix(canvas, 1, { selector: "aside" });
	assert.equal(base.value, "02-b.html", "most picks");
	base.value = "01-a.html";
	base.dispatch("change");
	addToMix(canvas, 1, { selector: "footer" });
	assert.equal(base.value, "01-a.html", "the user's choice stays");
	assert.match(read("index.html"), /<label[^>]*for="gd-mix-base"[^>]*>[^]*?data-i18n="mix.base">Structure from</);
});

test("canvas-mix S4: Create combined direction posts the base and the picks, toasts Sent or Queued and shows the picks as used", async () => {
	const canvas = await loadMix();
	addToMix(canvas, 0, { selector: "body > header", excerpt: "Acme" }, "la cabecera");
	addToMix(canvas, 1, { selector: ".chart", excerpt: "Weekly" });
	openMixTab(canvas);
	const create = mixEl(canvas, "gd-mix-create");
	assert.equal(create.disabled, false);
	assert.equal(mixEl(canvas, "gd-mix-note").hidden, true);
	create.dispatch("click");
	for (let i = 0; i < 5; i++) await flush();
	assert.deepEqual(canvas.posts.map((post) => post.url), [MIX_URL]);
	assert.deepEqual(canvas.posts[0].body, { base: "01-a.html", picks: [{ file: "01-a.html", selector: "body > header", excerpt: "Acme", note: "la cabecera" }, { file: "02-b.html", selector: ".chart", excerpt: "Weekly", note: "" }] });
	assert.equal(toastText(canvas), "Sent: the session is writing a combined direction with the structure of First now.");
	assert.ok(storedPicks(canvas).every((pick) => pick.used), "marked used in the store");
	assert.deepEqual(mixItems(canvas).map((item) => [item.classes.has("gd-mix-used"), texts(item, "gd-badge")[0]]), [[true, "Used"], [true, "Used"]]);
	assert.equal(create.disabled, true, "nothing new to send");
	assert.equal(mixEl(canvas, "gd-mix-note").textContent, "These picks were already sent. Add new ones, or clear the used ones.");
	assert.equal(withClass(canvas.world, "gd-placeholder").length, 1, "the new direction's placeholder shows until the manifest gains it");
	// Clear used empties the tray.
	const clear = mixEl(canvas, "gd-mix-clear");
	assert.equal(clear.hidden, false);
	clear.dispatch("click");
	assert.deepEqual(storedPicks(canvas), []);
	assert.equal(clear.hidden, true);
	assert.equal(mixEl(canvas, "gd-mix-empty").hidden, false);

	// Queued while the agent is busy; the next pick clears the used ones first.
	canvas.replies[MIX_URL] = { ok: true, slug: "alpha", queued: true };
	addToMix(canvas, 1, { selector: "aside" });
	create.dispatch("click");
	for (let i = 0; i < 5; i++) await flush();
	assert.equal(toastText(canvas), "Queued: the session will write a combined direction with the structure of Second after its current task.");
	addToMix(canvas, 0, { selector: "nav" });
	assert.deepEqual(pickFields(storedPicks(canvas)), [{ file: "01-a.html", selector: "nav", excerpt: "", note: "", used: false }], "the next pick clears the used ones");
	assert.equal(create.disabled, false);
});

test("canvas-mix S4: Create is disabled with a reason without picks or without mix delivery, and a refused request keeps the picks with an alert", async () => {
	const empty = await loadMix();
	openMixTab(empty);
	assert.equal(mixEl(empty, "gd-mix-create").disabled, true);
	assert.equal(mixEl(empty, "gd-mix-note").hidden, false);
	assert.equal(mixEl(empty, "gd-mix-note").textContent, "Add elements to the mix first.");
	assert.match(read("index.html"), /id="gd-mix-create"[^>]*aria-describedby="gd-mix-note"/, "the reason is the button's description");

	const offline = await loadMix({ config: { delivery: { mix: false } } });
	addToMix(offline, 0, { selector: "header" });
	openMixTab(offline);
	assert.equal(mixEl(offline, "gd-mix-create").disabled, true);
	assert.match(mixEl(offline, "gd-mix-note").textContent, /not connected to a Pi session[^]*\/gentle:design open/);
	assert.ok(mixEl(offline, "gd-mix-note").title.includes("mix-unavailable"));
	mixEl(offline, "gd-mix-create").dispatch("click");
	await flush();
	assert.equal(offline.posts.length, 0, "nothing is sent");

	const refused = await loadMix({ replies: { [MIX_URL]: { __http: 500, error: "delivery-failed", slug: "alpha", reason: "boom" } } });
	addToMix(refused, 0, { selector: "header" });
	openMixTab(refused);
	mixEl(refused, "gd-mix-create").dispatch("click");
	for (let i = 0; i < 5; i++) await flush();
	const alert = withClass(mixEl(refused, "gd-mix-foot"), "gd-alert")[0];
	assert.equal(alert.hidden, false);
	assert.match(texts(alert, "gd-alert-text")[0], /did not accept[^]*picks stay in the mix/);
	assert.equal(texts(alert, "gd-alert-detail")[0], "delivery-failed: boom");
	assert.ok(storedPicks(refused).every((pick) => !pick.used), "the picks are not marked used");
	assert.equal(withClass(refused.world, "gd-placeholder").length, 0);
	assert.equal(mixEl(refused, "gd-mix-create").disabled, false, "it can be retried");
});

test("canvas-mix S6: the mix speaks Spanish with tú forms, and a switch leaves nothing of the old language in the tab", async () => {
	const canvas = await loadMix({ browser: "es-ES", hydrate: true });
	addToMix(canvas, 0, { selector: "header" }, "la cabecera");
	assert.equal(canvas.document.getElementById("gd-popover-message").textContent, "Añadido a la mezcla (1)");
	assert.equal(canvas.document.getElementById("gd-popover-show-mix").textContent, "Ver mezcla");
	// Like a sent comment's line, it is news that closes with the popover.
	canvas.document.getElementById("gd-popover-cancel").dispatch("click");
	openMixTab(canvas);
	const { es } = loadCatalog();
	assert.equal(es["mix.add"], "Añadir a la mezcla");
	assert.equal(es["tab.mix"], "Mezcla");
	assert.equal(es["mix.base"], "Estructura de");
	assert.equal(es["mix.create"], "Crear propuesta combinada");
	assert.equal(es["mix.remove"], "Quitar");
	assert.equal(es["mix.clearUsed"], "Borrar usadas");
	assert.equal(texts(mixItems(canvas)[0], "gd-mix-remove")[0], "Quitar");
	assert.equal(mixEl(canvas, "gd-mix-create").textContent, "Crear propuesta combinada");
	// The fake DOM does not nest the popover's message line in the (closed) popover; a browser hides it with it.
	const left = (old: "en" | "es") => leftovers(canvas as unknown as LangCanvas, old).filter((line) => !line.startsWith("<div #gd-popover-message>"));
	for (const [from, to] of [["es", "en"], ["en", "es"]] as const) {
		chooseLang(canvas as unknown as LangCanvas, to);
		assert.deepEqual(left(from), [], `${from} -> ${to} on the Mix tab`);
	}
	mixEl(canvas, "gd-mix-create").dispatch("click");
	for (let i = 0; i < 5; i++) await flush();
	chooseLang(canvas as unknown as LangCanvas, "en");
	assert.deepEqual(left("es"), [], "used picks and the note follow the switch");
});

test("canvas-mix S6: index.html carries the Mix tab, the popover action and the tray; canvas.css styles them with tokens, focus rings and no motion", () => {
	const html = read("index.html");
	assert.equal([...html.matchAll(/role="tab"/g)].length, 5);
	assert.ok(html.indexOf('id="gd-tab-mix"') > html.indexOf('id="gd-tab-checks"') && html.indexOf('id="gd-tab-mix"') < html.indexOf('id="gd-tab-brief"'), "Mix sits between Checks and Brief");
	assert.match(html, /<button type="button" role="tab" id="gd-tab-mix" class="gd-tab" aria-selected="false" aria-controls="gd-tabpanel" tabindex="-1"><span data-i18n="tab.mix">Mix<\/span> <span id="gd-count-mix" class="gd-count">0<\/span><\/button>/);
	const actions = html.slice(html.indexOf('class="gd-popover-actions"'), html.indexOf("</form>", html.indexOf('class="gd-popover-actions"')));
	assert.match(actions, /<button type="button" id="gd-popover-mix"[^>]*data-i18n="mix.add">Add to the mix<\/button>/);
	assert.ok(actions.indexOf("gd-popover-mix") < actions.indexOf("gd-popover-send"), "beside Send, before it");
	assert.match(html, /<div id="gd-mix" class="gd-mix" hidden>/);
	assert.match(html, /<button type="button" id="gd-mix-create" class="gd-primary" aria-describedby="gd-mix-note"[^>]*data-i18n="mix.create">Create combined direction<\/button>/);
	assert.match(html, /<button type="button" id="gd-mix-clear"[^>]*data-i18n="mix.clearUsed" hidden>Clear used<\/button>/);
	const css = read("canvas.css");
	const block = (selector: string) => {
		const start = css.indexOf(`${selector} {`);
		assert.ok(start >= 0, `${selector} is styled`);
		return css.slice(start, css.indexOf("}", start) + 1);
	};
	assert.match(block(".gd-pin.gd-pin-mix"), /background:\s*var\(--info\)/, "a pick's pin has its own color");
	for (const selector of [".gd-pin.gd-pin-mix", ".gd-mix", ".gd-mix-group-title", ".gd-mix-item", ".gd-mix-number", ".gd-mix-note", ".gd-mix-foot", ".gd-mix-used"]) {
		const text = block(selector);
		assert.ok(!/#[0-9a-fA-F]{3,8}\b|rgba?\(/.test(text), `${selector}: tokens only`);
		assert.ok(!/transition|animation/.test(text), `${selector}: no motion`);
	}
	assert.match(css, /\.gd-mix-base select:focus-visible[^{]*{[^}]*outline:\s*2px solid var\(--accent\)|:focus-visible\s*{[^}]*outline:\s*2px solid var\(--accent\)/);
});

test("canvas-mix S6: the docs and the README describe Mix", () => {
	const docs = readFileSync(fileURLToPath(new URL("../docs/gentle-shell.md", import.meta.url)), "utf8");
	const section = docs.slice(docs.indexOf("### Gentle Design"));
	for (const part of ["**Add to the mix**", "**Mix**", "**Structure from**", "**Create combined direction**", "**Clear used**", "gentle-design:mix:<slug>", "NN-mix-<name>.html", "mix-unavailable"]) assert.ok(section.includes(part), `docs mention ${part}`);
	const readme = readFileSync(fileURLToPath(new URL("../README.md", import.meta.url)), "utf8");
	const row = readme.split("\n").find((line) => line.startsWith("| Gentle Design |"))!;
	assert.match(row, /Mix/);
});

// ---- canvas-mix discoverability: the first pick shows the Mix tab, the popover links to it, the placeholder says what it is ----

const panelShown = (canvas: MixCanvas) => !canvas.document.getElementById("gd-panel").hidden;
const selectedTab = (canvas: MixCanvas) => ["gd-tab-comments", "gd-tab-history", "gd-tab-checks", "gd-tab-mix", "gd-tab-brief"].filter((id) => canvas.document.getElementById(id).getAttribute("aria-selected") === "true");

test("canvas-mix discoverability: the first pick opens the review panel on the Mix tab; a refused pick and later picks leave the tab alone", async () => {
	const canvas = await loadMix();
	canvas.document.getElementById("gd-panel-toggle").dispatch("click");
	assert.equal(panelShown(canvas), false, "the panel starts hidden here");
	// Refused: nothing joins the mix, so nothing moves.
	addToMix(canvas, 0, { selector: "#cta" }, "x".repeat(2001));
	assert.equal(panelShown(canvas), false);
	assert.deepEqual(selectedTab(canvas), ["gd-tab-comments"]);

	addToMix(canvas, 0, { selector: "body > header" });
	assert.equal(panelShown(canvas), true, "the first pick opens the panel");
	assert.equal(canvas.document.getElementById("gd-panel-toggle").getAttribute("aria-pressed"), "true");
	assert.deepEqual(selectedTab(canvas), ["gd-tab-mix"]);
	assert.equal(mixEl(canvas, "gd-mix").hidden, false);
	assert.equal(mixItems(canvas).length, 1);
	assert.notEqual(canvas.document.activeElement, mixEl(canvas, "gd-tab-mix"), "keyboard focus stays where it was");

	// The person moves on: a later pick does not take the tab back, nor reopen the panel.
	canvas.document.getElementById("gd-filter-open").dispatch("click");
	addToMix(canvas, 1, { selector: ".chart" });
	assert.deepEqual(selectedTab(canvas), ["gd-tab-comments"]);
	canvas.document.getElementById("gd-panel-toggle").dispatch("click");
	addToMix(canvas, 1, { selector: "aside" });
	assert.equal(panelShown(canvas), false);
	assert.equal(mixEl(canvas, "gd-count-mix").textContent, "3");
});

test("canvas-mix discoverability: after Add to the mix the popover says Added to the mix (N) with a Show mix button that opens the Mix tab and closes the popover", async () => {
	const canvas = await loadMix();
	const message = canvas.document.getElementById("gd-popover-message");
	const show = canvas.document.getElementById("gd-popover-show-mix");
	addToMix(canvas, 0, { selector: "body > header" });
	assert.equal(message.textContent, "Added to the mix (1)");
	assert.equal(show.hidden, false, "Show mix sits beside the message");
	assert.equal(show.textContent, "Show mix");
	assert.equal(canvas.document.getElementById("gd-popover").hidden, false, "the popover stays open so the button can be reached");
	addToMix(canvas, 1, { selector: ".chart" });
	assert.equal(message.textContent, "Added to the mix (2)");
	addToMix(canvas, 1, { selector: ".chart" }, "only the colors");
	assert.equal(message.textContent, "Added to the mix (2)", "updating a pick's note keeps the count");

	// A new pick, or a refusal, takes the button away with the message.
	canvas.message(canvas.boards[0].frame.contentWindow, { type: "gd:pick", selector: "nav", excerpt: "", rect: { x: 10, y: 20, width: 30, height: 40 } });
	assert.equal(message.textContent, "");
	assert.equal(show.hidden, true);
	addToMix(canvas, 0, { selector: "nav" }, "x".repeat(2001));
	assert.equal(show.hidden, true);
	assert.equal(message.textContent, "Write a note of at most 2000 characters.");

	// From another tab with the panel hidden, Show mix brings the Mix tab and closes the popover.
	addToMix(canvas, 0, { selector: "nav" });
	assert.equal(message.textContent, "Added to the mix (3)");
	canvas.document.getElementById("gd-filter-open").dispatch("click");
	canvas.document.getElementById("gd-panel-toggle").dispatch("click");
	show.dispatch("click");
	assert.equal(panelShown(canvas), true);
	assert.deepEqual(selectedTab(canvas), ["gd-tab-mix"]);
	assert.equal(canvas.document.getElementById("gd-popover").hidden, true);
	assert.equal(canvas.document.activeElement, mixEl(canvas, "gd-tab-mix"), "keyboard focus lands on the Mix tab");
	assert.equal(storedPicks(canvas).length, 3, "showing the mix changes nothing in it");

	const { en, es } = loadCatalog();
	assert.equal(en["mix.added"], "Added to the mix ({count})");
	assert.equal(es["mix.added"], "Añadido a la mezcla ({count})");
	assert.equal(en["mix.show"], "Show mix");
	assert.equal(es["mix.show"], "Ver mezcla");
	const html = read("index.html");
	const actions = html.slice(html.indexOf('class="gd-popover-actions"'), html.indexOf("</form>", html.indexOf('class="gd-popover-actions"')));
	assert.match(actions, /<span id="gd-popover-message"[^>]*><\/span>\s*<button type="button" id="gd-popover-show-mix" class="gd-popover-show-mix" data-i18n="mix.show" hidden>Show mix<\/button>/, "right after the message");
});

test("canvas-mix discoverability: a mix placeholder is a Combined direction, and every placeholder says inside its frame what is being designed", async () => {
	const canvas = await loadMix({ replies: { [VARIANT_URL]: { ok: true, slug: "alpha", file: "01-a.html", queued: false } } });
	addToMix(canvas, 0, { selector: "body > header" });
	openMixTab(canvas);
	mixEl(canvas, "gd-mix-create").dispatch("click");
	for (let i = 0; i < 5; i++) await flush();
	let [placeholder] = withClass(canvas.world, "gd-placeholder");
	assert.equal(placeholder.getAttribute("aria-label"), "03 · Combined direction");
	assert.deepEqual(texts(placeholder, "gd-artboard-title"), ["Combined direction"]);
	assert.deepEqual(texts(placeholder, "gd-placeholder-state"), ["Designing…"], "the head keeps its status");
	const frame = withClass(placeholder, "gd-placeholder-frame")[0];
	assert.deepEqual(texts(frame, "gd-placeholder-status"), ["Designing the combined direction…"]);
	assert.equal(frame.getAttribute("aria-hidden"), "true", "the head's status is the one announced");

	// Another direction keeps its own title and says so in its frame.
	await openVariant(canvas as unknown as Canvas, 0);
	variantField(canvas as unknown as Canvas).value = "Calmer";
	await submitVariant(canvas as unknown as Canvas);
	[placeholder] = withClass(canvas.world, "gd-placeholder");
	assert.equal(withClass(canvas.world, "gd-placeholder").length, 1);
	assert.equal(placeholder.getAttribute("aria-label"), "03 · New direction");
	assert.deepEqual(texts(placeholder, "gd-artboard-title"), ["New direction"]);
	assert.deepEqual(texts(placeholder, "gd-placeholder-status"), ["Designing the new direction…"]);

	const { en, es } = loadCatalog();
	assert.equal(es["placeholder.mixTitle"], "Propuesta combinada");
	assert.equal(es["placeholder.mixAria"], "{number} · Propuesta combinada");
	assert.equal(es["placeholder.mixStatus"], "Diseñando la propuesta combinada…");
	assert.equal(es["placeholder.status"], "Diseñando la nueva dirección…");
	assert.equal(en["placeholder.mixTitle"], "Combined direction");

	// Centered over the frame and kept at screen size at any zoom; it pulses only without reduced motion.
	const css = read("canvas.css");
	const start = css.indexOf(".gd-placeholder-status {");
	assert.ok(start >= 0, ".gd-placeholder-status is styled");
	const block = css.slice(start, css.indexOf("}", start) + 1);
	assert.match(block, /position:\s*absolute/);
	assert.match(block, /translate\(-50%,\s*-50%\)\s*scale\(var\(--gd-inv-zoom, 1\)\)/);
	assert.match(block, /max-width:\s*calc\(\d+%\s*\/\s*var\(--gd-inv-zoom, 1\)\)/);
	assert.ok(!/#[0-9a-fA-F]{3,8}\b|rgba?\(/.test(block), "tokens only");
	assert.ok(!/transition|animation/.test(block), "no motion outside the media query");
	assert.match(css, /\.gd-placeholder-frame\s*{[^}]*position:\s*relative/);
	const motion = css.slice(css.indexOf("@media (prefers-reduced-motion: no-preference) {"));
	assert.match(motion.slice(0, motion.indexOf("\n}")), /\.gd-placeholder-status\s*{\s*animation:/);
});

test("canvas-mix discoverability: the docs describe the count, Show mix, the first pick's tab and the placeholders' titles and status", () => {
	const docs = readFileSync(fileURLToPath(new URL("../docs/gentle-shell.md", import.meta.url)), "utf8");
	const mix = docs.split("\n").find((line) => line.startsWith("- Mix:"))!;
	for (const part of ["**Added to the mix (N)**", "**Show mix**", "first pick", "**<NN> · Combined direction**", "**Designing the combined direction…**"]) assert.ok(mix.includes(part), `the Mix bullet mentions ${part}`);
	const variant = docs.split("\n").find((line) => line.includes("**Try another direction from this…** opens"))!;
	assert.ok(variant.includes("**Designing the new direction…**"), "the another-direction placeholder sentence mentions its status");
	assert.match(variant, /reduced motion/);
});

// ---- canvas-ux-quick-wins T1: comment inside a direction (S1), technical details on request (S2) ----

const TECHNICAL_KEY = "gentle-design:technical";

/** The canvas with a working (or a throwing) localStorage; `stored` seeds it. index.html's static text is hydrated. */
async function loadUx(options: { stored?: Record<string, string>; broken?: boolean; replies?: Record<string, unknown>; browser?: string } = {}) {
	const data = new Map<string, string>(Object.entries(options.stored ?? {}));
	const localStorage = options.broken
		? { getItem() { throw new Error("denied"); }, setItem() { throw new Error("denied"); } }
		: { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, String(value)); } };
	const navigator = options.browser ? { language: options.browser, languages: [options.browser] } : undefined;
	const canvas = await loadCanvas(300, { [TOKENS_URL]: TOKEN_SET, ...options.replies }, {}, { localStorage, ...(navigator ? { navigator } : {}) }, { hydrate: true });
	canvas.document.getElementById("gd-popover").hidden = true;
	return { ...canvas, data };
}
type UxCanvas = Awaited<ReturnType<typeof loadUx>>;

const hintOf = (shield: FakeElement) => withClass(shield, "gd-shield-hint")[0];
const technicalButton = (canvas: Canvas) => canvas.document.getElementById("gd-technical");

test("canvas-ux S1: in Comment mode a click on a direction in the overview opens it in focus; Comment mode stays on and the next click picks", async () => {
	const canvas = await loadRail();
	const [first] = canvas.boards;
	first.frame.rect = { left: 100, top: 100, width: 200, height: 150 };
	canvas.document.getElementById("gd-comment").dispatch("click");
	click(first.shield!, 150, 130);
	assert.equal(canvas.navMode.textContent, "Using: First · Shift+Esc to exit", "the click opened the direction in focus");
	assert.equal(first.shield!.hidden, true);
	assert.equal(pressed(canvas, "gd-comment"), "true", "Comment mode stays on");
	assert.ok(!first.frame.contentWindow!.posted.some((message) => message.type === "gd:pick-at"), "no tiny element was picked");
	assert.deepEqual(first.frame.contentWindow!.posted.filter((message) => message.type === "gd:mode").at(-1), { type: "gd:mode", enabled: true });
	// The next click, now inside the direction at full size, picks an element as before.
	canvas.message(first.frame.contentWindow, { type: "gd:pick", selector: "#cta", excerpt: "Buy", rect: { x: 30, y: 40, width: 60, height: 20 } });
	assert.equal(canvas.document.getElementById("gd-popover").hidden, false);
	assert.equal(canvas.document.getElementById("gd-popover-target").textContent, "01-a.html · #cta");
	// The keyboard path is the same: Enter on another direction's shield opens it, Comment mode still on.
	canvas.document.getElementById("gd-back").dispatch("click");
	canvas.boards[1].shield!.dispatch("keydown", { key: "Enter" });
	assert.equal(canvas.navMode.textContent, "Using: Second · Shift+Esc to exit");
	assert.equal(pressed(canvas, "gd-comment"), "true");
});

test("canvas-ux S1: hovering a direction in the overview in Comment mode outlines and measures nothing; the shield hint names what a click does", async () => {
	const canvas = await loadUx();
	const [first] = canvas.boards;
	first.frame.rect = { left: 100, top: 100, width: 200, height: 150 };
	assert.equal(hintOf(first.shield!).textContent, "Click to use this design");
	assert.equal(first.shield!.getAttribute("aria-label"), "Use First");
	canvas.document.getElementById("gd-comment").dispatch("click");
	const before = first.frame.contentWindow!.posted.length;
	first.shield!.dispatch("pointermove", { pointerId: 1, clientX: 150, clientY: 130 });
	assert.deepEqual(first.frame.contentWindow!.posted.slice(before), [], "no hover is routed to the artboard: no element box, no inspector");
	assert.equal(hintOf(first.shield!).textContent, "Click to open and comment");
	assert.equal(first.shield!.getAttribute("aria-label"), "Open First to comment");
	assert.equal(canvas.navMode.textContent, "Click a direction to open it and comment · Esc");
	canvas.document.getElementById("gd-tool-navigate").dispatch("click");
	assert.equal(hintOf(first.shield!).textContent, "Click to use this design");
	assert.equal(first.shield!.getAttribute("aria-label"), "Use First");
	// The same in Spanish, following a switch.
	chooseLang(canvas as unknown as LangCanvas, "es");
	canvas.document.getElementById("gd-comment").dispatch("click");
	assert.equal(hintOf(first.shield!).textContent, "Haz clic para abrirla y comentar");
	assert.equal(first.shield!.getAttribute("aria-label"), "Abrir First para comentar");
	assert.equal(canvas.navMode.textContent, "Haz clic en una propuesta para abrirla y comentar · Esc");
	// canvas.css keeps the hint visible in Comment mode and shows the shield's hover like Navigate.
	const css = read("canvas.css");
	assert.ok(!/\.gd-commenting \.gd-shield-hint\s*{\s*display:\s*none/.test(css), "the hint is not hidden in Comment mode");
	assert.ok(!/\.gd-commenting \.gd-shield:hover\s*{[^}]*background:\s*transparent/.test(css), "the hover is not cleared in Comment mode");
});

test("canvas-ux S2: Technical details is off by default: no inspector panel on hover and no selector chips on comment, resolved, check and mix cards", async () => {
	const picks = { version: 1, picks: [{ id: "p1", file: "01-a.html", selector: "main > .card", excerpt: "Card", note: "", used: false }] };
	const canvas = await loadUx({ stored: { [MIX_KEY]: JSON.stringify(picks) }, replies: commentsDoc(comment("a1", "01-a.html"), comment("a2", "01-a.html", "resolved")) });
	const [first] = canvas.boards;
	const list = canvas.document.getElementById("gd-comment-list");
	assert.equal(technicalButton(canvas).getAttribute("aria-pressed"), "false");
	assert.deepEqual(texts(list, "gd-comment-text"), ["Text of a1"]);
	assert.deepEqual(texts(list, "gd-comment-selector"), [], "no selector on an open comment");
	canvas.document.getElementById("gd-filter-resolved").dispatch("click");
	assert.deepEqual(texts(list, "gd-comment-text"), ["Text of a2"]);
	assert.deepEqual(texts(list, "gd-comment-selector"), [], "no selector on a resolved comment");
	report_(canvas, first.frame, [finding()]);
	openChecks(canvas);
	assert.equal(checkCards(canvas).length, 1);
	assert.deepEqual(texts(checkCards(canvas)[0], "gd-check-selector"), [], "no selector on a check card");
	assert.deepEqual(texts(checkCards(canvas)[0], "gd-check-title"), ["Low contrast"]);
	canvas.document.getElementById("gd-tab-mix").dispatch("click");
	const mixCard = withClass(canvas.document.getElementById("gd-mix-groups"), "gd-mix-item")[0];
	assert.deepEqual(texts(mixCard, "gd-mix-selector"), [], "no selector on a mix card");
	assert.deepEqual(texts(mixCard, "gd-mix-excerpt"), ["“Card”"], "the excerpt stays");
	canvas.document.getElementById("gd-comment").dispatch("click");
	inspect(canvas, first.frame);
	assert.equal(panelOf(canvas).hidden, true, "no token inspector on hover");
	assert.equal(canvas.data.has(TECHNICAL_KEY), false, "nothing is written until it is switched");
});

test("canvas-ux S2: the Technical details toggle applies at once, both ways, and is saved in the browser", async () => {
	const canvas = await loadUx({ replies: commentsDoc(comment("a1", "01-a.html")) });
	const [first] = canvas.boards;
	const list = canvas.document.getElementById("gd-comment-list");
	canvas.document.getElementById("gd-comment").dispatch("click");
	technicalButton(canvas).dispatch("click");
	assert.equal(technicalButton(canvas).getAttribute("aria-pressed"), "true");
	assert.equal(canvas.data.get(TECHNICAL_KEY), "on");
	assert.deepEqual(texts(list, "gd-comment-selector"), ["main > .a1"], "the open list shows selectors at once");
	report_(canvas, first.frame, [finding()]);
	openChecks(canvas);
	assert.deepEqual(texts(checkCards(canvas)[0], "gd-check-selector"), ["main > p.or"]);
	inspect(canvas, first.frame);
	assert.equal(panelOf(canvas).hidden, false, "the token inspector shows on hover");
	technicalButton(canvas).dispatch("click");
	assert.equal(technicalButton(canvas).getAttribute("aria-pressed"), "false");
	assert.equal(canvas.data.get(TECHNICAL_KEY), "off");
	assert.equal(panelOf(canvas).hidden, true, "switching off closes the open panel");
	assert.deepEqual(texts(checkCards(canvas)[0], "gd-check-selector"), [], "and takes the selectors away at once");
	canvas.document.getElementById("gd-filter-open").dispatch("click");
	assert.deepEqual(texts(list, "gd-comment-selector"), []);
	inspect(canvas, first.frame);
	assert.equal(panelOf(canvas).hidden, true);

	const stored = await loadUx({ stored: { [TECHNICAL_KEY]: "on" }, replies: commentsDoc(comment("a1", "01-a.html")) });
	assert.equal(technicalButton(stored).getAttribute("aria-pressed"), "true", "a saved choice is kept across reloads");
	assert.deepEqual(texts(stored.document.getElementById("gd-comment-list"), "gd-comment-selector"), ["main > .a1"]);
	const odd = await loadUx({ stored: { [TECHNICAL_KEY]: "yes" } });
	assert.equal(technicalButton(odd).getAttribute("aria-pressed"), "false", "an unknown value means off");
	const broken = await loadUx({ broken: true, replies: commentsDoc(comment("a1", "01-a.html")) });
	assert.equal(technicalButton(broken).getAttribute("aria-pressed"), "false", "storage that throws means off");
	technicalButton(broken).dispatch("click");
	assert.equal(technicalButton(broken).getAttribute("aria-pressed"), "true", "and the toggle still works for this page");
	assert.deepEqual(texts(broken.document.getElementById("gd-comment-list"), "gd-comment-selector"), ["main > .a1"]);
});

test("canvas-ux S2: the toggle is a named, pressed button in the top bar with an icon and a label in both languages", async () => {
	const html = read("index.html");
	const bar = html.slice(html.indexOf('<header class="gd-bar"'), html.indexOf("</header>"));
	const button = /<button type="button" id="gd-technical"([^>]*)>([^]*?)<\/button>/.exec(bar);
	assert.ok(button, "the toggle is a button in the top bar");
	assert.match(button![1], /aria-pressed="false"/);
	assert.match(button![2], /<svg class="gd-i[^"]*" aria-hidden="true"><use href="#i-[a-z-]+"\/><\/svg>/);
	assert.match(button![2], /<span data-i18n="technical.label">Technical details<\/span>/);
	const { en, es } = loadCatalog();
	assert.equal(en["technical.label"], "Technical details");
	assert.equal(es["technical.label"], "Detalles técnicos");
	assert.match(button![1], /title="Selectors and the token inspector" data-i18n-title="technical.title"/);
	const canvas = await loadUx({ browser: "es-ES" });
	assert.equal(technicalButton(canvas).title, "Selectores e inspector de tokens");
	assert.ok(canvas.document.querySelectorAll("[data-i18n]").some((element) => element.getAttribute("data-i18n") === "technical.label" && element.textContent === "Detalles técnicos"));
	assert.match(read("canvas.css"), /\.gd-technical\[aria-pressed="true"\][^{]*{[^}]*var\(--accent/);
});

// ---- canvas-ux-quick-wins T2: plain wording (S3), one Comments tab with a filter (S4) ----

const tabIds = ["gd-tab-comments", "gd-tab-history", "gd-tab-checks", "gd-tab-mix", "gd-tab-brief"];
const selectedTabs = (canvas: Canvas) => tabIds.filter((id) => canvas.document.getElementById(id).getAttribute("aria-selected") === "true");
const filterState = (canvas: Canvas) => ["gd-filter-open", "gd-filter-resolved"].map((id) => `${canvas.document.getElementById(id).textContent}=${canvas.document.getElementById(id).getAttribute("aria-pressed")}`);
const pendingLine = (canvas: Canvas) => canvas.document.getElementById("gd-send-pending");

test("canvas-ux S3: plain words: Accessible ✓, Original request, Save to send later and Directions, in English and Spanish", async () => {
	const { en, es } = loadCatalog();
	const words: Array<[string, string, string]> = [
		["a11y.ok", "Accessible ✓", "Accesible ✓"],
		["tab.brief", "Original request", "Petición original"],
		["panel.collect", "Save to send later", "Guardar para enviar luego"],
		["nav.title", "Directions · {count}", "Propuestas · {count}"],
		["viewport.label", "Directions", "Propuestas"],
		["rail.list", "Direction list", "Lista de propuestas"],
		["panel.footIntro", "Your comments go to the agent so it changes the design", "Tus comentarios se envían al agente para que cambie el diseño"],
	];
	for (const [key, english, spanish] of words) {
		assert.equal(en[key], english, key);
		assert.equal(es[key], spanish, key);
	}
	for (const old of ["A11y", "Encargo", "encargo", "Acumular", "Artboards ·"]) assert.ok(!Object.values(es).some((text) => text.includes(old)), `no Spanish text says ${old}`);
	for (const old of ["A11y", "Collect", "Artboards ·"]) assert.ok(!Object.values(en).some((text) => text.includes(old)), `no English text says ${old}`);

	const canvas = await loadUx();
	const [first] = canvas.boards;
	report_(canvas, first.frame, []);
	assert.equal(withClass(canvas.document.getElementById("gd-nav-list"), "gd-nav-a11y")[0].textContent, "Accessible ✓");
	assert.equal(canvas.document.getElementById("gd-nav-title").textContent, "Directions · 2");
	const staticTexts = canvas.document.querySelectorAll("[data-i18n]").map((element) => element.textContent);
	for (const text of ["Original request", "Save to send later", "Your comments go to the agent so it changes the design"]) assert.ok(staticTexts.includes(text), text);
	chooseLang(canvas as unknown as LangCanvas, "es");
	assert.equal(withClass(canvas.document.getElementById("gd-nav-list"), "gd-nav-a11y")[0].textContent, "Accesible ✓");
	assert.equal(canvas.document.getElementById("gd-nav-title").textContent, "Propuestas · 2");
	const spanish = canvas.document.querySelectorAll("[data-i18n]").map((element) => element.textContent);
	for (const text of ["Petición original", "Guardar para enviar luego", "Tus comentarios se envían al agente para que cambie el diseño"]) assert.ok(spanish.includes(text), text);
	canvas.document.getElementById("gd-tab-brief").dispatch("click");
	assert.equal(canvas.document.getElementById("gd-brief-text").textContent, "Aún no se ha escrito la petición original.");
});

test("canvas-ux S3: the footer says where comments go and how many wait to be sent, plural-safe and hidden at 0", async () => {
	const sent = "2026-10-26T10:00:00.000Z";
	const canvas = await loadUx({ replies: commentsDoc(comment("a1", "01-a.html"), comment("a2", "01-a.html"), comment("a3", "01-a.html", "open", { sentAt: sent }), comment("a4", "01-a.html", "resolved")) });
	assert.equal(canvas.document.getElementById("gd-send-intro").hidden, false);
	assert.equal(canvas.document.getElementById("gd-send-intro").textContent, "Your comments go to the agent so it changes the design");
	assert.equal(pendingLine(canvas).hidden, false);
	assert.equal(pendingLine(canvas).textContent, "2 waiting to be sent", "open and unsent only");
	await setComments(canvas, comment("a1", "01-a.html"), comment("a2", "01-a.html", "open", { sentAt: sent }));
	assert.equal(pendingLine(canvas).textContent, "1 waiting to be sent");
	chooseLang(canvas as unknown as LangCanvas, "es");
	assert.equal(pendingLine(canvas).textContent, "1 pendiente de enviar");
	await setComments(canvas, comment("a1", "01-a.html"), comment("a2", "01-a.html"));
	assert.equal(pendingLine(canvas).textContent, "2 pendientes de enviar");
	await setComments(canvas, comment("a1", "01-a.html", "open", { sentAt: sent }));
	assert.equal(pendingLine(canvas).hidden, true, "nothing waiting, nothing said");
	const html = read("index.html");
	const foot = html.slice(html.indexOf('<div class="gd-side-foot">'), html.indexOf("</aside>", html.indexOf('<div class="gd-side-foot">')));
	assert.match(foot, /<p id="gd-send-intro" class="gd-send-intro" data-i18n="panel.footIntro">Your comments go to the agent so it changes the design<\/p>/);
	assert.match(foot, /<p id="gd-send-pending" class="gd-send-pending" role="status" aria-live="polite" hidden><\/p>/);
	assert.ok(foot.indexOf("gd-send-intro") < foot.indexOf("gd-sendmode"), "the sentence leads the footer");
});

test("canvas-ux S4: one Comments tab counts the open comments, with an Open / Resolved filter, Open by default", async () => {
	const canvas = await loadUx({ replies: commentsDoc(comment("a1", "01-a.html"), comment("a2", "01-a.html", "resolved"), comment("a3", "02-b.html")) });
	const doc = canvas.document;
	const list = doc.getElementById("gd-comment-list");
	assert.deepEqual(selectedTabs(canvas), ["gd-tab-comments"]);
	assert.equal(doc.getElementById("gd-count-open").textContent, "2", "the tab counts open comments");
	assert.equal(doc.getElementById("gd-comment-filter").hidden, false);
	assert.deepEqual(filterState(canvas), ["Open (2)=true", "Resolved (1)=false"]);
	assert.deepEqual(texts(list, "gd-comment-text"), ["Text of a1", "Text of a3"]);
	doc.getElementById("gd-filter-resolved").dispatch("click");
	assert.deepEqual(filterState(canvas), ["Open (2)=false", "Resolved (1)=true"]);
	assert.deepEqual(selectedTabs(canvas), ["gd-tab-comments"], "the filter is not a tab");
	assert.deepEqual(texts(list, "gd-comment-text"), ["Text of a2"]);
	// Reopen works from the filter as it did from the Resolved tab.
	findAll(list, (element) => element.localName === "button" && element.textContent === "Reopen")[0].dispatch("click");
	await flush();
	assert.deepEqual(canvas.posts.filter((post) => post.url.endsWith("/comments/a2/status")).map((post) => post.body), [{ status: "open" }]);
	await setComments(canvas, comment("a1", "01-a.html"), comment("a2", "01-a.html"));
	assert.deepEqual(filterState(canvas), ["Open (2)=false", "Resolved (0)=true"]);
	assert.equal(doc.getElementById("gd-panel-empty").hidden, false);
	assert.equal(doc.getElementById("gd-panel-empty").textContent, "No resolved comments.");
	doc.getElementById("gd-filter-open").dispatch("click");
	assert.deepEqual(texts(list, "gd-comment-text"), ["Text of a1", "Text of a2"]);
	// The filter belongs to the Comments tab only.
	doc.getElementById("gd-tab-history").dispatch("click");
	assert.equal(doc.getElementById("gd-comment-filter").hidden, true);
	// Spanish, live.
	doc.getElementById("gd-tab-comments").dispatch("click");
	chooseLang(canvas as unknown as LangCanvas, "es");
	assert.deepEqual(filterState(canvas), ["Abiertos (2)=true", "Resueltos (0)=false"]);
	assert.equal(doc.getElementById("gd-comment-filter").getAttribute("aria-label"), "Mostrar comentarios");
	const html = read("index.html");
	assert.equal([...html.matchAll(/role="tab"/g)].length, 5, "five tabs: Comments, History, Checks, Mix, Original request");
	assert.ok(!/id="gd-count-resolved"/.test(html), "no Resolved tab count");
	assert.match(html, /<button type="button" role="tab" id="gd-tab-comments"[^>]*aria-selected="true"[^>]*><span data-i18n="tab.comments">Comments<\/span> <span id="gd-count-open" class="gd-count">0<\/span><\/button>/);
	assert.match(html, /<div id="gd-comment-filter" class="gd-devices gd-comment-filter" role="group" aria-label="Show comments" data-i18n-aria-label="filter.label">\s*<button type="button" id="gd-filter-open" class="gd-size-button" aria-pressed="true"[^>]*>[^<]*<\/button>\s*<button type="button" id="gd-filter-resolved" class="gd-size-button" aria-pressed="false"[^>]*>[^<]*<\/button>\s*<\/div>/);
});

test("canvas-ux S4: a pin opens the Comments tab with its comment's filter and focuses its card; arrow keys move over five tabs", async () => {
	const canvas = await loadUx({ replies: commentsDoc(comment("a1", "01-a.html"), comment("a2", "01-a.html", "resolved")) });
	const doc = canvas.document;
	const [first] = canvas.boards;
	canvas.message(first.frame.contentWindow, { type: "gd:pin-rects", rects: [{ id: "a1", rect: { x: 10, y: 10, width: 20, height: 20 } }, { id: "a2", rect: { x: 50, y: 50, width: 20, height: 20 } }] });
	const pin = (id: string) => withClass(first.wrapper, "gd-pin").find((element) => element.dataset.id === id)!;
	doc.getElementById("gd-tab-checks").dispatch("click");
	pin("a2").dispatch("click");
	assert.deepEqual(selectedTabs(canvas), ["gd-tab-comments"]);
	assert.deepEqual(filterState(canvas), ["Open (1)=false", "Resolved (1)=true"]);
	const list = doc.getElementById("gd-comment-list");
	assert.deepEqual(texts(list, "gd-comment-text"), ["Text of a2"]);
	assert.ok(list.children[0].contains(doc.activeElement), "keyboard focus is on its card");
	pin("a1").dispatch("click");
	assert.deepEqual(filterState(canvas), ["Open (1)=true", "Resolved (1)=false"]);
	assert.deepEqual(texts(list, "gd-comment-text"), ["Text of a1"]);

	const tablist = doc.getElementById("gd-tabs");
	tablist.dispatch("keydown", { key: "ArrowRight" });
	assert.deepEqual(selectedTabs(canvas), ["gd-tab-history"], "Comments is followed by History");
	tablist.dispatch("keydown", { key: "End" });
	assert.deepEqual(selectedTabs(canvas), ["gd-tab-brief"]);
	tablist.dispatch("keydown", { key: "ArrowRight" });
	assert.deepEqual(selectedTabs(canvas), ["gd-tab-comments"], "and it wraps around");
	assert.equal(doc.activeElement, doc.getElementById("gd-tab-comments"));
	assert.equal(doc.getElementById("gd-tabpanel").getAttribute("aria-labelledby"), "gd-tab-comments");
	assert.equal(doc.getElementById("gd-tab-comments").getAttribute("tabindex"), "0");
});

test("canvas-ux S5: the docs describe commenting inside a direction and the Technical details toggle", () => {
	const docs = readFileSync(fileURLToPath(new URL("../docs/gentle-shell.md", import.meta.url)), "utf8");
	const section = docs.slice(docs.indexOf("### Gentle Design"));
	for (const part of ["\"Click to open and comment\"", "**Click a direction to open it and comment · Esc**", "**Technical details**", "`gentle-design:technical`", "Comment mode still on"]) assert.ok(section.includes(part), `docs mention ${part}`);
	assert.ok(!section.includes("**Click an element to comment · Esc**"), "the old chip text is gone");
	assert.ok(!section.includes("a click picks an element instead of entering focus mode"), "the old overview behavior is gone");
});

test("canvas-ux S5: the docs and the README use the plain words, the footer sentence and the one Comments tab", () => {
	const docs = readFileSync(fileURLToPath(new URL("../docs/gentle-shell.md", import.meta.url)), "utf8");
	const section = docs.slice(docs.indexOf("### Gentle Design"));
	for (const part of ["**Original request**", "**Save to send later**", "`Accessible ✓`", "**Directions · N**", "**Open (N)**", "**Resolved (N)**", "\"Your comments go to the agent so it changes the design\"", "**N waiting to be sent**"]) assert.ok(section.includes(part), `docs mention ${part}`);
	for (const old of ["**Collect**", "A11y ✓", "**Resolved**, **History**", "Resolved tab", "Comments and Resolved tabs", "**Brief** tabs"]) assert.ok(!section.includes(old), `docs no longer say ${old}`);
	const readme = readFileSync(fileURLToPath(new URL("../README.md", import.meta.url)), "utf8");
	const row = readme.split("\n").find((line) => line.startsWith("| Gentle Design |"))!;
	for (const part of ["opens it in focus", "Technical details", "Original request", "Save to send later", "Open / Resolved"]) assert.ok(row.includes(part), `the README row mentions ${part}`);
});
