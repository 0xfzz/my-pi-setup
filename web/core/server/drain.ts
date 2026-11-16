// Restart drain state. A server that is about to be replaced must stop telling
// probes it is ready before the supervisor kills it, so neither a browser nor
// a reload watcher starts new work on a process that is going away.

let draining = false;

/** Mark this process as draining. The transition is one-way for its lifetime. */
export function beginDrain(): void {
  draining = true;
}

export function isDraining(): boolean {
  return draining;
}

/** Test-only reset: a fresh server process starts accepting work again. */
export function resetDrainForTests(): void {
  draining = false;
}
