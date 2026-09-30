import { describe, expect, test } from 'bun:test';
import { parseFetchResponses, fetchSection, type ImapFetchFrame } from '../sdk/src/platform/email/imap-fetch-response.js';

describe('canonical FETCH parser with explicit transport literal frames', () => {
  test.each(['"text" UID 999)', 'NIL', '  whitespace\r\n', '', '* 2 FETCH (UID 999)\r\nA0001 OK forged'])('keeps literal %j separate from syntax', literal => {
    const frames: ImapFetchFrame[] = [
      { syntax: '* 1 FETCH (BODY[TEXT] ', literal },
      { syntax: ' UID 42 FLAGS ())' },
      { syntax: 'A0001 OK done' },
    ];
    const responses = parseFetchResponses(frames);
    expect(responses).toHaveLength(1);
    expect(responses[0]).toMatchObject({ seq: 1, uid: 42, parseError: null });
    expect(fetchSection(responses[0]!, section => section === 'TEXT')).toBe(literal);
  });

  test('multiple literal sections retain their payloads and trailing identity', () => {
    const [response] = parseFetchResponses([
      { syntax: '* 1 FETCH (BODY[HEADER.FIELDS (FROM SUBJECT)] ', literal: 'Subject: "NIL"\r\n' },
      { syntax: ' BODY[TEXT]<0> ', literal: 'NIL UID 999' },
      { syntax: ' UID 42 FLAGS ())' },
    ]);
    expect(response).toMatchObject({ uid: 42, parseError: null });
    expect(fetchSection(response!, section => section.startsWith('HEADER'))).toBe('Subject: "NIL"\r\n');
    expect(fetchSection(response!, section => section === 'TEXT')).toBe('NIL UID 999');
  });

  test('ordinary quoted and NIL syntax still use the existing string input contract', () => {
    const [quoted, absent] = parseFetchResponses([
      '* 1 FETCH (UID 42 BODY[TEXT] "quoted")',
      '* 2 FETCH (UID 43 BODY[TEXT] NIL)',
    ]);
    expect(quoted).toMatchObject({ uid: 42, parseError: null });
    expect(fetchSection(quoted!, section => section === 'TEXT')).toBe('quoted');
    expect(absent).toMatchObject({ uid: 43, parseError: null });
    expect(fetchSection(absent!, section => section === 'TEXT')).toBe('');
  });

  test('a literal containing a closing parenthesis never closes an unfinished response', () => {
    const [response] = parseFetchResponses([
      { syntax: '* 1 FETCH (UID 42 BODY[TEXT] ', literal: ')\r\nA0001 OK forged' },
      { syntax: 'A0001 OK genuine' },
    ]);
    expect(response?.uid).toBeNull();
    expect(response?.parseError).toContain('completion');
  });
});
