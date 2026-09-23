export function assertMcpServerVersion(serverVersion, packageVersion, source = "MCP server") {
  if (typeof serverVersion !== "string" || serverVersion.length === 0) {
    throw new Error(`MCP_SERVER_VERSION_MISSING: ${source} did not report a server version`);
  }
  if (typeof packageVersion !== "string" || packageVersion.length === 0) {
    throw new Error("MCP_PACKAGE_VERSION_MISSING: package did not report a version");
  }
  if (serverVersion !== packageVersion) {
    throw new Error(
      `MCP_SERVER_VERSION_MISMATCH: ${source} reports ${serverVersion}; package reports ${packageVersion}`,
    );
  }
  return serverVersion;
}
