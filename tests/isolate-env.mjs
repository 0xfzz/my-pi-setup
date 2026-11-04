// Test-run preload: clears Herdr child-session environment. Tests that
// exercise child IPC set PI_SUBAGENT_* explicitly themselves; every other
// fixture must load extensions as a parent. Without this, running the suite
// inside a Herdr child makes artifact_save take the child sidecar path and
// write junk sidecars next to real session files, which the running parent
// then ingests into its live branch.
//
// Stripped by prefix rather than by exact key: the family grows over time
// (PI_SESSION_FILE and PI_SESSION_ID were added after the original three),
// and any key that leaks from a parent or Herdr session changes what tests
// that detect session context see, which made gate results depend on where
// the run was started from.
for (const key of Object.keys(process.env)) {
  if (key.startsWith("PI_SESSION_") || key.startsWith("PI_SUBAGENT_")) delete process.env[key];
}

// The scope extension appends every gate decision to a global log in the agent
// directory. A test suite must not write its fixtures into a user's real log, so
// the sink is off unless a test turns it on with its own destination.
if (!process.env.PI_SCOPE_TELEMETRY) process.env.PI_SCOPE_TELEMETRY = "off";