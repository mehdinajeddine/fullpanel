/** Stored only in encrypted server state and passed directly to the runtime. */
export interface ProxyAuthCredential {
  username: string;
  passwordHash: string;
}

export type ProxyAuthMap = Record<string, ProxyAuthCredential>;

export interface ProxyAuthStatus {
  enabled: boolean;
  username?: string;
}
