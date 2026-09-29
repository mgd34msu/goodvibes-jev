/**
 * A clipboard tool asked for an image type answers with bytes; they are an
 * image of that type only when they open with the signature the format
 * defines. An error text, an empty answer or another format's bytes is not
 * pasted as an image, however long it is, and a small real image is.
 */
import { describe, expect, test } from 'bun:test';
import { isImageData } from '../sdk/src/platform/utils/clipboard.ts';

const bytes = (...values: number[]): Uint8Array => Uint8Array.from(values);
const text = (value: string): Uint8Array => new TextEncoder().encode(value);
const concat = (...parts: Uint8Array[]): Uint8Array => Uint8Array.from(parts.flatMap((part) => [...part]));

const PNG = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d);
const JPEG = bytes(0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10);
const GIF87 = text('GIF87a\u0001\u0000');
const GIF89 = text('GIF89a\u0001\u0000');
const WEBP = concat(text('RIFF'), bytes(0x24, 0x00, 0x00, 0x00), text('WEBPVP8 '));

describe('isImageData', () => {
  test('each format\'s signature is an image of that format, even when tiny', () => {
    expect(isImageData(PNG, 'image/png')).toBe(true);
    expect(isImageData(JPEG, 'image/jpeg')).toBe(true);
    expect(isImageData(GIF87, 'image/gif')).toBe(true);
    expect(isImageData(GIF89, 'image/gif')).toBe(true);
    expect(isImageData(WEBP, 'image/webp')).toBe(true);
  });

  test('another format\'s bytes are not the requested type', () => {
    expect(isImageData(JPEG, 'image/png')).toBe(false);
    expect(isImageData(PNG, 'image/jpeg')).toBe(false);
    expect(isImageData(PNG, 'image/gif')).toBe(false);
    expect(isImageData(concat(text('RIFF'), bytes(0, 0, 0, 0), text('WAVE')), 'image/webp')).toBe(false);
  });

  test('a long error text or an empty answer is not an image', () => {
    expect(isImageData(text(`Error: target image/png not available ${'x'.repeat(500)}`), 'image/png')).toBe(false);
    expect(isImageData(new Uint8Array(0), 'image/png')).toBe(false);
    expect(isImageData(bytes(0x89, 0x50, 0x4e), 'image/png')).toBe(false);
  });

  test('a type with no signature here is not an image', () => {
    expect(isImageData(PNG, 'image/bmp')).toBe(false);
  });
});
