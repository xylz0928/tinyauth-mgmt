/* tinyauth-mgmt — dark mode: auto (default) | light | dark
   Mechanism inherited from luci-theme-liquid: <html data-darkmode="true|false">.
   State persisted in localStorage; auto follows prefers-color-scheme live.
   The header control is an ICON (three states), so it can never be confused
   with the text-based language toggle next to it. */
(function () {
	"use strict";
	var KEY = "tm-mode";            // auto | light | dark
	var mq = window.matchMedia("(prefers-color-scheme: dark)");

	var ICONS = {
	/* NOTE: SVG path numbers MUST be space-separated — "M12 2v2" cannot be
	   written "M122v2" (it parses as x=122, off-canvas). All three icons were
	   broken exactly that way. */
	auto:
		'<svg width="16" height="16" viewBox="0 0 24 24" fill="none" ' +
		'stroke="currentColor" stroke-width="1.8" stroke-linecap="round" ' +
		'stroke-linejoin="round" aria-hidden="true">' +
		'<circle cx="12" cy="12" r="9"/>' +
		'<path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor" stroke="none"/></svg>',
	light:
		'<svg width="16" height="16" viewBox="0 0 24 24" fill="none" ' +
		'stroke="currentColor" stroke-width="1.8" stroke-linecap="round" ' +
		'stroke-linejoin="round" aria-hidden="true">' +
		'<circle cx="12" cy="12" r="4"/>' +
		'<path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 5.66l1.41-1.41 ' +
		'M21 12h2M3 12h2M4.93 19.07l1.41-1.41M17.66 18.34l1.41 1.41"/></svg>',
	dark:
		'<svg width="16" height="16" viewBox="0 0 24 24" fill="none" ' +
		'stroke="currentColor" stroke-width="1.8" stroke-linecap="round" ' +
		'stroke-linejoin="round" aria-hidden="true">' +
		'<path d="M21 12.79A9.97 9.97 0 0 1 11.21 3.21 10 10 0 0 0 21 12.79z"/></svg>'
};

	function current() {
		var m = localStorage.getItem(KEY);
		return (m === "light" || m === "dark") ? m : "auto";
	}

	function apply(mode) {
		var dark = mode === "dark" || (mode === "auto" && mq.matches);
		var el = document.documentElement;
		el.setAttribute("data-darkmode", dark ? "true" : "false");
		el.setAttribute("data-mode", mode);
		var btn = document.getElementById("theme-toggle");
		if (btn) {
			btn.innerHTML = ICONS[mode] || ICONS.auto;
			btn.title = "Theme: " + mode + " (click to cycle)";
		}
	}

	// apply before first paint (this script is loaded synchronously in <head>)
	apply(current());

	mq.addEventListener("change", function () {
		if (current() === "auto") apply("auto");
	});

	// the button only exists once the body is parsed
	document.addEventListener("DOMContentLoaded", function () {
		apply(current());
	});

	window.__tmTheme = {
		get: current,
		cycle: function () {
			var order = ["auto", "light", "dark"];
			var next = order[(order.indexOf(current()) + 1) % order.length];
			localStorage.setItem(KEY, next);
			apply(next);
			return next;
		}
	};
})();
