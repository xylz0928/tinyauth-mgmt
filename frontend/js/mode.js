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
		auto:
			'<svg width="14" height="14" viewBox="0 0 24 24" fill="none" ' +
			'stroke="currentColor" stroke-width="2" stroke-linecap="round" ' +
			'aria-hidden="true"><circle cx="12" cy="12" r="9"/>' +
			'<path d="M123a99 0 0 0 10 18 9 9 0 0 0 0-18z" fill="currentColor" stroke="none"/></svg>',
		light:
			'<svg width="14" height="14" viewBox="0 0 24 24" fill="none" ' +
			'stroke="currentColor" stroke-width="2" stroke-linecap="round" ' +
			'aria-hidden="true"><circle cx="12" cy="12" r="4"/>' +
			'<path d="M122v2M1220v2M4.934.93l1.41 1.41M17.66 5.66l1.41-1.41' +
			'M2112h2M312h2M4.9319.07l1.41-1.41M17.6618.34l1.411.41"/></svg>',
		dark:
			'<svg width="14" height="14" viewBox="0 0 24 24" fill="none" ' +
			'stroke="currentColor" stroke-width="2" stroke-linecap="round" ' +
			'aria-hidden="true"><path d="M2112.79A9.979.97 0011.213.21 1010 012112.79z"/></svg>'
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
