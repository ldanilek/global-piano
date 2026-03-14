# Global Piano

A web-based piano built with Convex + Vite featuring the three middle octaves (C3–B5). Click keys to play realistic piano sounds. Note plays are synced globally via Convex so all users can see the shared piano state.

## Tech Stack

- **Vite** + **React** + **TypeScript** – Frontend
- **Convex** – Real-time backend for global note sync
- **@tonejs/piano** – High-quality sampled piano sounds (Salamander Grand Piano)

## Setup

1. **Install dependencies:**
   ```bash
   npm install
   ```

2. **Set up Convex** (one-time setup):
   ```bash
   npx convex dev
   ```
   This will:
   - Prompt you to log in or create a Convex account
   - Create a new Convex project (or link to existing)
   - Generate a `.env.local` file with `VITE_CONVEX_URL`

3. **Run the development server:**
   ```bash
   npm run dev
   ```
   For Convex backend + frontend together:
   ```bash
   npx convex dev
   ```
   (This runs both Convex functions and can proxy to your Vite dev server)

## Usage

- **Click** or **tap** piano keys to play notes
- White keys: C, D, E, F, G, A, B
- Black keys: C♯, D♯, F♯, G♯, A♯
- Notes are synced via Convex: each pointer hold is tracked so multiple players on the same key work correctly; drag across keys to glide
- **Debug:** `?debugPiano=1` or `localStorage.debugPiano = "1"` — extra console logs for keydown/keyup and Convex sync (no UI change)

## Project Structure

```
src/
  components/
    Piano.tsx     # Main piano component with keyboard UI
  App.tsx         # App shell
  main.tsx        # Entry point with ConvexProvider

convex/
  schema.ts       # noteHolds, sessionActivity, pianoEventLog
  piano.ts        # holds + listEventLog (append-only audit)
```

## Scripts

- `npm run dev` – Start Vite dev server
- `npm run build` – Production build
- `npm run preview` – Preview production build
- `npx convex dev` – Run Convex dev (backend + optional frontend proxy)
