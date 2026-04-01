import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import * as z from 'zod/v4';

type AuthMode = 'auto' | 'cloud_basic' | 'dc_pat';

type JsonObject = Record<string, unknown>;

interface JiraConfig {
  baseUrl: string;
  authMode: AuthMode;
  email?: string;
  token: string;
}

interface JiraRequestOptions {
  method?: string;
  path: string;
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
}

interface JiraResponse<T = unknown> {
  status: number;
  data: T;
}

class JiraHttpError extends Error {
  readonly status: number;
  readonly details: unknown;

  constructor(status: number, message: string, details: unknown) {
    super(message);
    this.name = 'JiraHttpError';
    this.status = status;
    this.details = details;
  }
}

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, '');
}

function getConfig(): JiraConfig {
  const baseUrl = process.env.JIRA_BASE_URL;
  const token = process.env.JIRA_TOKEN;
  const authMode = (process.env.JIRA_AUTH_MODE ?? 'auto') as AuthMode;
  const email = process.env.JIRA_EMAIL;

  if (!baseUrl) {
    throw new Error('Missing JIRA_BASE_URL');
  }

  if (!token) {
    throw new Error('Missing JIRA_TOKEN');
  }

  if (authMode === 'cloud_basic' && !email) {
    throw new Error('JIRA_EMAIL is required when JIRA_AUTH_MODE=cloud_basic');
  }

  return {
    baseUrl: normalizeBaseUrl(baseUrl),
    authMode,
    email: email?.trim() || undefined,
    token
  };
}

function buildAuthHeader(config: JiraConfig): string {
  const mode =
    config.authMode === 'auto' ? (config.email ? 'cloud_basic' : 'dc_pat') : config.authMode;

  if (mode === 'cloud_basic') {
    const value = Buffer.from(`${config.email ?? ''}:${config.token}`).toString('base64');
    return `Basic ${value}`;
  }

  return `Bearer ${config.token}`;
}

function buildUrl(config: JiraConfig, path: string, query?: JiraRequestOptions['query']): string {
  const url = new URL(`${config.baseUrl}${path}`);

  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined) {
      url.searchParams.set(key, String(value));
    }
  }

  return url.toString();
}

async function parseResponseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function formatErrorDetails(details: unknown): string {
  if (details == null) {
    return '';
  }

  if (typeof details === 'string') {
    return details;
  }

  try {
    return JSON.stringify(details, null, 2);
  } catch {
    return String(details);
  }
}

function summarizeJson(data: unknown): string {
  try {
    return JSON.stringify(data, null, 2);
  } catch {
    return String(data);
  }
}

class JiraClient {
  private readonly config: JiraConfig;
  private cachedServerInfo: JsonObject | null = null;

  constructor(config: JiraConfig) {
    this.config = config;
  }

  async request<T = unknown>(options: JiraRequestOptions): Promise<JiraResponse<T>> {
    const headers: Record<string, string> = {
      Accept: 'application/json',
      Authorization: buildAuthHeader(this.config)
    };

    let body: string | undefined;
    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(options.body);
    }

    const response = await fetch(buildUrl(this.config, options.path, options.query), {
      method: options.method ?? 'GET',
      headers,
      body
    });

    const data = await parseResponseBody(response);

    if (!response.ok) {
      let message = `Jira request failed with ${response.status}`;
      if (response.status === 401) {
        message +=
          this.config.authMode === 'cloud_basic' || (this.config.authMode === 'auto' && this.config.email)
            ? '. Check JIRA_EMAIL and JIRA_TOKEN for Jira Cloud Basic auth.'
            : '. Check JIRA_TOKEN for Bearer auth and confirm the instance accepts PATs.';
      }

      throw new JiraHttpError(response.status, message, data);
    }

