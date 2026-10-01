/**
 * Building blocks every settings section uses: a block (16/600 title, one
 * line of description, content), a setting row (label and description left,
 * control right, a hairline between rows), and readable fields with the raw
 * JSON behind a "Show details" disclosure.
 */
import { ChevronRight } from 'lucide-react';
import { createContext, useContext, useId, useState, type ReactNode } from 'react';
import { DataBlock } from '../../DataBlock';
import { asRecord } from '../../../lib/object';

/**
 * The heading level a SettingsBlock title takes: h3 directly under the page
 * title, h4 when the block sits inside a titled section of a multi-section page.
 */
export const SettingsHeadingLevel = createContext<3 | 4>(3);

export function SettingsBlock({
  title,
  description,
  actions,
  children,
  className,
  testId,
}: {
  title: ReactNode;
  description?: ReactNode;
  /** Right-aligned beside the title: at most one action. */
  actions?: ReactNode;
  children?: ReactNode;
  className?: string;
  testId?: string;
}) {
  const titleId = useId();
  const Heading = useContext(SettingsHeadingLevel) === 4 ? 'h4' : 'h3';
  return (
    <section
      className={['settings-block', className ?? ''].filter(Boolean).join(' ')}
      aria-labelledby={titleId}
      data-testid={testId}
    >
      <div className="settings-block__head">
        <div className="settings-block__titles">
          <Heading id={titleId} className="settings-block__title">{title}</Heading>
          {description && <p className="settings-block__description">{description}</p>}
        </div>
        {actions && <div className="settings-block__actions">{actions}</div>}
      </div>
      {children}
    </section>
  );
}

/** One setting: label and description on the left, its control on the right. */
export function SettingRow({
  label,
  description,
  control,
  htmlFor,
}: {
  label: ReactNode;
  description?: ReactNode;
  control: ReactNode;
  /** When the control is a labelable element, point the label at it. */
  htmlFor?: string;
}) {
  return (
    <div className="settings-row">
      <div className="settings-row__text">
        {htmlFor
          ? <label className="settings-row__label" htmlFor={htmlFor}>{label}</label>
          : <div className="settings-row__label">{label}</div>}
        {description && <div className="settings-row__description">{description}</div>}
      </div>
      <div className="settings-row__control">{control}</div>
    </div>
  );
}

function humanizeKey(key: string): string {
  const spaced = key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function scalarText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : null;
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  return null;
}

/**
 * The scalar fields of a record, one level of nesting flattened ("Identity
 * subject"), arrays summarized as a count or a short list. Pure; exported for
 * tests.
 */
export function readableFields(value: unknown, limit = 12): { label: string; value: string }[] {
  const out: { label: string; value: string }[] = [];
  const record = asRecord(value);
  const push = (label: string, raw: unknown) => {
    if (out.length >= limit) return;
    const text = scalarText(raw);
    if (text !== null && text !== '') {
      out.push({ label, value: text });
      return;
    }
    if (Array.isArray(raw)) {
      const scalars = raw.map(scalarText).filter((t): t is string => Boolean(t));
      if (scalars.length === raw.length && raw.length > 0 && raw.length <= 4) out.push({ label, value: scalars.join(', ') });
      else out.push({ label, value: `${raw.length} item${raw.length === 1 ? '' : 's'}` });
    }
  };
  for (const [key, raw] of Object.entries(record)) {
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      for (const [child, childRaw] of Object.entries(raw as Record<string, unknown>)) {
        if (childRaw && typeof childRaw === 'object' && !Array.isArray(childRaw)) continue;
        push(`${humanizeKey(key)} ${humanizeKey(child).toLowerCase()}`, childRaw);
      }
    } else {
      push(humanizeKey(key), raw);
    }
  }
  return out;
}

/** Readable label/value rows, with the full raw value behind "Show details". */
export function ReadableValue({
  value,
  title,
  empty = 'Nothing reported.',
}: {
  value: unknown;
  /** Names the raw block for the copy button. */
  title: string;
  empty?: string;
}) {
  const fields = readableFields(value);
  return (
    <div className="settings-readable-value">
      {fields.length > 0 ? (
        <dl className="settings-readable">
          {fields.map((field) => (
            <div key={field.label} className="settings-readable__row">
              <dt className="settings-readable__key">{field.label}</dt>
              <dd className="settings-readable__value">{field.value}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="settings-empty">{empty}</p>
      )}
      {value !== undefined && value !== null && (
        <ShowDetails>
          <DataBlock title={title} value={value} />
        </ShowDetails>
      )}
    </div>
  );
}

/** A "Show details" disclosure: a ghost button with a chevron, the content below. */
export function ShowDetails({ label = 'Show details', children }: { label?: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <div className="settings-details">
      <button
        type="button"
        className="settings-details__toggle"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((v) => !v)}
      >
        <ChevronRight className="settings-details__chevron" aria-hidden="true" />
        {open ? label.replace(/^Show/, 'Hide') : label}
      </button>
      {open && <div id={id} className="settings-details__body">{children}</div>}
    </div>
  );
}
