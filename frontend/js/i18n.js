/* tinyauth-mgmt — i18n (vanilla, no build)
   Language state: "auto" (follow the browser, zh* -> zh) | "zh" | "en",
   persisted in localStorage. t(key, params) falls back to the English
   source, then to the key itself. */
(function () {
	"use strict";
	var LANG_KEY = "tm-lang";

	var dict = {
		en: {
			"brand.console": "console",
			"role.admin": "admin",
			"role.self": "self",

			"nav.users": "Users",
			"nav.sessions": "Sessions",
			"nav.stack": "Stack",
			"nav.account": "My account",

			"common.loading": "loading…",
			"common.refresh": "Refresh",
			"common.cancel": "Cancel",
			"common.save": "Save",
			"common.close": "Close",
			"common.create": "Create",
			"common.failed": "failed",
			"common.mismatch": "text does not match",

			"users.title": "Users",
			"users.new": "+ New user",
			"users.desc": "Local accounts from the tinyauth users file · active / total sessions",
			"users.empty": "no users",
			"th.username": "Username",
			"th.totp": "TOTP",
			"th.sessions": "Sessions (active / total)",
			"th.sessions_short": "Sessions",
			"th.actions": "Actions",
			"badge.totp": "TOTP",
			"badge.no_totp": "no totp",
			"btn.password": "Password",
			"btn.delete": "Delete",

			"user.del.title": "Delete user · {user}",
			"user.del.msg": "Removes the account and kicks all of its sessions. This cannot be undone.",
			"user.del.confirm": "Delete {user}",
			"user.created": "User '{user}' created",
			"user.pw_changed": "Password changed for '{user}'",
			"user.deleted": "User '{user}' deleted",
			"user.deleted_n": "User '{user}' deleted ({n} sessions kicked)",

			"pw.title": "Change password · {user}",
			"pw.new": "New password (min 8)",
			"pw.repeat": "Repeat password",
			"pw.err_min": "Password must be at least 8 characters.",
			"pw.err_match": "Passwords do not match.",
			"pw.self_title": "Change my password",

			"user.new.title": "New user",
			"user.new.name": "Username",
			"user.new.name_hint": "no spaces, no ':'",
			"user.new.pw": "Password (min 8)",
			"user.new.err_name": "Invalid username (no spaces or ':', max 64).",

			"totp.entry.title": "TOTP · {user}",
			"totp.entry.msg": "This user already has TOTP bound. Rebind replaces the current secret (authenticators must scan the new one); remove turns TOTP off.",
			"totp.rebind": "Rebind",
			"totp.remove": "Remove",
			"totp.enable_title": "Enable TOTP · {user}",
			"totp.rebind_title": "Rebind TOTP · {user}",
			"totp.requesting": "requesting secret…",
			"totp.secret": "Secret (add to your authenticator)",
			"totp.otpauth": "otpauth link",
			"totp.code": "Enter the 6-digit code",
			"totp.err_code": "Enter the 6-digit code from your authenticator.",
			"totp.verify_save": "Verify & save",
			"totp.enabled": "TOTP enabled",
			"totp.rebound": "TOTP rebound",
			"totp.removed": "TOTP removed",
			"totp.rm_title": "Remove TOTP · {user}",
			"totp.rm_msg": "Your authenticator will stop being required at login. Password login stays unchanged.",
			"totp.rm_confirm": "Remove TOTP",

			"sessions.title": "Sessions",
			"sessions.kick_all": "Kick all",
			"sessions.desc": "Every session in tinyauth's store · expiry slides on use, hard cap {cap} from login",
			"sessions.filter": "filter by username or uuid",
			"sessions.empty": "no sessions match",
			"f.user": "User",
			"f.provider": "Provider",
			"f.flags": "Flags",
			"f.created": "Created",
			"f.expires": "Expires",
			"f.remaining": "Remaining",
			"f.status": "Status",
			"btn.kick": "Kick",
			"btn.kick_session": "Kick this session",
			"btn.kick_user": "Kick user sessions",
			"kick1.title": "Kick this session",
			"kick1.msg": "Ends THIS one session. The owner returns to the tinyauth login on the next request.",
			"kick1.confirm": "Kick session",
			"kick1.done": "Session kicked",
			"kick.title": "Kick sessions · {user}",
			"kick.msg": "Ends ALL sessions of '{user}'. Their next request goes back to the tinyauth login.",
			"kick.confirm": "Kick {user}",
			"kick.done": "Kicked {n} session(s) of '{user}'",
			"kickall.title": "Kick ALL sessions",
			"kickall.msg": "Every user on every site must log in again.",
			"kickall.confirm": "Kick everyone",
			"kickall.done": "Kicked {n} session(s) total",

			"stack.title": "Stack",
			"stack.restart": "Restart tinyauth",
			"stack.backend": "Backend:",
			"stack.vc": "container vs compose",
			"stack.match": "match",
			"stack.mismatch": "mismatch",
			"stack.no_compose": "compose n/a",
			"stack.health": "health",
			"kv.container": "container",
			"kv.state": "state",
			"kv.img_run": "image (running)",
			"kv.img_cmp": "image (compose)",
			"kv.project": "compose project",
			"kv.created": "created",
			"stack.rs_title": "Restart tinyauth",
			"stack.rs_msg": "Gracefully restarts the tinyauth container. Active sessions survive (they live in the database); logins pause for a few seconds.",
			"stack.rs_confirm": "Restart",
			"stack.rs_ok": "tinyauth restarted ({s}s, via {b})",
			"stack.rs_pending": "restarted, but health check pending",
			"stack.rs_warn": "container restarted but health check has not passed yet",

			"acc.title": "My account",
			"acc.desc": "Signed in as {user} · self-service only — your username comes from the login chain and cannot be changed here.",
			"acc.change_pw": "Change password",
			"acc.pw_hint": "Applies to your own account only.",
			"acc.2fa": "Two-factor",
			"acc.my_totp": "My TOTP",
			"acc.bound": "Bound. Rebind replaces the secret; remove turns it off.",
			"acc.rebind_totp": "Rebind TOTP",
			"acc.remove_totp": "Remove TOTP",
			"acc.enable_totp": "Enable TOTP",
			"acc.unbound": "Not bound yet. Enabling shows a secret to scan and asks for a test code.",

			"time.title": "Time",
			"time.base_tz": "Base timezone",
			"time.from_src": "(from {src} · every row below renders in it)",
			"time.src_env": "tinyauth-mgmt's TZ env",
			"time.src_default": "default",
			"time.desc2": "one snapshot every 30s — polling stops while this tab or view is inactive · drift > 5s can break TOTP",
			"time.loading": "loading time sources…",
			"time.unavailable": "time sources unavailable — will retry with the next snapshot",
			"th.source": "Source",
			"th.time": "Time",
			"th.offset": "Offset vs browser",
			"th.detail": "Detail",
			"time.browser": "Browser (this device)",
			"time.browser_detail": "browser tz: {tz} · reference",
			"time.ntp_server": "server: {s}",
			"time.queried": " · queried {n}s ago",
			"time.httpdate": "HTTP Date header",
			"time.backend_detail": "tz {tz} · {local}",

			"err.401": "No identity received. The reverse proxy must forward tinyauth's Remote-User header — see docs/reverse-proxy.",
			"err.403": "Forbidden. Check GATEWAY_TOKEN and your ADMIN_USERS entry.",
			"err.request": "request failed",
			"restart.failed": " — restart failed: {e}"
		},
		zh: {
			"brand.console": "控制台",
			"role.admin": "admin",
			"role.self": "自助",

			"nav.users": "用户",
			"nav.sessions": "会话",
			"nav.stack": "堆栈",
			"nav.account": "我的账号",

			"common.loading": "加载中…",
			"common.refresh": "刷新",
			"common.cancel": "取消",
			"common.save": "保存",
			"common.close": "关闭",
			"common.create": "创建",
			"common.failed": "操作失败",
			"common.mismatch": "输入不匹配",

			"users.title": "用户",
			"users.new": "+ 新建用户",
			"users.desc": "tinyauth 用户文件中的本地账号 · 活跃/总会话数",
			"users.empty": "无用户",
			"th.username": "用户名",
			"th.totp": "TOTP",
			"th.sessions": "会话（活跃/总数）",
			"th.sessions_short": "会话",
			"th.actions": "操作",
			"badge.totp": "TOTP",
			"badge.no_totp": "未绑定",
			"btn.password": "密码",
			"btn.delete": "删除",

			"user.del.title": "删除用户 · {user}",
			"user.del.msg": "删除该账号并踢出其全部会话，此操作不可撤销。",
			"user.del.confirm": "删除 {user}",
			"user.created": "已创建用户 '{user}'",
			"user.pw_changed": "已修改 {user} 的密码",
			"user.deleted": "已删除用户 '{user}'",
			"user.deleted_n": "已删除 {user}（踢出 {n} 个会话）",

			"pw.title": "修改密码 · {user}",
			"pw.new": "新密码（至少8位）",
			"pw.repeat": "重复密码",
			"pw.err_min": "密码至少需要8位。",
			"pw.err_match": "两次输入不一致。",
			"pw.self_title": "修改我的密码",

			"user.new.title": "新建用户",
			"user.new.name": "用户名",
			"user.new.name_hint": "不能含空格和 ':'",
			"user.new.pw": "密码（至少8位）",
			"user.new.err_name": "用户名不合法（不能含空格或 ':'，最多64字符）。",

			"totp.entry.title": "TOTP · {user}",
			"totp.entry.msg": "该用户已绑定 TOTP。改绑会替换当前密钥（认证器需重新扫描）；移除则关闭 TOTP。",
			"totp.rebind": "改绑",
			"totp.remove": "移除",
			"totp.enable_title": "启用 TOTP · {user}",
			"totp.rebind_title": "改绑 TOTP · {user}",
			"totp.requesting": "正在获取密钥…",
			"totp.secret": "密钥（添加到你的认证器）",
			"totp.otpauth": "otpauth 链接",
			"totp.code": "输入6位验证码",
			"totp.err_code": "请输入认证器上的6位验证码。",
			"totp.verify_save": "验证并保存",
			"totp.enabled": "TOTP 已启用",
			"totp.rebound": "TOTP 已改绑",
			"totp.removed": "TOTP 已移除",
			"totp.rm_title": "移除 TOTP · {user}",
			"totp.rm_msg": "登录将不再要求认证器，密码登录不受影响。",
			"totp.rm_confirm": "移除 TOTP",

			"sessions.title": "会话",
			"sessions.kick_all": "全部踢出",
			"sessions.desc": "tinyauth 存储中的全部会话 · 过期随使用滑动，登录起算硬上限 {cap}",
			"sessions.filter": "按用户名或 uuid 过滤",
			"sessions.empty": "无匹配会话",
			"f.user": "用户",
			"f.provider": "提供方",
			"f.flags": "标记",
			"f.created": "创建",
			"f.expires": "过期",
			"f.remaining": "剩余",
			"f.status": "状态",
			"btn.kick": "踢出",
			"btn.kick_session": "踢此会话",
			"btn.kick_user": "踢该用户全部",
			"kick1.title": "踢出此会话",
			"kick1.msg": "只结束这一条会话，属主下次请求将回到 tinyauth 登录。",
			"kick1.confirm": "踢出",
			"kick1.done": "已踢出该会话",
			"kick.title": "踢出会话 · {user}",
			"kick.msg": "结束 '{user}' 的全部会话，其下一次请求将回到 tinyauth 登录。",
			"kick.confirm": "踢出 {user}",
			"kick.done": "已踢出 {user} 的 {n} 个会话",
			"kickall.title": "踢出全部会话",
			"kickall.msg": "所有站点的所有用户都需要重新登录。",
			"kickall.confirm": "全部踢出",
			"kickall.done": "共踢出 {n} 个会话",

			"stack.title": "堆栈",
			"stack.restart": "重启 tinyauth",
			"stack.backend": "后端：",
			"stack.vc": "容器 vs compose",
			"stack.match": "一致",
			"stack.mismatch": "不一致",
			"stack.no_compose": "无 compose 比对",
			"stack.health": "健康",
			"kv.container": "容器",
			"kv.state": "状态",
			"kv.img_run": "镜像（运行中）",
			"kv.img_cmp": "镜像（compose）",
			"kv.project": "compose 项目",
			"kv.created": "创建时间",
			"stack.rs_title": "重启 tinyauth",
			"stack.rs_msg": "优雅重启 tinyauth 容器。活跃会话不受影响（存储在数据库中）；登录会暂停数秒。",
			"stack.rs_confirm": "重启",
			"stack.rs_ok": "tinyauth 已重启（{s} 秒，经 {b}）",
			"stack.rs_pending": "已重启，健康检查待确认",
			"stack.rs_warn": "容器已重启但健康检查尚未通过",

			"acc.title": "我的账号",
			"acc.desc": "当前登录：{user} · 仅自助服务——用户名来自登录链路，此处不可更改。",
			"acc.change_pw": "修改密码",
			"acc.pw_hint": "仅作用于你自己的账号。",
			"acc.2fa": "两因子",
			"acc.my_totp": "我的 TOTP",
			"acc.bound": "已绑定。改绑会替换密钥；移除则关闭。",
			"acc.rebind_totp": "改绑 TOTP",
			"acc.remove_totp": "移除 TOTP",
			"acc.enable_totp": "启用 TOTP",
			"acc.unbound": "尚未绑定。启用时会展示密钥供扫描，并要求输入验证码验证。",

			"time.title": "时间",
			"time.base_tz": "基准时区",
			"time.from_src": "（来自 {src} · 下方各行均以它显示）",
			"time.src_env": "tinyauth-mgmt 的 TZ 环境变量",
			"time.src_default": "默认",
			"time.desc2": "每30秒一张快照——标签页或视图非活动时停止轮询 · 漂移超过5秒会破坏 TOTP",
			"time.loading": "正在加载时间源…",
			"time.unavailable": "时间源不可用——将在下一个快照重试",
			"th.source": "来源",
			"th.time": "时间",
			"th.offset": "与浏览器的偏移",
			"th.detail": "详情",
			"time.browser": "浏览器（本设备）",
			"time.browser_detail": "浏览器时区：{tz} · 基准",
			"time.ntp_server": "服务器：{s}",
			"time.queried": " · {n}秒前查询",
			"time.httpdate": "HTTP Date 响应头",
			"time.backend_detail": "时区 {tz} · {local}",

			"err.401": "未收到身份信息。反向代理需转发 tinyauth 的 Remote-User 头——参见 docs/reverse-proxy。",
			"err.403": "被拒绝。请检查 GATEWAY_TOKEN 与 ADMIN_USERS 配置。",
			"err.request": "请求失败",
			"restart.failed": " —— 重启失败：{e}"
		}
	};

	function resolve() {
		var m;
		try { m = localStorage.getItem(LANG_KEY); } catch (e) { m = null; }
		m = m || "auto";
		if (m === "auto") {
			var nav = (navigator.language || navigator.userLanguage || "en").toLowerCase();
			return nav.indexOf("zh") === 0 ? "zh" : "en";
		}
		return m === "zh" ? "zh" : "en";
	}

	var lang = resolve();

	function t(key, params) {
		var s = (dict[lang] && dict[lang][key]) || dict.en[key] || key;
		if (params) {
			Object.keys(params).forEach(function (k) {
				s = s.split("{" + k + "}").join(String(params[k]));
			});
		}
		return s;
	}

	function mode() {
		try { return localStorage.getItem(LANG_KEY) || "auto"; }
		catch (e) { return "auto"; }
	}

	function setMode(m) {
		try { localStorage.setItem(LANG_KEY, m); } catch (e) { /* private mode */ }
		lang = resolve();
	}

	function cycle() {
		var order = ["auto", "zh", "en"];
		var next = order[(order.indexOf(mode()) + 1) % order.length];
		setMode(next);
		return next;
	}

	/* button label stays locale-independent by design: 自动 / 中 / EN */
	function toggleLabel() {
		var m = mode();
		return m === "auto" ? "自动" : (m === "zh" ? "中" : "EN");
	}

	window.__tmI18n = {
		t: t,
		get lang() { return lang; },
		mode: mode,
		setMode: setMode,
		cycle: cycle,
		toggleLabel: toggleLabel
	};
})();
