import type {
  AgentEvent,
  AgentResult,
  AgentTool,
  ConversationMessage,
  ExecutedToolCall,
  LanguageModel,
  ToolCall,
} from './types.js';

export type ToolExecution = {
  content: string;
  isError: boolean;
};

export type RunAgentOptions = {
  model: LanguageModel;
  tools: readonly AgentTool[];
  execute: (call: ToolCall) => Promise<ToolExecution>;
  confirmWrite: (call: ToolCall) => Promise<boolean>;
  task: string;
  system: string;
  maxSteps: number;
  onEvent?: (event: AgentEvent) => void;
};

export class AgentLoopError extends Error {
  override readonly name = 'AgentLoopError';
}

/**
 * One step is one tool execution, including a write the user declines.
 * When the budget is spent, the model gets one more turn with no tools so it can answer
 * from the results it already has.
 */
export async function runAgent(options: RunAgentOptions): Promise<AgentResult> {
  if (!Number.isInteger(options.maxSteps) || options.maxSteps < 1) {
    throw new AgentLoopError('maxSteps must be an integer of at least 1.');
  }

  const messages: ConversationMessage[] = [
    { role: 'system', content: options.system },
    { role: 'user', content: options.task },
  ];
  const trace: ExecutedToolCall[] = [];
  let toolExecutions = 0;

  for (;;) {
    const forceFinal = toolExecutions >= options.maxSteps;
    const response = await options.model.complete({
      messages,
      tools: forceFinal ? [] : options.tools,
    });
    const toolCalls = forceFinal ? [] : response.toolCalls;
    messages.push({ role: 'assistant', content: response.content, toolCalls });

    if (toolCalls.length === 0) {
      return {
        text: response.content,
        steps: toolExecutions,
        toolCalls: trace,
        stoppedReason: forceFinal ? 'max_steps' : 'completed',
      };
    }

    for (const call of toolCalls) {
      if (toolExecutions >= options.maxSteps) {
        pushTrace(messages, trace, call, {
          content: `Tool-call budget of ${options.maxSteps} is exhausted. Do not call more tools. Summarize from the results you already have.`,
          isError: true,
          executed: false,
        });
        continue;
      }

      const tool = options.tools.find((candidate) => candidate.name === call.name);
      if (!tool) {
        const available = options.tools.map((candidate) => candidate.name).join(', ');
        pushTrace(messages, trace, call, {
          content: `Unknown tool "${call.name}". Available tools: ${available}.`,
          isError: true,
          executed: false,
        });
        toolExecutions += 1;
        continue;
      }

      if (!tool.readOnly) {
        const allowed = await options.confirmWrite(call);
        if (!allowed) {
          options.onEvent?.({ type: 'tool_declined', call });
          pushTrace(messages, trace, call, {
            content: `Write action "${call.name}" was declined by the user. Do not retry it unless the user explicitly asks again.`,
            isError: true,
            executed: false,
          });
          toolExecutions += 1;
          continue;
        }
      }

      options.onEvent?.({ type: 'tool_start', call });
      let result: ToolExecution;
      try {
        result = await options.execute(call);
      } catch (error) {
        result = {
          content: error instanceof Error ? error.message : 'Tool execution failed.',
          isError: true,
        };
      }
      options.onEvent?.({ type: 'tool_end', call, isError: result.isError });
      pushTrace(messages, trace, call, { ...result, executed: true });
      toolExecutions += 1;
    }
  }
}

function pushTrace(
  messages: ConversationMessage[],
  trace: ExecutedToolCall[],
  call: ToolCall,
  outcome: { content: string; isError: boolean; executed: boolean },
): void {
  messages.push({
    role: 'tool',
    toolCallId: call.id,
    name: call.name,
    content: outcome.content,
    isError: outcome.isError,
  });
  trace.push({
    name: call.name,
    arguments: call.arguments,
    executed: outcome.executed,
    isError: outcome.isError,
    content: outcome.content,
  });
}
