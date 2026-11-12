/* tinyauth-mgmt — frontend core (vanilla, no build step)
   Role-driven navigation; identity comes from the reverse-proxy header chain,
   so the server is always the authority — the UI only adapts what's shown. */
(function () {
	"use strict";

	var me = null;          // {username, role}
	var currentView = null;

	/* ---------------- helpers ---------------- */

	function esc(s) {
		return String(s == null ? "" : s)
			.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
			.replace(/"/g, "&quot;").replace(/'/g, "&#39;");
	}

	function $(id) { return document.getElementById(id); }

	function toast(msg, kind) {
		var layer = $("toast-layer");
		var t = document.createElement("div");
		t.className = "toast" + (kind ? " " + kind : "");
		t.textContent = msg;
		layer.appendChild(t);
		setTimeout(function () {
			t.classList.add("out");
			setTimeout(function () { t.remove(); }, 250);
		}, 2600);
	}

	function fmtTime(epoch) {
		if (!epoch) return "—";
		var d = new Date(epoch * 1000);
		function p(n) { return (n < 10 ? "0" : "") + n; }
		return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) +
			" " + p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
	}

	function fmtRemaining(sec) {
		if (sec == null) return "—";
		if (sec <= 0) return "0m";
		var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60);
		return h > 0 ? h + "h " + m + "m" : m + "m";
	}

	/* api() → parsed JSON; throws {status, error} on failure */
	function api(path, opts) {
		return fetch(path, opts).then(function (r) {
			return r.json().catch(function () { return {}; }).then(function (body) {
				if (!r.ok) {
					var err = new Error(body.error || ("HTTP " + r.status));
					err.status = r.status;
					err.body = body;
					throw err;
				}
				return body;
			});
		});
	}

	function errorBox(err) {
		var hint = "";
		if (err.status === 401) {
			hint = "<p class=\"card-desc\">No identity received. The reverse proxy must " +
				"forward tinyauth's <code>Remote-User</code> header — see " +
				"<code>docs/reverse-proxy</code>.</p>";
		} else if (err.status === 403) {
			hint = "<p class=\"card-desc\">Forbidden. Check <code>GATEWAY_TOKEN</code> " +
				"and your <code>ADMIN_USERS</code> entry.</p>";
		}
		return "<div class=\"card\"><div class=\"error-box\">" +
			"<strong>" + esc(err.message) + "</strong>" + hint + "</div></div>";
	}

	/* ---------------- views ---------------- */

	var views = {
		admin: ["users", "sessions", "stack"],
		self: ["account"]
	};

	var viewMeta = {
		users:    { label: "Users" },
		sessions: { label: "Sessions" },
		stack:    { label: "Stack" },
		account:  { label: "My account" }
	};

	function renderNav() {
		var nav = $("nav");
		var list = views[me.role] || [];
		nav.innerHTML = list.map(function (v) {
			return "<button class=\"nav-tab\" data-view=\"" + v + "\" type=\"button\">" +
				esc(viewMeta[v].label) + "</button>";
		}).join("");
		nav.hidden = false;
		nav.querySelectorAll(".nav-tab").forEach(function (b) {
			b.addEventListener("click", function () { location.hash = "#" + b.dataset.view; });
		});
	}

	function setActiveTab(name) {
		document.querySelectorAll(".nav-tab").forEach(function (b) {
			b.classList.toggle("active", b.dataset.view === name);
		});
	}

	function route() {
		var name = (location.hash || "").replace(/^#/, "");
		var allowed = views[me.role] || [];
		if (allowed.indexOf(name) === -1) name = allowed[0];
		currentView = name;
		setActiveTab(name);
		viewsRender[name]();
	}

	/* ---- users ---- */

	function viewUsers() {
		var v = $("view");
		v.innerHTML = "<div class=\"card\"><div class=\"empty\"><span class=\"spinner\"></span> loading users…</div></div>";
		api("/api/admin/users").then(function (data) {
			var rows = data.users.map(function (u) {
				return "<tr>" +
					"<td><strong>" + esc(u.username) + "</strong></td>" +
					"<td>" + (u.has_totp
						? "<span class=\"badge primary\">TOTP</span>"
						: "<span class=\"badge\">no totp</span>") + "</td>" +
					"<td>" + esc(u.active_sessions) + " / " + esc(u.total_sessions) + "</td>" +
					"</tr>";
			}).join("");
			v.innerHTML =
				"<div class=\"card\">" +
				"  <h2 class=\"card-title\">Users</h2>" +
				"  <p class=\"card-desc\">Local accounts from the tinyauth users file · " +
				"active / total sessions</p>" +
				"  <div class=\"table-wrap\"><table class=\"data\">" +
				"    <thead><tr><th>Username</th><th>TOTP</th><th>Sessions (active / total)</th></tr></thead>" +
				"    <tbody>" + (rows || "<tr><td colspan=\"3\" class=\"empty\">no users</td></tr>") + "</tbody>" +
				"  </table></div>" +
				"  <div class=\"card-actions\"><button class=\"btn small\" id=\"users-refresh\">Refresh</button></div>" +
				"</div>";
			$("users-refresh").addEventListener("click", viewUsers);
		}).catch(function (err) { v.innerHTML = errorBox(err); });
	}

	/* ---- sessions ---- */

	var sessionFilter = "";

	function viewSessions() {
		var v = $("view");
		v.innerHTML = "<div class=\"card\"><div class=\"empty\"><span class=\"spinner\"></span> loading sessions…</div></div>";
		api("/api/admin/sessions").then(function (data) {
			var all = data.sessions || [];
			var q = sessionFilter.trim().toLowerCase();
			var list = q ? all.filter(function (s) {
				return s.username.toLowerCase().indexOf(q) !== -1 ||
					s.uuid.toLowerCase().indexOf(q) !== -1;
			}) : all;

			var rows = list.map(function (s) {
				var st = s.status;
				var cls = st === "active" ? "success" : (st === "expired" ? "error" : "warn");
				var flags = (s.flags || []).map(function (f) {
					return "<span class=\"tag\">" + esc(f) + "</span> ";
				}).join("");
				return "<tr>" +
					"<td><span class=\"chip\">" + esc(s.uuid) + "</span></td>" +
					"<td><strong>" + esc(s.username) + "</strong></td>" +
					"<td>" + esc(s.provider) + "</td>" +
					"<td>" + esc(fmtTime(s.created_at)) + "</td>" +
					"<td>" + esc(fmtTime(s.expires_at)) + "</td>" +
					"<td>" + esc(fmtRemaining(s.remaining)) + "</td>" +
					"<td><span class=\"badge " + cls + "\">" + esc(st) + "</span></td>" +
					"<td>" + flags + "</td>" +
					"</tr>";
			}).join("");

			v.innerHTML =
				"<div class=\"card\">" +
				"  <h2 class=\"card-title\">Sessions</h2>" +
				"  <p class=\"card-desc\">Every session in tinyauth's store · " +
				"expiry slides on use, hard cap " + esc(fmtRemaining(data.session_max_lifetime)) + " from login</p>" +
				"  <div class=\"toolbar\">" +
				"    <input type=\"search\" id=\"sess-filter\" placeholder=\"filter by username or uuid\" value=\"" + esc(sessionFilter) + "\">" +
				"    <span class=\"grow\"></span>" +
				"    <button class=\"btn small\" id=\"sess-refresh\">Refresh</button>" +
				"  </div>" +
				"  <div class=\"table-wrap\"><table class=\"data\">" +
				"    <thead><tr><th>UUID</th><th>User</th><th>Provider</th>" +
				"    <th>Created</th><th>Expires</th><th>Remaining</th><th>Status</th><th>Flags</th></tr></thead>" +
				"    <tbody>" + (rows || "<tr><td colspan=\"8\" class=\"empty\">no sessions match</td></tr>") + "</tbody>" +
				"  </table></div>" +
				"</div>";

			$("sess-refresh").addEventListener("click", viewSessions);
			$("sess-filter").addEventListener("input", function (e) {
				sessionFilter = e.target.value;
				viewSessions();
				var input = $("sess-filter");
				if (input) { input.focus(); input.setSelectionRange(input.value.length, input.value.length); }
			});
		}).catch(function (err) { v.innerHTML = errorBox(err); });
	}

	/* ---- stack / image ---- */

	function viewStack() {
		var v = $("view");
		v.innerHTML = "<div class=\"card\"><div class=\"empty\"><span class=\"spinner\"></span> loading stack info…</div></div>";
		api("/api/admin/image").then(function (d) {
			var matchBadge = d.compose_image == null
				? "<span class=\"badge\">compose n/a</span>"
				: (d.match
					? "<span class=\"badge success\">match</span>"
					: "<span class=\"badge error\">mismatch</span>");
			var health = d.health
				? "<span class=\"badge " + (d.health === "healthy" ? "success" : "warn") + "\">" + esc(d.health) + "</span>"
				: "<span class=\"badge\">n/a</span>";
			v.innerHTML =
				"<div class=\"card\">" +
				"  <h2 class=\"card-title\">Stack</h2>" +
				"  <p class=\"card-desc\">Running container vs compose declaration " + matchBadge + " · health " + health + "</p>" +
				"  <dl class=\"kv\">" +
				"    <dt>container</dt><dd>" + esc(d.container_name || "—") + "</dd>" +
				"    <dt>state</dt><dd>" + esc(d.state || "—") + "</dd>" +
				"    <dt>image (running)</dt><dd>" + esc(d.container_image || "—") + "</dd>" +
				"    <dt>image (compose)</dt><dd>" + esc(d.compose_image || (d.compose_note || "—")) + "</dd>" +
				"    <dt>compose project</dt><dd>" + esc(d.project || "—") + "</dd>" +
				"    <dt>created</dt><dd>" + esc(fmtTime(d.created)) + "</dd>" +
				"  </dl>" +
				"  <div class=\"card-actions\"><button class=\"btn small\" id=\"stack-refresh\">Refresh</button></div>" +
				"</div>";
			$("stack-refresh").addEventListener("click", viewStack);
		}).catch(function (err) { v.innerHTML = errorBox(err); });
	}

	/* ---- account (self service; mutation APIs land next milestone) ---- */

	function viewAccount() {
		$("view").innerHTML =
			"<div class=\"card\">" +
			"  <h2 class=\"card-title\">My account</h2>" +
			"  <p class=\"card-desc\">Signed in as <strong>" + esc(me.username) + "</strong></p>" +
			"  <div class=\"field\">" +
			"    <span class=\"field-label\">Change password</span>" +
			"    <span class=\"field-hint\">Self-service password change arrives with the next " +
			"milestone (mutation API). Sessions of other devices can be kicked afterwards.</span>" +
			"  </div>" +
			"  <div class=\"field\">" +
			"    <span class=\"field-label\">My TOTP</span>" +
			"    <span class=\"field-hint\">Enable / rebind / remove your own TOTP arrives with " +
			"the next milestone.</span>" +
			"  </div>" +
			"</div>";
	}

	var viewsRender = {
		users: viewUsers,
		sessions: viewSessions,
		stack: viewStack,
		account: viewAccount
	};

	/* ---------------- boot ---------------- */

	function boot() {
		var btn = $("theme-toggle");
		btn.addEventListener("click", function () { window.__tmTheme.cycle(); });

		api("/api/me").then(function (m) {
			me = m;
			$("identity").hidden = false;
			$("identity-user").textContent = m.username;
			var rb = $("identity-role");
			rb.textContent = m.role === "admin" ? "admin" : "self";
			rb.className = "role-badge " + (m.role === "admin" ? "admin" : "self");
			renderNav();
			window.addEventListener("hashchange", route);
			route();
		}).catch(function (err) {
			$("identity").hidden = false;
			$("identity-user").textContent = "no identity";
			$("identity-role").textContent = "error";
			$("identity-role").className = "role-badge self";
			$("view").innerHTML = errorBox(err);
		});
	}

	document.addEventListener("DOMContentLoaded", boot);
})();
