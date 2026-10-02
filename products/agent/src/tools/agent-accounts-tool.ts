/**
 * The `accounts` tool: the durable record of every account the agent created.
 *
 * Creating accounts autonomously, in service of work the owner asked for, is
 * authorized, it is why the agent has its own email address. What was never
 * authorized is doing it invisibly. So the safety mechanism here is visibility,
 * not prohibition: every signup is recorded at creation time, the list is
 * enumerable, and every entry carries the secret-store key name that revocation
 * starts from.
 *
 * `AgentAccountRegistry` had all of this and no caller outside its own test, so
 * an account created today would leave no trace. This is the caller.
 *
 * The credential itself never reaches this tool. Only `credentialSecretKey`,
 * the NAME of the secret-store entry holding it, the registry rejects
 * secret-looking text in every field.
 *
 * The one boundary that does not move: an outward effect refused because
 * untrusted content was read this turn stays refused. A web page describing a
 * signup form cannot cause a signup.
 */

import type { ToolRegistry } from '@goodvibes-jev/engine/sdk/platform/tools';
import type { Tool } from '@goodvibes-jev/engine/sdk/platform/types';
import { AgentAccountRegistry, type AgentAccountRecord } from '@goodvibes-jev/engine/sdk/platform/google';
import { mintAddressFor } from '@goodvibes-jev/engine/sdk/platform/google';
import { getSessionExpectationBook } from '../agent/signup/session-expectations.ts';
import { evaluateOutwardEffect, getSessionUntrustedContentLedger } from '../trust/untrusted-content.ts';

const ACCOUNT_ACTIONS = ['list', 'alias', 'record', 'forget', 'sweep'] as const;

type ToolOutput = { readonly success: true; readonly output: string } | { readonly success: false; readonly error: string };

function failure(message: string): ToolOutput {
  return { success: false, error: message };
}

