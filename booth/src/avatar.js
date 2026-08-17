/**
 * One adapter per renderer, each loaded only if it is the one selected.
 *
 * Statically importing all three pulled every vendor SDK into the first bundle: 1.25 MB
 * of JavaScript, of which two thirds was for renderers this booth was never going to
 * use in this session. A kiosk downloads that before it can paint, and the show floor
 * is the worst network it will ever see.
 *
 * Written as a map of `() => import(...)` rather than a computed specifier because the
 * bundler has to see each literal path to split it — `import(\`./adapters/${id}.js\`)`
 * would either bundle the whole directory or resolve to nothing at all.
 */
const ADAPTERS = {
  anam: () => import("./adapters/anam.js").then((m) => m.anamAdapter),
  simli: () => import("./adapters/simli.js").then((m) => m.simliAdapter),
  akool: () => import("./adapters/akool.js").then((m) => m.akoolAdapter),
};

/**
 * The one object the booth talks to, whichever renderer is selected.
 *
 * The server decides which vendor to use (from operator settings) and returns the
 * session plus a `mode`. This picks the matching client adapter and exposes a single
 * surface, so `main.js` never branches on vendor — only on `mode`, which is a real
 * behavioural difference: "pcm" renderers speak our Arabic audio, "text" renderers
 * speak their own voice from our text.
 */
export const avatar = {
  impl: null,
  provider: null,
  mode: null,
  sampleRate: null,
  /** True when the vendor charges for the open session, not for speech (Akool). */
  billsBySession: false,
  /** The id the server needs to end a billed session. Null for renderers without one. */
  sessionId: null,

  get client() {
    return this.impl?.client ?? this.impl?.room ?? null;
  },

  async connect(videoElementId, ctx) {
    const res = await fetch("/api/avatar/session", { method: "POST" });
    const session = await res.json();
    if (!res.ok) throw new Error(session.error || JSON.stringify(session));

    const loadAdapter = ADAPTERS[session.provider];
    if (!loadAdapter) throw new Error(`no client adapter for provider "${session.provider}"`);

    // Fetched now, over a connection the page has already opened, while the session
    // token is fresh. On a warm cache this is a no-op; on the first visit of the day it
    // is one chunk instead of three.
    const make = await loadAdapter();
    this.impl = make();
    this.provider = session.provider;
    this.mode = session.mode;
    this.sampleRate = session.sampleRate;
    this.billsBySession = !!session.billsBySession;
    this.sessionId = session.sessionId ?? null;

    ctx.log(`${session.label}: ${session.mode} mode${session.sampleRate ? ` @ ${session.sampleRate} Hz` : ""}`);

    // Announce the provider BEFORE handing off to the adapter, not after.
    //
    // Which vendor is on screen decides how the stage frames the video, and Simli's
    // `start()` does not reliably resolve — it brings up a painting video and then
    // leaves its promise pending. Anything that waited for the line below therefore
    // never ran for Simli, which is precisely why its avatar sat at the wrong crop
    // while Anam's was fine. The provider is known here and nothing about it depends
    // on the connection succeeding.
    ctx.onProvider?.(session.provider);

    await this.impl.connect(videoElementId, session, ctx);
  },

  begin(sampleRate, ctx) {
    this.impl?.begin(sampleRate, ctx);
  },

  /** Feed one synthesised clip (pcm renderers only). */
  push(pcm, ctx) {
    this.impl?.push(pcm, ctx);
  },

  /** Have the renderer speak this text in its own voice (text renderers only). */
  say(text, ctx) {
    this.impl?.say?.(text, ctx);
  },

  end() {
    this.impl?.end();
  },

  interrupt() {
    this.impl?.interrupt();
  },

  /**
   * Drop the stream AND end the session behind it.
   *
   * Leaving the room is not the same as ending the session. For a renderer billed by
   * the open window (Akool) the meter runs until the server tells the vendor to stop,
   * so a disconnect that only tears down WebRTC leaves a paid window running — and
   * the next connect opens another one on top of it. The close is awaited rather than
   * fired and forgotten, because the caller's very next act is usually to reconnect,
   * and overlapping the two is how sessions stack.
   */
  async disconnect() {
    const { provider, sessionId, billsBySession } = this;
    await this.impl?.disconnect();
    this.impl = null;
    this.provider = null;
    this.mode = null;

    if (billsBySession && sessionId) {
      await fetch("/api/avatar/close", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider, sessionId }),
      }).catch(() => {
        // The server also closes any orphan before it opens the next session, so a
        // failure here costs one stale window at worst rather than an unbounded leak.
      });
    }
    this.sessionId = null;
    this.billsBySession = false;
  },
};