    return { status: response.status, data: data as T };
  }

  async detectInstance(): Promise<JsonObject> {
    if (this.cachedServerInfo) {
      return this.cachedServerInfo;
    }

    const candidates = ['/rest/api/3/serverInfo', '/rest/api/2/serverInfo'];
    let lastError: unknown;

    for (const path of candidates) {
      try {
        const { data } = await this.request<JsonObject>({ path });
        const deploymentType =
          typeof data.deploymentType === 'string'
            ? data.deploymentType
            : this.inferDeploymentTypeFromUrl();

        const result = {
          ...data,
          deploymentType,
          checkedPath: path
        };
        this.cachedServerInfo = result;
        return result;
      } catch (error) {
        lastError = error;
      }
    }

    throw lastError instanceof Error ? lastError : new Error('Unable to detect Jira deployment type');
  }

  async whoAmI(): Promise<JsonObject> {
    const { data } = await this.request<JsonObject>({ path: '/rest/api/2/myself' });
    return data;
  }

  async listProjects(maxResults?: number): Promise<unknown> {
    try {
      const { data } = await this.request<JsonObject>({
        path: '/rest/api/2/project/search',
        query: maxResults ? { maxResults } : undefined
      });
      return data;
    } catch (error) {
      if (error instanceof JiraHttpError && error.status === 404) {
        const { data } = await this.request<unknown>({ path: '/rest/api/2/project' });
        return data;
      }

      throw error;
    }
  }

  async searchIssues(input: {
    jql: string;
    maxResults: number;
    startAt: number;
    fields?: string[];
  }): Promise<JsonObject> {
    const defaultFields = ['summary', 'status', 'assignee', 'reporter', 'issuetype', 'priority', 'project', 'updated'];
    const { data } = await this.request<JsonObject>({
      method: 'POST',
      path: '/rest/api/2/search',
      body: {
        jql: input.jql,
        maxResults: input.maxResults,
        startAt: input.startAt,
        fields: input.fields?.length ? input.fields : defaultFields
      }
    });
    return data;
  }

  async getIssue(issueKey: string, fields?: string[], expand?: string[]): Promise<JsonObject> {
    const query: Record<string, string> = {};
    if (fields?.length) {
      query.fields = fields.join(',');
    }
    if (expand?.length) {
      query.expand = expand.join(',');
    }

    const { data } = await this.request<JsonObject>({
      path: `/rest/api/2/issue/${encodeURIComponent(issueKey)}`,
      query
    });
    return data;
  }

  async createIssue(fields: JsonObject): Promise<JsonObject> {
    const { data } = await this.request<JsonObject>({
      method: 'POST',
      path: '/rest/api/2/issue',
      body: { fields }
    });
    return data;
  }

  async updateIssue(issueKey: string, fields?: JsonObject, update?: JsonObject): Promise<void> {
    await this.request({
      method: 'PUT',
      path: `/rest/api/2/issue/${encodeURIComponent(issueKey)}`,
      body: {
        ...(fields ? { fields } : {}),
        ...(update ? { update } : {})
      }
    });
  }

  async addComment(issueKey: string, bodyText?: string, body?: unknown): Promise<JsonObject> {
    const deployment = await this.detectInstance().catch(() => null);
    const isCloud =
      typeof deployment?.deploymentType === 'string'
        ? deployment.deploymentType.toLowerCase().includes('cloud')
        : this.config.authMode === 'cloud_basic';

    const commentBody =
      body ??
      (bodyText
        ? isCloud
          ? {
              type: 'doc',
              version: 1,
              content: [
                {
                  type: 'paragraph',
                  content: [{ type: 'text', text: bodyText }]
                }
              ]
            }
          : bodyText
        : null);

    const { data } = await this.request<JsonObject>({
      method: 'POST',
      path: `/rest/api/2/issue/${encodeURIComponent(issueKey)}/comment`,
      body: { body: commentBody }
    });
    return data;
  }

  async listTransitions(issueKey: string): Promise<JsonObject> {
    const { data } = await this.request<JsonObject>({
      path: `/rest/api/2/issue/${encodeURIComponent(issueKey)}/transitions`
    });
    return data;
  }

  async transitionIssue(issueKey: string, transitionId: string, fields?: JsonObject, update?: JsonObject): Promise<void> {
    await this.request({
      method: 'POST',
      path: `/rest/api/2/issue/${encodeURIComponent(issueKey)}/transitions`,
      body: {
        transition: { id: transitionId },
        ...(fields ? { fields } : {}),
        ...(update ? { update } : {})
      }
    });
  }

  private inferDeploymentTypeFromUrl(): string {
    try {
      const hostname = new URL(this.config.baseUrl).hostname.toLowerCase();
      if (hostname.endsWith('.atlassian.net')) {
        return 'Cloud (inferred from hostname)';
      }
    } catch {
      return 'Unknown';
    }

    return 'Unknown';
  }
}

