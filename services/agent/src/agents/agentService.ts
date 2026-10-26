export type AgentHealth = {
  healthy: boolean;
  version?: string;
};

export type AgentReply = {
  text: string;
  format?: "markdown";
};

export type AgentModelOption = {
  id: string;
  providerId: string;
  providerName: string;
  modelId: string;
  modelName: string;
};

export type AgentService = {
  name: string;
  displayName: string;
  health(): Promise<AgentHealth>;
  createSession(chatId: number): Promise<string>;
  listModels(): Promise<AgentModelOption[]>;
  getModel(): string | undefined;
  setModel(model: string): Promise<void>;
  sendMessage(sessionId: string, text: string): Promise<AgentReply>;
};
