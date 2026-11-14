export class ApiError extends Error {
  status: number;
  cause: any;
  constructor(message: string, status?: number, cause?: any);
}

export function createApi(options?: {
  fetchImpl?: (url: string, init?: any) => Promise<any>;
  base?: string;
}): {
  sessions(): Promise<{ sessions: any[] }>;
  session(id: string): Promise<{ session: any }>;
  artifact(session: string, id: string, version: number | null): Promise<{ artifact: any }>;
  health(): Promise<{ sessions: any[] }>;
};

export function createChangeCoalescer(
  onChange: () => void,
  options?: {
    delay?: number;
    schedule?: (fn: () => void, delay: number) => any;
    clear?: (handle: any) => void;
  },
): { trigger(): void; cancel(): void; isPending(): boolean };

export function parseChangeEvent(data: string): boolean;
