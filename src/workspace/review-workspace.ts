import type { ToolDefinition } from "@earendil-works/pi-coding-agent"

// ReviewWorkspace (CONTEXT.md): the confined repository view exposed to
// filesystem-capable AgentInvocations. This module is the one seam the review
// pipeline depends on — it owns the virtual root and both filesystem-facing
// model tools, so a future hosted sandbox is a different adapter with the
// same signature, not a pipeline redesign. Nothing outside src/workspace/
// imports the underlying library.

// The stable model-facing root. Prompts and tool results show this path;
// host absolute paths never appear in either.
export const REVIEW_WORKSPACE_ROOT = "/repo"

export interface ReviewWorkspace {
  // The virtual root, for prompt assembly and tool descriptions.
  readonly root: string
  // Both filesystem-facing tools resolve through one shared overlay, so
  // reads observe this invocation's earlier scratch writes and neither tool
  // retains a separate host-backed path.
  readonly readTool: ToolDefinition
  readonly bashTool: ToolDefinition
}
