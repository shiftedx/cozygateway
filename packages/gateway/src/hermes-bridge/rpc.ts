export interface HermesRpc {
  request(method: string, params?: unknown, opts?: { timeoutMs?: number }): Promise<unknown>;
}
