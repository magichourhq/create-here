import { createHash, createHmac, randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import { HttpError, get, put, redis, key } from "./store.js";
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

export async function startAuth(res, sid, origin, { provider, popup = false } = {}) {
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
  await put("oauth-state", state, { sid, verifier, redirect, clientId: client.client_id, popup }, 600);
  const url = new URL(`${issuer}/oauth/authorize`);
  url.search = new URLSearchParams({ response_type: "code", client_id: client.client_id, redirect_uri: redirect, state,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256", resource }).toString();
  if (provider === "google" || provider === "email") url.searchParams.set("provider", provider);
  res.statusCode = 302; res.setHeader("Location", url.href); res.end();
}

export async function finishAuth(url, res, sid) {
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
  res.statusCode = 302; res.setHeader("Location", record.popup ? "/?auth=complete" : "/"); res.end();
}

export function disconnect(sid) {
  return redis("DEL", key("account", sid));
}
