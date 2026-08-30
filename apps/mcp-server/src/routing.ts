import type { EditorIdentity, RuntimeCapabilities } from "@framekit/runtime";

export type EditingRouteOperation =
  | "timeline.edit"
  | "editor.native.edit"
  | "timeline.publish.new-project"
  | "timeline.export";

export type EditingRouteFallback = "none" | "external-renderer";

export interface EditingRouteRequest {
  operation: EditingRouteOperation;
  fallback?: EditingRouteFallback;
}

export interface EditorRoutingContext {
  connection: {
    state: string;
    lastError?: { code: string; message: string };
  };
  editor?: {
    identity: EditorIdentity;
    capabilities: RuntimeCapabilities;
  };
  native?: Record<string, boolean>;
}

export interface EditingRouteReason {
  code: "EDITOR_SELECTED" | "EDITOR_UNAVAILABLE" | "CAPABILITY_UNAVAILABLE" | "EXTERNAL_FALLBACK_SELECTED";
  message: string;
  connectionState: string;
  cause?: {
    code: string;
    message: string;
  };
}

export interface EditingRoute {
  operation: EditingRouteOperation;
  status: "editor-selected" | "external-fallback-selected" | "unavailable";
  selectedPath: "editor" | "external-renderer" | "none";
  requiredCapabilities: string[];
  missingCapabilities: string[];
  editor?: EditorIdentity;
  workflow: string[];
  reason: EditingRouteReason;
}

export const EDITOR_FIRST_WORKFLOW = [
  "connection.status",
  "editor.inspect",
  "project.inspect",
  "editing.route",
  "editing.intent.resolve",
  "timeline.edit.preview",
  "timeline.edit.execute",
  "context.inspect",
  "edit.diff",
  "edit.verify",
];

export const EDITOR_FIRST_MCP_INSTRUCTIONS = [
  "Framekit uses an editor-first workflow for every editing request.",
  "1. Call connection.status to establish whether the expected editor is connected.",
  "2. Call editor.inspect to read the selected editor identity and capabilities.",
  "3. Inspect the active project with project.inspect before selecting an editing path.",
  "4. Call editing.route and use only a path whose required capabilities are advertised.",
  "5. Resolve intent when needed, then preview before execute; never mutate on an unavailable capability.",
  "6. Observe the result, then use edit.diff and edit.verify to confirm the change.",
  "An external renderer is never an implicit substitute for a connected editor. Select fallback: external-renderer explicitly and report the structured reason returned by editing.route.",
].join("\n");

type Requirement = {
  label: string;
  satisfied: (context: EditorRoutingContext) => boolean;
};

const operationRequirements: Record<EditingRouteOperation, Requirement[]> = {
  "timeline.edit": [
    editorRequirement("projectRead"),
    editorRequirement("timelineSnapshotRead"),
    {
      label: "editor.timelineWrite|editor.timelineArtifactWrite",
      satisfied: (context) => Boolean(
        context.editor?.capabilities.editor.timelineWrite
        || context.editor?.capabilities.editor.timelineArtifactWrite,
      ),
    },
    editorRequirement("readAfterWrite"),
    editorRequirement("rollback"),
  ],
  "editor.native.edit": [
    nativeRequirement("selectionEdit"),
    nativeRequirement("timelineFocus"),
    nativeRequirement("undo"),
  ],
  "timeline.publish.new-project": [
    editorRequirement("timelinePublishNewProject"),
  ],
  "timeline.export": [
    editorRequirement("videoExport"),
  ],
};