function ok(output: string): ToolOutput {
  return { success: true, output };
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function renderAccount(account: AgentAccountRecord): string {
  return [
    `${account.id}  ${account.serviceDomain}`,
    `    created ${account.createdAt} for ${account.purpose}`,
    `    signed up at ${account.serviceUrl} as ${account.aliasAddress}`,
    `    credential: secret-store key ${account.credentialSecretKey}`,
  ].join('\n');
}

export interface AgentAccountsToolOptions {
  readonly registry: AgentAccountRegistry;
  /**
   * The owner's own mailbox, which per-signup aliases are minted from. Read at
   * call time so connecting an account mid-session takes effect.
   */
  readonly baseAddress?: () => string | null;
  /** Secret-store key names, so sweep can drop records whose credential is gone. */
  readonly knownSecretKeys?: () => Promise<readonly string[]>;
}

export function createAgentAccountsTool(options: AgentAccountsToolOptions): Tool {
  const { registry } = options;

  return {
    definition: {
      name: 'accounts',
      description: 'Register of accounts created for the owner.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: [...ACCOUNT_ACTIONS],
            description: 'What to do. Record an account as you create it.',
          },
          serviceDomain: { type: 'string', description: 'Service domain, for alias and record.' },
          serviceUrl: { type: 'string', description: 'The http(s) signup page, for record.' },
          aliasAddress: { type: 'string', description: 'The per-signup alias address used, for record.' },
          purpose: { type: 'string', description: 'What the account is for, for record.' },
          credentialSecretKey: {
            type: 'string',
            description: 'Secret-store key NAME. Never the credential itself.',
          },
          id: { type: 'string', description: 'Account record id, for forget.' },
          maxAgeDays: { type: 'number', description: 'For sweep: drop records older than this.' },
        },
        required: ['action'],
      },
    },
    execute: async (rawArgs: Record<string, unknown>): Promise<ToolOutput> => {
      const action = readString(rawArgs.action).toLowerCase();
      if (!ACCOUNT_ACTIONS.includes(action as (typeof ACCOUNT_ACTIONS)[number])) {
        return failure(`accounts needs one of: ${ACCOUNT_ACTIONS.join(', ')}.`);
      }

      try {
        if (action === 'alias') {
          // Each signup gets its own delivery address. That address is the
          // correlation key a verification mail is later matched on, so it must
          // be minted per signup rather than reused.
          const serviceDomain = readString(rawArgs.serviceDomain);
          if (!serviceDomain) return failure('accounts action:"alias" needs the serviceDomain you are signing up at.');
          const base = options.baseAddress?.() ?? null;
          if (!base) {
            return failure('No mailbox is connected to mint a signup alias from. Connect one with: /google connect');
          }
          const alias = mintAddressFor(base, serviceDomain);
          // Opening the expectation here is what lets the verification mail
          // this signup provokes be recognised later. Nothing else opens one,
          // so unsolicited "verify your account" mail is never acted on.
          const expectation = getSessionExpectationBook().openExpectation({
            serviceDomain: alias.serviceDomain,
            recipientAddress: alias.address,
            purpose: readString(rawArgs.purpose) || `signing up at ${alias.serviceDomain}`,
          });
          return ok([
            `Use ${alias.address} as the email address for this signup.`,
            `It delivers to ${alias.baseAddress}, and it is what a verification mail for ${alias.serviceDomain} will be matched on.`,
            `Watching for its verification mail until ${expectation.expiresAt}; read it with google action:"mail.verification".`,
            'Record the account with accounts action:"record" once it exists.',
          ].join('\n'));
        }

        if (action === 'list') {
          const snapshot = registry.snapshot();
          if (snapshot.accounts.length === 0) {
            return ok(`No accounts have been recorded. The register lives at ${snapshot.path}.`);
          }
          const dropped = snapshot.droppedOnRead > 0
            ? `\n\n${snapshot.droppedOnRead} malformed record(s) were dropped when reading ${snapshot.path}.`
            : '';
          return ok(`${snapshot.accounts.map(renderAccount).join('\n')}${dropped}`);
        }

        if (action === 'record') {
          // Recording is the visible half of an outward effect that already
          // happened, so it is gated the same way the signup itself is: page
          // text cannot drive the agent into registering an account.
          const decision = await evaluateOutwardEffect({
            request: {
              toolName: 'accounts',
              action: 'accounts.record',
              description: `recording an account created at ${readString(rawArgs.serviceDomain) || 'a service'}`,
            },
            ledger: getSessionUntrustedContentLedger(),
            // Enumerated rather than left to the coarse rule. Every field of a
            // record is text a page could have supplied, the domain and the URL
            // most of all, since a record pointing at an attacker's host is how
            // a forged signup would be made to look like a real one. Without
            // these, recording an account after reading any page was refused
            // outright, which is the friction that gets a check switched off.
            content: {
              serviceDomain: readString(rawArgs.serviceDomain) || undefined,
              serviceUrl: readString(rawArgs.serviceUrl) || undefined,
              aliasAddress: readString(rawArgs.aliasAddress) || undefined,
              purpose: readString(rawArgs.purpose) || undefined,
            },
            taintOptions: {
              // The domain and the URL are short and high-signal: the value
              // itself is the payload, so containment is the test rather than
              // length. The alias is deliberately NOT here, the agent minted it
              // for this signup, so of course it appears in the mail that signup
              // provoked, and testing it would refuse every real record.
              exactMatchFields: ['serviceDomain', 'serviceUrl'],
            },
            requestedBy: 'owner-direct',
          });
          if (!decision.allowed) return failure(`${decision.reason} ${decision.fix}`);

          const account = registry.record({
            serviceDomain: readString(rawArgs.serviceDomain),
            serviceUrl: readString(rawArgs.serviceUrl),
            aliasAddress: readString(rawArgs.aliasAddress),
            purpose: readString(rawArgs.purpose),
            credentialSecretKey: readString(rawArgs.credentialSecretKey),
          });
          return ok(`Recorded:\n${renderAccount(account)}`);
        }

        if (action === 'forget') {
          const id = readString(rawArgs.id);
          if (!id) return failure('accounts action:"forget" needs the record id, from accounts action:"list".');
          const removed = registry.forget(id);
          return ok(
            `Forgot the record for ${removed.serviceDomain}. This removed the RECORD only, the account at ${removed.serviceUrl} still exists, and its credential is still under secret-store key ${removed.credentialSecretKey}.`,
          );
        }

        const known = options.knownSecretKeys ? await options.knownSecretKeys() : undefined;
        const maxAgeDays = typeof rawArgs.maxAgeDays === 'number' ? rawArgs.maxAgeDays : undefined;
        const result = registry.sweep({
          ...(known === undefined ? {} : { knownSecretKeys: known }),
          ...(maxAgeDays === undefined ? {} : { maxAgeDays }),
        });
        return ok(
          result.removed.length === 0
            ? `Nothing to reap; ${result.remaining} record(s) remain.`
            : `Reaped ${result.removed.length} record(s) whose credential was gone or which aged out: ${result.removed.map((entry) => entry.id).join(', ')}. ${result.remaining} remain.`,
        );
      } catch (error) {
        return failure(error instanceof Error ? error.message : String(error));
      }
    },
  };
}

export function registerAgentAccountsTool(registry: ToolRegistry, options: AgentAccountsToolOptions): void {
  if (!registry.has('accounts')) registry.register(createAgentAccountsTool(options));
}
