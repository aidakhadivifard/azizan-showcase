// The recording primitive. One clip per page.
//
// Engineering rules encoded here (CLAUDE.md / docs/02-architecture.md):
//  - Compress AT CAPTURE, never transcode on the server: explicit videoBitsPerSecond.
//  - Never assume a format: feature-detect webm (Android) vs mp4 (iOS).
//  - HTTPS only: getUserMedia silently dies otherwise.

import { needsFreshCamera, releaseAllCameras, trackCamera, untrackCamera } from "./cameraResume.js";
import { diag } from "./diag.js";
import { captureHeight } from "./captureSize.js";
import { rememberCamera, rememberedCamera, videoConstraints } from "./cameraChoice.js";
import { makeFlakes, paintFlakes, stepFlakes, type Flake } from "./fx.js";
import { createGLRenderer, type GLRenderer, type MakeupMode } from "./glFilters.js";
import { cssFilterSteps, type ColorStep } from "./glMath.js";
import { createFaceEngine, captureFaceAvatar, filterDef, frameFit, framer, toneFilterCss, FACE_TONES, type FaceEngine } from "./faceFilters.js";

export type SupportedMime = "video/webm" | "video/mp4";

/** Target capture bitrate for a 640×640 talking head. Phase 0 measures the real
 *  MB/minute (prototype/rec-test) and this is tuned from that number, not guessed. */
export const VIDEO_BITS_PER_SECOND = 1_200_000; // ~1.2 Mbps
// Clear voice: the default MediaRecorder audio bitrate is low and sounds thin/noisy; 128 kbps
// Opus is roomy for a single speaking voice (owner, 2026-10-22). Video is still the big cost.
export const AUDIO_BITS_PER_SECOND = 128_000;
export const CAPTURE_SIZE = 600; // the recording's width
export const CAPTURE_H = 800;     // 3:4 portrait — the camera's whole frame (owner, 2026-10-30: real zoom-out)

export function pickMimeType(): SupportedMime {
  // Order matters: prefer webm where supported, fall back to mp4 (iOS Safari).
  if (typeof MediaRecorder === "undefined") return "video/mp4";
  if (MediaRecorder.isTypeSupported("video/webm")) return "video/webm";
  return "video/mp4";
}

export interface PageRecorder {
  stop(): Promise<{ blob: Blob; mimeType: SupportedMime; durationMs: number }>;
  /** the stream to show in the live preview (filtered, when the beauty filter is on) */
  stream: MediaStream;
  /** a still of the reader framed on their face (for the profile photo), or null */
  captureAvatar(): Promise<Blob | null>;
  /** switch the face filter mid-recording (owner, 2026-10-20: try filters while reading).
   *  "none" or an id from FILTER_DEFS; the new one is baked from the next frame on. */
  setFilter(id: string): void;
}

export interface RecordOptions {
  /** subtle "ملیح" beauty filter, baked into the recording (default on) */
  beauty?: boolean;
  /** the selected face filter id (see faceFilters.ts): a sticker (glasses, mustache,
   *  beard, wizard, firefighter, ears, crown) or a tone (bw). Can be changed later with
   *  setFilter(). */
  filter?: string;
}

// A gentle, not-obvious beauty pass drawn per frame: a soft glow over the skin
// (Orton-style), a touch of warmth, a little brightness and saturation. Cheap enough
// for a phone at 640×640. Returns a function that paints one frame. `tone` is an optional
// extra CSS grade (a tone filter) layered into the base draw.
const BEAUTY_BASE = "brightness(1.04) saturate(1.1) contrast(0.97)";
const WARM = 0.16; // the soft-light wash of rgb(255,170,150) over the whole frame

/** The WebGL filters (lib/glFilters) unless this phone was told not to (localStorage azizan.gl = "off"). */
function glWanted(): boolean {
  try { return localStorage.getItem("azizan.gl") !== "off"; } catch { return true; }
}

/** Does the WebGL picture really show the camera? It is compared with the same frame drawn by the 2D canvas:
 *  a WebGL picture that comes out black while the 2D one does not means this phone's WebGL can't be used for
 *  the recording, and the 2D path is kept. A camera that is still dark after a moment is accepted as dark. */