export function resolveEditingRoute(
  request: EditingRouteRequest,
  context: EditorRoutingContext,
): EditingRoute {
  const requirements = operationRequirements[request.operation];
  const requiredCapabilities = requirements.map((requirement) => requirement.label);
  const missingCapabilities = requirements
    .filter((requirement) => !requirement.satisfied(context))
    .map((requirement) => requirement.label);
  const editor = context.editor?.identity;

  if (request.fallback === "external-renderer") {
    const cause = externalFallbackCause(context, missingCapabilities);
    return {
      operation: request.operation,
      status: "external-fallback-selected",
      selectedPath: "external-renderer",
      requiredCapabilities,
      missingCapabilities,
      ...(editor ? { editor } : {}),
      workflow: [...EDITOR_FIRST_WORKFLOW],
      reason: {
        code: "EXTERNAL_FALLBACK_SELECTED",
        message: "The external renderer was selected explicitly; Framekit will not invoke it or bypass the editor silently.",
        connectionState: context.connection.state,
        cause,
      },
    };
  }

  const offlineArtifactEdit = request.operation === "timeline.edit"
    && context.editor?.capabilities.editor.timelineArtifactWrite === true;
  if (context.connection.state !== "ready" && !offlineArtifactEdit) {
    return {
      operation: request.operation,
      status: "unavailable",
      selectedPath: "none",
      requiredCapabilities,
      missingCapabilities,
      ...(editor ? { editor } : {}),
      workflow: [...EDITOR_FIRST_WORKFLOW],
      reason: editorUnavailableReason(context, missingCapabilities),
    };
  }

  if (missingCapabilities.length > 0 || !context.editor) {
    return {
      operation: request.operation,
      status: "unavailable",
      selectedPath: "none",
      requiredCapabilities,
      missingCapabilities,
      ...(editor ? { editor } : {}),
      workflow: [...EDITOR_FIRST_WORKFLOW],
      reason: {
        code: "CAPABILITY_UNAVAILABLE",
        message: `The connected editor cannot satisfy ${request.operation}; no alternate editor path was selected.`,
        connectionState: context.connection.state,
      },
    };
  }

  return {
    operation: request.operation,
    status: "editor-selected",
    selectedPath: "editor",
    requiredCapabilities,
    missingCapabilities: [],
    editor,
    workflow: [...EDITOR_FIRST_WORKFLOW],
    reason: {
      code: "EDITOR_SELECTED",
      message: "The connected editor satisfies the required capabilities; continue with the preview and execute contract.",
      connectionState: context.connection.state,
    },
  };
}

function editorRequirement(capability: keyof RuntimeCapabilities["editor"]): Requirement {
  return {
    label: `editor.${capability}`,
    satisfied: (context) => Boolean(context.editor?.capabilities.editor[capability]),
  };
}

function nativeRequirement(capability: string): Requirement {
  return {
    label: `native.${capability}`,
    satisfied: (context) => context.native?.[capability] === true,
  };
}

function externalFallbackCause(
  context: EditorRoutingContext,
  missingCapabilities: string[],
): NonNullable<EditingRouteReason["cause"]> {
  if (context.connection.state !== "ready") {
    return context.connection.lastError ?? {
      code: "EDITOR_UNAVAILABLE",
      message: `The expected editor is unavailable while the connection is ${context.connection.state}.`,
    };
  }
  if (missingCapabilities.length > 0 || !context.editor) {
    return {
      code: "CAPABILITY_UNAVAILABLE",
      message: "The connected editor does not advertise every capability required by this operation.",
    };
  }
  return {
    code: "USER_SELECTED_EXTERNAL_FALLBACK",
    message: "The caller explicitly selected the external renderer even though the editor is available.",
  };
}

function editorUnavailableReason(
  context: EditorRoutingContext,
  missingCapabilities: string[],
): EditingRouteReason {
  if (context.connection.state !== "ready") {
    return {
      code: "EDITOR_UNAVAILABLE",
      message: `The expected editor is unavailable while the connection is ${context.connection.state}.`,
      connectionState: context.connection.state,
      ...(context.connection.lastError ? { cause: context.connection.lastError } : {}),
    };
  }
  if (missingCapabilities.length > 0 || !context.editor) {
    return {
      code: "CAPABILITY_UNAVAILABLE",
      message: "The connected editor does not advertise every capability required by this operation.",
      connectionState: context.connection.state,
    };
  }
  return {
    code: "CAPABILITY_UNAVAILABLE",
    message: "The connected editor does not advertise every capability required by this operation.",
    connectionState: context.connection.state,
  };
}
