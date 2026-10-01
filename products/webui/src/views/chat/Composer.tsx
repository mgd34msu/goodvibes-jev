import {
  ChangeEvent,
  ClipboardEvent,
  DragEvent,
  FormEvent,
  KeyboardEvent,
  RefObject,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  MouseEvent as ReactMouseEvent,
} from 'react';
import { ArrowUp, ChevronDown, Check, Paperclip, Plus, X } from 'lucide-react';
import { Menu, MenuItem, MenuMeta, MenuSeparator } from '../../components/ui/Menu';
import { formatError } from '../../lib/errors';
import { ModelOption, ProviderOption } from '../../lib/provider-models';
import { dragHasFiles, filesFromDrop, imageFilesFromPaste, isImageFile, previewUrl } from './composer-attachments';
import { MicButton } from '../../components/voice/MicButton';
import { VoiceSettings } from '../../components/voice/VoiceSettings';
import '../../styles/components/chat-composer.css';
import '../../styles/components/voice.css';

// ─── Types ────────────────────────────────────────────────────────────────────

/** A slash-command hint entry shown when the draft starts with "/". */
export interface SlashCommandHint {
  name: string;
  description: string;
}

export interface ComposerProps {
  /**
   * 'centered' on a new chat (the composer sits under the greeting), 'docked'
   * in a conversation (pinned to the bottom above the safe area).
   */
  layout?: 'centered' | 'docked';
  /** Visible placeholder; the accessible name stays "Message GoodVibes". */
  placeholder?: string;
  draft: string;
  attachedFiles: File[];
  isSendPending: boolean;
  sendError: unknown;
  turnError: string;
  renameSessionError: unknown;
  selectModelError: unknown;
  providerOptions: ProviderOption[];
  selectedProviderId: string;
  providerModelOptions: ModelOption[];
  selectedModelRegistryKey: string;
  selectModelPending: boolean;
  composerRef: RefObject<HTMLTextAreaElement | null>;
  fileInputRef: RefObject<HTMLInputElement | null>;
  onDraftChange: (value: string) => void;
  onComposerKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  onSubmit: (event: FormEvent) => void;
  /**
   * STEER: send immediately, interrupting the in-flight turn. Desktop:
   * Ctrl/Cmd+Enter (handled by the caller's key handler). Touch: press and
   * hold the send button. Omitted = the hold affordance is off.
   */
  onSteer?: () => void;
  onFileSelection: (event: ChangeEvent<HTMLInputElement>) => void;
  onRemoveAttachedFile: (index: number) => void;
  onProviderChange: (providerId: string) => void;
  onModelChange: (registryKey: string) => void;
  /**
   * Reasoning-effort levels the CURRENT model actually accepts (from its
   * models.list entry). Empty = the daemon reports none, no control renders.
   */
  effortLevels?: readonly string[];
  /** The persisted effort selection, '' when unset (provider default). */
  currentEffort?: string;
  effortPending?: boolean;
  onEffortChange?: (effort: string) => void;
  /**
   * Optional list of slash-command hints shown when the user types "/" at the
   * start of the composer. Defaults to empty, no menu.
   */
  slashCommands?: readonly SlashCommandHint[];
  /**
   * Optional callback invoked when files are added via drag-and-drop or
   * clipboard paste. When provided, DnD/paste routes files directly here
   * instead of synthesising a native input change event.
   *
   * Integration: wire this to the chat file handler so DnD/paste activate
   * at the ChatView level without needing a hidden-input workaround.
   *
   * The hidden-input native onChange (fileInputRef) is still used for
   * click-to-attach so ChatView compiles unchanged when this prop is absent.
   */
  onFilesAdded?: (files: File[]) => void;
}

// ─── Attachment chip ──────────────────────────────────────────────────────────

interface AttachmentChipProps {
  file: File;
  index: number;
  onRemove: (index: number) => void;
}

