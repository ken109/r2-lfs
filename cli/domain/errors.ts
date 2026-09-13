/** A problem the user can fix. The CLI prints its message without a stack trace. */
export class UsageError extends Error {
  override readonly name = "UsageError";
}
