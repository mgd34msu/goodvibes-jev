import {
  type KnowledgeApi, type KnowledgeService, type KnowledgeSearchResult,
  type KnowledgePacket, type PreparedKnowledgePromptPacket, readPreparedKnowledgePromptPacket,
} from '@goodvibes-jev/engine/sdk/platform/knowledge';

declare const service: KnowledgeService;
declare const api: KnowledgeApi;
declare const prepared: PreparedKnowledgePromptPacket;
const search: Promise<KnowledgeSearchResult[]> = service.search('original query');
const scoped: Promise<KnowledgeSearchResult[]> = service.searchScoped({ query: 'original query', knowledgeSpaceId: 'default' });
const grouped: Promise<KnowledgeSearchResult[]> = api.graph.items.search('original query');
const packet: Promise<KnowledgePacket> = api.packets.build('original task');
const preparation: Promise<PreparedKnowledgePromptPacket> = api.packets.preparePrompt('original task', ['src']);
const prompt: string | null = readPreparedKnowledgePromptPacket(prepared, 'original task', ['src']);
// @ts-expect-error Search requires awaiting an actual recorded relevance pass.
const synchronousResults: KnowledgeSearchResult[] = service.search('original query');
// @ts-expect-error Cold synchronous retrieval was retired, not replaced with empty results.
service.buildPacketSync('original task');
// @ts-expect-error Public callers await packet or prompt preparation.
api.packets.buildPromptSync('original task');
// @ts-expect-error Only a completed local preparation creates this opaque handle.
const forged: PreparedKnowledgePromptPacket = {};
export { search, scoped, grouped, packet, preparation, prompt, synchronousResults, forged };
