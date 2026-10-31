// Test-run preload: clears Herdr child-session environment. Tests that
// exercise child IPC set PI_SUBAGENT_* explicitly themselves; every other
// fixture must load extensions as a parent. Without this, running the suite
// inside a Herdr child makes artifact_save take the child sidecar path and
// write junk sidecars next to real session files, which the running parent
// then ingests into its live branch.
for (const key of ["PI_SUBAGENT_SESSION", "PI_SUBAGENT_ID", "PI_SUBAGENT_NAME"]) {
  delete process.env[key];
}

// The scope extension appends every gate decision to a global log in the agent
// directory. A test suite must not write its fixtures into a user's real log, so
// the sink is off unless a test turns it on with its own destination.
if (!process.env.PI_SCOPE_TELEMETRY) process.env.PI_SCOPE_TELEMETRY = "off";