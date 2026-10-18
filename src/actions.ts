// The few GitHub Actions runner conventions this action needs, without the @actions/* packages: inputs arrive as
// INPUT_<NAME> environment variables, outputs and the job summary are files, and logs use workflow commands.
import { appendFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

export function input(name: string, env: NodeJS.ProcessEnv = process.env): string {
  return (env[`INPUT_${name.replace(/ /g, "_").toUpperCase()}`] ?? "").trim();
}

export function setOutput(name: string, value: string | number, env: NodeJS.ProcessEnv = process.env): void {
  const file = env.GITHUB_OUTPUT;
  if (!file) return;
  const delimiter = `EOF_${randomUUID()}`;
  appendFileSync(file, `${name}<<${delimiter}\n${value}\n${delimiter}\n`);
}

export function summary(markdown: string, env: NodeJS.ProcessEnv = process.env): void {
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
}

/** Workflow commands need %, CR and LF escaped in their message. */
const escape = (s: string) => s.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");

export const log = {
  info: (message: string) => console.log(message),
  notice: (message: string) => console.log(`::notice::${escape(message)}`),
  warning: (message: string) => console.log(`::warning::${escape(message)}`),
  error: (message: string) => console.log(`::error::${escape(message)}`),
  /** Mask a value in all later log output. */
  secret: (value: string) => value && console.log(`::add-mask::${escape(value)}`),
};
