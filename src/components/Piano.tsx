import { useCallback, useEffect, useLayoutEffect, useState } from "react";
import { flushSync } from "react-dom";
import * as Tone from "tone";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";

const WHITE_KEYS = [
  "C3", "D3", "E3", "F3", "G3", "A3", "B3",
  "C4", "D4", "E4", "F4", "G4", "A4", "B4",
  "C5", "D5", "E5", "F5", "G5", "A5", "B5",
];

const BLACK_KEYS: { note: string; whiteKeyIndex: number }[] = [
  { note: "C#3", whiteKeyIndex: 0 }, { note: "D#3", whiteKeyIndex: 1 },
  { note: "F#3", whiteKeyIndex: 3 }, { note: "G#3", whiteKeyIndex: 4 }, { note: "A#3", whiteKeyIndex: 5 },
  { note: "C#4", whiteKeyIndex: 7 }, { note: "D#4", whiteKeyIndex: 8 },
  { note: "F#4", whiteKeyIndex: 10 }, { note: "G#4", whiteKeyIndex: 11 }, { note: "A#4", whiteKeyIndex: 12 },
  { note: "C#5", whiteKeyIndex: 14 }, { note: "D#5", whiteKeyIndex: 15 },
  { note: "F#5", whiteKeyIndex: 17 }, { note: "G#5", whiteKeyIndex: 18 }, { note: "A#5", whiteKeyIndex: 19 },
];

const ALL_NOTES = new Set<string>([
  ...WHITE_KEYS,
  ...BLACK_KEYS.map((b) => b.note),
]);

function generateSessionId(): string {
  return `session_${Math.random().toString(36).slice(2, 11)}_${Date.now()}`;
}

function getOrCreatePersistedSessionId(): string {
  const k = "pianoSessionId";
  if (typeof sessionStorage === "undefined") {
    return generateSessionId();
  }
  const existing = sessionStorage.getItem(k);
  if (existing !== null && existing.length > 0) {
    return existing;
  }
  const id = generateSessionId();
  sessionStorage.setItem(k, id);
  return id;
}

/** Must match allowlist in convex/piano.ts */
const SESSION_EMOJI_CHOICES = [
  "🎹", "🎵", "🎶", "🎤", "🎧", "🎸", "🎺", "🎻", "🥁", "🎷",
  "🐱", "🐶", "🦊", "🐻", "🐼", "🦁", "🐸", "🦄", "🐝", "🦋",
  "⭐", "🌙", "☀️", "🌈", "🔥", "💧", "🌊", "🍀", "🌸", "🍄",
  "🎮", "🚀", "✨", "💫", "❤️", "💜", "💙", "💚", "🧡", "🤍",
  "🎪", "🎭", "🎨", "🍕", "🍦", "☕", "🌮", "🍎", "🐙", "🦀",
  "👽", "🤖", "💎", "⚡", "🎲", "🏀", "⚽", "🎯", "📌", "🔔",
] as const;

function pickRandomSessionEmoji(): string {
  const i = Math.floor(Math.random() * SESSION_EMOJI_CHOICES.length);
  return SESSION_EMOJI_CHOICES[i] ?? "🎹";
}

/** My emoji only while I’m physically holding (local input). Others from Convex holds. */
function keyEmojiLayers(
  note: string,
  holds: { sessionId: string; note: string }[],
  emojiBySession: Record<string, string>,
  mySessionId: string,
  localCountOnNote: number
): { showMine: boolean; remotes: { sid: string; emoji: string }[] } {
  const showMine = localCountOnNote > 0;
  const remotes: { sid: string; emoji: string }[] = [];
  const seen = new Set<string>();
  for (const h of holds) {
    if (h.note !== note) continue;
    if (sameSession(h.sessionId, mySessionId)) continue;
    if (seen.has(h.sessionId)) continue;
    seen.add(h.sessionId);
    remotes.push({ sid: h.sessionId, emoji: emojiBySession[h.sessionId] ?? "🎹" });
  }
  remotes.sort((a, b) => a.sid.localeCompare(b.sid));
  return { showMine, remotes };
}

