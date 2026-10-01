/** Remove a known resolved credential by exact bytes, without interpreting text. */
export function redactOwnedCredential(text: string, credential: string): string {
  return credential.length > 0 ? text.split(credential).join('[credential omitted]') : text;
}
