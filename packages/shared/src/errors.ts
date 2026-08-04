/** Base error for all toolc-originated failures. Messages must be actionable. */
export class ToolcError extends Error {
  constructor(
    message: string,
    readonly hint?: string,
  ) {
    super(hint ? `${message}\n  hint: ${hint}` : message);
    this.name = new.target.name;
  }
}

export class ConfigError extends ToolcError {}

/** A downstream MCP server failed to connect or respond. */
export class DownstreamError extends ToolcError {
  constructor(
    readonly sourceId: string,
    message: string,
    hint?: string,
  ) {
    super(`[downstream:${sourceId}] ${message}`, hint);
  }
}
