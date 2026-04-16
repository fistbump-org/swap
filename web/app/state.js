// Browser-side session persistence for in-progress swaps.
//
// Atomic swaps have a critical failure mode: if Alice broadcasts her BTC
// funding tx, closes the tab, and hasn't saved her preimage somewhere,
// she CAN'T claim the FBC leg — the preimage is lost. Her only recovery
// is waiting until T1 and refunding, which costs a tx fee and time.
//
// This module wraps localStorage with a narrow, typed-ish API so both
// Alice's and Bob's flows can checkpoint state at each protocol transition.
// Data is namespaced by role so concurrent Alice+Bob swaps in the same
// browser don't collide.
//
// Security posture: localStorage is origin-scoped. The preimage stored here
// is only at risk from code running on swap.fistbump.org itself — same
// threat model as the page at large. We don't encrypt at rest because a
// compromised page can also read window state, so encryption would only
// be theatre.

const KEY = (role) => `fistbump-swap:v1:${role}`;

export function saveState(role, state) {
  try {
    localStorage.setItem(KEY(role), JSON.stringify({
      ...state,
      _savedAt: Date.now(),
    }));
  } catch (err) {
    // Quota exceeded or privacy mode. Swaps still work without persistence;
    // just lose the reload safety net.
    console.warn("state.saveState failed:", err);
  }
}

export function loadState(role) {
  try {
    const raw = localStorage.getItem(KEY(role));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch (err) {
    console.warn("state.loadState failed:", err);
    return null;
  }
}

export function clearState(role) {
  try {
    localStorage.removeItem(KEY(role));
  } catch {
    // Ignore — best-effort cleanup.
  }
}

export function hasState(role) {
  return loadState(role) !== null;
}

// Promote a partial patch onto the stored state, preserving fields the
// caller didn't touch. Useful when each step adds one more field.
export function patchState(role, patch) {
  const existing = loadState(role) || {};
  saveState(role, { ...existing, ...patch });
}
