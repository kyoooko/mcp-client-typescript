
// TODO: 該当サーバー見つからない際は普通にLLMで回答するようにする
// TODO: 昨日が解釈されない
// TODO: MCPの選択から回答までLLMがよしなに行う
// TODO: LLMがよしなにMCP複数組み合わせる

// Gemini SDKは「Tool」機能が標準で存在しないため、ツール選択・引数生成・レスポンス解釈をすべてプロンプト設計と自前実装で補っています。
import { GoogleGenerativeAI } from "@google/generative-ai";
// そのためTool型は自前定義
type Tool = {
  name: string;
  description: string;
  input_schema: any;
};
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import readline from "readline/promises";

import dotenv from "dotenv";
dotenv.config();



const GEMINI_API_KEY = process.env.GEMINI_API_KEY ?? "";
if (!GEMINI_API_KEY) {
  throw new Error("GEMINI_API_KEY is not set");
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
    description: tool.description ?? "",
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

  // Gemini APIでツール選択
  const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
  const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
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

  const prompt = `あなたはユーザーのクエリに最も適したMCPサーバーのツール（pathとtool名の組み合わせ）を選択するAIです。全ツール情報を参考に、最も関連性が高いツールのpathとtool名のみを厳密に1つだけ出力してください。理由や説明は不要です。出力形式は必ず path=<パス>, name=<ツール名> のみ。\nユーザークエリ: ${query}\n\n利用可能なツールリスト:\n${toolListText}`;
  const result = await model.generateContent(prompt);
  const llmText = result.response.text().trim();
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
  console.log(`\n[DEBUG] LLMが選択したMCPツール: ${selectedName} (in ${selectedPath})\n\n`);
  return { ...selectedServer, selectedTool };
}

// 基本的なクライアントクラスを作成
class MCPClient {
  private mcp: Client;
  private genAI: GoogleGenerativeAI;
  private transport: StdioClientTransport | null = null;
  private tools: Tool[] = [];

  constructor(client: Client, transport: StdioClientTransport, tools: Tool[]) {
  this.genAI = new GoogleGenerativeAI(GEMINI_API_KEY ?? "");
    this.mcp = client;
    this.transport = transport;
    this.tools = tools;
  }

  // Gemini APIでツール呼び出し指示を生成
  async processQuery(query: string) {
    // Geminiはtool_use構造がないため、ツール呼び出しはプロンプトで誘導
    const toolListText = this.tools.map((tool, idx) =>
      `Tool${idx + 1}: name='${tool.name}', description='${tool.description}', input_schema=${JSON.stringify(tool.input_schema)}`
    ).join("\n");
    const prompt = `あなたはMCPサーバーツールを使うAIです。以下のツールリストから、ユーザーのクエリに最も適したツール名とその入力値(JSON)を1つだけ厳密に出力してください。\n必須項目や型はinput_schemaを必ず参照し、必須項目は必ず埋めてください。理由や説明は不要です。出力形式は必ず name=<ツール名>, args=<JSON> のみ。\nユーザークエリ: ${query}\n\n利用可能なツールリスト:\n${toolListText}`;
    const model = this.genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
    const result = await model.generateContent(prompt);
    const llmText = result.response.text().trim();
    const match = llmText.match(/name=(.*?),\s*args=(\{.*\})/);
    if (!match) throw new Error("Geminiが有効なツール指示を返しませんでした: " + llmText);
    const toolName = match[1].trim();
    const toolArgs = JSON.parse(match[2]);
    // デバッグ用: LLMが生成したツール名と引数
    console.log(`[DEBUG] Geminiが生成したツール指示: name=${toolName}, args=${JSON.stringify(toolArgs, null, 2)}\n\n`);
    const resultTool = await this.mcp.callTool({
      name: toolName,
      arguments: toolArgs,
    });
    let content = resultTool.content;
    // デバッグ用にMCPツールの生データを表示（長い場合は最初と最後のみ、配列も含め全体を対象）
    let debugStr = "";
    if (Array.isArray(content)) {
      debugStr = JSON.stringify(content, null, 2);
    } else if (typeof content === "object") {
      debugStr = JSON.stringify(content, null, 2);
    } else if (typeof content === "string") {
      debugStr = content;
    } else {
      debugStr = String(content);
    }
    if (debugStr.length > 1000) {
      const head = debugStr.slice(0, 500);
      const tail = debugStr.slice(-500);
      console.log(`[DEBUG] MCPツール生データ:\n\n (head 500 chars)\n${head}\n\n...省略...\n\n(tail 500 chars)\n${tail}\n\n`);
    } else {
      console.log("[DEBUG] MCPツール生データ:", debugStr, "\n\n");
    }
    // 配列形式で返ってきた場合はtype: textのtextだけ抽出
    if (Array.isArray(content)) {
      const texts = content
        .filter((item) => item.type === "text" && typeof item.text === "string")
        .map((item) => item.text)
        .join("\n\n");
      content = texts || JSON.stringify(content, null, 2);
    } else if (typeof content === "object") {
      content = JSON.stringify(content, null, 2);
    }
  // ユーザーの質問とMCPツールのレスポンスをもとに、直接的な日本語回答をGeminiで生成
  // モデル指定
  // const answerModel = this.genAI.getGenerativeModel({ model: "gemini-2.5-pro" });
  const answerModel = this.genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
  const answerPrompt = `ユーザーの質問: ${query}\n\n次のMCPツールのデータを参考に、ユーザーの質問に対して日本語で簡潔かつ直接的に回答してください。不要な情報は省き、質問に合った内容だけを答えてください。\n\nMCPツールの生データ（start）:\n${content}\nMCPツールの生データ（end）`;
  // ここデバッグ
  console.log(`[DEBUG] Geminiに送信する回答生成プロンプト:\n\n${answerPrompt}\n\n`);
  const answerResult = await answerModel.generateContent(answerPrompt);
  const answerText = answerResult.response.text().trim();
  return `【回答】\n${answerText}`;
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

    console.log(`\n\nSelected MCP tool: ${selectedTool.name} in ${path}`);
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

