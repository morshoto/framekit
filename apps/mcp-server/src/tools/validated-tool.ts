import { fromJsonSchema, McpServer, type CallToolResult, type jsonSchemaValidator } from "@modelcontextprotocol/server";
import { z } from "zod/v4";

/** Validate before invoking the callback while retaining an accurate discovery schema. */
export function registerValidatedTool<Schema extends z.ZodType>(
  server: McpServer,
  name: string,
  config: { inputSchema: Schema; description?: string },
  callback: (input: z.output<Schema>) => Promise<CallToolResult>,
): void {
  const jsonSchema = z.toJSONSchema(config.inputSchema);
  const passthrough: jsonSchemaValidator = {
    getValidator: (() => (data: unknown) => ({ valid: true, data, errorMessage: undefined })) as jsonSchemaValidator["getValidator"],
  };
  const advertised = fromJsonSchema<unknown>(jsonSchema as Parameters<typeof fromJsonSchema>[0], passthrough);
  server.registerTool(name, { ...config, inputSchema: advertised }, async (input) => {
    const result = await config.inputSchema.safeParseAsync(input);
    if (!result.success) {
      return { isError: true, content: [{ type: "text", text: JSON.stringify({ code: "INPUT_INVALID", message: "INPUT_INVALID: invalid tool arguments" }) }] };
    }
    return callback(result.data);
  });
}
