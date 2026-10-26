/** Consistent normalisation of glosses and dictionary labels (case, whitespace, punctuation). */
export function normalizeLabel(value: string): string {
  return String(value ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/^fs:/, '')
    .replace(/[_\-/]+/g, ' ')
    .replace(/[^\p{L}\p{N}\s']/gu, ' ')
    .replace(/'/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** `FS:JONATHAN_YOUNG` -> true. Phase 1 marks names to be spelled with this prefix. */
export function isFsToken(token: string): boolean {
  return /^FS:/i.test(token.trim())
}

/** Letters of a fingerspelled token, word gaps removed (`FS:JONATHAN_YOUNG` -> J..N, Y..G). */
export function fsLetters(token: string): string[] {
  return token
    .replace(/^FS:/i, '')
    .toUpperCase()
    .replace(/[^A-Z]/g, '')
    .split('')
}
