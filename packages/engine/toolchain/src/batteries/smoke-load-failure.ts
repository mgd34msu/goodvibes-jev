import { defineBattery, DEFAULT_MODEL, STAKES_BANDS, yesNo } from '@goodvibes-jev/judgment';

export const smokeLoadFailure = defineBattery({
  name: 'toolchain.smoke.load-failure', version: 1, model: DEFAULT_MODEL,
  description: 'Whether complete privacy-screened compiled version-smoke output reports an actual module or native-addon load failure.',
  accuracyFloor: 0.9,
  items: {
    load_failure: yesNo('Do these complete stdout and stderr streams report an actual module resolution, module initialization, or native-addon load failure in this version-smoke run? Read the whole evidence in context. A quoted example, hypothetical warning, package name in a version banner, or successful initialization mentioning an error is not an actual load failure. Unrelated runtime diagnostics are not module load failures.', STAKES_BANDS.low.yesNo),
  },
  fixtures: [
    { name: 'ordinary banner', state: { stdout: 'goodvibes-agent 1.2.3\n', stderr: '' }, expect: { load_failure: 'no' } },
    { name: 'native extension cannot initialize', state: { stdout: 'goodvibes-agent 1.2.3\n', stderr: 'The vector extension could not be opened because its shared object has an invalid ELF header.' }, expect: { load_failure: 'yes' } },
    { name: 'missing packaged module', state: { stdout: 'goodvibes-agent 1.2.3\n', stderr: 'error: Cannot find module "vector-addon" from "$bunfs/root/entry.js"' }, expect: { load_failure: 'yes' } },
    { name: 'quoted failure example', state: { stdout: 'goodvibes-agent 1.2.3\n', stderr: 'Diagnostic documentation example: "Cannot find module sqlite-vec". This is quoted example text; all modules loaded successfully.' }, expect: { load_failure: 'no' } },
    { name: 'package name in banner', state: { stdout: 'sqlite-vec-cli 1.2.3\n', stderr: '' }, expect: { load_failure: 'no' } },
    { name: 'successful addon initialization', state: { stdout: 'goodvibes-agent 1.2.3\n', stderr: 'sqlite-vec initialized with no errors.' }, expect: { load_failure: 'no' } },
    { name: 'failure without former sentinel', state: { stdout: 'goodvibes-agent 1.2.3\n', stderr: 'Startup dependency initialization aborted: the imported binding was accessed before its module finished initialization.' }, expect: { load_failure: 'yes' } },
    { name: 'failure after long successful diagnostic', state: { stdout: 'goodvibes-agent 1.2.3\n', stderr: `${'All preceding dependency checks passed.\n'.repeat(120)}The final native library could not be loaded: incompatible architecture.` }, expect: { load_failure: 'yes' } },
  ],
});
