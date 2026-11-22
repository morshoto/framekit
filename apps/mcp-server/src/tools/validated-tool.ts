import { fromJsonSchema, McpServer, type CallToolResult, type ServerContext, type jsonSchemaValidator } from "@modelcontextprotocol/server";
import { z } from "zod/v4";
import { formatInputError } from "./input-error.js";

/** Validate before invoking the callback while retaining an accurate discovery schema. */
export function registerValidatedTool<Schema extends z.ZodType>(
  server: McpServer,
  name: string,
  config: { inputSchema: Schema; description?: string },
  callback: (input: z.output<Schema>, context: ServerContext) => Promise<CallToolResult>,
): void {
  const jsonSchema = z.toJSONSchema(config.inputSchema);
  const passthrough: jsonSchemaValidator = {
    getValidator: (() => (data: unknown) => ({ valid: true, data, errorMessage: undefined })) as jsonSchemaValidator["getValidator"],
  };
  const advertised = fromJsonSchema<unknown>(jsonSchema as Parameters<typeof fromJsonSchema>[0], passthrough);
  server.registerTool(name, { ...config, inputSchema: advertised }, async (input, context) => {
    const result = await config.inputSchema.safeParseAsync(input);
    if (!result.success) {
      const message = formatInputError(result.error.issues, input);
      return { isError: true, content: [{ type: "text", text: JSON.stringify({ code: "INPUT_INVALID", message }) }] };
    }
    return callback(result.data, context);
  });
}
