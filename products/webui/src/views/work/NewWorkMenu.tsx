/**
 * The Work page's one primary action: "New", a menu of what can be started
 * from here, each in a kit Dialog. Task (tasks.create), hosted session
 * (sessions.hosted.create; the detach policy defaults to the daemon's own
 * setting and is omitted from the call unless chosen), CI watch
 * (ci.watches.create), and a one-off CI status check (ci.status) that creates
 * nothing.
 */
import { useState, type SyntheticEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, GitBranch, ListTodo, Plus, Search, Server } from 'lucide-react';
import { sdk } from '../../lib/goodvibes';
import type { SessionsHostedCreateInput } from '../../lib/goodvibes';
import { queryKeys } from '../../lib/queries';
import { hostedSessionFromResult } from '../../lib/hosted-sessions';
import { formatError, isMethodUnavailableError, isSessionClosedError } from '../../lib/errors';
import { useToast } from '../../lib/toast';
import { Button } from '../../components/ui/Button';
import { Checkbox } from '../../components/ui/Checkbox';
import { Dialog } from '../../components/ui/Dialog';
import { Field, Input } from '../../components/ui/Field';
import { Menu, MenuItem } from '../../components/ui/Menu';
import { Select } from '../../components/ui/Select';
import { CiReportDetail, type CiReport } from './CiWatchDetail';
import { NativeIntakeForm } from './NativeIntakeForm';
import type { ClientLifetime } from '../../lib/client-lifetime';

type NewKind = 'native' | 'task' | 'hosted' | 'ci-watch' | 'ci-status';

export interface NewWorkMenuProps {
  lifetime: ClientLifetime;
  /** A created item to open: its Work key (`hosted:<id>`, ...). */
  onCreated: (key: string) => void;
}

function TaskForm({ onDone }: { onDone: () => void }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [task, setTask] = useState('');
  const create = useMutation({
    mutationFn: () => sdk.operator.tasks.create({ task: task.trim() }),
    onSuccess: async () => {
      setTask('');
      await queryClient.invalidateQueries({ queryKey: queryKeys.tasks });
      toast({ title: 'Task submitted', tone: 'success' });
      onDone();
    },
    onError: (error: unknown) => toast({
      title: 'Failed to submit task',
      description: isSessionClosedError(error) ? 'That session is closed.' : formatError(error),
      tone: 'danger',
    }),
  });
  const submit = (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (task.trim() && !create.isPending) create.mutate();
  };
  return (
    <form id="work-new-form" className="work-form" onSubmit={submit}>
      <Field label="Task" help="The daemon queues it and runs it in the background.">
        <Input
          autoFocus
          placeholder="Describe a task to submit"
          value={task}
          onChange={(e) => setTask(e.target.value)}
          disabled={create.isPending}
        />
      </Field>
      <div className="work-form__actions">
        <Button type="submit" variant="primary" disabled={!task.trim() || create.isPending}>
          {create.isPending ? 'Submitting…' : 'Submit'}
        </Button>
      </div>
    </form>
  );
}

