/** Best-effort text filtering. Images and unfamiliar secret formats still require human review. */
export function filterSecrets(text: string): string {
  return text
    .replace(/-----BEGIN [^-]*(?:PRIVATE KEY|CERTIFICATE)-----[\s\S]*?-----END [^-]+-----/g,
      (value) => value.split('\n').map(() => '[REDACTED]').join('\n'))
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9+/_=.-]+/gi, '[REDACTED]')
    .replace(/\b(?:sk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{12,}\b/g, '[REDACTED]')
    .replace(/\bAKIA[A-Z0-9]{16}\b/g, '[REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[REDACTED]')
    .replace(/((?:[A-Za-z0-9_]*(?:api[_-]?key|secret|password|passwd|access[_-]?token|auth[_-]?token|private[_-]?key)[A-Za-z0-9_]*|authorization)["']?\s*[:=]\s*)(["'`])[^\r\n]*?\2/gi, '$1"[REDACTED]"')
    .replace(/((?:[A-Za-z0-9_]*(?:api[_-]?key|secret|password|passwd|access[_-]?token|auth[_-]?token)[A-Za-z0-9_]*|authorization)\s*[:=]\s*)[^\s,;\r\n]+/gi, '$1[REDACTED]')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[REDACTED]@')
    .replace(/([?&](?:key|token|secret|password|api_key)=)[^\s&#"']+/gi, '$1[REDACTED]');
}
