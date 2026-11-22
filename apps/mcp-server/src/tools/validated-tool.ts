import { fromJsonSchema, McpServer, type CallToolResult, type ServerContext, type jsonSchemaValidator } from "@modelcontextprotocol/server";
import { z } from "zod/v4";
import { formatInputError } from "./input-error.js";

/** Validate before invoking the callback while retaining an accurate discovery schema. */
type ToolSchema = z.ZodType | z.ZodRawShape;
type ToolInput<Schema extends ToolSchema> = Schema extends z.ZodType ? z.output<Schema> : Schema extends z.ZodRawShape ? z.output<z.ZodObject<Schema>> : never;

/** Preserve the object discovery constraints emitted by the v1 SDK. */
function preserveObjectConstraints(value: unknown, isToolRoot = false): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const schema = value as Record<string, unknown>;
  if (schema.type === "object" && schema.properties && typeof schema.properties === "object"
    && (!isToolRoot || Object.keys(schema.properties).length > 0)) {
    if (schema.additionalProperties === undefined) schema.additionalProperties = false;
    else if (schema.additionalProperties && typeof schema.additionalProperties === "object"
      && !Array.isArray(schema.additionalProperties) && Object.keys(schema.additionalProperties).length === 0) {
      schema.additionalProperties = true;
    }
  }
  for (const key of ["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"]) {
    const map = schema[key];
    if (map && typeof map === "object" && !Array.isArray(map)) {
      for (const child of Object.values(map)) preserveObjectConstraints(child);
    }
  }
  for (const key of ["items", "additionalProperties", "propertyNames", "not", "if", "then", "else", "contains"]) {
    preserveObjectConstraints(schema[key]);
  }
  for (const key of ["anyOf", "oneOf", "allOf", "prefixItems"]) {
    if (Array.isArray(schema[key])) for (const child of schema[key]) preserveObjectConstraints(child);
  }
}

export function registerValidatedTool<Schema extends ToolSchema>(
  server: McpServer,
  name: string,
  config: { inputSchema: Schema; description?: string },
  callback: (input: ToolInput<Schema>, context: ServerContext) => Promise<CallToolResult>,
): void {
  const schema = config.inputSchema instanceof z.ZodType ? config.inputSchema : z.object(config.inputSchema);
  const generated = z.toJSONSchema(schema, { io: "input" });
  preserveObjectConstraints(generated, true);
  const { oneOf, ...rest } = generated;
  const branches = oneOf ?? generated.anyOf;
  const variants = new Map<string, Map<string, unknown>>();
  for (const branch of branches ?? []) {
    if (typeof branch !== "object" || !branch || !("properties" in branch)) continue;
    for (const [key, value] of Object.entries(branch.properties ?? {})) {
      if (key === "type") continue;
      const schemas = variants.get(key) ?? new Map<string, unknown>();
      schemas.set(JSON.stringify(value), value);
      variants.set(key, schemas);
    }
  }
  const properties = Object.fromEntries([...variants].map(([key, schemas]) => {
    const alternatives = [...schemas.values()];
    return [key, alternatives.length === 1 ? alternatives[0] : { anyOf: alternatives }];
  }));
  const jsonSchema = branches ? { ...rest, type: "object" as const, properties, anyOf: branches } : generated;
  const passthrough: jsonSchemaValidator = {
    getValidator: (() => (data: unknown) => ({ valid: true, data, errorMessage: undefined })) as jsonSchemaValidator["getValidator"],
  };
  const advertised = fromJsonSchema<unknown>(jsonSchema as Parameters<typeof fromJsonSchema>[0], passthrough);
  server.registerTool(name, { ...config, inputSchema: advertised }, async (input, context) => {
    const result = await schema.safeParseAsync(input);
    context.mcpReq.signal.throwIfAborted();
    if (!result.success) {
      const message = formatInputError(result.error.issues, input);
      return { isError: true, content: [{ type: "text", text: JSON.stringify({ code: "INPUT_INVALID", message }) }] };
    }
    return callback(result.data as ToolInput<Schema>, context);
  });
}
