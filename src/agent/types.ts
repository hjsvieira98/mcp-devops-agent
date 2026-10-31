export type ToolCall = {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
};

export type ConversationMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls: ToolCall[] }
  | { role: 'tool'; toolCallId: string; name: string; content: string; isError: boolean };

export type AgentTool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** Fail closed: only an explicit readOnlyHint of true counts as read-only. */
  readOnly: boolean;
};

export type ModelCompletion = {
  content: string;
  toolCalls: ToolCall[];
};

export interface LanguageModel {
  readonly provider: string;
  readonly model: string;
  complete(input: {
    messages: readonly ConversationMessage[];
    tools: readonly AgentTool[];
  }): Promise<ModelCompletion>;
}

export type ExecutedToolCall = {
  name: string;
  arguments: Record<string, unknown>;
  executed: boolean;
  isError: boolean;
  content: string;
};

export type AgentStopReason = 'completed' | 'max_steps';

export type AgentResult = {
  text: string;
  steps: number;
  toolCalls: ExecutedToolCall[];
  stoppedReason: AgentStopReason;
};

export type AgentEvent =
  | { type: 'tool_start'; call: ToolCall }
  | { type: 'tool_end'; call: ToolCall; isError: boolean }
  | { type: 'tool_declined'; call: ToolCall };
