/** Root-owned, least-capability mail constructors for explicit inbox factories. */
import { EmailService } from '@goodvibes-jev/engine/sdk/platform/email';
import { composeMailDeps } from './mail-composition.js';
import type { DaemonInboxControls, DaemonInboxFactory } from './daemon-handler-composition.js';
import type { HandlerContext, OwnedHandlerSurface } from '../daemon/handlers/context.js';
import type { RoutingRegistration } from '../daemon/handlers/index.js';

type MailInput = Omit<Parameters<typeof composeMailDeps>[0], 'registerDispose'>;

/** Even a factory that throws after construction cannot orphan subscriptions. */
export async function registerOwnedMailInbox(factory: DaemonInboxFactory, context: HandlerContext,
  routing: RoutingRegistration, controls: Pick<DaemonInboxControls, 'gatePolling'>,
  mailInput: MailInput): Promise<OwnedHandlerSurface> {
  const mailClosers: Array<() => void> = [];
  let retired = false;
  const closeMail = (): void => {
    if (retired) return;
    retired = true;
    const errors: unknown[] = [];
    for (const close of mailClosers.reverse()) { try { close(); } catch (error) { errors.push(error); } }
    if (errors.length) throw new AggregateError(errors, 'Inbox mail lifetimes did not close cleanly');
  };
  try {
    const registration = await factory(context, routing, { ...controls,
      createEmailService() {
        if (retired) throw new Error('Inbox mail constructor is retired');
        const disposers: Array<() => void> = [];
        let closed = false;
        const close = (): void => {
          if (closed) return;
          closed = true;
          const errors: unknown[] = [];
          for (const dispose of disposers.reverse()) { try { dispose(); } catch (error) { errors.push(error); } }
          if (errors.length) throw new AggregateError(errors, 'Inbox mail service did not close cleanly');
        };
        mailClosers.push(close);
        try {
          const { emailServiceDeps } = composeMailDeps({ ...mailInput, registerDispose: dispose => { disposers.push(dispose); } });
          return Object.freeze({ service: new EmailService(emailServiceDeps), close });
        } catch (error) { close(); throw error; }
      },
    });
    let closing: Promise<void> | undefined;
    return {
      ...(registration.ready === undefined ? {} : { ready: registration.ready }),
      close() {
        if (!closing) closing = Promise.resolve().then(async () => {
          try { await registration.close(); } finally { closeMail(); }
        });
        return closing;
      },
    };
  } catch (error) {
    closeMail(); throw error;
  }
}
