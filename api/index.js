import { randomUUID, createHash } from "node:crypto";
import { missingConfig, HttpError, redis, key, get, put, owned, sessionId, trial, rateLimit, reserve, settle } from "../server/store.js";
import { mcp, planRequest, creation, createText, uploadDocument } from "../server/integrations.js";

const signupUrl = "https://magichour.ai/sign-up?callbackUrl=%2Fcreate";
const json = (res, status, value) => { res.statusCode = status; res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(value)); };
const terminal = status => ["complete", "error", "canceled"].includes(status);
const publicJob = job => ({ id: job.id, status: job.status, prompt: job.prompt, kind: job.kind, createdAt: job.createdAt, error: job.error || null,
  text: job.text || null, downloads: job.status === "complete" ? (job.downloads || []).map((_, index) => ({ url: `/api/download/${job.id}/${index}` })) : [] });
const publicPlan = plan => ({ id: plan.id, summary: plan.summary, kind: plan.kind, tool: plan.tool, costLabel: "1 included trial creation", requiresConfirmation: true });
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
async function assetsFor(sid, ids = [], jobIds = []) {
  if (!Array.isArray(ids) || !Array.isArray(jobIds) || ids.length + jobIds.length > 4) throw new HttpError(400, "Select up to four source items.");
  const assets = await Promise.all([...new Set(ids)].map(id => owned("asset", id, sid)));
  for (const id of [...new Set(jobIds)]) {
    const job = await owned("job", id, sid);
    if (job.status === "complete" && job.kind === "text" && job.text) { assets.push({ id: job.id, kind: "text", name: job.prompt, text: job.text }); continue; }
    if (job.status !== "complete" || !job.downloads?.length || job.kind !== "image") throw new HttpError(400, "Select a finished image or writing to use as an input.");
    const refreshed = await refresh(job);
    if (refreshed.downloads?.[0]?.url) assets.push({ id: job.id, kind: "image", name: job.prompt, filePath: refreshed.downloads[0].url });
  }
  return assets;
}
async function refresh(job) {
  if (!job.projectId) {
    if (job.status === "submitting" && Date.now() - Date.parse(job.createdAt) > 90000) return settle({ ...job, status: "submission_unknown", error: "Submission could not be confirmed before the connection ended. To avoid duplicate charges, this request will not be submitted again automatically. Please contact support@magichour.ai." });
    return job;
  }
  if (terminal(job.status) && job.status !== "complete") return job;
  const project = await mcp(`get_${job.kind}_project`, { id: job.projectId });
  if (!["draft", "queued", "rendering", "complete", "error", "canceled"].includes(project.status)) throw new HttpError(502, "Magic Hour returned an unknown project status.");
  const downloads = Array.isArray(project.downloads) ? project.downloads.filter(item => typeof item?.url === "string") : [];
  const updated = { ...job, status: project.status, downloads, error: project.error?.message || null };
  if (job.status === "complete") { await put("job", job.id, updated); return updated; }
  return settle(updated);
}
function originFor(req) {
  const scheme = req.headers["x-forwarded-proto"] === "https" || process.env.NODE_ENV === "production" ? "https" : "http";
  return process.env.PUBLIC_APP_URL?.replace(/\/$/, "") || `${scheme}://${req.headers.host}`;
}
async function serveDownload(res, job, index) {
  if (job.status !== "complete") throw new HttpError(409, "This result is not ready yet.");
  if (job.kind === "text") {
    if (index !== 0) throw new HttpError(404, "Download not found.");
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="create-here.txt"'); res.end(job.text); return;
  }
  const latest = await refresh(job), download = latest.downloads?.[index];
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
    if (req.method === "GET" && (path === "/api/auth/start" || path === "/api/auth/callback")) {
      res.statusCode = 302; res.setHeader("Location", path === "/api/auth/start" ? signupUrl : "/"); res.end(); return;
    }
    const missing = missingConfig();
    if (missing.length) {
      if (path === "/api/session") return json(res, 200, { configured: false, missing, trial: { remaining: 0, reserved: false }, account: null, jobs: [] });
      throw new HttpError(503, "Create.here is getting ready. Please come back soon.", { configured: false, missing });
    }
    if (req.method === "POST" && req.headers.origin && req.headers.origin !== originFor(req)) throw new HttpError(403, "This request must come from create.here.");
    const sid = sessionId(req, res);
    if (req.method === "POST") {
      await rateLimit(sid);
      const ip = req.headers["x-forwarded-for"]?.split(",")[0].trim() || req.socket?.remoteAddress || "unknown";
      await rateLimit(createHash("sha256").update(ip).digest("hex"), 60);
    }
    if (req.method === "GET" && path === "/api/session") {
      const ids = await redis("LRANGE", key("jobs", sid), 0, 49), jobs = [];
      for (const id of ids || []) { const job = await get("job", id); if (job?.sid === sid) jobs.push(publicJob(job)); }
      return json(res, 200, { configured: true, trial: await trial(sid), account: null, jobs });
    }
    if (req.method === "POST" && path === "/api/auth/logout") { await redis("DEL", key("account", sid)); return json(res, 200, { ok: true }); }
    if (req.method === "POST" && path === "/api/uploads") {
      const data = await body(req), extension = String(data.name || "").split(".").at(-1).toLowerCase();
      const types = { jpg: "image", jpeg: "image", png: "image", webp: "image", gif: "image", mp4: "video", mov: "video", webm: "video", mp3: "audio", wav: "audio", m4a: "audio" };
      const kind = types[extension];
      if (!kind || !Number.isFinite(data.size) || data.size <= 0 || data.size > 30000000) throw new HttpError(400, "Choose an image, video or audio file smaller than 30 MB.");
      const uploaded = await mcp("get_upload_urls", { items: [{ type: kind, extension }] }), item = uploaded.items?.[0];
      if (!item?.upload_url || !item.file_path) throw new HttpError(502, "Magic Hour could not prepare the upload.");
      const id = randomUUID();
      await put("asset", id, { id, sid, kind, name: String(data.name).slice(0, 180), filePath: item.file_path });
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
        const presigned = await mcp("get_upload_urls", { items: [{ type: "image", extension }] }), item = presigned.items?.[0];
        if (!item?.upload_url || !item.file_path) throw new HttpError(502, "Magic Hour could not prepare your image upload.");
        const uploadUrl = new URL(item.upload_url);
        if (uploadUrl.protocol !== "https:" || uploadUrl.hostname !== "videos.magichour.ai" || uploadUrl.port || uploadUrl.username || uploadUrl.password) throw new HttpError(502, "Magic Hour returned an unsupported upload address.");
        const uploaded = await fetch(uploadUrl, { method: "PUT", headers: { "Content-Type": mime }, body: bytes, redirect: "error", signal: AbortSignal.timeout(22000) });
        if (!uploaded.ok) throw new HttpError(502, "The image could not be uploaded to Magic Hour.");
        filePath = item.file_path;
      }
      const file = await uploadDocument(String(data.name).slice(0, 180), mime, bytes, image ? "vision" : "user_data"), id = randomUUID();
      if (!file.id) throw new HttpError(502, "The source file could not be uploaded.");
      await put("asset", id, { id, sid, kind, name: String(data.name).slice(0, 180), fileId: file.id, ...(filePath ? { filePath } : {}) }, 86400);
      return json(res, 200, { assetId: id, kind, note: image ? "Your image will be used as a visual input." : extension === "pdf" ? "PDF text and page images will inform your request." : "Document text will inform your request; embedded images are not read." });
    }
    if (req.method === "POST" && path === "/api/plan") {
      const data = await body(req), prompt = typeof data.prompt === "string" ? data.prompt.trim() : "";
      if (!prompt || prompt.length > 6000) throw new HttpError(400, "Describe what you want to create in up to 6,000 characters.");
      const allowance = await trial(sid);
      if (!allowance.remaining) throw new HttpError(402, "Your included creation is complete. Continue creating with Magic Hour.", { signupUrl, continueUrl: "https://magichour.ai/create" });
      if (allowance.reserved) throw new HttpError(409, "Your creation is still in progress. Resume it in your workspace.");
      const assets = await assetsFor(sid, data.assetIds, data.selectedJobIds);
      const history = await get("conversation", sid) || [];
      const result = await planRequest(prompt, assets, history.slice(-6));
      await put("conversation", sid, [...history, { request: prompt, response: result.action === "clarify" ? result.question : result.summary }].slice(-6));
      if (result.action === "clarify") return json(res, 200, { clarification: { question: result.question || "What would you like the finished result to look like?" } });
      if (!Array.isArray(result.inputIds) || result.inputIds.some(id => !assets.some(asset => asset.id === id))) throw new HttpError(502, "The agent selected an unavailable source. Please try again.");
      const recipe = creation(result, assets);
      const plan = { ...result, ...recipe, id: randomUUID(), sid, assetIds: assets.map(asset => asset.id), prompt, generationPrompt: result.prompt };
      await put("plan", plan.id, plan, 1800);
      return json(res, 200, { plan: publicPlan(plan) });
    }
    if (req.method === "POST" && path === "/api/generate") {
      const data = await body(req), plan = await owned("plan", data.planId, sid);
      const job = { id: randomUUID(), sid, kind: plan.kind, prompt: plan.prompt, tool: plan.tool, status: "submitting", createdAt: new Date().toISOString(), downloads: [] };
      const [state, id] = await reserve(sid, plan, job);
      if (state === "existing") return json(res, 200, { job: publicJob(await owned("job", id, sid)) });
      if (state === "exhausted") throw new HttpError(402, "Your included creation is complete. Continue with Magic Hour.", { signupUrl, continueUrl: "https://magichour.ai/create" });
      if (state === "busy") return json(res, 409, { error: "Your other creation is still in progress.", job: publicJob(await owned("job", id, sid)) });
      if (state !== "created") throw new HttpError(404, "This plan expired. Please describe your creation again.");
      try {
        if (plan.kind === "text") { job.text = await createText(plan.generationPrompt, plan.assets || []); job.status = "complete"; job.downloads = [{}]; }
        else {
          const result = await mcp(plan.tool, plan.args);
          if (!result.id) throw new HttpError(502, "Magic Hour did not return a project ID.");
          job.projectId = result.id; job.status = "queued";
        }
      } catch (error) {
        const rejected = error.definiteRejection || (error.upstreamStatus >= 400 && error.upstreamStatus < 500);
        job.status = rejected ? "error" : "submission_unknown";
        job.error = rejected ? "The service rejected this creation. Your included creation remains available." : "The connection ended before submission was confirmed. To avoid duplicate charges, this request will not be submitted again automatically. Please contact support@magichour.ai.";
        const saved = await settle(job);
        return json(res, 200, { job: publicJob(saved) });
      }
      return json(res, 200, { job: publicJob(await settle(job)) });
    }
    const jobMatch = path.match(/^\/api\/jobs\/([a-f0-9-]{36})$/);
    if (req.method === "GET" && jobMatch) {
      const job = await owned("job", jobMatch[1], sid);
      return json(res, 200, { job: publicJob(await refresh(job)) });
    }
    const downloadMatch = path.match(/^\/api\/download\/([a-f0-9-]{36})\/(\d+)$/);
    if (req.method === "GET" && downloadMatch) return await serveDownload(res, await owned("job", downloadMatch[1], sid), Number(downloadMatch[2]));
    throw new HttpError(404, "This page was not found.");
  } catch (error) {
    if (res.headersSent) { res.end(); return; }
    const message = error instanceof HttpError ? error.message : "The connection could not be completed. Please try again shortly.";
    return json(res, error.status || 503, { error: message, ...(error.extra || {}) });
  }
}
