const requiredTools = [
  ["project.inspect", "passed"],
  ["speech.analyze", "passed"],
  ["timeline.edit", "VERIFIED"],
  ["edit.diff", "passed"],
  ["edit.verify", "passed"],
  ["edit.undo", "passed"],
];

const editorCapabilityKeys = [
  "canonicalTimelineMode",
  "projectRead",
  "timelineSnapshotRead",
  "timelineWrite",
  "timelineArtifactWrite",
  "readAfterWrite",
  "incrementalChanges",
  "rollback",
  "assetDiscovery",
  "liveStateRead",
  "playheadWrite",
  "frameCapture",
  "projectCatalogRead",
  "projectSelection",
  "compositeTransactions",
  "mediaImport",
  "mediaPlacement",
  "titlePlacement",
];

const analyzerCapabilityKeys = ["speechTranscribe", "speechVad", "audioLoudness", "visualTrack"];
const prohibitedPublicTextPatterns = [
  /(?:^|[\\/])(?:Users|home|private|var[\\/]folders)(?:[\\/]|$)/i,
  /(?:api[-_ ]?key|access[-_ ]?token|password|secret|authorization)\s*[:=]\s*\S+/i,
  /(?:^|\b(?:export|set)\s+|--env\s+|--?\w+[=\s]+)(?:API[-_ ]?KEY|ACCESS[-_ ]?TOKEN|PASSWORD|SECRET|AUTHORIZATION)\s+\S+/,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/i,
  /\b(?:crash dump|stack trace|raw diagnostics?|exception(?:\s|:))/i,
  /\b(?:transaction|revision)[-_ ]?(?:id|identifier)?\s*[:=]\s*\S+/i,
];

export function sanitizeCleanMcpEvidence(run, options = {}) {
  assert(run?.schemaVersion === 1, "schema version must be 1");
  const clients = requireClients(run.clients, options.expectedClientNames);

  return {
    schemaVersion: 1,
    evidenceType: "clean-mcp-client-workflow",
    passed: true,
    recordedAt: requireString(run.recordedAt, "recordedAt"),
    environment: sanitizeEnvironment(run.environment),
    framekit: { version: sanitizePublicText(run.framekit?.version, "Framekit version") },
    runtime: { version: sanitizePublicText(run.runtime?.version, "runtime version") },
    clients: clients.map((client) => sanitizeClient(client)),
    sanitization: {
      strategy: "allowlisted-summary",
      omitted: [
        "private filesystem paths",
        "raw tool responses",
        "transaction identifiers",
        "credentials",
        "diagnostics",
      ],
    },
  };
}

function requireClients(clients, expectedClientNames = ["Codex", "Claude Code"]) {
  assert(
    Array.isArray(expectedClientNames) && expectedClientNames.length > 0,
    "at least one expected client is required",
  );
  assert(
    Array.isArray(clients) && clients.length === expectedClientNames.length,
    `${expectedClientNames.join(" and ")} client records are required`,
  );
  const names = clients.map((client) => requireString(client?.name, "client name"));
  assert(
    names.every((name, index) => name === expectedClientNames[index]),
    `${expectedClientNames.join(" and ")} records are required in order`,
  );
  return clients;
}

function sanitizeClient(client) {
  const name = requireString(client.name, "client name");
  const workflowTools = sanitizeWorkflow(client.workflow?.tools, name);
  const limitations = client.workflow?.limitations;
  assert(Array.isArray(limitations), `${name} workflow limitations are missing`);

  return {
    name,
    clientVersion: sanitizePublicText(client.clientVersion, `${name} version`),
    registration: sanitizeRegistration(client.registration, name),
    server: {
      version: sanitizePublicText(client.server?.version, `${name} server version`),
      protocolVersion: sanitizePublicText(client.server?.protocolVersion, `${name} protocol version`),
    },
    editor: sanitizeIdentity(client.editor, name),
    capabilities: sanitizeCapabilities(client.capabilities, name),
    workflow: {
      status: "passed",
      tools: workflowTools,
      limitations: limitations.map((limitation) => sanitizePublicText(limitation, `${name} limitation`)),
    },
  };
}

