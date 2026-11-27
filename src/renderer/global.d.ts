export {};

declare global {
  interface AccountRecord {
    id: string;
    kind: 'gmail' | 'imap';
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
      openLink(url: string): void;
      openAttachment(file: { filename: string; content: Uint8Array }): Promise<{ ok: boolean; reason?: string }>;
      saveAttachment(file: { filename: string; content: Uint8Array }): Promise<{ ok: boolean; path?: string }>;
      keymap(): Promise<{ file?: unknown; error?: string }>;
      onKeymapChanged(fn: (k: { file?: unknown; error?: string }) => void): () => void;
      snippets(): Promise<{ file?: unknown; error?: string }>;
      onSnippetsChanged(fn: (k: { file?: unknown; error?: string }) => void): () => void;
      accounts: {
        list(): Promise<AccountRecord[]>;
        addGmail(loginHint?: string): Promise<AccountRecord>;
        remove(id: string): Promise<void>;
        addPassword(input: {
          provider: 'icloud' | 'imap'; email: string; user?: string; password: string; savesSent?: boolean;
          imap?: { host: string; port: number; security: 'tls' | 'starttls' | 'none' };
          smtp?: { host: string; port: number; security: 'tls' | 'starttls' | 'none' };
        }): Promise<{ ok: true; account: AccountRecord } | { ok: false; error: string; field?: string }>;
        onChanged(fn: (list: AccountRecord[]) => void): () => void;
      };
    };
  }
}
