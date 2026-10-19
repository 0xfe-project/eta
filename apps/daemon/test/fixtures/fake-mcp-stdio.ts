/** The fake MCP server on stdio: a script a test starts as a child process. */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { fakeMcpServer } from "./fake-mcp";

void fakeMcpServer().connect(new StdioServerTransport());
