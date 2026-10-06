import assert from 'node:assert/strict';
import { createServer, get } from 'node:http';
import { createRequire } from 'node:module';
import { once } from 'node:events';

const require = createRequire(import.meta.url);
const verdaccioRequire = createRequire(require.resolve('verdaccio'));
const compression = verdaccioRequire('compression');
const zlib = require('node:zlib');

{
  assert.equal(verdaccioRequire('compression/package.json').version, '1.8.2');
  const streams = [];
  const createGzip = zlib.createGzip;
  const descriptor = Object.getOwnPropertyDescriptor(zlib, 'createGzip');
  Object.defineProperty(zlib, 'createGzip', { ...descriptor, value: options => {
    const stream = createGzip(options);
    streams.push(stream);
    return stream;
  } });
  const compress = compression({ threshold: 0 });
  const body = 'bounded compression fixture\n'.repeat(16);
  const server = createServer((request, response) => {
    compress(request, response, () => {
      response.setHeader('Content-Type', 'text/plain');
      if (request.url === '/complete') response.end(body);
      else {
        response.write(body);
        response.flush();
      }
    });
  });
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('Expected loopback address');
    const url = `http://127.0.0.1:${address.port}`;
    const completed = await new Promise((resolve, reject) => {
      const request = get(`${url}/complete`, { headers: { 'Accept-Encoding': 'gzip' } }, response => {
        const chunks = [];
        response.on('data', chunk => chunks.push(Buffer.from(chunk)));
        response.once('error', reject);
        response.once('end', () => resolve({ encoding: response.headers['content-encoding'], body: Buffer.concat(chunks) }));
      });
      request.once('error', reject);
    });
    assert.equal(completed.encoding, 'gzip');
    assert.equal(zlib.gunzipSync(completed.body).toString(), body);
    await new Promise((resolve, reject) => {
      const request = get(`${url}/abort`, { headers: { 'Accept-Encoding': 'gzip' } }, response => {
        response.once('data', () => { response.destroy(); resolve(); });
        response.once('error', reject);
      });
      request.once('error', reject);
    });
    assert.equal(streams.length, 2);
    const aborted = streams[1];
    if (!aborted.closed) {
      let timer;
      try {
        await Promise.race([
          once(aborted, 'close'),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Compression stream leaked after response close')), 2_000); }),
        ]);
      } finally { clearTimeout(timer); }
    }
    assert.equal(aborted.destroyed, true);
    assert.equal(aborted.closed, true);
    console.log('GZIP_ROUNDTRIP_AND_ABORT_RELEASE_OK');
  } finally {
    Object.defineProperty(zlib, 'createGzip', descriptor);
    for (const stream of streams) stream.destroy();
    server.closeAllConnections();
    await new Promise(resolve => server.close(() => resolve()));
  }
}