function AttachmentChip({ file, index, onRemove }: AttachmentChipProps) {
  const [thumbUrl, setThumbUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!isImageFile(file)) return;
    const url = previewUrl(file);
    setThumbUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  return (
    <span
      key={`${file.name}-${file.lastModified}-${index}`}
      className="composer-attachment"
    >
      {thumbUrl ? (
        <img
          src={thumbUrl}
          alt=""
          aria-hidden
          className="composer-attachment-thumb"
        />
      ) : (
        <Paperclip size={13} aria-hidden />
      )}
      <span className="composer-attachment-name">{file.name}</span>
      <button
        type="button"
        title={`Remove ${file.name}`}
        aria-label={`Remove attachment ${file.name}`}
        onClick={() => onRemove(index)}
      >
        <X size={12} aria-hidden />
      </button>
    </span>
  );
}

// ─── Model and effort menu ────────────────────────────────────────────────────

interface ModelMenuProps {
  providerOptions: ProviderOption[];
  selectedProviderId: string;
  providerModelOptions: ModelOption[];
  selectedModelRegistryKey: string;
  selectModelPending: boolean;
  onProviderChange: (providerId: string) => void;
  onModelChange: (registryKey: string) => void;
  effortLevels: readonly string[];
  currentEffort: string;
  effortPending: boolean;
  onEffortChange?: (effort: string) => void;
}

function effortWord(level: string): string {
  if (!level) return 'Default';
  if (/^x+high$/i.test(level)) return `${level.slice(0, level.length - 4).toUpperCase()}-high`;
  return level.charAt(0).toUpperCase() + level.slice(1);
}

function Selected({ on }: { on: boolean }) {
  return on
    ? <><Check size={16} aria-hidden className="composer-model-check" /><span className="gv-sr-only"> (selected)</span></>
    : <span className="composer-model-check composer-model-check--off" aria-hidden />;
}

/**
 * The model and effort, read as text in the control row ("Claude Opus 4.8 High"),
 * opening one kit menu: the selected provider's models, the effort ladder the
 * current model accepts, and the other providers to switch to.
 */
function ModelMenu({
  providerOptions,
  selectedProviderId,
  providerModelOptions,
  selectedModelRegistryKey,
  selectModelPending,
  onProviderChange,
  onModelChange,
  effortLevels,
  currentEffort,
  effortPending,
  onEffortChange,
}: ModelMenuProps) {
  const selectedModel = providerModelOptions.find((m) => m.registryKey === selectedModelRegistryKey);
  const modelLabel = selectModelPending
    ? 'Switching…'
    : selectedModel?.label ?? (providerModelOptions.length ? 'Choose a model' : 'No models');
  const showEffort = effortLevels.length > 1 && Boolean(onEffortChange);
  const effortLabel = showEffort && currentEffort ? effortWord(currentEffort) : '';
  const selectedProvider = providerOptions.find((provider) => provider.id === selectedProviderId);

  return (
    <Menu
      label="Model and effort"
      placement="top-end"
      width={280}
      className="composer-model-menu"
      trigger={(props) => (
        <button
          {...props}
          type="button"
          className="composer-model-btn"
          aria-label={`Model: ${modelLabel}${effortLabel ? `, effort ${effortLabel}` : ''}`}
          data-pending={selectModelPending || effortPending ? 'true' : undefined}
          disabled={!providerOptions.length}
        >
          <span className="composer-model-label">{modelLabel}</span>
          {effortLabel && <span className="composer-model-effort">{effortLabel}</span>}
          <ChevronDown size={14} aria-hidden />
        </button>
      )}
    >
      <MenuMeta>{selectedProvider?.label ?? 'Models'}</MenuMeta>
      {providerModelOptions.length === 0 && <MenuMeta>No models from this provider.</MenuMeta>}
      {providerModelOptions.map((model) => (
        <MenuItem
          key={model.registryKey}
          icon={<Selected on={model.registryKey === selectedModelRegistryKey} />}
          onSelect={() => onModelChange(model.registryKey)}
        >
          {model.label}
        </MenuItem>
      ))}
      {showEffort && onEffortChange && (
        <>
          <MenuSeparator />
          <MenuMeta>Effort</MenuMeta>
          {['', ...effortLevels].map((level) => (
            <MenuItem
              key={level || 'default'}
              icon={<Selected on={level === currentEffort} />}
              disabled={effortPending}
              onSelect={() => onEffortChange(level)}
            >
              {effortWord(level)}
            </MenuItem>
          ))}
        </>
      )}
      {providerOptions.length > 1 && (
        <>
          <MenuSeparator />
          <MenuMeta>Provider</MenuMeta>
          {providerOptions.map((provider) => (
            <MenuItem
              key={provider.id}
              icon={<Selected on={provider.id === selectedProviderId} />}
              keepOpen
              onSelect={() => onProviderChange(provider.id)}
            >
              {provider.label}
            </MenuItem>
          ))}
        </>
      )}
    </Menu>
  );
}

