import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
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

/**
 * Spatial piano ↔ QWERTY: home row = whites; row above = blacks set back‑left
 * between the same white pairs as on a real keyboard (e.g. R above/between D–F
 * = G#3 between G3 and A3, diagonal from F = A3).
 */
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

function pidToKeyCode(pid: string): string {
  return pid.startsWith("key_") ? pid.slice(4) : pid;
}

function isTypingTarget(el: EventTarget | null): boolean {
  if (el === null || !(el instanceof HTMLElement)) return false;
  const t = el.tagName;
  if (t === "INPUT" || t === "TEXTAREA" || t === "SELECT") return true;
  return el.isContentEditable;
}

function remoteNoteCounts(
  holds: { sessionId: string; note: string }[],
  mySession: string
): Map<string, number> {
  const m = new Map<string, number>();
  for (const h of holds) {
    if (h.sessionId === mySession) continue;
    m.set(h.note, (m.get(h.note) ?? 0) + 1);
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

/** `?debugPiano=1` or `localStorage.debugPiano = "1"` */
function pianoDebug(): boolean {
  if (typeof window === "undefined") return false;
  return (
    new URLSearchParams(window.location.search).has("debugPiano") ||
    window.localStorage.getItem("debugPiano") === "1"
  );
}

function pianoLog(...args: unknown[]): void {
  if (pianoDebug()) {
    console.log("[piano]", ...args);
  }
}

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
  /** Direct input (mouse / keyboard) — never share with remote logic */
  const localSynthRef = useRef<Tone.PolySynth<Tone.Synth> | null>(null);
  /** Other sessions only — so remote release never cuts a note you still hold */
  const remoteSynthRef = useRef<Tone.PolySynth<Tone.Synth> | null>(null);
  const sessionIdRef = useRef<string>(generateSessionId());
  const remoteInitRef = useRef(false);
  const prevRemoteCountsRef = useRef<Map<string, number>>(new Map());
  /** Per pointerId: current note held locally */
  const pointerNotesRef = useRef<Map<string, string>>(new Map());
  /** Local ref count per note (multiple pointers can hold same note) */
  const localNoteCountsRef = useRef<Map<string, number>>(new Map());

  const [activeKeys, setActiveKeys] = useState<Set<string>>(new Set());

  const pressNoteMutation = useMutation(api.piano.pressNote);
  const releasePointerMutation = useMutation(api.piano.releasePointer);
  const moveNoteMutation = useMutation(api.piano.moveNote);
  const syncKeyboardHoldsMutation = useMutation(api.piano.syncKeyboardHolds);
  const holds = useQuery(api.piano.getHolds);
  const holdsRef = useRef(holds);
  holdsRef.current = holds;

  /** One Convex sync shortly after the last keyboard change — avoids racy partial snapshots. */
  const keyboardConvexDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const scheduleKeyboardConvexSync = useCallback(() => {
    if (keyboardConvexDebounceRef.current !== null) {
      clearTimeout(keyboardConvexDebounceRef.current);
    }
    keyboardConvexDebounceRef.current = setTimeout(() => {
      keyboardConvexDebounceRef.current = null;
      const holdsPayload = [...pointerNotesRef.current.entries()]
        .filter(([pid]) => pid.startsWith("key_"))
        .map(([pointerId, note]) => ({ pointerId, note }));
      pianoLog(
        "syncKeyboard convex",
        holdsPayload.length,
        holdsPayload.map((x) => x.pointerId)
      );
      void syncKeyboardHoldsMutation({
        sessionId: sessionIdRef.current,
        holds: holdsPayload,
      })
        .then(() => pianoLog("syncKeyboard ok", holdsPayload.length))
        .catch((err: unknown) => {
          console.error("[piano] syncKeyboard failed", err);
          throw err;
        });
    }, 35);
  }, [syncKeyboardHoldsMutation]);

  const flushKeyboardConvexNow = useCallback(() => {
    if (keyboardConvexDebounceRef.current !== null) {
      clearTimeout(keyboardConvexDebounceRef.current);
      keyboardConvexDebounceRef.current = null;
    }
    const holdsPayload = [...pointerNotesRef.current.entries()]
      .filter(([pid]) => pid.startsWith("key_"))
      .map(([pointerId, note]) => ({ pointerId, note }));
    void syncKeyboardHoldsMutation({
      sessionId: sessionIdRef.current,
      holds: holdsPayload,
    }).catch((err: unknown) => {
      console.error("[piano] syncKeyboard failed", err);
      throw err;
    });
  }, [syncKeyboardHoldsMutation]);

  useEffect(
    () => () => {
      if (keyboardConvexDebounceRef.current !== null) {
        clearTimeout(keyboardConvexDebounceRef.current);
      }
    },
    []
  );

  const bumpLocalNote = useCallback((note: string, delta: number) => {
    const m = localNoteCountsRef.current;
    const next = (m.get(note) ?? 0) + delta;
    if (next <= 0) m.delete(note);
    else m.set(note, next);
  }, []);

  const recomputeActiveKeys = useCallback(
    (remote: Map<string, number>) => {
      setActiveKeys(mergeActiveKeys(localNoteCountsRef.current, remote));
    },
    []
  );

  useLayoutEffect(() => {
    const local = makePoly();
    const remote = makePoly();
    localSynthRef.current = local;
    remoteSynthRef.current = remote;

    return () => {
      local.dispose();
      remote.dispose();
      localSynthRef.current = null;
      remoteSynthRef.current = null;
    };
  }, []);

  const sessionId = sessionIdRef.current;

  useEffect(() => {
    if (!holds || !remoteSynthRef.current) return;

    const counts = remoteNoteCounts(holds, sessionId);
    const remoteSynth = remoteSynthRef.current;

    if (!remoteInitRef.current) {
      remoteInitRef.current = true;
      prevRemoteCountsRef.current = new Map(counts);
      recomputeActiveKeys(counts);
      return;
    }

    const prev = prevRemoteCountsRef.current;
    const allNotes = new Set([...prev.keys(), ...counts.keys()]);

    if (Tone.context.state !== "running") {
      Tone.start();
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

    prevRemoteCountsRef.current = new Map(counts);
    recomputeActiveKeys(counts);
  }, [holds, sessionId, recomputeActiveKeys]);

  const localPress = useCallback(
    (note: string, pid: string) => {
      if (!localSynthRef.current) {
        pianoLog("localPress skip: no synth", pid, note);
        return;
      }
      if (Tone.context.state !== "running") {
        Tone.start();
      }
      localSynthRef.current.triggerAttack(note, undefined, 0.7);
      pointerNotesRef.current.set(pid, note);
      bumpLocalNote(note, 1);
      const h = holdsRef.current;
      const remote = h ? remoteNoteCounts(h, sessionId) : new Map();
      recomputeActiveKeys(remote);
      pianoLog("keydown→press", pidToKeyCode(pid), note, "pointers", pointerNotesRef.current.size);
      if (pid.startsWith("key_")) {
        scheduleKeyboardConvexSync();
      } else {
        void pressNoteMutation({
          note,
          sessionId: sessionIdRef.current,
          pointerId: pid,
        }).then(() => {
          pianoLog("convex press ok", pid, note);
        }).catch((err: unknown) => {
          console.error("[piano] convex press failed", pid, note, err);
          throw err;
        });
      }
    },
    [pressNoteMutation, bumpLocalNote, recomputeActiveKeys, sessionId, scheduleKeyboardConvexSync]
  );

  const localReleasePointer = useCallback(
    (pid: string) => {
      if (!localSynthRef.current) {
        pianoLog("localRelease skip: no synth", pid);
        return;
      }
      const note = pointerNotesRef.current.get(pid);
      if (note === undefined) {
        pianoLog("keyup ignored (no prior press)", pidToKeyCode(pid));
        return;
      }
      pointerNotesRef.current.delete(pid);
      localSynthRef.current.triggerRelease(note);
      bumpLocalNote(note, -1);
      const h = holdsRef.current;
      const remote = h ? remoteNoteCounts(h, sessionId) : new Map();
      recomputeActiveKeys(remote);
      pianoLog("keyup→release", pidToKeyCode(pid), note, "pointers", pointerNotesRef.current.size);
      if (pid.startsWith("key_")) {
        scheduleKeyboardConvexSync();
      } else {
        void releasePointerMutation({
          sessionId: sessionIdRef.current,
          pointerId: pid,
        }).then(() => {
          pianoLog("convex release ok", pid);
        }).catch((err: unknown) => {
          console.error("[piano] convex release failed", pid, err);
          throw err;
        });
      }
    },
    [releasePointerMutation, bumpLocalNote, recomputeActiveKeys, sessionId, scheduleKeyboardConvexSync]
  );

  const localMove = useCallback(
    (pid: string, fromNote: string, toNote: string) => {
      if (!localSynthRef.current) return;
      localSynthRef.current.triggerRelease(fromNote);
      localSynthRef.current.triggerAttack(toNote, undefined, 0.7);
      bumpLocalNote(fromNote, -1);
      bumpLocalNote(toNote, 1);
      pointerNotesRef.current.set(pid, toNote);
      const h = holdsRef.current;
      const remote = h ? remoteNoteCounts(h, sessionId) : new Map();
      recomputeActiveKeys(remote);
      void moveNoteMutation({
        sessionId: sessionIdRef.current,
        pointerId: pid,
        fromNote,
        toNote,
      }).catch((err: unknown) => {
        console.error("[piano] convex move failed", err);
        throw err;
      });
    },
    [moveNoteMutation, bumpLocalNote, recomputeActiveKeys, sessionId]
  );

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const pid = pointerKey(e.pointerId);
      const current = pointerNotesRef.current.get(pid);
      if (current === undefined) return;

      const under = noteFromPoint(e.clientX, e.clientY);
      if (under === null) {
        localReleasePointer(pid);
        return;
      }
      if (under !== current) {
        localMove(pid, current, under);
      }
    };

    const onUp = (e: PointerEvent) => {
      const pid = pointerKey(e.pointerId);
      if (pointerNotesRef.current.has(pid)) {
        localReleasePointer(pid);
      }
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [localReleasePointer, localMove]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.repeat) {
        pianoLog("keydown skip repeat", e.code);
        return;
      }
      if (isTypingTarget(e.target)) {
        pianoLog("keydown skip typing target", e.code, (e.target as HTMLElement).tagName);
        return;
      }
      const note = CODE_TO_NOTE[e.code];
      if (note === undefined) return;
      e.preventDefault();
      const pid = keyboardPointerId(e.code);
      if (pointerNotesRef.current.has(pid)) {
        pianoLog("keydown skip already tracked", e.code, note);
        return;
      }
      localPress(note, pid);
    };

    const onKeyUp = (e: KeyboardEvent) => {
      const note = CODE_TO_NOTE[e.code];
      if (note === undefined) return;
      e.preventDefault();
      localReleasePointer(keyboardPointerId(e.code));
    };

    /** Only when the tab is hidden — not window `blur` (blur fires when focus moves to DevTools, iframes, or IDE UI and was wiping chords). */
    const onVisibilityChange = () => {
      if (!document.hidden) return;
      pianoLog("tab hidden → release all keyboard");
      const synth = localSynthRef.current;
      if (!synth) return;
      for (const id of [...pointerNotesRef.current.keys()]) {
        if (!id.startsWith("key_")) continue;
        const n = pointerNotesRef.current.get(id);
        if (n === undefined) continue;
        pointerNotesRef.current.delete(id);
        synth.triggerRelease(n);
        bumpLocalNote(n, -1);
      }
      const h = holdsRef.current;
      recomputeActiveKeys(h ? remoteNoteCounts(h, sessionId) : new Map());
      flushKeyboardConvexNow();
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
  }, [
    localPress,
    localReleasePointer,
    flushKeyboardConvexNow,
    bumpLocalNote,
    recomputeActiveKeys,
    sessionId,
  ]);

  const onPointerDown = useCallback(
    (note: string, e: React.PointerEvent) => {
      e.preventDefault();
      if (
        document.activeElement instanceof HTMLElement &&
        document.activeElement.closest(".piano")
      ) {
        document.activeElement.blur();
      }
      const pid = pointerKey(e.pointerId);
      if (pointerNotesRef.current.has(pid)) return;
      localPress(note, pid);
    },
    [localPress]
  );

  return (
    <div className="piano-container">
      <h1 className="piano-title">Global Piano</h1>
      <p className="piano-subtitle">
        Three middle octaves (C3–B5) · Everyone plays the same piano
      </p>

      <div className="piano">
        <div className="piano-keys piano-keys-white">
          {WHITE_KEYS.map((note) => (
            <button
              key={note}
              type="button"
              data-note={note}
              className={`piano-key piano-key-white ${activeKeys.has(note) ? "active" : ""}`}
              onPointerDown={(e) => onPointerDown(note, e)}
            >
              <span className="piano-key-label">{note}</span>
            </button>
          ))}
        </div>

        <div className="piano-keys piano-keys-black">
          {BLACK_KEYS.map(({ note, whiteKeyIndex }) => (
            <button
              key={note}
              type="button"
              data-note={note}
              className={`piano-key piano-key-black ${activeKeys.has(note) ? "active" : ""}`}
              style={{ left: `calc(${(whiteKeyIndex / 21) * 100}% + 2.2%)` }}
              onPointerDown={(e) => onPointerDown(note, e)}
            >
              <span className="piano-key-label">{note.replace("#", "♯")}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