function noteFromPoint(clientX: number, clientY: number): string | null {
  const el = document.elementFromPoint(clientX, clientY);
  let e: Element | null = el;
  while (e && e !== document.body) {
    const n = e.getAttribute("data-note");
    if (n !== null && ALL_NOTES.has(n)) return n;
    e = e.parentElement;
  }
  return null;
}

function pointerKey(id: number): string {
  return `p_${id}`;
}

const CODE_TO_NOTE: Record<string, string> = {
  KeyZ: "C3",
  KeyX: "D3",
  KeyA: "E3",
  KeyS: "F3",
  KeyD: "G3",
  KeyF: "A3",
  KeyG: "B3",
  KeyH: "C4",
  KeyJ: "D4",
  KeyK: "E4",
  KeyL: "F4",
  Semicolon: "G4",
  Quote: "A4",
  BracketRight: "B4",
  KeyW: "F#3",
  KeyR: "G#3",
  KeyT: "A#3",
  KeyY: "C#4",
  KeyU: "D#4",
  KeyO: "F#4",
  KeyP: "G#4",
  BracketLeft: "A#4",
};

function keyboardPointerId(code: string): string {
  return `key_${code}`;
}

function isTypingTarget(el: EventTarget | null): boolean {
  if (el === null || !(el instanceof HTMLElement)) return false;
  const t = el.tagName;
  if (t === "INPUT" || t === "TEXTAREA" || t === "SELECT") return true;
  return el.isContentEditable;
}

function sameSession(a: string, b: string): boolean {
  return String(a) === String(b);
}

function remoteNoteCounts(
  holds: { sessionId: string; note: string }[],
  mySession: string
): Map<string, number> {
  const m = new Map<string, number>();
  for (const h of holds) {
    if (sameSession(h.sessionId, mySession)) continue;
    m.set(h.note, (m.get(h.note) ?? 0) + 1);
  }
  return m;
}

function localNoteCounts(pointers: Map<string, string>): Map<string, number> {
  const m = new Map<string, number>();
  for (const note of pointers.values()) {
    m.set(note, (m.get(note) ?? 0) + 1);
  }
  return m;
}

function mergeActiveKeys(
  localByNote: Map<string, number>,
  remote: Map<string, number>
): Set<string> {
  const s = new Set<string>();
  for (const [note, c] of localByNote) {
    if (c > 0) s.add(note);
  }
  for (const [note, c] of remote) {
    if (c > 0) s.add(note);
  }
  return s;
}

function keyboardHoldsPayload(pointers: Map<string, string>) {
  return [...pointers.entries()]
    .filter(([pid]) => pid.startsWith("key_"))
    .map(([pointerId, note]) => ({ pointerId, note }));
}

/** Previous remote note counts for audio diff (survives effect re-runs; reset when synth disposes) */
let pianoLastRemoteCounts: Map<string, number> | undefined;

function makePoly(): Tone.PolySynth<Tone.Synth> {
  return new Tone.PolySynth({
    maxPolyphony: 64,
    voice: Tone.Synth,
    options: {
      oscillator: { type: "triangle" },
      envelope: {
        attack: 0.005,
        decay: 0.1,
        sustain: 0.3,
        release: 0.5,
      },
    },
  }).toDestination();
}

