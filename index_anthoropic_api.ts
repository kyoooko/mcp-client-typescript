
// Anthropic APIを使用 →1分あたりのレート制限にかかりやすい
// Claude SDKは「Tool」機能をネイティブでサポートしており、toolsパラメータにツール情報を渡すことで、LLMが自動的にツール呼び出し・引数生成・レスポンス処理まで一貫して行います。
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
// selectedToolを返すよう型を修正
async function selectServerScript(query: string): Promise<{path: string, tools: Tool[], client: Client, transport: StdioClientTransport, selectedTool: Tool}> {
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

  // 2. ツール単位でLLMに最適なツールを選ばせる
  const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
  // 各ツールを一意に識別できるよう path + tool名 でリスト化
  const allTools = allServerInfos.flatMap(info =>
    info.tools.map(tool => ({
      path: info.path,
      name: tool.name,
      description: tool.description,
      input_schema: tool.input_schema
    }))
  );
  const toolListText = allTools.map((tool, idx) =>
    `Tool${idx + 1}: path='${tool.path}', name='${tool.name}', description='${tool.description}'`
  ).join("\n");

  const systemPrompt = `あなたはユーザーのクエリに最も適したMCPサーバーのツール（pathとtool名の組み合わせ）を選択するAIです。全ツール情報を参考に、最も関連性が高いツールのpathとtool名のみを厳密に1つだけ出力してください。理由や説明は不要です。出力形式は必ず path=<パス>, name=<ツール名> のみ。`;
  const userPrompt = `ユーザークエリ: ${query}\n\n利用可能なツールリスト:\n${toolListText}`;

  const response = await anthropic.messages.create({
    model: "claude-3-5-sonnet-20241022",
    max_tokens: 200,
    messages: [
      { role: "user", content: systemPrompt + "\n" + userPrompt }
    ]
  });
  const llmText = response.content.map(c => c.type === "text" ? c.text : "").join("").trim();
  // pathとnameを抽出
  const match = llmText.match(/path=(.*?),\s*name=(.*)/);
  if (!match) throw new Error("LLMが有効なツール選択を返しませんでした: " + llmText);
  const selectedPath = match[1].trim();
  const selectedName = match[2].trim();
  const selectedServer = allServerInfos.find(info => info.path === selectedPath);
  if (!selectedServer) throw new Error("該当サーバーが見つかりません: " + selectedPath);
  const selectedTool = selectedServer.tools.find(t => t.name === selectedName);
  if (!selectedTool) throw new Error("該当ツールが見つかりません: " + selectedName);
  // 不要なクライアントはクローズ
  for (const info of allServerInfos) {
    if (info.path !== selectedPath) {
      await info.client.close();
      await info.transport.close?.();
    }
  }
  console.log(`\n[DEBUG] LLMが選択したMCPツール: ${selectedName} (in ${selectedPath})`);
  return { ...selectedServer, selectedTool };
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
  while (true) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const query = await rl.question("クエリを入力してください: ");
    rl.close();

    // クエリに応じて最適なツールを自動選択
    let serverInfo;
    try {
      serverInfo = await selectServerScript(query);
    } catch (e) {
      console.error(e);
      continue;
    }
    const { path, tools, client, transport, selectedTool } = serverInfo;
    const toolLabel = `${selectedTool.name}`;

    // ツール選択確認
    const rl2 = readline.createInterface({ input: process.stdin, output: process.stdout });
    const confirm = await rl2.question(`MCPツール: ${toolLabel} を使用して良いですか？: `);
    rl2.close();
    if (confirm.trim().toLowerCase() !== "ok") {
      console.log("終了します");
      continue;
    }

    console.log(`Selected MCP tool: ${selectedTool.name} in ${path}`);
    // 選択ツールのみをMCPClientに渡す
    const mcpClient = new MCPClient(client, transport, [selectedTool]);
    try {
      await mcpClient.processQuery(query).then(res => console.log("\n" + res));
    } finally {
      await mcpClient.cleanup();
    }
    // 1回で終了、再度最初のクエリ入力に戻る
  }
}

main();

