// Gentle Design canvas: artboards side by side with pan, zoom, live reload,
// and comments persisted in design/<slug>/comments.json (pins, list, send modes).
// design/system.html, when present, is the first board of every design; it is
// kept out of state.boards so comments never apply to it.
// Artboards run in iframes sandboxed with scripts only, so each one has an opaque
// origin; messages are trusted only by matching event.source to a known artboard.
// Navigation mode (the default) covers every artboard with a shield, so the wheel,
// drags and clicks always reach the canvas; a click on a shield enters focus mode,
// which shows that artboard at 100% and lets it own the pointer and the keyboard
// until "Back to canvas" or Shift+Esc restores the previous view.
// A left tool rail (Navigate, Comment, Overview, artboard list, design system, shortcuts) and the
// single-key shortcuts behind it; the mode chip in the viewport names the active mode.
// Handoffs (design/<slug>/handoffs.json) show live on each artboard's header: the
// handoff state, the chosen artboard and its alternatives, and, once implemented
// with a loopback previewUrl, a Compare view of the artboard next to the running app.
(() => {
	"use strict";

	const config = JSON.parse(document.getElementById("gd-config").textContent);
	const base = String(config.base);
	const MIN_ZOOM = 0.05;
	const MAX_ZOOM = 4;
	const FIT_PADDING = 48;
	const FOCUS_MARGIN = 16;
	// Room below a focused artboard for the floating "Back to canvas" button.
	const BACK_SPACE = 64;
	const CLICK_SLOP = 4;
	const LIMITS = { selector: 500, excerpt: 300, comment: 2000, pins: 500, tokens: 500, versions: 50, historyArtboards: 256, screenshotBytes: 5 * 1024 * 1024 };
	const SCREENSHOT_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];
	const MODE_KEY = "gentle-design:send-mode";
	const SYSTEM_LABEL = { title: "Design system", tradeoff: "Project tokens (design/system.md)" };
	const SYSTEM_NOTE = "Comments apply to design artboards only. To change the system, update the project's design sources and run /gentle:design sync.";
	const HANDOFF_LABELS = { queued: "Queued", sent: "Implementing…", in_progress: "In progress", implemented: "Implemented ✓" };
	const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "[::1]"];
	const MAX_PREVIEW_URL = 2048;
	// The running app is another loopback origin (previewTarget refuses this server's own
	// port), so the same-origin flag below gives the app its own origin, never the canvas's: it cannot
	// reach this page, its token or its API, and its scripts, storage and forms work as in
	// production. No top-navigation flag is granted, so it can never navigate the canvas away.
	const PREVIEW_SANDBOX = "allow-scripts allow-same-origin allow-forms allow-popups";
	const PREVIEW_TIMEOUT_MS = 6000;
	const PREVIEW_HINT = "If the app refuses to be framed, use Open in new tab.";
	// CSP host sources have no IPv6 literal form, so Chromium drops the [::1] source from frame-src.
	const IPV6_HINT = "Browsers do not frame [::1] under the canvas policy (CSP has no IPv6 sources): use Open in new tab, or report the preview on localhost.";
	// Below this on-screen artboard width, the screen-size handoff row and Implement this would
	// overlap the next artboard: they collapse, and the navigator and the timeline carry the state.
	const COMPACT_BOARD_WIDTH = 360;
	const COMPARE_GAP = 24;
	const COMPARE_PADDING = 24;
	// Screen sizes in focus mode. Desktop is the artboard's own manifest size; the custom width is whole
	// CSS px in this range with the manifest height; All sizes leaves a gap between frames and a band for each label.
	const SIZE_PRESETS = [
		{ kind: "phone", label: "Phone", icon: "i-phone", width: 390, height: 844 },
		{ kind: "tablet", label: "Tablet", icon: "i-tablet", width: 820, height: 1180 },
		{ kind: "desktop", label: "Desktop", icon: "i-monitor", manifest: true },
	];
	const CUSTOM_WIDTH = { min: 240, max: 2560 };
	// What comments.json accepts for the size a comment was made at (lib/design-comments.ts).
	const VIEWPORT_LIMITS = { minWidth: 240, maxWidth: 4096, minHeight: 1, maxHeight: 20000 };
	const SIZES_GAP = 20;
	const SIZES_HEAD = 28;
	const MIN_SIZES_SCALE = 0.05;
	const TOAST_MS = 5000;
	// What the server can deliver; an older page config without it means everything.
	const DELIVERY = { comment: true, batch: true, implement: true, ...(config.delivery && typeof config.delivery === "object" ? config.delivery : {}) };
	const OPEN_HINT = "open the canvas from your session with /gentle:design open";
	// Every reason code the canvas routes can answer: the cause and the way out. The raw code stays as the detail.
	const REASONS = {
		"batch-delivery-unavailable": `This canvas is not connected to a Pi session, so comments cannot be sent. They stay saved; ${OPEN_HINT}, then use Send all.`,
		"implement-unavailable": `This canvas is not connected to a Pi session, so it cannot hand the artboard off. ${OPEN_HINT[0].toUpperCase()}${OPEN_HINT.slice(1)}.`,
		"delivery-failed": "The session did not accept the message. Your comments stay saved and unsent; check that the session is running, then try again.",
		"too-many-comments": "This design has too many comments. Resolve or delete some in comments.json, then try again.",
		"too-many-handoffs": "This design has too many handoffs recorded. Remove old ones from handoffs.json, then try again.",
		"invalid-comments": "comments.json for this design is not valid, so it cannot be changed. Fix or remove the file, then try again.",
		"invalid-handoffs": "handoffs.json for this design is not valid, so it cannot be changed. Fix or remove the file, then try again.",
		"invalid-history": "The version history of this design cannot be used right now (its index or a version file is damaged, or the artboard is a link), so nothing was changed. Fix or remove what the detail names under .history, then try again.",
		"history-limit": "The history index is full, so this change was not recorded. Delete old versions from .history to make room, then try again.",
		"invalid-comment": "This comment was rejected by the server. Write 1 to 2000 characters and try again.",
		"invalid-handoff": "This handoff was rejected by the server. Reload the canvas and try again.",
		"invalid-screenshot": "The screenshot was rejected. Attach a PNG, JPEG, WebP or GIF image of at most 5 MB, or remove it.",
		"body-too-large": "The request was too large. Remove the screenshot or shorten the comment, then try again with something smaller.",
		"file-too-large": "That file is too large for the canvas to show. Make the artboard or asset smaller.",
		"not-found": "That item no longer exists. Reload the canvas to see the current state.",
		"too-many-streams": "Too many canvas tabs are open. Close the ones you do not use, then reload this one.",
		internal: `An unexpected error happened in the canvas server. Try again; if it keeps failing, reopen it: ${OPEN_HINT}.`,
		forbidden: "The server refused this request. Reload the canvas page, or reopen it with /gentle:design open.",
		misdirected: "The server refused this request. Reload the canvas page, or reopen it with /gentle:design open.",
		network: `The canvas could not reach its server; it may have been stopped. Reopen it: ${OPEN_HINT}.`,
	};
	const COMMENT_CHIP = "Click an element to comment · Esc";
	const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
	const TAB_NAMES = ["open", "resolved", "history", "checks", "brief"];

	const $ = (id) => document.getElementById(id);
	const els = {
		design: $("gd-design"),
		designField: $("gd-design-field"),
		feature: $("gd-feature"),
		zoomOut: $("gd-zoom-out"),
		zoomIn: $("gd-zoom-in"),
		zoomLevel: $("gd-zoom-level"),
		fit: $("gd-fit"),
		navMode: $("gd-nav-mode"),
		toolNavigate: $("gd-tool-navigate"),
		railFit: $("gd-rail-fit"),
		navToggle: $("gd-nav-toggle"),
		railSystem: $("gd-rail-system"),
		shortcutsOpen: $("gd-shortcuts-open"),
		shortcuts: $("gd-shortcuts"),
		shortcutsClose: $("gd-shortcuts-close"),
		nav: $("gd-nav"),
		navTitle: $("gd-nav-title"),
		navList: $("gd-nav-list"),
		navNote: $("gd-nav-note"),
		featureSep: $("gd-feature-sep"),
		compareApp: $("gd-compare-app"),
		tabs: $("gd-tabs"),
		tabHistory: $("gd-tab-history"),
		countHistory: $("gd-count-history"),
		history: $("gd-history"),
		versions: $("gd-versions"),
		versionsTitle: $("gd-versions-title"),
		versionsModeSlider: $("gd-versions-mode-slider"),
		versionsModeSide: $("gd-versions-mode-side"),
		versionsClose: $("gd-versions-close"),
		versionsStage: $("gd-versions-stage"),
		tabChecks: $("gd-tab-checks"),
		countChecks: $("gd-count-checks"),
		checks: $("gd-checks"),
		tabBrief: $("gd-tab-brief"),
		countOpen: $("gd-count-open"),
		countResolved: $("gd-count-resolved"),
		tabPanel: $("gd-tabpanel"),
		brief: $("gd-brief"),
		briefTitle: $("gd-brief-title"),
		briefText: $("gd-brief-text"),
		briefFeature: $("gd-brief-feature"),
		handoffPanel: $("gd-handoff-panel"),
		handoffTitle: $("gd-handoff-title"),
		timeline: $("gd-timeline"),
		back: $("gd-back"),
		comment: $("gd-comment"),
		status: $("gd-status"),
		viewport: $("gd-viewport"),
		world: $("gd-world"),
		empty: $("gd-empty"),
		popover: $("gd-popover"),
		form: $("gd-popover-form"),
		target: $("gd-popover-target"),
		text: $("gd-popover-text"),
		message: $("gd-popover-message"),
		cancel: $("gd-popover-cancel"),
		send: $("gd-popover-send"),
		shotInput: $("gd-shot-input"),
		shotAttach: $("gd-shot-attach"),
		shotPreview: $("gd-shot-preview"),
		shotImage: $("gd-shot-image"),
		shotRemove: $("gd-shot-remove"),
		modeSend: $("gd-mode-send"),
		modeCollect: $("gd-mode-collect"),
		sendAll: $("gd-send-all"),
		sendNote: $("gd-send-note"),
		panelToggle: $("gd-panel-toggle"),
		panel: $("gd-panel"),
		filterOpen: $("gd-filter-open"),
		filterResolved: $("gd-filter-resolved"),
		panelEmpty: $("gd-panel-empty"),
		list: $("gd-comment-list"),
		toast: $("gd-toast"),
		compare: $("gd-compare"),
		compareTitle: $("gd-compare-title"),
		compareFit: $("gd-compare-fit"),
		compareModes: { side: $("gd-compare-mode-side"), overlay: $("gd-compare-mode-overlay"), slider: $("gd-compare-mode-slider") },
		compareOpacityField: $("gd-compare-opacity-field"),
		compareOpacity: $("gd-compare-opacity"),
		compareOpacityValue: $("gd-compare-opacity-value"),
		compareFitField: $("gd-compare-fit-field"),
		compareOpen: $("gd-compare-open"),
		compareBack: $("gd-compare-back"),
		compareMessage: $("gd-compare-message"),
		compareStage: $("gd-compare-stage"),
		compareSizer: $("gd-compare-sizer"),
		comparePanes: $("gd-compare-panes"),
		inspector: $("gd-inspector"),
		inspectorTitle: $("gd-inspector-title"),
		inspectorSelector: $("gd-inspector-selector"),
		inspectorList: $("gd-inspector-list"),
		inspectorNote: $("gd-inspector-note"),
		inspectorFix: $("gd-inspector-fix"),
		inspectorCopy: $("gd-inspector-copy"),
	};

	function storedMode() {
		try {
			return localStorage.getItem(MODE_KEY) === "collect" ? "collect" : "send";
		} catch {
			return "send";
		}
	}

	const state = {
		slug: typeof config.slug === "string" ? config.slug : null,
		manifest: null,
		boards: [],
		system: null,
		systemBoard: null,
		zoom: 1,
		x: FIT_PADDING,
		y: FIT_PADDING,
		commenting: false,
		pick: null,
		// The one screenshot of the open popover: { mimeType, data: base64 }, or null.
		shot: null,
		shotToken: 0,
		closeTimer: 0,
		comments: [],
		// The review tab: "open" or "resolved" (the comment list) or "brief".
		tab: "open",
		mode: storedMode(),
		activeId: null,
		designCount: 0,
		// The focused board, and the view to restore when focus mode ends.
		focus: null,
		savedView: null,
		savedPanel: null,
		savedNav: null,
		// The size shown while focused: { kind: "phone" | "tablet" | "desktop" | "all" }, or { kind: "custom", width }.
		size: { kind: "desktop" },
		hoverBoard: null,
		// The open version comparison: { board, n, mode, pos, enteredFocus, ... }, or null.
		vcompare: null,
		// The history of design `slug`: Map of artboard file to its versions (oldest first), the reply's warnings, and a load error.
		history: { slug: null, artboards: new Map(), warnings: [], error: null },
		historyPending: null,
		historyAgain: false,
		historyAlert: null,
		// The version whose restore is being confirmed ({ slug, file, n }), a failed restore's reply, and what to focus next.
		restoreAsk: null,
		restoreBusy: false,
		restoreError: null,
		historyFocus: null,
		// The project's design tokens (design/system.md), for the inspector: [{ name, value, section, group }].
		tokens: [],
		// The element the inspector panel shows: { surface, measure, flags, text }, and what keeps the panel open.
		inspect: null,
		inspectGen: 0,
		inspectorHover: false,
		// The handoffs.json of design `slug`; boards of another design ignore it.
		handoffs: { slug: null, chosen: null, handoffs: {} },
		// The open Compare view: { board, preview, artboardFrame, appFrame, design, app, handle, shield, pos, opacity, timer, loaded }.
		compare: null,
		// "side", "overlay" or "slider": the last Compare mode, kept while the canvas runs.
		compareMode: "side",
		toastTimer: 0,
		// Failed resolve or reopen replies by comment id, shown in that comment's card.
		cardErrors: new Map(),
	};

	function setStatus(text, isError) {
		els.status.textContent = text;
		els.status.classList.toggle("gd-error", Boolean(isError));
	}

	/**
	 * A failed reply in words: { text: cause and way out, detail: the raw code (and the server's own reason) }.
	 * `reply` is what postJson returns; a code without a sentence gets a generic one that still names it.
	 */
	// Sentences that depend on the action: a refused handoff is taken back, so it is not "unsent comments".
	const ACTION_REASONS = {
		implement: { "delivery-failed": "The session did not accept the handoff, so it was not recorded. Check that the session is running, then use Implement this again." },
		restore: {
			"file-too-large": "The artboard is too large to save a copy before restoring (versions are limited to 8 MB), so nothing was changed. Make it smaller, then try again.",
			"not-found": "That version is no longer kept, so nothing was changed. Choose another version.",
		},
	};

	/** `action` picks an action-specific sentence over the generic one, when it has one. */
	function explain(reply, action) {
		const body = reply && reply.body && typeof reply.body === "object" ? reply.body : {};
		const code = typeof body.error === "string" && body.error ? body.error : `http-${reply ? reply.status : 0}`;
		const reason = typeof body.reason === "string" && body.reason ? body.reason : "";
		const specific = action && ACTION_REASONS[action] && Object.prototype.hasOwnProperty.call(ACTION_REASONS[action], code) ? ACTION_REASONS[action][code] : "";
		let text = specific || (Object.prototype.hasOwnProperty.call(REASONS, code) ? REASONS[code] : "");
		if (!text && code.startsWith("invalid-")) text = "The server rejected the request as invalid. Reload the canvas and try again.";
		if (!text) text = `Something went wrong. Try again; if it keeps failing, reopen the canvas: ${OPEN_HINT}.`;
		return { text, detail: reason ? `${code}: ${reason}` : code };
	}

	/** A sprite icon; the SVG namespace comes from the page's own icon in the footer alert. */
	function icon(name, className) {
		const SVG_NS = document.getElementById("gd-send-alert-icon").namespaceURI;
		const svg = document.createElementNS(SVG_NS, "svg");
		svg.setAttribute("class", className);
		svg.setAttribute("aria-hidden", "true");
		const use = document.createElementNS(SVG_NS, "use");
		use.setAttribute("href", `#${name}`);
		svg.append(use);
		return svg;
	}

	/** An inline error next to the action that failed: icon, sentence, small code, and a dismiss button. */
	function createAlert() {
		const root = document.createElement("div");
		root.className = "gd-alert";
		root.setAttribute("role", "alert");
		root.hidden = true;
		const body = document.createElement("div");
		body.className = "gd-alert-body";
		const text = document.createElement("p");
		text.className = "gd-alert-text";
		const detail = document.createElement("small");
		detail.className = "gd-alert-detail";
		body.append(text, detail);
		const dismiss = document.createElement("button");
		dismiss.type = "button";
		dismiss.className = "gd-alert-dismiss";
		dismiss.setAttribute("aria-label", "Dismiss");
		dismiss.title = "Dismiss";
		dismiss.append(icon("i-x", "gd-i"));
		root.append(icon("i-alert", "gd-i gd-alert-icon"), body, dismiss);
		return alertParts(root, text, detail, dismiss);
	}

	function alertParts(root, text, detail, dismiss) {
		const parts = { root, text, detail, dismiss };
		dismiss.addEventListener("click", () => {
			hideAlert(parts);
			if (parts.onDismiss) parts.onDismiss();
		});
		return parts;
	}

	function showAlert(parts, reply, action) {
		const info = explain(reply, action);
		parts.text.textContent = info.text;
		parts.detail.textContent = info.detail;
		parts.root.title = info.detail;
		parts.root.hidden = false;
	}

	function hideAlert(parts) {
		parts.root.hidden = true;
		parts.text.textContent = "";
		parts.detail.textContent = "";
	}

	const sendAlert = alertParts($("gd-send-alert"), $("gd-send-alert-text"), $("gd-send-alert-detail"), $("gd-send-alert-dismiss"));

	/** A confirmation that stays on screen for a few seconds, beyond the status line. */
	function showToast(text, isError) {
		clearTimeout(state.toastTimer);
		els.toast.textContent = text;
		els.toast.classList.toggle("gd-error", Boolean(isError));
		els.toast.hidden = false;
		state.toastTimer = setTimeout(() => { els.toast.hidden = true; }, TOAST_MS);
	}

	function fileUrl(slug, file) {
		return `${base}files/${encodeURIComponent(slug)}/${file.split("/").map(encodeURIComponent).join("/")}`;
	}

	async function getJson(path) {
		const response = await fetch(base + path, { headers: { Accept: "application/json" }, cache: "no-store" });
		let body = null;
		try { body = await response.json(); } catch { body = null; }
		if (!response.ok) {
			const reason = body && (body.reason || body.error);
			throw new Error(reason ? String(reason) : `HTTP ${response.status}`);
		}
		return body;
	}

	// ---- view transform -------------------------------------------------

	function clampZoom(value) {
		return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value));
	}

	function applyView() {
		els.world.style.transform = `translate(${state.x}px, ${state.y}px) scale(${state.zoom})`;
		els.world.style.setProperty("--gd-inv-zoom", String(1 / state.zoom));
		els.zoomLevel.textContent = `${Math.round(state.zoom * 100)}%`;
		for (const board of allBoards()) board.wrapper.classList.toggle("gd-compact", board.artboard.width * state.zoom < COMPACT_BOARD_WIDTH);
	}

	/** Zoom so the world point under (px, py) in viewport coordinates stays put. */
	function zoomAt(nextZoom, px, py) {
		const zoom = clampZoom(nextZoom);
		state.x = px - (px - state.x) * (zoom / state.zoom);
		state.y = py - (py - state.y) * (zoom / state.zoom);
		state.zoom = zoom;
		applyView();
		closePopover();
	}

	function zoomAtCenter(factor) {
		const rect = els.viewport.getBoundingClientRect();
		zoomAt(state.zoom * factor, rect.width / 2, rect.height / 2);
	}

	function panBy(dx, dy) {
		state.x += dx;
		state.y += dy;
		applyView();
		closePopover();
	}

	function fit() {
		if (state.focus) return;
		const rect = els.viewport.getBoundingClientRect();
		const width = els.world.offsetWidth;
		const height = els.world.offsetHeight;
		if (!width || !height) return;
		const zoom = clampZoom(Math.min((rect.width - FIT_PADDING * 2) / width, (rect.height - FIT_PADDING * 2) / height, 1));
		state.zoom = zoom;
		state.x = (rect.width - width * zoom) / 2;
		state.y = Math.max(FIT_PADDING, (rect.height - height * zoom) / 2);
		applyView();
		closePopover();
	}

	function wheelPixels(delta, mode) {
		return mode === 1 ? delta * 16 : mode === 2 ? delta * 400 : delta;
	}

	/** Shared by native wheel events and wheel events forwarded from artboards. */
	function handleWheel(deltaX, deltaY, deltaMode, zooming, shift, clientX, clientY) {
		if (state.focus) return;
		const dx = wheelPixels(deltaX, deltaMode);
		const dy = wheelPixels(deltaY, deltaMode);
		if (zooming) {
			const rect = els.viewport.getBoundingClientRect();
			const step = Math.max(-50, Math.min(50, dy));
			zoomAt(state.zoom * Math.exp(-step * 0.01), clientX - rect.left, clientY - rect.top);
		} else if (shift && dx === 0) {
			panBy(-dy, 0);
		} else {
			panBy(-dx, -dy);
		}
	}

	els.viewport.addEventListener("wheel", (event) => {
		event.preventDefault();
		handleWheel(event.deltaX, event.deltaY, event.deltaMode, event.ctrlKey || event.metaKey, event.shiftKey, event.clientX, event.clientY);
	}, { passive: false });

	// A press on a shield pans like the background; released without moving, it is a
	// click on that artboard: a routed pick in comment mode, else focus mode.
	let drag = null;
	els.viewport.addEventListener("pointerdown", (event) => {
		if (state.focus || event.button !== 0 || event.target.closest("button")) return;
		const shield = event.target.closest(".gd-shield");
		if (!shield && event.target !== els.viewport && event.target !== els.world && !event.target.closest(".gd-artboard-label")) return;
		drag = { id: event.pointerId, x: event.clientX, y: event.clientY, startX: event.clientX, startY: event.clientY, moved: false, board: shield ? boardOfShield(shield) : null };
		els.viewport.setPointerCapture(event.pointerId);
		els.viewport.classList.add("gd-panning");
	});
	els.viewport.addEventListener("pointermove", (event) => {
		if (!drag || drag.id !== event.pointerId) {
			if (!drag) hoverAt(event);
			return;
		}
		panBy(event.clientX - drag.x, event.clientY - drag.y);
		drag.x = event.clientX;
		drag.y = event.clientY;
		if (Math.abs(event.clientX - drag.startX) > CLICK_SLOP || Math.abs(event.clientY - drag.startY) > CLICK_SLOP) drag.moved = true;
	});
	const endDrag = (event) => {
		if (!drag || drag.id !== event.pointerId) return;
		const ended = drag;
		drag = null;
		els.viewport.classList.remove("gd-panning");
		if (event.type === "pointerup" && ended.board && !ended.moved) activateBoard(ended.board, event.clientX, event.clientY);
	};
	els.viewport.addEventListener("pointerup", endDrag);
	els.viewport.addEventListener("pointercancel", endDrag);
	els.viewport.addEventListener("pointerleave", () => setHoverBoard(null));

	els.viewport.addEventListener("keydown", (event) => {
		if (event.target !== els.viewport || state.focus) return;
		const step = event.shiftKey ? 200 : 50;
		const actions = {
			ArrowLeft: () => panBy(step, 0),
			ArrowRight: () => panBy(-step, 0),
			ArrowUp: () => panBy(0, step),
			ArrowDown: () => panBy(0, -step),
			"+": () => zoomAtCenter(1.25),
			"=": () => zoomAtCenter(1.25),
			"-": () => zoomAtCenter(0.8),
			"0": fit,
		};
		const action = actions[event.key];
		if (!action) return;
		event.preventDefault();
		action();
	});

	els.zoomIn.addEventListener("click", () => zoomAtCenter(1.25));
	els.zoomOut.addEventListener("click", () => zoomAtCenter(0.8));
	els.fit.addEventListener("click", fit);
	els.railFit.addEventListener("click", fit);

	// ---- navigation and focus modes ---------------------------------------

	function allBoards() {
		return state.systemBoard ? [state.systemBoard, ...state.boards] : state.boards;
	}

	function boardOfShield(shield) {
		return allBoards().find((board) => board.shield === shield) ?? null;
	}

	/** A viewport point in the artboard's own CSS pixels. */
	function framePoint(board, clientX, clientY) {
		const rect = board.frame.getBoundingClientRect();
		const scale = rect.width / board.viewWidth || 1;
		return { x: (clientX - rect.left) / scale, y: (clientY - rect.top) / scale };
	}

	function activateBoard(board, clientX, clientY) {
		if (!state.commenting) enterFocus(board);
		else if (!board.system) board.frame.contentWindow?.postMessage({ type: "gd:pick-at", ...framePoint(board, clientX, clientY) }, "*");
	}

	function setHoverBoard(board) {
		if (state.hoverBoard && state.hoverBoard !== board) state.hoverBoard.frame.contentWindow?.postMessage({ type: "gd:hover-at", x: null, y: null }, "*");
		state.hoverBoard = board;
	}

	/** Comment mode in navigation: the shield routes the hover to the inspector so it can outline the element. */
	function hoverAt(event) {
		// The inspector panel is beside the artboard: reaching it keeps the element outlined.
		if (event.target && els.inspector.contains(event.target)) return;
		if (!state.commenting || state.focus) return setHoverBoard(null);
		const shield = event.target.closest(".gd-shield");
		const board = shield ? boardOfShield(shield) : null;
		setHoverBoard(board && !board.system ? board : null);
		if (state.hoverBoard) state.hoverBoard.frame.contentWindow?.postMessage({ type: "gd:hover-at", ...framePoint(board, event.clientX, event.clientY) }, "*");
	}

	/** The board's own frame, then the extra frames All sizes adds: every one reports picks and pins the same way. */
	function surfacesOf(board) {
		return board.sizeFrames.length > 0 ? [board, ...board.sizeFrames] : [board];
	}

	/** The artboard a frame belongs to: a board is its own, a size frame names its board. */
	function ownerOf(surface) {
		return surface.board ?? surface;
	}

	function sendFocus(surface) {
		surface.frame.contentWindow?.postMessage({ type: "gd:focus", enabled: ownerOf(surface) === state.focus }, "*");
	}

	/**
	 * The artboard's visible size: its manifest size, or the focused size. A report of horizontal
	 * overflow belongs to one width, so a new width clears it until the page reports again.
	 */
	function setFrameSize(board, width, height) {
		if (board.viewWidth !== width) {
			board.overflow = null;
			board.viewWidth = width;
			board.frame.style.width = `${width}px`;
			renderOverflow(board);
		}
		board.viewHeight = height;
		board.frame.style.height = `${height}px`;
	}

	function presetSize(board, preset) {
		return preset.manifest ? { width: board.artboard.width, height: board.artboard.height } : { width: preset.width, height: preset.height };
	}

	/** What the focused size means for one artboard (All sizes keeps the artboard's own frame at its manifest size). */
	function focusSize(board) {
		const size = state.size;
		if (size.kind === "custom") return { width: size.width, height: board.artboard.height };
		const preset = SIZE_PRESETS.find((candidate) => candidate.kind === size.kind);
		return preset ? presetSize(board, preset) : presetSize(board, SIZE_PRESETS[2]);
	}

	/**
	 * 100% zoom with the focused artboard centered and its label (Implement this) in view.
	 * A taller artboard is top-aligned and its frame is clipped to the viewport, so it
	 * scrolls inside like a browser window instead of leaving its bottom out of reach
	 * while the canvas cannot pan. The frame has the focused size (Phone, a custom width...);
	 * All sizes puts the label at the top and fits three frames below it.
	 */
	function centerFocus() {
		const board = state.focus;
		if (!board) return;
		const viewport = els.viewport.getBoundingClientRect();
		// Layout offsets inside the world ignore its transform, so re-centering is idempotent
		// (a scaled bounding rect carries sub-pixel error that shifted the board by 1 px).
		const box = board.frame.parentElement;
		const left = box.offsetLeft;
		const top = box.offsetTop;
		const labelSpace = box.offsetTop - board.wrapper.offsetTop;
		const all = state.size.kind === "all";
		const { width, height } = focusSize(board);
		const minTop = FOCUS_MARGIN + labelSpace;
		const available = viewport.height - minTop - BACK_SPACE;
		const tall = all || height > available;
		setFrameSize(board, width, tall ? Math.max(120, Math.floor(available)) : height);
		state.zoom = 1;
		state.x = Math.round(!all && width + FOCUS_MARGIN * 2 <= viewport.width ? (viewport.width - width) / 2 - left : FOCUS_MARGIN - left);
		state.y = Math.round((tall ? minTop : Math.max(minTop, (viewport.height - height) / 2)) - top);
		applyView();
		if (all) layoutSizes(board, minTop, viewport);
	}

	/** Shields, dimming, inert boards, toolbar controls and the mode label follow state.focus. */
	function applyFocusState() {
		const focused = state.focus;
		els.viewport.classList.toggle("gd-focused", Boolean(focused));
		for (const board of allBoards()) {
			const active = board === focused;
			board.wrapper.classList.toggle("gd-focus-board", active);
			board.wrapper.inert = Boolean(focused) && !active;
			board.shield.hidden = active;
			board.wrapper.classList.toggle("gd-all-sizes", active && state.size.kind === "all");
			if (!active) {
				// Leaving focus mode, or focusing another artboard, restores the manifest size.
				setFrameSize(board, board.artboard.width, board.artboard.height);
				removeSizeFrames(board);
			}
			renderOverflow(board);
			surfacesOf(board).forEach(sendFocus);
		}
		if (focused) renderSizeControl(focused);
		for (const control of [els.zoomOut, els.zoomIn, els.fit, els.railFit]) control.disabled = Boolean(focused);
		els.design.disabled = Boolean(focused) || state.designCount === 0;
		els.back.hidden = !focused;
		els.railSystem.disabled = !state.systemBoard;
		els.compareApp.disabled = Boolean(state.compare);
		renderNav();
		renderHistory();
		renderNavMode();
	}

	/** The floating chip: focus mode, comment mode or plain navigation. */
	function renderNavMode() {
		const focused = state.focus;
		els.navMode.textContent = focused ? `Using: ${focused.artboard.title} · Shift+Esc to exit` : state.commenting ? COMMENT_CHIP : "Navigating";
		els.navMode.classList.toggle("gd-using", Boolean(focused));
		els.navMode.classList.toggle("gd-commenting-chip", !focused && state.commenting);
	}

	function enterFocus(board) {
		if (state.focus === board) return;
		if (state.vcompare && state.vcompare.board !== board) closeVersionCompare(false, false);
		if (!state.focus) {
			state.savedView = { zoom: state.zoom, x: state.x, y: state.y };
			// The artboard keeps its designed width at 100%; hiding the panel gains room for it.
			state.savedPanel = !els.panel.hidden;
			setPanel(false);
			// The artboard list gives its room too, but only when the artboard would not fit beside it.
			state.savedNav = !els.nav.hidden;
			if (state.savedNav && board.artboard.width + FOCUS_MARGIN * 2 > els.viewport.getBoundingClientRect().width) setNav(false);
		}
		closePopover();
		setHoverBoard(null);
		state.focus = board;
		// Every focus session starts at Desktop.
		state.size = { kind: "desktop" };
		// The state first: the header's size control takes room above the frame that centering counts.
		applyFocusState();
		centerFocus();
		board.frame.focus();
	}

	function exitFocus() {
		if (!state.focus) return;
		closeVersionCompare(false, false);
		closePopover();
		state.focus = null;
		state.size = { kind: "desktop" };
		if (state.savedPanel !== null) setPanel(state.savedPanel);
		state.savedPanel = null;
		if (state.savedNav !== null) setNav(state.savedNav);
		state.savedNav = null;
		if (state.savedView) Object.assign(state, state.savedView);
		state.savedView = null;
		applyView();
		applyFocusState();
		els.viewport.focus();
	}

	els.back.addEventListener("click", exitFocus);

	// ---- designs and artboards -------------------------------------------

	function showEmpty(text) {
		exitFocus();
		els.world.replaceChildren();
		state.boards = [];
		els.railSystem.disabled = !state.systemBoard;
		renderHandoffViews();
		els.empty.textContent = text;
		els.empty.hidden = false;
	}

	function renderDesignOptions(designs) {
		const options = designs.map((design) => {
			const option = document.createElement("option");
			option.value = design.slug;
			option.textContent = design.valid ? design.title : `${design.slug} (invalid design.json)`;
			return option;
		});
		els.design.replaceChildren(...options);
		state.designCount = designs.length;
		els.design.disabled = designs.length === 0 || Boolean(state.focus);
		els.designField.hidden = designs.length === 0;
		if (state.slug) els.design.value = state.slug;
	}

	/** pickLatest: with no design selected, select the most recent one (not for the system-only view). */
	async function refreshDesigns(pickLatest = true) {
		const { designs } = await getJson("api/designs");
		if (pickLatest && !state.slug && designs.length > 0) state.slug = designs[0].slug;
		renderDesignOptions(designs);
		return designs;
	}

	function sendMode(surface) {
		surface.frame.contentWindow?.postMessage({ type: "gd:mode", enabled: state.commenting && !ownerOf(surface).system }, "*");
	}

	function boardUrl(board) {
		return board.system ? `${base}system.html` : fileUrl(board.slug, board.artboard.file);
	}

	function createBoard(slug, artboard, system = false, number = 0) {
		const wrapper = document.createElement("section");
		wrapper.className = system ? "gd-artboard gd-system-board" : "gd-artboard";
		wrapper.setAttribute("aria-label", artboard.title);
		const label = document.createElement("div");
		label.className = "gd-artboard-label";
		// The header: number, title and, while focused, the handoff state chip.
		const head = document.createElement("div");
		head.className = "gd-artboard-head";
		const title = document.createElement("h2");
		title.className = "gd-artboard-title";
		title.textContent = artboard.title;
		let stateChip = null;
		if (!system) {
			const num = chip("gd-artboard-num", String(number).padStart(2, "0"));
			num.setAttribute("aria-hidden", "true");
			// The handoff row below says the same in words; this chip only repeats it in the focus header.
			stateChip = chip("gd-artboard-state", "");
			stateChip.hidden = true;
			stateChip.setAttribute("aria-hidden", "true");
			head.append(num, title, stateChip);
		} else head.append(title);
		label.append(head);
		if (artboard.tradeoff) {
			const tradeoff = document.createElement("p");
			tradeoff.className = "gd-artboard-tradeoff";
			tradeoff.textContent = artboard.tradeoff;
			label.append(tradeoff);
		}
		const sizeControl = system ? null : createSizeControl(artboard);
		// The handoff state, the chosen badge and Compare (rendered by renderHandoff) stack above
		// Implement this, at screen size, so neither covers the other at any zoom.
		const handoff = document.createElement("div");
		handoff.className = "gd-handoff";
		handoff.hidden = true;
		if (sizeControl) label.append(sizeControl.root);
		if (!system) {
			const actions = document.createElement("div");
			actions.className = "gd-board-actions";
			actions.append(handoff, createImplementControl(slug, artboard));
			label.append(actions);
		}
		if (system) {
			label.title = SYSTEM_NOTE;
			const note = document.createElement("p");
			note.className = "gd-system-note";
			note.title = SYSTEM_NOTE;
			note.textContent = "Comments off on this board";
			label.append(note);
		}
		const frame = document.createElement("iframe");
		frame.className = "gd-artboard-frame";
		frame.setAttribute("sandbox", "allow-scripts");
		frame.setAttribute("referrerpolicy", "no-referrer");
		frame.title = `${artboard.title} artboard`;
		frame.style.width = `${artboard.width}px`;
		const box = document.createElement("div");
		box.className = "gd-frame-box";
		const shield = document.createElement("div");
		shield.className = "gd-shield";
		shield.setAttribute("role", "button");
		shield.tabIndex = 0;
		shield.setAttribute("aria-label", system ? `View ${artboard.title} (read-only)` : `Use ${artboard.title}`);
		const hint = document.createElement("span");
		hint.className = "gd-shield-hint";
		hint.setAttribute("aria-hidden", "true");
		hint.textContent = system ? "Click to view the design system" : "Click to use this design";
		shield.append(hint);
		const pins = document.createElement("div");
		pins.className = "gd-pins";
		// rects: null until the artboard reports where each commented element is.
		const flag = createOverflowFlag();
		const board = { slug, artboard, number, frame, wrapper, shield, pins, handoff, stateChip, rects: null, system, viewWidth: artboard.width, viewHeight: artboard.height, flag, overflow: null, sizeControl, sizeFrames: [], sizesView: null, checks: null };
		setFrameSize(board, artboard.width, artboard.height);
		renderHandoff(board);
		// The system board is not listed in the navigator, so it has no item or thumbnail.
		if (!system) board.nav = createNavItem(board);
		shield.addEventListener("keydown", (event) => {
			if (event.key !== "Enter" && event.key !== " ") return;
			event.preventDefault();
			enterFocus(board);
		});
		frame.addEventListener("load", () => {
			surfaceLoaded(board);
			// A live reload of the focused artboard keeps focus mode and its keyboard focus.
			if (state.focus === board && els.popover.hidden && (document.activeElement === frame || document.activeElement === document.body)) frame.focus();
		});
		frame.src = boardUrl(board);
		box.append(frame, shield, pins, flag);
		wrapper.append(label, box);
		return board;
	}

	// ---- screen sizes --------------------------------------------------------

	/** A frame (the board's own or a size frame) finished loading: it knows nothing yet, so tell it the state. */
	function surfaceLoaded(surface) {
		surface.rects = null;
		// A reloaded artboard is checked again: its old result no longer describes it.
		if (surface === ownerOf(surface) && !surface.system && surface.checks) {
			surface.checks = null;
			renderChecks();
			renderNav();
		}
		surface.overflow = null;
		renderOverflow(surface);
		sendMode(surface);
		sendFocus(surface);
		if (!ownerOf(surface).system) sendPins(surface);
	}

	/** The "Overflows" chip of one frame; its title says how wide the frame is (renderOverflow). */
	function createOverflowFlag() {
		const flag = document.createElement("span");
		flag.className = "gd-overflow-flag";
		flag.hidden = true;
		flag.append(chip("gd-overflow-text", "Overflows"), chip("gd-visually-hidden", ""));
		return flag;
	}

	/**
	 * Shown while the page last reported content wider than this frame. The artboard's own frame
	 * shows it only at a single focused size; in All sizes each size frame has its own.
	 */
	function renderOverflow(surface) {
		const board = ownerOf(surface);
		const shown = Boolean(surface.overflow) && (surface !== board || (state.focus === board && state.size.kind !== "all"));
		surface.flag.hidden = !shown;
		if (!shown) return;
		const note = `Content is wider than ${surface.viewWidth} px, so part of it is cut off or needs sideways scrolling at this size.`;
		surface.flag.title = note;
		surface.flag.children[1].textContent = ` ${note}`;
	}

	/** The size control in an artboard's header: presets, All sizes, a custom width and the current size. */
	function createSizeControl(artboard) {
		const root = document.createElement("div");
		root.className = "gd-sizebar";
		const group = document.createElement("div");
		group.className = "gd-devices";
		group.setAttribute("role", "group");
		group.setAttribute("aria-label", "Preview size");
		const buttons = {};
		const addButton = (kind, label, iconName, title) => {
			const button = document.createElement("button");
			button.type = "button";
			button.className = "gd-size-button";
			button.dataset.size = kind;
			button.title = title;
			button.setAttribute("aria-pressed", "false");
			if (iconName) button.append(icon(iconName, "gd-i gd-i-s"));
			button.append(chip("gd-size-label", label));
			button.addEventListener("click", () => setSize({ kind }));
			buttons[kind] = button;
			group.append(button);
		};
		for (const preset of SIZE_PRESETS) {
			const { width, height } = presetSize({ artboard }, preset);
			addButton(preset.kind, preset.label, preset.icon, `${preset.label} ${width} × ${height}`);
		}
		addButton("all", "All sizes", null, "All sizes: Phone, Tablet and Desktop side by side");
		const custom = document.createElement("label");
		custom.className = "gd-size-custom";
		const input = document.createElement("input");
		input.type = "number";
		input.className = "gd-size-input";
		input.setAttribute("aria-label", "Custom width in pixels");
		input.setAttribute("min", String(CUSTOM_WIDTH.min));
		input.setAttribute("max", String(CUSTOM_WIDTH.max));
		input.setAttribute("step", "1");
		input.setAttribute("inputmode", "numeric");
		const unit = chip("gd-size-unit", "px");
		unit.setAttribute("aria-hidden", "true");
		custom.append(chip("gd-size-custom-label", "Custom"), input, unit);
		const readout = document.createElement("output");
		readout.className = "gd-size-readout";
		readout.setAttribute("aria-label", "Current size");
		readout.setAttribute("aria-live", "polite");
		const error = chip("gd-size-error", "");
		error.setAttribute("role", "alert");
		error.hidden = true;
		const apply = () => {
			const text = input.value.trim();
			const width = Number(text);
			if (!/^\d+$/.test(text) || width < CUSTOM_WIDTH.min || width > CUSTOM_WIDTH.max) {
				input.setAttribute("aria-invalid", "true");
				error.textContent = `Enter a whole number from ${CUSTOM_WIDTH.min} to ${CUSTOM_WIDTH.max} (px).`;
				error.hidden = false;
				return;
			}
			setSize({ kind: "custom", width });
		};
		input.addEventListener("change", apply);
		input.addEventListener("keydown", (event) => {
			if (event.key !== "Enter") return;
			event.preventDefault();
			apply();
		});
		root.append(group, custom, readout, error);
		return { root, buttons, custom, input, readout, error };
	}

	function renderSizeControl(board) {
		const control = board.sizeControl;
		if (!control) return;
		const size = state.size;
		for (const [kind, button] of Object.entries(control.buttons)) button.setAttribute("aria-pressed", String(size.kind === kind));
		control.custom.classList.toggle("gd-selected", size.kind === "custom");
		if (size.kind === "custom") control.input.value = String(size.width);
		else if (document.activeElement !== control.input) control.input.value = "";
		const { width, height } = focusSize(board);
		control.readout.textContent = size.kind === "all" ? "All sizes" : `${width} × ${height}`;
	}

	/**
	 * The size a pick was made at, for the comment: the focused single size, or the picked size frame of
	 * All sizes. Null at the artboard's own size (nothing to record) and when comments.json would refuse it.
	 */
	function viewportOf(surface) {
		const board = ownerOf(surface);
		let size;
		if (surface !== board) size = { width: surface.width, height: surface.height };
		else if (state.focus === board && state.size.kind !== "all") size = focusSize(board);
		else return null;
		if (size.width === board.artboard.width && size.height === board.artboard.height) return null;
		const { minWidth, maxWidth, minHeight, maxHeight } = VIEWPORT_LIMITS;
		const fits = size.width >= minWidth && size.width <= maxWidth && size.height >= minHeight && size.height <= maxHeight;
		return fits && Number.isInteger(size.width) && Number.isInteger(size.height) ? size : null;
	}

	/** `Phone 390 × 844`, `Tablet 820 × 1180` or `<w> × <h>`: the preset's name only for its exact size. */
	function describeViewport(viewport) {
		const size = `${viewport.width} × ${viewport.height}`;
		const preset = SIZE_PRESETS.find((candidate) => !candidate.manifest && candidate.width === viewport.width && candidate.height === viewport.height);
		return preset ? `${preset.label} ${size}` : size;
	}

	/** Picks a size for the focused artboard; a bad custom width never gets here (the field refuses it). */
	function setSize(size) {
		const board = state.focus;
		if (!board) return;
		closePopover();
		const control = board.sizeControl;
		control.input.removeAttribute("aria-invalid");
		control.error.hidden = true;
		state.size = size;
		applySize();
	}

	/** Brings the focused artboard's frames, centering, control and chip in line with state.size. */
	function applySize() {
		const board = state.focus;
		if (!board) return;
		const all = state.size.kind === "all";
		board.wrapper.classList.toggle("gd-all-sizes", all);
		if (all && !board.sizesView) createSizeFrames(board);
		else if (!all) removeSizeFrames(board);
		centerFocus();
		renderSizeControl(board);
		renderOverflow(board);
	}

	/**
	 * All sizes: a real iframe per size at its true width (so the design's media queries apply), scaled down
	 * together. They are registered like the artboard's own frame (surfacesOf), so they take picks and show pins.
	 */
	function createSizeFrames(board) {
		const view = document.createElement("div");
		view.className = "gd-sizes-all";
		view.classList.toggle("gd-commenting", state.commenting);
		view.setAttribute("role", "group");
		view.setAttribute("aria-label", "All sizes");
		board.sizeFrames = SIZE_PRESETS.map((preset) => createSizeFrame(board, preset));
		view.append(...board.sizeFrames.map((surface) => surface.root));
		board.sizesView = view;
		els.viewport.append(view);
	}

	function createSizeFrame(board, preset) {
		const { width, height } = presetSize(board, preset);
		const root = document.createElement("section");
		root.className = "gd-size-frame";
		root.setAttribute("aria-label", `${preset.label} ${width} by ${height}`);
		const head = document.createElement("div");
		head.className = "gd-size-head";
		const scaleLabel = chip("gd-size-scale", "");
		head.append(icon(preset.icon, "gd-i gd-i-s"), chip("gd-size-name", preset.label), chip("gd-size-dim", `${width} × ${height}`), scaleLabel);
		const scaled = document.createElement("div");
		scaled.className = "gd-size-scaled";
		const stage = document.createElement("div");
		stage.className = "gd-size-stage";
		stage.style.width = `${width}px`;
		stage.style.height = `${height}px`;
		const frame = document.createElement("iframe");
		frame.className = "gd-size-iframe";
		frame.setAttribute("sandbox", "allow-scripts");
		frame.setAttribute("referrerpolicy", "no-referrer");
		frame.title = `${board.artboard.title} artboard at ${preset.label} ${width} × ${height}`;
		frame.style.width = `${width}px`;
		frame.style.height = `${height}px`;
		const pins = document.createElement("div");
		pins.className = "gd-pins";
		const flag = createOverflowFlag();
		stage.append(frame, pins);
		scaled.append(stage, flag);
		root.append(head, scaled);
		const surface = { board, kind: preset.kind, width, height, viewWidth: width, viewHeight: height, frame, pins, flag, rects: null, overflow: null, root, scaled, stage, scaleLabel };
		frame.addEventListener("load", () => surfaceLoaded(surface));
		frame.src = boardUrl(board);
		return surface;
	}

	function removeSizeFrames(board) {
		if (!board.sizesView) return;
		board.sizesView.remove();
		board.sizesView = null;
		board.sizeFrames = [];
	}

	/** One scale for the three frames: small enough that they fit side by side under the label and above Back to canvas. */
	function layoutSizes(board, minTop, viewport) {
		const view = board.sizesView;
		const frames = board.sizeFrames;
		if (!view || frames.length === 0) return;
		const top = minTop + 8;
		view.style.left = `${FOCUS_MARGIN}px`;
		view.style.right = `${FOCUS_MARGIN}px`;
		view.style.top = `${top}px`;
		view.style.bottom = `${BACK_SPACE}px`;
		const availableWidth = viewport.width - FOCUS_MARGIN * 2 - SIZES_GAP * (frames.length - 1);
		const availableHeight = viewport.height - top - BACK_SPACE - SIZES_HEAD;
		const totalWidth = frames.reduce((sum, surface) => sum + surface.width, 0);
		const tallest = Math.max(...frames.map((surface) => surface.height));
		const scale = Math.max(MIN_SIZES_SCALE, Math.min(1, availableWidth / totalWidth, availableHeight / tallest));
		for (const surface of frames) {
			surface.scaled.style.width = `${Math.round(surface.width * scale)}px`;
			surface.scaled.style.height = `${Math.round(surface.height * scale)}px`;
			surface.stage.style.transform = `scale(${scale})`;
			surface.stage.style.setProperty("--gd-inv-zoom", String(1 / scale));
			surface.scaleLabel.textContent = `· ${Math.round(scale * 100)}%`;
		}
	}

	/** "Implement this" with an inline confirm step; the system board never gets one. */
	let implementNotes = 0;

	function createImplementControl(slug, artboard) {
		const box = document.createElement("div");
		box.className = "gd-implement";
		const start = document.createElement("button");
		start.type = "button";
		start.className = "gd-implement-start";
		start.textContent = "Implement this";
		start.setAttribute("aria-label", `Implement ${artboard.title} in the project`);
		const confirm = document.createElement("div");
		confirm.className = "gd-implement-confirm";
		confirm.setAttribute("role", "group");
		confirm.setAttribute("aria-label", `Confirm implementing ${artboard.title}`);
		confirm.hidden = true;
		const question = document.createElement("span");
		question.textContent = "Send it to the session to implement?";
		const yes = document.createElement("button");
		yes.type = "button";
		yes.className = "gd-primary";
		yes.textContent = "Send";
		const no = document.createElement("button");
		no.type = "button";
		no.textContent = "Cancel";
		confirm.append(question, yes, no);
		const alert = createAlert();
		let note = null;
		if (!DELIVERY.implement) {
			// No session to hand off to: say so up front instead of failing on click.
			const info = explain({ status: 501, body: { error: "implement-unavailable" } });
			start.disabled = true;
			start.title = info.detail;
			// A short visible line keeps the artboard header readable; the full sentence stays
			// in the tooltip and, for screen readers, in the visually hidden rest of the note.
			note = chip("gd-implement-note", "Canvas not connected to a Pi session.");
			note.title = info.text;
			note.append(chip("gd-visually-hidden", ` ${info.text}`));
			note.id = `gd-implement-note-${++implementNotes}`;
			start.setAttribute("aria-describedby", note.id);
		}
		const close = (focus) => {
			confirm.hidden = true;
			start.hidden = false;
			if (focus) start.focus();
		};
		start.addEventListener("click", () => {
			if (start.disabled) return;
			hideAlert(alert);
			start.hidden = true;
			confirm.hidden = false;
			yes.disabled = false;
			yes.focus();
		});
		no.addEventListener("click", () => close(true));
		confirm.addEventListener("keydown", (event) => {
			if (event.key !== "Escape") return;
			event.preventDefault();
			event.stopPropagation();
			close(true);
		});
		yes.addEventListener("click", async () => {
			yes.disabled = true;
			hideAlert(alert);
			const reply = await postJson(`api/designs/${encodeURIComponent(slug)}/implement`, { file: artboard.file });
			if (reply.ok) {
				const queued = reply.body.queued === true;
				const text = queued
					? `Queued: the session will implement ${artboard.title} after its current task.`
					: `Sent: the session is implementing ${artboard.title} now.`;
				showToast(text, false);
				// The server recorded it before answering; the handoffs.json change event confirms it.
				noteHandoff(slug, artboard.file, queued);
			} else {
				showAlert(alert, reply, "implement");
				// The alert says it next to the button; only a board collapsed by zoom hides it, so only then toast.
				if (box.closest(".gd-compact")) showToast(alert.text.textContent, true);
			}
			close(true);
		});
		box.append(start, confirm, ...(note ? [note] : []), alert.root);
		return box;
	}

	// ---- handoffs ------------------------------------------------------------

	function ownPort() {
		const location = window.location;
		return location && typeof location.port === "string" ? location.port : "";
	}

	/**
	 * The preview URL Compare may frame: http(s) on localhost, 127.0.0.1 or [::1], no
	 * credentials, and never this canvas server's port (the server validates it too).
	 */
	function previewTarget(value) {
		if (typeof value !== "string" || value.length === 0 || value.length > MAX_PREVIEW_URL) return null;
		let url;
		try { url = new URL(value); } catch { return null; }
		if (url.protocol !== "http:" && url.protocol !== "https:") return null;
		if (url.username || url.password || !LOOPBACK_HOSTS.includes(url.hostname)) return null;
		const port = url.port || (url.protocol === "https:" ? "443" : "80");
		return port === ownPort() ? null : url.href;
	}

	function handoffOf(board) {
		const data = state.handoffs;
		if (board.system || data.slug !== board.slug) return { chosen: null, entry: null };
		const file = board.artboard.file;
		const entry = Object.prototype.hasOwnProperty.call(data.handoffs, file) ? data.handoffs[file] : null;
		return { chosen: data.chosen, entry: entry && typeof entry === "object" ? entry : null };
	}

	function handoffKind(entry) {
		if (entry.status === "sent") return entry.queued === true ? "queued" : "sent";
		return entry.status === "in_progress" || entry.status === "implemented" ? entry.status : null;
	}

	function chip(className, text) {
		const element = document.createElement("span");
		element.className = className;
		element.textContent = text;
		return element;
	}

	/** The header row of one artboard: Chosen or Alternative, the handoff badge, its feature document, note and Compare. */
	function renderHandoff(board) {
		if (board.system || !board.handoff) return;
		const { chosen, entry } = handoffOf(board);
		const isChosen = typeof chosen === "string" && chosen === board.artboard.file;
		board.wrapper.classList.toggle("gd-chosen", isChosen);
		const parts = [];
		if (typeof chosen === "string") parts.push(chip(`gd-choice ${isChosen ? "gd-choice-chosen" : "gd-choice-alternative"}`, isChosen ? "Chosen" : "Alternative"));
		const kind = entry ? handoffKind(entry) : null;
		board.stateChip.hidden = !kind;
		board.stateChip.textContent = kind ? HANDOFF_LABELS[kind] : "";
		if (kind) board.stateChip.dataset.status = kind;
		else delete board.stateChip.dataset.status;
		let compare = null;
		if (kind) {
			const badge = chip("gd-handoff-badge", HANDOFF_LABELS[kind]);
			badge.dataset.status = kind;
			parts.push(badge);
			if (typeof entry.feature === "string" && entry.feature) {
				const feature = chip("gd-handoff-feature", entry.feature);
				feature.title = "Tracked in this ODD feature document";
				parts.push(feature);
			}
			if (typeof entry.note === "string" && entry.note) {
				const note = chip("gd-handoff-note", entry.note);
				note.title = entry.note;
				parts.push(note);
			}
			const preview = kind === "implemented" ? previewTarget(entry.previewUrl) : null;
			if (preview) {
				compare = document.createElement("button");
				compare.type = "button";
				compare.className = "gd-compare-start";
				compare.textContent = "Compare";
				compare.setAttribute("aria-label", `Compare ${board.artboard.title} with the running app`);
				compare.addEventListener("click", () => enterCompare(board, preview));
				parts.push(compare);
			}
		}
		const hadFocus = board.handoff.contains(document.activeElement);
		board.handoff.replaceChildren(...parts);
		board.handoff.hidden = parts.length === 0;
		board.wrapper.classList.toggle("gd-has-handoff", parts.length > 0);
		if (hadFocus && compare) compare.focus();
	}

	function renderHandoffs() {
		state.boards.forEach(renderHandoff);
		renderHandoffViews();
	}

	/** The chosen artboard of the open design, or null. */
	function chosenBoard() {
		const chosen = state.handoffs.slug === state.slug ? state.handoffs.chosen : null;
		return typeof chosen === "string" ? state.boards.find((board) => board.artboard.file === chosen) ?? null : null;
	}

	/** Everything outside the artboards that follows handoffs, boards and comments: navigator, Compare with app, timeline. */
	function renderHandoffViews() {
		renderCompareApp();
		renderTimeline();
		renderNav();
		renderHistory();
	}

	function renderCompareApp() {
		const board = chosenBoard();
		const entry = board ? handoffOf(board).entry : null;
		const preview = entry && handoffKind(entry) === "implemented" ? previewTarget(entry.previewUrl) : null;
		state.comparePreview = board && preview ? { board, preview } : null;
		els.compareApp.hidden = !state.comparePreview;
	}

	els.compareApp.addEventListener("click", () => {
		if (state.comparePreview) enterCompare(state.comparePreview.board, state.comparePreview.preview);
	});

	/** A short local time: "Today 10:42", "Oct 26, 10:42", or "Mar 4 2020, 09:05" from another year; "" when unreadable. */
	function shortTime(value) {
		const date = typeof value === "string" ? new Date(value) : null;
		if (!date || Number.isNaN(date.getTime())) return "";
		const now = new Date();
		const clock = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
		if (date.toDateString() === now.toDateString()) return `Today ${clock}`;
		const day = `${MONTHS[date.getMonth()]} ${date.getDate()}`;
		return `${date.getFullYear() === now.getFullYear() ? day : `${day} ${date.getFullYear()}`}, ${clock}`;
	}

	/** Chosen, Sent to the session, In progress, Implemented: done, current or pending, with timestamps. */
	function renderTimeline() {
		const board = chosenBoard();
		els.handoffPanel.hidden = !board;
		if (!board) {
			els.timeline.replaceChildren();
			return;
		}
		els.handoffTitle.textContent = `Handoff · ${board.artboard.title}`;
		const entry = handoffOf(board).entry;
		const kind = entry ? handoffKind(entry) : null;
		// The index of the step the handoff is at; steps before it are done, a step at it is current.
		const at = { queued: 1, sent: 2, in_progress: 2, implemented: 4 }[kind] ?? 1;
		const stateOf = (index) => (index < at ? "done" : index === at && kind ? "current" : "pending");
		const sent = entry ? shortTime(entry.sentAt) : "";
		const started = entry ? shortTime(entry.startedAt) : "";
		const finished = entry ? shortTime(entry.implementedAt) : "";
		const note = entry && typeof entry.note === "string" && entry.note ? `“${entry.note}”` : "";
		const queued = kind === "queued";
		const defs = [
			["Chosen", []],
			["Sent to the session", queued ? [sent ? `Queued · ${sent}` : "Queued"] : kind ? [sent] : ["Use Implement this to send it"]],
			["In progress", kind ? [started, note] : []],
			["Implemented", [kind === "implemented" ? finished : "Compare with the running app when ready"]],
		];
		els.timeline.replaceChildren(...defs.map(([label, details], index) => {
			const status = stateOf(index);
			const item = document.createElement("li");
			item.className = `gd-step gd-step-${status}`;
			item.dataset.state = status;
			if (status === "current") item.setAttribute("aria-current", "step");
			const dot = document.createElement("span");
			dot.className = "gd-step-dot";
			dot.setAttribute("aria-hidden", "true");
			const body = document.createElement("span");
			body.className = "gd-step-body";
			// Never color alone: the state is also in words for assistive technology.
			const words = chip("gd-visually-hidden gd-step-state", status === "done" ? " (done)" : status === "current" ? " (current)" : " (not yet)");
			body.append(chip("gd-step-label", label), words, ...details.filter(Boolean).map((text) => chip("gd-step-detail", text)));
			item.append(dot, body);
			return item;
		}));
	}

	function commentSummary(board) {
		const mine = commentsForBoard(board);
		const open = mine.filter((comment) => comment.status === "open").length;
		const resolved = mine.filter((comment) => comment.status === "resolved").length;
		const parts = [];
		if (open > 0) parts.push(`${open} open comment${open === 1 ? "" : "s"}`);
		if (resolved > 0) parts.push(`${resolved} resolved`);
		return parts.length > 0 ? parts.join(" · ") : "No comments";
	}

	/**
	 * One navigator item, built once per board: its live thumbnail is an iframe, and an iframe that is
	 * removed from the page and put back reloads. renderNav therefore only updates the item in place.
	 */
	function createNavItem(board) {
		const item = document.createElement("li");
		const button = document.createElement("button");
		button.type = "button";
		button.className = "gd-nav-item";
		button.dataset.file = board.artboard.file;
		const thumb = createThumb(board);
		const text = document.createElement("span");
		text.className = "gd-nav-text";
		const title = chip("gd-nav-item-title", "");
		const summary = chip("gd-nav-summary", "");
		const tags = chip("gd-nav-tags", "");
		text.append(title, summary, tags);
		button.append(thumb.box, text);
		button.addEventListener("click", () => enterFocus(board));
		item.append(button);
		return { item, button, thumb, text, title, summary, tags, tag: chip("gd-nav-tag", ""), a11y: chip("gd-nav-a11y", "") };
	}

	// The live thumbnail shows the artboard scaled to this width.
	const THUMB_WIDTH = 56;

	/**
	 * The live thumbnail: the artboard in a sandboxed iframe (scripts only, like the canvas), scaled down.
	 * It is inert, hidden from assistive technology, never focusable and takes no pointer events (canvas.css),
	 * and it is not a registered artboard frame, so nothing it posts is trusted.
	 */
	function createThumb(board) {
		const { width, height, title } = board.artboard;
		const box = chip("gd-nav-thumb", "");
		box.setAttribute("aria-hidden", "true");
		const frame = document.createElement("iframe");
		frame.className = "gd-nav-thumb-frame";
		frame.setAttribute("sandbox", "allow-scripts");
		frame.setAttribute("referrerpolicy", "no-referrer");
		// Lazy: a long list does not load every artboard at once.
		frame.setAttribute("loading", "lazy");
		frame.setAttribute("tabindex", "-1");
		frame.setAttribute("aria-hidden", "true");
		frame.inert = true;
		frame.title = `${title} preview`;
		frame.style.width = `${width}px`;
		frame.style.height = `${height}px`;
		frame.style.transform = `scale(${THUMB_WIDTH / width})`;
		frame.src = boardUrl(board);
		box.append(frame);
		return { box, frame };
	}

	function reloadThumb(board) {
		if (board.nav) board.nav.thumb.frame.src = `${boardUrl(board)}?v=${Date.now()}`;
	}

	/** The artboard navigator: one item per design artboard; the system board is not listed. */
	function renderNav() {
		els.navTitle.textContent = `Artboards · ${state.boards.length}`;
		els.navNote.hidden = !state.systemBoard;
		const refocus = els.navList.contains(document.activeElement) ? document.activeElement.dataset.file : null;
		const items = state.boards.map((board) => {
			const nav = board.nav;
			if (board === state.focus) nav.button.setAttribute("aria-current", "true");
			else nav.button.removeAttribute("aria-current");
			nav.title.textContent = `${String(board.number).padStart(2, "0")} ${board.artboard.title}`;
			nav.summary.textContent = commentSummary(board);
			const tags = [];
			const { chosen } = handoffOf(board);
			if (typeof chosen === "string") {
				const isChosen = chosen === board.artboard.file;
				nav.tag.className = `gd-nav-tag${isChosen ? " gd-nav-tag-chosen" : ""}`;
				nav.tag.textContent = isChosen ? "Chosen" : "Alternative";
				tags.push(nav.tag);
			}
			const failures = checkFailures(board);
			if (failures !== null) {
				nav.a11y.textContent = failures === 0 ? "A11y ✓" : `${failures} check${failures === 1 ? "" : "s"}`;
				nav.a11y.dataset.state = failures === 0 ? "ok" : "warn";
				nav.a11y.title = failures === 0 ? "Automatic checks found no problems. They are heuristics, not a full audit." : "Open the Checks tab to see them.";
				tags.push(nav.a11y);
			}
			nav.tags.replaceChildren(...tags);
			return nav.item;
		});
		// Putting the same items back would reload their thumbnails: rebuild the list only when it changed.
		const current = Array.from(els.navList.children);
		if (items.length === current.length && items.every((item, index) => item === current[index])) return;
		els.navList.replaceChildren(...items);
		if (refocus) els.navList.querySelector?.(`[data-file="${CSS.escape(refocus)}"]`)?.focus();
	}

	function setHandoffs(slug, data) {
		const valid = Boolean(data && typeof data === "object" && data.handoffs && typeof data.handoffs === "object" && !Array.isArray(data.handoffs));
		state.handoffs = { slug, chosen: valid && typeof data.chosen === "string" ? data.chosen : null, handoffs: valid ? data.handoffs : {} };
		renderHandoffs();
	}

	async function loadHandoffs() {
		const slug = state.slug;
		if (!slug) return;
		let data = null;
		try {
			data = await getJson(`api/designs/${encodeURIComponent(slug)}/handoffs`);
		} catch (error) {
			setStatus(`handoffs.json for ${slug} cannot be read: ${error.message}`, true);
		}
		if (slug === state.slug) setHandoffs(slug, data);
	}

	/** Shows a handoff the server just accepted, before its handoffs.json change event arrives. */
	function noteHandoff(slug, file, queued) {
		const current = state.handoffs.slug === slug ? state.handoffs.handoffs : {};
		const feature = state.manifest && state.manifest.slug === slug && typeof state.manifest.feature === "string" ? state.manifest.feature : undefined;
		const entry = { status: "sent", queued, sentAt: new Date().toISOString(), startedAt: null, implementedAt: null };
		if (feature) entry.feature = feature;
		const handoffs = Object.assign({}, current);
		handoffs[file] = entry;
		state.handoffs = { slug, chosen: file, handoffs };
		renderHandoffs();
	}

	// ---- compare -------------------------------------------------------------

	function comparePane(caption, frame) {
		const figure = document.createElement("figure");
		figure.className = "gd-compare-pane";
		const label = document.createElement("figcaption");
		label.className = "gd-compare-caption";
		label.textContent = caption;
		figure.append(label, frame);
		return { figure, label, caption };
	}

	function compareFrame(width, height, title) {
		const frame = document.createElement("iframe");
		frame.className = "gd-compare-frame";
		frame.setAttribute("referrerpolicy", "no-referrer");
		frame.title = title;
		frame.style.width = `${width}px`;
		frame.style.height = `${height}px`;
		return frame;
	}

	function setCompareMessage(text, isError) {
		els.compareMessage.textContent = text;
		els.compareMessage.classList.toggle("gd-error", Boolean(isError));
	}

	/**
	 * 100% by default; past the window width, "Scale to fit" shrinks the pair to fit.
	 * Overlay and Slider stack the pair at one artboard's size, so they are as wide as one frame.
	 */
	function layoutCompare() {
		const compare = state.compare;
		if (!compare) return;
		const { width, height } = compare.board.artboard;
		const stacked = state.compareMode !== "side";
		const needed = stacked ? width : width * 2 + COMPARE_GAP;
		els.comparePanes.style.width = stacked ? `${width}px` : "";
		els.comparePanes.style.height = stacked ? `${height}px` : "";
		const available = els.compareStage.getBoundingClientRect().width - COMPARE_PADDING * 2;
		const wide = needed > available;
		els.compareFitField.hidden = !wide;
		const scale = wide && els.compareFit.checked ? Math.max(0.05, available / needed) : 1;
		els.comparePanes.style.transform = scale === 1 ? "none" : `scale(${scale.toFixed(3)})`;
		// The sizer keeps the scroll area at the scaled size.
		els.compareSizer.style.width = scale === 1 ? "" : `${Math.ceil(needed * scale)}px`;
		els.compareSizer.style.height = scale === 1 ? "" : `${Math.ceil((stacked ? height : els.comparePanes.offsetHeight) * scale)}px`;
	}

	/** Side by side, Overlay or Slider: the same two frames restyled, so nothing reloads. */
	function setCompareView(mode) {
		const compare = state.compare;
		if (!compare) return;
		state.compareMode = mode;
		els.comparePanes.dataset.mode = mode;
		for (const [name, button] of Object.entries(els.compareModes)) button.setAttribute("aria-pressed", String(name === mode));
		const stacked = mode !== "side";
		compare.design.label.textContent = stacked ? "Design" : compare.design.caption;
		compare.app.label.textContent = stacked ? "App" : compare.app.caption;
		compare.handle.hidden = mode !== "slider";
		compare.shield.hidden = mode !== "slider";
		els.compareOpacityField.hidden = mode !== "overlay";
		if (stacked) els.comparePanes.setAttribute("role", "group");
		else els.comparePanes.removeAttribute("role");
		setCompareOpacity(compare.opacity);
		setCompareSplit(compare.pos);
		layoutCompare();
	}

	/** App opacity, 0 to 100: how much of the app shows over the design in Overlay. */
	function setCompareOpacity(value) {
		const compare = state.compare;
		if (!compare) return;
		compare.opacity = Math.min(100, Math.max(0, Math.round(value)));
		const text = `${compare.opacity}%`;
		els.compareOpacity.value = String(compare.opacity);
		els.compareOpacity.setAttribute("aria-valuetext", text);
		els.compareOpacityValue.textContent = text;
		compare.appFrame.style.opacity = state.compareMode === "overlay" ? String(compare.opacity / 100) : "";
		describeCompare();
	}

	/** The Slider position, 0 to 100: the design shows left of the line, the app right of it. */
	function setCompareSplit(value) {
		const compare = state.compare;
		if (!compare) return;
		compare.pos = clampSlider(value);
		compare.app.figure.style.clipPath = state.compareMode === "slider" ? `inset(0 0 0 ${compare.pos}%)` : "";
		compare.handle.style.left = `${compare.pos}%`;
		compare.handle.setAttribute("aria-valuenow", String(compare.pos));
		compare.handle.setAttribute("aria-valuetext", `${compare.pos}%: Design on the left, App on the right`);
		describeCompare();
	}

	/** The stacked pair is one group named for what it shows; side by side is two figures. */
	function describeCompare() {
		const compare = state.compare;
		if (!compare) return;
		const mode = state.compareMode;
		if (mode === "overlay") els.comparePanes.setAttribute("aria-label", `Design and running app overlaid, app at ${compare.opacity}% opacity`);
		else if (mode === "slider") els.comparePanes.setAttribute("aria-label", `Design and running app, split at ${compare.pos}%`);
		else els.comparePanes.removeAttribute("aria-label");
	}

	/** The artboard (sandboxed as on the canvas) next to the running app, both at the artboard's size. */
	function enterCompare(board, preview) {
		exitCompare(false);
		exitFocus();
		closePopover();
		setHoverBoard(null);
		const { width, height, title } = board.artboard;
		const artboardFrame = compareFrame(width, height, `${title} artboard`);
		artboardFrame.setAttribute("sandbox", "allow-scripts");
		// Like focus mode: the artboard owns its scroll, and Shift+Esc inside it asks to leave.
		artboardFrame.addEventListener("load", () => artboardFrame.contentWindow?.postMessage({ type: "gd:focus", enabled: true }, "*"));
		artboardFrame.src = boardUrl(board);
		const app = compareFrame(width, height, `Running app at ${preview}`);
		app.setAttribute("sandbox", PREVIEW_SANDBOX);
		const design = comparePane(`Design: ${board.artboard.file}`, artboardFrame);
		const running = comparePane(`Implementation: ${preview}`, app);
		const handle = splitHandle("Comparison position");
		const shield = splitShield();
		const compare = { board, preview, artboardFrame, appFrame: app, design, app: running, handle, shield, pos: 50, opacity: 50, timer: 0, loaded: false };
		bindSplitInput({ shield, handle, box: els.comparePanes, position: () => compare.pos, move: setCompareSplit });
		const failed = (text) => {
			if (state.compare === compare) setCompareMessage(text, true);
		};
		// A frame refused by X-Frame-Options or frame-ancestors may still fire load, so the
		// Open in new tab fallback is always shown; a missing load also says so.
		app.addEventListener("load", () => { compare.loaded = true; });
		app.addEventListener("error", () => failed(`The app at ${preview} could not be loaded in the frame. Use Open in new tab.`));
		compare.timer = setTimeout(() => {
			if (!compare.loaded) failed(`The app at ${preview} has not loaded; it may be down or refuse to be framed. Use Open in new tab.`);
		}, PREVIEW_TIMEOUT_MS);
		app.src = preview;
		state.compare = compare;
		els.compareTitle.textContent = `Compare: ${title}`;
		// A new tab with no opener and no Referer: the canvas URL carries the server token.
		els.compareOpen.setAttribute("target", "_blank");
		els.compareOpen.setAttribute("rel", "noopener noreferrer");
		els.compareOpen.href = preview;
		setCompareMessage(new URL(preview).hostname === "[::1]" ? IPV6_HINT : PREVIEW_HINT, false);
		els.comparePanes.replaceChildren(design.figure, running.figure, handle, shield);
		els.compareFit.checked = false;
		els.compare.hidden = false;
		els.viewport.inert = true;
		els.panel.inert = true;
		els.nav.inert = true;
		for (const control of [els.zoomOut, els.zoomIn, els.fit, els.railFit, els.railSystem, els.design, els.compareApp]) control.disabled = true;
		setCompareView(state.compareMode);
		els.compareBack.focus();
	}

	function exitCompare(restoreFocus) {
		const compare = state.compare;
		if (!compare) return;
		clearTimeout(compare.timer);
		state.compare = null;
		els.comparePanes.replaceChildren();
		els.compareOpen.removeAttribute("href");
		els.compare.hidden = true;
		els.viewport.inert = false;
		els.panel.inert = false;
		els.nav.inert = false;
		applyFocusState();
		if (!restoreFocus) return;
		const board = state.boards.find((candidate) => candidate.artboard.file === compare.board.artboard.file);
		const button = board ? Array.from(board.handoff.children).find((child) => child.classList.contains("gd-compare-start")) : null;
		(button ?? els.viewport).focus();
	}

	els.compareBack.addEventListener("click", () => exitCompare(true));
	els.compareFit.addEventListener("change", layoutCompare);
	for (const [mode, button] of Object.entries(els.compareModes)) button.addEventListener("click", () => setCompareView(mode));
	els.compareOpacity.addEventListener("input", () => {
		const compare = state.compare;
		if (!compare) return;
		const text = String(els.compareOpacity.value).trim();
		// Anything that is not a number leaves the opacity as it was.
		setCompareOpacity(text !== "" && Number.isFinite(Number(text)) ? Number(text) : compare.opacity);
	});

	function showFeature(manifest) {
		const feature = manifest && typeof manifest.feature === "string" ? manifest.feature : "";
		els.feature.textContent = feature;
		els.feature.hidden = !feature;
		els.featureSep.hidden = !feature;
		els.briefFeature.textContent = feature;
		els.briefFeature.hidden = !feature;
	}

	/** The Brief tab: the design's title, brief and feature document. */
	function renderBrief() {
		const manifest = state.manifest;
		els.briefTitle.textContent = manifest ? manifest.title : "No design selected";
		els.briefText.textContent = manifest ? (typeof manifest.brief === "string" && manifest.brief ? manifest.brief : "No brief written.") : "";
	}

	/** No design selected: only the system board, or the empty notice. */
	function showSystemOnly() {
		state.manifest = null;
		state.boards = [];
		showFeature(null);
		renderBrief();
		if (!state.systemBoard) {
			showEmpty("No designs yet. Run /gentle:design with a brief to create one.");
			return;
		}
		els.empty.hidden = true;
		placeBoards();
		renderHandoffViews();
		setStatus("", false);
		requestAnimationFrame(fit);
	}

	async function loadManifest(slug, keepView) {
		let manifest;
		try {
			manifest = await getJson(`api/designs/${encodeURIComponent(slug)}`);
		} catch (error) {
			showEmpty(`Design "${slug}" cannot be shown: ${error.message}`);
			setStatus(`design.json for ${slug} is invalid`, true);
			return;
		}
		if (slug !== state.slug) return;
		closePopover();
		state.manifest = manifest;
		showFeature(manifest);
		renderBrief();
		document.title = `${manifest.title} · Gentle Design`;
		history.replaceState(null, "", `${base}d/${encodeURIComponent(slug)}/`);
		if (manifest.artboards.length === 0 && !state.systemBoard) {
			showEmpty("This design has no artboards yet.");
			return;
		}
		els.empty.hidden = true;
		const focusFile = state.focus && !state.focus.system ? state.focus.artboard.file : null;
		state.boards.forEach(removeSizeFrames);
		state.boards = manifest.artboards.map((artboard, index) => createBoard(slug, artboard, false, index + 1));
		// A manifest reload keeps focus mode on the same artboard file while it still exists.
		if (focusFile) state.focus = state.boards.find((board) => board.artboard.file === focusFile) ?? state.focus;
		placeBoards();
		if (state.focus) requestAnimationFrame(applySize);
		const warnings = Array.isArray(manifest.warnings) ? manifest.warnings.filter((warning) => typeof warning === "string") : [];
		setStatus(warnings.length > 0 ? `design.json: ${warnings.join("; ")}` : state.boards.length === 0 ? "This design has no artboards yet." : "", warnings.length > 0);
		if (!keepView) requestAnimationFrame(fit);
		await loadHandoffs();
		await loadComments();
		loadHistory().catch(() => {});
	}

	function reloadBoard(board) {
		const url = `${boardUrl(board)}?v=${Date.now()}`;
		for (const surface of surfacesOf(board)) {
			surface.rects = null;
			surface.frame.src = url;
		}
	}

	/** The system board first, then the design's artboards. */
	function placeBoards() {
		const boards = allBoards();
		els.world.replaceChildren(...boards.map((board) => board.wrapper));
		if (state.focus && !boards.includes(state.focus)) exitFocus();
		else applyFocusState();
	}

	/** Reads api/system and creates or drops the system board; true when it appeared or went away. */
	async function refreshSystem() {
		let info = null;
		try { info = await getJson("api/system"); } catch { info = null; }
		const exists = Boolean(info && info.exists === true && isFiniteNumber(info.width) && isFiniteNumber(info.height));
		state.system = exists ? info : null;
		if (exists === Boolean(state.systemBoard)) return false;
		state.systemBoard = exists ? createBoard(null, { file: String(info.file), ...SYSTEM_LABEL, width: info.width, height: info.height }, true) : null;
		return true;
	}

	/** The tokens of design/system.md; none when it is missing, unreadable or malformed (the canvas never fails on it). */
	async function loadTokens() {
		let data = null;
		try { data = await getJson("api/system/tokens"); } catch { data = null; }
		const list = data && Array.isArray(data.tokens) ? data.tokens : [];
		state.tokens = list.slice(0, LIMITS.tokens)
			.filter((token) => token && typeof token.name === "string" && /^--[A-Za-z0-9_-]+$/.test(token.name) && typeof token.value === "string" && token.value.length > 0)
			.map((token) => ({ name: token.name, value: token.value, section: typeof token.section === "string" ? token.section : "", group: typeof token.group === "string" ? token.group : "other" }));
	}

	async function onSystemChange() {
		if (!(await refreshSystem())) {
			if (state.systemBoard) reloadBoard(state.systemBoard);
			return;
		}
		if (state.focus && !allBoards().includes(state.focus)) exitFocus();
		if (!state.slug) {
			showSystemOnly();
			return;
		}
		if (!state.manifest || state.manifest.slug !== state.slug) return;
		if (state.boards.length === 0 && !state.systemBoard) showEmpty("This design has no artboards yet.");
		else {
			els.empty.hidden = true;
			placeBoards();
		}
	}

	els.design.addEventListener("change", () => {
		exitCompare(false);
		state.slug = els.design.value;
		resetHistory();
		loadManifest(state.slug, false);
	});

	/**
	 * The server's show event (S14): `open` while this page is connected switches it to
	 * that design (null: the system-only view) and reloads every board from the server, so
	 * a change event this page missed is caught up. The same design refreshes in place and
	 * keeps zoom, pan and focus mode on the same artboard; another design leaves focus mode
	 * first, since its artboards differ.
	 */
	async function showDesign(slug) {
		const same = slug === state.slug;
		if (!same) {
			exitCompare(false);
			exitFocus();
			state.slug = slug;
			state.comments = [];
			state.activeId = null;
			resetHistory();
			renderComments();
		}
		if (!(await refreshSystem()) && state.systemBoard) reloadBoard(state.systemBoard);
		if (slug !== state.slug) return;
		try {
			await refreshDesigns(false);
		} catch (error) {
			setStatus(`Designs cannot be listed: ${error.message}`, true);
		}
		if (slug !== state.slug) return;
		if (slug === null) {
			history.replaceState(null, "", base);
			document.title = "Gentle Design";
			if (!same || !state.systemBoard) showSystemOnly();
			return;
		}
		await loadManifest(slug, same);
	}

	async function start() {
		applyView();
		loadTokens().catch(() => {});
		await refreshSystem();
		try {
			await refreshDesigns();
		} catch (error) {
			showEmpty(`Designs cannot be listed: ${error.message}`);
			return;
		}
		if (!state.slug) {
			showSystemOnly();
			return;
		}
		await loadManifest(state.slug, false);
	}

	// ---- live reload -------------------------------------------------------

	function connectEvents() {
		const source = new EventSource(`${base}events`);
		source.addEventListener("open", () => {
			if (els.status.classList.contains("gd-error")) setStatus("", false);
		});
		source.addEventListener("error", () => setStatus("Live reload disconnected, retrying…", true));
		source.addEventListener("show", (event) => {
			let request;
			try { request = JSON.parse(event.data); } catch { return; }
			if (!request || typeof request !== "object") return;
			if (request.slug !== null && !(typeof request.slug === "string" && /^[a-z0-9][a-z0-9-]*$/.test(request.slug))) return;
			showDesign(request.slug).catch(() => {});
		});
		// design/<slug>/.history changed (a version was stored): refresh the list of that design.
		source.addEventListener("history", (event) => {
			let change;
			try { change = JSON.parse(event.data); } catch { return; }
			if (!change || typeof change !== "object" || typeof change.slug !== "string" || change.slug !== state.slug) return;
			loadHistory().catch(() => {});
		});
		source.addEventListener("change", (event) => {
			let change;
			try { change = JSON.parse(event.data); } catch { return; }
			if (!change || typeof change.file !== "string") return;
			if (change.slug === null) {
				if (change.file === "system.html") onSystemChange().catch(() => {});
				else if (change.file === "system.md") loadTokens().catch(() => {});
				return;
			}
			if (typeof change.slug !== "string") return;
			if (change.file === "design.json") {
				refreshDesigns().then(() => {
					if (change.slug === state.slug) return loadManifest(state.slug, true);
					if (!state.manifest && state.slug) return loadManifest(state.slug, false);
					return undefined;
				}).catch(() => {});
				return;
			}
			if (change.slug !== state.slug) return;
			if (change.file === "comments.json") {
				loadComments();
				return;
			}
			if (change.file === "handoffs.json") {
				loadHandoffs();
				return;
			}
			if (state.compare && state.compare.board.artboard.file === change.file) state.compare.artboardFrame.src = `${boardUrl(state.compare.board)}?v=${Date.now()}`;
			if (state.vcompare && state.vcompare.board.artboard.file === change.file) state.vcompare.current.frame.src = `${boardUrl(state.vcompare.board)}?v=${Date.now()}`;
			const matching = state.boards.filter((board) => board.artboard.file === change.file);
			// A shared asset (CSS, image, font) can affect every artboard of the design.
			const targets = matching.length > 0 ? matching : change.file.endsWith(".html") ? [] : state.boards;
			targets.forEach(reloadBoard);
			targets.forEach(reloadThumb);
		});
	}

	// ---- token inspector -------------------------------------------------------
	// In Comment mode the artboard reports the element under the pointer (gd:inspect); the canvas compares its
	// colors, font, sizes, spacing and radius with the tokens of design/system.md (state.tokens), computes the
	// WCAG contrast and shows the result in a panel beside the artboard. Heuristics, not a full audit.

	const INSPECTOR_WIDTH = 280;
	const INSPECTOR_HEIGHT = 340;
	const INSPECTOR_GAP = 12;
	const INSPECTOR_HIDE_MS = 300;
	// Channels are whole numbers, so a token matches only when it is the same color; alpha tolerates hex rounding.
	const ALPHA_EPSILON = 0.01;
	const NEAR_ALPHA = 0.05;
	const SIZE_EPSILON = 0.01;

	function parseTokenColor(value) {
		const hex = /^#([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.exec(value.trim());
		if (hex) {
			const digits = hex[1].length <= 4 ? Array.from(hex[1], (digit) => digit + digit).join("") : hex[1];
			const channel = (index) => Number.parseInt(digits.slice(index * 2, index * 2 + 2), 16);
			return { r: channel(0), g: channel(1), b: channel(2), a: digits.length === 8 ? Math.round((channel(3) / 255) * 100) / 100 : 1 };
		}
		const rgb = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(value.trim());
		if (rgb && [rgb[1], rgb[2], rgb[3]].every((channel) => Number(channel) <= 255)) return { r: Number(rgb[1]), g: Number(rgb[2]), b: Number(rgb[3]), a: rgb[4] === undefined ? 1 : Math.min(1, Number(rgb[4])) };
		return null;
	}

	/** px of a token like `8px` or `0.5rem`, else null. */
	function parseTokenLength(value) {
		const match = /^(-?\d*\.?\d+)(px|rem)$/.exec(value.trim());
		return match ? Number(match[1]) * (match[2] === "rem" ? 16 : 1) : null;
	}

	function linearChannel(value) {
		const unit = value / 255;
		return unit <= 0.04045 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
	}

	/** WCAG relative luminance of an sRGB color. */
	function luminance(color) {
		return 0.2126 * linearChannel(color.r) + 0.7152 * linearChannel(color.g) + 0.0722 * linearChannel(color.b);
	}

	/** WCAG contrast ratio, 1 to 21. */
	function contrastRatio(a, b) {
		const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
		return (high + 0.05) / (low + 0.05);
	}

	/** OKLab coordinates, so distances follow perceived difference rather than sRGB channel values. */
	function oklab(color) {
		const r = linearChannel(color.r);
		const g = linearChannel(color.g);
		const b = linearChannel(color.b);
		const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
		const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
		const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
		return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
	}

	function colorDistance(a, b) {
		const [x, y] = [oklab(a), oklab(b)];
		return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]);
	}

	const hex2 = (value) => Math.round(value).toString(16).padStart(2, "0");
	const colorHex = (color) => `#${hex2(color.r)}${hex2(color.g)}${hex2(color.b)}${color.a !== undefined && color.a < 1 ? hex2(color.a * 255) : ""}`;
	const fmt = (value) => String(Number(value.toFixed(2)));
	/** Contrast shown to two decimals, never rounded up: 4.499 must not read as a pass. */
	const fmtRatio = (ratio) => String(Math.floor(ratio * 100) / 100);

	/** The tokens by what they can be compared with: colors, font families, and px lengths by purpose. */
	function tokenKinds() {
		const kinds = { color: [], family: [], radius: [], spacing: [], fontSize: [] };
		for (const token of state.tokens) {
			const color = parseTokenColor(token.value);
			const length = color ? null : parseTokenLength(token.value);
			if (color) kinds.color.push({ token, color });
			else if (length !== null) {
				if (token.group === "radius" || /radius/.test(token.name)) kinds.radius.push({ token, px: length });
				else if (token.group === "spacing" || /(^|-)(space|spacing|gap|pad|padding|margin)(-|$)/.test(token.name)) kinds.spacing.push({ token, px: length });
				else if (token.group === "font" || /font|text|type/.test(token.name)) kinds.fontSize.push({ token, px: length });
			} else if ((token.group === "font" || /font|family/.test(token.name)) && /[a-zA-Z]/.test(token.value)) kinds.family.push(token);
		}
		return kinds;
	}

	/** Families of a font stack, quotes stripped, split on commas outside quotes. */
	function familyList(value) {
		const families = [];
		let current = "";
		let quote = "";
		for (const char of value) {
			if (quote) {
				if (char === quote) quote = "";
				else current += char;
			} else if (char === "\"" || char === "'") quote = char;
			else if (char === ",") {
				families.push(current);
				current = "";
			} else current += char;
		}
		families.push(current);
		return families.map((family) => family.trim()).filter(Boolean);
	}

	const sameFamilies = (a, b) => a.length === b.length && a.every((family, index) => family.toLowerCase() === b[index].toLowerCase());

	const span = (className, text) => chip(className, text);
	const okChip = (text) => span("gd-inspector-ok", `✓ ${text}`);
	const badChip = (text) => span("gd-inspector-bad", `⚠ ${text}`);

	function swatch(color) {
		const box = span("gd-inspector-swatch", "");
		box.setAttribute("aria-hidden", "true");
		box.style.background = color.a === undefined || color.a >= 1 ? `rgb(${color.r}, ${color.g}, ${color.b})` : `rgba(${color.r}, ${color.g}, ${color.b}, ${color.a})`;
		return box;
	}

	function row(label, nodes) {
		const item = document.createElement("div");
		item.className = "gd-inspector-row";
		const term = document.createElement("dt");
		term.className = "gd-inspector-label";
		term.textContent = label;
		const value = document.createElement("dd");
		value.className = "gd-inspector-value";
		value.append(...nodes);
		item.append(term, value);
		return item;
	}

	/** A length against the tokens of one kind: exact token names, else the nearest by numeric distance. */
	function matchLength(px, candidates) {
		const exact = candidates.filter((candidate) => Math.abs(candidate.px - px) < SIZE_EPSILON).map((candidate) => candidate.token);
		if (exact.length > 0) return { exact };
		let nearest = null;
		for (const candidate of candidates) if (!nearest || Math.abs(candidate.px - px) < Math.abs(nearest.px - px)) nearest = candidate;
		return { exact: [], nearest: nearest ? nearest.token : null };
	}

	/** The nodes of a color row: swatch and hex, the matching token(s) or ⚠ no token with the nearest one. */
	function colorValue(color, tokens, flags, label) {
		const nodes = [swatch(color), span("gd-inspector-code", colorHex(color))];
		if (tokens.length === 0) return nodes;
		const same = tokens.filter((entry) => entry.color.r === color.r && entry.color.g === color.g && entry.color.b === color.b && Math.abs(entry.color.a - (color.a ?? 1)) < ALPHA_EPSILON);
		if (same.length > 0) {
			nodes.push(okChip(same.map((entry) => entry.token.name).join(" / ")));
			return nodes;
		}
		nodes.push(badChip("no token"));
		let nearest = null;
		let best = Infinity;
		for (const entry of tokens) {
			if (Math.abs(entry.color.a - (color.a ?? 1)) > NEAR_ALPHA) continue;
			const distance = colorDistance(color, entry.color);
			if (distance < best) {
				best = distance;
				nearest = entry;
			}
		}
		if (nearest) {
			nodes.push(span("gd-inspector-near", `Nearest ${nearest.token.name}`), span("gd-inspector-code", nearest.token.value));
			flags.push(`${label} ${colorHex(color)} is not a token; nearest is ${nearest.token.name} (${nearest.token.value}).`);
		} else flags.push(`${label} ${colorHex(color)} is not a token.`);
		return nodes;
	}

	/** A px value against tokens of one kind; no tokens of that kind means nothing to compare. */
	function lengthValue(px, candidates, flags, label) {
		const nodes = [span("gd-inspector-code", `${fmt(px)} px`)];
		if (candidates.length === 0) return nodes;
		const match = matchLength(px, candidates);
		if (match.exact.length > 0) {
			nodes.push(okChip(match.exact.map((token) => token.name).join(" / ")));
			return nodes;
		}
		nodes.push(badChip("no token"));
		if (match.nearest) {
			nodes.push(span("gd-inspector-near", `Nearest ${match.nearest.name}`), span("gd-inspector-code", match.nearest.value));
			flags.push(`${label} ${fmt(px)}px is not a token; nearest is ${match.nearest.name} (${match.nearest.value}).`);
		} else flags.push(`${label} ${fmt(px)}px is not a token.`);
		return nodes;
	}

	const sides = (values) => values.map(fmt).join(" ");

	/** The panel's rows for one measured element, and the flagged values as sentences. */
	function describeInspection(m) {
		const kinds = tokenKinds();
		const flags = [];
		const rows = [];
		const text = m.color;
		const behind = m.background;
		rows.push(row("Color", text ? colorValue(text, kinds.color, flags, "Text color") : [span("gd-inspector-code", "unreadable")]));
		rows.push(row("Background", behind ? colorValue(behind, kinds.color, flags, "Background") : [span("gd-inspector-code", "image or gradient")]));

		let contrast = [span("gd-inspector-code", "—")];
		if (m.hasText && text && !behind) contrast = [span("gd-inspector-code", "unknown background")];
		else if (m.hasText && text && behind) {
			const over = text.a < 1 ? { r: Math.round(text.r * text.a + behind.r * (1 - text.a)), g: Math.round(text.g * text.a + behind.g * (1 - text.a)), b: Math.round(text.b * text.a + behind.b * (1 - text.a)) } : text;
			const ratio = contrastRatio(over, behind);
			const large = m.fontSize >= 24 || (m.fontSize >= 18.66 && m.fontWeight >= 700);
			const needed = large ? 3 : 4.5;
			if (ratio >= needed) contrast = [okChip(`${fmtRatio(ratio)} : 1`), span("gd-inspector-near", large ? "AA large text (3 : 1)" : "AA (4.5 : 1)")];
			else {
				contrast = [badChip(`${fmtRatio(ratio)} : 1`), span("gd-inspector-near", `needs ${needed} : 1${large ? " (large text)" : ""}`)];
				flags.push(`Contrast ${fmtRatio(ratio)}:1 is below WCAG AA (${needed}:1 for ${large ? "large" : "normal"} text).`);
			}
		}
		rows.push(row("Contrast", contrast));

		const mine = familyList(m.fontFamily);
		const first = mine[0] || "—";
		const family = [span("gd-inspector-code", first)];
		family[0].title = m.fontFamily;
		if (kinds.family.length > 0) {
			const exact = kinds.family.filter((token) => sameFamilies(familyList(token.value), mine));
			const byFirst = exact.length > 0 ? exact : kinds.family.filter((token) => mine.length > 0 && familyList(token.value)[0]?.toLowerCase() === mine[0].toLowerCase());
			if (byFirst.length > 0) family.push(okChip(byFirst.map((token) => token.name).join(" / ")));
			else {
				family.push(badChip("no token"));
				flags.push(`Font family "${first}" is not a token (${kinds.family.map((token) => token.name).join(", ")}).`);
			}
		}
		rows.push(row("Font", family));
		rows.push(row("Size", [...lengthValue(m.fontSize, kinds.fontSize, flags, "Font size"), span("gd-inspector-near", `weight ${m.fontWeight}`)]));
		rows.push(row("Line height", [span("gd-inspector-code", m.lineHeight === null ? "normal" : `${fmt(m.lineHeight)} px`)]));

		const spacing = [];
		if (m.margin.some((value) => value !== 0)) spacing.push(span("gd-inspector-code", `margin ${sides(m.margin)}`));
		if (m.padding.some((value) => value !== 0)) spacing.push(span("gd-inspector-code", `padding ${sides(m.padding)}`));
		if (spacing.length === 0) spacing.push(span("gd-inspector-code", "—"));
		else if (kinds.spacing.length > 0) {
			const values = [...new Set([...m.margin, ...m.padding].filter((value) => value > 0))];
			const off = values.map((value) => ({ value, match: matchLength(value, kinds.spacing) })).filter((entry) => entry.match.exact.length === 0);
			if (off.length === 0) spacing.push(okChip("on scale"));
			for (const entry of off) {
				const near = entry.match.nearest;
				spacing.push(badChip(`${fmt(entry.value)} px off scale`));
				if (near) spacing.push(span("gd-inspector-near", `Nearest ${near.name}`), span("gd-inspector-code", near.value));
				flags.push(`Spacing ${fmt(entry.value)}px is not on the token scale${near ? `; nearest is ${near.name} (${near.value})` : ""}.`);
			}
		}
		rows.push(row("Spacing", spacing));

		const corners = m.radius;
		let radius;
		if (corners.every((value) => value === 0)) radius = [span("gd-inspector-code", "—")];
		else if (corners.every((value) => value === corners[0])) radius = lengthValue(corners[0], kinds.radius, flags, "Border radius");
		else {
			radius = [span("gd-inspector-code", `${sides(corners)} px`)];
			for (const value of new Set(corners.filter((corner) => corner > 0))) {
				const match = kinds.radius.length > 0 ? matchLength(value, kinds.radius) : { exact: [{}] };
				if (match.exact.length > 0) continue;
				radius.push(badChip(`${fmt(value)} px no token`));
				flags.push(`Border radius ${fmt(value)}px is not a token${match.nearest ? `; nearest is ${match.nearest.name} (${match.nearest.value})` : ""}.`);
			}
		}
		rows.push(row("Radius", radius));

		const message = flags.length > 0
			? `Fix the values on ${m.selector} that are off the design system (design/system.md):\n${flags.map((flag) => `- ${flag}`).join("\n")}`
			: `Nothing is off the design system on ${m.selector}.`;
		return { rows, flags, text: message.slice(0, LIMITS.comment) };
	}

	function finiteRgb(value, withAlpha) {
		if (value === null) return null;
		if (!value || typeof value !== "object") return undefined;
		if (!["r", "g", "b"].every((key) => isFiniteNumber(value[key]) && value[key] >= 0 && value[key] <= 255)) return undefined;
		if (!withAlpha) return { r: value.r, g: value.g, b: value.b };
		return isFiniteNumber(value.a) && value.a >= 0 && value.a <= 1 ? { r: value.r, g: value.g, b: value.b, a: value.a } : undefined;
	}

	function fourNumbers(value) {
		return Array.isArray(value) && value.length === 4 && value.every(isFiniteNumber) ? value.slice() : null;
	}

	/** A gd:inspect measurement checked field by field (the page is the design's own code, not trusted); null when malformed. */
	function readMeasure(raw) {
		if (!raw || typeof raw !== "object") return null;
		const selector = typeof raw.selector === "string" ? raw.selector.trim() : "";
		const rect = raw.rect && typeof raw.rect === "object" ? raw.rect : null;
		const color = finiteRgb(raw.color, true);
		const background = finiteRgb(raw.background, false);
		const margin = fourNumbers(raw.margin);
		const padding = fourNumbers(raw.padding);
		const radius = fourNumbers(raw.radius);
		if (!selector || selector.length > LIMITS.selector || !rect || !["x", "y", "width", "height"].every((key) => isFiniteNumber(rect[key]))) return null;
		if (color === undefined || background === undefined || !margin || !padding || !radius) return null;
		if (!isFiniteNumber(raw.fontSize) || !isFiniteNumber(raw.fontWeight) || typeof raw.fontFamily !== "string" || (raw.lineHeight !== null && !isFiniteNumber(raw.lineHeight))) return null;
		return {
			selector,
			label: typeof raw.label === "string" && raw.label ? raw.label.slice(0, 80) : selector.slice(0, 80),
			text: typeof raw.text === "string" ? raw.text.slice(0, LIMITS.excerpt) : "",
			hasText: raw.hasText === true,
			rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
			color, background, fontFamily: raw.fontFamily.slice(0, 300), fontSize: raw.fontSize, fontWeight: raw.fontWeight, lineHeight: raw.lineHeight,
			margin, padding, radius,
		};
	}

	/** Beside the frame (right, else left), level with the element; below or above it when the frame leaves no room. */
	function placeInspector(surface, rect) {
		const viewport = els.viewport.getBoundingClientRect();
		const box = surface.frame.getBoundingClientRect();
		const frame = { left: box.left, top: box.top, width: box.width, right: box.left + box.width };
		const scale = frame.width / surface.viewWidth || 1;
		const top = frame.top + rect.y * scale;
		const bottom = frame.top + (rect.y + rect.height) * scale;
		const width = els.inspector.offsetWidth || INSPECTOR_WIDTH;
		const height = els.inspector.offsetHeight || INSPECTOR_HEIGHT;
		const minX = viewport.left + INSPECTOR_GAP;
		const maxX = viewport.left + viewport.width - width - INSPECTOR_GAP;
		const minY = viewport.top + INSPECTOR_GAP;
		const maxY = Math.max(minY, viewport.top + viewport.height - height - INSPECTOR_GAP);
		const clamp = (value, low, high) => Math.min(Math.max(value, low), high);
		let x;
		let y = clamp(top, minY, maxY);
		if (frame.right + INSPECTOR_GAP <= maxX) x = frame.right + INSPECTOR_GAP;
		else if (frame.left - INSPECTOR_GAP - width >= minX) x = frame.left - INSPECTOR_GAP - width;
		else {
			x = clamp(frame.left + rect.x * scale, minX, Math.max(minX, maxX));
			y = clamp(bottom + 8 + height <= viewport.top + viewport.height - INSPECTOR_GAP ? bottom + 8 : top - 8 - height, minY, maxY);
		}
		els.inspector.style.left = `${x - viewport.left}px`;
		els.inspector.style.top = `${y - viewport.top}px`;
	}

	function showInspector(surface, measure) {
		const result = describeInspection(measure);
		// A new element cancels a pending hide (scheduleInspectorHide checks the generation).
		state.inspectGen += 1;
		state.inspect = { surface, measure, flags: result.flags, text: result.text };
		els.inspectorTitle.textContent = measure.label;
		els.inspectorSelector.textContent = measure.selector;
		els.inspectorSelector.title = measure.selector;
		els.inspectorList.replaceChildren(...result.rows);
		els.inspectorNote.hidden = state.tokens.length > 0;
		els.inspectorNote.textContent = "No design/system.md tokens found, so values and contrast are shown without a comparison.";
		const nothing = result.flags.length === 0;
		els.inspectorFix.disabled = nothing;
		els.inspectorFix.title = nothing ? "Nothing is off the design system, so there is nothing to fix." : "";
		els.inspector.hidden = false;
		placeInspector(surface, measure.rect);
	}

	function hideInspector() {
		state.inspectGen += 1;
		state.inspect = null;
		state.inspectorHover = false;
		els.inspector.hidden = true;
	}

	/** The element was left: the panel goes soon, unless the pointer or the keyboard is in it by then. */
	function scheduleInspectorHide() {
		const generation = ++state.inspectGen;
		setTimeout(() => {
			if (generation !== state.inspectGen) return;
			if (state.inspectorHover || els.inspector.contains(document.activeElement)) return;
			hideInspector();
		}, INSPECTOR_HIDE_MS);
	}

	els.inspector.addEventListener("pointerenter", () => { state.inspectorHover = true; });
	els.inspector.addEventListener("pointerleave", () => {
		state.inspectorHover = false;
		scheduleInspectorHide();
	});
	// The panel is not part of the artboard: wheel over it never pans the canvas.
	els.inspector.addEventListener("wheel", (event) => event.stopPropagation());

	els.inspectorFix.addEventListener("click", () => {
		const current = state.inspect;
		if (!current || current.flags.length === 0) return;
		const { surface, measure, text } = current;
		openPopover(surface, { selector: measure.selector, excerpt: measure.text, rect: measure.rect });
		els.text.value = text.slice(0, LIMITS.comment);
	});

	/** The Clipboard API, else the browser's copy command through a hidden text area. */
	async function copyText(text) {
		try {
			if (typeof navigator !== "undefined" && navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
				await navigator.clipboard.writeText(text);
				return true;
			}
		} catch { /* denied or unavailable: use the fallback */ }
		const previous = document.activeElement;
		const area = document.createElement("textarea");
		area.value = text;
		area.setAttribute("readonly", "");
		area.className = "gd-visually-hidden";
		document.body.append(area);
		try {
			area.focus?.();
			area.select?.();
			return typeof document.execCommand === "function" && document.execCommand("copy") === true;
		} catch {
			return false;
		} finally {
			area.remove();
			previous?.focus?.();
		}
	}

	els.inspectorCopy.addEventListener("click", async () => {
		const current = state.inspect;
		if (!current) return;
		const ok = await copyText(current.text);
		showToast(ok ? "Copied" : "Could not copy. Use Ask the agent to fix and copy the text from the comment box.", !ok);
	});

	// ---- accessibility checks -------------------------------------------------
	// Each artboard's own frame reports gd:checks after it loads (inspector.js). The result belongs to the
	// artboard until it reloads. They are heuristics, not a full audit: see docs/gentle-shell.md.

	const CHECK_IDS = ["contrast", "target", "alt", "label", "heading"];

	/** Failures of a board's last result (advice is not counted), or null when it has not reported. */
	function checkFailures(board) {
		return board.checks ? board.checks.checks.reduce((sum, check) => sum + check.count, 0) : null;
	}

	function boundedText(value, max) {
		return typeof value === "string" ? value.slice(0, max) : null;
	}

	/** A gd:checks report checked field by field; null when malformed. */
	function readChecks(data) {
		if (!Array.isArray(data.checks) || data.checks.length > 10 || !Array.isArray(data.issues) || data.issues.length > 200) return null;
		const checks = [];
		for (const entry of data.checks) {
			if (!entry || !CHECK_IDS.includes(entry.id) || typeof entry.label !== "string" || !Number.isInteger(entry.count) || entry.count < 0 || !Number.isInteger(entry.advice) || entry.advice < 0) return null;
			checks.push({ id: entry.id, label: entry.label.slice(0, 60), count: entry.count, advice: entry.advice });
		}
		const issues = [];
		for (const raw of data.issues) {
			if (!raw || !CHECK_IDS.includes(raw.check) || (raw.severity !== "fail" && raw.severity !== "advice")) return null;
			const title = boundedText(raw.title, 80);
			const detail = boundedText(raw.detail, 400);
			const selector = boundedText(raw.selector, LIMITS.selector);
			const label = boundedText(raw.label, 80);
			const rect = raw.rect && typeof raw.rect === "object" ? raw.rect : null;
			if (!title || detail === null || !selector || label === null || !rect || !["x", "y", "width", "height"].every((key) => isFiniteNumber(rect[key]))) return null;
			issues.push({ check: raw.check, severity: raw.severity, title, detail, selector, label, rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } });
		}
		return { checks, issues };
	}

	/** The Checks tab: its count and, while it is shown, one group per checked artboard. */
	function renderChecks() {
		const total = state.boards.reduce((sum, board) => sum + (checkFailures(board) ?? 0), 0);
		els.countChecks.textContent = String(total);
		if (state.tab !== "checks") return;
		const groups = state.boards.filter((board) => board.checks).map(checkGroup);
		if (groups.length === 0) {
			const empty = chip("gd-check-empty", "Checks run when an artboard loads.");
			els.checks.replaceChildren(empty);
			return;
		}
		els.checks.replaceChildren(...groups);
	}

	function checkGroup(board) {
		const { checks, issues } = board.checks;
		const failures = checkFailures(board);
		const group = document.createElement("section");
		group.className = "gd-check-group";
		group.setAttribute("aria-label", `Checks for ${String(board.number).padStart(2, "0")} ${board.artboard.title}`);
		const heading = document.createElement("h3");
		heading.className = "gd-check-heading";
		heading.textContent = `${String(board.number).padStart(2, "0")} ${board.artboard.title}`;
		const summary = chip(`gd-check-summary${failures === 0 ? " gd-check-summary-ok" : ""}`, failures === 0 ? "A11y ✓" : `${failures} check${failures === 1 ? "" : "s"}`);
		const head = document.createElement("div");
		head.className = "gd-check-head";
		head.append(heading, summary);
		const passed = checks.filter((check) => check.count === 0).map((check) => check.label);
		const parts = [head, ...issues.map((issue) => checkCard(board, issue))];
		if (passed.length > 0) parts.push(chip("gd-check-passed", `Passed: ${passed.join(" · ")}`));
		group.append(...parts);
		return group;
	}

	function checkCard(board, issue) {
		const fail = issue.severity === "fail";
		const card = document.createElement("article");
		card.className = `gd-check ${fail ? "gd-check-fail" : "gd-check-advice"}`;
		const body = document.createElement("div");
		body.className = "gd-check-body";
		const title = document.createElement("b");
		title.className = "gd-check-title";
		title.textContent = issue.title;
		const heading = document.createElement("div");
		heading.className = "gd-check-top";
		heading.append(title, chip("gd-check-kind", fail ? "Problem" : "Advice"));
		const detail = document.createElement("small");
		detail.className = "gd-check-detail";
		detail.textContent = issue.detail;
		const selector = document.createElement("code");
		selector.className = "gd-check-selector";
		selector.textContent = issue.selector;
		selector.title = issue.selector;
		const actions = document.createElement("div");
		actions.className = "gd-check-actions";
		const show = document.createElement("button");
		show.type = "button";
		show.className = "gd-check-show gd-small";
		show.setAttribute("aria-label", `Show ${issue.title} on ${issue.label} in ${String(board.number).padStart(2, "0")} ${board.artboard.title}`);
		show.append(icon("i-target", "gd-i gd-i-s"), chip("", "Show"));
		show.addEventListener("click", () => showIssue(board, issue));
		const fix = document.createElement("button");
		fix.type = "button";
		fix.className = "gd-check-fix gd-small";
		fix.setAttribute("aria-label", `Ask the agent to fix ${issue.title} on ${issue.label}`);
		fix.append(chip("", "Ask the agent to fix"));
		fix.addEventListener("click", () => askAboutIssue(board, issue));
		actions.append(show, fix);
		body.append(heading, detail, selector, actions);
		card.append(icon("i-alert", "gd-i gd-i-s gd-check-icon"), body);
		return card;
	}

	/** Brings an issue's artboard into view: another artboard's focus ends, and with none focused the canvas centers the element. */
	function revealIssue(board, issue) {
		if (state.focus && state.focus !== board) exitFocus();
		if (state.focus) return;
		const viewport = els.viewport.getBoundingClientRect();
		const frame = board.frame.getBoundingClientRect();
		const scale = frame.width / board.viewWidth || 1;
		const x = frame.left + (issue.rect.x + issue.rect.width / 2) * scale;
		const y = frame.top + (issue.rect.y + issue.rect.height / 2) * scale;
		panBy(viewport.left + viewport.width / 2 - x, viewport.top + viewport.height / 2 - y);
	}

	function showIssue(board, issue) {
		revealIssue(board, issue);
		for (const surface of surfacesOf(board)) surface.frame.contentWindow?.postMessage({ type: "gd:highlight", selector: issue.selector }, "*");
	}

	function askAboutIssue(board, issue) {
		revealIssue(board, issue);
		for (const surface of surfacesOf(board)) surface.frame.contentWindow?.postMessage({ type: "gd:highlight", selector: issue.selector }, "*");
		const fail = issue.severity === "fail";
		const text = fail
			? `Accessibility check on ${issue.selector}: ${issue.title}.\n${issue.detail}\nFix it so it meets WCAG 2.2 AA, keeping the design's tokens.`
			: `Accessibility advice on ${issue.selector}: ${issue.title}.\n${issue.detail}\nConsider fixing it, keeping the design's tokens.`;
		// In All sizes the artboard's own frame is hidden: ask on the Desktop frame, the manifest size.
		openPopover(board.sizeFrames.length > 0 ? board.sizeFrames[board.sizeFrames.length - 1] : board, { selector: issue.selector, excerpt: issue.label, rect: issue.rect });
		els.text.value = text.slice(0, LIMITS.comment);
	}

	// ---- version history ----------------------------------------------------------
	// design/<slug>/.history keeps earlier versions of every artboard (lib/design-history.ts). The History tab lists the
	// versions of one artboard: the focused one, else the chosen one, else the first. Compare puts an older version and the
	// current artboard over each other (a slider) or next to each other; Restore writes a version back through the server.
	// The frames of a comparison run sandboxed like artboards but are never registered as message sources: nothing they post is trusted.

	const VERSION_SOURCES = { agent: "Agent", hand: "You", restore: "Restore" };
	// Room above a comparison for its bar; below it the Back to canvas button keeps BACK_SPACE.
	const VERSIONS_BAR = 72;
	const VERSIONS_GAP = 20;
	const SLIDER_STEP = 2;
	const SLIDER_BIG_STEP = 10;

	/** `history/<slug>/<n>/<file>`: version n of an artboard, served read-only like an artboard. */
	function versionUrl(slug, n, file) {
		return `${base}history/${encodeURIComponent(slug)}/${n}/${file.split("/").map(encodeURIComponent).join("/")}`;
	}

	async function getReply(path) {
		let response;
		try {
			response = await fetch(base + path, { headers: { Accept: "application/json" }, cache: "no-store" });
		} catch (error) {
			return { status: 0, ok: false, body: { error: "network", reason: typeof error?.message === "string" ? error.message : String(error) } };
		}
		let body = null;
		try { body = await response.json(); } catch { body = null; }
		return { status: response.status, ok: response.ok, body: body || {} };
	}

	/** A GET history reply checked field by field; null when it is not one. */
	function readHistory(body) {
		if (!body || typeof body !== "object" || !body.artboards || typeof body.artboards !== "object" || Array.isArray(body.artboards)) return null;
		const artboards = new Map();
		for (const [file, entry] of Object.entries(body.artboards).slice(0, LIMITS.historyArtboards)) {
			const list = entry && Array.isArray(entry.versions) ? entry.versions.slice(0, LIMITS.versions) : [];
			const versions = [];
			for (const item of list) {
				if (!item || !Number.isInteger(item.n) || item.n < 1 || typeof item.createdAt !== "string" || !Object.prototype.hasOwnProperty.call(VERSION_SOURCES, item.source)) continue;
				const version = { n: item.n, createdAt: item.createdAt.slice(0, 64), source: item.source };
				if (typeof item.comment === "string" && item.comment.length <= 32) version.comment = item.comment;
				if (typeof item.note === "string" && item.note) version.note = item.note.slice(0, 500);
				versions.push(version);
			}
			if (versions.length > 0) artboards.set(file, versions.sort((a, b) => a.n - b.n));
		}
		const warnings = Array.isArray(body.warnings) ? body.warnings.filter((text) => typeof text === "string" && text).slice(0, 10).map((text) => text.slice(0, 300)) : [];
		return { artboards, warnings };
	}

	function resetHistory() {
		state.history = { slug: null, artboards: new Map(), warnings: [], error: null };
		state.restoreAsk = null;
		state.restoreError = null;
		renderHistory();
	}

	/** One load at a time; a request that arrives meanwhile (a burst of history events) runs once more afterwards. */
	function loadHistory() {
		if (!state.slug) return Promise.resolve();
		if (state.historyPending) {
			state.historyAgain = true;
			return state.historyPending;
		}
		const run = (async () => {
			do {
				state.historyAgain = false;
				await fetchHistory();
			} while (state.historyAgain);
		})().finally(() => { state.historyPending = null; });
		state.historyPending = run;
		return run;
	}

	async function fetchHistory() {
		const slug = state.slug;
		const reply = await getReply(`api/designs/${encodeURIComponent(slug)}/history`);
		if (slug !== state.slug) return;
		const parsed = reply.ok ? readHistory(reply.body) : null;
		const same = state.history.slug === slug;
		if (parsed) state.history = { slug, artboards: parsed.artboards, warnings: parsed.warnings, error: null };
		// A failed reload keeps the last good list and says why in the tab.
		else state.history = { slug, artboards: same ? state.history.artboards : new Map(), warnings: same ? state.history.warnings : [], error: reply.ok ? { status: 500, body: { error: "internal" } } : reply };
		renderHistory();
		refreshVersionCompare();
	}

	/** The artboard whose history the tab shows: the focused one, else the chosen one, else the first. */
	function historyBoard() {
		if (state.focus && !state.focus.system) return state.focus;
		return chosenBoard() ?? state.boards[0] ?? null;
	}

	function boardVersions(board) {
		if (!board || state.history.slug !== state.slug) return [];
		return state.history.artboards.get(board.artboard.file) ?? [];
	}

	function versionLabelTime(version) {
		return shortTime(version.createdAt);
	}

	function renderHistory() {
		const board = historyBoard();
		const versions = boardVersions(board);
		els.countHistory.textContent = String(versions.length);
		if (state.tab !== "history") return;
		if (!state.historyAlert) {
			state.historyAlert = createAlert();
			state.historyAlert.onDismiss = () => {
				state.restoreError = null;
				state.history.error = null;
			};
		}
		const keyed = new Map();
		const wanted = state.historyFocus ?? (els.history.contains(document.activeElement) ? document.activeElement.dataset.key : null);
		state.historyFocus = null;
		const alertReply = state.restoreError ?? state.history.error;
		if (alertReply) showAlert(state.historyAlert, alertReply, state.restoreError ? "restore" : undefined);
		else hideAlert(state.historyAlert);
		const parts = [];
		if (board) parts.push(chip("gd-history-title", `${String(board.number).padStart(2, "0")} ${board.artboard.title}`));
		parts.push(state.historyAlert.root);
		for (const warning of state.history.slug === state.slug ? state.history.warnings : []) parts.push(chip("gd-history-warning", warning));
		if (board && versions.length === 0) parts.push(chip("gd-history-empty", "No versions of this artboard yet. The canvas keeps one when it first sees an artboard and whenever its file changes."));
		const newest = versions[versions.length - 1];
		for (let index = versions.length - 1; index >= 0; index--) parts.push(versionCard(board, versions[index], newest, keyed));
		if (board) {
			const note = document.createElement("p");
			note.className = "gd-history-note";
			note.textContent = `Versions are kept in design/${state.slug}/.history/; Restore saves the current one first, so nothing is lost.`;
			parts.push(note);
		}
		els.history.replaceChildren(...parts);
		if (wanted) keyed.get(wanted)?.focus();
	}

	/** One version of the artboard: number, who and when, the comment it applied, the note, and its actions. */
	function versionCard(board, version, newest, keyed) {
		const current = version.n === newest.n;
		const comparing = Boolean(state.vcompare && state.vcompare.board === board && state.vcompare.n === version.n);
		const card = document.createElement("article");
		card.className = "gd-version";
		card.classList.toggle("gd-version-current", current);
		card.classList.toggle("gd-version-comparing", comparing);
		card.dataset.n = String(version.n);
		card.setAttribute("aria-label", `Version ${version.n}${current ? " (current)" : ""}`);
		const title = document.createElement("h4");
		title.className = "gd-version-title";
		title.append(chip("gd-version-number", `v${version.n}`));
		if (current) title.append(chip("gd-version-tag", "Current"));
		else if (version.n === 1) title.append(chip("gd-version-tag", "Original"));
		if (comparing) title.append(chip("gd-version-comparing-chip", "Comparing"));
		const comment = version.comment ? state.comments.find((candidate) => candidate.id === version.comment) : null;
		if (comment) title.append(chip("gd-version-applied", `Applied #${commentNumber(comment)}`));
		const time = versionLabelTime(version);
		const body = document.createElement("div");
		body.className = "gd-version-body";
		body.append(title, chip("gd-version-meta", time ? `${VERSION_SOURCES[version.source]} · ${time}` : VERSION_SOURCES[version.source]));
		if (version.note && version.source === "agent") {
			const reply = document.createElement("div");
			reply.className = "gd-version-reply";
			reply.append(chip("gd-version-reply-label", "Agent:"), chip("gd-version-reply-text", version.note));
			body.append(reply);
		} else if (version.note) body.append(chip("gd-version-note", version.note));
		const actions = document.createElement("div");
		actions.className = "gd-version-actions";
		const button = (className, label, iconName, aria, key, onClick) => {
			const element = document.createElement("button");
			element.type = "button";
			element.className = `${className} gd-small`;
			element.setAttribute("aria-label", aria);
			element.dataset.key = key;
			element.append(icon(iconName, "gd-i gd-i-s"), chip("", label));
			element.addEventListener("click", onClick);
			keyed.set(key, element);
			actions.append(element);
		};
		if (current) button("gd-version-view", "View", "i-eye", `View the current version, v${version.n}`, `view-${version.n}`, () => viewCurrent(board));
		else {
			button("gd-version-compare", "Compare with current", "i-compare", `Compare v${version.n} with the current version`, `compare-${version.n}`, () => startVersionCompare(board, version));
			button("gd-version-restore", "Restore", "i-restore", `Restore v${version.n}`, `restore-${version.n}`, () => askRestore(board, version));
		}
		const asking = state.restoreAsk && state.restoreAsk.slug === state.slug && state.restoreAsk.file === board.artboard.file && state.restoreAsk.n === version.n;
		actions.hidden = Boolean(asking);
		body.append(actions);
		if (asking) body.append(restoreConfirm(board, version, keyed));
		card.append(body);
		return card;
	}

	function restoreConfirm(board, version, keyed) {
		const box = document.createElement("div");
		box.className = "gd-version-confirm";
		box.setAttribute("role", "group");
		box.setAttribute("aria-label", `Confirm restoring v${version.n}`);
		const question = chip("gd-version-confirm-text", `Restore v${version.n}? The current version is saved first, so nothing is lost.`);
		const yes = document.createElement("button");
		yes.type = "button";
		yes.className = "gd-version-confirm-restore gd-primary gd-small";
		yes.textContent = "Restore";
		yes.dataset.key = `confirm-${version.n}`;
		yes.disabled = state.restoreBusy;
		const no = document.createElement("button");
		no.type = "button";
		no.className = "gd-version-confirm-cancel gd-small";
		no.textContent = "Cancel";
		no.dataset.key = `cancel-${version.n}`;
		const cancel = () => {
			state.restoreAsk = null;
			state.historyFocus = `restore-${version.n}`;
			renderHistory();
		};
		yes.addEventListener("click", () => restoreVersion(board, version));
		no.addEventListener("click", cancel);
		box.addEventListener("keydown", (event) => {
			if (event.key !== "Escape") return;
			event.preventDefault();
			event.stopPropagation();
			cancel();
		});
		keyed.set(yes.dataset.key, yes);
		keyed.set(no.dataset.key, no);
		box.append(question, yes, no);
		return box;
	}

	function askRestore(board, version) {
		state.restoreAsk = { slug: state.slug, file: board.artboard.file, n: version.n };
		state.restoreError = null;
		state.historyFocus = `confirm-${version.n}`;
		renderHistory();
	}

	/** Writes the version back through the server, which saves the current content first; the artboard then reloads. */
	async function restoreVersion(board, version) {
		const slug = state.slug;
		const file = board.artboard.file;
		state.restoreBusy = true;
		state.restoreError = null;
		renderHistory();
		const reply = await postJson(`api/designs/${encodeURIComponent(slug)}/history/restore`, { file, n: version.n });
		state.restoreBusy = false;
		state.restoreAsk = null;
		if (slug !== state.slug) return;
		if (!reply.ok) {
			state.restoreError = reply;
			state.historyFocus = `restore-${version.n}`;
			renderHistory();
			return;
		}
		const made = Number.isInteger(reply.body.version) ? reply.body.version : null;
		showToast(made === null ? `v${version.n} already has the current content, so nothing changed.` : `Restored v${version.n} as v${made}`, false);
		reloadBoard(board);
		reloadThumb(board);
		state.historyFocus = null;
		renderHistory();
		await loadHistory();
	}

	/** View on the current version: the artboard itself, in focus mode. */
	function viewCurrent(board) {
		closeVersionCompare(false, false);
		if (state.focus !== board) enterFocus(board);
		else board.frame.focus();
	}

	// ---- comparing a version with the current artboard

	function versionFrame(board, src, title) {
		const frame = document.createElement("iframe");
		frame.className = "gd-versions-frame";
		frame.setAttribute("sandbox", "allow-scripts");
		frame.setAttribute("referrerpolicy", "no-referrer");
		frame.setAttribute("tabindex", "-1");
		frame.title = title;
		frame.style.width = `${board.artboard.width}px`;
		frame.style.height = `${board.artboard.height}px`;
		frame.src = src;
		return frame;
	}

	/** A pane: its label, and a box clipping the scaled frame. */
	function versionPane(kind, board, src, title) {
		const root = document.createElement("div");
		root.className = `gd-versions-pane gd-versions-pane-${kind}`;
		const label = chip("gd-versions-label", "");
		const box = document.createElement("div");
		box.className = "gd-versions-box";
		const scale = document.createElement("div");
		scale.className = "gd-versions-scale";
		scale.style.width = `${board.artboard.width}px`;
		scale.style.height = `${board.artboard.height}px`;
		const frame = versionFrame(board, src, title);
		scale.append(frame);
		box.append(scale);
		root.append(label, box);
		return { root, label, box, scale, frame };
	}

	// ---- the split line shared by the version comparison and Compare's Slider mode

	/** A slider position, 0 to 100, to one decimal. */
	function clampSlider(value) {
		return Math.min(100, Math.max(0, Math.round(value * 10) / 10));
	}

	/** The vertical line with its knob: a named, focusable slider whose value the caller keeps (aria-valuenow and -valuetext). */
	function splitHandle(label) {
		const handle = document.createElement("div");
		handle.className = "gd-versions-handle";
		handle.setAttribute("role", "slider");
		handle.setAttribute("tabindex", "0");
		handle.setAttribute("aria-label", label);
		handle.setAttribute("aria-orientation", "horizontal");
		handle.setAttribute("aria-valuemin", "0");
		handle.setAttribute("aria-valuemax", "100");
		const knob = document.createElement("span");
		knob.className = "gd-versions-knob";
		knob.setAttribute("aria-hidden", "true");
		knob.textContent = "↔";
		handle.append(knob);
		return handle;
	}

	/** Frames take pointer events themselves, so a transparent shield over them carries the drag. */
	function splitShield() {
		const shield = document.createElement("div");
		shield.className = "gd-versions-shield";
		shield.setAttribute("aria-hidden", "true");
		return shield;
	}

	/** Pointer drag on the shield and arrows (Shift for a bigger step), Home and End on the handle; `move` gets the new position. */
	function bindSplitInput({ shield, handle, box, position, move }) {
		let dragging = null;
		const fromPointer = (clientX) => {
			const rect = box.getBoundingClientRect();
			return rect.width > 0 ? ((clientX - rect.left) / rect.width) * 100 : position();
		};
		shield.addEventListener("pointerdown", (event) => {
			if (event.button !== 0) return;
			dragging = event.pointerId;
			shield.setPointerCapture?.(event.pointerId);
			move(fromPointer(event.clientX));
			handle.focus();
		});
		shield.addEventListener("pointermove", (event) => {
			if (dragging === event.pointerId) move(fromPointer(event.clientX));
		});
		const endDrag = (event) => {
			if (dragging === event.pointerId) dragging = null;
		};
		shield.addEventListener("pointerup", endDrag);
		shield.addEventListener("pointercancel", endDrag);
		handle.addEventListener("keydown", (event) => {
			const step = event.shiftKey ? SLIDER_BIG_STEP : SLIDER_STEP;
			const next = { ArrowLeft: position() - step, ArrowDown: position() - step, ArrowRight: position() + step, ArrowUp: position() + step, Home: 0, End: 100 }[event.key];
			if (next === undefined) return;
			event.preventDefault();
			move(next);
		});
	}

	function startVersionCompare(board, version) {
		const versions = boardVersions(board);
		const newest = versions[versions.length - 1];
		if (!newest || version.n === newest.n) return;
		closeVersionCompare(false, false);
		const enteredFocus = state.focus !== board;
		if (enteredFocus) enterFocus(board);
		closePopover();
		const older = versionPane("old", board, versionUrl(state.slug, version.n, board.artboard.file), `${board.artboard.title} artboard, v${version.n}`);
		const current = versionPane("new", board, boardUrl(board), `${board.artboard.title} artboard, current version`);
		const box = document.createElement("div");
		box.className = "gd-versions-compare";
		box.setAttribute("role", "group");
		const handle = splitHandle("Comparison position");
		const shield = splitShield();
		box.append(older.root, current.root, handle, shield);
		const compare = { board, n: version.n, mode: "slider", pos: 50, enteredFocus, older, current, box, handle, shield };
		state.vcompare = compare;
		bindSplitInput({ shield, handle, box, position: () => compare.pos, move: setSlider });
		els.versionsTitle.textContent = `Compare versions · ${board.artboard.title}`;
		els.versionsStage.replaceChildren(box);
		els.versions.hidden = false;
		els.world.inert = true;
		setCompareMode("slider");
		renderHistory();
		handle.focus();
	}

	function setCompareMode(mode) {
		const compare = state.vcompare;
		if (!compare) return;
		compare.mode = mode;
		els.versionsStage.dataset.mode = mode;
		els.versionsModeSlider.setAttribute("aria-pressed", String(mode === "slider"));
		els.versionsModeSide.setAttribute("aria-pressed", String(mode === "side"));
		compare.handle.hidden = mode !== "slider";
		compare.shield.hidden = mode !== "slider";
		layoutVersions();
		setSlider(compare.pos);
	}

	/** The slider position, 0 to 100: where the line is; the older version shows left of it, the current one right of it. */
	function setSlider(value) {
		const compare = state.vcompare;
		if (!compare) return;
		compare.pos = clampSlider(value);
		compare.current.box.style.clipPath = compare.mode === "slider" ? `inset(0 0 0 ${compare.pos}%)` : "";
		compare.handle.style.left = `${compare.pos}%`;
		compare.handle.setAttribute("aria-valuenow", String(compare.pos));
		const versions = boardVersions(compare.board);
		const newest = versions[versions.length - 1];
		compare.handle.setAttribute("aria-valuetext", `${compare.pos}%: v${compare.n} on the left, v${newest ? newest.n : "?"} (current) on the right`);
		compare.box.setAttribute("aria-label", `Comparison of v${compare.n} and the current version of ${compare.board.artboard.title}`);
	}

	/** One scale for the frames, small enough to fit under the bar and above Back to canvas. */
	function layoutVersions() {
		const compare = state.vcompare;
		if (!compare) return;
		const viewport = els.viewport.getBoundingClientRect();
		const { width, height } = compare.board.artboard;
		const side = compare.mode === "side";
		const panes = side ? 2 : 1;
		const availableWidth = viewport.width - FOCUS_MARGIN * 2 - VERSIONS_GAP * (panes - 1);
		const availableHeight = viewport.height - VERSIONS_BAR - BACK_SPACE - (side ? SIZES_HEAD : 0);
		const scale = Math.max(MIN_SIZES_SCALE, Math.min(1, availableWidth / (width * panes), availableHeight / height));
		for (const pane of [compare.older, compare.current]) {
			pane.box.style.width = `${Math.round(width * scale)}px`;
			pane.box.style.height = `${Math.round(height * scale)}px`;
			pane.scale.style.transform = `scale(${scale})`;
		}
		compare.box.style.width = side ? "" : compare.older.box.style.width;
		compare.box.style.height = side ? "" : compare.older.box.style.height;
		renderVersionLabels();
	}

	function renderVersionLabels() {
		const compare = state.vcompare;
		if (!compare) return;
		const versions = boardVersions(compare.board);
		const older = versions.find((version) => version.n === compare.n);
		const newest = versions[versions.length - 1];
		const time = older ? versionLabelTime(older) : "";
		compare.older.label.textContent = time ? `v${compare.n} · ${time}` : `v${compare.n}`;
		compare.current.label.textContent = `v${newest ? newest.n : "?"} · Current`;
	}

	/** After the history changed: the labels follow the newest version, and a comparison whose version is gone closes. */
	function refreshVersionCompare() {
		const compare = state.vcompare;
		if (!compare) return;
		const versions = boardVersions(compare.board);
		const newest = versions[versions.length - 1];
		if (!newest || !versions.some((version) => version.n === compare.n) || compare.n === newest.n) {
			const gone = newest && compare.n !== newest.n ? `v${compare.n} is no longer kept, so the comparison was closed.` : `v${compare.n} is now the current version, so the comparison was closed.`;
			closeVersionCompare(true);
			showToast(gone, false);
			return;
		}
		renderVersionLabels();
		setSlider(compare.pos);
	}

	/**
	 * Ends the comparison. `leaveFocus`: when it was the comparison that put the artboard in focus mode, that ends too.
	 * `restoreFocus`: the keyboard goes back to the button that opened it.
	 */
	function closeVersionCompare(restoreFocus, leaveFocus = true) {
		const compare = state.vcompare;
		if (!compare) return;
		state.vcompare = null;
		els.versions.hidden = true;
		els.versionsStage.replaceChildren();
		els.world.inert = false;
		// After exitFocus: it renders the history itself and then moves the keyboard to the viewport.
		if (leaveFocus && compare.enteredFocus && state.focus === compare.board) exitFocus();
		state.historyFocus = restoreFocus ? `compare-${compare.n}` : null;
		renderHistory();
		if (restoreFocus && state.focus === compare.board) compare.board.frame.focus();
	}

	els.versionsModeSlider.addEventListener("click", () => setCompareMode("slider"));
	els.versionsModeSide.addEventListener("click", () => setCompareMode("side"));
	els.versionsClose.addEventListener("click", () => closeVersionCompare(true));

	// ---- comments ----------------------------------------------------------

	function commentsForBoard(board) {
		return state.comments.filter((comment) => comment.file === board.artboard.file);
	}

	function sendPins(surface) {
		const pins = commentsForBoard(ownerOf(surface)).slice(0, LIMITS.pins).map((comment) => ({ id: comment.id, selector: comment.selector }));
		surface.frame.contentWindow?.postMessage({ type: "gd:pins", pins }, "*");
	}

	/** Detached: the artboard is gone, or it reported that the selector matches nothing. */
	function isDetached(comment) {
		const board = state.boards.find((candidate) => candidate.artboard.file === comment.file);
		if (!board) return true;
		return Boolean(board.rects && board.rects.has(comment.id) && board.rects.get(comment.id) === null);
	}

	function detachedKey() {
		return state.comments.filter(isDetached).map((comment) => comment.id).join(",");
	}

	function commentNumber(comment) {
		return state.comments.indexOf(comment) + 1;
	}

	/** The pins of one frame, at their element's position in that frame; a size frame has its own set. */
	function renderPins(surface) {
		const pins = [];
		for (const comment of commentsForBoard(ownerOf(surface))) {
			const rect = surface.rects?.get(comment.id);
			if (!rect) continue;
			if (rect.x + rect.width < 0 || rect.y + rect.height < 0 || rect.x > surface.viewWidth || rect.y > surface.viewHeight) continue;
			const pin = document.createElement("button");
			pin.type = "button";
			pin.className = "gd-pin";
			pin.dataset.id = comment.id;
			pin.dataset.status = comment.status;
			pin.classList.toggle("gd-pin-active", comment.id === state.activeId);
			pin.textContent = String(commentNumber(comment));
			pin.setAttribute("aria-label", `Comment ${commentNumber(comment)} (${comment.status}): ${comment.comment}`);
			pin.style.left = `${Math.max(0, rect.x)}px`;
			pin.style.top = `${Math.max(0, rect.y)}px`;
			pin.addEventListener("click", (event) => {
				event.stopPropagation();
				selectComment(comment.id, { scroll: false, focusList: true });
			});
			pins.push(pin);
		}
		const focused = surface.pins.contains(document.activeElement) ? document.activeElement.dataset.id : null;
		surface.pins.replaceChildren(...pins);
		if (focused) pins.find((pin) => pin.dataset.id === focused)?.focus();
	}

	function renderList() {
		const open = state.comments.filter((comment) => comment.status === "open");
		const resolved = state.comments.filter((comment) => comment.status === "resolved");
		els.countOpen.textContent = String(open.length);
		els.countResolved.textContent = String(resolved.length);
		TAB_NAMES.forEach((name, index) => {
			const tab = tabButtons()[index];
			tab.setAttribute("aria-selected", String(state.tab === name));
			tab.setAttribute("tabindex", state.tab === name ? "0" : "-1");
		});
		els.tabPanel.setAttribute("aria-labelledby", tabButtons()[TAB_NAMES.indexOf(state.tab)].id);
		const unsent = open.filter((comment) => comment.sentAt === null).length;
		els.sendAll.textContent = `Send all (${unsent})`;
		els.sendAll.disabled = unsent === 0 || !DELIVERY.batch;
		const brief = state.tab === "brief";
		const checks = state.tab === "checks";
		const history = state.tab === "history";
		els.brief.hidden = !brief;
		els.checks.hidden = !checks;
		els.history.hidden = !history;
		els.list.hidden = brief || checks || history;
		renderChecks();
		renderHistory();
		const shown = state.tab === "resolved" ? resolved : open;
		els.panelEmpty.hidden = brief || checks || history || shown.length > 0;
		els.panelEmpty.textContent = state.comments.length === 0
			? "No comments yet. Turn on Comment mode and click an element."
			: state.tab === "open" ? "No open comments." : "No resolved comments.";
		els.list.replaceChildren(...shown.map((comment) => {
			const item = document.createElement("li");
			item.className = "gd-comment-item";
			item.dataset.id = comment.id;
			item.classList.toggle("gd-active", comment.id === state.activeId);
			const show = document.createElement("button");
			show.type = "button";
			show.className = "gd-comment-show";
			show.setAttribute("aria-label", `Show comment ${commentNumber(comment)} on ${comment.file}`);
			// Pin number, the element's selector, and whether the session has it yet.
			const meta = document.createElement("span");
			meta.className = "gd-comment-meta";
			const number = document.createElement("span");
			number.className = "gd-comment-number";
			number.textContent = String(commentNumber(comment));
			const selector = document.createElement("code");
			selector.className = "gd-comment-selector";
			selector.title = `${comment.file} · ${comment.selector}`;
			selector.textContent = comment.selector;
			meta.append(number, selector);
			const badge = (text, kind) => {
				const element = document.createElement("span");
				element.className = `gd-badge gd-badge-${kind}`;
				element.textContent = text;
				meta.append(element);
			};
			badge(comment.sentAt ? "Sent" : "Waiting", comment.sentAt ? "sent" : "unsent");
			if (isDetached(comment)) badge("Detached", "detached");
			const text = document.createElement("span");
			text.className = "gd-comment-text";
			text.style.display = "block";
			text.textContent = comment.comment;
			const file = document.createElement("span");
			file.className = "gd-comment-file";
			file.textContent = comment.file;
			show.append(meta, text);
			// Where the comment was made, when not at the artboard's own size.
			if (comment.viewport && typeof comment.viewport === "object") {
				const label = describeViewport(comment.viewport);
				const size = chip("gd-comment-viewport", label);
				size.title = `Made at ${label}`;
				show.append(size);
			}
			show.append(file);
			if (comment.screenshot) {
				const shot = document.createElement("img");
				shot.className = "gd-comment-shot";
				shot.alt = `Screenshot of comment ${commentNumber(comment)}`;
				shot.loading = "lazy";
				shot.src = `${base}api/designs/${encodeURIComponent(state.slug)}/comments/${encodeURIComponent(comment.id)}/screenshot`;
				show.append(shot);
			}
			show.addEventListener("click", () => selectComment(comment.id, { scroll: true, focusList: false }));
			const actions = document.createElement("div");
			actions.className = "gd-comment-actions";
			const toggle = document.createElement("button");
			toggle.type = "button";
			toggle.className = "gd-comment-toggle";
			const next = comment.status === "open" ? "resolved" : "open";
			toggle.textContent = next === "resolved" ? "Resolve" : "Reopen";
			toggle.setAttribute("aria-label", `${toggle.textContent} comment ${commentNumber(comment)}`);
			toggle.addEventListener("click", () => setCommentStatus(comment.id, next));
			actions.append(toggle);
			item.append(show);
			// What the agent did, from the note it gave when resolving; a reopened comment has none.
			if (comment.status === "resolved" && typeof comment.resolution === "string" && comment.resolution) {
				const reply = document.createElement("div");
				reply.className = "gd-comment-reply";
				reply.append(chip("gd-comment-reply-label", "Agent:"), chip("gd-comment-reply-text", comment.resolution));
				item.append(reply);
			}
			item.append(actions);
			if (state.cardErrors.has(comment.id)) {
				const alert = createAlert();
				showAlert(alert, state.cardErrors.get(comment.id));
				alert.onDismiss = () => { state.cardErrors.delete(comment.id); };
				item.append(alert.root);
			}
			return item;
		}));
	}

	function renderComments() {
		renderList();
		renderNav();
		state.boards.forEach((board) => surfacesOf(board).forEach(renderPins));
	}

	async function loadComments() {
		const slug = state.slug;
		if (!slug) return;
		let comments = [];
		try {
			comments = (await getJson(`api/designs/${encodeURIComponent(slug)}/comments`)).comments;
		} catch (error) {
			setStatus(`comments.json for ${slug} cannot be read: ${error.message}`, true);
		}
		if (slug !== state.slug || !Array.isArray(comments)) return;
		state.comments = comments;
		if (state.activeId && !comments.some((comment) => comment.id === state.activeId)) state.activeId = null;
		state.boards.forEach((board) => surfacesOf(board).forEach(sendPins));
		renderComments();
	}

	function selectComment(id, options) {
		state.activeId = id;
		renderComments();
		const comment = state.comments.find((candidate) => candidate.id === id);
		if (!comment) return;
		if (comment.status !== state.tab && options.focusList) setTab(comment.status);
		const board = state.boards.find((candidate) => candidate.artboard.file === comment.file);
		if (board) for (const surface of surfacesOf(board)) surface.frame.contentWindow?.postMessage({ type: "gd:highlight", id }, "*");
		if (options.focusList) els.list.querySelector(`[data-id="${CSS.escape(id)}"] .gd-comment-show`)?.focus();
		if (!options.scroll) return;
		// The focused artboard is already at 1:1; another board's comment leaves focus mode first.
		if (state.focus) {
			if (state.focus === board) return;
			exitFocus();
		}
		const pin = board?.pins.querySelector(`[data-id="${CSS.escape(id)}"]`);
		const target = pin ?? board?.frame;
		if (!target) return;
		const viewport = els.viewport.getBoundingClientRect();
		const rect = target.getBoundingClientRect();
		panBy(viewport.left + viewport.width / 2 - (rect.left + rect.width / 2), viewport.top + viewport.height / 2 - (rect.top + rect.height / 2));
	}

	async function postJson(path, body) {
		let response;
		try {
			response = await fetch(base + path, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				cache: "no-store",
				body: JSON.stringify(body),
			});
		} catch (error) {
			// The request itself failed: the server is gone or unreachable.
			return { status: 0, ok: false, body: { error: "network", reason: typeof error?.message === "string" ? error.message : String(error) } };
		}
		let reply = null;
		try { reply = await response.json(); } catch { reply = null; }
		return { status: response.status, ok: response.ok, body: reply || {} };
	}

	async function setCommentStatus(id, status) {
		const slug = state.slug;
		if (state.cardErrors.delete(id)) renderList();
		const reply = await postJson(`api/designs/${encodeURIComponent(slug)}/comments/${encodeURIComponent(id)}/status`, { status });
		if (!reply.ok) {
			// The failure stays in that comment's card until it is dismissed or the next attempt.
			state.cardErrors.set(id, reply);
			renderList();
			els.list.querySelector(`[data-id="${CSS.escape(id)}"] .gd-comment-toggle`)?.focus();
		} else showToast(status === "resolved" ? "Comment resolved" : "Comment reopened", false);
		await loadComments();
	}

	els.sendAll.addEventListener("click", async () => {
		const slug = state.slug;
		if (!slug) return;
		els.sendAll.disabled = true;
		hideAlert(sendAlert);
		const reply = await postJson(`api/designs/${encodeURIComponent(slug)}/comments/send-all`, {});
		if (!reply.ok) showAlert(sendAlert, reply);
		else showToast(reply.body.sent ? `Sent ${reply.body.sent} comment${reply.body.sent === 1 ? "" : "s"} to the session` : "No unsent comments", false);
		await loadComments();
		renderList();
	});

	function setMode(mode) {
		state.mode = mode === "collect" ? "collect" : "send";
		els.modeSend.checked = state.mode === "send";
		els.modeCollect.checked = state.mode === "collect";
		els.send.textContent = state.mode === "collect" ? "Save" : "Send";
		try { localStorage.setItem(MODE_KEY, state.mode); } catch { /* storage may be unavailable */ }
	}

	els.modeSend.addEventListener("change", () => setMode("send"));
	els.modeCollect.addEventListener("change", () => setMode("collect"));

	function tabButtons() {
		return [els.filterOpen, els.filterResolved, els.tabHistory, els.tabChecks, els.tabBrief];
	}

	function setTab(name) {
		state.tab = name;
		renderList();
		updateTabFades();
	}

	/** The tab row scrolls when it is wider than the panel; each edge with tabs behind it fades (L10, A2). */
	function updateTabFades() {
		const tabs = els.tabs;
		const left = Number(tabs.scrollLeft) || 0;
		const hidden = (Number(tabs.scrollWidth) || 0) - (Number(tabs.clientWidth) || 0);
		tabs.classList.toggle("gd-tabs-more-start", left > 1);
		tabs.classList.toggle("gd-tabs-more-end", left < hidden - 1);
	}

	els.tabs.addEventListener("scroll", updateTabFades);
	tabButtons().forEach((tab, index) => tab.addEventListener("click", () => setTab(TAB_NAMES[index])));
	// Arrow keys, Home and End move between the tabs, wrapping around.
	els.tabs.addEventListener("keydown", (event) => {
		const current = TAB_NAMES.indexOf(state.tab);
		const count = TAB_NAMES.length;
		const next = { ArrowRight: (current + 1) % count, ArrowLeft: (current + count - 1) % count, Home: 0, End: count - 1 }[event.key];
		if (next === undefined) return;
		event.preventDefault();
		setTab(TAB_NAMES[next]);
		tabButtons()[next].focus();
		tabButtons()[next].scrollIntoView({ block: "nearest", inline: "nearest" });
	});
	function setPanel(show) {
		els.panel.hidden = !show;
		els.panelToggle.setAttribute("aria-pressed", String(show));
	}

	els.panelToggle.addEventListener("click", () => setPanel(els.panel.hidden));

	function setNav(show) {
		els.nav.hidden = !show;
		els.navToggle.setAttribute("aria-pressed", String(show));
	}

	els.navToggle.addEventListener("click", () => setNav(els.nav.hidden));
	els.railSystem.addEventListener("click", () => { if (state.systemBoard) enterFocus(state.systemBoard); });

	function openShortcuts() {
		if (typeof els.shortcuts.showModal === "function") els.shortcuts.showModal();
		else els.shortcuts.setAttribute("open", "");
	}

	function closeShortcuts() {
		if (typeof els.shortcuts.close === "function") els.shortcuts.close();
		else els.shortcuts.removeAttribute("open");
		els.shortcutsOpen.focus();
	}

	els.shortcutsOpen.addEventListener("click", openShortcuts);
	els.shortcutsClose.addEventListener("click", closeShortcuts);

	function readRects(data) {
		if (!Array.isArray(data.rects) || data.rects.length > LIMITS.pins) return null;
		const rects = new Map();
		for (const entry of data.rects) {
			if (!entry || typeof entry.id !== "string" || entry.id.length > 32) return null;
			const rect = entry.rect;
			if (rect === null) rects.set(entry.id, null);
			else if (rect && ["x", "y", "width", "height"].every((key) => isFiniteNumber(rect[key]))) rects.set(entry.id, { x: rect.x, y: rect.y, width: rect.width, height: rect.height });
			else return null;
		}
		return rects;
	}

	/** Navigate and Comment are one pressed pair. */
	function renderTools() {
		els.comment.setAttribute("aria-pressed", String(state.commenting));
		els.toolNavigate.setAttribute("aria-pressed", String(!state.commenting));
	}

	function setCommenting(enabled) {
		state.commenting = enabled;
		renderTools();
		renderNavMode();
		els.world.classList.toggle("gd-commenting", enabled);
		state.boards.forEach((board) => board.sizesView?.classList.toggle("gd-commenting", enabled));
		state.boards.forEach((board) => surfacesOf(board).forEach(sendMode));
		if (!enabled) {
			setHoverBoard(null);
			closePopover();
		}
	}

	els.comment.addEventListener("click", () => setCommenting(!state.commenting));
	els.toolNavigate.addEventListener("click", () => setCommenting(false));

	// Single-key shortcuts. They never fire while typing, with a browser chord, while the comment
	// box or the shortcuts list is open, in Compare, or in focus mode (the artboard owns the keyboard
	// there; Shift+Esc is handled apart).
	const TYPING_TAGS = ["input", "textarea", "select"];
	document.addEventListener("keydown", (event) => {
		if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
		const target = event.target;
		if (target && (TYPING_TAGS.includes(target.localName) || target.isContentEditable)) return;
		if (els.shortcuts.hasAttribute("open")) {
			if (event.key === "?") {
				event.preventDefault();
				closeShortcuts();
			}
			return;
		}
		if (!els.popover.hidden || state.focus || state.compare) return;
		const actions = {
			v: () => setCommenting(false),
			c: () => setCommenting(true),
			f: fit,
			"[": () => setNav(els.nav.hidden),
			"]": () => setPanel(els.panel.hidden),
			"?": openShortcuts,
		};
		const action = actions[event.key.length === 1 ? event.key.toLowerCase() : ""];
		if (!action) return;
		event.preventDefault();
		action();
	});

	function isFiniteNumber(value) {
		return typeof value === "number" && Number.isFinite(value);
	}

	function readPick(data) {
		if (typeof data.selector !== "string") return null;
		const selector = data.selector.trim();
		if (!selector || selector.length > LIMITS.selector) return null;
		const excerpt = typeof data.excerpt === "string" ? data.excerpt.slice(0, LIMITS.excerpt) : "";
		const rect = data.rect && typeof data.rect === "object" ? data.rect : {};
		const box = ["x", "y", "width", "height"].every((key) => isFiniteNumber(rect[key])) ? rect : { x: 0, y: 0, width: 0, height: 0 };
		return { selector, excerpt, rect: { x: box.x, y: box.y, width: box.width, height: box.height } };
	}

	function openPopover(surface, pick) {
		hideInspector();
		clearTimeout(state.closeTimer);
		const board = ownerOf(surface);
		state.pick = { board, surface, viewport: viewportOf(surface), ...pick };
		els.target.textContent = `${board.artboard.file} · ${pick.selector}`;
		els.message.textContent = "";
		els.message.title = "";
		els.message.classList.remove("gd-error");
		els.send.disabled = false;
		els.popover.hidden = false;
		// Beside the element in the frame it was picked in, which may be scaled (All sizes) or resized (a single size).
		const frameRect = surface.frame.getBoundingClientRect();
		const scale = frameRect.width / surface.viewWidth || 1;
		const width = els.popover.offsetWidth;
		const height = els.popover.offsetHeight;
		let left = frameRect.left + pick.rect.x * scale;
		let top = frameRect.top + (pick.rect.y + pick.rect.height) * scale + 8;
		if (top + height > window.innerHeight - 12) top = frameRect.top + pick.rect.y * scale - height - 8;
		left = Math.min(Math.max(12, left), window.innerWidth - width - 12);
		top = Math.min(Math.max(12, top), window.innerHeight - height - 12);
		els.popover.style.left = `${left}px`;
		els.popover.style.top = `${top}px`;
		els.text.focus();
	}

	function clearShot() {
		state.shot = null;
		state.shotToken += 1;
		els.shotInput.value = "";
		els.shotImage.removeAttribute("src");
		els.shotPreview.hidden = true;
		els.shotAttach.hidden = false;
	}

	function shotError(message) {
		els.message.textContent = message;
		els.message.classList.add("gd-error");
	}

	/** Reads one image file into the popover; a later attach or a clear discards a read still running. */
	function attachShot(file) {
		if (!file || els.popover.hidden) return;
		if (!SCREENSHOT_TYPES.includes(file.type)) return shotError("Attach a PNG, JPEG, WebP or GIF image.");
		if (file.size === 0 || file.size > LIMITS.screenshotBytes) return shotError("The screenshot must be at most 5 MB.");
		const token = ++state.shotToken;
		const reader = new FileReader();
		reader.addEventListener("load", () => {
			if (token !== state.shotToken || typeof reader.result !== "string") return;
			const url = reader.result;
			state.shot = { mimeType: file.type, data: url.slice(url.indexOf(",") + 1) };
			els.shotImage.src = url;
			els.shotPreview.hidden = false;
			els.shotAttach.hidden = true;
			els.message.textContent = "";
			els.message.classList.remove("gd-error");
		});
		reader.addEventListener("error", () => { if (token === state.shotToken) shotError("The screenshot could not be read."); });
		reader.readAsDataURL(file);
	}

	function imageFile(list) {
		return Array.from(list || []).find((file) => file.type.startsWith("image/")) || (list && list[0]) || null;
	}

	els.shotAttach.addEventListener("click", () => els.shotInput.click());
	els.shotInput.addEventListener("change", () => attachShot(els.shotInput.files && els.shotInput.files[0]));
	els.shotRemove.addEventListener("click", () => {
		clearShot();
		els.shotAttach.focus();
	});
	els.popover.addEventListener("paste", (event) => {
		const items = Array.from(event.clipboardData ? event.clipboardData.items : []);
		const item = items.find((entry) => entry.kind === "file" && entry.type.startsWith("image/"));
		if (!item) return;
		event.preventDefault();
		attachShot(item.getAsFile());
	});
	els.popover.addEventListener("dragover", (event) => {
		if (!event.dataTransfer || !Array.from(event.dataTransfer.types).includes("Files")) return;
		event.preventDefault();
		event.dataTransfer.dropEffect = "copy";
		els.popover.classList.add("gd-dropping");
	});
	els.popover.addEventListener("dragleave", (event) => {
		if (!els.popover.contains(event.relatedTarget)) els.popover.classList.remove("gd-dropping");
	});
	els.popover.addEventListener("drop", (event) => {
		els.popover.classList.remove("gd-dropping");
		if (!event.dataTransfer || event.dataTransfer.files.length === 0) return;
		event.preventDefault();
		attachShot(imageFile(event.dataTransfer.files));
	});

	function closePopover() {
		hideInspector();
		if (els.popover.hidden) return;
		clearTimeout(state.closeTimer);
		const surface = state.pick && state.pick.surface;
		state.pick = null;
		clearShot();
		els.popover.hidden = true;
		surface?.frame.contentWindow?.postMessage({ type: "gd:clear" }, "*");
		if (els.popover.contains(document.activeElement) || document.activeElement === document.body) (state.focus ? state.focus.frame : els.comment).focus();
	}

	els.cancel.addEventListener("click", closePopover);
	els.popover.addEventListener("keydown", (event) => {
		if (event.key === "Escape") {
			event.preventDefault();
			closePopover();
		}
	});
	document.addEventListener("keydown", (event) => {
		if (event.defaultPrevented || event.key !== "Escape") return;
		// Esc and Shift+Esc close a version comparison first.
		if (state.vcompare) {
			event.preventDefault();
			closeVersionCompare(true);
			return;
		}
		if (event.shiftKey) {
			if (state.compare) {
				event.preventDefault();
				exitCompare(true);
				return;
			}
			if (!state.focus) return;
			event.preventDefault();
			exitFocus();
		} else if (state.commenting && els.popover.hidden && event.target === document.body) setCommenting(false);
	});

	els.form.addEventListener("submit", async (event) => {
		event.preventDefault();
		const pick = state.pick;
		if (!pick) return;
		const comment = els.text.value.trim();
		if (!comment || comment.length > LIMITS.comment) {
			els.message.textContent = `Write a comment of 1 to ${LIMITS.comment} characters.`;
			els.message.classList.add("gd-error");
			return;
		}
		els.send.disabled = true;
		els.message.classList.remove("gd-error");
		els.message.textContent = "Sending…";
		const shot = state.shot;
		const reply = await postJson("api/comments", { slug: pick.board.slug, file: pick.board.artboard.file, selector: pick.selector, excerpt: pick.excerpt, comment, mode: state.mode, ...(shot ? { screenshot: shot } : {}), ...(pick.viewport ? { viewport: pick.viewport } : {}) });
		// Delivery can fail after the comment was saved; it then waits for "Send all".
		const savedOnly = reply.status === 500 && reply.body.saved === true;
		if (!reply.ok && !savedOnly) {
			if (state.pick !== pick) return;
			const info = explain(reply);
			els.send.disabled = false;
			els.message.textContent = info.text;
			els.message.title = info.detail;
			els.message.classList.add("gd-error");
			return;
		}
		loadComments();
		if (state.pick !== pick) return;
		els.text.value = "";
		if (state.shot === shot) clearShot();
		const done = savedOnly ? "Saved, but not sent to the session. Use Send all to try again." : reply.status === 201 ? "Saved; use Send all to send it" : "Sent to the session";
		els.message.textContent = done;
		els.message.title = savedOnly ? explain(reply).detail : "";
		els.message.classList.toggle("gd-error", savedOnly);
		state.closeTimer = setTimeout(closePopover, savedOnly ? 2500 : 1200);
	});

	window.addEventListener("message", (event) => {
		// Shift+Esc inside the compared artboard leaves Compare; nothing else from it is trusted.
		if (state.compare && event.source === state.compare.artboardFrame.contentWindow) {
			if (event.data && typeof event.data === "object" && event.data.type === "gd:exit-focus") exitCompare(true);
			return;
		}
		// A board's own frame or, in All sizes, one of its size frames; nothing else is trusted.
		const surface = allBoards().flatMap(surfacesOf).find((candidate) => candidate.frame.contentWindow === event.source);
		if (!surface || !event.data || typeof event.data !== "object") return;
		const board = ownerOf(surface);
		const data = event.data;
		if (data.type === "gd:pick") {
			// The system board never takes comments, even if its page posts a pick.
			if (!state.commenting || board.system || (state.focus && board !== state.focus)) return;
			const pick = readPick(data);
			if (pick) openPopover(surface, pick);
		} else if (data.type === "gd:wheel") {
			if (![data.deltaX, data.deltaY, data.deltaMode, data.x, data.y].every(isFiniteNumber)) return;
			const frameRect = surface.frame.getBoundingClientRect();
			const scale = frameRect.width / surface.viewWidth || 1;
			handleWheel(data.deltaX, data.deltaY, data.deltaMode, data.zoom === true, data.shift === true, frameRect.left + data.x * scale, frameRect.top + data.y * scale);
		} else if (data.type === "gd:pin-rects") {
			if (board.system) return;
			const rects = readRects(data);
			if (!rects) return;
			const detachedBefore = detachedKey();
			surface.rects = rects;
			renderPins(surface);
			// Re-render the list only when a badge changes, so keyboard focus in it survives.
			// Only the artboard's own frame says whether a comment is detached.
			if (detachedKey() !== detachedBefore) renderList();
		} else if (data.type === "gd:overflow") {
			if (board.system || typeof data.overflow !== "boolean" || !isFiniteNumber(data.width) || !isFiniteNumber(data.scrollWidth)) return;
			// A report for another width is a late one from before the frame was resized.
			if (Math.round(data.width) !== surface.viewWidth) return;
			surface.overflow = data.overflow ? { scrollWidth: data.scrollWidth } : null;
			renderOverflow(surface);
		} else if (data.type === "gd:inspect") {
			// Only while commenting on the focused artboard (or any, in the overview), never while the comment box is open.
			if (board.system || !state.commenting || !els.popover.hidden || (state.focus && board !== state.focus)) return;
			if (data.element === null) {
				if (state.inspect && state.inspect.surface === surface) scheduleInspectorHide();
				return;
			}
			const measure = readMeasure(data.element);
			if (measure) showInspector(surface, measure);
		} else if (data.type === "gd:checks") {
			// Only the artboard's own frame says how the artboard is; the system board is never checked.
			if (board.system || surface !== board) return;
			const result = readChecks(data);
			if (!result) return;
			board.checks = result;
			renderChecks();
			renderNav();
		} else if (data.type === "gd:escape") {
			if (!els.popover.hidden) closePopover();
			else if (state.commenting) setCommenting(false);
		} else if (data.type === "gd:exit-focus") {
			// Only the focused artboard may end its own focus mode.
			if (board === state.focus) exitFocus();
		}
	});

	window.addEventListener("resize", closePopover);
	window.addEventListener("resize", layoutCompare);
	window.addEventListener("resize", layoutVersions);
	window.addEventListener("resize", updateTabFades);
	// The viewport also changes size when the comments panel opens or closes.
	if (typeof ResizeObserver === "function") new ResizeObserver(() => { centerFocus(); layoutVersions(); }).observe(els.viewport);
	else window.addEventListener("resize", () => centerFocus());

	setMode(state.mode);
	renderTools();
	if (!DELIVERY.batch) {
		const info = explain({ status: 501, body: { error: "batch-delivery-unavailable" } });
		els.sendNote.textContent = info.text;
		els.sendNote.title = info.detail;
		els.sendNote.hidden = false;
	}
	start();
	connectEvents();
})();
