/* tinyauth-mgmt — frontend core (vanilla, no build step)
   Role-driven navigation; identity comes from the reverse-proxy header chain,
   so the server is always the authority — the UI only adapts what's shown.
   All user-visible strings go through i18n's t() (auto/zh/en). */
(function () {
	"use strict";

	var t = window.__tmI18n.t;
	var me = null;          // {username, role, has_totp}
	var currentView = null;

	/* ---------------- helpers ---------------- */

	function esc(s) {
		return String(s == null ? "" : s)
			.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
			.replace(/"/g, "&quot;").replace(/'/g, "&#39;");
	}

	function $(id) { return document.getElementById(id); }

	function toast(msg, kind, link) {
		var layer = $("toast-layer");
		var el = document.createElement("div");
		el.className = "toast" + (kind ? " " + kind : "");
		el.textContent = msg;
		if (link && link.href) {
			var la = document.createElement("a");
			la.href = link.href;
			la.target = "_blank";
			la.rel = "noopener";
			la.textContent = link.label || "\u2192";
			la.style.cssText = "margin-left:8px;font-weight:700;color:inherit;" +
				"text-decoration:underline;";
			el.appendChild(la);
		}
		layer.appendChild(el);
		setTimeout(function () {
			el.classList.add("out");
			setTimeout(function () { el.remove(); }, 250);
		}, kind === "error" ? 4200 : 2800);
	}

	function verTuple(v) {
		var m = /^v?(\d+)\.(\d+)(?:\.(\d+))?/.exec(String(v || ""));
		return m ? [+m[1], +m[2], +(m[3] || 0)] : null;
	}

	function verGt(a, b) {
		var x = verTuple(a), y = verTuple(b);
		if (!x || !y) return false;
		for (var i = 0; i < 3; i++) {
			if (x[i] !== y[i]) return x[i] > y[i];
		}
		return false;
	}

	/* online update check, modeled on luci-app-pushbot's status page:
	   fetch remote version markers (github tags), compare, toast.
	   - throttled to once/6h via sessionStorage (github api rate limit)
	   - found -> warn toast + version badge becomes a release link
	   - latest -> success toast (auto-hides, pushbot's "already latest")
	   - offline/error -> silent (never alarm the admin over a network flap) */
	function checkForUpdate(current) {
		var last = 0;
		try { last = +(sessionStorage.getItem("tm-updchk") || 0); } catch (e) {}
		if (Date.now() - last < 6 * 3600 * 1000) return;
		try { sessionStorage.setItem("tm-updchk", String(Date.now())); } catch (e) {}
		var ctl = new AbortController();
		var timer = setTimeout(function () { ctl.abort(); }, 8000);
		fetch("https://api.github.com/repos/xylz0928/tinyauth-mgmt/tags?per_page=100",
			{ signal: ctl.signal, headers: { Accept: "application/vnd.github+json" } })
			.then(function (r) {
				if (!r.ok) throw new Error("http " + r.status);
				return r.json();
			})
			.then(function (tags) {
				clearTimeout(timer);
				var best = null;
				(Array.isArray(tags) ? tags : []).forEach(function (tg) {
					var name = tg && tg.name;
					if (verTuple(name) && (!best || verGt(name, best))) best = name;
				});
				if (!best) return;
				if (verGt(best, current)) {
					toast(t("update.found", { latest: best, current: current }),
						"warn",
						{ href: "https://github.com/xylz0928/tinyauth-mgmt/releases",
						  label: "GitHub" });
					var v = $("brand-version");
					v.classList.add("has-update");
					v.textContent = "";
					var a = document.createElement("a");
					a.href = "https://github.com/xylz0928/tinyauth-mgmt/releases";
					a.target = "_blank";
					a.rel = "noopener";
					a.textContent = current + " \u2192 " + best;
					v.appendChild(a);
				} else {
					toast(t("update.latest"), "success");
				}
			})
			.catch(function () { clearTimeout(timer); /* offline: stay silent */ });
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

	/* uuid for the sessions table — forced wrap per the author's layout:
	   line1 = first8 hex + the dash; the remainder packs into lines of at
	   most14 chars broken at hyphens (a continuation line may LEAD with the
	   hyphen), e.g. "4ea415e9-" / "be95-4506-a514" / "-a4d8d54204e2".
	   Keeps the column narrow on mobile screens. */
	function fmtUuid(u) {
		u = String(u || "");
		if (u.length <= 9) return esc(u);
		var lines = [u.slice(0, 9)];
		var rest = u.slice(9);
		while (rest.length > 14) {
			var cut = rest.lastIndexOf("-", 14);
			if (cut < 1) cut = 14;
			lines.push(rest.slice(0, cut));
			rest = rest.slice(cut);
		}
		lines.push(rest);
		return lines.map(esc).join("<br>");
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
			hint = "<p class=\"card-desc\">" + esc(t("err.401")) + "</p>";
		} else if (err && err.status === 403) {
			hint = "<p class=\"card-desc\">" + esc(t("err.403")) + "</p>";
		}
		return "<div class=\"card\"><div class=\"error-box\">" +
			"<strong>" + esc(err && err.message ? err.message : t("err.request")) +
			"</strong>" + hint + "</div></div>";
	}

	/* restart outcome is advisory: file/db changes are already durable */
	function reportRestart(res, okMsg) {
		if (res && res.restart_ok === false) {
			toast(okMsg + t("restart.failed",
				{ e: res.restart_error || "?" }), "warn");
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
						toast(e.message || t("common.failed"), "error");
						el.disabled = false;
					}
				});
				actionsEl.appendChild(el);
			});
		}
		renderButtons(opts.buttons || [{ label: t("common.close"), id: "close" }]);
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
				? "<div class=\"field\"><span class=\"field-label\">Type <strong class=\"exact\">" +
				  esc(o.typed) + "</strong> to confirm</span>" +
				  "<input type=\"text\" id=\"confirm-typed\" autocomplete=\"off\" spellcheck=\"false\" " +
				  "placeholder=\"" + esc(o.typed) + "\"></div>"
				: "";
			var m;
			m = modal({
				title: o.title,
				body: "<p>" + esc(o.message) + "</p>" + typedHtml,
				buttons: [
					{ label: o.confirmLabel || t("common.save"),
					  kind: o.danger === false ? "primary" : "danger", id: "ok" },
					{ label: t("common.cancel"), id: "cancel" }
				],
				onAction: function (id) {
					if (id === "cancel") { resolve(false); return true; }
					if (o.typed) {
						var v = m.body.querySelector("#confirm-typed").value.trim();
						if (v !== o.typed) { toast(t("common.mismatch"), "error"); return false; }
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
					"<div class=\"field\"><span class=\"field-label\">" + t("pw.new") + "</span>" +
					"<input type=\"password\" id=\"pw1\" autocomplete=\"new-password\"></div>" +
					"<div class=\"field\"><span class=\"field-label\">" + t("pw.repeat") + "</span>" +
					"<input type=\"password\" id=\"pw2\" autocomplete=\"new-password\"></div>" +
					"<div class=\"error-box\" id=\"pw-err\" hidden></div>",
				buttons: [
					{ label: t("common.save"), kind: "primary", id: "ok" },
					{ label: t("common.cancel"), id: "cancel" }
				],
				onAction: function (id) {
					if (id === "cancel") { resolve(null); return true; }
					var a = m.body.querySelector("#pw1").value;
					var b = m.body.querySelector("#pw2").value;
					var errBox = m.body.querySelector("#pw-err");
					if (a.length < 8) {
						errBox.hidden = false;
						errBox.textContent = t("pw.err_min");
						return false;
					}
					if (a !== b) {
						errBox.hidden = false;
						errBox.textContent = t("pw.err_match");
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
				title: t("user.new.title"),
				body:
					"<div class=\"field\"><span class=\"field-label\">" + t("user.new.name") + "</span>" +
					"<input type=\"text\" id=\"nu-name\" autocomplete=\"off\" spellcheck=\"false\" " +
					"placeholder=\"" + esc(t("user.new.name_hint")) + "\"></div>" +
					"<div class=\"field\"><span class=\"field-label\">" + t("user.new.pw") + "</span>" +
					"<input type=\"password\" id=\"nu-pw1\" autocomplete=\"new-password\"></div>" +
					"<div class=\"field\"><span class=\"field-label\">" + t("pw.repeat") + "</span>" +
					"<input type=\"password\" id=\"nu-pw2\" autocomplete=\"new-password\"></div>" +
					"<div class=\"error-box\" id=\"nu-err\" hidden></div>",
				buttons: [
					{ label: t("common.create"), kind: "primary", id: "ok" },
					{ label: t("common.cancel"), id: "cancel" }
				],
				onAction: function (id) {
					if (id === "cancel") { resolve(null); return true; }
					var name = m.body.querySelector("#nu-name").value.trim();
					var a = m.body.querySelector("#nu-pw1").value;
					var b = m.body.querySelector("#nu-pw2").value;
					var errBox = m.body.querySelector("#nu-err");
					function fail(msg) { errBox.hidden = false; errBox.textContent = msg; return false; }
					if (!name || /[\s:]/.test(name) || name.length > 64)
						return fail(t("user.new.err_name"));
					if (a.length < 8) return fail(t("pw.err_min"));
					if (a !== b) return fail(t("pw.err_match"));
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
			title: (mode === "rebind" ? t("totp.rebind_title", { user: label })
				: t("totp.enable_title", { user: label })),
			body: "<div class=\"empty\"><span class=\"spinner\"></span> " +
				t("totp.requesting") + "</div>",
			buttons: [{ label: t("common.cancel"), id: "cancel" }],
			onAction: function (id) { if (id === "cancel") { resolveEarly(); } return true; }
		});
		var resolved = false;
		function resolveEarly() { resolved = true; }

		apiPost(base + "/totp", { action: mode }).then(function (r) {
			if (resolved) return;
			m.body.innerHTML =
				"<div class=\"field\"><span class=\"field-label\">" + t("totp.secret") + "</span>" +
				"<span class=\"chip selectable\">" + esc(r.secret) + "</span></div>" +
				"<div class=\"field\"><span class=\"field-label\">" + t("totp.otpauth") + "</span>" +
				"<span class=\"chip selectable\" style=\"font-size:11px\">" + esc(r.otpauth) + "</span></div>" +
				"<div class=\"field\"><span class=\"field-label\">" + t("totp.code") + "</span>" +
				"<input type=\"text\" id=\"totp-code\" class=\"code-input\" inputmode=\"numeric\" " +
				"autocomplete=\"one-time-code\" maxlength=\"6\" placeholder=\"000000\"></div>" +
				"<div class=\"error-box\" id=\"totp-err\" hidden></div>";
			m.renderButtons([
				{ label: t("totp.verify_save"), kind: "primary", id: "save" },
				{ label: t("common.cancel"), id: "cancel" }
			]);
			m.setHandler(async function (id) {
				if (id === "cancel") return true;
				var code = m.body.querySelector("#totp-code").value.trim();
				var errBox = m.body.querySelector("#totp-err");
				if (!/^\d{6}$/.test(code)) {
					errBox.hidden = false;
					errBox.textContent = t("totp.err_code");
					return false;
				}
				var res = await apiPost(base + "/totp",
					{ action: mode, secret: r.secret, code: code });
				reportRestart(res, mode === "rebind" ? t("totp.rebound") : t("totp.enabled"));
				if (onDone) onDone();
				return true;
			});
		}).catch(function (e) {
			m.close();
			toast(e.message || t("common.failed"), "error");
		});
	}

	function removeTotp(base, label, onDone) {
		confirmModal({
			title: t("totp.rm_title", { user: label }),
			message: t("totp.rm_msg"),
			confirmLabel: t("totp.rm_confirm")
		}).then(function (ok) {
			if (!ok) return;
			apiPost(base + "/totp", { action: "remove" })
				.then(function (res) {
					reportRestart(res, t("totp.removed"));
					(onDone || refresh)();
				})
				.catch(function (e) { toast(e.message || t("common.failed"), "error"); });
		});
	}

	/* ---------------- views ---------------- */

	var views = { admin: ["users", "sessions", "stack"], self: ["account"] };
	var NAV_KEYS = {
		users: "nav.users",
		sessions: "nav.sessions",
		stack: "nav.stack",
		account: "nav.account"
	};

	function renderNav() {
		var nav = $("nav");
		var list = views[me.role] || [];
		nav.innerHTML = list.map(function (v) {
			return "<button class=\"nav-tab\" data-view=\"" + v + "\" type=\"button\">" +
				esc(t(NAV_KEYS[v])) + "</button>";
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
		stopTimeCycle();   // never poll the time sources in the background
		if (currentView) viewsRender[currentView]();
	}

	/* ---- users (admin) ---- */

	function adminTotpBase(user) {
		// NOTE: returns the RESOURCE base only — totpModal()/removeTotp()
		// append "/totp" themselves (a doubled suffix caused the405 bug).
		return "/api/admin/users/" + encodeURIComponent(user);
	}

	function viewUsers() {
		var v = $("view");
		v.innerHTML = "<div class=\"card\"><div class=\"empty\"><span class=\"spinner\"></span> " +
			t("common.loading") + "</div></div>";
		api("/api/admin/users").then(function (data) {
			var rows = data.users.map(function (u) {
				return "<tr>" +
					"<td data-label=\"" + esc(t("th.username")) + "\"><strong>" +
						esc(u.username) + "</strong></td>" +
					"<td data-label=\"" + esc(t("th.totp")) + "\">" + (u.has_totp
						? "<span class=\"badge primary\">" + t("badge.totp") + "</span>"
						: "<span class=\"badge\">" + t("badge.no_totp") + "</span>") + "</td>" +
					"<td data-label=\"" + esc(t("th.sessions_short")) + "\">" +
						esc(u.active_sessions) + " / " + esc(u.total_sessions) + "</td>" +
					"<td class=\"actions-td\"><div class=\"actions\">" +
						"<button class=\"btn small\" data-act=\"pw\" data-u=\"" + esc(u.username) + "\">" +
							t("btn.password") + "</button>" +
						"<button class=\"btn small\" data-act=\"totp\" data-u=\"" + esc(u.username) +
							"\" data-has=\"" + (u.has_totp ? "1" : "0") + "\">" + t("badge.totp") + "</button>" +
						"<button class=\"btn small danger\" data-act=\"del\" data-u=\"" + esc(u.username) + "\">" +
							t("btn.delete") + "</button>" +
					"</div></td>" +
					"</tr>";
			}).join("");
			v.innerHTML =
				"<div class=\"card\">" +
				"  <div class=\"toolbar\"><h2 class=\"card-title grow\">" + t("users.title") + "</h2>" +
				"    <button class=\"btn primary small\" id=\"users-new\">" + t("users.new") + "</button></div>" +
				"  <p class=\"card-desc\">" + esc(t("users.desc")) + "</p>" +
				"  <div class=\"table-wrap\"><table class=\"data users-table\">" +
				"    <thead><tr><th>" + t("th.username") + "</th><th>" + t("th.totp") + "</th>" +
				"    <th>" + t("th.sessions") + "</th><th>" + t("th.actions") + "</th></tr></thead>" +
				"    <tbody>" + (rows || "<tr><td colspan=\"4\" class=\"empty\">" +
					t("users.empty") + "</td></tr>") + "</tbody>" +
				"  </table></div>" +
				"</div>";

			$("users-new").addEventListener("click", async function () {
				var creds = await newUserModal();
				if (!creds) return;
				try {
					var res = await apiPost("/api/admin/users", creds);
					reportRestart(res, t("user.created", { user: creds.username }));
					refresh();
				} catch (e) { toast(e.message || t("common.failed"), "error"); }
			});

			v.querySelectorAll("button[data-act]").forEach(function (btn) {
				btn.addEventListener("click", async function () {
					var user = btn.dataset.u;
					var act = btn.dataset.act;
					try {
						if (act === "pw") {
							var pw = await passwordModal(t("pw.title", { user: user }));
							if (!pw) return;
							var res = await apiPost(
								"/api/admin/users/" + encodeURIComponent(user) + "/password",
								{ password: pw });
							reportRestart(res, t("user.pw_changed", { user: user }));
						} else if (act === "totp") {
							if (btn.dataset.has === "1") {
								totpEntryChoice(user);
							} else {
								totpModal(adminTotpBase(user), user, "enable", refresh);
							}
						} else if (act === "del") {
							var ok = await confirmModal({
								title: t("user.del.title", { user: user }),
								message: t("user.del.msg"),
								confirmLabel: t("user.del.confirm", { user: user }),
								typed: user
							});
							if (!ok) return;
							var res2 = await apiDelete(
								"/api/admin/users/" + encodeURIComponent(user));
							reportRestart(res2, res2.sessions_flushed
								? t("user.deleted_n", { user: user, n: res2.sessions_flushed })
								: t("user.deleted", { user: user }));
							refresh();
						}
					} catch (e) { toast(e.message || t("common.failed"), "error"); }
				});
			});
		}).catch(function (err) { v.innerHTML = errorBox(err); });
	}

	/* small chooser when a user already has TOTP */
	function totpEntryChoice(user) {
		var m = modal({
			title: t("totp.entry.title", { user: user }),
			body: "<p>" + esc(t("totp.entry.msg")) + "</p>",
			buttons: [
				{ label: t("totp.rebind"), kind: "primary", id: "rebind" },
				{ label: t("totp.remove"), kind: "danger", id: "remove" },
				{ label: t("common.cancel"), id: "cancel" }
			],
			onAction: function (id) {
				if (id === "rebind") { m.close(); totpModal(adminTotpBase(user), user, "rebind", refresh); }
				if (id === "remove") { m.close(); removeTotp(adminTotpBase(user), user, refresh); }
				return true;
			}
		});
	}

	/* ---- sessions (admin): responsive item cards ---- */

	var sessionFilter = "";

	function viewSessions() {
		var v = $("view");
		v.innerHTML = "<div class=\"card\"><div class=\"empty\"><span class=\"spinner\"></span> " +
			t("common.loading") + "</div></div>";
		api("/api/admin/sessions").then(function (data) {
			var all = data.sessions || [];
			var q = sessionFilter.trim().toLowerCase();
			var list = q ? all.filter(function (s) {
				return s.username.toLowerCase().indexOf(q) !== -1 ||
					s.uuid.toLowerCase().indexOf(q) !== -1;
			}) : all;

			function field(label, valueHtml, extra) {
				return "<span class=\"s-field" + (extra ? " " + extra : "") +
					"\"><span class=\"field-label\">" +
					label + "</span><span class=\"s-val\">" + valueHtml + "</span></span>";
			}
			var items = list.map(function (s) {
				var st = s.status;
				var cls = st === "active" ? "success" : (st === "expired" ? "error" : "warn");
				var flags = (s.flags || []).map(function (f) {
					var m = /^renewed\u2248(.+)$/.exec(f);
					if (m) {
						var seg = m[1].split(" ");
						var times = seg.slice(1).join(" ");
						return "<span class=\"tag tag-wrapped\">renewed\u2248<br>" +
							esc(seg[0]) + (times ? "<br>" + esc(times) : "") + "</span>";
					}
					return "<span class=\"tag\">" + esc(f) + "</span>";
				}).join(" ");
				return "<div class=\"session-item\">" +
					"<span class=\"s-uuid chip uuid-chip\"><span class=\"uu-wide\">" +
					esc(s.uuid) + "</span><span class=\"uu-narrow\">" +
					fmtUuid(s.uuid) + "</span>" +
					"<span class=\"s-ip\">" + esc(s.login_ip || "—") + "</span></span>" +
					"<div class=\"s-body\">" +
						"<div class=\"s-line s-l1\">" +
							field(t("f.user"), "<strong>" + esc(s.username) + "</strong>") +
							field(t("f.provider"), esc(s.provider)) +
						"</div>" +
						field(t("f.flags"), flags || "—", "s-flags-cell") +
						field(t("f.created"), esc(fmtTime(s.created_at)), "cell-created") +
						field(t("f.expires"), esc(fmtTime(s.expires_at)), "cell-expires") +
						field(t("f.remaining"), esc(fmtRemaining(s.remaining)), "cell-remaining") +
						field(t("f.status"),
							"<span class=\"badge " + cls + "\">" + esc(st) + "</span>",
							"s-status") +
						"<span class=\"s-field s-kick\">" +
							"<button class=\"btn small danger\" data-kick-s=\"" + esc(s.uuid) + "\">" +
							t("btn.kick_session") + "</button>" +
							"<button class=\"btn small danger\" data-kick-u=\"" + esc(s.username) + "\">" +
							t("btn.kick_user") + "</button></span>" +
					"</div>" +
				"</div>";
			}).join("");

			v.innerHTML =
				"<div class=\"card\">" +
				"  <div class=\"toolbar\">" +
				"    <h2 class=\"card-title grow\">" + t("sessions.title") + "</h2>" +
				"    <button class=\"btn danger small\" id=\"sess-kickall\">" +
				t("sessions.kick_all") + "</button>" +
				"    <button class=\"btn small\" id=\"sess-refresh\">" + t("common.refresh") + "</button>" +
				"  </div>" +
				"  <p class=\"card-desc\">" +
				esc(t("sessions.desc", { cap: fmtRemaining(data.session_max_lifetime) })) + "</p>" +
				"  <div class=\"toolbar\">" +
				"    <input type=\"search\" id=\"sess-filter\" placeholder=\"" +
				esc(t("sessions.filter")) + "\" value=\"" + esc(sessionFilter) + "\">" +
				"  </div>" +
				"  <div class=\"session-list\">" +
				(items || "<div class=\"empty\">" + t("sessions.empty") + "</div>") +
				"  </div>" +
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

			v.querySelectorAll("button[data-kick-s]").forEach(function (btn) {
				btn.addEventListener("click", async function () {
					var uuid = btn.dataset.kickS;
					var ok = await confirmModal({
						title: t("kick1.title"),
						message: t("kick1.msg"),
						confirmLabel: t("kick1.confirm")
					});
					if (!ok) return;
					try {
						var res = await apiPost("/api/admin/flush", { uuid: uuid });
						toast(t("kick1.done") + (res.removed ? " (" + res.removed + ")" : ""),
							"success");
						refresh();
					} catch (e) { toast(e.message || t("common.failed"), "error"); }
				});
			});

			v.querySelectorAll("button[data-kick-u]").forEach(function (btn) {
				btn.addEventListener("click", async function () {
					var user = btn.dataset.kickU;
					var ok = await confirmModal({
						title: t("kick.title", { user: user }),
						message: t("kick.msg", { user: user }),
						confirmLabel: t("kick.confirm", { user: user })
					});
					if (!ok) return;
					try {
						var res = await apiPost("/api/admin/flush", { username: user });
						toast(t("kick.done", { n: res.removed, user: user }), "success");
						refresh();
					} catch (e) { toast(e.message || t("common.failed"), "error"); }
				});
			});

			$("sess-kickall").addEventListener("click", async function () {
				var ok = await confirmModal({
					title: t("kickall.title"),
					message: t("kickall.msg"),
					confirmLabel: t("kickall.confirm"),
					typed: "ALL"
				});
				if (!ok) return;
				try {
					var res = await apiPost("/api/admin/flush", { all: true });
					toast(t("kickall.done", { n: res.removed }), "success");
					refresh();
				} catch (e) { toast(e.message || t("common.failed"), "error"); }
			});
		}).catch(function (err) { v.innerHTML = errorBox(err); });
	}

	/* ---- time sources card (Stack tab) ----
	   One snapshot every30s: browser + three server sources are fetched and
	   rendered TOGETHER, so offsets stay constant between refreshes (no
	   growing drift). The cycle stops while the tab is hidden or the view
	   is left — nothing keeps polling in the background. The card FRAME is
	   created first (loading state) and only its contents are updated. */
	function fmtTimeTz(epoch, tz) {
		try {
			return new Intl.DateTimeFormat("sv-SE", {
				timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
				hour: "2-digit", minute: "2-digit", second: "2-digit",
				hourCycle: "h23"
			}).format(new Date(epoch * 1000));
		} catch (e) {
			return fmtTime(epoch);   // unknown tz: fall back to browser local
		}
	}

	function timeCardFrame() {
		function row(src, label) {
			return "<tr data-src=\"" + src + "\">" +
				"<td>" + label + "</td>" +
				"<td class=\"t-time\">…</td>" +
				"<td class=\"t-off\">—</td>" +
				"<td class=\"t-detail\">—</td></tr>";
		}
		return "<h2 class=\"card-title\">" + t("time.title") + "</h2>" +
			"<p class=\"card-desc\" id=\"time-desc\">" +
			"<span class=\"spinner\"></span> " + t("time.loading") + "</p>" +
			"<div class=\"table-wrap\"><table class=\"data\"><thead><tr>" +
			"<th>" + t("th.source") + "</th><th>" + t("th.time") + "</th>" +
			"<th>" + t("th.offset") + "</th><th>" + t("th.detail") + "</th>" +
			"</tr></thead><tbody>" +
			row("browser", t("time.browser")) +
			row("ntp", "NTP") +
			row("tinyauth", "tinyauth") +
			row("backend", "tinyauth-mgmt") +
			"</tbody></table></div>";
	}

	/* updates happen IN PLACE — the card frame is never destroyed, so the
	   first load and the30s cycle never make the card disappear */
	function updateTimeCard(tdata) {
		var card = document.getElementById("time-card");
		if (!card) return;
		var tz = tdata.display_tz || "";
		var desc = document.getElementById("time-desc");
		if (desc) {
			var srcLabel = tdata.display_tz_source === "TZ env" ? t("time.src_env")
				: (tdata.display_tz_source === "default" ? t("time.src_default")
					: tdata.display_tz_source || t("time.src_default"));
			desc.innerHTML =
				"<strong>" + esc(t("time.base_tz")) + "</strong> " +
				"<span class=\"tag\">" + esc(tz || "UTC") + "</span> " +
				"<span class=\"field-hint\">" +
				esc(t("time.from_src", { src: srcLabel })) + "</span><br>" +
				esc(t("time.desc2"));
		}
		var now = Date.now() / 1000;
		var values = { browser: now, ntp: tdata.ntp.epoch,
			tinyauth: tdata.tinyauth.epoch, backend: tdata.backend.epoch };
		var btz = "";
		try { btz = Intl.DateTimeFormat().resolvedOptions().timeZone || ""; } catch (e) {}
		var details = {
			browser: t("time.browser_detail", { tz: btz || "?" }),
			ntp: tdata.ntp.error ? tdata.ntp.error :
				t("time.ntp_server", { s: tdata.ntp.server || "" }) +
				(typeof tdata.ntp.age === "number" && tdata.ntp.age >= 1
					? t("time.queried", { n: Math.round(tdata.ntp.age) }) : ""),
			tinyauth: tdata.tinyauth.error ? tdata.tinyauth.error : t("time.httpdate"),
			backend: t("time.backend_detail",
				{ tz: tdata.backend.tz || "?", local: tdata.backend.local || "" })
		};
		card.querySelectorAll("tr[data-src]").forEach(function (tr) {
			var src = tr.dataset.src;
			var timeCell = tr.querySelector(".t-time");
			var offCell = tr.querySelector(".t-off");
			var detCell = tr.querySelector(".t-detail");
			if (detCell) detCell.innerHTML = esc(details[src] || "");
			var epoch = values[src];
			if (typeof epoch !== "number" || !isFinite(epoch)) {
				timeCell.textContent = "—";
				offCell.innerHTML = "";
				return;
			}
			timeCell.textContent = tz ? fmtTimeTz(epoch, tz) : fmtTime(epoch);
			if (src === "browser") { offCell.innerHTML = ""; return; }
			var d = epoch - now;              // measured once per snapshot
			var cls = Math.abs(d) <= 1 ? "success" : (Math.abs(d) <= 5 ? "warn" : "error");
			offCell.innerHTML = "<span class=\"badge " + cls + "\">" +
				(d >= 0 ? "+" : "") + d.toFixed(1) + "s</span>";
		});
	}

	function stopTimeCycle() {
		if (window.__tmTimeCycle) {
			clearInterval(window.__tmTimeCycle);
			window.__tmTimeCycle = null;
		}
	}

	function ensureTimeCycle() {
		if (window.__tmTimeCycle) return;
		window.__tmTimeCycle = setInterval(function () {
			if (currentView !== "stack" || document.hidden) {
				stopTimeCycle();
				return;
			}
			loadTimeCard();
		}, 30000);
	}

	function loadTimeCard() {
		var card = document.getElementById("time-card");
		if (!card) {
			// frame FIRST — the card (loading state) is visible before the fetch
			card = document.createElement("div");
			card.className = "card";
			card.id = "time-card";
			card.innerHTML = timeCardFrame();
			$("view").appendChild(card);
		}
		api("/api/admin/time").then(function (tdata) {
			if (currentView !== "stack") return;   // navigated away meanwhile
			updateTimeCard(tdata);                 // in-place: frame preserved
		}).catch(function () {
			var desc = document.getElementById("time-desc");
			if (desc) {
				desc.innerHTML = "<span class=\"error-box\">" +
					t("time.unavailable") + "</span>";
			}
		});
		ensureTimeCycle();   // cycle also retries after a failed fetch
	}

	/* ---- stack (admin) ---- */

	function viewStack() {
		var v = $("view");
		v.innerHTML = "<div class=\"card\"><div class=\"empty\"><span class=\"spinner\"></span> " +
			t("common.loading") + "</div></div>";
		api("/api/admin/image").then(function (d) {
			var matchBadge = d.compose_image == null
				? "<span class=\"badge\">" + t("stack.no_compose") + "</span>"
				: (d.match
					? "<span class=\"badge success\">" + t("stack.match") + "</span>"
					: "<span class=\"badge error\">" + t("stack.mismatch") + "</span>");
			var health = d.health
				? "<span class=\"badge " + (d.health === "healthy" ? "success" : "warn") + "\">" +
					esc(d.health) + "</span>"
				: "<span class=\"badge\">—</span>";
			v.innerHTML =
				"<div class=\"card\">" +
				"  <div class=\"toolbar\"><h2 class=\"card-title grow\">" + t("stack.title") + "</h2>" +
				"    <button class=\"btn danger small\" id=\"stack-restart\">" +
					t("stack.restart") + "</button>" +
				"    <button class=\"btn small\" id=\"stack-refresh\">" + t("common.refresh") +
					"</button></div>" +
				"  <p class=\"card-desc\">" + esc(t("stack.backend")) +
				" <span class=\"tag\">" + esc(d.backend || "?") + "</span> · " +
				esc(t("stack.vc")) + " " + matchBadge + " · " +
				esc(t("stack.health")) + " " + health + "</p>" +
				"  <dl class=\"kv\">" +
				"    <dt>" + t("kv.container") + "</dt><dd>" + esc(d.container_name || "—") + "</dd>" +
				"    <dt>" + t("kv.state") + "</dt><dd>" + esc(d.state || "—") + "</dd>" +
				"    <dt>" + t("kv.img_run") + "</dt><dd>" + esc(d.container_image || "—") + "</dd>" +
				"    <dt>" + t("kv.img_cmp") + "</dt><dd>" +
					esc(d.compose_image || (d.compose_note || "—")) + "</dd>" +
				"    <dt>" + t("kv.project") + "</dt><dd>" + esc(d.project || "—") + "</dd>" +
				"    <dt>" + t("kv.created") + "</dt><dd>" + esc(fmtTime(d.created)) + "</dd>" +
				"  </dl>" +
				"</div>";
			$("stack-refresh").addEventListener("click", viewStack);
			$("stack-restart").addEventListener("click", async function () {
				var ok = await confirmModal({
					title: t("stack.rs_title"),
					message: t("stack.rs_msg"),
					confirmLabel: t("stack.rs_confirm"),
					danger: false
				});
				if (!ok) return;
				try {
					var res = await apiPost("/api/admin/restart", { scope: "container" });
					if (res.healthy) {
						toast(t("stack.rs_ok", { s: res.waited_s, b: res.backend }), "success");
					} else {
						toast(res.warning || t("stack.rs_pending"), "warn");
					}
					refresh();
				} catch (e) { toast(e.message || t("common.failed"), "error"); }
			});
			loadTimeCard();
		}).catch(function (err) { v.innerHTML = errorBox(err); });
	}

	/* ---- account (self-service) ---- */

	function viewAccount() {
		var v = $("view");
		var totpCard = me.has_totp
			? "<div class=\"field\"><span class=\"field-label\">" + t("acc.my_totp") + "</span>" +
			  "<span class=\"field-hint\">" + esc(t("acc.bound")) + "</span></div>" +
			  "<div class=\"card-actions\">" +
			  "<button class=\"btn small\" id=\"acc-rebind\">" + t("acc.rebind_totp") + "</button>" +
			  "<button class=\"btn small danger\" id=\"acc-remove\">" + t("acc.remove_totp") +
			  "</button></div>"
			: "<div class=\"field\"><span class=\"field-label\">" + t("acc.my_totp") + "</span>" +
			  "<span class=\"field-hint\">" + esc(t("acc.unbound")) + "</span></div>" +
			  "<div class=\"card-actions\">" +
			  "<button class=\"btn primary small\" id=\"acc-enable\">" + t("acc.enable_totp") +
			  "</button></div>";

		v.innerHTML =
			"<div class=\"card\">" +
			"  <h2 class=\"card-title\">" + t("acc.title") + "</h2>" +
			"  <p class=\"card-desc\">" +
			esc(t("acc.desc", { user: me.username })) + "</p>" +
			"  <div class=\"field\"><span class=\"field-label\">" + t("acc.change_pw") + "</span>" +
			"    <span class=\"field-hint\">" + esc(t("acc.pw_hint")) + "</span></div>" +
			"  <div class=\"card-actions\">" +
			"    <button class=\"btn primary small\" id=\"acc-pw\">" + t("acc.change_pw") +
			"</button></div>" +
			"</div>" +
			"<div class=\"card\">" +
			"  <h2 class=\"card-title\">" + t("acc.2fa") + "</h2>" + totpCard +
			"</div>";

		$("acc-pw").addEventListener("click", async function () {
			var pw = await passwordModal(t("pw.self_title"));
			if (!pw) return;
			try {
				var res = await apiPost("/api/me/password", { password: pw });
				reportRestart(res, t("user.pw_changed", { user: me.username }));
			} catch (e) { toast(e.message || t("common.failed"), "error"); }
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

	function renderIdentity() {
		$("identity").hidden = false;
		$("identity-user").textContent = me.username;
		var rb = $("identity-role");
		rb.textContent = t(me.role === "admin" ? "role.admin" : "role.self");
		rb.className = "role-badge " + (me.role === "admin" ? "admin" : "self");
	}

	function boot() {
		$("brand-sub").textContent = t("brand.console");

		$("theme-toggle").addEventListener("click", function () {
			window.__tmTheme.cycle();
		});

		// language: 自动 -> 中 -> EN (text button, unlike the icon theme toggle)
		var langBtn = $("lang-toggle");
		langBtn.textContent = window.__tmI18n.toggleLabel();
		langBtn.addEventListener("click", function () {
			window.__tmI18n.cycle();
			langBtn.textContent = window.__tmI18n.toggleLabel();
			$("brand-sub").textContent = t("brand.console");
			if (me) {
				renderNav();
				route();          // re-render everything in the new language
			}
		});

		// background tab = no polling; returning = one fresh snapshot + resume
		document.addEventListener("visibilitychange", function () {
			if (document.hidden) {
				stopTimeCycle();
			} else if (currentView === "stack" && document.getElementById("time-card")) {
				loadTimeCard();
			}
		});

		// version badge (ungated endpoint, shows even before identity resolves)
		fetch("/api/health").then(function (r) { return r.json(); }).then(function (h) {
			if (h && h.version) {
				var v = $("brand-version");
				v.textContent = h.version;
				v.hidden = false;
				checkForUpdate(h.version);
			}
		}).catch(function () { /* version is cosmetic */ });

		api("/api/me").then(function (m) {
			me = m;
			renderIdentity();
			renderNav();
			window.addEventListener("hashchange", route);
			route();
		}).catch(function (err) {
			$("identity").hidden = false;
			$("identity-user").textContent = "—";
			$("identity-role").textContent = "error";
			$("identity-role").className = "role-badge self";
			$("view").innerHTML = errorBox(err);
		});
	}

	document.addEventListener("DOMContentLoaded", boot);
})();
