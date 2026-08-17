/**
 * Writing a command's standard input, for both drivers (TRE-29).
 *
 * One caller wants this: `sudo -S` reads the password from stdin. It is not
 * passed as an argument because an argument is visible in the host's process
 * list to every account on the machine.
 *
 * Shared rather than written twice because the half that matters is the half
 * that looks like tidying up, and a driver that got it wrong would hang instead
 * of failing — see below.
 */

/**
 * Write standard input, then close it. With nothing to write, just close it.
 *
 * **Closing is not the optional half.** Both drivers open the pipe and would
 * otherwise never touch it again, and a program that reads stdin waits on it:
 * `tail` with no file argument, or `sudo -S` when nothing was sent, sits there
 * until something kills it. Ending the stream is what makes "no input" mean
 * EOF rather than "not yet", so it happens on every call, not only the ones
 * carrying input.
 *
 * The error handler is not defensive clutter. A command can exit before it
 * reads — `sudo` refusing the account before it ever prompts — and the write
 * then lands on a closed pipe as `EPIPE`. On a stream with no `error` listener
 * that is an unhandled event, which takes the process down. Here it is an
 * ordinary outcome, and the result is whatever the command already produced.
 *
 * Nothing is logged, and the input is never copied anywhere: this function is
 * on the path a password travels.
 */
export function sendStdin(stdin: NodeJS.WritableStream | null | undefined, input: string | undefined): void {
  if (!stdin) return;
  guardStdin(stdin);
  if (input !== undefined) stdin.write(input);
  stdin.end();
}

/**
 * Write the first line and leave the pipe open, for a caller that has more.
 *
 * The one operation that needs this is writing a root-owned file: `sudo -S`
 * consumes exactly one line — the password — and then execs `tee`, which reads
 * everything after it. Password and payload therefore share a pipe, and the
 * driver can only write the first part of it.
 *
 * **Whoever receives the stream now owns closing it.** `sendStdin` above closes
 * because nothing else was going to; here the close is the caller's `end()`,
 * and a caller that forgets leaves a command waiting for EOF forever.
 */
export function openStdin(stdin: NodeJS.WritableStream | null | undefined, first: string | undefined): void {
  if (!stdin) return;
  guardStdin(stdin);
  if (first !== undefined) stdin.write(first);
}

/**
 * Swallow the write errors that are ordinary outcomes here.
 *
 * A command can exit before it reads — `sudo` refusing the account before it
 * ever prompts — and the write then lands on a closed pipe as `EPIPE`. On a
 * stream with no `error` listener that is an unhandled event, which takes the
 * process down rather than the command.
 */
function guardStdin(stdin: NodeJS.WritableStream): void {
  stdin.on("error", () => {});
}
