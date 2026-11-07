# Create.here

A standalone MVP from [PD-183](https://linear.app/magic-hour/issue/PD-183/createhere-define-the-platform-concept-initial-use-cases-and-access). Uses Oleg's supplied editable frontend export (`668ab66cedae7751b164d2ef98bbbc50f229fb7a`, October 20, 2026), with server-side planning and Magic Hour's hosted MCP for generation. No framework build or npm dependencies.

Describe an outcome or choose a starter, attach source materials, review the proposed creation, then confirm. The workspace shows real queued/rendering states and the finished output. It restores creations from a signed browser session after refresh. Desktop retains the canvas; mobile uses the supplied grid.

## Included workflows

- One 640px image, including edits using up to four source images.
- One 5-second 480p video, optionally from a starting image. Spoken video needs a prepared image and script.
- A 15-second instrumental.
- Finished scripts, copy and briefs, previewable and downloadable as text.
- Images and source documents (PDF, Word, PowerPoint, text) up to 3 MB each. Word/PowerPoint inputs use extracted text; embedded images are not read. Media uploads are limited to 20 MB in the client. Existing audio/video transformation and arbitrary video/audio compositing are outside this MVP; the agent asks instead of silently omitting requested work.

The first successful creation is included without sign-up. A Redis transaction reserves the allowance before submission and consumes it only on success. Terminal failure releases it. An uncertain submission stays reserved and is never submitted again automatically. Reopening the same plan returns the same job. Cookies plus server-side session/IP throttles limit casual guest reuse; clearing cookies can create a new guest identity. Configure the service account's funded allowance before public access.

After the trial, sign in or create a Magic Hour account through the existing OAuth flow. The sign-in tab returns to create.here; the original workspace also refreshes its connection when focused. New media uses the connected account's token and credits. Signed-in creations are saved to the account and load across browsers, in pages of 50. Signing in claims that browser's unclaimed guest creations once. Their original generation credentials stay unchanged. Signing out hides account-owned creations; signing in to another account cannot claim them again. Unclaimed guest creations remain browser-specific with the existing 30-day retention. Account-owned creation records do not expire; media downloads still depend on the underlying Magic Hour project remaining available. Delete and Undo update the saved Create.here library without deleting the underlying Magic Hour project.

Planning and writing remain funded by the app's OpenAI key. Signed-in writing uses no Magic Hour credits and retains the existing request limits. Media plans show estimates for the fixed recipes: 5 credits per image/edit, 120 for a five-second LTX video, 240 for spoken video, and 15 for fifteen-second music. These are estimates from Magic Hour pricing at core commit `c4c1b7c`, not live quotes; final charges follow Magic Hour's pricing and video reconciliation. Update these estimates when the recipes or pricing change.

The creation plan shows the connected account's balance beside the estimate. Get credits opens Magic Hour's existing credit-pack page in a separate tab and preserves the request here. Returning refreshes the balance; Refresh balance is also available. Purchases must use the displayed Magic Hour account. Only an explicit upstream credit rejection is described as insufficient credits; estimates do not block submission. Retrying a rejected creation prepares a new plan rather than resubmitting its existing job.

Guest source images uploaded before sign-in are copied into the connected account's upload storage using the original OpenAI file. The original guest record is preserved. Generated guest images use freshly authorized signed output URLs as inputs. Guest and account-funded plans retain atomic submission idempotency; account changes require a new plan, and signed-in errors never retry with the guest key.

Guest sessions are retained for 30 days; media availability follows Magic Hour retention, and uploaded source context expires after 24 hours. Signed-in result history is shared across devices. Draft prompts and uploaded source context stay in their current browser session. There is no separate checkout. Keep `SESSION_SECRET` stable: it signs browser sessions and encrypts stored account tokens. API keys issued by Magic Hour OAuth have no refresh-token contract and can be revoked in Magic Hour's Developer Hub.

## Run

Use Node 24. Set the five required environment variables listed in `.env.example` through your secret manager or environment. `SESSION_SECRET` must contain at least 32 random characters. The Magic Hour service key funds the included creations. Keep all credentials server-side and out of Git.

```sh
node --env-file=.env server.mjs
```

The app serves at `http://127.0.0.1:8714`. Without configuration, the UI displays an unavailable state and the API does not pretend to generate content. `PUBLIC_APP_URL` is optional during local development; omit it or use the local origin for same-origin checks. Never load the production origin value for a local session.

## Vercel release

1. Import this repository as a separate project in the intended Magic Hour team. Set Framework Preset to Other, output directory to `public`, and Node to 24. The supplied configuration serves static assets and routes `/api/*` to the server function.
2. Connect a dedicated Upstash Redis REST database and add the five required secrets separately for the intended environment. Set `PUBLIC_APP_URL` to that environment's exact origin. The exact production callback origins must be allowed by Magic Hour OAuth. Core web-app PR #19364 adds create.here and create-here.vercel.app; its production deployment is required before releasing this connection flow. Arbitrary preview origins are not allowed.
3. Verify an actual creation, upload, failed-generation allowance recovery, reload, download and account signup/sign-in return, personal-credit generation, guest-source reuse, logout/reconnect and account switching before approving production. Generation checks require live credentials and have not been proved by an unconfigured preview or syntax checks.
4. After release approval, add `create.here` under project Domains. Enter Vercel's exact supplied records at the authoritative DNS provider, then verify DNS and HTTPS. Keep registration at Brandsight.

No production deployment, DNS mutation, paid generation, signup or storage provisioning is implied by committing this source. No tests, fixtures or mock services are included.
