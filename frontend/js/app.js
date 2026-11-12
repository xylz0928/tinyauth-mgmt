/* tinyauth-mgmt — frontend core (vanilla, no build step)
   Role-driven navigation; identity comes from the reverse-proxy header chain,
   so the server is always the authority — the UI only adapts what's shown. */
(function () {
	"use strict";

	var me = null;          // {username, role, has_totp}
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
		}, kind === "error" ? 4200 : 2800);
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

	/* api() → parsed JSON; throws {status, message} on failure */
	function api(path, opts) {
		return fetch(path, opts).then(function (r) {
			return r.json().catch(function () { return {}; }).then(function (body) {
				if (!r.ok) {
					var err = new Error(body.error || ("HTTP " + r.status));
					err.status = r.status;
					if (r.status === 401 && body.login_url) {
						// session gone: tinyauth hands us the login URL — send the
						// user back to the console root instead of a raw JSON API
						var target = body.login_url.replace(
							/redirect_uri=[^&]*/,
							"redirect_uri=" + encodeURIComponent(window.location.origin + "/"));
						window.location.href = target;
						return new Promise(function () {});  // navigation takes over
					}
					throw err;
				}
				return body;
			});
		});
	}

	function apiPost(path, data) {
		return api(path, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(data || {})
		});
	}

	function apiDelete(path) {
		return api(path, { method: "DELETE" });
	}

	function errorBox(err) {
		var hint = "";
		if (err && err.status === 401) {
			hint = "<p class=\"card-desc\">No identity received. The reverse proxy must " +
				"forward tinyauth's <code>Remote-User</code> header — see " +
				"<code>docs/reverse-proxy</code>.</p>";
		} else if (err && err.status === 403) {
			hint = "<p class=\"card-desc\">Forbidden. Check <code>GATEWAY_TOKEN</code> " +
				"and your <code>ADMIN_USERS</code> entry.</p>";
		}
		return "<div class=\"card\"><div class=\"error-box\">" +
			"<strong>" + esc(err && err.message ? err.message : "request failed") +
			"</strong>" + hint + "</div></div>";
	}

	/* restart outcome is advisory: file/db changes are already durable */
	function reportRestart(res, okMsg) {
		if (res && res.restart_ok === false) {
			toast(okMsg + " — restart failed: " + (res.restart_error || "unknown"), "warn");
		} else {
			toast(okMsg, "success");
		}
	}

	/* ---------------- modal system ---------------- */

	function modal(opts) {
		var back = document.createElement("div");
		back.className = "modal-backdrop";
		var box = document.createElement("div");
		box.className = "modal";
		box.innerHTML =
			"<h3></h3><div class=\"modal-body\"></div><div class=\"modal-actions\"></div>";
		box.querySelector("h3").textContent = opts.title || "";
		back.appendChild(box);
		document.body.appendChild(back);

		var bodyEl = box.querySelector(".modal-body");
		var actionsEl = box.querySelector(".modal-actions");
		bodyEl.innerHTML = opts.body || "";
		var handler = opts.onAction || function () { return Promise.resolve(true); };
		var closed = false;

		function close() {
			if (closed) return;
			closed = true;
			back.remove();
			document.removeEventListener("keydown", onKey);
		}
		function onKey(e) { if (e.key === "Escape") close(); }
		document.addEventListener("keydown", onKey);
		back.addEventListener("click", function (e) { if (e.target === back) close(); });

		function renderButtons(list) {
			actionsEl.innerHTML = "";
			list.forEach(function (b) {
				var el = document.createElement("button");
				el.type = "button";
				el.className = "btn" + (b.kind ? " " + b.kind : "");
				el.textContent = b.label;
				el.addEventListener("click", async function () {
					el.disabled = true;
					try {
						// handlers follow "return true = done, close the modal"
						var done = await handler(b.id, api);
						if (done) close();
						else el.disabled = false;   // validation failed: let them retry
					} catch (e) {
						toast(e.message || "failed", "error");
						el.disabled = false;
					}
				});
				actionsEl.appendChild(el);
			});
		}
		renderButtons(opts.buttons || [{ label: "Close", id: "close" }]);
		return {
			close: close,
			body: bodyEl,
			renderButtons: renderButtons,
			setHandler: function (h) { handler = h; }
		};
	}

	function confirmModal(o) {
		return new Promise(function (resolve) {
			var typedHtml = o.typed
				? "<div class=\"field\"><span class=\"field-label\">Type <strong>" +
				  esc(o.typed) + "</strong> to confirm</span>" +
				  "<input type=\"text\" id=\"confirm-typed\" autocomplete=\"off\" spellcheck=\"false\"></div>"
				: "";
			var m;
			m = modal({
				title: o.title,
				body: "<p>" + esc(o.message) + "</p>" + typedHtml,
				buttons: [
					{ label: o.confirmLabel || "Confirm", kind: o.danger === false ? "primary" : "danger", id: "ok" },
					{ label: "Cancel", id: "cancel" }
				],
				onAction: function (id) {
					if (id === "cancel") { resolve(false); return true; }
					if (o.typed) {
						var v = m.body.querySelector("#confirm-typed").value.trim();
						if (v !== o.typed) { toast("text does not match", "error"); return false; }
					}
					resolve(true);
					return true;
				}
			});
		});
	}

	/* two-field password entry; resolves to password or null */
	function passwordModal(title) {
		return new Promise(function (resolve) {
			var m;
			m = modal({
				title: title,
				body:
					"<div class=\"field\"><span class=\"field-label\">New password (min8)</span>" +
					"<input type=\"password\" id=\"pw1\" autocomplete=\"new-password\"></div>" +
					"<div class=\"field\"><span class=\"field-label\">Repeat password</span>" +
					"<input type=\"password\" id=\"pw2\" autocomplete=\"new-password\"></div>" +
					"<div class=\"error-box\" id=\"pw-err\" hidden></div>",
				buttons: [
					{ label: "Save", kind: "primary", id: "ok" },
					{ label: "Cancel", id: "cancel" }
				],
				onAction: function (id) {
					if (id === "cancel") { resolve(null); return true; }
					var a = m.body.querySelector("#pw1").value;
					var b = m.body.querySelector("#pw2").value;
					var errBox = m.body.querySelector("#pw-err");
					if (a.length < 8) {
						errBox.hidden = false;
						errBox.textContent = "Password must be at least 8 characters.";
						return false;
					}
					if (a !== b) {
						errBox.hidden = false;
						errBox.textContent = "Passwords do not match.";
						return false;
					}
					resolve(a);
					return true;
				}
			});
		});
	}

	function newUserModal() {
		return new Promise(function (resolve) {
			var m;
			m = modal({
				title: "New user",
				body:
					"<div class=\"field\"><span class=\"field-label\">Username</span>" +
					"<input type=\"text\" id=\"nu-name\" autocomplete=\"off\" spellcheck=\"false\" " +
					"placeholder=\"no spaces, no ':'\"></div>" +
					"<div class=\"field\"><span class=\"field-label\">Password (min8)</span>" +
					"<input type=\"password\" id=\"nu-pw1\" autocomplete=\"new-password\"></div>" +
					"<div class=\"field\"><span class=\"field-label\">Repeat password</span>" +
					"<input type=\"password\" id=\"nu-pw2\" autocomplete=\"new-password\"></div>" +
					"<div class=\"error-box\" id=\"nu-err\" hidden></div>",
				buttons: [
					{ label: "Create", kind: "primary", id: "ok" },
					{ label: "Cancel", id: "cancel" }
				],
				onAction: function (id) {
					if (id === "cancel") { resolve(null); return true; }
					var name = m.body.querySelector("#nu-name").value.trim();
					var a = m.body.querySelector("#nu-pw1").value;
					var b = m.body.querySelector("#nu-pw2").value;
					var errBox = m.body.querySelector("#nu-err");
					function fail(msg) { errBox.hidden = false; errBox.textContent = msg; return false; }
					if (!name || /[\s:]/.test(name) || name.length > 64)
						return fail("Invalid username (no spaces or ':', max 64).");
					if (a.length < 8) return fail("Password must be at least 8 characters.");
					if (a !== b) return fail("Passwords do not match.");
					resolve({ username: name, password: a });
					return true;
				}
			});
		});
	}

	/* TOTP flow: generate secret -> show binding -> verify code -> saved.
   base: "/api/admin/users/<user>" or "/api/me" */
	function totpModal(base, label, mode, onDone) {
		var m = modal({
			title: (mode === "rebind" ? "Rebind TOTP · " : "Enable TOTP · ") + label,
			body: "<div class=\"empty\"><span class=\"spinner\"></span> requesting secret…</div>",
			buttons: [{ label: "Cancel", id: "cancel" }],
			onAction: function (id) { if (id === "cancel") { resolveEarly(); } return true; }
		});
		var resolved = false;
		function resolveEarly() { resolved = true; }

		apiPost(base + "/totp", { action: mode }).then(function (r) {
			if (resolved) return;
			m.body.innerHTML =
				"<div class=\"field\"><span class=\"field-label\">Secret (add to your authenticator)</span>" +
				"<span class=\"chip selectable\">" + esc(r.secret) + "</span></div>" +
				"<div class=\"field\"><span class=\"field-label\">otpauth link</span>" +
				"<span class=\"chip selectable\" style=\"font-size:11px\">" + esc(r.otpauth) + "</span></div>" +
				"<div class=\"field\"><span class=\"field-label\">Enter the 6-digit code</span>" +
				"<input type=\"text\" id=\"totp-code\" class=\"code-input\" inputmode=\"numeric\" " +
				"autocomplete=\"one-time-code\" maxlength=\"6\" placeholder=\"000000\"></div>" +
				"<div class=\"error-box\" id=\"totp-err\" hidden></div>";
			m.renderButtons([
				{ label: "Verify & save", kind: "primary", id: "save" },
				{ label: "Cancel", id: "cancel" }
			]);
			m.setHandler(async function (id) {
				if (id === "cancel") return true;
				var code = m.body.querySelector("#totp-code").value.trim();
				var errBox = m.body.querySelector("#totp-err");
				if (!/^\d{6}$/.test(code)) {
					errBox.hidden = false;
					errBox.textContent = "Enter the 6-digit code from your authenticator.";
					return false;
				}
				var res = await apiPost(base + "/totp",
					{ action: mode, secret: r.secret, code: code });
				reportRestart(res, mode === "rebind" ? "TOTP rebound" : "TOTP enabled");
				if (onDone) onDone();
				return true;
			});
		}).catch(function (e) {
			m.close();
			toast(e.message || "failed to request secret", "error");
		});
	}

	function removeTotp(base, label, onDone) {
		confirmModal({
			title: "Remove TOTP · " + label,
			message: "Your authenticator will stop being required at login. " +
				"Password login stays unchanged.",
			confirmLabel: "Remove TOTP"
		}).then(function (ok) {
			if (!ok) return;
			apiPost(base + "/totp", { action: "remove" })
				.then(function (res) {
					reportRestart(res, "TOTP removed");
					(onDone || refresh)();
				})
				.catch(function (e) { toast(e.message || "failed", "error"); });
		});
	}

	/* ---------------- views ---------------- */

	var views = { admin: ["users", "sessions", "stack"], self: ["account"] };
	var viewMeta = {
		users: { label: "Users" },
		sessions: { label: "Sessions" },
		stack: { label: "Stack" },
		account: { label: "My account" }
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
		refresh();
	}

	function refresh() {
		if (currentView) viewsRender[currentView]();
	}

	/* ---- users (admin) ---- */

	function adminTotpBase(user) {
		return "/api/admin/users/" + encodeURIComponent(user) + "/totp";
	}

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
					"<td style=\"white-space:nowrap\">" +
						"<button class=\"btn small\" data-act=\"pw\" data-u=\"" + esc(u.username) + "\">Password</button> " +
						"<button class=\"btn small\" data-act=\"totp\" data-u=\"" + esc(u.username) +
							"\" data-has=\"" + (u.has_totp ? "1" : "0") + "\">TOTP</button> " +
						"<button class=\"btn small danger\" data-act=\"del\" data-u=\"" + esc(u.username) + "\">Delete</button>" +
					"</td>" +
					"</tr>";
			}).join("");
			v.innerHTML =
				"<div class=\"card\">" +
				"  <div class=\"toolbar\"><h2 class=\"card-title grow\">Users</h2>" +
				"    <button class=\"btn primary small\" id=\"users-new\">+ New user</button></div>" +
				"  <p class=\"card-desc\">Local accounts from the tinyauth users file · " +
				"active / total sessions</p>" +
				"  <div class=\"table-wrap\"><table class=\"data\">" +
				"    <thead><tr><th>Username</th><th>TOTP</th>" +
				"    <th>Sessions (active / total)</th><th>Actions</th></tr></thead>" +
				"    <tbody>" + (rows || "<tr><td colspan=\"4\" class=\"empty\">no users</td></tr>") + "</tbody>" +
				"  </table></div>" +
				"</div>";

			$("users-new").addEventListener("click", async function () {
				var creds = await newUserModal();
				if (!creds) return;
				try {
					var res = await apiPost("/api/admin/users", creds);
					reportRestart(res, "User '" + creds.username + "' created");
					refresh();
				} catch (e) { toast(e.message || "failed", "error"); }
			});

			v.querySelectorAll("button[data-act]").forEach(function (btn) {
				btn.addEventListener("click", async function () {
					var user = btn.dataset.u;
					var act = btn.dataset.act;
					try {
						if (act === "pw") {
							var pw = await passwordModal("Change password · " + user);
							if (!pw) return;
							var res = await apiPost(
								"/api/admin/users/" + encodeURIComponent(user) + "/password",
								{ password: pw });
							reportRestart(res, "Password changed for '" + user + "'");
						} else if (act === "totp") {
							if (btn.dataset.has === "1") {
								totpEntryChoice(user);
							} else {
								totpModal(adminTotpBase(user), user, "enable", refresh);
							}
						} else if (act === "del") {
							var ok = await confirmModal({
								title: "Delete user · " + user,
								message: "Removes the account and kicks all of its sessions. " +
									"This cannot be undone.",
								confirmLabel: "Delete " + user,
								typed: user
							});
							if (!ok) return;
							var res2 = await apiDelete(
								"/api/admin/users/" + encodeURIComponent(user));
							reportRestart(res2, "User '" + user + "' deleted" +
								(res2.sessions_flushed ? " (" + res2.sessions_flushed + " sessions kicked)" : ""));
							refresh();
						}
					} catch (e) { toast(e.message || "failed", "error"); }
				});
			});
		}).catch(function (err) { v.innerHTML = errorBox(err); });
	}

	/* small chooser when a user already has TOTP */
	function totpEntryChoice(user) {
		var m = modal({
			title: "TOTP · " + user,
			body: "<p>This user already has TOTP bound. Rebind replaces the current " +
				"secret (authenticators must scan the new one); remove turns TOTP off.</p>",
			buttons: [
				{ label: "Rebind", kind: "primary", id: "rebind" },
				{ label: "Remove", kind: "danger", id: "remove" },
				{ label: "Cancel", id: "cancel" }
			],
			onAction: function (id) {
				if (id === "rebind") { m.close(); totpModal(adminTotpBase(user), user, "rebind", refresh); }
				if (id === "remove") { m.close(); removeTotp(adminTotpBase(user), user, refresh); }
				return true;
			}
		});
	}

	/* ---- sessions (admin) ---- */

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
					"<td><button class=\"btn small danger\" data-kick=\"" + esc(s.username) + "\">Kick</button></td>" +
					"</tr>";
			}).join("");

			v.innerHTML =
				"<div class=\"card\">" +
				"  <div class=\"toolbar\">" +
				"    <h2 class=\"card-title grow\">Sessions</h2>" +
				"    <button class=\"btn danger small\" id=\"sess-kickall\">Kick all</button>" +
				"    <button class=\"btn small\" id=\"sess-refresh\">Refresh</button>" +
				"  </div>" +
				"  <p class=\"card-desc\">Every session in tinyauth's store · expiry slides " +
				"on use, hard cap " + esc(fmtRemaining(data.session_max_lifetime)) +
				" from login</p>" +
				"  <div class=\"toolbar\">" +
				"    <input type=\"search\" id=\"sess-filter\" placeholder=\"filter by username or uuid\" value=\"" +
				esc(sessionFilter) + "\">" +
				"  </div>" +
				"  <div class=\"table-wrap\"><table class=\"data\">" +
				"    <thead><tr><th>UUID</th><th>User</th><th>Provider</th>" +
				"    <th>Created</th><th>Expires</th><th>Remaining</th><th>Status</th>" +
				"    <th>Flags</th><th></th></tr></thead>" +
				"    <tbody>" + (rows || "<tr><td colspan=\"9\" class=\"empty\">no sessions match</td></tr>") + "</tbody>" +
				"  </table></div>" +
				"</div>";

			$("sess-refresh").addEventListener("click", viewSessions);
			var filterInput = $("sess-filter");
			filterInput.addEventListener("input", function (e) {
				sessionFilter = e.target.value;
				viewSessions();
				var again = $("sess-filter");
				if (again) {
					again.focus();
					again.setSelectionRange(again.value.length, again.value.length);
				}
			});

			v.querySelectorAll("button[data-kick]").forEach(function (btn) {
				btn.addEventListener("click", async function () {
					var user = btn.dataset.kick;
					var ok = await confirmModal({
						title: "Kick sessions · " + user,
						message: "Ends ALL sessions of '" + user + "'. " +
							"Their next request goes back to the tinyauth login.",
						confirmLabel: "Kick " + user
					});
					if (!ok) return;
					try {
						var res = await apiPost("/api/admin/flush", { username: user });
						toast("Kicked " + res.removed + " session(s) of '" + user + "'", "success");
						refresh();
					} catch (e) { toast(e.message || "failed", "error"); }
				});
			});

			$("sess-kickall").addEventListener("click", async function () {
				var ok = await confirmModal({
					title: "Kick ALL sessions",
					message: "Every user on every site must log in again.",
					confirmLabel: "Kick everyone",
					typed: "ALL"
				});
				if (!ok) return;
				try {
					var res = await apiPost("/api/admin/flush", { all: true });
					toast("Kicked " + res.removed + " session(s) total", "success");
					refresh();
				} catch (e) { toast(e.message || "failed", "error"); }
			});
		}).catch(function (err) { v.innerHTML = errorBox(err); });
	}

	/* ---- stack (admin) ---- */

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
				"  <div class=\"toolbar\"><h2 class=\"card-title grow\">Stack</h2>" +
				"    <button class=\"btn danger small\" id=\"stack-restart\">Restart tinyauth</button>" +
				"    <button class=\"btn small\" id=\"stack-refresh\">Refresh</button></div>" +
				"  <p class=\"card-desc\">Backend: <span class=\"tag\">" + esc(d.backend || "?") +
				"</span> · container vs compose " + matchBadge + " · health " + health + "</p>" +
				"  <dl class=\"kv\">" +
				"    <dt>container</dt><dd>" + esc(d.container_name || "—") + "</dd>" +
				"    <dt>state</dt><dd>" + esc(d.state || "—") + "</dd>" +
				"    <dt>image (running)</dt><dd>" + esc(d.container_image || "—") + "</dd>" +
				"    <dt>image (compose)</dt><dd>" + esc(d.compose_image || (d.compose_note || "—")) + "</dd>" +
				"    <dt>compose project</dt><dd>" + esc(d.project || "—") + "</dd>" +
				"    <dt>created</dt><dd>" + esc(fmtTime(d.created)) + "</dd>" +
				"  </dl>" +
				"</div>";
			$("stack-refresh").addEventListener("click", viewStack);
			$("stack-restart").addEventListener("click", async function () {
				var ok = await confirmModal({
					title: "Restart tinyauth",
					message: "Gracefully restarts the tinyauth container. Active sessions " +
						"survive (they live in the database); logins pause for a few seconds.",
					confirmLabel: "Restart"
				});
				if (!ok) return;
				try {
					var res = await apiPost("/api/admin/restart", { scope: "container" });
					if (res.healthy) {
						toast("tinyauth restarted (" + res.waited_s + "s, via " + res.backend + ")", "success");
					} else {
						toast(res.warning || "restarted, but health check pending", "warn");
					}
					refresh();
				} catch (e) { toast(e.message || "restart failed", "error"); }
			});
		}).catch(function (err) { v.innerHTML = errorBox(err); });
	}

	/* ---- account (self-service) ---- */

	function viewAccount() {
		var v = $("view");
		var totpCard = me.has_totp
			? "<div class=\"field\"><span class=\"field-label\">My TOTP</span>" +
			  "<span class=\"field-hint\">Bound. Rebind replaces the secret; remove turns it off.</span></div>" +
			  "<div class=\"card-actions\">" +
			  "<button class=\"btn small\" id=\"acc-rebind\">Rebind TOTP</button>" +
			  "<button class=\"btn small danger\" id=\"acc-remove\">Remove TOTP</button></div>"
			: "<div class=\"field\"><span class=\"field-label\">My TOTP</span>" +
			  "<span class=\"field-hint\">Not bound yet. Enabling shows a secret to scan " +
			  "and asks for a test code.</span></div>" +
			  "<div class=\"card-actions\">" +
			  "<button class=\"btn primary small\" id=\"acc-enable\">Enable TOTP</button></div>";

		v.innerHTML =
			"<div class=\"card\">" +
			"  <h2 class=\"card-title\">My account</h2>" +
			"  <p class=\"card-desc\">Signed in as <strong>" + esc(me.username) +
			"</strong> · self-service only — your username comes from the login " +
			"chain and cannot be changed here.</p>" +
			"  <div class=\"field\"><span class=\"field-label\">Change password</span>" +
			"    <span class=\"field-hint\">Applies to your own account only.</span></div>" +
			"  <div class=\"card-actions\">" +
			"    <button class=\"btn primary small\" id=\"acc-pw\">Change password</button></div>" +
			"</div>" +
			"<div class=\"card\">" +
			"  <h2 class=\"card-title\">Two-factor</h2>" + totpCard +
			"</div>";

		$("acc-pw").addEventListener("click", async function () {
			var pw = await passwordModal("Change my password");
			if (!pw) return;
			try {
				var res = await apiPost("/api/me/password", { password: pw });
				reportRestart(res, "Your password changed");
			} catch (e) { toast(e.message || "failed", "error"); }
		});

		var enableBtn = $("acc-enable");
		if (enableBtn) {
			enableBtn.addEventListener("click", function () {
				totpModal("/api/me", me.username, "enable", refreshMeAndRender);
			});
		}
		var rebindBtn = $("acc-rebind");
		if (rebindBtn) {
			rebindBtn.addEventListener("click", function () {
				totpModal("/api/me", me.username, "rebind", refreshMeAndRender);
			});
		}
		var removeBtn = $("acc-remove");
		if (removeBtn) {
			removeBtn.addEventListener("click", function () {
				removeTotp("/api/me", me.username, refreshMeAndRender);
			});
		}
	}

	function refreshMeAndRender() {
		api("/api/me").then(function (m) {
			me = m;
			if (currentView === "account") viewAccount();
		}).catch(function () { /* keep last known state */ });
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

		// version badge (ungated endpoint, shows even before identity resolves)
		fetch("/api/health").then(function (r) { return r.json(); }).then(function (h) {
			if (h && h.version) {
				var v = $("brand-version");
				v.textContent = h.version;
				v.hidden = false;
			}
		}).catch(function () { /* version is cosmetic */ });

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
