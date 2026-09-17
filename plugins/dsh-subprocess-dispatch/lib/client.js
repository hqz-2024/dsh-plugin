/**
 * dsh-subprocess-dispatch — browser half.
 *
 * Loaded by the shell's client module loader (`window.__ModuleLoader__.load`),
 * exactly like the shipped `dsh.client` bundles: one self-contained factory, no
 * imports, dependencies pulled through the provided `require`.
 *
 * Responsibility: the admin surface for workspace bindings (plan §2.1's second
 * manual exit). The occupant's own page covers the common case, but not the one
 * this exists for -- a machine that is still alive and still holding a workspace
 * while its user has walked away. Nothing on that machine can be asked to let go,
 * so somebody else has to be able to, from the browser.
 *
 * It lives beside the endpoint it calls (`/client-admin/...`) rather than in the
 * auth plugin's settings page: the plugin that owns the admin surface owns the UI
 * for it, and the deployment's auth plugin does not have to learn about bindings.
 *
 * NOTE on rendering: React's automatic runtime signature is
 * `jsx(type, props, key)` -- children MUST live inside `props.children`, which is
 * what the `h()` helper below folds variadic children into.
 */
window.__ModuleLoader__.load({
	id: "dsh-subprocess-dispatch",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const react = require("react");
		const { jsx } = require("react/jsx-runtime");

		const name = "dsh-subprocess-dispatch";

		/** jsx(type, props, ...children) -- folds children into props.children. */
		function h(type, props, ...children) {
			if (children.length === 0) return jsx(type, props || {});
			if (children.length === 1) return jsx(type, { ...(props || {}), children: children[0] });
			return jsx(type, { ...(props || {}), children });
		}

		const copy = {
			zh: {
				title: "工作区绑定",
				intro: "工作区被某台机器绑定后，该工作区里的命令就在那台机器上执行。这里可以看当前占用情况，并在占用人离开时强制释放。",
				refresh: "刷新",
				none: "当前没有任何绑定。",
				loading: "读取中…",
				denied: "需要管理员权限才能查看和释放别人的绑定。",
				unavailable: "客户端执行世界没有挂在这个实例上（没有可查询的绑定端点）。",
				unbind: "强制解绑",
				unbinding: "释放中…",
				released: "已释放",
				failed: "释放失败",
				colWorkspace: "工作区",
				colOccupant: "占用人",
				colMachine: "机器",
				colState: "状态",
				stateActive: "占用中",
				stateExpired: "已失效",
				connected: "在线",
				offline: "离线",
				heldSince: "自",
			},
			en: {
				title: "Workspace bindings",
				intro: "A workspace bound to a machine runs that workspace's commands on it. This lists who holds what, and releases a binding when its occupant has walked away.",
				refresh: "Refresh",
				none: "No workspace is bound right now.",
				loading: "Loading…",
				denied: "Admin rights are required to see or release another account's binding.",
				unavailable: "The client execution world is not mounted on this instance (no bindings endpoint).",
				unbind: "Force release",
				unbinding: "Releasing…",
				released: "Released",
				failed: "Release failed",
				colWorkspace: "Workspace",
				colOccupant: "Occupant",
				colMachine: "Machine",
				colState: "State",
				stateActive: "held",
				stateExpired: "expired",
				connected: "online",
				offline: "offline",
				heldSince: "since",
			},
		};

		/**
		 * Active translator. Starts as a zh fallback and is replaced by a
		 * locale-service binding in apply(); components call `t(...)` at render time so
		 * a language switch re-renders them. Reading `document.documentElement.lang`
		 * instead looked reasonable and was wrong: this deployment's shell keeps that
		 * attribute in English while the UI is Chinese, so the section rendered its
		 * label in the wrong language next to correctly translated neighbours.
		 */
		let t = (key) => copy.zh[key] ?? key;

		const NS = "dsh-subprocess-dispatch";

		const muted = { fontSize: "12px", color: "var(--dsw-alias-label-secondary, #8b949e)" };
		const label = { fontSize: "13px", color: "var(--dsw-alias-label-primary, #e6edf3)" };
		const field = {
			font: "inherit",
			padding: "4px 8px",
			borderRadius: "6px",
			border: "1px solid var(--dsw-alias-border-l2, #30363d)",
			background: "var(--dsw-alias-bg-base, transparent)",
			color: "var(--dsw-alias-label-primary, #e6edf3)",
		};
		const button = {
			...field,
			cursor: "pointer",
			background: "var(--dsw-alias-bg-l2, rgba(127,127,127,0.12))",
		};
		const chip = {
			fontSize: "11px",
			padding: "1px 7px",
			borderRadius: "999px",
			border: "1px solid var(--dsw-alias-border-l2, #30363d)",
			color: "var(--dsw-alias-label-secondary, #8b949e)",
		};

		/** One admin request; `status` is returned so the caller can tell 403 from a real answer. */
		async function adminCall(path, body) {
			try {
				const response = await fetch(`/client-admin${path}`, body === undefined
					? { headers: { accept: "application/json" } }
					: { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
				let payload = null;
				try { payload = await response.json(); } catch { payload = null; }
				return { status: response.status, payload };
			} catch (error) {
				return { status: 0, payload: { error: String((error && error.message) || error) } };
			}
		}



		function BindingsSection() {
			const [state, setState] = react.useState({ status: "loading", rows: [], note: "", busy: "" });

			const load = react.useCallback(async () => {
				const { status, payload } = await adminCall("/bindings");
				if (status === 403) return setState({ status: "denied", rows: [], note: "", busy: "" });
				if (status === 404 || status === 501 || status === 0) return setState({ status: "unavailable", rows: [], note: "", busy: "" });
				if (status !== 200) {
					return setState({ status: "ready", rows: [], note: String(payload?.error ?? `HTTP ${status}`), busy: "" });
				}
				setState({ status: "ready", rows: Array.isArray(payload?.bindings) ? payload.bindings : [], note: "", busy: "" });
			}, []);
			react.useEffect(() => { load(); }, [load]);

			const release = async (workspaceId) => {
				setState((prev) => ({ ...prev, busy: workspaceId, note: t("unbinding") }));
				const { status, payload } = await adminCall("/unbind", { workspaceId });
				if (status === 200 && payload?.ok) {
					// Re-read rather than patching the row locally: the store is what decides,
					// and another admin may have changed it in the meantime.
					await load();
					setState((prev) => ({ ...prev, note: t("released") }));
					return;
				}
				setState((prev) => ({ ...prev, busy: "", note: `${t("failed")}: ${String(payload?.error ?? `HTTP ${status}`)}` }));
			};

			if (state.status === "denied" || state.status === "unavailable") {
				return h("div", { style: { padding: "4px 0" } }, h("div", { style: muted }, t(state.status)));
			}

			return h("div", { style: { padding: "4px 0" } }, [
				h("h3", { key: "title", style: { margin: "0 0 4px", fontSize: "14px", color: "var(--dsw-alias-label-primary, #e6edf3)" } }, t("title")),
				h("div", { key: "intro", style: { ...muted, marginBottom: "10px" } }, t("intro")),
				h("div", { key: "bar", style: { display: "flex", gap: "8px", alignItems: "center", marginBottom: "8px" } }, [
					h("button", { key: "refresh", type: "button", style: button, onClick: load }, t("refresh")),
					state.note ? h("span", { key: "note", style: muted }, state.note) : null,
				]),
				state.status === "loading" ? h("div", { key: "loading", style: muted }, t("loading")) : null,
				state.status === "ready" && state.rows.length === 0 ? h("div", { key: "none", style: muted }, t("none")) : null,
				state.status === "ready" ? h("table", { key: "table", style: { width: "100%", borderCollapse: "collapse", fontSize: "13px" } }, [
					h("thead", { key: "head" }, h("tr", null, [
						h("th", { key: "w", style: { textAlign: "left", ...muted, padding: "4px 6px" } }, t("colWorkspace")),
						h("th", { key: "o", style: { textAlign: "left", ...muted, padding: "4px 6px" } }, t("colOccupant")),
						h("th", { key: "m", style: { textAlign: "left", ...muted, padding: "4px 6px" } }, t("colMachine")),
						h("th", { key: "s", style: { textAlign: "left", ...muted, padding: "4px 6px" } }, t("colState")),
						h("th", { key: "a", style: { padding: "4px 6px" } }, ""),
					])),
					h("tbody", { key: "body" }, state.rows.map((row) => h("tr", { key: row.workspaceId, style: { borderTop: "1px solid var(--dsw-alias-border-l2, #30363d)" } }, [
						h("td", { key: "w", style: { ...label, padding: "6px" } }, row.workspaceTitle || row.workspaceId),
						h("td", { key: "o", style: { padding: "6px" } }, row.username || "-"),
						h("td", { key: "m", style: { padding: "6px" } }, [
							h("div", { key: "name" }, row.machine || "-"),
							h("div", { key: "facts", style: muted }, [row.machineHost, row.machinePlatform].filter(Boolean).join(" ")),
						]),
						h("td", { key: "s", style: { padding: "6px" } }, [
							h("span", { key: "state", style: chip }, row.state === "active" ? t("stateActive") : t("stateExpired")),
							" ",
							h("span", { key: "conn", style: muted }, row.connected ? t("connected") : t("offline")),
							row.boundAt ? h("div", { key: "since", style: muted }, `${t("heldSince")} ${String(row.boundAt).replace("T", " ").slice(0, 19)}`) : null,
						]),
						h("td", { key: "a", style: { padding: "6px", textAlign: "right" } },
							row.state === "active"
								? h("button", {
									type: "button",
									style: { ...button, whiteSpace: "nowrap" },
									disabled: state.busy === row.workspaceId,
									onClick: () => release(row.workspaceId),
								}, state.busy === row.workspaceId ? t("unbinding") : t("unbind"))
								: null),
					]))),
				]) : null,
			]);
		}

		function apply(ctx) {
			// Register the dictionaries with the app's locale service and bind a live
			// translator, so the section follows the app-level language preference and
			// runtime switches instead of guessing from the document.
			ctx.effect(() => {
				const dispose = ctx.locale.register(NS, { zh: copy.zh, en: copy.en });
				t = ctx.locale.bind(NS);
				return () => {
					dispose();
					t = (key) => copy.zh[key] ?? key;
				};
			}, "dsh-subprocess-dispatch: locale dictionaries");

			// Order 1010: right after the auth plugin's local-plugins section (1000), so
			// the admin surfaces stay together at the end of the settings list.
			ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "client-bindings",
				order: 1010,
				label: () => t("title"),
				inject: () => ({}),
			}, BindingsSection));
		}

		exports.apply = apply;
		// `slots` and `locale` are hard requirements: apply() registers a settings
		// section and its dictionaries, and reaching either service without declaring
		// it fails the whole bundle at load ("cannot get property \"slots\" without
		// inject"), which takes the section down with it rather than degrading it.
		exports.inject = ["slots", "locale"];
		exports.name = name;
		return module.exports;
	},
});
