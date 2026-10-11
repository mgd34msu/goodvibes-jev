/** Complete local DOM descriptor fixture, with no entered field values. */
export function liveControlDescriptor(
  element: { readonly tag: string; readonly name: string; readonly submits?: boolean; readonly disabled?: boolean },
  documentUrl = 'https://example.test/',
) {
  return { tag: element.tag, name: element.name, submits: element.submits ?? false, type: '', disabled: element.disabled ?? false,
    role: null, documentUrl, attributes: { name: null, id: '', autocomplete: null, ariaLabel: null, labelledBy: null, labelText: '', placeholder: null, title: null } };
}