function HostedForm({ onDone }: { onDone: (key?: string) => void }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [workspaceRoot, setWorkspaceRoot] = useState('');
  const [title, setTitle] = useState('');
  const [detachPolicy, setDetachPolicy] = useState<'' | 'kill' | 'survive'>('');
  const create = useMutation({
    mutationFn: (input: SessionsHostedCreateInput) => sdk.operator.sessions.hosted.create(input),
    onSuccess: (result) => {
      const session = hostedSessionFromResult(result);
      void queryClient.invalidateQueries({ queryKey: queryKeys.hostedSessionsAll });
      if (!session) {
        toast({ title: 'Hosted session created', description: 'The daemon did not return a session in a shape this client understands; refresh to find it.', tone: 'info' });
        onDone();
        return;
      }
      toast({ title: 'Hosted session created', tone: 'success' });
      onDone(`hosted:${session.id}`);
    },
    onError: (error: unknown) => toast({ title: 'Could not create hosted session', description: formatError(error), tone: 'danger' }),
  });
  const submit = (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    const root = workspaceRoot.trim();
    if (!root || create.isPending) return;
    create.mutate({
      workspaceRoot: root,
      ...(title.trim() ? { title: title.trim() } : {}),
      ...(detachPolicy ? { detachPolicy } : {}),
    });
  };
  return (
    <form className="work-form" onSubmit={submit}>
      <Field label="Workspace path">
        <Input autoFocus required placeholder="/home/you/project" value={workspaceRoot} onChange={(e) => setWorkspaceRoot(e.target.value)} disabled={create.isPending} />
      </Field>
      <Field label="Title (optional)">
        <Input value={title} onChange={(e) => setTitle(e.target.value)} disabled={create.isPending} />
      </Field>
      <Field label="When the last client leaves">
        <Select<'' | 'kill' | 'survive'>
          aria-label="Detach policy"
          value={detachPolicy}
          onChange={setDetachPolicy}
          disabled={create.isPending}
          options={[
            { value: '', label: 'Use the daemon default' },
            { value: 'kill', label: 'End the session' },
            { value: 'survive', label: 'Keep it running' },
          ]}
        />
      </Field>
      <div className="work-form__actions">
        <Button type="submit" variant="primary" disabled={create.isPending || !workspaceRoot.trim()}>
          {create.isPending ? 'Creating…' : 'Create'}
        </Button>
      </div>
    </form>
  );
}

function CiWatchForm({ onDone }: { onDone: (key?: string) => void }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [repo, setRepo] = useState('');
  const [ref, setRef] = useState('');
  const [prNumber, setPrNumber] = useState('');
  const [deliveryChannel, setDeliveryChannel] = useState('');
  const [triggerFixSession, setTriggerFixSession] = useState(false);
  const create = useMutation({
    mutationFn: () => sdk.operator.ci.watches.create({
      repo: repo.trim(),
      ...(ref.trim() ? { ref: ref.trim() } : {}),
      ...(prNumber.trim() ? { prNumber: Number(prNumber.trim()) } : {}),
      deliveryChannel: deliveryChannel.trim(),
      triggerFixSession,
    }),
    onSuccess: async (result) => {
      toast({ title: 'Watch created', tone: 'success' });
      await queryClient.invalidateQueries({ queryKey: queryKeys.ciWatches });
      const id = (result as { watch?: { id?: unknown } } | undefined)?.watch?.id;
      onDone(typeof id === 'string' ? `ci-watch:${id}` : undefined);
    },
    onError: (error: unknown) => toast({ title: 'Failed to create watch', description: formatError(error), tone: 'danger' }),
  });
  const submit = (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!repo.trim() || !deliveryChannel.trim() || create.isPending) return;
    create.mutate();
  };
  return (
    <form className="work-form" onSubmit={submit}>
      <Field label="Repository">
        <Input autoFocus required placeholder="owner/repo" value={repo} onChange={(e) => setRepo(e.target.value)} disabled={create.isPending} />
      </Field>
      <div className="work-form__pair">
        <Field label="Ref (optional)">
          <Input placeholder="main" value={ref} onChange={(e) => setRef(e.target.value)} disabled={create.isPending} />
        </Field>
        <Field label="Pull request (optional)">
          <Input inputMode="numeric" pattern="[0-9]*" placeholder="123" value={prNumber} onChange={(e) => setPrNumber(e.target.value.replace(/\D/g, ''))} disabled={create.isPending} />
        </Field>
      </div>
      <Field label="Delivery channel" help="Where the result is sent, for example a Slack channel.">
        <Input required value={deliveryChannel} onChange={(e) => setDeliveryChannel(e.target.value)} disabled={create.isPending} />
      </Field>
      <Checkbox checked={triggerFixSession} onChange={setTriggerFixSession} disabled={create.isPending}>
        Start a fix session on failure
      </Checkbox>
      <div className="work-form__actions">
        <Button type="submit" variant="primary" disabled={create.isPending || !repo.trim() || !deliveryChannel.trim()}>
          {create.isPending ? 'Creating…' : 'Create watch'}
        </Button>
      </div>
    </form>
  );
}

