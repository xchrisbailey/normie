// The Electron-backed stores: secrets through safeStorage's async API (Keychain on macOS),
// and the Account list as JSON in userData. Secrets are never written in plain text.
import { safeStorage } from 'electron';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseJson } from '../../core/json';
import type { AccountList, AccountRecord, SecretStore } from './accounts';

export class SafeStorageSecrets implements SecretStore {
  private memory = new Map<string, string>();
  private secure?: Promise<boolean>;

  constructor(private readonly dir: string) {}

  /** False when the OS has no secure backend (Linux without a keyring): then secrets stay in memory only. */
  private isSecure() {
    this.secure ??= safeStorage
      .isAsyncEncryptionAvailable()
      .then((ok) => ok && (process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text'));
    return this.secure;
  }

  private file(id: string) {
    return path.join(this.dir, `${Buffer.from(id).toString('base64url')}.bin`);
  }

  async get(id: string) {
    if (!(await this.isSecure())) {
      return this.memory.get(id);
    }
    try {
      const { result, shouldReEncrypt } = await safeStorage.decryptStringAsync(readFileSync(this.file(id)));
      if (shouldReEncrypt) {
        await this.set(id, result);
      }
      return result;
    } catch {
      return undefined;
    }
  }

  async set(id: string, value: string) {
    if (!(await this.isSecure())) {
      return void this.memory.set(id, value);
    }
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    writeFileSync(this.file(id), await safeStorage.encryptStringAsync(value), { mode: 0o600 });
  }

  async delete(id: string) {
    this.memory.delete(id);
    rmSync(this.file(id), { force: true });
  }
}

/** The shape of a saved Account: what the rest of the code reads from it. */
function isAccountRecord(r: unknown): r is AccountRecord {
  if (typeof r !== 'object' || r === null) {
    return false;
  }
  if (!('id' in r) || typeof r.id !== 'string' || !('email' in r) || typeof r.email !== 'string') {
    return false;
  }
  if (!('status' in r) || (r.status !== 'ok' && r.status !== 'needs-sign-in')) {
    return false;
  }
  if (!('kind' in r)) {
    return false;
  }
  return r.kind === 'gmail' || (r.kind === 'imap' && 'settings' in r && typeof r.settings === 'object' && r.settings !== null);
}

export class JsonAccountList implements AccountList {
  constructor(private readonly file: string) {}

  load(): Array<AccountRecord> {
    try {
      const v = parseJson(readFileSync(this.file, 'utf8'));
      if (!Array.isArray(v)) {
        return [];
      }
      const accounts: Array<AccountRecord> = [];
      for (const r of v) {
        if (!isAccountRecord(r)) {
          return [];
        }
        accounts.push(r);
      }
      return accounts;
    } catch {
      return [];
    }
  }

  save(accounts: Array<AccountRecord>) {
    writeFileSync(this.file, JSON.stringify(accounts, null, 2));
  }
}
