// The Electron-backed stores: secrets through safeStorage's async API (Keychain on macOS),
// and the Account list as JSON in userData. Secrets are never written in plain text.
import { safeStorage } from 'electron';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
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
    if (!(await this.isSecure())) {return this.memory.get(id);}
    try {
      const { result, shouldReEncrypt } = await safeStorage.decryptStringAsync(readFileSync(this.file(id)));
      if (shouldReEncrypt) {await this.set(id, result);}
      return result;
    } catch {
      return undefined;
    }
  }

  async set(id: string, value: string) {
    if (!(await this.isSecure())) {return void this.memory.set(id, value);}
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    writeFileSync(this.file(id), await safeStorage.encryptStringAsync(value), { mode: 0o600 });
  }

  async delete(id: string) {
    this.memory.delete(id);
    rmSync(this.file(id), { force: true });
  }
}

export class JsonAccountList implements AccountList {
  constructor(private readonly file: string) {}

  load(): Array<AccountRecord> {
    try {
      return JSON.parse(readFileSync(this.file, 'utf8')) as Array<AccountRecord>;
    } catch {
      return [];
    }
  }

  save(accounts: Array<AccountRecord>) {
    writeFileSync(this.file, JSON.stringify(accounts, null, 2));
  }
}
