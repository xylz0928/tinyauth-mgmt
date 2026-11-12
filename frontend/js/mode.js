/* tinyauth-mgmt — dark mode: auto (default) | light | dark
   Mechanism inherited from luci-theme-liquid: <html data-darkmode="true|false">.
   State persisted in localStorage; auto follows prefers-color-scheme live. */
(function () {
	"use strict";
	var KEY = "tm-mode";            // auto | light | dark
	var mq = window.matchMedia("(prefers-color-scheme: dark)");

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
			btn.textContent = mode === "auto" ? "Auto" : (mode === "dark" ? "Dark" : "Light");
			btn.title = "Theme: " + mode + " (click to cycle)";
		}
	}

	// apply before first paint (this script is loaded synchronously in <head>)
	apply(current());

	mq.addEventListener("change", function () {
		if (current() === "auto") apply("auto");
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