function issueSummary(issue: JsonObject): string {
  const fields = (issue.fields as JsonObject | undefined) ?? {};
  const status = (fields.status as JsonObject | undefined)?.name;
  const summary = fields.summary;
  return `${String(issue.key ?? issue.id ?? 'issue')}: ${String(summary ?? '')} [${String(status ?? 'unknown')}]`;
}

function normalizeStructuredContent(structuredContent: unknown): Record<string, unknown> | undefined {
  if (structuredContent === undefined || structuredContent === null) {
    return undefined;
  }

  if (typeof structuredContent === 'object' && !Array.isArray(structuredContent)) {
    return structuredContent as Record<string, unknown>;
  }

  return { data: structuredContent };
}

function toolResult(summary: string, structuredContent?: unknown): CallToolResult {
  const normalizedStructuredContent = normalizeStructuredContent(structuredContent);
  return {
    content: [{ type: 'text', text: summary }],
    ...(normalizedStructuredContent ? { structuredContent: normalizedStructuredContent } : {})
  };
}

function toolError(error: unknown): CallToolResult {
  if (error instanceof JiraHttpError) {
    return {
      isError: true,
      content: [
        {
          type: 'text',
          text: `${error.message}\n${formatErrorDetails(error.details)}`.trim()
        }
      ]
    };
  }

  return {
    isError: true,
    content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }]
  };
}

async function withToolError(fn: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await fn();
  } catch (error) {
    return toolError(error);
  }
}

const server = new McpServer(
  {
    name: 'jira-bridge',
    version: '0.1.0'
  },
  {
    capabilities: {
      logging: {}
    }
  }
);

server.registerTool(
  'jira_detect_instance',
  {
    title: 'Detect Jira Deployment',
    description: 'Detects whether the configured Jira instance is Cloud or Data Center/Server.',
    inputSchema: z.object({})
  },
  async (): Promise<CallToolResult> =>
    withToolError(async () => {
      const client = new JiraClient(getConfig());
      const data = await client.detectInstance();
      return toolResult(`Detected Jira deployment: ${String(data.deploymentType ?? 'Unknown')}`, data);
    })
);

server.registerTool(
  'jira_whoami',
  {
    title: 'Who Am I',
    description: 'Validates auth by returning the current Jira user.',
    inputSchema: z.object({})
  },
  async (): Promise<CallToolResult> =>
    withToolError(async () => {
      const client = new JiraClient(getConfig());
      const data = await client.whoAmI();
      return toolResult(`Authenticated as ${String(data.displayName ?? data.name ?? data.accountId ?? 'unknown user')}`, data);
    })
);

server.registerTool(
  'jira_list_projects',
  {
    title: 'List Projects',
    description: 'Lists accessible Jira projects.',
    inputSchema: z.object({
      maxResults: z.number().int().positive().max(1000).optional()
    })
  },
  async ({ maxResults }): Promise<CallToolResult> =>
    withToolError(async () => {
      const client = new JiraClient(getConfig());
      const data = await client.listProjects(maxResults);
      return toolResult(`Fetched Jira projects.`, data);
    })
);

server.registerTool(
  'jira_search_issues',
  {
    title: 'Search Issues',
    description: 'Runs a JQL search and returns matching issues.',
    inputSchema: z.object({
      jql: z.string().min(1),
      maxResults: z.number().int().positive().max(100).default(10),
      startAt: z.number().int().min(0).default(0),
      fields: z.array(z.string()).optional()
    })
  },
  async ({ jql, maxResults, startAt, fields }): Promise<CallToolResult> =>
    withToolError(async () => {
      const client = new JiraClient(getConfig());
      const data = await client.searchIssues({ jql, maxResults, startAt, fields });
      const issues = Array.isArray(data.issues) ? (data.issues as JsonObject[]) : [];
      const lines = issues.map(issueSummary);
      return toolResult(
        lines.length
          ? `Found ${issues.length} issue(s):\n${lines.join('\n')}`
          : `No issues matched the JQL query.`,
        data
      );
    })
);

