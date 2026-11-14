export interface SubagentGraphUiState {
  sessions: any[];
  selectedSessionId: string | null;
  session: any | null;
  sessionEpoch: number;
  selectedNodeId: string | null;
  selectedArtifactId: string | null;
  selectedArtifactVersion: number | null;
  artifact: any | null;
  artifactEpoch: number;
  artifactStale: boolean;
  artifactError: { message: string; status: number } | null;
  artifactMode: "rendered" | "raw";
  artifactQuery: string;
  tab: "work" | "artifacts";
  viewMode: "list" | "graph";
  detailOpen: boolean;
  hideCompleted: boolean;
  connection: "connecting" | "live" | "offline";
  notice: string | null;
  error: { message: string } | null;
  updatedAt: number;
}

export interface SessionToken { epoch: number; id: string | null }
export interface ArtifactToken {
  epoch: number;
  sessionId: string | null;
  id: string | null;
  version: number | null;
}

export function createState(): SubagentGraphUiState;
export function selectSession(state: SubagentGraphUiState, id: string | null): SubagentGraphUiState;
export function applySessions(state: SubagentGraphUiState, sessions: any[]): SubagentGraphUiState;
export function sessionToken(state: SubagentGraphUiState): SessionToken;
export function isSessionTokenCurrent(state: SubagentGraphUiState, token: SessionToken): boolean;
export function applySessionView(state: SubagentGraphUiState, view: any, token: SessionToken): SubagentGraphUiState;
export function selectArtifact(state: SubagentGraphUiState, id: string | null, version?: number | null): SubagentGraphUiState;
export function openNodeDetail(state: SubagentGraphUiState, nodeId: string | null): SubagentGraphUiState;
export function closeDetail(state: SubagentGraphUiState): SubagentGraphUiState;
export function setViewMode(state: SubagentGraphUiState, mode: SubagentGraphUiState["viewMode"]): SubagentGraphUiState;
export function artifactToken(state: SubagentGraphUiState): ArtifactToken;
export function isArtifactTokenCurrent(state: SubagentGraphUiState, token: ArtifactToken): boolean;
export function applyArtifact(state: SubagentGraphUiState, artifact: any, token: ArtifactToken): SubagentGraphUiState;
export function applyArtifactError(state: SubagentGraphUiState, error: any, token: ArtifactToken): SubagentGraphUiState;
export function isArtifactStaleForCatalog(state: SubagentGraphUiState): boolean;
export function latestSummary(state: SubagentGraphUiState, id: string): any | null;
export function setConnection(state: SubagentGraphUiState, connection: SubagentGraphUiState["connection"]): SubagentGraphUiState;
export function setError(state: SubagentGraphUiState, message: string | null): SubagentGraphUiState;
export function setTab(state: SubagentGraphUiState, tab: SubagentGraphUiState["tab"]): SubagentGraphUiState;
