# GEMINI_API_KEYS configuration

Use the comma-separated pool in `.env`:

```dotenv
GEMINI_API_KEYS=key1,key2,key3
```

A quoted list is also accepted:

```dotenv
GEMINI_API_KEYS="key1,key2,key3"
```

Replace the example values with your actual Gemini API keys; do not commit `.env` to source control or paste real keys into logs/issues.

`GEMINI_API_KEYS` is authoritative when it contains valid entries. The agent will not mix in a stale key left in `GEMINI_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`, `GOOGLE_API_KEYS`, or numbered legacy variables. Those are backward-compatible fallbacks only when `GEMINI_API_KEYS` is missing or empty.

For each incoming user message, Wathiq builds one cryptographically shuffled order and reuses that order across the request's model steps, key retries, Fast Lane narration, and image-label parsing. With multiple distinct keys it avoids selecting the same primary as the previous message when possible. A single configured key cannot rotate, and rotation does not make invalid or quota-exhausted keys valid. Keys are not written to logs.
