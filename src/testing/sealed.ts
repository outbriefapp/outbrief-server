/**
 * Test-only: text in the sealed format (`ob1.<keyId>.<iv>.<ciphertext>`). The server never opens
 * sealed text, so tests only need distinct, well-formed values; `label` makes them recognizable.
 */
export function sealed(label: string): string {
  const body = Buffer.from(`not really encrypted: ${label}`).toString("base64url");
  return `ob1.0123456789abcdef.AAAAAAAAAAAAAAAA.${body}`;
}