export function Piano() {
  const [sessionId] = useState(() => getOrCreatePersistedSessionId());
  /** pointerId → note (mouse + keyboard) */
  const [localPointers, setLocalPointers] = useState<Map<string, string>>(() => new Map());
  const [synthPair, setSynthPair] = useState<{
    local: Tone.PolySynth<Tone.Synth>;
    remote: Tone.PolySynth<Tone.Synth>;
  } | null>(null);
  const [myEmoji, setMyEmoji] = useState(pickRandomSessionEmoji);
  const [emojiPickerOpen, setEmojiPickerOpen] = useState(false);

  const pressNoteMutation = useMutation(api.piano.pressNote);
  const releasePointerMutation = useMutation(api.piano.releasePointer);
  const moveNoteMutation = useMutation(api.piano.moveNote);
  const syncKeyboardHoldsMutation = useMutation(api.piano.syncKeyboardHolds);
  const setSessionProfileMutation = useMutation(api.piano.setSessionProfile);
  const pianoState = useQuery(api.piano.getPianoState);
  const holds = pianoState?.holds;
  const emojiBySession = pianoState?.emojiBySession ?? {};
  const holdsList = holds ?? [];

  const localCounts = localNoteCounts(localPointers);
  const remoteCounts =
    holds !== undefined ? remoteNoteCounts(holds, sessionId) : new Map<string, number>();
  const activeKeys = mergeActiveKeys(localCounts, remoteCounts);

  useLayoutEffect(() => {
    const local = makePoly();
    const remote = makePoly();
    /* Tone must be created here so Strict Mode’s effect cleanup→re-run replaces disposed synths */
    // eslint-disable-next-line react-hooks/set-state-in-effect -- sync external audio nodes to React tree
    setSynthPair({ local, remote });
    return () => {
      pianoLastRemoteCounts = undefined;
      local.dispose();
      remote.dispose();
    };
  }, []);

  useEffect(() => {
    void setSessionProfileMutation({ sessionId, emoji: myEmoji });
  }, [setSessionProfileMutation, myEmoji, sessionId]);

  useEffect(() => {
    if (!emojiPickerOpen) return;
    const close = () => setEmojiPickerOpen(false);
    const id = requestAnimationFrame(() => {
      document.addEventListener("click", close);
    });
    return () => {
      cancelAnimationFrame(id);
      document.removeEventListener("click", close);
    };
  }, [emojiPickerOpen]);

  /** Remote-only audio: diff remote counts when Convex holds change */
  useEffect(() => {
    if (holds === undefined || synthPair === null) return;
    const remoteSynth = synthPair.remote;
    const counts = remoteNoteCounts(holds, sessionId);
    const prev = pianoLastRemoteCounts;
    if (prev === undefined) {
      pianoLastRemoteCounts = new Map(counts);
      return;
    }
    const allNotes = new Set([...prev.keys(), ...counts.keys()]);
    if (Tone.context.state !== "running") {
      void Tone.start();
    }
    for (const note of allNotes) {
      const a = prev.get(note) ?? 0;
      const b = counts.get(note) ?? 0;
      if (a === 0 && b > 0) {
        remoteSynth.triggerAttack(note, undefined, 0.5);
      } else if (a > 0 && b === 0) {
        remoteSynth.triggerRelease(note);
      }
    }
    pianoLastRemoteCounts = new Map(counts);
  }, [holds, sessionId, synthPair]);

  const syncKeyboardToConvex = useCallback(
    (next: Map<string, string>) => {
      void syncKeyboardHoldsMutation({
        sessionId,
        holds: keyboardHoldsPayload(next),
      }).catch((err: unknown) => {
        console.error("[piano] syncKeyboard failed", err);
        throw err;
      });
    },
    [syncKeyboardHoldsMutation, sessionId]
  );

  useEffect(() => {
    if (synthPair === null) return;
    const { local: localSynth } = synthPair;
    const onMove = (e: PointerEvent) => {
      const pid = pointerKey(e.pointerId);
      setLocalPointers((prev) => {
        const current = prev.get(pid);
        if (current === undefined) return prev;
        const under = noteFromPoint(e.clientX, e.clientY);
        if (under === null) {
          localSynth.triggerRelease(current);
          const next = new Map(prev);
          next.delete(pid);
          void releasePointerMutation({ sessionId, pointerId: pid }).catch((err: unknown) => {
            console.error("[piano] convex release failed", err);
            throw err;
          });
          return next;
        }
        if (under !== current) {
          localSynth.triggerRelease(current);
          localSynth.triggerAttack(under, undefined, 0.7);
          void moveNoteMutation({
            sessionId,
            pointerId: pid,
            fromNote: current,
            toNote: under,
          }).catch((err: unknown) => {
            console.error("[piano] convex move failed", err);
            throw err;
          });
          return new Map(prev).set(pid, under);
        }
        return prev;
      });
    };

    const onUp = (e: PointerEvent) => {
      const pid = pointerKey(e.pointerId);
      setLocalPointers((prev) => {
        if (!prev.has(pid)) return prev;
        const note = prev.get(pid);
        if (note === undefined) return prev;
        localSynth.triggerRelease(note);
        const next = new Map(prev);
        next.delete(pid);
        void releasePointerMutation({ sessionId, pointerId: pid }).catch((err: unknown) => {
          console.error("[piano] convex release failed", err);
          throw err;
        });
        return next;
      });
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [releasePointerMutation, sessionId, moveNoteMutation, synthPair]);

  useEffect(() => {
    if (synthPair === null) return;
    const { local: localSynth } = synthPair;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.repeat) return;
      if (isTypingTarget(e.target)) return;
      const note = CODE_TO_NOTE[e.code];
      if (note === undefined) return;
      e.preventDefault();
      const pid = keyboardPointerId(e.code);
      setLocalPointers((prev) => {
        if (prev.has(pid)) return prev;
        if (Tone.context.state !== "running") {
          void Tone.start();
        }
        localSynth.triggerAttack(note, undefined, 0.7);
        const next = new Map(prev).set(pid, note);
        syncKeyboardToConvex(next);
        return next;
      });
    };

    const onKeyUp = (e: KeyboardEvent) => {
      const note = CODE_TO_NOTE[e.code];
      if (note === undefined) return;
      e.preventDefault();
      const pid = keyboardPointerId(e.code);
      setLocalPointers((prev) => {
        if (!prev.has(pid)) return prev;
        const n = prev.get(pid);
        if (n === undefined) return prev;
        localSynth.triggerRelease(n);
        const next = new Map(prev);
        next.delete(pid);
        syncKeyboardToConvex(next);
        return next;
      });
    };

    const onVisibilityChange = () => {
      if (!document.hidden) return;
      setLocalPointers((prev) => {
        const next = new Map(prev);
        for (const [id, n] of prev) {
          if (!id.startsWith("key_")) continue;
          localSynth.triggerRelease(n);
          next.delete(id);
        }
        if (next.size !== prev.size) {
          syncKeyboardToConvex(next);
        }
        return next;
      });
    };

    const opts = { capture: true };
    window.addEventListener("keydown", onKeyDown, opts);
    window.addEventListener("keyup", onKeyUp, opts);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.removeEventListener("keydown", onKeyDown, opts);
      window.removeEventListener("keyup", onKeyUp, opts);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [sessionId, synthPair, syncKeyboardToConvex]);

  const onPointerDown = useCallback(
    (note: string, e: React.PointerEvent) => {
      e.preventDefault();
      if (synthPair === null) return;
      if (
        document.activeElement instanceof HTMLElement &&
        document.activeElement.closest(".piano")
      ) {
        document.activeElement.blur();
      }
      const pid = pointerKey(e.pointerId);
      const { local: localSynth } = synthPair;
      let began = false;
      flushSync(() => {
        setLocalPointers((prev) => {
          if (prev.has(pid)) return prev;
          began = true;
          return new Map(prev).set(pid, note);
        });
      });
      if (!began) return;
      if (Tone.context.state !== "running") {
        void Tone.start();
      }
      localSynth.triggerAttack(note, undefined, 0.7);
      void pressNoteMutation({ note, sessionId, pointerId: pid }).catch((err: unknown) => {
        console.error("[piano] convex press failed", err);
        throw err;
      });
    },
    [pressNoteMutation, sessionId, synthPair]
  );

  if (synthPair === null) {
    return (
      <div className="piano-container">
        <h1 className="piano-title">Global Piano</h1>
        <p className="piano-subtitle">Loading audio…</p>
      </div>
    );
  }

  return (
    <div className="piano-container">
      <h1 className="piano-title">Global Piano</h1>
      <p className="piano-subtitle">
        Three middle octaves (C3–B5) · Everyone plays the same piano
      </p>

      <div className="piano-session-bar">
        <span className="piano-session-label">You</span>
        <button
          type="button"
          className="piano-session-emoji-btn"
          aria-label={emojiPickerOpen ? "Close emoji picker" : "Choose your emoji"}
          aria-expanded={emojiPickerOpen}
          onClick={(e) => {
            e.stopPropagation();
            setEmojiPickerOpen((o) => !o);
          }}
        >
          {myEmoji}
        </button>
        {emojiPickerOpen ? (
          <div
            className="piano-emoji-picker"
            role="listbox"
            aria-label="Session emoji"
            onClick={(e) => e.stopPropagation()}
          >
            {SESSION_EMOJI_CHOICES.map((em) => (
              <button
                key={em}
                type="button"
                role="option"
                aria-selected={em === myEmoji}
                className={`piano-emoji-option ${em === myEmoji ? "piano-emoji-option-current" : ""}`}
                onClick={() => {
                  setMyEmoji(em);
                  setEmojiPickerOpen(false);
                }}
              >
                {em}
              </button>
            ))}
          </div>
        ) : null}
      </div>

      <div className="piano">
        <div className="piano-keys piano-keys-white">
          {WHITE_KEYS.map((note) => {
            const lc = localCounts.get(note) ?? 0;
            const layers = keyEmojiLayers(
              note,
              holdsList,
              emojiBySession,
              sessionId,
              lc
            );
            const anyEmoji = layers.showMine || layers.remotes.length > 0;
            return (
              <div key={note} className="piano-white-key-cell">
                <div className="piano-key-emojis" aria-hidden={!anyEmoji}>
                  <span className="piano-key-emojis-inner">
                    {layers.showMine ? (
                      <span className="piano-key-emoji piano-key-emoji-mine">{myEmoji}</span>
                    ) : null}
                    {layers.remotes.map((r) => (
                      <span key={r.sid} className="piano-key-emoji">
                        {r.emoji}
                      </span>
                    ))}
                  </span>
                </div>
                <button
                  type="button"
                  data-note={note}
                  className={`piano-key piano-key-white ${activeKeys.has(note) ? "active" : ""}`}
                  onPointerDown={(e) => onPointerDown(note, e)}
                >
                  <span className="piano-key-label">{note}</span>
                </button>
              </div>
            );
          })}
        </div>

        <div className="piano-keys piano-keys-black">
          {BLACK_KEYS.map(({ note, whiteKeyIndex }) => {
            const lc = localCounts.get(note) ?? 0;
            const layers = keyEmojiLayers(
              note,
              holdsList,
              emojiBySession,
              sessionId,
              lc
            );
            const anyEmoji = layers.showMine || layers.remotes.length > 0;
            return (
              <div
                key={note}
                className="piano-key-black-cell"
                style={{
                  left: `calc(${(whiteKeyIndex / 21) * 100}% + 2.2%)`,
                  width: "calc(100% / 21 * 0.6)",
                }}
              >
                <div className="piano-key-emojis piano-key-emojis-black" aria-hidden={!anyEmoji}>
                  <span className="piano-key-emojis-inner">
                    {layers.showMine ? (
                      <span className="piano-key-emoji piano-key-emoji-mine">{myEmoji}</span>
                    ) : null}
                    {layers.remotes.map((r) => (
                      <span key={r.sid} className="piano-key-emoji">
                        {r.emoji}
                      </span>
                    ))}
                  </span>
                </div>
                <button
                  type="button"
                  data-note={note}
                  className={`piano-key piano-key-black ${activeKeys.has(note) ? "active" : ""}`}
                  onPointerDown={(e) => onPointerDown(note, e)}
                >
                  <span className="piano-key-label">{note.replace("#", "♯")}</span>
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
