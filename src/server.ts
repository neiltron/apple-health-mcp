#!/usr/bin/env bun

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ErrorCode,
  McpError
} from "@modelcontextprotocol/sdk/types.js";

import { HealthDataDB } from "./db/database.js";
import { FileCatalog } from "./db/catalog.js";
import { TableLoader } from "./db/loader.js";
import { QueryCache } from "./core/cache.js";
import { MemoryManager } from "./core/memory.js";
import { QueryOptimizer } from "./core/optimizer.js";
import { HealthQueryTool } from "./tools/health-query.js";
import { HealthInsightsTool } from "./tools/health-insights.js";
import { HealthReportTool } from "./tools/health-report.js";

// Get configuration from environment
const DATA_DIR = process.env.HEALTH_DATA_DIR || './HealthAll_2025-07-202_01-04-39_SimpleHealthExportCSV';
const MAX_MEMORY_MB = parseInt(process.env.MAX_MEMORY_MB || '1024');
const CACHE_SIZE = parseInt(process.env.CACHE_SIZE || '100');

// Validate data directory
if (!DATA_DIR) {
  // console.error('ERROR: HEALTH_DATA_DIR environment variable not set');
  // console.error('Usage: HEALTH_DATA_DIR=/path/to/health/data bun run src/server.ts');
  process.exit(1);
}

// console.log(`Starting Apple Health MCP Server...`);
// console.log(`Data directory: ${DATA_DIR}`);
// console.log(`Max memory: ${MAX_MEMORY_MB}MB`);

// Initialize components
const db = new HealthDataDB({ dataDir: DATA_DIR, maxMemoryMB: MAX_MEMORY_MB });
const catalog = new FileCatalog(DATA_DIR);
const loader = new TableLoader(db, catalog);
const cache = new QueryCache(CACHE_SIZE);
const memoryManager = new MemoryManager(db, catalog, loader, MAX_MEMORY_MB);
const optimizer = new QueryOptimizer(loader, catalog);

// Initialize tools
const queryTool = new HealthQueryTool(db, cache, optimizer);
const insightsTool = new HealthInsightsTool(db, cache, optimizer);
const reportTool = new HealthReportTool(db, cache);

// Create MCP server
const server = new Server({
  name: "apple-health-mcp",
  version: "1.0.0",
}, {
  capabilities: {
    tools: {}
  }
});

// List available tools
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "health_query",
      description: "Execute SQL queries on Apple Health data. Supports SELECT queries only.",
      inputSchema: {
        type: "object",
        properties: {
          query: { 
            type: "string",
            description: "SQL SELECT query to execute"
          },
          format: { 
            type: "string", 
            enum: ["json", "csv", "summary"],
            description: "Output format (default: json)"
          }
        },
        required: ["query"]
      }
    },
    {
      name: "health_insights",
      description: "Get health insights using natural language questions",
      inputSchema: {
        type: "object",
        properties: {
          question: { 
            type: "string",
            description: "Natural language question about health data"
          },
          timeframe: { 
            type: "string",
            description: "Time period (e.g., '7 days', '1 month', '3 months')",
            default: "30 days"
          },
          metrics: {
            type: "array",
            items: { type: "string" },
            description: "Specific metrics to include"
          }
        },
        required: ["question"]
      }
    },
    {
      name: "health_report",
      description: "Generate structured health reports for a specific period",
      inputSchema: {
        type: "object",
        properties: {
          report_type: {
            type: "string",
            enum: ["weekly", "monthly", "custom"],
            description: "Type of report to generate"
          },
          start_date: {
            type: "string",
            format: "date",
            description: "Start date for custom reports (YYYY-MM-DD)"
          },
          end_date: {
            type: "string",
            format: "date",
            description: "End date for custom reports (YYYY-MM-DD)"
          },
          include_metrics: {
            type: "array",
            items: { type: "string" },
            description: "Metrics to include (default: all)"
          }
        },
        required: ["report_type"]
      }
    }
  ]
}));

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  
  try {
    switch (name) {
      case "health_query":
        return {
          content: [{
            type: "text",
            text: JSON.stringify(await queryTool.execute(args), null, 2)
          }]
        };
        
      case "health_insights":
        return {
          content: [{
            type: "text",
            text: JSON.stringify(await insightsTool.execute(args), null, 2)
          }]
        };
        
      case "health_report":
        return {
          content: [{
            type: "text",
            text: JSON.stringify(await reportTool.execute(args), null, 2)
          }]
        };
        
      default:
        throw new McpError(
          ErrorCode.MethodNotFound,
          `Unknown tool: ${name}`
        );
    }
  } catch (error) {
    // console.error(`Error executing tool ${name}:`, error);
    
    if (error instanceof McpError) {
      throw error;
    }
    
    throw new McpError(
      ErrorCode.InternalError,
      `Tool execution failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }
});

// Initialize and start server
async function main() {
  try {
    // Initialize database and catalog
    // console.log('Initializing database...');
    await db.initialize();
    
    // console.log('Scanning health data files...');
    await catalog.initialize();
    
    // Start memory monitoring
    memoryManager.startMonitoring();
    
    // Connect to transport
    const transport = new StdioServerTransport();
    await server.connect(transport);
    
    // console.log('Apple Health MCP Server ready!');
    
    // Handle shutdown
    process.on('SIGINT', async () => {
      // console.log('\\nShutting down...');
      memoryManager.stopMonitoring();
      await db.close();
      process.exit(0);
    });
    
  } catch (error) {
    // console.error('Failed to start server:', error);
    process.exit(1);
  }
}

// Start the server
main().catch(() => {});