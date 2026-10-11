/** Consumer proof: public CI composition names its real source, admission and result types. */
import { CiWatchAutoMinter, CiWatchService, CiWatchStore, startAdmittedCiRepair,
  type CiWatchServiceDeps, type CiRepairRequest, type CiRepairAdmissionHost, type FixSessionStarter,
  type CiWatchSubscription, type CiWatchCheckResult } from '@goodvibes-jev/engine/sdk/platform/ci-watch';
declare const dependencies: CiWatchServiceDeps;
declare const host: CiRepairAdmissionHost;
declare const request: CiRepairRequest;
declare const starter: FixSessionStarter;
const service = new CiWatchService(dependencies);
const minter = new CiWatchAutoMinter({ service, workingDirectory: '/owned/workspace' });
const store = new CiWatchStore('/owned/ci-watches.json');
const subscriptions: Promise<CiWatchSubscription[]> = store.load();
const observed: Promise<CiWatchCheckResult> = service.checkWatch('issued-watch');
const admitted = startAdmittedCiRepair(host, request, starter);
// A persisted subscription is scheduling evidence, not a source/admission request.
// @ts-expect-error A watch cannot replace the required live owner and claim/recheck boundaries.
startAdmittedCiRepair(host, {} as CiWatchSubscription, starter);
export { minter, subscriptions, observed, admitted };
