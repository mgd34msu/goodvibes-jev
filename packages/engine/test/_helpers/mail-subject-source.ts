/** In-memory IMAP transport: production protocol reader, no sockets or accounts. */
import { EventEmitter } from 'node:events';
import type { Socket } from 'node:net';
import { EmailService, type EmailServiceDeps } from '../../sdk/src/platform/email/email-service.js';
import { EmailReplySubjectSourceOwner } from '../../sdk/src/platform/email/reply-subject-source.js';
import { testDescribeSenderClaim, throwingEmailTransport } from './platform-email-fixtures.js';

export interface ReadPlan {
  readonly uidValidity?: number | null;
  readonly subject?: string;
  readonly wireUid?: number | null;
  readonly headerPartial?: string;
  readonly gone?: boolean;
  readonly headerGate?: Promise<void>;
  readonly logoutGate?: Promise<void>;
}

class MailSocket extends EventEmitter {
  constructor(private readonly plan: ReadPlan) { super(); }
  feed(text: string): void { this.emit('data', Buffer.from(text)); }
  write(command: string, _encoding: string, done: (error?: Error) => void): boolean {
    done();
    void this.answer(command);
    return true;
  }
  private async answer(command: string): Promise<void> {
    const tag = command.split(' ')[0];
    const end = `${tag} OK complete\r\n`;
    const uid = Number(/UID FETCH (\d+)/.exec(command)?.[1]);
    if (command.includes(' EXAMINE ')) {
      this.feed(`* 2 EXISTS\r\n${this.plan.uidValidity === null ? '' : `* OK [UIDVALIDITY ${this.plan.uidValidity ?? 7}]\r\n`}${end}`);
    } else if (command.includes('BODY.PEEK[HEADER]')) {
      await this.plan.headerGate;
      if (this.plan.gone) { this.feed(end); return; }
      const headers = `From: sender@example.invalid\r\nSubject: ${this.plan.subject ?? 'Original subject'}\r\nMessage-ID: <synthetic@example.invalid>\r\n\r\n`;
      const wireUid = this.plan.wireUid === null ? '' : `UID ${this.plan.wireUid ?? uid} `;
      this.feed(`* 1 FETCH (${wireUid}BODY[HEADER]${this.plan.headerPartial ?? ''} {${Buffer.byteLength(headers)}}\r\n${headers})\r\n${end}`);
    } else if (command.includes('BODYSTRUCTURE')) {
      this.feed(`* 1 FETCH (UID ${uid} BODYSTRUCTURE NIL)\r\n${end}`);
    } else if (command.includes('BODY.PEEK[TEXT]')) {
      this.feed(`* 1 FETCH (UID ${uid} BODY[TEXT] "Synthetic body")\r\n${end}`);
    } else if (command.includes('SEARCH')) {
      this.feed(`* SEARCH\r\n${end}`);
    } else {
      if (command.includes(' LOGOUT')) await this.plan.logoutGate;
      this.feed(end);
    }
  }
  destroy(): this { this.emit('close'); return this; }
}

export function mailFixture(options: {
  readonly plans?: ReadPlan[];
  readonly owner?: EmailReplySubjectSourceOwner | null;
  readonly overrides?: Partial<EmailServiceDeps>;
} = {}) {
  const plans = options.plans ?? [{}];
  const owner = options.owner === null ? undefined : options.owner ?? new EmailReplySubjectSourceOwner();
  const config: Record<string, unknown> = {
    'email.enabled': true,
    'email.imapHost': 'imap.example.invalid',
    'email.imapPort': 993,
    'email.smtpHost': 'smtp.example.invalid',
    'email.smtpPort': 587,
    'email.username': 'owner@example.invalid',
    'email.passwordRef': 'goodvibes://secrets/goodvibes/SYNTHETIC_PASSWORD',
    'email.fromAddress': 'owner@example.invalid',
    'email.mailbox': 'INBOX',
  };
  let connections = 0;
  const deps: EmailServiceDeps = {
    getConfig: (key) => config[key],
    secretsManager: { get: async () => 'synthetic-test-value' },
    transport: throwingEmailTransport,
    describeSenderClaim: testDescribeSenderClaim,
    replySubjectSourceOwner: owner,
    imapSocketFactory: async () => {
      const plan = plans[connections++];
      if (!plan) throw new Error('No synthetic read plan.');
      const socket = new MailSocket(plan);
      setImmediate(() => socket.feed('* OK synthetic mailbox\r\n'));
      return socket as unknown as Socket;
    },
    ...options.overrides,
  };
  return { service: new EmailService(deps), owner, config, deps, connections: () => connections };
}

export function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
export const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
