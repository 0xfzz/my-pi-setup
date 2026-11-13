/**
 * Pure dashboard state transitions with explicit request epochs.
 *
 * Two rules matter for correctness:
 *  - Refreshing the session list never steals an existing selection. If the
 *    selected session disappears, selection falls back deterministically.
 *  - Changing sessions clears artifact selection/content immediately, and every
 *    async response carries a token that must still match the current epoch.
 */

const MAX_REMEMBERED_ERRORS = 1;

function byRecent(a, b) {
  const connected = Number(Boolean(b.connected)) - Number(Boolean(a.connected));
  if (connected) return connected;
  const seen = (Number(b.lastSeen) || 0) - (Number(a.lastSeen) || 0);
  if (seen) return seen;
  return String(a.id).localeCompare(String(b.id));
}

export function createState() {
  return {
    sessions: [],
    selectedSessionId: null,
    session: null,
    sessionEpoch: 0,
    selectedNodeId: null,
    selectedArtifactId: null,
    selectedArtifactVersion: null,
    artifact: null,
    artifactEpoch: 0,
    artifactStale: false,
    artifactError: null,
    artifactMode: "rendered",
    artifactQuery: "",
    tab: "work",
    viewMode: "list",
    detailOpen: false,
    hideCompleted: false,
    connection: "connecting",
    notice: null,
    error: null,
    updatedAt: 0,
  };
}

/** Select a session, immediately clearing content that belonged to the old one. */
export function selectSession(state, id) {
  if (state.selectedSessionId === id) return state;
  return {
    ...state,
    selectedSessionId: id ?? null,
    session: null,
    sessionEpoch: state.sessionEpoch + 1,
    selectedNodeId: null,
    detailOpen: false,
    selectedArtifactId: null,
    selectedArtifactVersion: null,
    artifact: null,
    artifactEpoch: state.artifactEpoch + 1,
    artifactStale: false,
    artifactError: null,
    notice: null,
    error: null,
  };
}

/** Merge a sessions poll without letting a new session steal the selection. */
export function applySessions(state, sessions) {
  const list = Array.isArray(sessions) ? [...sessions].sort(byRecent) : [];
  let next = { ...state, sessions: list };
  if (state.selectedSessionId == null) {
    if (list.length > 0) next = selectSession(next, list[0].id);
    return next;
  }
  if (!list.some((session) => session.id === state.selectedSessionId)) {
    next = selectSession(next, list[0]?.id ?? null);
  }
  return next;
}

export function sessionToken(state) {
  return { epoch: state.sessionEpoch, id: state.selectedSessionId };
}

export function isSessionTokenCurrent(state, token) {
  return Boolean(token) && token.epoch === state.sessionEpoch && token.id === state.selectedSessionId;
}

/**
 * Apply a session view if its token is current and it is not older than the
 * view already displayed. Returns the same state object when the response is
 * stale, so callers can cheaply skip re-rendering.
 */
export function applySessionView(state, view, token) {
  if (!isSessionTokenCurrent(state, token)) return state;
  if (!view || !view.session || view.session.id !== token.id) return state;
  if (state.session && Number(view.revision) < Number(state.session.revision)) return state;

  const artifacts = Array.isArray(view.artifacts) ? view.artifacts : [];
  let next = {
    ...state,
    session: { ...view, artifacts },
    updatedAt: Date.now(),
    connection: view.connected === false ? "offline" : state.connection,
  };

  if (state.selectedArtifactId) {
    const summary = artifacts.find((artifact) => artifact.id === state.selectedArtifactId);
    if (!summary) {
      next = {
        ...next,
        selectedArtifactId: null,
        selectedArtifactVersion: null,
        artifact: null,
        artifactStale: false,
        artifactError: null,
        artifactEpoch: next.artifactEpoch + 1,
        notice: "The selected artifact was removed from this session.",
      };
    } else if (state.artifact && Number(summary.version) !== Number(state.artifact.version)) {
      next = { ...next, artifact: null, artifactStale: true, notice: "The selected artifact changed; refreshing its content." };
    }
  }
  return next;
}

