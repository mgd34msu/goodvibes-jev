import type { JudgmentReadingOptions } from '@goodvibes-jev/engine/errors';
import type { FieldKind } from './batteries/field-kind.js';
import { assertRedactionCurrent } from './redaction-reading.js';

/** Declared field roles. Unlisted names remain withheld; no name-based inference. */
const fields: Readonly<Record<FieldKind, ReadonlySet<string>>> = {
  secret: new Set(['password', 'passwd', 'loginpassword', 'apikey', 'accesstoken', 'refreshtoken', 'authorization', 'cookie',
    'credential', 'credentials', 'credentialref', 'token', 'privatekey', 'signingkey', 'secret', 'unlockpassphrase', 'privatesigningmaterial']),
  owner_profile: new Set(['shippingaddress', 'billingaddress', 'homeaddress', 'emailaddress', 'phonenumber', 'privateaddress', 'quiethours']),
  content: new Set(['message', 'body', 'text', 'content', 'prompt', 'response', 'stdout', 'stderr', 'output', 'error', 'stack',
    'summary', 'hint', 'name', 'note', 'description', 'reasoningcontent', 'reasoningsummary', 'instructions', 'document', 'transcript', 'title',
    'data', 'details', 'payload', 'attributes', 'arguments', 'result', 'results', 'records', 'items', 'nested', 'self', 'metadata', 'judgment', 'config', 'extension', 'surfaces', 'diagnostics']),
  other: new Set(['id', 'requestid', 'sessionid', 'agentid', 'taskid', 'documentid', 'traceid', 'spanid', 'workstreamid',
    'domain', 'eventtype', 'source', 'turnid', 'stopreason', 'model', 'modelid', 'provider', 'providerid', 'registrykey', 'site', 'universe', 'kind', 'type', 'category', 'code', 'status', 'state',
    'count', 'tokencount', 'maxtokens', 'maxoutputtokens', 'totaltokens', 'inputtokens', 'outputtokens', 'cachereadtokens', 'cachewritetokens',
    'durationms', 'latencyms', 'elapsedms', 'timestamp', 'at', 'attempt', 'attempts', 'retryafterms', 'size', 'bytes', 'limit', 'total',
    'active', 'enabled', 'success', 'valid', 'complete', 'cached', 'recoverable', 'stable', 'found']),
};

export class FieldKindReader {
  private disposed = false;
  constructor(private readonly options: JudgmentReadingOptions = {}) {}

  read(field: string): FieldKind | undefined {
    try {
      if (this.disposed || this.options.signal?.aborted) return undefined;
      assertRedactionCurrent(this.options.assertCurrent);
      const name = field.replace(/[_-]/g, '').toLowerCase();
      for (const kind of ['secret', 'owner_profile', 'content', 'other'] as const) if (fields[kind].has(name)) return kind;
    } catch { return undefined; }
    return undefined;
  }

  async readAsync(field: string): Promise<FieldKind | undefined> { return this.read(field); }
  dispose(): void { this.disposed = true; }
}
