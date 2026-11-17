# azizan: selected engineering

**azizan** is a mobile app that helps immigrant families keep their mother tongue alive.
Grandparents, parents, aunts and uncles read illustrated children's stories aloud on
video, page by page. The recording goes onto the child's shelf, so the child hears the
story in the voice of someone who loves them while watching that person's face.

It is live as a PWA at [azizan.app](https://azizan.app) and as an Android app built from
the same codebase. The interface and stories are in Persian first.

The full codebase is private: it holds children's data, server keys and the admin
tooling. This repository contains a few real modules copied unchanged from it. I picked
the ones that best show how the product is engineered, and they come with their tests.

| | |
|---|---|
| Built | Sept–Nov 2026, solo, from first commit to a live app tested by real families |
| Size | ~28k lines of TypeScript, ~1,800 commits |
| Tests | 220 test files, ~1,400 test cases. I write a failing test first for every reported bug |
| Stack | React + Vite PWA, Capacitor (Android), Cloudflare Workers, Cloudflare R2 |

---

## The problem behind the architecture

This is a **video app dressed as a storybook**, so almost every architectural decision
follows from video economics and from where the users live.

- **Egress costs more than storage.** A child rewatches grandma's story dozens of
  times. On a provider that charges about $0.09/GB to serve video, that replay traffic is
  what kills a video product. **R2 serves video with zero egress fees**, so it is a
  structural choice, not a vendor preference.
- **Compress when recording, not by transcoding.** `MediaRecorder` records at an explicit
  bitrate (~1.2 Mbps video, 128 kbps Opus audio). Transcoding a million videos on a
  server would be the most expensive feature this product could ever add.
- **The users are on bad connections.** Readers are often 60–75 years old and on mobile
  data in Tehran, Delhi or Lagos. Every upload has to resume where it stopped, and a
  recording must never be lost.
- **No hard dependency on Google.** Google services are blocked in China and unreliable
  in Iran, so the app uses self-hosted fonts and no reCAPTCHA. Push notifications use FCM
  where it works and fall back to background polling where it doesn't.
- **Children's data.** When a family deletes their account, the video objects are
  actually removed from storage. A "deleted" flag in a database row is not enough.

### Shape of the system

```
Phone (PWA / Capacitor Android)
  ├─ records one continuous take per sitting + page marks (second → page)
  ├─ keeps every 1-second slice in IndexedDB until the take is safe
  └─ upload queue (persistent, idempotent, backoff, survives restarts)
          │  resumable 5 MiB parts
          ▼
Cloudflare Worker (stateless API)  ──►  R2 bucket
  • multipart start → parts → complete       • video objects
  • JSON state written compare-and-swap      • JSON documents (no separate database)
    on the object's ETag
```

The stack is deliberately boring: no database server, no microservices and no
transcoding pipeline. It is one modular monolith, and four "seams" (reading source, AI,
storage, entitlement) keep the parts most likely to change behind one interface each.

---

## What is in this repo

### Runnable and tested (`npm test`, `npm run typecheck`)

| Module | What it shows |
|---|---|
| [`apps/worker/src/cas.ts`](apps/worker/src/cas.ts) | **Optimistic concurrency on object storage.** There is no database, so every shared JSON write is compare-and-swap on the R2 ETag with a bounded retry. Without it, two relatives finishing a reading in the same second could erase each other's work. |
| [`apps/web/src/lib/takeJournal.ts`](apps/web/src/lib/takeJournal.ts) | **Crash-safe recording.** Each 1-second `MediaRecorder` slice goes to IndexedDB as it arrives. If Android kills the app mid-story, the take is rebuilt and offered back the next time the app opens. |
| [`apps/web/src/lib/pageMarks.ts`](apps/web/src/lib/pageMarks.ts) | **Page timing.** A sitting is one continuous video, and each page turn (a scroll-snap settle) writes a mark. The player turns the illustrated pages from those marks. |
| [`apps/web/src/lib/updatePlan.ts`](apps/web/src/lib/updatePlan.ts) | **Silent app updates.** The installed app downloads a new web bundle, checks its SHA-256 and swaps it in. It refuses a bundle that needs a newer native shell than the one installed. |
| [`apps/web/src/lib/deleteAll.ts`](apps/web/src/lib/deleteAll.ts) | **Deletion you can prove.** The phone holds the only keys that can delete the family's videos, so it is wiped last, and only after every server confirms the deletion. This module came out of a bug in review: a failed delete used to wipe the phone anyway. |
| [`apps/web/src/lib/captureSize.ts`](apps/web/src/lib/captureSize.ts) | Recording size follows the camera sensor's real aspect ratio instead of cropping a quarter of the frame. |
| [`apps/web/src/domain/ageMode.ts`](apps/web/src/domain/ageMode.ts) | One recording, two playback modes. Under 5, the child sees only the reader's face and the pictures. From 5 up, the text appears too. |

### Excerpts for reading only

These files import modules that stay in the private repo, so they don't compile here.
They are copied unchanged.

| File | What it shows |
|---|---|
| [`apps/worker/src/v2/uploads.ts`](apps/worker/src/v2/uploads.ts) | **Resumable uploads** using R2 multipart: `start → parts → complete`. The server remembers which parts have arrived, so a phone that lost its connection, or was closed, sends only what is missing. |
| [`apps/web/src/lib/uploadQueue.ts`](apps/web/src/lib/uploadQueue.ts) | **The upload queue.** It stores small metadata only (the video bytes stay in IndexedDB), deduplicates by video id, and retries with backoff (5s → 15m, forever). It survives force-quits, and an item is removed only after the server confirms it. |
| [`apps/web/src/lib/recorder.ts`](apps/web/src/lib/recorder.ts) | **The recorder.** It sets the bitrate at capture, detects webm (Android) vs mp4 (iOS) support, only works over HTTPS, and draws face filters with WebGL. |

---

## How I work

- **Tests first.** Every bug report becomes a failing test before the fix. Each release
  goes through tests, then a check in a real browser, then a release gate that verifies
  the bundle before phones can download it.
- **Decisions are written down, including reversals.** The private repo keeps a decision
  log of about 1,500 lines. It records what we chose, what we later reversed, and why.
  Some examples:
  - *AI narration → deferred indefinitely.* The product is the real voice of a known
    person. A synthetic voice would make it a different product.
  - *One clip per page → one continuous take per sitting, with page marks.* Separate
    clips per page made playback choppy. The page is still the unit of the story, but
    the sitting is now the unit of the video.
  - *A single upload per sitting → resumable multipart.* A long reading on a weak
    connection kept breaking near the end and restarting from zero.
- **Every change traces back to a reason.** Comments like `(owner, 2026-10-30: «…»)` in the
  code quote the product feedback (often a real user's words, in Persian) that caused the change.
- **Measure before optimising.** Bitrates and costs come from recordings on real phones,
  not from guesses.
- **AI-assisted, human-directed.** I build with Claude Code as a pair programmer. The
  product decisions, architecture, constraints and reviews are mine. The AI writes a lot
  of the code, under rules I set: tests first, small commits, and every decision logged.

## Running it

```bash
npm install
npm test          # 81 tests
npm run typecheck
```

---

© azizan. All rights reserved. Shown for review; this code is not open source.
