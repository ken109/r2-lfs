import type { Decision } from "../domain/plan.ts";

export const jsonArg = { json: { type: "boolean", description: "Print machine-readable JSON instead of text" } } as const;

export const layoutArg = {
  layout: {
    type: "string",
    description: "Storage layout (per-repo or shared) when the server cannot be asked",
    valueHint: "per-repo|shared",
  },
} as const;

export function describeDecision(decision: Decision, trash = true): string {
  switch (decision.kind) {
    case "keep":
      return `keep: ${decision.reason}`;
    case "young":
      return "unreferenced, but uploaded too recently to collect";
    case "tier":
      return "would move to Infrequent Access";
    case "delete":
      return trash ? "would move to the trash" : "would be deleted";
    case "foreign":
      return "not an LFS object";
  }
}

export function commaList(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}