server.registerTool(
  'jira_get_issue',
  {
    title: 'Get Issue',
    description: 'Fetches a Jira issue by key or ID.',
    inputSchema: z.object({
      issueKey: z.string().min(1),
      fields: z.array(z.string()).optional(),
      expand: z.array(z.string()).optional()
    })
  },
  async ({ issueKey, fields, expand }): Promise<CallToolResult> =>
    withToolError(async () => {
      const client = new JiraClient(getConfig());
      const data = await client.getIssue(issueKey, fields, expand);
      return toolResult(issueSummary(data), data);
    })
);

server.registerTool(
  'jira_create_issue',
  {
    title: 'Create Issue',
    description: 'Creates a Jira issue from a raw Jira fields payload.',
    inputSchema: z.object({
      fields: z.record(z.string(), z.unknown())
    })
  },
  async ({ fields }): Promise<CallToolResult> =>
    withToolError(async () => {
      const client = new JiraClient(getConfig());
      const data = await client.createIssue(fields);
      return toolResult(`Created issue ${String(data.key ?? data.id ?? 'unknown')}`, data);
    })
);

server.registerTool(
  'jira_update_issue',
  {
    title: 'Update Issue',
    description: 'Updates a Jira issue using raw Jira fields and update payloads.',
    inputSchema: z.object({
      issueKey: z.string().min(1),
      fields: z.record(z.string(), z.unknown()).optional(),
      update: z.record(z.string(), z.unknown()).optional()
    })
  },
  async ({ issueKey, fields, update }): Promise<CallToolResult> =>
    withToolError(async () => {
      if (!fields && !update) {
        throw new Error('Provide at least one of fields or update.');
      }

      const client = new JiraClient(getConfig());
      await client.updateIssue(issueKey, fields, update);
      return toolResult(`Updated issue ${issueKey}.`);
    })
);

server.registerTool(
  'jira_add_comment',
  {
    title: 'Add Comment',
    description: 'Adds a comment to a Jira issue. Accepts plain text or a raw Jira body payload.',
    inputSchema: z.object({
      issueKey: z.string().min(1),
      bodyText: z.string().min(1).optional(),
      body: z.unknown().optional()
    })
  },
  async ({ issueKey, bodyText, body }): Promise<CallToolResult> =>
    withToolError(async () => {
      if (!bodyText && body === undefined) {
        throw new Error('Provide bodyText or body.');
      }

      const client = new JiraClient(getConfig());
      const data = await client.addComment(issueKey, bodyText, body);
      return toolResult(`Added comment to ${issueKey}.`, data);
    })
);

server.registerTool(
  'jira_list_transitions',
  {
    title: 'List Transitions',
    description: 'Lists valid workflow transitions for a Jira issue.',
    inputSchema: z.object({
      issueKey: z.string().min(1)
    })
  },
  async ({ issueKey }): Promise<CallToolResult> =>
    withToolError(async () => {
      const client = new JiraClient(getConfig());
      const data = await client.listTransitions(issueKey);
      const transitions = Array.isArray(data.transitions) ? (data.transitions as JsonObject[]) : [];
      const text =
        transitions.length > 0
          ? transitions.map((transition) => `${String(transition.id)}: ${String(transition.name ?? 'Unnamed transition')}`).join('\n')
          : 'No transitions returned.';
      return toolResult(text, data);
    })
);

server.registerTool(
  'jira_transition_issue',
  {
    title: 'Transition Issue',
    description: 'Moves a Jira issue through a workflow transition.',
    inputSchema: z.object({
      issueKey: z.string().min(1),
      transitionId: z.string().min(1),
      fields: z.record(z.string(), z.unknown()).optional(),
      update: z.record(z.string(), z.unknown()).optional()
    })
  },
  async ({ issueKey, transitionId, fields, update }): Promise<CallToolResult> =>
    withToolError(async () => {
      const client = new JiraClient(getConfig());
      await client.transitionIssue(issueKey, transitionId, fields, update);
      return toolResult(`Transitioned ${issueKey} using transition ${transitionId}.`);
    })
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('jira-bridge MCP server running on stdio');
}

main().catch((error) => {
  console.error('Fatal error starting jira-bridge:', error);
  process.exit(1);
});
