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

export function sanitizeCleanMcpEvidence(run, options = {}) {
  assert(run?.schemaVersion === 1, "schema version must be 1");
  const clients = requireClients(run.clients, options.expectedClientNames);

  return {
    schemaVersion: 1,
    evidenceType: "clean-mcp-client-workflow",
    passed: true,
    recordedAt: requireString(run.recordedAt, "recordedAt"),
    environment: sanitizeEnvironment(run.environment),
    framekit: { version: requireString(run.framekit?.version, "Framekit version") },
    runtime: { version: requireString(run.runtime?.version, "runtime version") },
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
    clientVersion: requireString(client.clientVersion, `${name} version`),
    registration: sanitizeRegistration(client.registration, name),
    server: {
      version: requireString(client.server?.version, `${name} server version`),
      protocolVersion: requireString(client.server?.protocolVersion, `${name} protocol version`),
    },
    editor: sanitizeIdentity(client.editor, name),
    capabilities: sanitizeCapabilities(client.capabilities, name),
    workflow: {
      status: "passed",
      tools: workflowTools,
      limitations: limitations.map((limitation) => requireString(limitation, `${name} limitation`)),
    },
  };
}

function sanitizeRegistration(registration, clientName) {
  assert(registration?.status === "passed", `${clientName} registration did not pass`);
  const result = {
    status: "passed",
    command: requireString(registration.command, `${clientName} registration command`),
  };
  if (registration.publicPackage) {
    const status = registration.publicPackage.status;
    assert(status === "passed" || status === "blocked", `${clientName} public package status is invalid`);
    result.publicPackage = {
      status,
      ...(status === "blocked"
        ? { reason: requireString(registration.publicPackage.reason, `${clientName} public package reason`) }
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
    nodeVersion: requireString(environment.nodeVersion, "Node version"),
    platform: requireString(environment.platform, "platform"),
    architecture: requireString(environment.architecture, "architecture"),
    ...(isNonEmptyString(environment.osVersion) ? { osVersion: environment.osVersion } : {}),
  };
}

function sanitizeIdentity(identity, clientName) {
  assert(identity, `${clientName} editor identity is missing`);
  return {
    name: requireString(identity.name, `${clientName} editor name`),
    version: requireString(identity.version, `${clientName} editor version`),
    backend: requireString(identity.backend, `${clientName} editor backend`),
  };
}

function sanitizeCapabilities(capabilities, clientName) {
  assert(capabilities, `${clientName} capabilities are missing`);
  const editor = pickKnown(capabilities.editor, editorCapabilityKeys);
  const analyzers = pickKnown(capabilities.analyzers, analyzerCapabilityKeys);
  assert(typeof editor.canonicalTimelineMode === "string", `${clientName} canonicalTimelineMode is missing`);
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

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function assert(condition, message) {
  if (!condition) throw new Error(`CLEAN_MCP_EVIDENCE_INCOMPLETE: ${message}`);
}
