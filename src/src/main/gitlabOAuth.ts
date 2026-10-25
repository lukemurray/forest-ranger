/**
 * "Sign in with GitLab": OAuth 2 authorization code + PKCE for a public (secretless)
 * desktop client. The browser shows GitLab's approve page, which redirects to a
 * one-shot listener on 127.0.0.1; the code is exchanged for an access token
 * (~2h) and a rotating refresh token.
 *
 * GitLab only issues tokens to a registered OAuth application. That's a one-time
 * step by whoever publishes the app (gitlab.com → Edit profile → Applications, or a
 * group's Settings → Applications), not something each user does:
 *   Name:         Forest Ranger
 *   Redirect URI: http://127.0.0.1:33417/oauth/callback   (must match exactly)
 *   Confidential: unchecked (public client — PKCE, no secret)
 *   Scopes:       api
 * Put its Application ID in GITLAB_COM_CLIENT_ID. Self-managed GitLab hosts need
 * their own registration; Settings accepts an Application ID per host for that.
 */

import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { shell } from "electron";

/** Fixed: GitLab matches the redirect URI exactly (port included). */
export const OAUTH_PORT = 33417;
export const REDIRECT_URI = `http://127.0.0.1:${OAUTH_PORT}/oauth/callback`;
/** Forest Ranger's OAuth application on gitlab.com. Public — not a secret. */
export const GITLAB_COM_CLIENT_ID = "";
/** `api` covers MR/pipeline status and opening MRs (read_api can't create). */
const SCOPES = "api";
/** Give up on an abandoned browser sign-in after this long. */
const SIGN_IN_TIMEOUT_MS = 5 * 60_000;

export type OAuthTokens = { access: string; refresh: string; expiresAt: number };

/** Normalize a host into a scheme-qualified site URL with no trailing slash. */
export function siteUrl(host: string): string {
	let h = host.trim().replace(/\/+$/, "");
	if (!/^https?:\/\//i.test(h)) h = `https://${h}`;
	return h;
}

/** The built-in application id for this host, if it has one (gitlab.com only). */
export function builtInClientId(host: string): string {
	return /^(https?:\/\/)?(www\.)?gitlab\.com\/?$/i.test(host.trim()) ? GITLAB_COM_CLIENT_ID : "";
}

type TokenResponse = {
	access_token: string;
	refresh_token: string;
	expires_in?: number;
	created_at?: number;
	error?: string;
	error_description?: string;
};

async function tokenRequest(site: string, params: Record<string, string>): Promise<OAuthTokens> {
	const res = await fetch(`${site}/oauth/token`, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
		body: new URLSearchParams(params).toString(),
	});
	const json = (await res.json().catch(() => ({}))) as TokenResponse;
	if (!res.ok || !json.access_token) {
		throw new Error(json.error_description || json.error || `token request failed (${res.status})`);
	}
	// expires_in is seconds from issue; default to GitLab's 2h if omitted.
	const issued = (json.created_at ?? Math.floor(Date.now() / 1000)) * 1000;
	return {
		access: json.access_token,
		refresh: json.refresh_token,
		expiresAt: issued + (json.expires_in ?? 7200) * 1000,
	};
}

let active: { server: Server; cancel: (why: string) => void } | null = null;

/**
 * Run the browser sign-in and resolve with tokens. A newer sign-in cancels an
 * unfinished one (only one listener can hold the port).
 */
export function signIn(host: string, clientId: string): Promise<OAuthTokens> {
	const site = siteUrl(host);
	active?.cancel("Superseded by a new sign-in");

	const verifier = randomBytes(32).toString("base64url");
	const challenge = createHash("sha256").update(verifier).digest("base64url");
	const state = randomBytes(16).toString("base64url");

	return new Promise<OAuthTokens>((resolve, reject) => {
		let settled = false;
		const finish = (err: Error | null, tokens?: OAuthTokens) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			server.close();
			server.closeIdleConnections(); // don't leave a keep-alive socket a later sign-in's browser could reuse
			if (active?.server === server) active = null;
			if (err) reject(err);
			else resolve(tokens!);
		};

		const server = createServer((req, res) => {
			const url = new URL(req.url ?? "/", REDIRECT_URI);
			// One request per connection: a kept-alive socket would outlive this sign-in
			// and could receive the *next* sign-in's callback.
			if (url.pathname !== "/oauth/callback") {
				res.writeHead(404, { Connection: "close" }).end();
				return;
			}
			const page = (title: string, body: string) => {
				res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", Connection: "close" });
				res.end(
					`<!doctype html><meta charset="utf-8"><title>${title}</title>` +
						`<body style="font:15px -apple-system,system-ui,sans-serif;padding:48px;color:#1c1f26">` +
						`<h2 style="margin:0 0 8px">${title}</h2><p>${body}</p></body>`,
				);
			};
			// Static text only — nothing from the query string is reflected.
			if (url.searchParams.get("state") !== state) {
				page("Sign-in failed", "This sign-in link doesn't match the one Forest Ranger started. Try again from the app.");
				finish(new Error("Sign-in state mismatch"));
				return;
			}
			const error = url.searchParams.get("error");
			const code = url.searchParams.get("code");
			if (error || !code) {
				page("Sign-in cancelled", "No changes were made. You can close this tab.");
				finish(new Error(error === "access_denied" ? "Sign-in was declined" : error || "No authorization code"));
				return;
			}
			tokenRequest(site, {
				client_id: clientId,
				grant_type: "authorization_code",
				code,
				redirect_uri: REDIRECT_URI,
				code_verifier: verifier,
			}).then(
				(tokens) => {
					page("Signed in to GitLab", "You can close this tab and return to Forest Ranger.");
					finish(null, tokens);
				},
				(err) => {
					page("Sign-in failed", "GitLab didn't accept the sign-in. Return to Forest Ranger for details.");
					finish(err instanceof Error ? err : new Error(String(err)));
				},
			);
		});

		const timer = setTimeout(() => finish(new Error("Sign-in timed out")), SIGN_IN_TIMEOUT_MS);
		active = { server, cancel: (why) => finish(new Error(why)) };

		server.once("error", (err: NodeJS.ErrnoException) =>
			finish(
				new Error(
					err.code === "EADDRINUSE"
						? `Port ${OAUTH_PORT} is in use — close whatever is using it and try again`
						: err.message,
				),
			),
		);
		server.listen(OAUTH_PORT, "127.0.0.1", () => {
			const authorize = new URL(`${site}/oauth/authorize`);
			authorize.search = new URLSearchParams({
				client_id: clientId,
				redirect_uri: REDIRECT_URI,
				response_type: "code",
				scope: SCOPES,
				state,
				code_challenge: challenge,
				code_challenge_method: "S256",
			}).toString();
			shell.openExternal(authorize.toString()).catch((err) => finish(err));
		});
	});
}

/** Exchange a refresh token for fresh tokens (GitLab rotates the refresh token). */
export function refresh(host: string, clientId: string, refreshToken: string): Promise<OAuthTokens> {
	return tokenRequest(siteUrl(host), {
		client_id: clientId,
		grant_type: "refresh_token",
		refresh_token: refreshToken,
		redirect_uri: REDIRECT_URI,
	});
}

/** Best-effort revoke on sign-out (the local copy is deleted regardless). */
export async function revoke(host: string, clientId: string, token: string): Promise<void> {
	await fetch(`${siteUrl(host)}/oauth/revoke`, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({ client_id: clientId, token }).toString(),
	}).catch(() => {});
}
