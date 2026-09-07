import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateRoleGate, denyRpcEnvelope } from "../lib/index.js";

/** Build a client-request body buffer like the browser's connection layer sends. */
const clientRequest = (method, rpcId = "rpc-1") => Buffer.from(JSON.stringify({
	type: "client-request", rpcId, method, payload: {},
}));

/** Build a client-response body buffer (the /api/respond channel). */
const clientResponse = (rpcId = "rpc-1") => Buffer.from(JSON.stringify({
	type: "client-response", rpcId, result: { ok: true, value: {} },
}));

// ── respond channel must pass for every role ───────────────────────────────────
// Regression: roleGate denied /api/respond because a client-response envelope
// has no `method` (method === null fell into the deny branch). The host's
// pending server-requests (approvals, questions, tool results, subagent
// submissions) then never got answered, the host aborted the stream, the
// WebSocket reconnected, and the workspace/session baselines reloaded —
// appearing "cleared" whenever a flow needed a respond (e.g. editing a model
// fired credentials.describe, whose own denial compounded the break).

test("evaluateRoleGate: /api/respond passes for user and guest", () => {
	for (const role of ["user", "guest"]) {
		const gate = evaluateRoleGate("/api/respond", "POST", clientResponse("r-9"), role);
		assert.equal(gate.allowed, true, `role ${role}`);
		assert.equal(gate.replayed, true, `role ${role} must replay the body`);
	}
});

test("evaluateRoleGate: /api/respond passes for admin", () => {
	const gate = evaluateRoleGate("/api/respond", "POST", clientResponse(), "admin");
	assert.equal(gate.allowed, true);
});

test("evaluateRoleGate: non-client-request POST envelopes are never role-denied", () => {
	const gate = evaluateRoleGate("/api/events.host", "POST", Buffer.from(JSON.stringify({ type: "other", foo: 1 })), "user");
	assert.equal(gate.allowed, true);
});

// ── client-request gating still applies ────────────────────────────────────────

test("evaluateRoleGate: credentials.describe is denied for user", () => {
	const gate = evaluateRoleGate("/api/credentials.describe", "POST", clientRequest("credentials.describe"), "user");
	assert.equal(gate.allowed, false);
});

test("evaluateRoleGate: session.prompt is denied for guest but allowed for user", () => {
	assert.equal(evaluateRoleGate("/api/session.prompt", "POST", clientRequest("session.prompt"), "guest").allowed, false);
	assert.equal(evaluateRoleGate("/api/session.prompt", "POST", clientRequest("session.prompt"), "user").allowed, true);
});

test("evaluateRoleGate: workspace.list is allowed for every role", () => {
	for (const role of ["admin", "user", "guest"]) {
		assert.equal(evaluateRoleGate("/api/workspace.list", "POST", clientRequest("workspace.list"), role).allowed, true, role);
	}
});

test("evaluateRoleGate: GET /api skips body-based role gating", () => {
	// session.export is admin-only (a non-admin export would dump any account's
	// session); the point here is a GET with no body never falls into the
	// envelope deny branch.
	assert.equal(evaluateRoleGate("/api/session.export", "GET", null, "admin").allowed, true);
	assert.equal(evaluateRoleGate("/api/session.export", "GET", null, "user").allowed, false);
	assert.equal(evaluateRoleGate("/api/session.export", "GET", null, "guest").allowed, false);
	assert.equal(evaluateRoleGate("/api/session.list", "GET", null, "guest").allowed, true);
});

// ── unmapped non-admin accounts fail closed on the session surface ─────────────
// P5 hardening: a non-admin account without a roleMap entry must not reach
// session methods at all — an unmapped session.list would return every
// session, since no scopeUser would be stamped for it.

test("evaluateRoleGate: unmapped user account is denied session methods", () => {
	const mapped = new Set(["Finance-mgr", "Finance-staff"]);
	assert.equal(evaluateRoleGate("/api/session.list", "POST", clientRequest("session/list"), "user", "Newbie", null, mapped).allowed, false);
	assert.equal(evaluateRoleGate("/api/session.create", "POST", clientRequest("session.create"), "user", "Newbie", null, mapped).allowed, false);
});

test("evaluateRoleGate: mapped user account keeps session.create", () => {
	const mapped = new Set(["Finance-mgr"]);
	const gate = evaluateRoleGate("/api/session.create", "POST", clientRequest("session.create"), "user", "Finance-mgr", () => null, mapped);
	assert.equal(gate.allowed, true);
});

test("evaluateRoleGate: admin is exempt from the mapped-account rule", () => {
	const mapped = new Set(["Finance-mgr"]);
	assert.equal(evaluateRoleGate("/api/session.list", "POST", clientRequest("session/list"), "admin", undefined, null, mapped).allowed, true);
});

test("evaluateRoleGate: commands/execute is denied for the user role", () => {
	assert.equal(evaluateRoleGate("/api/commands.execute", "POST", clientRequest("commands/execute"), "user").allowed, false);
});

// ── denied client-requests answer with a wire-compliant envelope ──────────────

test("denyRpcEnvelope: emits a server-response the client schema can parse", () => {
	const chunks = [];
	const res = {
		writeHead(status, headers) {
			this.status = status;
			this.headers = headers;
		},
		end(text) {
			chunks.push(text);
		},
	};
	denyRpcEnvelope(res, clientRequest("credentials.describe", "echo-42"), "forbidden for role user");
	const body = JSON.parse(chunks.join(""));
	assert.equal(res.status, 200, "business denial must be a 200 so the client parses the envelope");
	assert.equal(body.type, "server-response");
	assert.equal(body.rpcId, "echo-42", "rpcId must echo the request");
	assert.equal(body.result.ok, false);
	assert.equal(body.result.error.code, "internal", "code must be one of the client schema's codes");
	assert.equal(body.result.error.message, "forbidden for role user");
	assert.deepEqual(body.result.error.details, {});
	assert.equal(res.headers["Content-Type"], "application/json; charset=utf-8");
});
