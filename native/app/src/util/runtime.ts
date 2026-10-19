/**
 * The few platform globals this client uses, reached without depending on a DOM
 * or Node type library.
 *
 * React Native ships its own declarations for timers, and the unit tests run
 * the same modules under plain Node where the two type worlds disagree.
 * Reaching for the globals through a narrow structural type keeps one
 * description that compiles in both places and keeps the testable modules free
 * of any native import.
 */

export interface TimerHandle {
  readonly id: number;
}

interface TimerGlobals {
  setTimeout(handler: () => void, timeout: number): number;
  clearTimeout(handle: number): void;
}

const timerGlobals = globalThis as unknown as TimerGlobals;

/** Starts a timer. The handle is opaque and is cancelled with cancelTimer. */
export function scheduleTimer(handler: () => void, delayMs: number): TimerHandle {
  return {id: timerGlobals.setTimeout(handler, delayMs)};
}

/** Cancels a timer started by scheduleTimer. A null handle is ignored. */
export function cancelTimer(handle: TimerHandle | null): void {
  if (!handle) return;
  timerGlobals.clearTimeout(handle.id);
}

/** Milliseconds since the epoch, read from the platform clock. */
export function nowMs(): number {
  return Date.now();
}
