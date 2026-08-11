import { Room, RoomEvent } from "livekit-client";

/**
 * Akool — TEXT mode, and that difference is the whole story.
 *
 * Akool's live avatar has no audio input. You cannot hand it PCM and ask it to
 * lip-sync; you send chat text over the stream and Akool speaks it with its own
 * `voice_id`. So selecting Akool silently replaces the Arabic voice this project
 * ranked in SCORING.md Step 1 with whatever voice the Akool avatar carries.
 *
 * That makes Akool a different experiment, not a third data point in the same one:
 * comparing its lip-sync to Anam's means comparing two different voices at the same
 * time, which is precisely the confound Phase 0 avoided by rendering fixture audio
 * once and feeding identical files to every renderer. The admin page says this in
 * plain language rather than leaving an operator to discover it live.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * PARTLY VERIFIED against a live key on 2026-08-11 (npm run check:akool):
 *
 *   ✓ session/create returns credentials named `livekit_url` and `livekit_token`
 *     — the namespaced spelling this adapter reads, alongside livekit_room_name,
 *     livekit_client_identity and livekit_server_identity.
 *   ✓ session/close is accepted, so a session can be ended on demand.
 *
 *   ✗ STILL UNVERIFIED — the part below connect(): the chat protocol (v: 2,
 *     type "chat") and the interrupt command have never been sent to a live room,
 *     because that needs an actual WebRTC connection rather than an API call. If
 *     the avatar connects and shows video but stays silent, this is where to look:
 *     the message shape follows Akool's docs and nothing more.
 * ─────────────────────────────────────────────────────────────────────────────
 */
export function akoolAdapter() {
  return {
    mode: "text",
    room: null,

    async connect(videoElementId, session, { log }) {
      // Akool namespaces the connection fields by transport: the LiveKit credentials
      // arrive as `livekit_url` / `livekit_token`, not the bare `url` / `token` this
      // adapter originally guessed at. Confirmed against a live session on 2026-08-11.
      // The bare spellings are kept as a fallback purely in case Akool ever flattens
      // the shape — a wrong guess here fails at connect time with an empty room and
      // no useful error, which is why the throw below names the fields it actually got.
      const c = session.credentials ?? {};
      const url = c.livekit_url ?? c.url;
      const token = c.livekit_token ?? c.token;
      if (!url || !token) {
        throw new Error(
          `Akool returned no LiveKit url/token — got fields: ${Object.keys(c).join(", ") || "(none)"}`,
        );
      }

      this.room = new Room();

      // Akool publishes the avatar as a normal WebRTC track pair.
      this.room.on(RoomEvent.TrackSubscribed, (track) => {
        const el = document.getElementById(videoElementId);
        if (track.kind === "video") track.attach(el);
        if (track.kind === "audio") track.attach(document.getElementById("avatar-audio"));
      });
      this.room.on(RoomEvent.Disconnected, () => log("Akool room disconnected"));

      await this.room.connect(url, token);
      log("Akool ready (text mode — Akool's own voice)");
    },

    begin() {
      /* no audio sequence in text mode */
    },

    push() {
      // Guard rather than silently no-op: reaching here means the caller treated a
      // text-mode renderer as a PCM one, and the visitor would get a mute avatar.
      throw new Error("Akool is text mode — send text with say(), not PCM");
    },

    /** Send one sentence for Akool to speak in its own voice. */
    say(text) {
      const payload = {
        v: 2,
        type: "chat",
        mid: `msg-${Date.now()}`,
        idx: 0,
        fin: true,
        pld: { text },
      };
      // Akool's documented protocol is JSON-serialised bytes on the data channel.
      this.room?.localParticipant?.publishData(
        new TextEncoder().encode(JSON.stringify(payload)),
        { reliable: true },
      );
    },

    end() {
      /* nothing to close per utterance */
    },

    interrupt() {
      this.room?.localParticipant?.publishData(
        new TextEncoder().encode(JSON.stringify({ v: 2, type: "command", pld: { cmd: "interrupt" } })),
        { reliable: true },
      );
    },

    async disconnect() {
      await this.room?.disconnect();
      this.room = null;
    },
  };
}
