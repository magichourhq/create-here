import { createHmac, timingSafeEqual, randomUUID } from "node:crypto";
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
export const key = (type, id) => `createhere:${type}:${id}`;
export const get = async (type, id) => { const value = await redis("GET", key(type, id)); return value ? JSON.parse(value) : null; };
export const put = (type, id, value, ttl = 2592000) => redis("SET", key(type, id), JSON.stringify(value), "EX", ttl);
export async function owned(type, id, sid, accountId, includeDeleted = false) {
  if (typeof id !== "string" || !/^[a-f0-9-]{36}$/.test(id)) throw new HttpError(404, "This item was not found in your workspace.");
  const value = await get(type, id);
  const owner = type === "job" && (value?.ownerAccountId || value?.accountId);
  if (!value || (owner ? owner !== accountId : value.sid !== sid) || (!includeDeleted && value.deleted)) throw new HttpError(404, "This item was not found in your workspace.");
  return value;
}
export async function claimJobs(sid, accountId, jobs) {
  if (!jobs.length) return;
  const script = `for _,item in ipairs(cjson.decode(ARGV[3])) do
local jobKey=ARGV[4]..item.id; local raw=redis.call('GET',jobKey)
if raw then local job=cjson.decode(raw)
if job.sid==ARGV[1] and not job.ownerAccountId and (not job.accountId or job.accountId==ARGV[2]) then
 job.ownerAccountId=ARGV[2]; redis.call('SET',jobKey,cjson.encode(job))
 if not job.deleted then redis.call('ZADD',KEYS[1],item.score,item.id) end
end end end; return 1`;
  return redis("EVAL", script, 1, key("account-jobs", accountId), sid, accountId, JSON.stringify(jobs.map(job => ({ id: job.id, score: Date.parse(job.createdAt) || 0 }))), key("job", ""));
}
export async function setJobsDeleted(sid, accountId, jobs, deleted) {
  const script = `local jobs={}
for _,item in ipairs(cjson.decode(ARGV[3])) do
 local raw=redis.call('GET',ARGV[5]..item.id); if not raw then return 'missing' end
 local job=cjson.decode(raw); local owner=job.ownerAccountId or job.accountId
 if (owner and owner~=ARGV[2]) or (not owner and job.sid~=ARGV[1]) then return 'missing' end
 if job.status~='complete' and job.status~='error' and job.status~='canceled' then return 'pending' end
 table.insert(jobs,{job=job,id=item.id,score=item.score})
end
for _,item in ipairs(jobs) do local job=item.job
 job.deleted=ARGV[4]=='1' or nil
 redis.call('SET',ARGV[5]..item.id,cjson.encode(job),'KEEPTTL')
 if job.ownerAccountId or job.accountId then
  if job.deleted then redis.call('ZREM',KEYS[1],item.id) else redis.call('ZADD',KEYS[1],item.score,item.id) end
 end
end; return 'ok'`;
  const result = await redis("EVAL", script, 1, key("account-jobs", accountId || ""), sid, accountId || "", JSON.stringify(jobs.map(job => ({ id: job.id, score: Date.parse(job.createdAt) || 0 }))), deleted ? "1" : "0", key("job", ""));
  if (result !== "ok") throw new HttpError(result === "pending" ? 409 : 404, result === "pending" ? "Wait for this creation to finish before deleting it." : "This creation was not found in your workspace.");
}
export async function rateLimit(sid, limit = 20, seconds = 60) {
  const result = await redis("EVAL", "local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('EXPIRE',KEYS[1],ARGV[1]) end; return n", 1, key("rate", sid), seconds);
  if (result > limit) throw new HttpError(429, `Please wait ${seconds === 60 ? "a minute" : `${Math.ceil(seconds / 60)} minutes`} before trying again.`);
}
export async function trial(sid, accountId) {
  const [used, reserved] = await redis("HMGET", key("session", sid), "used", "reserved");
  const pending = accountId ? await redis("HGET", key("session", `${sid}:${accountId}`), "reserved") : reserved;
  return { remaining: Number(used || 0) >= 1 ? 0 : 1, reserved: Boolean(pending) };
}
export async function reserve(sid, plan, job) {
  const script = `local p=redis.call('GET',KEYS[1]); if not p then return {'missing'} end
local plan=cjson.decode(p); if plan.sid~=ARGV[1] then return {'missing'} end
if plan.jobId then return {'existing',plan.jobId} end
if not plan.accountId and tonumber(redis.call('HGET',KEYS[2],'used') or '0')>=1 then return {'exhausted'} end
local pending=redis.call('HGET',KEYS[2],'reserved'); if pending then return {'busy',pending} end
redis.call('HSET',KEYS[2],'reserved',ARGV[2]); redis.call('EXPIRE',KEYS[2],2592000)
if plan.accountId then redis.call('SET',KEYS[3],ARGV[3]); redis.call('ZADD',KEYS[5],ARGV[4],ARGV[2])
else redis.call('SET',KEYS[3],ARGV[3],'EX',2592000) end
plan.jobId=ARGV[2]; redis.call('SET',KEYS[1],cjson.encode(plan),'EX',2592000)
redis.call('LPUSH',KEYS[4],ARGV[2]); redis.call('LTRIM',KEYS[4],0,49); redis.call('EXPIRE',KEYS[4],2592000)
return {'created',ARGV[2]}`;
  return redis("EVAL", script, 5, key("plan", plan.id), key("session", plan.accountId ? `${sid}:${plan.accountId}` : sid), key("job", job.id), key("jobs", sid), key("account-jobs", plan.accountId || ""), sid, job.id, JSON.stringify(job), Date.parse(job.createdAt));
}
export async function settle(job) {
  const script = `local raw=redis.call('GET',KEYS[1]); if not raw then return nil end
local prior=cjson.decode(raw); local job=cjson.decode(ARGV[1])
if prior.status=='error' or prior.status=='canceled' or (prior.status=='complete' and job.status~='complete') then return raw end
job.sid=prior.sid; job.accountId=prior.accountId; job.ownerAccountId=prior.ownerAccountId; job.deleted=prior.deleted
local updated=cjson.encode(job)
if job.ownerAccountId or job.accountId then redis.call('SET',KEYS[1],updated) else redis.call('SET',KEYS[1],updated,'EX',2592000) end
if job.status=='complete' and not job.accountId then redis.call('HSET',KEYS[2],'used',1) end
if job.status=='complete' or job.status=='error' or job.status=='canceled' then
 if redis.call('HGET',KEYS[2],'reserved')==job.id then redis.call('HDEL',KEYS[2],'reserved') end
end
return updated`;
  const value = await redis("EVAL", script, 2, key("job", job.id), key("session", job.accountId ? `${job.sid}:${job.accountId}` : job.sid), JSON.stringify(job));
  return value ? JSON.parse(value) : job;
}
