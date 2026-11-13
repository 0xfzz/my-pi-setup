export interface DashboardUiState {
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

export function createState(): DashboardUiState;
export function selectSession(state: DashboardUiState, id: string | null): DashboardUiState;
export function applySessions(state: DashboardUiState, sessions: any[]): DashboardUiState;
export function sessionToken(state: DashboardUiState): SessionToken;
export function isSessionTokenCurrent(state: DashboardUiState, token: SessionToken): boolean;
export function applySessionView(state: DashboardUiState, view: any, token: SessionToken): DashboardUiState;
export function selectArtifact(state: DashboardUiState, id: string | null, version?: number | null): DashboardUiState;
export function openNodeDetail(state: DashboardUiState, nodeId: string | null): DashboardUiState;
export function closeDetail(state: DashboardUiState): DashboardUiState;
export function setViewMode(state: DashboardUiState, mode: DashboardUiState["viewMode"]): DashboardUiState;
export function artifactToken(state: DashboardUiState): ArtifactToken;
export function isArtifactTokenCurrent(state: DashboardUiState, token: ArtifactToken): boolean;
export function applyArtifact(state: DashboardUiState, artifact: any, token: ArtifactToken): DashboardUiState;
export function applyArtifactError(state: DashboardUiState, error: any, token: ArtifactToken): DashboardUiState;
export function isArtifactStaleForCatalog(state: DashboardUiState): boolean;
export function latestSummary(state: DashboardUiState, id: string): any | null;
export function setConnection(state: DashboardUiState, connection: DashboardUiState["connection"]): DashboardUiState;
export function setError(state: DashboardUiState, message: string | null): DashboardUiState;
export function setTab(state: DashboardUiState, tab: DashboardUiState["tab"]): DashboardUiState;
