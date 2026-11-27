export {};

declare global {
  interface AccountRecord {
    id: string;
    kind: 'gmail';
    email: string;
    status: 'ok' | 'needs-sign-in';
  }

  interface Window {
    normie: {
      firstPaint(info: { rows: number; fromSnapshot: boolean }): void;
      ready(info: { rows: number; view: 'list' | 'empty'; fromSnapshot: boolean }): void;
      snapshot(): import('../core/types').ThreadRow[];
      saveSnapshot(rows: import('../core/types').ThreadRow[]): void;
      platform: string;
      fake: boolean;
      onMenuAction(fn: (ids: string[]) => void): () => void;
      accounts: {
        list(): Promise<AccountRecord[]>;
        addGmail(loginHint?: string): Promise<AccountRecord>;
        remove(id: string): Promise<void>;
        onChanged(fn: (list: AccountRecord[]) => void): () => void;
      };
    };
  }
}
