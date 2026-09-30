import {
  createAtRestCipher,
  createDaemonCredentialStore,
  type AtRestCipher,
  type DaemonCredentialStore,
} from '@goodvibes-jev/engine/sdk/platform/config';

const credentials: DaemonCredentialStore = createDaemonCredentialStore({
  async get(_key: string): Promise<string | null> { return null; },
  async set(_key: string, _value: string): Promise<void> {},
});
const cipher: AtRestCipher = createAtRestCipher(credentials, 'FIXTURE_DRAFT_KEY');
const encrypted: Promise<string> = cipher.encrypt('fixture');
const decrypted: Promise<string> = cipher.decrypt('fixture');
void [encrypted, decrypted];

// @ts-expect-error The input must have a real writer as well as a reader.
createDaemonCredentialStore({ async get() { return null; } });
// @ts-expect-error A cipher accepts text, not an arbitrary payload object.
cipher.encrypt({ body: 'fixture' });
// @ts-expect-error Credential scope is a declared storage tier.
credentials.put('FIXTURE', 'fixture', { scope: 'everywhere' });
