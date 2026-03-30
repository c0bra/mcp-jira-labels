#!/usr/bin/env node

import { Buffer } from "node:buffer";
import { pathToFileURL } from "node:url";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";

const issueKeySchema = z
  .string()
  .trim()
  .min(1)
  .describe("Jira issue key, for example PROJ-123");

const labelSchema = z
  .string()
  .trim()
  .min(1)
  .describe("Jira label to add or remove");

const labelInputSchema = z.object({
  issueKey: issueKeySchema,
  label: labelSchema,
});

const labelOutputSchema = z.object({
  issueKey: z.string(),
  label: z.string(),
  action: z.enum(["add", "remove"]),
  changed: z.boolean(),
  labels: z.array(z.string()),
  message: z.string(),
});

type LabelAction = z.infer<typeof labelOutputSchema>["action"];
type LabelResult = z.infer<typeof labelOutputSchema>;

type JiraConfig = {
  apiVersion: string;
  baseUrl: string;
  token: string;
  user: string;
};

type JiraIssueResponse = {
  fields?: {
    labels?: string[];
  };
};

class JiraRequestError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly details?: string,
  ) {
    super(message);
    this.name = "JiraRequestError";
  }
}

function getEnvValue(...names: string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) {
      return value;
    }
  }

  return undefined;
}

function getJiraConfig(): JiraConfig {
  const baseUrl = getEnvValue("JIRA_BASE_URL");
  const user = getEnvValue("JIRA_USER", "JIRA_EMAIL", "JIRA_USERNAME");
  const token = getEnvValue("JIRA_TOKEN", "JIRA_API_TOKEN", "JIRA_PAT");
  const apiVersion = getEnvValue("JIRA_API_VERSION") ?? "3";

  if (!baseUrl) {
    throw new Error("Missing JIRA_BASE_URL.");
  }

  if (!user) {
    throw new Error(
      "Missing Jira user. Set JIRA_USER, JIRA_EMAIL, or JIRA_USERNAME.",
    );
  }

  if (!token) {
    throw new Error(
      "Missing Jira token. Set JIRA_TOKEN, JIRA_API_TOKEN, or JIRA_PAT.",
    );
  }

  return {
    apiVersion,
    baseUrl: baseUrl.replace(/\/+$/, ""),
    token,
    user,
  };
}

function buildIssueUrl(config: JiraConfig, issueKey: string): URL {
  return new URL(
    `/rest/api/${config.apiVersion}/issue/${encodeURIComponent(issueKey)}`,
    config.baseUrl,
  );
}

function getAuthHeader(config: JiraConfig): string {
  return `Basic ${Buffer.from(`${config.user}:${config.token}`).toString("base64")}`;
}

async function jiraRequest<T>(
  config: JiraConfig,
  url: URL,
  init?: RequestInit,
): Promise<T | undefined> {
  const response = await fetch(url, {
    ...init,
    headers: {
      Accept: "application/json",
      Authorization: getAuthHeader(config),
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...(init?.headers ?? {}),
    },
  });

  if (response.ok) {
    if (response.status === 204) {
      return undefined;
    }

    return (await response.json()) as T;
  }

  const responseText = await response.text();
  let details = responseText.trim();

  try {
    const parsed = JSON.parse(responseText) as {
      errorMessages?: string[];
      errors?: Record<string, string>;
      message?: string;
    };

    const messages = [
      ...(parsed.errorMessages ?? []),
      ...Object.values(parsed.errors ?? {}),
      ...(parsed.message ? [parsed.message] : []),
    ].filter(Boolean);

    if (messages.length > 0) {
      details = messages.join("; ");
    }
  } catch {
    details = responseText.trim();
  }

  throw new JiraRequestError(
    `Jira request failed with status ${response.status}.`,
    response.status,
    details || undefined,
  );
}

async function getIssueLabels(
  config: JiraConfig,
  issueKey: string,
): Promise<string[]> {
  const url = buildIssueUrl(config, issueKey);
  url.searchParams.set("fields", "labels");

  const issue = await jiraRequest<JiraIssueResponse>(config, url, {
    method: "GET",
  });

  return issue?.fields?.labels ?? [];
}

async function applyLabelUpdate(
  config: JiraConfig,
  issueKey: string,
  label: string,
  action: LabelAction,
): Promise<void> {
  const url = buildIssueUrl(config, issueKey);

  await jiraRequest(config, url, {
    method: "PUT",
    body: JSON.stringify({
      update: {
        labels: [{ [action]: label }],
      },
    }),
  });
}

async function editLabel(
  action: LabelAction,
  issueKey: string,
  rawLabel: string,
): Promise<LabelResult> {
  const config = getJiraConfig();
  const label = rawLabel.trim();

  const existingLabels = await getIssueLabels(config, issueKey);
  const alreadyPresent = existingLabels.includes(label);
  const shouldChange = action === "add" ? !alreadyPresent : alreadyPresent;

  if (!shouldChange) {
    return {
      action,
      changed: false,
      issueKey,
      label,
      labels: existingLabels,
      message:
        action === "add"
          ? `Label \"${label}\" is already on ${issueKey}.`
          : `Label \"${label}\" is not on ${issueKey}.`,
    };
  }

  await applyLabelUpdate(config, issueKey, label, action);

  const updatedLabels = await getIssueLabels(config, issueKey);

  return {
    action,
    changed: true,
    issueKey,
    label,
    labels: updatedLabels,
    message:
      action === "add"
        ? `Added label \"${label}\" to ${issueKey}.`
        : `Removed label \"${label}\" from ${issueKey}.`,
  };
}

function formatToolText(result: LabelResult): string {
  const labelsText =
    result.labels.length > 0 ? result.labels.join(", ") : "(none)";

  return `${result.message}\nCurrent labels: ${labelsText}`;
}

export function createServer(): McpServer {
  const server = new McpServer({
    name: "jira-labels-mcp",
    version: "0.1.0",
  });

  server.registerTool(
    "jira_add_label",
    {
      title: "Add Jira label",
      description: "Add a single label to a Jira issue without replacing the full label list.",
      inputSchema: labelInputSchema,
      outputSchema: labelOutputSchema,
    },
    async ({ issueKey, label }) => {
      const result = await editLabel("add", issueKey, label);

      return {
        content: [{ type: "text", text: formatToolText(result) }],
        structuredContent: result,
      };
    },
  );

  server.registerTool(
    "jira_remove_label",
    {
      title: "Remove Jira label",
      description: "Remove a single label from a Jira issue without replacing the full label list.",
      inputSchema: labelInputSchema,
      outputSchema: labelOutputSchema,
    },
    async ({ issueKey, label }) => {
      const result = await editLabel("remove", issueKey, label);

      return {
        content: [{ type: "text", text: formatToolText(result) }],
        structuredContent: result,
      };
    },
  );

  return server;
}

export async function runServer(): Promise<void> {
  getJiraConfig();

  const server = createServer();
  const transport = new StdioServerTransport();

  await server.connect(transport);
  console.error("jira-labels-mcp running on stdio");
}

const isDirectExecution =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectExecution) {
  runServer().catch((error: unknown) => {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    console.error(message);
    process.exit(1);
  });
}