// ─── Slash-command menu ───────────────────────────────────────────────────────

interface SlashMenuProps {
  /** Pre-filtered commands, parent is the single source of truth. */
  commands: readonly SlashCommandHint[];
  activeIndex: number;
  onSelect: (name: string) => void;
  menuId: string;
  /** Base id prefix for option elements (enables aria-activedescendant). */
  optionIdPrefix: string;
}

function SlashMenu({ commands, activeIndex, onSelect, menuId, optionIdPrefix }: SlashMenuProps) {
  if (!commands.length) return null;

  return (
    <div
      id={menuId}
      role="listbox"
      aria-label="Slash commands"
      className="composer-slash-menu"
    >
      <div className="composer-slash-menu-label">Commands</div>
      {commands.map((cmd, i) => (
        <button
          key={cmd.name}
          id={`${optionIdPrefix}-${i}`}
          type="button"
          role="option"
          aria-selected={i === activeIndex}
          className="composer-slash-item"
          onMouseDown={(e) => {
            // Prevent textarea blur
            e.preventDefault();
            onSelect(cmd.name);
          }}
        >
          <span className="composer-slash-item-name">/{cmd.name}</span>
          <span className="composer-slash-item-desc">{cmd.description}</span>
        </button>
      ))}
    </div>
  );
}

// ─── Composer ─────────────────────────────────────────────────────────────────

