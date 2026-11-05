import { createHash, createHmac, randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import { HttpError, get, put, redis, key, rateLimit } from "./store.js";
import { jsonFetch, mcp, MCP_URL } from "./integrations.js";

const issuer = "https://magichour.ai";
const resource = MCP_URL.replace(/\/$/, "");
const encryptionKey = () => createHmac("sha256", process.env.SESSION_SECRET).update("create-here-oauth").digest();

function encrypt(token) {
  const nonce = randomBytes(12), cipher = createCipheriv("aes-256-gcm", encryptionKey(), nonce);
  const bytes = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  return Buffer.concat([nonce, cipher.getAuthTag(), bytes]).toString("base64url");
}

function decrypt(value) {
  const bytes = Buffer.from(value, "base64url"), cipher = createDecipheriv("aes-256-gcm", encryptionKey(), bytes.subarray(0, 12));
  cipher.setAuthTag(bytes.subarray(12, 28));
  return Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString("utf8");
}

export async function accountFor(sid) {
  const account = await get("account", sid);
  if (!account) return null;
  try {
    return { id: account.id, email: account.email, credits: account.credits, token: decrypt(account.token) };
  } catch {
    await disconnect(sid);
    throw new HttpError(401, "Please reconnect your Magic Hour account.");
  }
}

export async function verifyAccount(sid, account) {
  try {
    const info = await mcp("get_account_info", {}, account.token);
    if (info.id !== account.id) throw new HttpError(401, "Your Magic Hour account changed.");
    return { ...account, email: info.email, credits: info.credits };
  } catch (error) {
    if ([401, 403].includes(error.upstreamStatus || error.status)) {
      await disconnect(sid);
      throw new HttpError(401, "Please reconnect your Magic Hour account.");
    }
    throw error;
  }
}

async function prepareAuth(sid, origin, popup = false) {
  const redirect = `${origin.replace(/\/$/, "")}/api/auth/callback`;
  const clientKey = createHash("sha256").update(origin).digest("hex");
  let client = await get("oauth-client", clientKey);
  if (!client) {
    const registered = await jsonFetch(`${issuer}/oauth/register`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_name: "create.here", redirect_uris: [redirect], response_types: ["code"], grant_types: ["authorization_code"], token_endpoint_auth_method: "none" })
    });
    if (!registered.client_id) throw new HttpError(502, "Magic Hour could not register this sign-in connection.");
    client = { client_id: registered.client_id };
    await put("oauth-client", clientKey, client);
  }
  const verifier = randomBytes(32).toString("base64url"), state = randomBytes(32).toString("base64url");
  const record = { sid, verifier, redirect, clientId: client.client_id, popup };
  await put("oauth-state", state, record, 600);
  return { state, record };
}

function authorizationUrl(state, record) {
  const url = new URL(`${issuer}/oauth/authorize`);
  url.search = new URLSearchParams({ response_type: "code", client_id: record.clientId, redirect_uri: record.redirect, state,
    code_challenge: createHash("sha256").update(record.verifier).digest("base64url"), code_challenge_method: "S256", resource }).toString();
  return url;
}

export async function startAuth(res, sid, origin, { provider, popup = false, prompt } = {}) {
  const { state, record } = await prepareAuth(sid, origin, popup), url = authorizationUrl(state, record);
  if (provider === "google" || provider === "email") url.searchParams.set("provider", provider);
  if (prompt === "consent") url.searchParams.set("prompt", prompt);
  res.statusCode = 302; res.setHeader("Location", url.href); res.end();
}

async function completeAuth(url, sid) {
  const state = url.searchParams.get("state");
  const record = /^[A-Za-z0-9_-]{43}$/.test(state || "") ? await get("oauth-state", state) : null;
  if (!record || record.sid !== sid || url.searchParams.get("iss") !== issuer) throw new HttpError(400, "This sign-in expired. Please start again.");
  const claimed = await redis("GETDEL", key("oauth-state", state));
  if (!claimed) throw new HttpError(400, "This sign-in was already used. Please start again.");
  if (url.searchParams.has("error")) throw new HttpError(400, "Sign-in was canceled. Your workspace is still here.");
  const code = url.searchParams.get("code");
  if (!code) throw new HttpError(400, "Magic Hour did not return a sign-in code.");
  const token = await jsonFetch(`${issuer}/oauth/token`, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: record.redirect, client_id: record.clientId, code_verifier: record.verifier, resource })
  });
  if (typeof token.access_token !== "string" || !token.access_token) throw new HttpError(502, "Magic Hour did not return an access token.");
  const account = await mcp("get_account_info", {}, token.access_token);
  if (typeof account.id !== "string" || !Number.isFinite(account.credits)) throw new HttpError(502, "Magic Hour could not verify this account.");
  await put("account", sid, { id: account.id, email: account.email, credits: account.credits, token: encrypt(token.access_token) });
  return record;
}

export async function finishAuth(url, res, sid) {
  const record = await completeAuth(url, sid);
  res.statusCode = 302; res.setHeader("Location", record.popup ? "/?auth=complete" : "/"); res.end();
}

