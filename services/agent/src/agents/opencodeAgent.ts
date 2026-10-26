import type { AgentHealth, AgentModelOption, AgentReply, AgentService } from "./agentService.js";
import { OpencodeClient } from "../opencode/opencodeClient.js";

export class OpencodeAgent implements AgentService {
  readonly name = "opencode";
  readonly displayName = "opencode";

  constructor(private readonly client: OpencodeClient) {}

  async health(): Promise<AgentHealth> {
    return this.client.health();
  }

  async createSession(chatId: number): Promise<string> {
    return this.client.createSession(chatId);
  }

  async listModels(): Promise<AgentModelOption[]> {
    return this.client.listModels();
  }

  getModel(): string | undefined {
    return this.client.getModel();
  }

  async setModel(model: string): Promise<void> {
    await this.client.setModel(model);
  }

  async sendMessage(sessionId: string, text: string): Promise<AgentReply> {
    return { text: await this.client.sendMessage(sessionId, text), format: "markdown" };
  }
}
