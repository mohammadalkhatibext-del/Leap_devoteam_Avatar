import { Room, RoomEvent } from "livekit-client";
import { chunkPcm, toBase64 } from "../wav.js";

/**
 * HeyGen LiveAvatar — LITE mode.
 * Video arrives over LiveKit; audio goes out over a separate control websocket.
 *
 *   POST /v1/sessions/token  (X-API-KEY)      -> session_token
 *   POST /v1/sessions/start  (Bearer token)   -> livekit_url, livekit_client_token, ws_url
 *   ws:  {"type":"agent.speak","audio":"<base64 PCM 16-bit 24 kHz>"}
 *
 * Docs: https://docs.liveavatar.com/docs/lite-mode/events
 */
export const heygenAdapter = {
  name: "HeyGen LiveAvatar (LITE)",
  room: null,
  ws: null,
  ready: false,

  async connect(videoElementId, { log }) {
    const res = await fetch("/api/heygen/session", { method: "POST" });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || JSON.stringify(body));

    const data = body.data ?? body;
    const { livekit_url, livekit_client_token, ws_url } = data;
    if (!livekit_url || !ws_url) throw new Error(`unexpected start response: ${JSON.stringify(body)}`);

    // --- video over LiveKit ---
    this.room = new Room();
    const video = document.getElementById(videoElementId);
    this.room.on(RoomEvent.TrackSubscribed, (track) => {
      if (track.kind === "video" || track.kind === "audio") track.attach(video);
      log(`track subscribed: ${track.kind}`);
    });
    await this.room.connect(livekit_url, livekit_client_token);
    log("livekit connected");

    // --- audio out over the control websocket ---
    await new Promise((resolve, reject) => {
      this.ws = new WebSocket(ws_url);
      this.ws.onerror = () => reject(new Error("websocket error"));
      this.ws.onclose = () => { this.ready = false; log("websocket closed"); };
      this.ws.onopen = () => log("websocket open, waiting for connected state…");
      this.ws.onmessage = (ev) => {
        let msg;
        try { msg = JSON.parse(ev.data); } catch { return; }
        // Docs are explicit: wait for state "connected" before sending commands.
        if (msg.state === "connected" && !this.ready) {
          this.ready = true;
          log("session connected");
          resolve();
        }
      };
      setTimeout(() => reject(new Error("timed out waiting for connected state")), 20000);
    });
  },

  async speak(pcm, sampleRate, { log }) {
    if (sampleRate !== 24000) {
      // Hard requirement, not a preference — wrong rate plays at the wrong pitch,
      // which would silently corrupt the lip-sync score.
      throw new Error(`HeyGen LITE requires 24000 Hz; fixture is ${sampleRate} Hz. Re-render with --rate 24000.`);
    }
    if (!this.ready) throw new Error("session not connected");

    // ~500 ms chunks: comfortably under the 1 MB packet cap, near the documented
    // ~1 s recommendation, and small enough to see time-to-first-frame.
    const chunks = chunkPcm(pcm, sampleRate, 500);
    for (const chunk of chunks) {
      this.ws.send(JSON.stringify({ type: "agent.speak", audio: toBase64(chunk) }));
    }
    this.ws.send(JSON.stringify({ type: "agent.speak_end", event_id: crypto.randomUUID() }));
    log(`sent ${chunks.length} chunks`);
  },

  interrupt() {
    this.ws?.send(JSON.stringify({ type: "agent.interrupt" }));
  },

  async disconnect() {
    this.ws?.close();
    await this.room?.disconnect();
    this.ws = null;
    this.room = null;
    this.ready = false;
  },
};
