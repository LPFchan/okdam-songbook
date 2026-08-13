import type { BearerMcpMountOptions, McpProtocolRevision, McpScope } from "@songbook/shared";

/** MCP package boundary; transport and tools are assigned to the MCP wave. */
export interface StatelessMcpContract {
  revision: McpProtocolRevision;
  scopes: McpScope[];
  mount: BearerMcpMountOptions;
}

export const mcpPackage = "@songbook/mcp" as const;
