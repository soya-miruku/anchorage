const MAX_LOG_LINE_CHARACTERS = 8_192;

const SECRET_ASSIGNMENT =
  /(\b(?:authorization|password|passwd|token|access[_-]?token|refresh[_-]?token|secret|api[_-]?key|auth)\b\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/giu;
const AUTHORIZATION_VALUE = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/giu;
const URL_CREDENTIALS = /([a-z][a-z0-9+.-]*:\/\/)([^/@\s:]+):([^/@\s]+)@/giu;
const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gu;
const DOCKER_AUTH_JSON = /("auth"\s*:\s*")[^"]+(")/giu;

export function redactSensitiveText(value) {
  let text = String(value ?? "").slice(0, MAX_LOG_LINE_CHARACTERS);
  text = text.replace(URL_CREDENTIALS, "$1[REDACTED]@");
  text = text.replace(AUTHORIZATION_VALUE, "$1 [REDACTED]");
  text = text.replace(JWT, "[REDACTED JWT]");
  text = text.replace(DOCKER_AUTH_JSON, "$1[REDACTED]$2");
  text = text.replace(SECRET_ASSIGNMENT, "$1[REDACTED]");
  return text;
}

export class RedactedLogTail {
  #lines = [];
  #maximumLines;
  #maximumCharacters;
  #characters = 0;

  constructor({ maximumLines = 200, maximumCharacters = 65_536 } = {}) {
    this.#maximumLines = maximumLines;
    this.#maximumCharacters = maximumCharacters;
  }

  push(line) {
    const redacted = redactSensitiveText(line);
    this.#lines.push(redacted);
    this.#characters += redacted.length;

    while (
      this.#lines.length > this.#maximumLines ||
      this.#characters > this.#maximumCharacters
    ) {
      const removed = this.#lines.shift();
      this.#characters -= removed.length;
    }

    return redacted;
  }

  snapshot() {
    return [...this.#lines];
  }

  clear() {
    this.#lines = [];
    this.#characters = 0;
  }
}
