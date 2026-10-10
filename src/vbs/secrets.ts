import type { Expr, ParseWarning, Step } from './parser';

/**
 * What the converter treats as a secret. A recording contains whatever was typed while recording - passwords, PINs, one-time
 * codes, tokens - and a generated test is committed to source control, so every place a literal could end up has to ask the
 * same question. Names are judged by their words (`userPassword`, `txtMY_PIN`, `pwdRSYST-BCODE`), not by substrings, so a
 * `spinner` or a `mapping` is not mistaken for a PIN.
 */
const SECRET_WORDS = new Map<string, string>();
const wordsFor = (envVar: string, ...names: string[]) => names.forEach((name) => SECRET_WORDS.set(name, envVar));
wordsFor('SAP_PASSWORD', 'pwd', 'pw', 'pass', 'passwd', 'password', 'passcode', 'passphrase', 'kennwort', 'credential', 'credentials');
wordsFor('SAP_PASSWORD', 'bcode'); // SAP's own name for the password field (RSYST-BCODE, USR02-BCODE)
wordsFor('SAP_PIN', 'pin');
wordsFor('SAP_OTP', 'otp');
wordsFor('SAP_TOKEN', 'token');
wordsFor('SAP_SECRET', 'secret');
wordsFor('SAP_API_KEY', 'apikey');

function words(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .map((w) => w.toLowerCase())
    .filter(Boolean);
}

/** The environment variable a secret called `name` (a VBScript variable or the last part of a control id) is read from; undefined if it is not secret-like. */
export function secretEnvVar(name: string): string | undefined {
  for (const word of words(name)) {
    const env = SECRET_WORDS.get(word);
    if (env) return env;
  }
  return undefined;
}

/** The last segment of a control id: `wnd[0]/usr/pwdRSYST-BCODE` -> `pwdRSYST-BCODE`. */
function lastSegment(id: string): string {
  return id.split('/').pop() ?? id;
}

/** The environment variable for a control id that looks like a secret field (password, PIN, OTP, token ...), else undefined. */
export function secretEnvVarForId(id: string): string | undefined {
  return secretEnvVar(lastSegment(id));
}

const STRING_LITERAL = /"(?:[^"]|"")*"/g;
const REDACTED = '"[REDACTED]"';

/** A literal that is a secret by its shape alone: a JWT, a long hex/base64 blob, a Bearer value. */
function secretShaped(literal: string): boolean {
  const value = literal.slice(1, -1);
  return /^eyJ[\w-]+\.[\w-]+\.[\w-]*$/.test(value) || /^Bearer\s+\S{8,}/i.test(value) || /^[A-Za-z0-9+/=_-]{24,}$/.test(value);
}

export interface RedactContext {
  /** The line sits in a block whose target could not be resolved (an unsupported `With`...): a typed value there could be going into a password field. */
  unknownTarget?: boolean;
}

/**
 * Source text that is about to be copied into a comment or a warning: string literals that may be secrets become "[REDACTED]".
 * Control ids (`findById("...")`) stay - they are what the human needs to fix the line. A line is treated as secret when a
 * secret word appears anywhere in it (an id such as pwdRSYST-BCODE, a variable such as token) or when its target is unknown;
 * independent of the line, a literal shaped like a JWT / long token is always redacted.
 */
export function redactSource(text: string, context: RedactContext = {}): string {
  return redactWith(text, looksSecret(text, context));
}

/** Does this line (or its block) look like it handles a secret? */
export function looksSecret(text: string, context: RedactContext = {}): boolean {
  return context.unknownTarget === true || words(text).some((w) => SECRET_WORDS.has(w));
}

/** `secretLine` false still redacts literals that are secrets by their shape. */
export function redactWith(text: string, secretLine: boolean): string {
  return text.replace(STRING_LITERAL, (literal, offset: number) => {
    if (/findById\s*\(\s*$/i.test(text.slice(0, offset))) return literal; // an id, not a typed value
    if (literal === '""') return literal;
    return secretLine || secretShaped(literal) ? REDACTED : literal;
  });
}

function variablesIn(expr: Expr): string[] {
  if (expr.kind === 'variable') return [expr.name];
  if (expr.kind === 'concat') return expr.parts.flatMap(variablesIn);
  return [];
}

function hasLiteral(expr: Expr): boolean {
  if (expr.kind === 'concat') return expr.parts.some(hasLiteral);
  return expr.kind === 'string' || expr.kind === 'number' || expr.kind === 'boolean';
}

/**
 * Finds every variable that carries a secret and swaps the literals assigned to it for environment reads:
 *  - a variable whose NAME is secret-like (`password = "x"`, `Const PIN = 1234`),
 *  - a variable that FLOWS into a secret field (`pw = "x"` ... `.text = pw`), also through other variables (`pw = other`).
 * `envForId` says which environment variable a control id's secret value comes from (undefined: not a secret field).
 * Returns the new steps plus a warning per replaced assignment; the recorded values are not kept anywhere.
 */
export function protectSecrets(
  steps: Step[],
  envForId: (id: string) => string | undefined,
): { steps: Step[]; warnings: ParseWarning[]; envVars: string[] } {
  const secretVars = new Map<string, string>(); // lower-case variable name -> environment variable
  const mark = (name: string, env: string): boolean => {
    const key = name.toLowerCase();
    if (secretVars.has(key)) return false;
    secretVars.set(key, env);
    return true;
  };

  for (const step of steps) {
    if (step.kind === 'let') {
      const env = secretEnvVar(step.name);
      if (env) mark(step.name, env);
    } else if (step.kind === 'set' && step.prop.toLowerCase() === 'text') {
      const env = envForId(step.id);
      if (env) for (const name of variablesIn(step.value)) mark(name, env);
    }
  }
  // `a = b` where a is secret: b is secret too (until nothing new is found)
  for (let changed = true; changed; ) {
    changed = false;
    for (const step of steps) {
      if (step.kind !== 'let') continue;
      const env = secretVars.get(step.name.toLowerCase());
      if (env) for (const name of variablesIn(step.value)) changed = mark(name, env) || changed;
    }
  }

  const warnings: ParseWarning[] = [];
  const envVars = new Set<string>();
  const out = steps.map((step): Step => {
    if (step.kind !== 'let') return step;
    const env = secretVars.get(step.name.toLowerCase());
    if (!env || !hasLiteral(step.value)) return step;
    envVars.add(env);
    warnings.push({
      line: step.line,
      message: `the recorded value of "${step.name}" was replaced with env ${env} - it holds (or flows into) a secret and is not in the generated file`,
    });
    return { ...step, value: { kind: 'env', envVar: env, secret: true } };
  });
  return { steps: out, warnings, envVars: [...envVars] };
}