async function emailRequest(url, cookies, context, options = {}) {
  const target = new URL(url, issuer);
  if (target.origin !== issuer) throw new HttpError(502, "Magic Hour could not complete sign-in.");
  const headers = { ...options.headers, "User-Agent": context.userAgent, Cookie: Object.entries(cookies).map(([name, value]) => `${name}=${value}`).join("; ") };
  if (target.pathname === "/api/auth/signin/email" || target.pathname === "/api/auth/callback/email") {
    const secret = process.env.CREATE_HERE_EMAIL_AUTH_SECRET;
    if (!secret || secret.length < 32) throw new HttpError(503, "Email sign-in is temporarily unavailable. Please try again shortly.");
    const encoded = Buffer.from(JSON.stringify({ timestamp: Date.now(), ip: context.ip, userAgent: context.userAgent })).toString("base64url");
    const params = options.body instanceof URLSearchParams ? options.body : target.searchParams;
    const message = JSON.stringify([encoded, options.method || "GET", target.pathname, ...["email", "callbackUrl", "csrfToken", "token"].map(name => params.get(name) || "")]);
    headers["x-create-here-email-context"] = encoded;
    headers["x-create-here-email-signature"] = createHmac("sha256", secret).update(message).digest("base64url");
  }
  const response = await fetch(target, { ...options, redirect: "manual", signal: AbortSignal.timeout(22000),
    headers });
  for (const header of response.headers.getSetCookie()) {
    const pair = header.split(";", 1)[0], separator = pair.indexOf("="), name = pair.slice(0, separator);
    if (/^(?:__Host-|__Secure-)?next-auth\.(?:csrf-token|callback-url|session-token)(?:\.\d+)?$/.test(name)) cookies[name] = pair.slice(separator + 1);
  }
  if (response.status === 429) throw new HttpError(429, "Please wait before requesting another code.");
  if (response.status >= 500) throw new HttpError(502, "Magic Hour could not complete sign-in. Please try again.");
  return response;
}

export async function startEmailAuth(sid, origin, value, context) {
  const email = typeof value === "string" ? value.normalize("NFKC").trim().toLowerCase() : "";
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, "Enter a valid email address.");
  await rateLimit(`email-send:${createHash("sha256").update(email).digest("hex")}`, 3);
  const { state, record } = await prepareAuth(sid, origin), callbackUrl = authorizationUrl(state, record);
  callbackUrl.pathname += "/complete";
  const cookies = {}, csrf = await (await emailRequest("/api/auth/csrf", cookies, context)).json();
  if (typeof csrf.csrfToken !== "string" || !csrf.csrfToken) throw new HttpError(502, "Could not prepare sign-in. Try again.");
  // Store only the pre-verification CSRF jar, before the email can be opened in another tab.
  const pendingCookies = Object.fromEntries(Object.entries(cookies).filter(([name]) => !name.includes("session-token")));
  await put("oauth-state", state, { ...record, email, cookies: encrypt(JSON.stringify(pendingCookies)) }, 600);
  const response = await emailRequest("/api/auth/signin/email", cookies, context, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ email, csrfToken: csrf.csrfToken, callbackUrl: callbackUrl.href, json: "true" })
  });
  const result = await response.json(), returned = new URL(result.url, issuer);
  if (returned.origin !== issuer || returned.pathname !== "/api/auth/verify-request" || returned.searchParams.get("provider") !== "email" || returned.searchParams.get("type") !== "email") {
    if (returned.searchParams.get("error") === "AccessDenied") throw new HttpError(400, "This email address is not supported. Try another email or continue with Google.");
    throw new HttpError(502, "Could not send your code. Please try again.");
  }
  return { challenge: state, email };
}

export async function verifyEmailAuth(sid, state, code, context) {
  if (typeof state !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(state) || typeof code !== "string" || !/^\d{6}$/.test(code)) throw new HttpError(400, "Enter the 6-digit code from your email.");
  const record = await get("oauth-state", state);
  if (!record || record.sid !== sid || !record.email || !record.cookies) throw new HttpError(400, "Your code has expired. Send a new code.");
  const attempts = `email-verify:${createHash("sha256").update(record.email).digest("hex")}`;
  await rateLimit(attempts, 5, 600);
  const callbackUrl = authorizationUrl(state, record); callbackUrl.pathname += "/complete";
  const url = new URL(`${issuer}/api/auth/callback/email`);
  url.search = new URLSearchParams({ email: record.email, token: code, callbackUrl: callbackUrl.href }).toString();
  const cookies = JSON.parse(decrypt(record.cookies)), response = await emailRequest(url, cookies, context);
  const location = response.headers.get("location"), returned = location ? new URL(location, issuer) : null;
  if (returned?.searchParams.has("error")) throw new HttpError(400, "That code is invalid or expired. Try again or send a new code.");
  if (!returned || response.status < 300 || response.status >= 400 || returned.origin !== issuer || (returned.href !== callbackUrl.href && !(returned.pathname === "/new-user" && new URL(returned.searchParams.get("callbackUrl") || "/", issuer).href === callbackUrl.href))) throw new HttpError(502, "Magic Hour could not finish sign-in. Please try again.");
  const authorized = await emailRequest(callbackUrl, cookies, context), destination = authorized.headers.get("location");
  const completed = destination ? new URL(destination, issuer) : null;
  if (authorized.status !== 302 || !completed || `${completed.origin}${completed.pathname}` !== record.redirect) throw new HttpError(502, "Could not connect your account. Send a new code and try again.");
  await completeAuth(completed, sid);
}

export function disconnect(sid) {
  return redis("DEL", key("account", sid));
}
