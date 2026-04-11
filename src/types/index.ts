export interface Settings {
  idle_timeout_seconds: number;
  llm: {
    provider: string;
    apiKey: string;
    baseUrl: string;
    model: string;
    maxTokens: number;
    temperature: number;
    systemPrompt: string;
  };
  excel: {
    mergeDuplicateNames: boolean;
    sortByName: boolean;
  };
  ui: {
    pageTitle: string;
    companyFooter: string;
  };
}

export interface ImageTask {
  message_id: number;
  file_id: string;
  chat_id: number;
  timestamp: number;
  caption?: string; // Add caption for the image
  localPath?: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  result?: AdData[];
}

export interface AdData {
  名称: string;
  消耗: number;
  展示: number;
  点击: number;
}
