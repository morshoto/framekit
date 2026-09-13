import type {
  CapabilityDescriptor,
  CapabilityGuarantee,
  EditorIdentity,
  RuntimeCapabilities,
} from "@framekit/runtime";

export type EditingRouteOperation =
  | "project.list"
  | "project.select"
  | "project.inspect"
  | "timeline.inspect"
  | "editor.live.inspect"
  | "timeline.edit"
  | "timeline.mask.add"
  | "editor.native.edit"
  | "editor.native.picture-in-picture"
  | "artifact.edit"
  | "timeline.publish.new-project"
  | "timeline.export";

export type EditingRouteFallback = "none" | "external-renderer";
export type CapabilityUnavailableCategory = "background-api" | "canonical-snapshot" | "native-ui";

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

export interface EditingRouteProvider {
  backend: string;
  guarantee: CapabilityGuarantee;
}

export interface EditingRouteReason {
  code: "EDITOR_SELECTED" | "EDITOR_UNAVAILABLE" | "CAPABILITY_UNAVAILABLE" | "EXTERNAL_FALLBACK_SELECTED";
  message: string;
  connectionState: string;
  cause?: {
    code: string;
    message: string;
  };
  unavailable?: {
    category: CapabilityUnavailableCategory;
    capability: string;
    backend: string;
    guarantee: CapabilityGuarantee;
    message: string;
  };
}

