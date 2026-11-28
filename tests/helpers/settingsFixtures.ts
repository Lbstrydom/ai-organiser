/** Provider configurations whose request bytes and settings rendering are pinned. */
const AZURE = {
    serviceType: 'cloud',
    azureFirstMode: true,
    azureAIEndpoint: 'https://my-resource.services.ai.azure.com',
    azureOpenAIEndpoint: 'https://my-resource.openai.azure.com',
    azureApiKey: 'AZ-KEY',
};

export const SETTINGS_FIXTURES: Record<string, Record<string, unknown>> = {
    'azure model-based (Claude main)': {
        ...AZURE, cloudServiceType: 'azure-claude', cloudModel: 'claude-sonnet-5-5',
        azureRoutingMode: 'model-based', azureGPTModel: 'gpt-5.5',
    },
    'azure deployment-based (OpenAI main)': {
        ...AZURE, cloudServiceType: 'azure-openai', cloudModel: 'gpt-chat-dep', azureGPTModel: 'gpt-other',
        azureRoutingMode: 'deployment-based', azureDeployments: { chat: 'gpt-chat-dep', embeddings: 'embed-dep' },
        embeddingModel: 'text-embedding-3-large',
    },
    'azure gateway': {
        ...AZURE, cloudServiceType: 'azure-claude', cloudModel: 'claude-sonnet-5-5',
        azureOpenAIEndpoint: 'https://my-apim.azure-api.net/foundry', azureClaudeViaOpenAIGateway: true,
        azureRoutingMode: 'deployment-based', azureDeployments: { chat: 'gpt-5.5', embeddings: 'text-embedding-3-large' },
    },
    'azure per-feature override': {
        ...AZURE, cloudServiceType: 'azure-openai', cloudModel: 'gpt-5.5', azureGPTModel: 'gpt-5.5',
        azureRoutingMode: 'deployment-based', azureDeployments: { chat: 'gpt-5.5', embeddings: 'legacy-embed' },
        azureWhisperDeployment: 'legacy-whisper',
        azureCapabilities: {
            embeddings: { mode: 'azure', deployment: 'override-embed' },
            transcription: { mode: 'azure', deployment: 'override-whisper' },
            tts: { mode: 'azure', deployment: 'override-tts' },
            websearch: { mode: 'azure', deployment: 'override-search' },
        },
    },
    'direct claude': {
        serviceType: 'cloud', cloudServiceType: 'claude', cloudModel: 'claude-sonnet-5-5',
        cloudEndpoint: 'https://api.anthropic.com/v1/messages', cloudApiKey: 'sk-ant-key',
    },
    'direct openai': {
        serviceType: 'cloud', cloudServiceType: 'openai', cloudModel: 'gpt-5.5',
        cloudEndpoint: 'https://api.openai.com/v1/chat/completions', cloudApiKey: 'sk-key',
    },
    'local ollama': {
        serviceType: 'local', localEndpoint: 'http://localhost:11434/v1/chat/completions', localModel: 'llama3',
    },
};
