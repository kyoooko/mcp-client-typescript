
import { Anthropic } from "@anthropic-ai/sdk";
import { MessageParam, Tool } from "@anthropic-ai/sdk/resources/messages/messages.mjs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import readline from "readline/promises";

import dotenv from "dotenv";
dotenv.config();



const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
if (!ANTHROPIC_API_KEY) {
  throw new Error("ANTHROPIC_API_KEY is not set");
}

// サーバー候補リスト（必要に応じてパスを追加）
const SERVER_CANDIDATES = [
  "/Users/iida/Desktop/custom-mcp/link-ag-achievement/dist/index.js",
  "/Users/iida/Desktop/mcp/weather-nodejs/build/index.js"
  // 他のサーバースクリプトパスをここに追加
];

// サーバーのツール情報を取得
async function getServerTools(serverScriptPath: string): Promise<{tools: Tool[], client: Client, transport: StdioClientTransport}> {
  const client = new Client({ name: "mcp-client-cli", version: "1.0.0" });
  const isJs = serverScriptPath.endsWith(".js");
  const isPy = serverScriptPath.endsWith(".py");
  const command = isPy
    ? process.platform === "win32"
      ? "python"
      : "python3"
    : process.execPath;
  const transport = new StdioClientTransport({
    command,
    args: [serverScriptPath],
    env: Object.fromEntries(
      Object.entries(process.env).filter(([_, v]) => typeof v === "string") as [string, string][]
    ),
  });
  await client.connect(transport);
  const toolsResult = await client.listTools();
  const tools = toolsResult.tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema,
  }));
  // デバッグ出力
  console.log(`\n[DEBUG] ツールリスト for ${serverScriptPath}`);
  tools.forEach((tool, idx) => {
    console.log(`[DEBUG] Tool${idx + 1}: name='${tool.name}', description='${tool.description}'`);
  });
  return { tools, client, transport };
}

// クエリに最もマッチするサーバーを選択
async function selectServerScript(query: string): Promise<{path: string, tools: Tool[], client: Client, transport: StdioClientTransport}> {
  // 1. 各サーバーのツール情報をすべて取得
  const allServerInfos: { path: string, tools: Tool[], client: Client, transport: StdioClientTransport }[] = [];
  for (const path of SERVER_CANDIDATES) {
    try {
      const { tools, client, transport } = await getServerTools(path);
      allServerInfos.push({ path, tools, client, transport });
    } catch (e) {
      // サーバー起動失敗時はスキップ
    }
  }
  if (allServerInfos.length === 0) throw new Error("No suitable MCP server found.");

  // 2. LLMにツール情報とクエリを渡して最適なサーバーを選ばせる
  const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
  const toolListText = allServerInfos.map((info, idx) => {
    const toolDescs = info.tools.map((tool, tIdx) => `  Tool${tIdx + 1}: name='${tool.name}', description='${tool.description}'`).join("\n");
    return `サーバー${idx + 1}: path='${info.path}'\n${toolDescs}`;
  }).join("\n\n");

  const systemPrompt = `あなたはユーザーのクエリに最も適したMCPサーバーを選択するAIです。サーバーごとのツール情報を参考に、最も関連性が高いサーバーのpathのみを厳密に1つだけ出力してください。理由や説明は不要です。`;
  const userPrompt = `ユーザークエリ: ${query}\n\n利用可能なサーバーとツール:\n${toolListText}`;

  const response = await anthropic.messages.create({
    model: "claude-3-5-sonnet-20241022",
    max_tokens: 200,
    messages: [
      { role: "user", content: systemPrompt + "\n" + userPrompt }
    ]
  });
  const llmText = response.content.map(c => c.type === "text" ? c.text : "").join("").trim();
  // pathだけを抽出
  const selectedPath = allServerInfos.find(info => llmText.includes(info.path))?.path;
  if (!selectedPath) throw new Error("LLMが有効なサーバーパスを返しませんでした: " + llmText);
  const selected = allServerInfos.find(info => info.path === selectedPath)!;
  // 不要なクライアントはクローズ
  for (const info of allServerInfos) {
    if (info.path !== selectedPath) {
      await info.client.close();
      await info.transport.close?.();
    }
  }
  // サーバー名（最初のツール名）を表示
  const serverName = selected.tools[0]?.name || selected.path.split("/").pop() || selected.path;
  console.log(`\n[DEBUG] LLMが選択したMCP server: ${serverName}`);
  return selected;
}

// 基本的なクライアントクラスを作成
class MCPClient {
  private mcp: Client;
  private anthropic: Anthropic;
  private transport: StdioClientTransport | null = null;
  private tools: Tool[] = [];

  constructor(client: Client, transport: StdioClientTransport, tools: Tool[]) {
    this.anthropic = new Anthropic({
      apiKey: ANTHROPIC_API_KEY,
    });
    this.mcp = client;
    this.transport = transport;
    this.tools = tools;
  }

  // メッセージを処理し、必要に応じてLLMを通じてツール呼び出し行う（chatLoop内で使用される）
  async processQuery(query: string) {
    const messages: MessageParam[] = [
      {
        role: "user",
        content: query,
      },
    ];

    const response = await this.anthropic.messages.create({
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 1000,
      messages,
      tools: this.tools,
    });

    const finalText = [];

    for (const content of response.content) {
      if (content.type === "text") {
        finalText.push(content.text);
      } else if (content.type === "tool_use") {
        const toolName = content.name;
        const toolArgs = content.input as { [x: string]: unknown } | undefined;

        const result = await this.mcp.callTool({
          name: toolName,
          arguments: toolArgs,
        });

        finalText.push(
          `[Calling tool ${toolName} with args ${JSON.stringify(toolArgs)}]`
        );

        messages.push({
          role: "user",
          content: result.content as string,
        });
        const response = await this.anthropic.messages.create({
          model: "claude-3-5-sonnet-20241022",
          max_tokens: 1000,
          messages,
        });

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
    if (this.transport) await this.transport.close?.();
  }
}

// メインエントリーポイント
async function main() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const query = await rl.question("最初のクエリを入力してください: ");
  rl.close();

  // クエリに応じてサーバーを自動選択
  const { path, tools, client, transport } = await selectServerScript(query);
  console.log(`Selected MCP server: ${path}`);
  const mcpClient = new MCPClient(client, transport, tools);
  try {
    await mcpClient.chatLoop();
  } finally {
    await mcpClient.cleanup();
    process.exit(0);
  }
}

main();

