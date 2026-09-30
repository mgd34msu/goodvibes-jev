import { STRING_SCHEMA, objectSchema } from './method-catalog-shared.js';
import { enumSchema } from './operator-contract-schemas-shared.js';

export const KNOWLEDGE_BROWSER_PROFILE_SCHEMA = objectSchema({
  family: STRING_SCHEMA,
  browser: STRING_SCHEMA,
  profileName: STRING_SCHEMA,
  profilePath: STRING_SCHEMA,
  historyPath: STRING_SCHEMA,
  bookmarksPath: STRING_SCHEMA,
}, ['family', 'browser', 'profileName', 'profilePath'], { additionalProperties: true });

export const KNOWLEDGE_BROWSER_INGEST_OUTCOME_SCHEMA = objectSchema({
  canonicalUri: STRING_SCHEMA,
  sourceId: STRING_SCHEMA,
  capture: enumSchema(['completed', 'partial', 'failed']),
  compilation: enumSchema(['completed', 'held', 'failed', 'not-attempted']),
  error: STRING_SCHEMA,
}, ['canonicalUri', 'capture', 'compilation']);
