import {
  cloneElement,
  forwardRef,
  isValidElement,
  useId,
  type InputHTMLAttributes,
  type ReactElement,
  type ReactNode,
  type TextareaHTMLAttributes,
} from 'react';
import '../../styles/components/ui.css';

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input(
  { className, ...rest },
  ref,
) {
  return <input ref={ref} className={['gv-input', className ?? ''].filter(Boolean).join(' ')} {...rest} />;
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea(
  { className, ...rest },
  ref,
) {
  return <textarea ref={ref} className={['gv-input', className ?? ''].filter(Boolean).join(' ')} {...rest} />;
});

interface ControlProps {
  id?: string;
  'aria-describedby'?: string;
  'aria-invalid'?: boolean | 'true' | 'false';
}

export interface FieldProps {
  label: ReactNode;
  help?: ReactNode;
  error?: ReactNode;
  className?: string;
  /** One control (Input, Textarea, Select). It receives the id and aria wiring. */
  children: ReactElement<ControlProps>;
}

/** Label above, control, then help text or an error, wired with id / aria-describedby. */
export function Field({ label, help, error, className, children }: FieldProps) {
  const autoId = useId();
  const control = isValidElement(children) ? children : null;
  const controlId = control?.props.id ?? `${autoId}-control`;
  const helpId = help ? `${autoId}-help` : undefined;
  const errorId = error ? `${autoId}-error` : undefined;
  const describedBy = [control?.props['aria-describedby'], helpId, errorId].filter(Boolean).join(' ') || undefined;

  return (
    <div className={['gv-field', className ?? ''].filter(Boolean).join(' ')}>
      <label className="gv-field__label" htmlFor={controlId}>{label}</label>
      {control && cloneElement(control, {
        id: controlId,
        'aria-describedby': describedBy,
        'aria-invalid': error ? true : control.props['aria-invalid'],
      })}
      {help && !error && <div id={helpId} className="gv-field__help">{help}</div>}
      {error && <div id={errorId} className="gv-field__error" role="alert">{error}</div>}
    </div>
  );
}
