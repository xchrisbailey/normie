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
      ready(info: { rows: number; view: 'list' | 'empty' }): void;
      platform: string;
      fake: boolean;
      accounts: {
        list(): Promise<AccountRecord[]>;
        addGmail(loginHint?: string): Promise<AccountRecord>;
        remove(id: string): Promise<void>;
        onChanged(fn: (list: AccountRecord[]) => void): () => void;
      };
    };
  }
}
