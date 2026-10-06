/** Narrow compiled product command graph, not a substitute for full-screen UX e2e. */
import { runAgentImportProof } from '../helpers/legacy-import-product-proof.ts';
const [product, home, workspace, baseUrl, ...args] = process.argv.slice(2);
if (product !== 'agent' || !home || !workspace || !baseUrl) throw new Error('Product and owned fixture selection required');
const output = await runAgentImportProof({ home, workspace, baseUrl }, args);
process.stdout.write(JSON.stringify({ product, output }) + '\n');
