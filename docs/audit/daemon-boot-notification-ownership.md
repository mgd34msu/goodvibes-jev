# Notification shutdown prerequisite for daemon boot

The upstream daemon boot tasks acquire a Notifier without retaining a shutdown
owner. Before porting that startup path, its delivery lifetime must be closable.
A synthetic regression on Jev main `b9312519` held a delivery, disposed the queue,
then released a retryable failure. The queue scheduled another attempt after
disposal; advancing that captured retry called the fixture transport twice.
No network request or semantic provider reading was needed to reproduce it.

DeliveryQueue now permanently closes admission when disposed, clears queued
retries, and checks closure after an admitted transport or failure reading
settles. A stale timer callback cannot reopen the queue. Successful admitted
transports still report their actual success. A failure settling after shutdown
rejects with a value-free DeliveryError instead of scheduling a retry or creating
a misleading dead letter. Refused replay retains existing dead letters.

An admitted replay temporarily removes its prior row while it owns the attempt.
If that replay rejects without a settled outcome, including shutdown or an
unavailable failure reading, it restores the exact prior record once through
the same bounded FIFO policy. Successful replay and ordinary
terminal replacement keep their existing receipts and metrics. The entire replay,
including restoration, is registered before callbacks run and is drained by
close(). Concurrent batches skip rows another batch has already consumed.

The additive close() method performs that immediate shutdown and awaits admitted
attempts. Admission is registered before invoking the callback, including callbacks
that request close synchronously. The callback still owns its transport timeout
or cancellation: close does not claim to cancel an API that accepts no signal,
and remains pending if an admitted callback never settles. Delivery failures stay
observable through the original delivery promises. A callback must not await the
same owner's close promise while it is itself being drained.

Notifier dispose() also detaches event subscriptions and prevents reattachment.
Its close() awaits complete admitted notifications and queue work. Closing between
two channels prevents the second send; closing one notifier preserves unrelated
subscribers. Tests use synthetic transports, controlled promises and captured
retry callbacks. No actual Slack or Discord messages, credentials, or provider
calls are involved.

This is an engine lifecycle prerequisite. Product boot wiring, plugin ownership,
notification metadata-only policy, default inbox composition and executable
startup remain separate work; this change does not advertise them as complete.
