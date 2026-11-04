import { createHmac, timingSafeEqual, randomUUID, createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
export const required = ["OPENAI_API_KEY", "MAGIC_HOUR_API_KEY", "SESSION_SECRET", "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN"];
export function missingConfig() {
  const missing = required.filter(name => !process.env[name]);
  if (process.env.SESSION_SECRET && process.env.SESSION_SECRET.length < 32) missing.push("SESSION_SECRET (at least 32 characters)");
  return missing;
}
export class HttpError extends Error {
  constructor(status, message, extra = {}) { super(message); this.status = status; this.extra = extra; }
}
export async function redis(...command) {
  const response = await fetch(process.env.UPSTASH_REDIS_REST_URL, {
    method: "POST", headers: { Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(command), signal: AbortSignal.timeout(10000)
  });
  if (!response.ok) throw new HttpError(503, "Workspace storage is unavailable. Please try again shortly.");
  const data = await response.json();
  if (data.error) throw new HttpError(503, "Workspace storage is unavailable. Please try again shortly.");
  return data.result;
}
const signature = value => createHmac("sha256", process.env.SESSION_SECRET).update(value).digest("base64url");
export function sessionId(req, res) {
  const cookie = (req.headers.cookie || "").split(";").map(part => part.trim()).find(part => part.startsWith("ch_session="))?.slice(11);
  if (cookie) {
    const [id, sig] = cookie.split("."), expected = signature(id || "");
    if (/^[a-f0-9-]{36}$/.test(id || "") && /^[A-Za-z0-9_-]{43}$/.test(sig || "") && sig.length === expected.length && timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return id;
  }
  const id = randomUUID(), secure = process.env.NODE_ENV === "production" || req.headers["x-forwarded-proto"] === "https";
  res.setHeader("Set-Cookie", `ch_session=${id}.${signature(id)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000${secure ? "; Secure" : ""}`);
  return id;
}
const encryptionKey = () => createHmac("sha256", process.env.SESSION_SECRET).update("create-here-oauth").digest();
export function seal(value) {
  const nonce = randomBytes(12), cipher = createCipheriv("aes-256-gcm", encryptionKey(), nonce);
  const bytes = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return Buffer.concat([nonce, cipher.getAuthTag(), bytes]).toString("base64url");
}
export function unseal(value) {
  const bytes = Buffer.from(value, "base64url"), cipher = createDecipheriv("aes-256-gcm", encryptionKey(), bytes.subarray(0, 12));
  cipher.setAuthTag(bytes.subarray(12, 28));
  return Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString("utf8");
}
export const key = (type, id) => `createhere:${type}:${id}`;
export const get = async (type, id) => { const value = await redis("GET", key(type, id)); return value ? JSON.parse(value) : null; };
export const put = (type, id, value, ttl = 2592000) => redis("SET", key(type, id), JSON.stringify(value), "EX", ttl);
export async function owned(type, id, sid) {
  if (typeof id !== "string" || !/^[a-f0-9-]{36}$/.test(id)) throw new HttpError(404, "This item was not found in your workspace.");
  const value = await get(type, id);
  if (!value || value.sid !== sid) throw new HttpError(404, "This item was not found in your workspace.");
  return value;
}
export async function rateLimit(sid, limit = 20) {
  const result = await redis("EVAL", "local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('EXPIRE',KEYS[1],60) end; return n", 1, key("rate", sid));
  if (result > limit) throw new HttpError(429, "Please wait a minute before trying again.");
}
export async function trial(sid) {
  const [used, reserved] = await redis("HMGET", key("session", sid), "used", "reserved");
  return { remaining: Number(used || 0) >= 1 ? 0 : 1, reserved: Boolean(reserved) };
}
export async function reserve(sid, plan, job) {
  const script = `local p=redis.call('GET',KEYS[1]); if not p then return {'missing'} end
local plan=cjson.decode(p); if plan.sid~=ARGV[1] then return {'missing'} end
if plan.jobId then return {'existing',plan.jobId} end
if tonumber(redis.call('HGET',KEYS[2],'used') or '0')>=1 then return {'exhausted'} end
local pending=redis.call('HGET',KEYS[2],'reserved'); if pending then return {'busy',pending} end
redis.call('HSET',KEYS[2],'reserved',ARGV[2]); redis.call('EXPIRE',KEYS[2],2592000)
redis.call('SET',KEYS[3],ARGV[3],'EX',2592000)
plan.jobId=ARGV[2]; redis.call('SET',KEYS[1],cjson.encode(plan),'EX',2592000)
redis.call('LPUSH',KEYS[4],ARGV[2]); redis.call('LTRIM',KEYS[4],0,49); redis.call('EXPIRE',KEYS[4],2592000)
return {'created',ARGV[2]}`;
  return redis("EVAL", script, 4, key("plan", plan.id), key("session", sid), key("job", job.id), key("jobs", sid), sid, job.id, JSON.stringify(job));
}
export async function settle(job) {
  const script = `local raw=redis.call('GET',KEYS[1]); if not raw then return nil end
local prior=cjson.decode(raw); if prior.status=='complete' or prior.status=='error' or prior.status=='canceled' then return raw end
local job=cjson.decode(ARGV[1]); redis.call('SET',KEYS[1],ARGV[1],'EX',2592000)
if job.status=='complete' then redis.call('HSET',KEYS[2],'used',1) end
if job.status=='complete' or job.status=='error' or job.status=='canceled' then
 if redis.call('HGET',KEYS[2],'reserved')==job.id then redis.call('HDEL',KEYS[2],'reserved') end
end
return ARGV[1]`;
  const value = await redis("EVAL", script, 2, key("job", job.id), key("session", job.sid), JSON.stringify(job));
  return value ? JSON.parse(value) : job;
}