async function glShowsCamera(glr: GLRenderer, ctx: CanvasRenderingContext2D, video: HTMLVideoElement, w: number, h: number): Promise<string> {
  for (let tries = 0; tries < 10; tries++) {
    const vw = video.videoWidth, vh = video.videoHeight;
    if (vw && vh) {
      const fr = frameFit(vw, vh, w, h);
      ctx.drawImage(video, fr.dx, fr.dy, fr.dw, fr.dh);
      const d = ctx.getImageData(Math.floor(w / 2), Math.floor(h / 2), 1, 1).data;
      const ref = d[0]! + d[1]! + d[2]!;
      glr.draw({ video, frame: fr, grade: [], warm: 0, pts: null, makeup: "none", faceTone: null, sticker: null, flakes: null, tMs: performance.now() });
      const [r, g, b] = glr.probe();
      const got = r + g + b;
      if (glr.lost()) return "lost";
      if (ref > 30) return got > 10 ? "ok" : `black ref=${ref}`;
    }
    await new Promise((res) => setTimeout(res, 80));
  }
  return "ok-dark";
}

function beautyPainter(ctx: CanvasRenderingContext2D, video: HTMLVideoElement, size: number) {
  // «یه آرایش محو که خوشگلمون کنه» (owner, 2026-10-29): a bit brighter and warmer, a touch less
  // contrast. The soft-focus itself is done on the FACE only (faceFilters paintMakeup: a blurred copy
  // masked to the face oval) — the old whole-picture glow blurred the eyes, the hair and the filter
  // too, and cost a full-frame blur every frame (owner, 2026-10-30: «کل تصویر نرم و محو است»).
  const beautyBase = BEAUTY_BASE;
  return (tone: string) => {
    const vw = video.videoWidth || size, vh = video.videoHeight || size;
    const H = ctx.canvas.height;
    const { dx, dy, dw, dh } = frameFit(vw, vh, size, H);
    // auto-framing: the frame always covers the canvas (see framer in faceFilters)
    // soft base: slightly brighter, warmer, a hair less contrast + tone
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
    ctx.filter = tone ? `${beautyBase} ${tone}` : beautyBase;
    ctx.drawImage(video, dx, dy, dw, dh);
    // a whisper of warm light over the WHOLE frame (it used to stop at a square — the bottom strip of
    // the 3:4 frame was left out), so skin looks healthy not grey
    ctx.globalCompositeOperation = "soft-light";
    ctx.filter = "none";
    ctx.fillStyle = `rgba(255, 170, 150, ${WARM})`;
    ctx.fillRect(0, 0, size, H);
    ctx.globalCompositeOperation = "source-over";
  };
}

/** A live, filtered camera that is not recording yet — so the reader can try the face
 *  filters before pressing «شروع» (owner, 2026-10-20). `record()` then records this same
 *  stream: no second permission prompt, no camera restart. */
export interface CameraSession {
  stream: MediaStream;
  /** the recording's width ÷ height (1 for a square camera frame, 0.75 for a 3:4 one) */
  aspect: number;
  captureAvatar(): Promise<Blob | null>;
  setFilter(id: string): void;
  /** the reader's zoom-in, 1 (the camera's whole frame) … 1.6 */
  setZoom(z: number): void;
  /** the filters are drawn by WebGL and can show 3D hats (the football) */
  gl3d(): boolean;
  /** where the face is in the camera frame (normalised), or null */
  faceBox(): { x: number; y: number; w: number; h: number } | null;
  /** start recording; stop() resolves with the clip and leaves the camera running. `onChunk` gets every
   *  1-second slice as it arrives (the take journal keeps them on the phone — lib/takeJournal). */
  record(opts?: { onChunk?: (blob: Blob) => void }): { mimeType: SupportedMime; stop(): Promise<{ blob: Blob; mimeType: SupportedMime; durationMs: number }> };
  /** turn the camera and mic off */
  close(): void;
  /** after the app comes back: carry on — a fresh camera track is swapped in underneath when the
   *  old one died or froze, so the preview and a recording in progress continue (lib/cameraResume) */
  resume(): Promise<void>;
}

/** Records one page. The caller stops it on the scroll-settle event that turns the
 *  page — that same event writes the page timestamp. stop() also turns the camera off. */
export async function recordPage(opts: RecordOptions = {}): Promise<PageRecorder> {
  const cam = await openCamera(opts);
  const rec = cam.record();
  return {
    stream: cam.stream,
    captureAvatar: cam.captureAvatar,
    setFilter: cam.setFilter,
    stop: async () => {
      const out = await rec.stop();
      cam.close();
      return out;
    },
  };
}