function CiStatusForm() {
  const { toast } = useToast();
  const [repo, setRepo] = useState('');
  const [ref, setRef] = useState('');
  const [prNumber, setPrNumber] = useState('');
  const [report, setReport] = useState<CiReport | null>(null);
  const check = useMutation({
    mutationFn: () => sdk.operator.ci.status({
      repo: repo.trim(),
      ...(ref.trim() ? { ref: ref.trim() } : {}),
      ...(prNumber.trim() ? { prNumber: Number(prNumber.trim()) } : {}),
    }),
    onSuccess: (result) => setReport(result.report),
    onError: (error: unknown) => toast({
      title: isMethodUnavailableError(error) ? 'CI status unavailable on this daemon' : 'Check failed',
      description: isMethodUnavailableError(error) ? undefined : formatError(error),
      tone: 'danger',
    }),
  });
  const submit = (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (repo.trim() && !check.isPending) check.mutate();
  };
  return (
    <form className="work-form" onSubmit={submit}>
      <Field label="Repository">
        <Input autoFocus required placeholder="owner/repo" value={repo} onChange={(e) => setRepo(e.target.value)} disabled={check.isPending} />
      </Field>
      <div className="work-form__pair">
        <Field label="Ref (optional)">
          <Input value={ref} onChange={(e) => setRef(e.target.value)} disabled={check.isPending} />
        </Field>
        <Field label="Pull request (optional)">
          <Input inputMode="numeric" pattern="[0-9]*" value={prNumber} onChange={(e) => setPrNumber(e.target.value.replace(/\D/g, ''))} disabled={check.isPending} />
        </Field>
      </div>
      <div className="work-form__actions">
        <Button type="submit" variant="primary" disabled={check.isPending || !repo.trim()}>
          {check.isPending ? 'Checking…' : 'Check status'}
        </Button>
      </div>
      {report && <CiReportDetail report={report} />}
    </form>
  );
}

const TITLES: Record<NewKind, { title: string; description: string }> = {
  native: { title: 'Native request', description: 'Capture original text and let Jev decide admission to the work ledger.' },
  task: { title: 'New task', description: 'Submit a task for the daemon to run.' },
  hosted: { title: 'New hosted session', description: 'A conversation that runs inside the daemon and survives this tab.' },
  'ci-watch': { title: 'Watch CI', description: 'Get notified when a repository, ref or pull request finishes its checks.' },
  'ci-status': { title: 'Check CI status', description: 'Look up any repository, ref or pull request once, without creating a watch.' },
};

export function NewWorkMenu({ onCreated, lifetime }: NewWorkMenuProps) {
  const [open, setOpen] = useState<NewKind | null>(null);
  const close = () => setOpen(null);
  const done = (key?: string) => {
    setOpen(null);
    if (key) onCreated(key);
  };
  return (
    <>
      <Menu
        label="New"
        placement="bottom-end"
        trigger={(props) => (
          <Button {...props} variant="primary" icon={<Plus aria-hidden="true" />}>
            New
            <ChevronDown className="work-new__chevron" aria-hidden="true" />
          </Button>
        )}
      >
        <MenuItem icon={<ListTodo />} onSelect={() => setOpen('native')}>Native request</MenuItem>
        <MenuItem icon={<ListTodo />} onSelect={() => setOpen('task')}>Task</MenuItem>
        <MenuItem icon={<Server />} onSelect={() => setOpen('hosted')}>Hosted session</MenuItem>
        <MenuItem icon={<GitBranch />} onSelect={() => setOpen('ci-watch')}>CI watch</MenuItem>
        <MenuItem icon={<Search />} onSelect={() => setOpen('ci-status')}>Check CI status</MenuItem>
      </Menu>
      <Dialog
        open={open !== null}
        onClose={close}
        title={open ? TITLES[open].title : ''}
        description={open ? TITLES[open].description : undefined}
      >
        {open === 'native' && <NativeIntakeForm lifetime={lifetime} onOpenSession={(id) => done(`hosted:${id}`)} />}
        {open === 'task' && <TaskForm onDone={() => done()} />}
        {open === 'hosted' && <HostedForm onDone={done} />}
        {open === 'ci-watch' && <CiWatchForm onDone={done} />}
        {open === 'ci-status' && <CiStatusForm />}
      </Dialog>
    </>
  );
}
