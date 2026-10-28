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
	parentElement: FakeElement | null = null;
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
	rect: Rect = { left: 0, top: 0, width: 0, height: 0 };
	contentWindow: { posted: any[]; postMessage(message: any): void } | null = null;
	doc: FakeDocument;

	constructor(tag: string, doc: FakeDocument) {
		this.localName = tag;
		this.doc = doc;
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

async function loadCanvas(firstHeight = 300, extraReplies: Record<string, unknown> = {}, config: Record<string, unknown> = {}) {
	const document = new FakeDocument();
	document.getElementById("gd-config").textContent = JSON.stringify({ base: "/t/", slug: "alpha", ...config });
	// Hidden in index.html until a delivery problem is shown.
	for (const id of ["gd-send-note", "gd-send-alert"]) document.getElementById(id).hidden = true;
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
		requestAnimationFrame: () => 0,
		MutationObserver: class { observe() {} },
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
	return { posted, fire, fromParent };
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
async function loadRail(firstHeight = 300, extraReplies: Record<string, unknown> = {}, config: Record<string, unknown> = {}) {
	const canvas = await loadCanvas(firstHeight, extraReplies, config);
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

test("the review side has Comments, Resolved and Brief tabs that drive the list", async () => {
	const canvas = await loadRail(300, { ...commentsDoc(comment("a1", "01-a.html"), comment("a2", "02-b.html", "resolved", { sentAt: "2026-10-26T10:00:00.000Z" })), "/t/api/designs/alpha": { slug: "alpha", title: "Alpha", brief: "Make a checkout.", feature: "odd/tasks/checkout.md", artboards: [{ file: "01-a.html", title: "First", tradeoff: "", width: 400, height: 300 }, { file: "02-b.html", title: "Second", tradeoff: "", width: 400, height: 300 }] } });
	const doc = canvas.document;
	const tabs = ["gd-filter-open", "gd-filter-resolved", "gd-tab-brief"];
	const selected = () => tabs.map((id) => doc.getElementById(id).getAttribute("aria-selected"));
	const list = doc.getElementById("gd-comment-list");
	const brief = doc.getElementById("gd-brief");
	assert.deepEqual(selected(), ["true", "false", "false"]);
	assert.equal(doc.getElementById("gd-count-open").textContent, "1");
	assert.equal(doc.getElementById("gd-count-resolved").textContent, "1");
	assert.equal(brief.hidden, true);
	assert.deepEqual(texts(list, "gd-comment-text"), ["Text of a1"]);

	doc.getElementById("gd-filter-resolved").dispatch("click");
	assert.deepEqual(selected(), ["false", "true", "false"]);
	assert.deepEqual(texts(list, "gd-comment-text"), ["Text of a2"]);

	doc.getElementById("gd-tab-brief").dispatch("click");
	assert.deepEqual(selected(), ["false", "false", "true"]);
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
	assert.deepEqual(selected(), ["true", "false", "false"]);
	assert.equal(doc.activeElement, doc.getElementById("gd-filter-open"));
	assert.equal(doc.getElementById("gd-filter-open").getAttribute("tabindex"), "0");
	assert.equal(doc.getElementById("gd-tab-brief").getAttribute("tabindex"), "-1");
	tablist.dispatch("keydown", { key: "End" });
	assert.deepEqual(selected(), ["false", "false", "true"]);
	tablist.dispatch("keydown", { key: "ArrowLeft" });
	assert.deepEqual(selected(), ["false", "true", "false"]);
	assert.equal(brief.hidden, true);
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

test("the T2 markup: tablist with three tabs, tabpanel, timeline region, Compare with app and the navigator note", () => {
	const html = read("index.html");
	assert.match(html, /role="tablist"/);
	assert.equal([...html.matchAll(/role="tab"/g)].length, 3);
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

test("S13: a failed Implement this shows the alert in that artboard's implement control, plus the toast", async () => {
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
	assert.match(canvas.document.getElementById("gd-toast").textContent, /not connected to a Pi session/, "the toast repeats it");
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
	assert.equal(canvas.document.getElementById("gd-toast").textContent, text);
});
