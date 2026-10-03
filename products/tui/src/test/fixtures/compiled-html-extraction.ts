import { extractKnowledgeArtifact } from '@goodvibes-jev/engine/sdk/platform/knowledge';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { choiceAnswer, fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';

// Only the semantic judgment boundary is synthetic. The actual extractor,
// optional-dependency loader, JSDOM and CSS parser all ship in this executable.
const fake = fakePort((name, question) => {
  if (question.type === 'choice') return choiceAnswer(question, 'title-1', 0.99);
  if (name.startsWith('fits_') || name.startsWith('main_')) return noulAnswer(0.99);
  throw new Error(`Unexpected fixture judgment: ${name}`);
});
installJudgmentPort(fake.port);
globalThis.fetch = Object.assign(
  async () => { throw new Error('Compiled HTML proof forbids network requests'); },
  { preconnect: () => { throw new Error('Compiled HTML proof forbids network preconnect'); } },
);
const result = await extractKnowledgeArtifact(
  { id: 'compiled-html-fixture', mimeType: 'text/html', filename: 'fixture.html' },
  Buffer.from('<html><head><title>Compiled DOM proof</title><meta name="author" content="Synthetic Writer"></head>'
    + '<body><article><h1>Native extraction</h1><p>Parsed content &amp; 電圧 100 V.</p><a href="/guide">Guide</a></article></body></html>'),
);
console.log(JSON.stringify({ result, requests: fake.requests.map((request) => request.context?.battery) }));