export function Composer({
  layout = 'docked',
  placeholder = 'Message GoodVibes',
  draft,
  attachedFiles,
  isSendPending,
  sendError,
  turnError,
  renameSessionError,
  selectModelError,
  providerOptions,
  selectedProviderId,
  providerModelOptions,
  selectedModelRegistryKey,
  selectModelPending,
  composerRef,
  fileInputRef,
  onDraftChange,
  onComposerKeyDown,
  onSubmit,
  onSteer,
  onFileSelection,
  onRemoveAttachedFile,
  onProviderChange,
  onModelChange,
  effortLevels = [],
  currentEffort = '',
  effortPending = false,
  onEffortChange,
  slashCommands = [],
  onFilesAdded,
}: ComposerProps) {
  const [isDragOver, setIsDragOver] = useState(false);
  const [slashActiveIndex, setSlashActiveIndex] = useState(0);
  // When true, the slash menu is suppressed for the current draft value.
  // Resets automatically when the draft changes to a non-slash or empty string.
  const [slashDismissed, setSlashDismissed] = useState(false);
  const slashMenuId = useId();
  const slashOptionIdPrefix = `${slashMenuId}-opt`;

  const showSlashMenu =
    !slashDismissed &&
    slashCommands.length > 0 &&
    draft.startsWith('/') &&
    !draft.includes(' ');

  const filteredSlashCommands = showSlashMenu
    ? draft.length > 1
      ? slashCommands.filter((cmd) =>
          cmd.name.toLowerCase().startsWith(draft.slice(1).toLowerCase()),
        )
      : slashCommands
    : [];

  // Reset slash selection when filtered list changes
  useEffect(() => {
    setSlashActiveIndex(0);
  }, [filteredSlashCommands.length]);

  // Reset dismissed flag when draft changes out of slash territory
  useEffect(() => {
    if (!draft.startsWith('/') || draft.includes(' ')) {
      setSlashDismissed(false);
    }
  }, [draft]);

  // ── Drag-and-drop ──────────────────────────────────────────────────────────

  const handleDragOver = useCallback((event: DragEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (dragHasFiles(event.nativeEvent)) {
      setIsDragOver(true);
    }
  }, []);

  const handleDragLeave = useCallback((event: DragEvent<HTMLFormElement>) => {
    // Only clear when leaving the form element entirely
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
      setIsDragOver(false);
    }
  }, []);

  const handleDrop = useCallback(
    (event: DragEvent<HTMLFormElement>) => {
      event.preventDefault();
      setIsDragOver(false);
      const files = filesFromDrop(event.nativeEvent);
      if (!files.length) return;
      if (onFilesAdded) {
        // Typed callback path, no synthetic events needed.
        onFilesAdded(files);
      } else {
        // Fallback: push files into the hidden input so native onChange fires.
        const dt = new DataTransfer();
        for (const file of files) dt.items.add(file);
        if (fileInputRef.current) {
          fileInputRef.current.files = dt.files;
          fileInputRef.current.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }
    },
    [fileInputRef, onFilesAdded],
  );

  // ── Paste image from clipboard ─────────────────────────────────────────────

  const handlePaste = useCallback(
    (event: ClipboardEvent<HTMLTextAreaElement>) => {
      const images = imageFilesFromPaste(event.nativeEvent);
      if (!images.length) return;
      // Prevent pasting the raw base64 text into the textarea
      event.preventDefault();
      if (onFilesAdded) {
        // Typed callback path, no synthetic events needed.
        onFilesAdded(images);
      } else {
        // Fallback: push images into the hidden input so native onChange fires.
        const dt = new DataTransfer();
        for (const file of images) dt.items.add(file);
        if (fileInputRef.current) {
          fileInputRef.current.files = dt.files;
          fileInputRef.current.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }
    },
    [fileInputRef, onFilesAdded],
  );

  // ── Slash-command keyboard handling ───────────────────────────────────────

  // Press-and-hold the send button = STEER (the touch counterpart of
  // Ctrl+Enter). The hold fires once at the threshold; the click that follows
  // pointer-up is suppressed so the form does not ALSO submit normally.
  const steerHoldTimerRef = useRef<number | null>(null);
  const steerHoldFiredRef = useRef(false);
  const startSteerHold = useCallback(() => {
    steerHoldFiredRef.current = false;
    steerHoldTimerRef.current = window.setTimeout(() => {
      steerHoldTimerRef.current = null;
      steerHoldFiredRef.current = true;
      onSteer?.();
    }, 550);
  }, [onSteer]);
  const cancelSteerHold = useCallback(() => {
    if (steerHoldTimerRef.current !== null) {
      window.clearTimeout(steerHoldTimerRef.current);
      steerHoldTimerRef.current = null;
    }
  }, []);
  const suppressClickAfterSteerHold = useCallback((event: ReactMouseEvent<HTMLButtonElement>) => {
    if (steerHoldFiredRef.current) {
      steerHoldFiredRef.current = false;
      event.preventDefault();
      event.stopPropagation();
    }
  }, []);

  const handleTextareaKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (showSlashMenu && filteredSlashCommands.length > 0) {
        if (event.key === 'ArrowDown') {
          event.preventDefault();
          setSlashActiveIndex((i) => Math.min(filteredSlashCommands.length - 1, i + 1));
          return;
        }
        if (event.key === 'ArrowUp') {
          event.preventDefault();
          setSlashActiveIndex((i) => Math.max(0, i - 1));
          return;
        }
        if (event.key === 'Enter' || event.key === 'Tab') {
          const selected = filteredSlashCommands[slashActiveIndex];
          if (selected) {
            event.preventDefault();
            onDraftChange(`/${selected.name} `);
            return;
          }
        }
        if (event.key === 'Escape') {
          event.preventDefault();
          // Dismiss the menu without wiping the draft.
          setSlashDismissed(true);
          return;
        }
      }
      onComposerKeyDown(event);
    },
    [showSlashMenu, filteredSlashCommands, slashActiveIndex, onDraftChange, onComposerKeyDown],
  );

  function handleSlashSelect(name: string) {
    onDraftChange(`/${name} `);
    composerRef.current?.focus();
  }

  // Dictated transcript lands in the draft for REVIEW BEFORE SENDING, appended after any
  // text already typed, never auto-sent.
  const handleTranscript = useCallback(
    (text: string) => {
      if (!text) return;
      onDraftChange(draft.trim() ? `${draft.trimEnd()} ${text}` : text);
      composerRef.current?.focus();
    },
    [draft, onDraftChange, composerRef],
  );

  const activeSlashOptionId =
    showSlashMenu && filteredSlashCommands.length > 0 && slashActiveIndex >= 0
      ? `${slashOptionIdPrefix}-${slashActiveIndex}`
      : undefined;

  const canSend = Boolean(draft.trim()) || attachedFiles.length > 0;

  return (
    <form
      className={`composer composer--${layout}`}
      onSubmit={onSubmit}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {Boolean(sendError) && <div className="composer-error" role="alert">{formatError(sendError)}</div>}
      {turnError && <div className="composer-error" role="alert">{turnError}</div>}
      {Boolean(renameSessionError) && <div className="composer-error" role="alert">{formatError(renameSessionError)}</div>}
      {Boolean(selectModelError) && <div className="composer-error" role="alert">{formatError(selectModelError)}</div>}

      <div className="composer-box" data-drag-over={isDragOver ? 'true' : undefined}>
        {showSlashMenu && filteredSlashCommands.length > 0 && (
          <SlashMenu
            commands={filteredSlashCommands}
            activeIndex={slashActiveIndex}
            onSelect={handleSlashSelect}
            menuId={slashMenuId}
            optionIdPrefix={slashOptionIdPrefix}
          />
        )}

        {attachedFiles.length > 0 && (
          <div className="composer-attachments">
            {attachedFiles.map((file, index) => (
              <AttachmentChip
                key={`${file.name}-${file.lastModified}-${index}`}
                file={file}
                index={index}
                onRemove={onRemoveAttachedFile}
              />
            ))}
          </div>
        )}

        <textarea
          ref={composerRef}
          value={draft}
          onChange={(event) => onDraftChange(event.target.value)}
          onKeyDown={handleTextareaKeyDown}
          onPaste={handlePaste}
          placeholder={placeholder}
          aria-label="Message GoodVibes"
          aria-autocomplete={showSlashMenu ? 'list' : undefined}
          aria-controls={showSlashMenu && filteredSlashCommands.length > 0 ? slashMenuId : undefined}
          aria-activedescendant={activeSlashOptionId}
          rows={1}
        />
        <input ref={fileInputRef} type="file" hidden multiple onChange={onFileSelection} />

        <div className="composer-toolbar">
          <button
            type="button"
            className="composer-tool composer-attach"
            title="Attach files"
            aria-label="Attach files"
            onClick={() => fileInputRef.current?.click()}
            disabled={isSendPending}
          >
            <Plus size={18} aria-hidden />
          </button>

          <div className="composer-toolbar__end">
            <ModelMenu
              providerOptions={providerOptions}
              selectedProviderId={selectedProviderId}
              providerModelOptions={providerModelOptions}
              selectedModelRegistryKey={selectedModelRegistryKey}
              selectModelPending={selectModelPending}
              onProviderChange={onProviderChange}
              onModelChange={onModelChange}
              effortLevels={effortLevels}
              currentEffort={currentEffort}
              effortPending={effortPending || isSendPending}
              onEffortChange={onEffortChange}
            />
            <MicButton onTranscript={handleTranscript} disabled={isSendPending} />
            <VoiceSettings />
            <button
              type="submit"
              className="send-button"
              title={onSteer
                ? 'Send message (Enter: queues behind an active reply). Steer: Ctrl+Enter or press and hold, sends now, interrupting the current reply.'
                : 'Send message'}
              aria-label="Send message"
              data-ready={canSend && !isSendPending ? 'true' : undefined}
              data-pending={isSendPending ? 'true' : undefined}
              disabled={isSendPending || !canSend}
              onPointerDown={onSteer ? startSteerHold : undefined}
              onPointerUp={onSteer ? cancelSteerHold : undefined}
              onPointerLeave={onSteer ? cancelSteerHold : undefined}
              onPointerCancel={onSteer ? cancelSteerHold : undefined}
              onClick={onSteer ? suppressClickAfterSteerHold : undefined}
            >
              <ArrowUp size={18} aria-hidden />
            </button>
          </div>
        </div>
      </div>
    </form>
  );
}
