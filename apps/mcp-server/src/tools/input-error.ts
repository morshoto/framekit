import { z } from "zod/v4";

export function formatInputError(issues: z.core.$ZodIssue[], args: unknown): string {
  const formatIssue = (issue: z.core.$ZodIssue, prefix: PropertyKey[] = []): string => {
    const path = [...prefix, ...issue.path];
    const field = path.length ? path.map(String).join(" ") : "arguments";
    if (issue.code === "invalid_union") {
      const alternatives = issue.errors.map((branch) => branch.map((nested) => formatIssue(nested, path)).join("; "));
      return `${field} must satisfy one of: ${[...new Set(alternatives)].map((alternative) => `(${alternative})`).join(" or ")}`;
    }
    if (issue.path.at(-1) === "approved" && issue.code === "invalid_value") {
      return "execute requires approved: true after a preview";
    }
    if (issue.path.at(-1) === "planDigest" && issue.code === "invalid_format") {
      return "planDigest must be a 64-character lowercase hexadecimal digest";
    }
    const value = path.reduce<unknown>((current, key) => current && typeof current === "object" ? (current as Record<PropertyKey, unknown>)[key] : undefined, args);
    if (issue.code === "invalid_type" && value === undefined) return `${field} is required`;
    if (issue.code === "too_small" && issue.origin === "number") {
      return `${field} must be ${issue.inclusive ? "at least" : "greater than"} ${issue.minimum}`;
    }
    if (issue.code === "too_small" && (issue.origin === "string" || issue.origin === "array")) {
      return `${field} must contain at least ${issue.minimum} ${issue.origin === "string" ? "character(s)" : "item(s)"}`;
    }
    if (issue.code === "invalid_type") return `${field} must be ${issue.expected}`;
    if (issue.code === "invalid_value") return `${field} must be one of ${issue.values.map(String).join(", ")}`;
    if (issue.code === "unrecognized_keys") return `${field} contains unsupported fields: ${issue.keys.join(", ")}`;
    if (issue.code === "custom" && issue.message !== "Invalid input") return `${field}: ${issue.message}`;
    return `${field} is invalid; check the tool's input requirements`;
  };
  const messages = issues.map((issue) => formatIssue(issue));
  return `INPUT_INVALID: ${messages.join("; ")}`;
}
