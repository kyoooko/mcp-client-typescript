import { Anthropic } from "@anthropic-ai/sdk";
import {
  MessageParam,
  Tool,
} from "@anthropic-ai/sdk/resources/messages/messages.mjs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import readline from "readline/promises";
import dotenv from "dotenv";

dotenv.config();

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
if (!ANTHROPIC_API_KEY) {
  throw new Error("ANTHROPIC_API_KEY is not set");
}

// 基本的なクライアントクラスを作成
class MCPClient {
  private mcp: Client;
  private anthropic: Anthropic;
  private transport: StdioClientTransport | null = null;
  private tools: Tool[] = [];

  constructor() {
    this.anthropic = new Anthropic({
      apiKey: ANTHROPIC_API_KEY,
    });
    this.mcp = new Client({ name: "mcp-client-cli", version: "1.0.0" });
  }

  // MCPサーバーとの初期化接続（その際、利用できるツール一覧も取得）
   async connectToServer(serverScriptPath: string) {
    try {
        const isJs = serverScriptPath.endsWith(".js");
        const isPy = serverScriptPath.endsWith(".py");
        if (!isJs && !isPy) {
            throw new Error("Server script must be a .js or .py file");
        }
        const command = isPy
        ? process.platform === "win32"
            ? "python"
            : "python3"
        : process.execPath;

        // 接続
        this.transport = new StdioClientTransport({
            command,
            args: [serverScriptPath],
        });
        await this.mcp.connect(this.transport);

        // 利用できるツールの一覧を取得
        const toolsResult = await this.mcp.listTools();
        this.tools = toolsResult.tools.map((tool) => {
            return {
                name: tool.name,
                description: tool.description,
                input_schema: tool.inputSchema,
            };
        });
            console.log(
            "Connected to server with tools:",
            this.tools.map(({ name }) => name)
        );
    } catch (e) {
        console.log("Failed to connect to MCP server: ", e);
        throw e;
    }
  } 

  // メッセージを処理し、必要に応じてLLMを通じてツール呼び出し行う（chatLoop内で使用される）
  async processQuery(query: string) {
    // メッセージ=クエリ
    const messages: MessageParam[] = [
        {
        role: "user",
        content: query,
        },
    ];

    // LLMにメッセージと使えるツール一覧を送る
    const response = await this.anthropic.messages.create({
        model: "claude-3-5-sonnet-20241022",
        max_tokens: 1000,
        messages,
        tools: this.tools,
    });

    const finalText = [];

    for (const content of response.content) {
        // LLMからのレスポンスがテキストの場合
        if (content.type === "text") {
        // finalTextにテキストを追加
          finalText.push(content.text);

        // LLMからのレスポンスがツール呼び出しの場合
        } else if (content.type === "tool_use") {
            // ツールを実行（callTool）
            const toolName = content.name;
            const toolArgs = content.input as { [x: string]: unknown } | undefined;

            const result = await this.mcp.callTool({
                name: toolName,
                arguments: toolArgs,
            });

            // finalTextにツール呼び出しの結果を追加
            finalText.push(
                `[Calling tool ${toolName} with args ${JSON.stringify(toolArgs)}]`
            );

            // ツールの結果をLLMに送信して整形
            messages.push({
                role: "user",
                content: result.content as string,
            });
            const response = await this.anthropic.messages.create({
                model: "claude-3-5-sonnet-20241022",
                max_tokens: 1000,
                messages,
            });

            // finalTextにツールの結果をLLMで整形した結果を追加
            finalText.push(
                response.content[0].type === "text" ? response.content[0].text : ""
            );
        }
    }

    return finalText.join("\n");
  }

  // チャット ループ
  async chatLoop() {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });

    try {
        console.log("\nMCP Client Started!");
        console.log("Type your queries or 'quit' to exit.");

        while (true) {
        const message = await rl.question("\nQuery: ");
        if (message.toLowerCase() === "quit") {
            break;
        }
        // processQueryの実行（メッセージを処理し、必要に応じてLLMを通じてツール呼び出しを行う）
        const response = await this.processQuery(message);
        console.log("\n" + response);
        }
    } finally {
        rl.close();
    }
  }

  // クリーンアップ
  async cleanup() {
    await this.mcp.close();
  }
}

// メインエントリーポイント
async function main() {
  if (process.argv.length < 3) {
    console.log("Usage: node index.ts <path_to_server_script>");
    return;
  }
  const mcpClient = new MCPClient();
  try {
    // MCPサーバーとの初期化接続（その際、利用できるツール一覧も取得）
    await mcpClient.connectToServer(process.argv[2]);

    // チャットループの開始（メッセージを処理し、必要に応じてLLMを通じてツール呼び出しを行う）
    await mcpClient.chatLoop();
    
  } finally {
    // クリーンアップ
    await mcpClient.cleanup();
    process.exit(0);
  }
}

// メインエントリーポイントを実行
main();

