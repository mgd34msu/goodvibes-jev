import { Button } from '../ui/Button';

/** A background refresh must not implicitly authorize overwriting a newer value. */
export function SettingsDraftConflict({ onReset, onSave }: {
  readonly onReset: () => void;
  readonly onSave: () => void;
}) {
  return (
    <div className="settings-field-conflict" role="alert">
      <p>This setting changed elsewhere. Use the latest value or save your edit.</p>
      <Button size="sm" onClick={onReset}>Use latest</Button>
      <Button size="sm" onClick={onSave}>Save my edit</Button>
    </div>
  );
}
