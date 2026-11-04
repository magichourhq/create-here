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

After the trial, connect a Magic Hour account using its real OAuth flow. Guest results stay available in the same browser workspace; continued paid creation goes to Magic Hour. This MVP has no separate checkout, invented credit prices, or automatic cross-device workspace transfer. Workspace history and guest sessions are retained for 30 days; media availability follows Magic Hour retention, and uploaded source context expires after 24 hours. Keep `SESSION_SECRET` stable, since changing it invalidates browser sessions and stored account-token encryption.

## Run

Use Node 24. Set the five required environment variables listed in `.env.example` through your secret manager or environment. `SESSION_SECRET` must contain at least 32 random characters. The Magic Hour service key funds the included creations. Keep all credentials server-side and out of Git.

```sh
node --env-file=.env server.mjs
```

The app serves at `http://127.0.0.1:8714`. Without configuration, the UI displays an unavailable state and the API does not pretend to generate content. `PUBLIC_APP_URL` is optional during local development; omit it or use the local origin, so OAuth and same-origin checks use that origin. Never load the production origin value for a local session.

## Vercel release

1. Import this repository as a separate project in the intended Magic Hour team. Set Framework Preset to Other, output directory to `public`, and Node to 24. The supplied configuration serves static assets and routes `/api/*` to the server function.
2. Connect a dedicated Upstash Redis REST database and add the five required secrets separately for the intended environment. Set `PUBLIC_APP_URL` to that environment's exact origin; preview OAuth callbacks need their own origin.
3. Verify an actual creation, upload, failed-generation allowance recovery, reload, download and OAuth flow before approving production. These require live credentials and have not been proved by an unconfigured preview or syntax checks.
4. After release approval, add `create.here` under project Domains. Enter Vercel's exact supplied records at the authoritative DNS provider, then verify DNS and HTTPS. Keep registration at Brandsight.

No production deployment, DNS mutation, paid generation, account connection or storage provisioning is implied by committing this source. No tests, fixtures or mock services are included.