// a BIGGER frame than we draw: on many phones the small 4:3 mode is a crop of the sensor, and asking for
// more pixels gives a WIDER view — the only zoom-out the browser allows (owner, 2026-10-30: «زوم رو چطور
// می‌شه درست کرد؟»). We still paint a 720-px square; the extra pixels only buy field of view.
// aspectRatio is asked for on purpose: without it the owner's phone delivered a LANDSCAPE 1920×1440
// frame (the middle band of the sensor — no room above the head); 3:4 portrait is the whole sensor
const VIDEO_CONSTRAINTS: MediaTrackConstraints = { width: { ideal: 1440 }, height: { ideal: 1920 }, aspectRatio: { ideal: 0.75 }, facingMode: "user" };

export async function openCamera(opts: RecordOptions = {}): Promise<CameraSession> {
  framer.reset();
  // one camera at a time: anything left open (a screen closed mid-open) would block this one
  releaseAllCameras();
  if (!window.isSecureContext) {
    throw new Error("insecure_context"); // getUserMedia needs HTTPS
  }
  // the same clean-up WhatsApp/Zoom lean on, so a voice in a normal room comes through clear:
  // kill the background hum (noiseSuppression), the room echo (echoCancellation), and even out
  // a quiet vs loud voice (autoGainControl). Mono — one speaker (owner, 2026-10-22).
  const audio: MediaTrackConstraints = { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 };
  // the camera is asked for in steps, never refused outright: the full wish (portrait 3:4, a
  // remembered camera) first, then the plain front camera at any size. On 2026-10-30 the wish alone
  // left the owner with a black frame («چیزی نشون نمی‌ده»); recording must never depend on a constraint.
  const wishes: MediaTrackConstraints[] = [
    // first: the same wish with resizeMode "none" — the browser must hand over the camera's NATIVE frame,
    // not a frame it cropped/scaled to fit our numbers. The owner's phone kept giving a LANDSCAPE 1920×1440
    // (no room above the head) whatever portrait size was asked; if that is the browser's own crop, this is
    // the one constraint that stops it (owner, 2026-10-30: «کلاه فوتبال هنوز نمیاد» — it sits above the frame)
    { ...videoConstraints(VIDEO_CONSTRAINTS, rememberedCamera()), resizeMode: "none" } as MediaTrackConstraints,
    videoConstraints(VIDEO_CONSTRAINTS, rememberedCamera()),
    { width: { ideal: 1440 }, height: { ideal: 1920 }, facingMode: "user" },
    { facingMode: "user" },
    true as unknown as MediaTrackConstraints,
  ];
  let stream: MediaStream | null = null;
  let lastErr: unknown = null;
  for (const video of wishes) {
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio, video });
      break;
    } catch (e) {
      lastErr = e;
      diag("camerr", `${(e as { name?: string })?.name ?? "?"} ${JSON.stringify(video).slice(0, 80)}`);
      rememberCamera(null); // a remembered camera that fails is forgotten
    }
  }
  if (!stream) throw lastErr instanceof Error ? lastErr : new Error("camera");
  trackCamera(stream);
  try { diag("camsel", `${rememberedCamera() ? "picked" : "default"} ${stream.getVideoTracks()[0]?.label?.slice(0, 40) ?? ""}`); } catch { /* test doubles */ }
  // Zoom out as far as the camera allows (owner, 2026-10-29: the face filled the circle and the
  // ears were cut off; WhatsApp sits further back). Not every phone exposes zoom — then nothing changes.
  try {
    const vt = stream.getVideoTracks()[0];
    const caps = vt?.getCapabilities?.() as { zoom?: { min?: number; max?: number } } | undefined;
    if (vt && caps?.zoom && typeof caps.zoom.min === "number") await vt.applyConstraints({ advanced: [{ zoom: caps.zoom.min } as MediaTrackConstraintSet] });
    // what this phone offers (read in the panel report → «گوشی‌ها»): zoom range, or none
    const st = vt?.getSettings?.() as { zoom?: number } | undefined;
    diag("zoom", caps?.zoom ? `${caps.zoom.min}-${caps.zoom.max}@${st?.zoom ?? "?"}` : "none");
  } catch { /* fine */ }
  // Build the stream to record. With the beauty filter on, we draw the camera onto a
  // canvas each frame and record the canvas (plus the real audio). If anything in the
  // pipeline is missing (older WebView, tests), fall back to the raw camera — recording
  // must never break for a beauty filter.
  const beauty = opts.beauty !== false;
  // the live filter — changed by setFilter() while recording, read on every frame
  let current = opts.filter ? filterDef(opts.filter) : undefined;
  // We need the canvas pipeline whenever there's a beauty pass or a filter. A filter can be
  // picked mid-recording, so with beauty off but no filter yet we still can't switch later —
  // beauty is on by default, so in practice the canvas path always runs.
  const needCanvas = beauty || current !== undefined;
  let recordStream = stream;
  let cleanupFilter: (() => void) | null = null;
  // kept so we can frame the profile photo on the reader's face (faceBox) from the RAW video
  let rawVideo: HTMLVideoElement | null = null;
  let engine: FaceEngine | null = null;
  let captureH = CAPTURE_H;
  let glr: GLRenderer | null = null;
  if (needCanvas) {
    try {
      const canvas = document.createElement("canvas");
      canvas.width = CAPTURE_SIZE;
      canvas.height = CAPTURE_H;
      const ctx = canvas.getContext("2d");
      const video = document.createElement("video");
      video.muted = true;
      video.playsInline = true;
      video.srcObject = stream;
      if (ctx && typeof canvas.captureStream === "function") {
        await video.play();
        rawVideo = video;
        // the recording's shape follows the camera's frame (lib/captureSize): a square sensor → a square
        // recording — nothing of the camera's view is thrown away (owner, 2026-10-30: «وبش رو بهتر کنیم»)
        captureH = captureHeight(video.videoWidth, video.videoHeight);
        canvas.height = captureH;
        // what the front camera really gives (owner, 2026-10-30: «حس زوم‌اوت نمی‌ده») — the widest view we can
        // show is bounded by this frame, so it is reported once per opening to decide the framing numbers
        {
          // the frame we get vs what the track says it is (size, aspect, resizeMode) and how the phone is held:
          // tells a browser-side crop apart from the sensor's own shape
          const st = (stream.getVideoTracks()[0]?.getSettings?.() ?? {}) as { width?: number; height?: number; resizeMode?: string; aspectRatio?: number };
          const orient = (typeof screen !== "undefined" && (screen as { orientation?: { type?: string } }).orientation?.type) || "";
          diag("cam", `${video.videoWidth}x${video.videoHeight} track=${st.width ?? "?"}x${st.height ?? "?"} resize=${st.resizeMode ?? "?"} ${orient}`);
        }
        // how many front cameras this phone offers (a second one is usually the wide lens)
        void navigator.mediaDevices.enumerateDevices().then((ds) => { const fronts = ds.filter((d) => d.kind === "videoinput" && /front|facing|user/i.test(d.label)); diag("cams", `${ds.filter((d) => d.kind === "videoinput").length} video, ${fronts.length} front: ${fronts.map((d) => d.label).join("|").slice(0, 80)}`); }).catch(() => {});
        const paint = beautyPainter(ctx, video, CAPTURE_SIZE);
        // the WebGL filters when this phone draws them; the 2D canvas otherwise (and on any doubt)
        if (glWanted()) {
          try {
            const r = createGLRenderer(CAPTURE_SIZE, captureH);
            const verdict = r ? await glShowsCamera(r, ctx, video, CAPTURE_SIZE, captureH) : "none";
            diag("gl", verdict);
            if (r && verdict.startsWith("ok")) glr = r;
            else r?.stop();
          } catch (e) {
            diag("gl", `error ${String(e).slice(0, 80)}`);
            glr = null;
          }
        }
        const steps = new Map<string, ColorStep[]>();
        const stepsFor = (css: string) => { let v = steps.get(css); if (!v) { v = cssFilterSteps(css); steps.set(css, v); } return v; };
        let lostReported = false;
        // Load the face engine in the background — stickers appear once the model is ready;
        // recording never waits on it (CLAUDE.md: recording must never break for a filter).
        // It always runs (rarely when no sticker is on) so we also get a face box to frame
        // the profile photo on the whole face, not just the forehead.
        let stopped = false;
        void createFaceEngine(video).then((e) => { if (stopped) e.stop(); else engine = e; });
        let raf = 0;
        let lastFrame = -1;
        let flakes: Flake[] | null = null;
        let lastFx = 0;
        let lastPaint = 0;
        let lastDetect = 0;
        const loop = () => {
          raf = requestAnimationFrame(loop);
          // the off-screen camera video gets PAUSED when the app is backgrounded; if it stays
          // paused the canvas (and so the preview) freezes on the last frame. Nudge it back to
          // playing every frame — a no-op while it's already playing (owner, 2026-10-24: «دوربین
          // فریز شد و دیگه تکون نخورد»).
          if (video.paused) void video.play().catch(() => {});
          // only work when the camera has a NEW frame, so detection and drawing use the same
          // one. Safety net: a WebView whose currentTime never moves still paints at ~15fps.
          const now = performance.now();
          if (video.currentTime === lastFrame && now - lastPaint < 66) return;
          lastFrame = video.currentTime;
          lastPaint = now;
          const sticker = current?.kind === "sticker" ? current.id : null;
          // the face is tracked every frame now: the makeup (and the stickers) sit on it
          if (engine && (sticker || beauty || current?.kind === "tone" || now - lastDetect > 160)) { engine.detect(now); lastDetect = now; }
          // the frame is chosen for the face AND the sticker on it (a tall hat → zoom out, face lower)
          framer.update(engine?.faceBox() ?? null, video.videoWidth, video.videoHeight, CAPTURE_SIZE, captureH, sticker ? engine?.room(sticker) ?? null : null);
          const glam = current?.id === "glam";
          const faceTone = current?.kind === "tone" && (FACE_TONES.has(current.id) || glam) ? current.id : null;
          if (current?.kind === "fx") { flakes ??= makeFlakes(90, captureH); stepFlakes(flakes, Math.min(50, now - (lastFx || now)), captureH); lastFx = now; } else { flakes = null; }
          if (glr) {
            if (glr.lost()) { if (!lostReported) { lostReported = true; diag("gl", "context lost"); } return; }
            const tone = current?.kind === "tone" && !faceTone ? toneFilterCss(current.id) : "";
            const makeup: MakeupMode = glam ? "glam" : beauty && (current?.kind !== "tone" || faceTone) ? "soft" : "none";
            const toneSteps = faceTone && !glam ? stepsFor(toneFilterCss(faceTone)) : null;
            const pose = sticker && engine ? engine.stickerPose(CAPTURE_SIZE, captureH, sticker, glr.can3d()) : null;
            glr.draw({
              video,
              frame: frameFit(video.videoWidth, video.videoHeight, CAPTURE_SIZE, captureH),
              grade: stepsFor(tone ? `${BEAUTY_BASE} ${tone}` : BEAUTY_BASE),
              warm: WARM,
              pts: engine && (makeup !== "none" || toneSteps) ? engine.points(CAPTURE_SIZE, captureH) : null,
              makeup,
              faceTone: toneSteps,
              sticker: pose && sticker ? { id: sticker, pose } : null,
              flakes,
              tMs: now,
            });
            return;
          }
          paint(current?.kind === "tone" && !faceTone ? toneFilterCss(current.id) : "");
          if (glam) engine?.paintGlam(ctx, CAPTURE_SIZE);
          else if (beauty && (current?.kind !== "tone" || faceTone)) engine?.paintMakeup(ctx, CAPTURE_SIZE);
          if (faceTone && !glam) engine?.paintFaceTone(ctx, CAPTURE_SIZE, toneFilterCss(faceTone));
          if (sticker) engine?.paintSticker(ctx, CAPTURE_SIZE, sticker);
          // full-frame effects, on top of everything, no face needed
          if (flakes) paintFlakes(ctx, flakes);
        };
        loop();
        const canvasStream = (glr ? glr.canvas : canvas).captureStream(30);
        const audio = stream.getAudioTracks()[0];
        if (audio) canvasStream.addTrack(audio);
        recordStream = canvasStream;
        cleanupFilter = () => { stopped = true; cancelAnimationFrame(raf); engine?.stop(); glr?.stop(); video.pause(); video.srcObject = null; };
      }
    } catch {
      recordStream = stream; // any failure → record the raw camera
    }
  }

  // Frame the profile photo on the reader's face. Uses the raw camera (no sticker baked in)
  // and the face box when available; otherwise a centred square.
  const captureAvatar = async (): Promise<Blob | null> => {
    try {
      // the best calm, whole-face frame seen since the camera opened — not whatever frame is showing now,
      // which is usually mid-word (owner, 2026-10-31: «حین حرف زدن نباشه»)
      const best = engine?.bestPortrait();
      if (best) {
        const blob = await new Promise<Blob | null>((res) => best.toBlob(res, "image/jpeg", 0.9));
        if (blob) return blob;
      }
      let v = rawVideo;
      if (!v) { // no canvas path — read a frame straight off the camera stream
        v = document.createElement("video");
        v.muted = true; v.playsInline = true; v.srcObject = stream;
        await v.play();
      }
      return await captureFaceAvatar(v, engine?.faceBox() ?? null);
    } catch {
      return null;
    }
  };

  const record = (ropts: { onChunk?: (blob: Blob) => void } = {}) => {
    const mimeType = pickMimeType();
    const rec = new MediaRecorder(recordStream, {
      mimeType,
      videoBitsPerSecond: VIDEO_BITS_PER_SECOND,
      audioBitsPerSecond: AUDIO_BITS_PER_SECOND,
    });
    const chunks: Blob[] = [];
    const startedAt = performance.now();
    // does the recording carry a live microphone? (owner, 2026-10-30: a reading played back without sound —
    // this tells a silent recording apart from a phone that would not play the sound)
    try {
      const a = recordStream.getAudioTracks();
      diag("rec", `${mimeType} audio=${a.length}${a[0] ? ` ${a[0].readyState}${a[0].muted ? " muted" : ""}${a[0].enabled ? "" : " disabled"}` : ""} video=${recordStream.getVideoTracks().length}`);
    } catch { /* test doubles */ }
    rec.ondataavailable = (e) => {
      if (e.data.size > 0) {
        chunks.push(e.data);
        // kept on the phone as it arrives, so a killed app does not lose the take; never breaks recording
        try { ropts.onChunk?.(e.data); } catch { /* the journal is a safety net only */ }
      }
    };
    rec.start(1000); // gather in 1s slices — friendlier to a resumable upload
    return {
      mimeType,
      stop: () =>
        new Promise<{ blob: Blob; mimeType: SupportedMime; durationMs: number }>((resolve) => {
          rec.onstop = () =>
            resolve({
              blob: new Blob(chunks, { type: mimeType }),
              mimeType,
              durationMs: Math.round(performance.now() - startedAt),
            });
          rec.stop();
        }),
    };
  };

  let closed = false;
  const resume = async () => {
    if (closed) return;
    const v = rawVideo;
    const old = stream.getVideoTracks()[0];
    // does the camera still deliver frames? watch the picture for a moment
    let framesMoved = false;
    if (v) {
      if (v.paused) await v.play().catch(() => {});
      const t0 = v.currentTime;
      await new Promise((r) => setTimeout(r, 700));
      framesMoved = v.currentTime !== t0;
    } else {
      framesMoved = !!old && old.readyState === "live" && !old.muted;
    }
    if (!needsFreshCamera({ readyState: old?.readyState, muted: !!old?.muted, framesMoved })) return;
    try {
      const fresh = await navigator.mediaDevices.getUserMedia({ video: videoConstraints(VIDEO_CONSTRAINTS, rememberedCamera()) });
      const track = fresh.getVideoTracks()[0];
      if (!track || closed) { fresh.getTracks().forEach((x) => x.stop()); return; }
      if (old) { stream.removeTrack(old); old.stop(); }
      stream.addTrack(track);
      // with the canvas path the recording keeps its own (canvas) track — it just gets frames again
      if (v) { v.srcObject = stream; await v.play().catch(() => {}); }
    } catch { /* camera busy or denied — the screen keeps its last frame */ }
  };
  return {
    stream: recordStream,
    aspect: CAPTURE_SIZE / captureH,
    captureAvatar,
    setFilter: (id: string) => { current = id === "none" ? undefined : filterDef(id); },
    setZoom: (z: number) => framer.setZoom(z),
    gl3d: () => !!glr && glr.can3d() && !glr.lost(),
    faceBox: () => engine?.faceBox() ?? null,
    record,
    resume,
    close: () => {
      if (closed) return;
      closed = true;
      untrackCamera(stream);
      cleanupFilter?.();
      for (const track of stream.getTracks()) track.stop();
      for (const track of recordStream.getTracks()) track.stop();
    },
  };
}
