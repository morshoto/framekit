const requiredTools = [
  ["headless.project.create", "passed"],
  ["headless.project.inspect", "passed"],
  ["speech.analyze", "passed"],
  ["headless.edit.preview", "passed"],
  ["headless.edit.execute", "passed"],
  ["editing.route", "headless-selected"],
];

const pluginIdentitySources = [
  "installed-content-equals-clean-source",
  "installed-content-equals-dirty-source",
  "installed-content-differs-from-source",
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
  assert(run.passed === true, "clean MCP workflow did not pass");
  const clients = requireClients(run.clients, options.expectedClientNames);
  const environment = sanitizeEnvironment(run.environment);
  const releaseCandidate = run.releaseCandidate ? sanitizeReleaseCandidate(run.releaseCandidate) : undefined;
  if (releaseCandidate) {
    assert(
      releaseCandidate.target.sourceClean === environment.sourceClean,
      "release candidate and workflow source cleanliness do not match",
    );
  }

  return {
    schemaVersion: 1,
    evidenceType: "clean-mcp-client-workflow",
    passed: true,
    recordedAt: requireString(run.recordedAt, "recordedAt"),
    environment,
    framekit: { version: sanitizePublicText(run.framekit?.version, "Framekit version") },
    runtime: { version: sanitizePublicText(run.runtime?.version, "runtime version") },
    clients: clients.map((client) => sanitizeClient(client)),
    ...(releaseCandidate ? { releaseCandidate } : {}),
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
  const serverVersion = sanitizePublicText(client.server?.version, `${name} server version`);
  const buildFingerprint = client.server?.buildFingerprint
    ? sanitizeBuildFingerprint(client.server.buildFingerprint, `${name} server`)
    : undefined;
  if (buildFingerprint) assert(buildFingerprint.version === serverVersion, `${name} server build version does not match its MCP version`);

  return {
    name,
    clientVersion: sanitizePublicText(client.clientVersion, `${name} version`),
    registration: sanitizeRegistration(client.registration, name),
    server: {
      version: serverVersion,
      protocolVersion: sanitizePublicText(client.server?.protocolVersion, `${name} protocol version`),
      ...(buildFingerprint ? { buildFingerprint } : {}),
      ...(client.server?.buildFingerprintIssue
        ? { buildFingerprintIssue: sanitizePublicText(client.server.buildFingerprintIssue, `${name} server build issue`) }
        : {}),
    },
    editor: sanitizeIdentity(client.editor, name),
    capabilities: sanitizeCapabilities(client.capabilities, name),
    workflow: {
      status: "passed",
      tools: workflowTools,
      limitations: limitations.map((limitation) => sanitizePublicText(limitation, `${name} limitation`)),
      ...(client.workflow?.delivery ? { delivery: sanitizeDelivery(client.workflow.delivery, name) } : {}),
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
    assert(["passed", "blocked", "mismatched"].includes(status), `${clientName} public package status is invalid`);
    result.publicPackage = {
      status,
      ...(registration.publicPackage.version
        ? { version: sanitizePublicText(registration.publicPackage.version, `${clientName} public package version`) }
        : {}),
      ...(registration.publicPackage.commit
        ? { commit: sanitizeCommit(registration.publicPackage.commit, `${clientName} public package commit`) }
        : {}),
      ...(status !== "passed"
        ? { reason: sanitizePublicText(registration.publicPackage.reason, `${clientName} public package reason`) }
        : {}),
    };
  }
  if (registration.plugin) {
    const plugin = {
      version: sanitizePublicText(registration.plugin.version, `${clientName} plugin version`),
      ...(registration.plugin.commit
        ? { commit: sanitizeCommit(registration.plugin.commit, `${clientName} plugin commit`) }
        : {}),
    };
    const identitySource = registration.plugin.identitySource;
    const contentDigest = registration.plugin.contentDigest
      ? sanitizeDigest(registration.plugin.contentDigest, `${clientName} installed plugin digest`)
      : undefined;
    const sourceContentDigest = registration.plugin.sourceContentDigest
      ? sanitizeDigest(registration.plugin.sourceContentDigest, `${clientName} source plugin digest`)
      : undefined;
    const sourceCommit = registration.plugin.sourceCommit
      ? sanitizeCommit(registration.plugin.sourceCommit, `${clientName} source plugin commit`)
      : undefined;
    if (identitySource !== undefined) {
      assert(pluginIdentitySources.includes(identitySource), `${clientName} plugin identity source is invalid`);
      plugin.identitySource = identitySource;
    }
    if (contentDigest) plugin.contentDigest = contentDigest;
    if (sourceContentDigest) plugin.sourceContentDigest = sourceContentDigest;
    if (sourceCommit) plugin.sourceCommit = sourceCommit;
    const hasContentIdentity = contentDigest !== undefined
      || sourceContentDigest !== undefined
      || sourceCommit !== undefined
      || identitySource !== undefined;
    if (hasContentIdentity) {
      assert(contentDigest && sourceContentDigest && identitySource, `${clientName} plugin content identity is incomplete`);
      if (identitySource === "installed-content-equals-clean-source") {
        assert(
          plugin.commit !== undefined
          && sourceCommit !== undefined
          && plugin.commit === sourceCommit
          && contentDigest === sourceContentDigest,
          `${clientName} plugin commit is not bound to matching installed content`,
        );
      } else {
        assert(plugin.commit === undefined && sourceCommit === undefined, `${clientName} unverified plugin content cannot claim a commit`);
      }
    }
    result.plugin = plugin;
  }
  if (registration.packageSource) {
    assert(["published-package", "packed-source"].includes(registration.packageSource), `${clientName} package source is invalid`);
    result.packageSource = registration.packageSource;
  }
  return result;
}

function sanitizeReleaseCandidate(candidate) {
  assert(candidate?.schemaVersion === 1, "release candidate schema version must be 1");
  assert(candidate?.evidenceType === "framekit-release-candidate", "release candidate evidence type is invalid");
  const target = {
    version: sanitizePublicText(candidate.target?.version, "release candidate version"),
    commit: sanitizeCommit(candidate.target?.commit, "release candidate commit"),
    sourceClean: requireBoolean(candidate.target?.sourceClean, "release candidate source cleanliness"),
  };
  assert(candidate.status === "GO" || candidate.status === "NO_GO", "release candidate status is invalid");
  const names = ["npmPackage", "codexPlugin", "mcpServer", "nativeExtension"];
  const artifacts = Object.fromEntries(names.map((name) => [name, sanitizeCandidateArtifact(candidate.artifacts?.[name], name)]));
  const complete = Object.values(artifacts).every((artifact) => artifact.status === "GO");
  for (const artifact of Object.values(artifacts)) {
    if (artifact.status === "GO") {
      assert(artifact.version === target.version, "GO release artifact version does not match the candidate");
      assert(artifact.commit === target.commit, "GO release artifact commit does not match the candidate");
    }
  }
  assert(target.sourceClean || candidate.status === "NO_GO", "dirty release source cannot be a GO candidate");
  if (!target.sourceClean) {
    assert(Object.values(artifacts).every((artifact) => artifact.status === "NO_GO"), "dirty release source cannot have GO artifacts");
  }
  assert(candidate.status === (complete ? "GO" : "NO_GO"), "release candidate status does not match artifact statuses");
  return {
    schemaVersion: 1,
    evidenceType: "framekit-release-candidate",
    target,
    status: candidate.status,
    artifacts,
  };
}

function sanitizeCandidateArtifact(artifact, name) {
  assert(artifact?.status === "GO" || artifact?.status === "NO_GO", `${name} release status is invalid`);
  const result = {
    status: artifact.status,
    ...(artifact.version ? { version: sanitizePublicText(artifact.version, `${name} version`) } : {}),
    ...(artifact.commit ? { commit: sanitizeCommit(artifact.commit, `${name} commit`) } : {}),
    ...(artifact.status === "NO_GO"
      ? { reason: sanitizePublicText(artifact.reason, `${name} release blocker`) }
      : {}),
  };
  if (name === "codexPlugin") {
    if (artifact.identitySource !== undefined) {
      assert(pluginIdentitySources.includes(artifact.identitySource), "Codex plugin identity source is invalid");
      result.identitySource = artifact.identitySource;
    }
    if (artifact.contentDigest !== undefined) {
      result.contentDigest = sanitizeDigest(artifact.contentDigest, "Codex plugin installed digest");
    }
    if (artifact.sourceContentDigest !== undefined) {
      result.sourceContentDigest = sanitizeDigest(artifact.sourceContentDigest, "Codex plugin source digest");
    }
    if (artifact.sourceCommit !== undefined) {
      result.sourceCommit = sanitizeCommit(artifact.sourceCommit, "Codex plugin source commit");
    }
    if (artifact.status === "GO") {
      assert(
        result.identitySource === "installed-content-equals-clean-source"
        && result.contentDigest !== undefined
        && result.contentDigest === result.sourceContentDigest
        && result.sourceCommit !== undefined
        && result.sourceCommit === result.commit,
        "GO Codex plugin is missing installed-content source binding",
      );
    }
  }
  return result;
}

function sanitizeBuildFingerprint(fingerprint, clientName) {
  const result = {
    version: sanitizePublicText(fingerprint.version, `${clientName} build version`),
    commit: sanitizeCommit(fingerprint.commit, `${clientName} build commit`),
  };
  return result;
}

function sanitizeCommit(value, label) {
  const commit = sanitizePublicText(value, label);
  assert(/^[0-9a-f]{40}$/i.test(commit), `${label} must be a full SHA-1`);
  return commit.toLowerCase();
}

function sanitizeDigest(value, label) {
  const digest = sanitizePublicText(value, label);
  assert(/^[0-9a-f]{64}$/i.test(digest), `${label} must be a SHA-256 digest`);
  return digest.toLowerCase();
}

function sanitizeDelivery(delivery, clientName) {
  assert(["headed", "headless", "unknown"].includes(delivery.processMode), `${clientName} process mode is invalid`);
  assert(delivery.processMode === "headless", `${clientName} delivery workflow did not run headless`);
  assert(delivery.headless?.status === "passed", `${clientName} headless capability was not verified`);
  assert(["passed", "blocked"].includes(delivery.nativeFinalCut?.status), `${clientName} native-delivery status is invalid`);
  return {
    processMode: delivery.processMode,
    headless: {
      status: "passed",
      backend: sanitizePublicText(delivery.headless.backend, `${clientName} headless backend`),
      requiredCapabilities: requireArray(delivery.headless.requiredCapabilities, `${clientName} headless capabilities`)
        .map((capability) => sanitizePublicText(capability, `${clientName} headless capability`)),
    },
    nativeFinalCut: {
      status: delivery.nativeFinalCut.status,
      reason: sanitizePublicText(delivery.nativeFinalCut.reason, `${clientName} native-delivery status`),
    },
  };
}

function requireArray(value, label) {
  assert(Array.isArray(value), `${label} are missing`);
  return value;
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
    sourceClean: requireBoolean(environment?.sourceClean, "source checkout cleanliness"),
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

function requireBoolean(value, label) {
  assert(typeof value === "boolean", `${label} is missing`);
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
