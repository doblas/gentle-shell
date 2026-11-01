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
	scrollIntoView() {}
}

class FakeDocument {
	activeElement: FakeElement | null = null;
	body: FakeElement;
	documentElement: FakeElement;
	title = "";
	byId = new Map<string, FakeElement>();
	listeners = new Map<string, Listener[]>();

	constructor() {
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
	querySelectorAll() { return []; }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

async function loadCanvas(firstHeight = 300, extraReplies: Record<string, unknown> = {}, config: Record<string, unknown> = {}, extraContext: Record<string, unknown> = {}) {
	const document = new FakeDocument();
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
			return { ok: status < 400, status, json: async () => reply ?? {} };
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
	vm.runInNewContext(read("canvas.js"), context);
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

test("a drag over an artboard pans the canvas, and in comment mode a click is routed to the inspector as a pick", async () => {
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
	assert.equal(canvas.navMode.textContent, "Click an element to comment · Esc", "comment mode picks instead of focusing");
	// The frame shows a 400x300 artboard at half size: (150-100)/0.5, (130-100)/0.5.
	assert.deepEqual(first.frame.contentWindow!.posted.at(-1), { type: "gd:pick-at", x: 100, y: 60 });
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

test("the chosen artboard gets a Chosen badge and an accent frame; the others are labeled Alternative", async () => {
	const canvas = await loadCanvas(300, { "/t/api/designs/alpha/handoffs": handoffDoc(null, {}) });
	for (const board of boardsOf(canvas)) {
		assert.deepEqual(texts(board, "gd-choice"), [], "nothing is chosen yet");
		assert.equal(board.classes.has("gd-chosen"), false);
	}
	await setHandoffs(canvas, handoffDoc("02-b.html", { "02-b.html": {} }));
	const [first, second] = boardsOf(canvas);
	assert.deepEqual(texts(second, "gd-choice"), ["Chosen"]);
	assert.equal(second.classes.has("gd-chosen"), true);
	assert.deepEqual(texts(first, "gd-choice"), ["Alternative"]);
	assert.equal(first.classes.has("gd-chosen"), false);
	await setHandoffs(canvas, handoffDoc("01-a.html", { "02-b.html": {}, "01-a.html": {} }));
	assert.deepEqual(boardsOf(canvas).map((board) => texts(board, "gd-choice")[0]), ["Chosen", "Alternative"], "a new handoff moves Chosen");
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
	assert.deepEqual(texts(boardsOf(canvas)[1], "gd-choice"), ["Alternative"]);

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
const COMMENT_CHIP = "Click an element to comment · Esc";

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
	assert.equal(canvas.navMode.textContent, COMMENT_CHIP, "a routed pick, not focus, in comment mode");
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
	assert.equal(canvas.document.getElementById("gd-nav-title").textContent, "Artboards · 2");
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
	assert.equal(canvas.document.getElementById("gd-nav-title").textContent, "Artboards · 2");
	assert.deepEqual(navTexts(canvas, "gd-nav-item-title"), ["01 First", "02 Second"]);
	// Open comments first, then resolved; either alone stands alone; none says so.
	assert.deepEqual(navTexts(canvas, "gd-nav-summary"), ["2 open comments · 1 resolved", "1 resolved"]);
	assert.equal(withClass(navItems(canvas)[0], "gd-nav-thumb").length, 1, "each item has a thumbnail block");

	await setComments(canvas, comment("a1", "01-a.html"));
	assert.deepEqual(navTexts(canvas, "gd-nav-summary"), ["1 open comment", "No comments"], "the summary follows comments.json live");
	await setComments(canvas);
	assert.deepEqual(navTexts(canvas, "gd-nav-summary"), ["No comments", "No comments"]);
});

test("the navigator tags Chosen and Alternative only once an artboard is chosen, live", async () => {
	const canvas = await loadRail();
	assert.deepEqual(navTexts(canvas, "gd-nav-tag"), [], "no tags without a chosen artboard");
	await setHandoffs(canvas, handoffDoc("02-b.html", { "02-b.html": {} }));
	assert.deepEqual(navTexts(canvas, "gd-nav-tag"), ["Alternative", "Chosen"]);
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
	assert.equal(withSystem.document.getElementById("gd-nav-title").textContent, "Artboards · 2", "the system board is not counted");
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
	assert.deepEqual(navTexts(canvas, "gd-nav-tag"), ["Alternative", "Chosen"]);
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

test("the review side has Comments, Resolved, History, Checks and Brief tabs that drive the list", async () => {
	const canvas = await loadRail(300, { ...commentsDoc(comment("a1", "01-a.html"), comment("a2", "02-b.html", "resolved", { sentAt: "2026-10-26T10:00:00.000Z" })), "/t/api/designs/alpha": { slug: "alpha", title: "Alpha", brief: "Make a checkout.", feature: "odd/tasks/checkout.md", artboards: [{ file: "01-a.html", title: "First", tradeoff: "", width: 400, height: 300 }, { file: "02-b.html", title: "Second", tradeoff: "", width: 400, height: 300 }] } });
	const doc = canvas.document;
	const tabs = ["gd-filter-open", "gd-filter-resolved", "gd-tab-history", "gd-tab-checks", "gd-tab-brief"];
	const selected = () => tabs.map((id) => doc.getElementById(id).getAttribute("aria-selected"));
	const list = doc.getElementById("gd-comment-list");
	const brief = doc.getElementById("gd-brief");
	assert.deepEqual(selected(), ["true", "false", "false", "false", "false"]);
	assert.equal(doc.getElementById("gd-count-open").textContent, "1");
	assert.equal(doc.getElementById("gd-count-resolved").textContent, "1");
	assert.equal(brief.hidden, true);
	assert.deepEqual(texts(list, "gd-comment-text"), ["Text of a1"]);

	doc.getElementById("gd-filter-resolved").dispatch("click");
	assert.deepEqual(selected(), ["false", "true", "false", "false", "false"]);
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
	assert.equal(doc.activeElement, doc.getElementById("gd-filter-open"));
	assert.equal(doc.getElementById("gd-filter-open").getAttribute("tabindex"), "0");
	assert.equal(doc.getElementById("gd-tab-brief").getAttribute("tabindex"), "-1");
	tablist.dispatch("keydown", { key: "End" });
	assert.deepEqual(selected(), ["false", "false", "false", "false", "true"]);
	tablist.dispatch("keydown", { key: "ArrowLeft" });
	assert.deepEqual(selected(), ["false", "false", "false", "true", "false"], "Checks sits between History and Brief");
	assert.equal(brief.hidden, true);
	assert.equal(doc.getElementById("gd-checks").hidden, false);
});

test("the Brief tab says so when the design has no brief, and keeps the Send footer", async () => {
	const canvas = await loadRail();
	canvas.document.getElementById("gd-tab-brief").dispatch("click");
	assert.equal(canvas.document.getElementById("gd-brief-title").textContent, "Alpha");
	assert.equal(canvas.document.getElementById("gd-brief-text").textContent, "No brief written.");
	assert.equal(canvas.document.getElementById("gd-brief-feature").hidden, true);
	assert.equal(canvas.document.getElementById("gd-send-all").disabled, true, "the footer stays under every tab");
});

test("a comment card shows its number, selector chip, waiting or sent state, text and actions", async () => {
	const canvas = await loadRail(300, commentsDoc(comment("a1", "01-a.html"), comment("a2", "01-a.html", "open", { sentAt: "2026-10-26T10:00:00.000Z", screenshot: { path: "x.png", mimeType: "image/png" } })));
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

test("the T2 markup: tablist with five tabs, tabpanel, timeline region, Compare with app and the navigator note", () => {
	const html = read("index.html");
	assert.match(html, /role="tablist"/);
	assert.equal([...html.matchAll(/role="tab"/g)].length, 5);
	assert.match(html, /id="gd-filter-open"[^>]*role="tab"|role="tab"[^>]*id="gd-filter-open"/);
	assert.match(html, /role="tabpanel"/);
	assert.match(html, /<section id="gd-handoff-panel"[^>]*aria-labelledby="gd-handoff-title"/);
	assert.match(html, /id="gd-compare-app"[^>]*hidden>.*Compare with app<\/button>/);
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

type PageSpec = { tag: string; attrs?: Record<string, string>; style?: Record<string, string>; size?: [number, number]; text?: string; kids?: PageSpec[] };

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
		node.getBoundingClientRect = () => ({ left: 8, top: 8 + node.index * 30, width: node.size[0], height: node.size[1] });
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
	assert.match(texts(checksPanel(canvas), "gd-check-summary")[0], /A11y ✓/);
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

test("S4: each artboard's list item carries A11y ✓ or N checks; none before the artboard has reported", async () => {
	const canvas = await loadRail();
	const [first, second] = canvas.boards;
	assert.deepEqual(navA11y(canvas), []);
	report_(canvas, first.frame, []);
	report_(canvas, second.frame, [finding(), finding({ selector: "#b" }), finding({ check: "target", severity: "advice", selector: "#c" })]);
	assert.deepEqual(navA11y(canvas).map((tag) => tag.textContent), ["A11y ✓", "2 checks"]);
	assert.deepEqual(navA11y(canvas).map((tag) => tag.dataset.state), ["ok", "warn"]);
	assert.match(navA11y(canvas)[1].title, /Checks tab/);
	assert.match(navA11y(canvas)[0].title, /heuristics/i);
	report_(canvas, second.frame, [finding()]);
	assert.equal(navA11y(canvas)[1].textContent, "1 check", "singular");
	// A chosen tag and the checks tag live side by side.
	await setHandoffs(canvas, handoffDoc("02-b.html", { "02-b.html": {} }));
	assert.deepEqual(navTexts(canvas, "gd-nav-tag"), ["Alternative", "Chosen"]);
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
	assert.equal(navA11y(canvas)[0].textContent, "A11y ✓");
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
	assert.match(html, /<button type="button" role="tab" id="gd-tab-checks" class="gd-tab" aria-selected="false" aria-controls="gd-tabpanel" tabindex="-1">Checks <span id="gd-count-checks" class="gd-count">0<\/span><\/button>/);
	assert.ok(html.indexOf('id="gd-filter-resolved"') < html.indexOf('id="gd-tab-checks"') && html.indexOf('id="gd-tab-checks"') < html.indexOf('id="gd-tab-brief"'));
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

test("S2: the History tab sits after Resolved with its own count, and arrow keys reach it with five tabs", async () => {
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
	assert.equal(canvas.document.getElementById("gd-filter-resolved").getAttribute("aria-selected"), "true");
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
	assert.match(html, /<button type="button" role="tab" id="gd-tab-history" class="gd-tab" aria-selected="false" aria-controls="gd-tabpanel" tabindex="-1">History <span id="gd-count-history" class="gd-count">0<\/span><\/button>/);
	assert.ok(html.indexOf('id="gd-filter-resolved"') < html.indexOf('id="gd-tab-history"') && html.indexOf('id="gd-tab-history"') < html.indexOf('id="gd-tab-checks"'));
	assert.match(html, /<div id="gd-history" class="gd-history" hidden><\/div>/);
	assert.match(html, /<section id="gd-versions" class="gd-versions" aria-labelledby="gd-versions-title" hidden>/);
	assert.match(html, /<div class="gd-devices gd-versions-mode" role="group" aria-label="Comparison mode">/);
	assert.match(html, /id="gd-versions-mode-slider"[^>]*aria-pressed="true">Slider</);
	assert.match(html, /id="gd-versions-mode-side"[^>]*aria-pressed="false">Side by side</);
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

test("S2: five tabs never squeeze their labels into each other: the tab row scrolls instead", () => {
	const css = read("canvas.css");
	assert.match(css, /\.gd-tabs\s*{[^}]*overflow-x:\s*auto/);
	assert.match(css, /\.gd-tab\s*{[^}]*flex:\s*none/);
});