export function selectArtifact(state, id, version) {
  const sameSelection = state.selectedArtifactId === id && Number(state.selectedArtifactVersion) === Number(version);
  if (sameSelection && (state.artifact || state.artifactStale)) {
    return state.detailOpen ? state : { ...state, detailOpen: true };
  }
  return {
    ...state,
    selectedArtifactId: id ?? null,
    selectedArtifactVersion: version == null ? null : Number(version),
    artifact: null,
    artifactEpoch: state.artifactEpoch + 1,
    artifactStale: false,
    artifactError: null,
    notice: null,
    ...(id ? { detailOpen: true } : {}),
  };
}

/**
 * Open the detail drawer for a node. Deliberately never changes `tab`: clicking a
 * node must not yank the user away from the tab they are reading.
 */
export function openNodeDetail(state, nodeId) {
  const id = nodeId ?? null;
  const detailOpen = Boolean(id);
  if (state.selectedNodeId === id && state.detailOpen === detailOpen) return state;
  return { ...state, selectedNodeId: id, detailOpen };
}

/** Close the drawer and drop the artifact it was showing (invalidating in-flight loads). */
export function closeDetail(state) {
  const alreadyClosed = !state.detailOpen
    && state.selectedNodeId == null
    && state.selectedArtifactId == null
    && !state.artifact
    && !state.artifactStale
    && !state.artifactError;
  if (alreadyClosed) return state;
  return {
    ...state,
    detailOpen: false,
    selectedNodeId: null,
    selectedArtifactId: null,
    selectedArtifactVersion: null,
    artifact: null,
    artifactStale: false,
    artifactError: null,
    artifactEpoch: state.artifactEpoch + 1,
  };
}

export function setViewMode(state, mode) {
  return state.viewMode === mode ? state : { ...state, viewMode: mode };
}

export function artifactToken(state) {
  return {
    epoch: state.artifactEpoch,
    sessionId: state.selectedSessionId,
    id: state.selectedArtifactId,
    version: state.selectedArtifactVersion,
  };
}

export function isArtifactTokenCurrent(state, token) {
  return Boolean(token)
    && token.epoch === state.artifactEpoch
    && token.sessionId === state.selectedSessionId
    && token.id === state.selectedArtifactId;
}

export function applyArtifact(state, artifact, token) {
  if (!isArtifactTokenCurrent(state, token)) return state;
  if (!artifact || artifact.id !== token.id) return state;
  if (token.version != null && Number(artifact.version) !== Number(token.version)) return state;
  return { ...state, artifact, artifactStale: false, artifactError: null };
}

export function applyArtifactError(state, error, token) {
  if (!isArtifactTokenCurrent(state, token)) return state;
  const status = Number(error?.status) || 0;
  return {
    ...state,
    artifact: null,
    artifactStale: status === 409 ? true : state.artifactStale,
    artifactError: {
      message: String(error?.message || "Unable to load artifact"),
      status,
    },
  };
}

export function isArtifactStaleForCatalog(state) {
  if (!state.selectedArtifactId || !state.session) return false;
  const summary = (state.session.artifacts || []).find((artifact) => artifact.id === state.selectedArtifactId);
  if (!summary) return false;
  const loadedVersion = state.artifact ? Number(state.artifact.version) : NaN;
  const selectedVersion = Number(state.selectedArtifactVersion);
  return Number(summary.version) !== selectedVersion || (Number.isFinite(loadedVersion) && loadedVersion !== Number(summary.version));
}

export function latestSummary(state, id) {
  return (state.session?.artifacts || []).find((artifact) => artifact.id === id) || null;
}

export function setConnection(state, connection) {
  return state.connection === connection ? state : { ...state, connection };
}

export function setError(state, message) {
  if (!message) return { ...state, error: null };
  return { ...state, error: { message: String(message) } };
}

export function setTab(state, tab) {
  return state.tab === tab ? state : { ...state, tab };
}

export { MAX_REMEMBERED_ERRORS };