export interface EditingRoute {
  operation: EditingRouteOperation;
  status: "editor-selected" | "external-fallback-selected" | "unavailable";
  selectedPath: "editor" | "artifact" | "background" | "native" | "external-renderer" | "none";
  requiredCapabilities: string[];
  missingCapabilities: string[];
  provider?: EditingRouteProvider;
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

export const BACKGROUND_LIBRARY_WORKFLOW = [
  "connection.status",
  "editor.inspect",
  "editing.route",
  "project.list",
  "editor.live.inspect",
];

export const BACKGROUND_ARTIFACT_WORKFLOW = [
  "connection.status",
  "editor.inspect",
  "artifact.inspect",
  "project.inspect",
  "editing.route",
  "artifact.edit.preview",
  "artifact.edit.execute",
  "artifact.edit.diff",
  "artifact.edit.verify",
  "artifact.edit.undo",
];

export const EDITOR_FIRST_MCP_INSTRUCTIONS = [
  "Framekit uses an editor-first workflow for every editing request.",
  "1. Call connection.status to establish whether the expected editor is connected.",
  "2. Call editor.inspect to read the selected editor identity and capabilities.",
  "3. Inspect the active project with project.inspect before selecting an editing path.",
  "4. Call editing.route and use only a path whose required capabilities are advertised.",
  "5. Resolve intent when needed, then preview before execute; never mutate on an unavailable capability.",
  "6. Observe the result, then use edit.diff and edit.verify to confirm the change.",
  "Background project and live metadata may use project.list and editor.live.inspect without canonical timeline proof.",
  "For an explicit FCPXML artifact, select artifact.edit; its background workflow uses artifact.inspect, artifact.edit.preview, artifact.edit.execute, artifact.edit.diff, artifact.edit.verify, and artifact.edit.undo, and never claims to change the open Final Cut timeline.",
  "An external renderer is never an implicit substitute for a connected editor. Select fallback: external-renderer explicitly and report the structured reason returned by editing.route.",
].join("\n");

type Requirement = {
  name: string;
  label: string;
  category: CapabilityUnavailableCategory;
  satisfied: (context: EditorRoutingContext) => boolean;
  descriptor: (context: EditorRoutingContext) => CapabilityDescriptor | undefined;
};

const operationRequirements: Record<EditingRouteOperation, Requirement[]> = {
  "project.list": [backgroundLibraryRequirement()],
  "project.select": [editorRequirement("projectSelection", "native-ui")],
  "project.inspect": [canonicalRequirement()],
  "timeline.inspect": [canonicalRequirement()],
  "editor.live.inspect": [observationRequirement("timeline")],
  "timeline.edit": [
    editorRequirement("projectRead"),
    editorRequirement("timelineSnapshotRead"),
    editorArtifactWriteRequirement(),
    editorRequirement("readAfterWrite"),
    editorRequirement("rollback"),
  ],
  "timeline.mask.add": [
    editorRequirement("projectRead"),
    editorRequirement("timelineSnapshotRead"),
    editorRequirement("timelineWrite"),
    editorRequirement("readAfterWrite"),
    editorRequirement("rollback"),
    editorRequirement("masking"),
  ],
  "editor.native.edit": [
    nativeRequirement("selectionEdit"),
    nativeRequirement("timelineFocus"),
    nativeRequirement("undo"),
  ],
  "editor.native.picture-in-picture": [
    nativeRequirement("pictureInPicture"),
    nativeRequirement("mediaSelection"),
    nativeRequirement("timelineOccurrenceLocate"),
    nativeRequirement("timelineFocus"),
    nativeRequirement("undo"),
  ],
  "artifact.edit": [
    editorRequirement("projectRead"),
    editorRequirement("timelineSnapshotRead"),
    editorRequirement("timelineArtifactWrite"),
    editorRequirement("readAfterWrite"),
    editorRequirement("rollback"),
  ],
  "timeline.publish.new-project": [
    {
      name: "editor.artifactPublish",
      label: "editor.artifactPublish",
      category: "native-ui",
      satisfied: (context) => Boolean(
        context.editor?.capabilities.editor.artifactPublish
        || context.editor?.capabilities.editor.timelinePublishNewProject,
      ),
      descriptor: (context) => context.editor?.capabilities.families?.publishing.projectCreation,
    },
  ],
  "timeline.export": [editorRequirement("videoExport", "native-ui")],
};

export function resolveEditingRoute(
  request: EditingRouteRequest,
  context: EditorRoutingContext,
): EditingRoute {
  const requirements = operationRequirements[request.operation];
  const requiredCapabilities = requirements.map((requirement) => requirement.label);
  const missingRequirements = requirements.filter((requirement) => !requirement.satisfied(context));
  const missingCapabilities = missingRequirements.map((requirement) => requirement.label);
  const editor = context.editor?.identity;
  const workflow = request.operation === "artifact.edit"
    ? BACKGROUND_ARTIFACT_WORKFLOW
    : request.operation === "project.list"
      ? BACKGROUND_LIBRARY_WORKFLOW
      : EDITOR_FIRST_WORKFLOW;

  if (request.fallback === "external-renderer") {
    const cause = externalFallbackCause(context, missingCapabilities);
    return {
      operation: request.operation,
      status: "external-fallback-selected",
      selectedPath: "external-renderer",
      requiredCapabilities,
      missingCapabilities,
      ...(editor ? { editor } : {}),
      workflow: [...workflow],
      reason: {
        code: "EXTERNAL_FALLBACK_SELECTED",
        message: "The external renderer was selected explicitly; Framekit will not invoke it or bypass the editor silently.",
        connectionState: context.connection.state,
        cause,
      },
    };
  }

  const offlineArtifactEdit = (request.operation === "artifact.edit" || request.operation === "timeline.edit")
    && Boolean(
      context.editor?.capabilities.editor.timelineArtifactWrite
      && (context.editor.capabilities.families?.canonicalDocument.artifactWrite.available ?? true),
    );
  if (context.connection.state !== "ready" && !offlineArtifactEdit && request.operation !== "project.list") {
    return {
      operation: request.operation,
      status: "unavailable",
      selectedPath: "none",
      requiredCapabilities,
      missingCapabilities,
      ...(editor ? { editor } : {}),
      workflow: [...workflow],
      reason: editorUnavailableReason(context, missingRequirements),
    };
  }

  if (missingRequirements.length > 0 || !context.editor) {
    return {
      operation: request.operation,
      status: "unavailable",
      selectedPath: "none",
      requiredCapabilities,
      missingCapabilities,
      ...(editor ? { editor } : {}),
      workflow: [...workflow],
      reason: capabilityUnavailableReason(context, missingRequirements, request.operation),
    };
  }

  const provider = selectedProvider(request.operation, context);
  return {
    operation: request.operation,
    status: "editor-selected",
    selectedPath: selectedPath(request.operation, provider),
    requiredCapabilities,
    missingCapabilities: [],
    ...(provider ? { provider } : {}),
    editor,
    workflow: [...workflow],
    reason: {
      code: "EDITOR_SELECTED",
      message: selectedMessage(request.operation),
      connectionState: context.connection.state,
    },
  };
}

function canonicalRequirement(): Requirement {
  return {
    name: "canonicalDocument.read",
    label: "canonicalDocument.read",
    category: "canonical-snapshot",
    satisfied: (context) => {
      const descriptor = context.editor?.capabilities.families?.canonicalDocument.read;
      return descriptor ? descriptor.available : Boolean(
        context.editor?.capabilities.editor.projectRead
        && context.editor.capabilities.editor.timelineSnapshotRead,
      );
    },
    descriptor: (context) => context.editor?.capabilities.families?.canonicalDocument.read,
  };
}

function observationRequirement(operation: keyof RuntimeCapabilities["editor"] extends never ? never : "timeline"): Requirement {
  return {
    name: `observation.${operation}`,
    label: `observation.${operation}`,
    category: "background-api",
    satisfied: (context) => {
      const descriptor = context.editor?.capabilities.families?.observation[operation];
      return descriptor ? descriptor.available : Boolean(context.editor?.capabilities.editor.liveStateRead);
    },
    descriptor: (context) => context.editor?.capabilities.families?.observation[operation],
  };
}

function backgroundLibraryRequirement(): Requirement {
  return {
    name: "observation.library",
    label: "observation.library|canonicalDocument.read",
    category: "background-api",
    satisfied: (context) => Boolean(
      context.editor?.capabilities.families?.observation.library.available
      || context.editor?.capabilities.editor.projectCatalogRead
        && context.editor.capabilities.families?.canonicalDocument.read.available,
    ) || Boolean(
      !context.editor?.capabilities.families
      && context.editor?.capabilities.editor.projectCatalogRead,
    ),
    descriptor: (context) => {
      const families = context.editor?.capabilities.families;
      if (families?.observation.library.available) return families.observation.library;
      if (families?.canonicalDocument.read.available) return families.canonicalDocument.read;
      return families?.observation.library;
    },
  };
}

function editorArtifactWriteRequirement(): Requirement {
  return {
    name: "editor.timelineWrite|editor.timelineArtifactWrite",
    label: "editor.timelineWrite|editor.timelineArtifactWrite",
    category: "canonical-snapshot",
    satisfied: (context) => {
      const families = context.editor?.capabilities.families;
      if (families) {
        return families.canonicalDocument.write.available || families.canonicalDocument.artifactWrite.available;
      }
      return Boolean(
        context.editor?.capabilities.editor.timelineWrite
        || context.editor?.capabilities.editor.timelineArtifactWrite,
      );
    },
    descriptor: (context) => {
      const families = context.editor?.capabilities.families;
      if (families?.canonicalDocument.write.available) return families.canonicalDocument.write;
      return families?.canonicalDocument.artifactWrite;
    },
  };
}

function editorRequirement(
  capability: keyof RuntimeCapabilities["editor"],
  category: CapabilityUnavailableCategory = "canonical-snapshot",
): Requirement {
  return {
    name: `editor.${capability}`,
    label: `editor.${capability}`,
    category,
    satisfied: (context) => {
      const descriptor = editorDescriptor(context, capability);
      return descriptor ? descriptor.available : Boolean(context.editor?.capabilities.editor[capability]);
    },
    descriptor: (context) => editorDescriptor(context, capability),
  };
}

function nativeRequirement(capability: string): Requirement {
  return {
    name: `native.${capability}`,
    label: `native.${capability}`,
    category: "native-ui",
    satisfied: (context) => {
      const descriptor = nativeDescriptor(context, capability);
      return descriptor ? descriptor.available : context.native?.[capability] === true;
    },
    descriptor: (context) => nativeDescriptor(context, capability),
  };
}

function editorDescriptor(
  context: EditorRoutingContext,
  capability: keyof RuntimeCapabilities["editor"],
): CapabilityDescriptor | undefined {
  const families = context.editor?.capabilities.families;
  if (!families) return undefined;
  switch (capability) {
    case "projectRead":
    case "timelineSnapshotRead":
      return families.canonicalDocument.read;
    case "timelineWrite":
      return families.canonicalDocument.write;
    case "timelineArtifactWrite":
      return families.canonicalDocument.artifactWrite;
    case "readAfterWrite":
    case "rollback":
      return families.canonicalDocument.write.available
        ? families.canonicalDocument.write
        : families.canonicalDocument.artifactWrite;
    case "videoExport":
      return families.export.timeline;
    case "artifactPublish":
    case "timelinePublishNewProject":
      return families.publishing.projectCreation;
    default:
      return undefined;
  }
}

function nativeDescriptor(
  context: EditorRoutingContext,
  capability: string,
): CapabilityDescriptor | undefined {
  const operation = {
    selectionEdit: "selectionWrite",
    timelineFocus: "timelineFocus",
    undo: "undo",
    pictureInPicture: "pictureInPicture",
    mediaSelection: "mediaSelection",
    timelineOccurrenceLocate: "timelineOccurrenceLocate",
  }[capability] as keyof NonNullable<RuntimeCapabilities["families"]>["native"] | undefined;
  return operation ? context.editor?.capabilities.families?.native[operation] : undefined;
}

function selectedProvider(
  operation: EditingRouteOperation,
  context: EditorRoutingContext,
): EditingRouteProvider | undefined {
  const requirements = operationRequirements[operation];
  const descriptor = operation === "timeline.edit"
    ? requirements.find((requirement) => requirement.name === "editor.timelineWrite|editor.timelineArtifactWrite")?.descriptor(context)
    : requirements[0]?.descriptor(context);
  return descriptor?.available
    ? { backend: descriptor.backend, guarantee: descriptor.guarantee }
    : undefined;
}

function selectedPath(
  operation: EditingRouteOperation,
  provider: EditingRouteProvider | undefined,
): EditingRoute["selectedPath"] {
  if (operation === "artifact.edit") return "artifact";
  if (operation === "project.list" || operation === "editor.live.inspect") {
    return provider?.guarantee === "observed" ? "background" : "editor";
  }
  if (operation.startsWith("editor.native.")) return "native";
  return "editor";
}

function selectedMessage(operation: EditingRouteOperation): string {
  if (operation === "project.list" || operation === "editor.live.inspect") {
    return "The background observation provider satisfies the requested metadata fields; no canonical timeline proof is implied.";
  }
  if (operation === "artifact.edit") {
    return "The managed FCPXML artifact satisfies the required capabilities; continue with its background preview and execute contract without Final Cut UI access.";
  }
  return "The connected editor satisfies the required capabilities; continue with the preview and execute contract.";
}

function unavailableEvidence(
  context: EditorRoutingContext,
  requirements: Requirement[],
): NonNullable<EditingRouteReason["unavailable"]> | undefined {
  const requirement = requirements[0];
  if (!requirement) return undefined;
  const descriptor = requirement.descriptor(context);
  const category = requirement.category;
  return {
    category,
    capability: requirement.name,
    backend: descriptor?.backend ?? context.editor?.identity.backend ?? "unknown",
    guarantee: descriptor?.guarantee ?? "none",
    message: `${categoryMessage(category)}: ${descriptor?.unavailableReason ?? "the required capability is unavailable"}`,
  };
}

function categoryMessage(category: CapabilityUnavailableCategory): string {
  switch (category) {
    case "background-api": return "background API support is unavailable";
    case "canonical-snapshot": return "canonical snapshot support is unavailable";
    case "native-ui": return "native UI access is unavailable";
  }
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
  missingRequirements: Requirement[],
): EditingRouteReason {
  if (context.connection.state !== "ready") {
    return {
      code: "EDITOR_UNAVAILABLE",
      message: `The expected editor is unavailable while the connection is ${context.connection.state}.`,
      connectionState: context.connection.state,
      ...(context.connection.lastError ? { cause: context.connection.lastError } : {}),
      ...(unavailableEvidence(context, missingRequirements) ? { unavailable: unavailableEvidence(context, missingRequirements) } : {}),
    };
  }
  return capabilityUnavailableReason(context, missingRequirements);
}

function capabilityUnavailableReason(
  context: EditorRoutingContext,
  missingRequirements: Requirement[],
  operation?: EditingRouteOperation,
): EditingRouteReason {
  const unavailable = unavailableEvidence(context, missingRequirements);
  return {
    code: "CAPABILITY_UNAVAILABLE",
    message: operation
      ? `The connected editor cannot satisfy ${operation}; no alternate editor path was selected.`
      : "The connected editor does not advertise every capability required by this operation.",
    connectionState: context.connection.state,
    ...(unavailable ? { unavailable } : {}),
  };
}
