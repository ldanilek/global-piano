import { useCallback, useEffect, useRef, useState } from "react";
import * as Tone from "tone";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";

// Three middle octaves: C3 to B5 (36 keys: 21 white, 15 black)
const WHITE_KEYS = [
  "C3", "D3", "E3", "F3", "G3", "A3", "B3",
  "C4", "D4", "E4", "F4", "G4", "A4", "B4",
  "C5", "D5", "E5", "F5", "G5", "A5", "B5",
];

// Black keys with their position: index of the white key to the left (0-20)
const BLACK_KEYS: { note: string; whiteKeyIndex: number }[] = [
  { note: "C#3", whiteKeyIndex: 0 }, { note: "D#3", whiteKeyIndex: 1 },
  { note: "F#3", whiteKeyIndex: 3 }, { note: "G#3", whiteKeyIndex: 4 }, { note: "A#3", whiteKeyIndex: 5 },
  { note: "C#4", whiteKeyIndex: 7 }, { note: "D#4", whiteKeyIndex: 8 },
  { note: "F#4", whiteKeyIndex: 10 }, { note: "G#4", whiteKeyIndex: 11 }, { note: "A#4", whiteKeyIndex: 12 },
  { note: "C#5", whiteKeyIndex: 14 }, { note: "D#5", whiteKeyIndex: 15 },
  { note: "F#5", whiteKeyIndex: 17 }, { note: "G#5", whiteKeyIndex: 18 }, { note: "A#5", whiteKeyIndex: 19 },
];

// Generate a unique session ID for this browser tab
function generateSessionId(): string {
  return `session_${Math.random().toString(36).slice(2, 11)}_${Date.now()}`;
}

export function Piano() {
  const synthRef = useRef<Tone.PolySynth<Tone.Synth> | null>(null);
  const sessionIdRef = useRef<string>(generateSessionId());
  const processedEventsRef = useRef<Set<Id<"noteEvents">>>(new Set());
  const hasInitializedRef = useRef(false);
  const [activeKeys, setActiveKeys] = useState<Set<string>>(new Set());

  const playNoteMutation = useMutation(api.piano.playNote);
  const releaseNoteMutation = useMutation(api.piano.releaseNote);
  const noteEvents = useQuery(api.piano.getNoteEvents);

  // Initialize synth - use PolySynth for piano-like polyphonic playback
  useEffect(() => {
    const synth = new Tone.PolySynth({
      maxPolyphony: 32, // Increased for multi-user: many users may play simultaneously
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

    synthRef.current = synth;

    return () => {
      synth.dispose();
      synthRef.current = null;
    };
  }, []);

  // Subscribe to note events from other users (and our own, but we ignore ours)
  // When we receive an event from another session, play/release it on our synth
  useEffect(() => {
    if (!noteEvents || !synthRef.current) return;

    const sessionId = sessionIdRef.current;

    // On first load: mark all existing events as processed without playing them.
    // This avoids a jarring burst of old notes when joining. Only new events (after we joined) will play.
    if (!hasInitializedRef.current) {
      hasInitializedRef.current = true;
      for (const event of noteEvents) {
        processedEventsRef.current.add(event._id);
      }
      return;
    }

    for (const event of noteEvents) {
      // Skip events we've already processed
      if (processedEventsRef.current.has(event._id)) continue;

      // Skip our own events - we play those locally immediately
      if (event.sessionId === sessionId) {
        processedEventsRef.current.add(event._id);
        continue;
      }

      // Process events from other users
      processedEventsRef.current.add(event._id);

      // Start AudioContext if needed (browser autoplay policy)
      if (Tone.context.state !== "running") {
        Tone.start();
      }

      if (event.action === "attack") {
        synthRef.current.triggerAttack(event.note, undefined, 0.5); // Slightly lower volume for remote
        setActiveKeys((prev) => new Set(prev).add(event.note));
      } else if (event.action === "release") {
        synthRef.current.triggerRelease(event.note);
        setActiveKeys((prev) => {
          const next = new Set(prev);
          next.delete(event.note);
          return next;
        });
      }
    }

    // Clean up old processed events to prevent memory bloat
    // Keep only recent event IDs (last 100)
    if (processedEventsRef.current.size > 100) {
      const recentIds = new Set(noteEvents.slice(-50).map((e) => e._id));
      processedEventsRef.current = new Set(
        [...processedEventsRef.current].filter((id) => recentIds.has(id))
      );
    }
  }, [noteEvents]);

  const handleKeyDown = useCallback(
    (note: string) => {
      if (!synthRef.current) return;

      // Start AudioContext on first user interaction (browser autoplay policy)
      if (Tone.context.state !== "running") {
        Tone.start();
      }

      // Play locally immediately (responsive)
      synthRef.current.triggerAttack(note, undefined, 0.7);
      setActiveKeys((prev) => new Set(prev).add(note));

      // Sync to all other users via Convex
      playNoteMutation({ note, sessionId: sessionIdRef.current });
    },
    [playNoteMutation]
  );

  const handleKeyUp = useCallback(
    (note: string) => {
      if (!synthRef.current) return;

      // Release locally
      synthRef.current.triggerRelease(note);
      setActiveKeys((prev) => {
        const next = new Set(prev);
        next.delete(note);
        return next;
      });

      // Sync release to all other users via Convex
      releaseNoteMutation({ note, sessionId: sessionIdRef.current });
    },
    [releaseNoteMutation]
  );

  return (
    <div className="piano-container">
      <h1 className="piano-title">Global Piano</h1>
      <p className="piano-subtitle">Three middle octaves (C3 – B5) · Everyone plays the same piano</p>

      <div className="piano">
        {/* White keys */}
        <div className="piano-keys piano-keys-white">
          {WHITE_KEYS.map((note) => (
            <button
              key={note}
              className={`piano-key piano-key-white ${activeKeys.has(note) ? "active" : ""}`}
              onMouseDown={() => handleKeyDown(note)}
              onMouseUp={() => handleKeyUp(note)}
              onMouseLeave={() => handleKeyUp(note)}
              onTouchStart={(e) => {
                e.preventDefault();
                handleKeyDown(note);
              }}
              onTouchEnd={(e) => {
                e.preventDefault();
                handleKeyUp(note);
              }}
            >
              <span className="piano-key-label">{note}</span>
            </button>
          ))}
        </div>

        {/* Black keys - positioned absolutely over white keys */}
        <div className="piano-keys piano-keys-black">
          {BLACK_KEYS.map(({ note, whiteKeyIndex }) => (
            <button
              key={note}
              className={`piano-key piano-key-black ${activeKeys.has(note) ? "active" : ""}`}
              style={{ left: `calc(${(whiteKeyIndex / 21) * 100}% + 2.2%)` }}
              onMouseDown={() => handleKeyDown(note)}
              onMouseUp={() => handleKeyUp(note)}
              onMouseLeave={() => handleKeyUp(note)}
              onTouchStart={(e) => {
                e.preventDefault();
                handleKeyDown(note);
              }}
              onTouchEnd={(e) => {
                e.preventDefault();
                handleKeyUp(note);
              }}
            >
              <span className="piano-key-label">{note.replace("#", "♯")}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
