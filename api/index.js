import { randomUUID, createHash } from "node:crypto";
import { missingConfig, HttpError, redis, key, get, put, owned, sessionId, trial, rateLimit, reserve, settle, claimJobs, setJobsDeleted } from "../server/store.js";
import { mcp, planRequest, creation, createText, uploadDocument, uploadImage, migrateImage } from "../server/integrations.js";
import { accountFor, verifyAccount, startAuth, finishAuth, startEmailAuth, verifyEmailAuth, disconnect } from "../server/auth.js";

const signupUrl = "/api/auth/start";
const json = (res, status, value) => { res.statusCode = status; res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(value)); };
const terminal = status => ["complete", "error", "canceled"].includes(status);
const publicJob = job => ({ id: job.id, status: job.status, prompt: job.prompt, kind: job.kind, createdAt: job.createdAt, error: job.error || null, errorCode: job.errorCode || null,
  text: job.text || null, downloads: job.status === "complete" ? (job.downloads || []).map((_, index) => ({ url: `/api/download/${job.id}/${index}` })) : [] });
const publicPlan = plan => ({ id: plan.id, summary: plan.summary, kind: plan.kind, tool: plan.tool, estimatedCredits: plan.estimatedCredits, costLabel: plan.accountId ? (plan.kind === "text" ? "Writing is included. No Magic Hour credits." : `Estimated ${plan.estimatedCredits} Magic Hour credits. Final charge follows Magic Hour’s current pricing.`) : "1 included trial creation", requiresConfirmation: true });
function accountToken(item, account) {
  if (!item.accountId) return undefined;
  if (item.accountId !== account?.id) throw new HttpError(401, "Sign in to the Magic Hour account that created this item.");
  return account.token;
}
async function body(req) {
  if (!(req.headers["content-type"] || "").startsWith("application/json")) throw new HttpError(415, "Send this request as JSON.");
  const length = Number(req.headers["content-length"] || 0);
  if (length > 4200000) throw new HttpError(413, "This upload is too large. Please use a file smaller than 3 MB.");
  if (req.body && typeof req.body === "object") {
    if (Buffer.byteLength(JSON.stringify(req.body)) > 4200000) throw new HttpError(413, "This upload is too large.");
    return req.body;
  }
  if (typeof req.body === "string") { try { return JSON.parse(req.body); } catch { throw new HttpError(400, "The request could not be read."); } }
  let bytes = 0, chunks = [];
  for await (const chunk of req) { bytes += Buffer.byteLength(chunk); if (bytes > 4200000) throw new HttpError(413, "This upload is too large. Please use a document smaller than 3 MB."); chunks.push(Buffer.from(chunk)); }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new HttpError(400, "The request could not be read."); }
}
async function assetsFor(sid, ids = [], jobIds = [], account) {
  if (!Array.isArray(ids) || !Array.isArray(jobIds) || ids.length + jobIds.length > 4) throw new HttpError(400, "Select up to four source items.");
  const assets = await Promise.all([...new Set(ids)].map(id => owned("asset", id, sid)));
  for (const asset of assets) {
    accountToken(asset, account);
    if (account && !asset.accountId && asset.kind === "image" && asset.fileId) {
      const copyId = `${asset.id}:${account.id}`;
      let copy = await get("account-asset", copyId);
      if (!copy) { copy = { filePath: await migrateImage(asset, account.token) }; await put("account-asset", copyId, copy, 86400); }
      asset.filePath = copy.filePath;
    }
  }
  for (const id of [...new Set(jobIds)]) {
    const job = await owned("job", id, sid, account?.id);
    accountToken(job, account);
    if (job.status === "complete" && job.kind === "text" && job.text) { assets.push({ id: job.id, kind: "text", name: job.prompt, text: job.text }); continue; }
    if (job.status !== "complete" || !job.downloads?.length || job.kind !== "image") throw new HttpError(400, "Select a finished image or writing to use as an input.");
    const refreshed = await refresh(job, account);
    if (refreshed.downloads?.[0]?.url) assets.push({ id: job.id, kind: "image", name: job.prompt, filePath: refreshed.downloads[0].url });
  }
  return assets;
}
async function refresh(job, account) {
  const token = accountToken(job, account);
  if (!job.projectId) {
    if (job.status === "submitting" && Date.now() - Date.parse(job.createdAt) > 90000) return settle({ ...job, status: "submission_unknown", error: "Submission could not be confirmed before the connection ended. To avoid duplicate charges, this request will not be submitted again automatically. Please contact support@magichour.ai." });
    return job;
  }
  if (terminal(job.status) && job.status !== "complete") return job;
  const project = await mcp(`get_${job.kind}_project`, { id: job.projectId }, token);
  if (!["draft", "queued", "rendering", "complete", "error", "canceled"].includes(project.status)) throw new HttpError(502, "Magic Hour returned an unknown project status.");
  const downloads = Array.isArray(project.downloads) ? project.downloads.filter(item => typeof item?.url === "string") : [];
  const updated = { ...job, status: project.status, downloads, error: project.error?.message || null };
  return settle(updated);
}
function originFor(req) {
  const scheme = req.headers["x-forwarded-proto"] === "https" || process.env.NODE_ENV === "production" ? "https" : "http";
  return process.env.PUBLIC_APP_URL?.replace(/\/$/, "") || `${scheme}://${req.headers.host}`;
}
async function serveDownload(res, job, index, account) {
  accountToken(job, account);
  if (job.status !== "complete") throw new HttpError(409, "This result is not ready yet.");
  if (job.kind === "text") {
    if (index !== 0) throw new HttpError(404, "Download not found.");
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="create-here.txt"'); res.end(job.text); return;
  }
  const latest = await refresh(job, account), download = latest.downloads?.[index];
  if (!download) throw new HttpError(404, "Download not found.");
  const url = new URL(download.url);
  if (url.protocol !== "https:" || url.hostname !== "videos.magichour.ai" || url.port || url.username || url.password) throw new HttpError(502, "Magic Hour returned an unsupported download address.");
  res.statusCode = 302;
  res.setHeader("Location", download.url);
  res.end();
}
export default async function handler(req, res) {
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  try {
    const url = new URL(req.url, originFor(req));
    const route = req.query?.route || url.searchParams.get("route");
    const path = (route ? "/api/" + (Array.isArray(route) ? route.join("/") : route).replace(/^\/+/, "") : url.pathname).replace(/\/$/, "");
    const missing = missingConfig();
    if (missing.length) {
      if (path === "/api/session") return json(res, 200, { configured: false, missing, trial: { remaining: 0, reserved: false }, account: null, jobs: [] });
      throw new HttpError(503, "Create.here is getting ready. Please come back soon.", { configured: false, missing });
    }
    if (req.method === "POST" && req.headers.origin && req.headers.origin !== originFor(req)) throw new HttpError(403, "This request must come from create.here.");
    const sid = sessionId(req, res);
    if (req.method === "GET" && path === "/api/auth/start") return await startAuth(res, sid, originFor(req), { provider: url.searchParams.get("provider"), popup: url.searchParams.get("popup") === "1", prompt: url.searchParams.get("prompt") });
    if (req.method === "GET" && path === "/api/auth/callback") return await finishAuth(url, res, sid);
    let account = await accountFor(sid);
    if (req.method === "POST") {
      await rateLimit(sid);
      const ip = req.headers["x-forwarded-for"]?.split(",")[0].trim() || req.socket?.remoteAddress || "unknown";
      await rateLimit(createHash("sha256").update(ip).digest("hex"), 60);
      if (path === "/api/auth/email/start" || path === "/api/auth/email/verify") {
        const data = await body(req), context = { ip, userAgent: req.headers["user-agent"] || "" };
        if (path === "/api/auth/email/start") return json(res, 200, await startEmailAuth(sid, originFor(req), data.email, context));
        await verifyEmailAuth(sid, data.challenge, data.code, context); return json(res, 200, { connected: true });
      }
    }
    if (req.method === "GET" && path === "/api/session") {
      if (account) {
        try {
          account = await verifyAccount(sid, account);
        } catch (error) {
          if (error.status === 401) account = null;
          else { account.credits = null; }
        }
      }
      const offset = Number(url.searchParams.get("offset") || 0);
      if (!Number.isSafeInteger(offset) || offset < 0) throw new HttpError(400, "Invalid history page.");
      let ids = await redis("LRANGE", key("jobs", sid), 0, 49) || [];
      let jobs = ids.length ? (await redis("MGET", ...ids.map(id => key("job", id)))).filter(Boolean).map(value => JSON.parse(value)) : [];
      if (account) {
        await claimJobs(sid, account.id, jobs);
        ids = await redis("ZREVRANGE", key("account-jobs", account.id), offset, offset + 50) || [];
        jobs = ids.length ? (await redis("MGET", ...ids.slice(0, 50).map(id => key("job", id)))).filter(Boolean).map(value => JSON.parse(value)) : [];
      }
      jobs = jobs.filter(job => !job.deleted && ((job.ownerAccountId || job.accountId) ? (job.ownerAccountId || job.accountId) === account?.id : job.sid === sid));
      return json(res, 200, { configured: true, trial: await trial(sid, account?.id), account: account ? { connected: true, id: account.id, email: account.email, credits: account.credits } : null, jobs: jobs.map(publicJob), hasMore: Boolean(account && ids.length > 50) });
    }
    if (account && (path.startsWith("/api/jobs/") || path.startsWith("/api/download/"))) account = await verifyAccount(sid, account);
    if (req.method === "POST" && ["/api/jobs/delete", "/api/jobs/restore"].includes(path)) {
      const data = await body(req);
      if (!Array.isArray(data.ids) || !data.ids.length || data.ids.length > 50) throw new HttpError(400, "Select between one and 50 creations.");
      const jobs = await Promise.all([...new Set(data.ids)].map(id => owned("job", id, sid, account?.id, true)));
      await setJobsDeleted(sid, account?.id, jobs, path.endsWith("/delete"));
      return json(res, 200, { ok: true });
    }
    if (req.method === "POST" && path === "/api/auth/logout") { await disconnect(sid); return json(res, 200, { ok: true }); }
    if (req.method === "POST" && path === "/api/uploads") {
      const data = await body(req), extension = String(data.name || "").split(".").at(-1).toLowerCase();
      const types = { jpg: "image", jpeg: "image", png: "image", webp: "image", gif: "image", mp4: "video", mov: "video", webm: "video", mp3: "audio", wav: "audio", m4a: "audio" };
      const kind = types[extension];
      if (!kind || !Number.isFinite(data.size) || data.size <= 0 || data.size > 30000000) throw new HttpError(400, "Choose an image, video or audio file smaller than 30 MB.");
      const uploaded = await mcp("get_upload_urls", { items: [{ type: kind, extension }] }, account?.token), item = uploaded.items?.[0];
      if (!item?.upload_url || !item.file_path) throw new HttpError(502, "Magic Hour could not prepare the upload.");
      const id = randomUUID();
      await put("asset", id, { id, sid, kind, name: String(data.name).slice(0, 180), filePath: item.file_path, ...(account ? { accountId: account.id } : {}) });
      return json(res, 200, { assetId: id, uploadUrl: item.upload_url, method: "PUT", kind });
    }
    if (req.method === "POST" && path === "/api/documents") {
      const data = await body(req), extension = String(data.name || "").split(".").at(-1).toLowerCase();
      const mime = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif", pdf: "application/pdf", doc: "application/msword", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", ppt: "application/vnd.ms-powerpoint", pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation", txt: "text/plain" }[extension];
      if (!mime || typeof data.data !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(data.data)) throw new HttpError(400, "Choose an image, PDF, Word document, PowerPoint or text file.");
      const bytes = Buffer.from(data.data, "base64");
      if (!bytes.length || bytes.length > 3000000) throw new HttpError(413, "Choose an image or document smaller than 3 MB.");
      const image = mime.startsWith("image/"), kind = image ? "image" : "document";
      let filePath;
      if (image) {
        filePath = await uploadImage(extension, mime, bytes, account?.token);
      }
      const file = await uploadDocument(String(data.name).slice(0, 180), mime, bytes, image ? "vision" : "user_data"), id = randomUUID();
      if (!file.id) throw new HttpError(502, "The source file could not be uploaded.");
      await put("asset", id, { id, sid, kind, name: String(data.name).slice(0, 180), fileId: file.id, ...(filePath ? { filePath } : {}), ...(account ? { accountId: account.id } : {}) }, 86400);
      return json(res, 200, { assetId: id, kind, note: image ? "Your image will be used as a visual input." : extension === "pdf" ? "PDF text and page images will inform your request." : "Document text will inform your request; embedded images are not read." });
    }
    if (req.method === "POST" && path === "/api/plan") {
      if (account) account = await verifyAccount(sid, account);
      const data = await body(req), prompt = typeof data.prompt === "string" ? data.prompt.trim() : "";
      if (!prompt || prompt.length > 6000) throw new HttpError(400, "Describe what you want to create in up to 6,000 characters.");
      const allowance = await trial(sid, account?.id);
      if (!account && !allowance.remaining) throw new HttpError(402, "Sign in with Magic Hour to keep creating here.", { signupUrl });
      if (allowance.reserved) throw new HttpError(409, "Your creation is still in progress. Resume it in your workspace.");
      const assets = await assetsFor(sid, data.assetIds, data.selectedJobIds, account);
      const conversationId = account ? `${sid}:${account.id}` : sid;
      const history = await get("conversation", conversationId) || [];
      const result = await planRequest(prompt, assets, history.slice(-6));
      await put("conversation", conversationId, [...history, { request: prompt, response: result.action === "clarify" ? result.question : result.summary }].slice(-6));
      if (result.action === "clarify") return json(res, 200, { clarification: { question: result.question || "What would you like the finished result to look like?" } });
      if (!Array.isArray(result.inputIds) || result.inputIds.some(id => !assets.some(asset => asset.id === id))) throw new HttpError(502, "The agent selected an unavailable source. Please try again.");
      const recipe = creation(result, assets);
      const plan = { ...result, ...recipe, id: randomUUID(), sid, ...(account ? { accountId: account.id } : {}), assetIds: assets.map(asset => asset.id), prompt, generationPrompt: result.prompt };
      await put("plan", plan.id, plan, 1800);
      return json(res, 200, { plan: publicPlan(plan) });
    }
    if (req.method === "POST" && path === "/api/generate") {
      if (account) account = await verifyAccount(sid, account);
      const data = await body(req), plan = await owned("plan", data.planId, sid);
      if ((plan.accountId || null) !== (account?.id || null)) throw new HttpError(409, "Your account changed. Review a new plan before creating.");
      const job = { id: randomUUID(), sid, ...(plan.accountId ? { accountId: plan.accountId, ownerAccountId: plan.accountId } : {}), kind: plan.kind, prompt: plan.prompt, tool: plan.tool, status: "submitting", createdAt: new Date().toISOString(), downloads: [] };
      const [state, id] = await reserve(sid, plan, job);
      if (state === "existing") { const existing = await owned("job", id, sid, account?.id); accountToken(existing, account); return json(res, 200, { job: publicJob(existing) }); }
      if (state === "exhausted") throw new HttpError(402, "Sign in with Magic Hour to keep creating here.", { signupUrl });
      if (state === "busy") { const pending = await owned("job", id, sid, account?.id); accountToken(pending, account); return json(res, 409, { error: "Your other creation is still in progress.", job: publicJob(pending) }); }
      if (state !== "created") throw new HttpError(404, "This plan expired. Please describe your creation again.");
      try {
        if (plan.kind === "text") { job.text = await createText(plan.generationPrompt, plan.assets || []); job.status = "complete"; job.downloads = [{}]; }
        else {
          const result = await mcp(plan.tool, plan.args, account?.token);
          if (!result.id) throw new HttpError(502, "Magic Hour did not return a project ID.");
          job.projectId = result.id; job.status = "queued";
        }
      } catch (error) {
        const rejected = error.definiteRejection || (error.upstreamStatus >= 400 && error.upstreamStatus < 500);
        job.status = rejected ? "error" : "submission_unknown";
        job.errorCode = job.accountId && error.insufficientCredits ? "insufficient_credits" : null;
        job.error = job.errorCode ? "You need more Magic Hour credits for this creation. Get credits, then try again. Your request is still here." : rejected ? (job.accountId ? "Magic Hour rejected this creation. Check your inputs and account access, then try again." : "The service rejected this creation. Your included creation remains available.") : "The connection ended before submission was confirmed. To avoid duplicate charges, this request will not be submitted again automatically. Please contact support@magichour.ai.";
        const saved = await settle(job);
        return json(res, 200, { job: publicJob(saved) });
      }
      return json(res, 200, { job: publicJob(await settle(job)) });
    }
    const jobMatch = path.match(/^\/api\/jobs\/([a-f0-9-]{36})$/);
    if (req.method === "GET" && jobMatch) {
      const job = await owned("job", jobMatch[1], sid, account?.id);
      return json(res, 200, { job: publicJob(await refresh(job, account)) });
    }
    const downloadMatch = path.match(/^\/api\/download\/([a-f0-9-]{36})\/(\d+)$/);
    if (req.method === "GET" && downloadMatch) return await serveDownload(res, await owned("job", downloadMatch[1], sid, account?.id), Number(downloadMatch[2]), account);
    throw new HttpError(404, "This page was not found.");
  } catch (error) {
    if (res.headersSent) { res.end(); return; }
    const message = error instanceof HttpError ? error.message : "The connection could not be completed. Please try again shortly.";
    return json(res, error.status || 503, { error: message, ...(error.extra || {}) });
  }
}