function sanitizeRegistration(registration, clientName) {
  assert(registration?.status === "passed", `${clientName} registration did not pass`);
  const result = {
    status: "passed",
    command: sanitizePublicText(registration.command, `${clientName} registration command`),
  };
  if (registration.publicPackage) {
    const status = registration.publicPackage.status;
    assert(status === "passed" || status === "blocked", `${clientName} public package status is invalid`);
    result.publicPackage = {
      status,
      ...(status === "blocked"
        ? { reason: sanitizePublicText(registration.publicPackage.reason, `${clientName} public package reason`) }
        : {}),
    };
  }
  return result;
}

function sanitizeWorkflow(tools, clientName) {
  assert(Array.isArray(tools) && tools.length === requiredTools.length, `${clientName} workflow is incomplete`);
  return tools.map((tool, index) => {
    const [expectedName, expectedStatus] = requiredTools[index];
    const name = requireString(tool?.name, `${clientName} tool name`);
    const status = requireString(tool?.status, `${clientName} ${name} status`);
    assert(name === expectedName && status === expectedStatus, `${clientName} workflow step ${index + 1} is invalid`);
    return { name, status };
  });
}

function sanitizeEnvironment(environment) {
  const gitCommit = requireString(environment?.gitCommit, "Git commit");
  assert(/^[0-9a-f]{40}$/i.test(gitCommit), "Git commit must be a full SHA-1");
  return {
    gitCommit,
    nodeVersion: sanitizePublicText(environment.nodeVersion, "Node version"),
    platform: sanitizePublicText(environment.platform, "platform"),
    architecture: sanitizePublicText(environment.architecture, "architecture"),
    ...(isNonEmptyString(environment.osVersion)
      ? { osVersion: sanitizePublicText(environment.osVersion, "OS version") }
      : {}),
  };
}

function sanitizeIdentity(identity, clientName) {
  assert(identity, `${clientName} editor identity is missing`);
  return {
    name: sanitizePublicText(identity.name, `${clientName} editor name`),
    version: sanitizePublicText(identity.version, `${clientName} editor version`),
    backend: sanitizePublicText(identity.backend, `${clientName} editor backend`),
  };
}

function sanitizeCapabilities(capabilities, clientName) {
  assert(capabilities, `${clientName} capabilities are missing`);
  const editor = pickKnown(capabilities.editor, editorCapabilityKeys);
  const analyzers = pickKnown(capabilities.analyzers, analyzerCapabilityKeys);
  assert(typeof editor.canonicalTimelineMode === "string", `${clientName} canonicalTimelineMode is missing`);
  editor.canonicalTimelineMode = sanitizePublicText(editor.canonicalTimelineMode, `${clientName} canonicalTimelineMode`);
  for (const key of editorCapabilityKeys.filter((candidate) => candidate !== "canonicalTimelineMode")) {
    if (editor[key] !== undefined) assert(typeof editor[key] === "boolean", `${clientName} ${key} capability must be boolean`);
  }
  for (const key of analyzerCapabilityKeys) {
    if (analyzers[key] !== undefined) assert(typeof analyzers[key] === "boolean", `${clientName} ${key} capability must be boolean`);
  }
  return { editor, analyzers };
}

function pickKnown(value, keys) {
  const result = {};
  for (const key of keys) {
    if (value?.[key] !== undefined) result[key] = value[key];
  }
  return result;
}

function requireString(value, label) {
  assert(isNonEmptyString(value), `${label} is missing`);
  return value;
}

function sanitizePublicText(value, label) {
  const text = requireString(value, label).trim();
  assert(text.length <= 240, `${label} is too long`);
  assert(
    !prohibitedPublicTextPatterns.some((pattern) => pattern.test(text)),
    `${label} contains prohibited content`,
  );
  return text;
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function assert(condition, message) {
  if (!condition) throw new Error(`CLEAN_MCP_EVIDENCE_INCOMPLETE: ${message}`);
}
