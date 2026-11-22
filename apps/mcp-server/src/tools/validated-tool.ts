import { fromJsonSchema, McpServer, type CallToolResult, type ServerContext, type jsonSchemaValidator } from "@modelcontextprotocol/server";
import { z } from "zod/v4";
import { formatInputError } from "./input-error.js";

/** Validate before invoking the callback while retaining an accurate discovery schema. */
type ToolSchema = z.ZodType | z.ZodRawShape;
type ToolInput<Schema extends ToolSchema> = Schema extends z.ZodType ? z.output<Schema> : Schema extends z.ZodRawShape ? z.output<z.ZodObject<Schema>> : never;

export function registerValidatedTool<Schema extends ToolSchema>(
  server: McpServer,
  name: string,
  config: { inputSchema: Schema; description?: string },
  callback: (input: ToolInput<Schema>, context: ServerContext) => Promise<CallToolResult>,
): void {
  const schema = config.inputSchema instanceof z.ZodType ? config.inputSchema : z.object(config.inputSchema);
  const generated = z.toJSONSchema(schema, { io: "input" });
  const { oneOf, ...rest } = generated;
  const branches = oneOf ?? generated.anyOf;
  const properties: Record<string, unknown> = {};
  for (const branch of branches ?? []) {
    if (typeof branch !== "object" || !branch || !("properties" in branch)) continue;
    for (const [key, value] of Object.entries(branch.properties ?? {})) if (key !== "type") properties[key] = value;
  }
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
