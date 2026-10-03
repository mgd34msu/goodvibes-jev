# Which Google scopes to request, and why

Verified against Google's live documentation on 2026-07-26, and re-verified on 2026-08-05 when the scope set widened to cover mail. Every classification below carries the source it came from.

## The model this assumes

**Each user creates their own OAuth client in their own Google Cloud account.** Nothing is shipped with the product: no client id, no client secret, no project. The agent automates the clicking; the credentials belong to the person who made them.

That single fact removes most of the usual OAuth burden:

- **No Google verification is required.** Verification exists so Google can vouch for an app to *other people's* users. When you are the author and the sole user, there is nobody to vouch to. You click through the "Google hasn't verified this app" screen once and that is the end of it.
- **The 100-user cap is irrelevant.** It caps unverified apps at 100 users; a personal app has one.
- **No third-party security assessment.** That obligation attaches to published apps requesting restricted scopes, not to a personal client.

What does *not* go away is the publishing-status trap. See below: it is the single most consequential detail in the whole flow.

## The trap: Testing publishing status expires credentials in 7 days

> "A Google Cloud Platform project with an OAuth consent screen configured for an external user type and a publishing status of 'Testing' is issued a refresh token expiring in 7 days"
> Source: [OAuth 2.0 guide](https://developers.google.com/identity/protocols/oauth2)

The documented exemption covers apps requesting only `openid`, `email` and `profile`. Calendar and Gmail scopes are not exempt.

So an app left in **Testing** works perfectly for a week and then dies, and the failure surfaces as an ordinary-looking auth error a week after anyone last touched the setup. Publishing status must be moved to **In production**, which is self-certified and immediate. It is *not* the same thing as verification, and it needs no review.

The flow therefore treats this as a first-class step. It sets the status, then **re-reads it to confirm** rather than assuming the click worked, and reports a plain-language warning if it cannot confirm.

## Scope classification, and why it still matters

Google splits scopes into non-sensitive, sensitive, and restricted ([restricted scope list](https://support.google.com/cloud/answer/13464325)).

| Scope | Tier |
| --- | --- |
| `gmail.send` | sensitive |
| `gmail.readonly` | **restricted** |
| `gmail.modify` | **restricted** |
| `gmail.metadata` | **restricted** |
| `gmail.compose` | **restricted** |
| `https://mail.google.com/` | **restricted** |
| `calendar` (full) | sensitive |
| `calendar.events` | sensitive |
| `calendar.readonly` | sensitive |
| `calendar.events.readonly` | sensitive |

Two facts worth knowing:

- **`gmail.send` is sensitive, not restricted.** Google says so directly: *"gmail.send is a sensitive scope. Projects requesting only sensitive scopes do not need to undergo a third-party security assessment"* ([source](https://support.google.com/cloud/answer/13807380)). Sending is cheap; *reading* mail through the Gmail API is the expensive tier.
- **No Calendar scope is restricted.** The word "Calendar" does not appear on Google's restricted-scope page at all.

For a personal app the tier does not create a fee. It still shapes the request, because the narrowest scope that does the job is the right one regardless. It limits blast radius if the credential leaks, and it keeps the consent screen honest about what the agent can reach.

## What this integration requests

**Three scopes, asked for together, in one consent.**

| Scope | Tier | What needs it |
| --- | --- | --- |
| `https://www.googleapis.com/auth/gmail.readonly` | restricted | Reading messages (`api-client.ts`), and the inbound-mail history delta (`history-delta.ts`) |
| `https://www.googleapis.com/auth/gmail.send` | sensitive | Sending through the Gmail API (`messages/send`) |
| `https://www.googleapis.com/auth/calendar.events` | sensitive | Reading and writing events |

### Why all three at once, and not one at a time

Because splitting them produced a real failure. A token was minted carrying
Gmail scopes only; the first Calendar call afterwards returned
`403 insufficient authentication scopes`. A grant carries exactly the scopes
that were approved, so a consent that omits one produces a credential that
looks connected, reports connected, and then refuses a single feature at the
moment somebody uses it, long after the setup that would explain it.

Asking once for everything the product can do costs the person nothing extra:
it is the same consent screen with a longer permissions list. Splitting it
costs them a second consent and a confusing failure in between. `OAUTH_SCOPES`
in the platform runtime is therefore the complete set, and a test pins it.

### On `gmail.readonly` being restricted

It is, and that does not change the decision. The restricted tier triggers a
third-party security assessment for apps **published to other people's users**.
That is not this model. Each person creates the OAuth client in their own
Google Cloud account and is its only user, so there is nobody for Google to
vouch to, the app is self-certified rather than verified, and the 100-user cap
is irrelevant to a one-user app. The consent screen shows its unverified-app
warning once, which the flow tells the person to expect.

The guard that remains is on **width**, not on tier. `gmail.modify` and
`https://mail.google.com/` grant message deletion and full mailbox control, and
nothing in this platform does either. Requesting one would widen what a leaked
credential reaches in exchange for nothing. Those two are listed in
`FORBIDDEN_OAUTH_SCOPES` and a test fails if either is ever added.

### Both APIs are enabled, not just Calendar

`REQUIRED_SERVICES` carries `gmail.googleapis.com` alongside
`calendar-json.googleapis.com`. A scope whose API is switched off fails with a
service-disabled error rather than an auth error, which is a genuinely
confusing thing to debug: the credential is valid and the call still fails.
Both are enabled through gcloud with no clicking.

### Mail over IMAP is still there

The app-password path is unchanged and still needs no OAuth grant at all. What
changed is that the OAuth path no longer pretends mail is out of its scope: the
platform reads and sends mail through the Gmail API when a Google account is
connected that way, so the grant has to permit it.

## Why Google Calendar is read-only on the app-password path

Google refuses HTTP Basic authentication on its CalDAV endpoint:

> "The CalDAV server refuses to authenticate a request unless it arrives over HTTPS with OAuth 2.0 authentication of a Google Account. Attempting to connect over HTTP or using Basic Authentication results in an HTTP `401 Unauthorized` status code."
> Source: [CalDAV v2 guide](https://developers.google.com/workspace/calendar/caldav/v2/guide)

Confirmed by direct probe: a `PROPFIND` with Basic credentials against `apidata.googleusercontent.com/caldav/v2/...` returns `401` and offers no `WWW-Authenticate: Basic` challenge.

So an app password cannot reach Google Calendar over CalDAV, however it is configured. The app-password path uses the **private iCal address** instead, which needs no credential setup and is read-only. Calendar *writes* are the reason the OAuth path exists.

The CalDAV client the connected daemon uses for other providers (`surfaces.calendar.*` config) is still real and still used. It speaks Basic auth for providers that permit it (Fastmail, iCloud, Nextcloud) and Bearer auth for those that require OAuth. It is only Google-plus-app-password that is impossible.

## Shipping a client secret: not applicable here, but worth recording

Google's documentation says embedding a Desktop client's secret in a distributed app is expected: *"the client secret is obviously not treated as a secret"* ([OAuth 2.0 guide](https://developers.google.com/identity/protocols/oauth2)). RFC 8252 §8.5 agrees. Its §6 also states that public native clients **MUST** implement PKCE, which this implementation does.

That guidance would matter if the product shipped one shared client. It does not. Each user's secret is theirs, is stored only in their encrypted secret store, and is never compiled into anything.
