/**
 * Turns the bytes of a recording into text. SAP GUI's "Record and Playback" dialog offers an encoding, and its default
 * `Unicode` is UTF-16 (little endian, with a byte order mark): read as UTF-8 every other character is a NUL and nothing
 * parses. This understands UTF-16 LE / BE (with BOM), UTF-8 (with or without BOM) and, as a fallback, plain ANSI text.
 */
export function decodeRecording(bytes: Buffer): string {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return bytes.subarray(2).toString('utf16le');
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    const swapped = Buffer.from(bytes.subarray(2));
    swapped.swap16();
    return swapped.toString('utf16le');
  }
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return bytes.subarray(3).toString('utf8');
  // No byte order mark: a text file whose second byte is NUL in most pairs is UTF-16 without a BOM (some tools write that).
  const sample = bytes.subarray(0, Math.min(bytes.length, 400));
  let nulsAtOdd = 0;
  for (let i = 1; i < sample.length; i += 2) if (sample[i] === 0) nulsAtOdd++;
  if (sample.length >= 4 && nulsAtOdd > sample.length / 4) return bytes.toString('utf16le');
  return bytes.toString('utf8');
}
