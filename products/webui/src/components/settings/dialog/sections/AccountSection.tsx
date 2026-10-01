/**
 * Account: everything that was Admin's sign-in half. Session login, the
 * explicit operator token, the current sign-in as readable fields (raw JSON
 * behind "Show details"), passkey step-up, the owner profile and the mail and
 * calendar account status, then the profile / email / calendar config groups.
 */
import { useState, type SyntheticEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  clearStoredAuthToken,
  getCurrentAuth,
  invokeMethod,
  login,
  setExplicitAuthToken,
  WEBUI_TOKEN_STORE_KEY,
} from '../../../../lib/goodvibes';
import { queryKeys } from '../../../../lib/queries';
import { compactJson } from '../../../../lib/object';
import { errorDebugValue, formatError } from '../../../../lib/errors';
import { ErrorState } from '../../../feedback/ErrorState';
import { SkeletonBlock } from '../../../feedback/SkeletonBlock';
import { Button } from '../../../ui/Button';
import { Field, Input } from '../../../ui/Field';
import { StepUpSettings } from '../../StepUpSettings';
import { OwnerProfileSettings } from '../../OwnerProfileSettings';
import { MailAccountSettings } from '../../MailAccountSettings';
import { ConfigGroupList, useConfigSettings } from '../ConfigSettings';
import { ReadableValue, SettingsBlock, ShowDetails } from '../parts';
import { groupsForSection } from '../sections';

export function AccountSection() {
  const queryClient = useQueryClient();
  const { groups } = useConfigSettings();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [token, setToken] = useState('');

  const auth = useQuery({ queryKey: queryKeys.auth, queryFn: getCurrentAuth });
  const localAuth = useQuery({ queryKey: queryKeys.localAuth, queryFn: () => invokeMethod('local_auth.status') });

  const loginMutation = useMutation({
    mutationFn: () => login(username, password),
    onSuccess: async () => {
      setPassword('');
      await queryClient.invalidateQueries();
    },
  });
  const tokenMutation = useMutation({
    mutationFn: () => setExplicitAuthToken(token),
    onSuccess: async () => {
      setToken('');
      await queryClient.invalidateQueries();
    },
  });
  const clearTokenMutation = useMutation({
    mutationFn: clearStoredAuthToken,
    onSuccess: async () => {
      await queryClient.invalidateQueries();
    },
  });

  const loginDiagnostics = {
    route: 'POST /login',
    transport: 'raw fetch without Authorization header or cookies',
    currentAuth: auth.data,
    currentAuthError: errorDebugValue(auth.error),
    localAuth: localAuth.data,
    localAuthError: errorDebugValue(localAuth.error),
    loginError: errorDebugValue(loginMutation.error),
  };

  function submitLogin(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (username && password) loginMutation.mutate();
  }

  function submitToken(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (token.trim()) tokenMutation.mutate();
  }

  return (
    <>
      <SettingsBlock
        title="Current sign-in"
        description={(
          <>
            Your daemon owns sign-in. This browser keeps only its session token, under <code>{WEBUI_TOKEN_STORE_KEY}</code>.
          </>
        )}
      >
        {auth.isPending ? (
          <div className="settings-skeleton" aria-label="Loading auth status">
            <SkeletonBlock height={16} width="60%" />
            <SkeletonBlock variant="text" lines={3} />
          </div>
        ) : auth.error ? (
          <ErrorState error={auth.error} onRetry={() => auth.refetch()} title="Auth status unavailable" />
        ) : (
          <ReadableValue value={auth.data} title="Current Auth" />
        )}
      </SettingsBlock>

      <SettingsBlock
        title="Sign in"
        description="Sign in with your daemon username and password. This browser keeps only its own session."
      >
        <form className="settings-form" onSubmit={submitLogin}>
          <Field label="Username">
            <Input value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" />
          </Field>
          <Field label="Password">
            <Input
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              type="password"
              autoComplete="current-password"
            />
          </Field>
          <div className="settings-actions">
            <Button variant="primary" type="submit" disabled={loginMutation.isPending || !username || !password}>
              Sign in
            </Button>
          </div>
        </form>
        {loginMutation.error && <div className="banner warning">{formatError(loginMutation.error)}</div>}
        <ShowDetails label="Show login diagnostics">
          <pre className="settings-pre">{compactJson(loginDiagnostics)}</pre>
        </ShowDetails>
      </SettingsBlock>

      <SettingsBlock
        title="Operator token"
        description={<>Paste a token deliberately. It is checked with <code>sdk.auth.current()</code>; an invalid token is cleared at once.</>}
      >
        <form className="settings-form" onSubmit={submitToken}>
          <Field label="Operator token">
            <Input
              value={token}
              onChange={(event) => setToken(event.target.value)}
              type="password"
              autoComplete="off"
              placeholder="Paste token deliberately"
            />
          </Field>
          <div className="settings-actions">
            <Button disabled={clearTokenMutation.isPending} onClick={() => clearTokenMutation.mutate()}>
              Clear stored token
            </Button>
            <Button type="submit" disabled={tokenMutation.isPending || !token.trim()}>
              Validate and store
            </Button>
          </div>
        </form>
        {tokenMutation.error && <div className="banner warning">{formatError(tokenMutation.error)}</div>}
      </SettingsBlock>

      <StepUpSettings />
      <OwnerProfileSettings />
      <MailAccountSettings />
      <ConfigGroupList groups={groupsForSection('account', groups)} />
    </>
  );
}
