import type { ThreadRow } from '../core/types';
import type { ActiveTheme, ThemeChoice, ThemeList } from '../core/vscode-theme';

export {};

declare global {
  interface AccountRecord {
    id: string;
    kind: 'gmail' | 'imap';
    email: string;
    status: 'ok' | 'needs-sign-in';
    /** iCloud and IMAP Accounts: their servers (never the password). */
    settings?: {
      provider: 'icloud' | 'imap';
      email: string;
      user: string;
      savesSent: boolean;
      imap: { host: string; port: number; security: 'tls' | 'starttls' | 'none' };
      smtp: { host: string; port: number; security: 'tls' | 'starttls' | 'none' };
    };
    /** From names and addresses this Account sends as, the default first. Absent: just the login address. */
    identities?: Array<{ name?: string; address: string }>;
  }

  interface Window {
    normie: {
      firstPaint(info: { rows: number; fromSnapshot: boolean }): void;
      ready(info: { rows: number; view: 'list' | 'empty'; fromSnapshot: boolean }): void;
      snapshot(): Array<ThreadRow>;
      saveSnapshot(rows: Array<ThreadRow>): void;
      platform: string;
      fake: boolean;
      onMenuAction(fn: (ids: Array<string>) => void): () => void;
      notify(n: { key: string; title: string; body: string }): void;
      setInboxCount(n: number): void;
      themes: {
        current(legacy: string | null): ActiveTheme;
        list(): Promise<ThemeList>;
        choose(choice: ThemeChoice): Promise<ActiveTheme>;
        onChanged(fn: (t: ActiveTheme) => void): () => void;
        onListChanged(fn: (l: ThemeList) => void): () => void;
      };
      toggleLoginItem(): Promise<{ on: boolean; packaged: boolean }>;
      onOpenThread(fn: (key: string) => void): () => void;
      openLink(url: string): void;
      trimMemory(): void;
      openAttachment(file: { filename: string; content: Uint8Array }): Promise<{ ok: boolean; reason?: string }>;
      saveAttachment(file: { filename: string; content: Uint8Array }): Promise<{ ok: boolean; path?: string }>;
      keymap(): Promise<{ file?: unknown; error?: string }>;
      onKeymapChanged(fn: (k: { file?: unknown; error?: string }) => void): () => void;
      snippets(): Promise<{ file?: unknown; error?: string }>;
      splits(): Promise<{ file?: unknown; error?: string }>;
      onSplitsChanged(fn: (k: { file?: unknown; error?: string }) => void): () => void;
      onSnippetsChanged(fn: (k: { file?: unknown; error?: string }) => void): () => void;
      accounts: {
        list(): Promise<Array<AccountRecord>>;
        addGmail(loginHint?: string): Promise<AccountRecord>;
        remove(id: string): Promise<void>;
        setIdentities(id: string, identities: Array<{ name?: string; address: string }>): Promise<{ ok: true } | { ok: false; error: string }>;
        addPassword(input: {
          provider: 'icloud' | 'imap';
          email: string;
          user?: string;
          password: string;
          savesSent?: boolean;
          imap?: { host: string; port: number; security: 'tls' | 'starttls' | 'none' };
          smtp?: { host: string; port: number; security: 'tls' | 'starttls' | 'none' };
        }): Promise<{ ok: true; account: AccountRecord } | { ok: false; error: string; field?: string }>;
        onChanged(fn: (list: Array<AccountRecord>) => void): () => void;
      };
    };
  }
}
