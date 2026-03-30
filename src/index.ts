#!/usr/bin/env node

import { Buffer } from "node:buffer";
import { realpathSync } from "node:fs";
import { extname } from "node:path";
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

const attachmentFailureSchema = z.object({
  filename: z.string(),
  error: z.string(),
});

const attachmentMetadataSchema = z.object({
  id: z.string(),
  filename: z.string(),
  mimeType: z.string(),
  size: z.number().int().nonnegative(),
});

const attachmentInputSchema = z.object({
  issueKey: issueKeySchema,
});

const downloadAttachmentsOutputSchema = z.object({
  issueKey: z.string(),
  total: z.number().int().nonnegative(),
  downloaded: z.number().int().nonnegative(),
  attachments: z.array(attachmentMetadataSchema),
  failed: z.array(attachmentFailureSchema),
  message: z.string().optional(),
});

const issueImagesOutputSchema = z.object({
  issueKey: z.string(),
  totalImages: z.number().int().nonnegative(),
  downloaded: z.number().int().nonnegative(),
  images: z.array(attachmentMetadataSchema),
  failed: z.array(attachmentFailureSchema),
  message: z.string().optional(),
});

type LabelAction = z.infer<typeof labelOutputSchema>["action"];
type LabelResult = z.infer<typeof labelOutputSchema>;
type AttachmentFailure = z.infer<typeof attachmentFailureSchema>;
type AttachmentMetadata = z.infer<typeof attachmentMetadataSchema>;
type DownloadAttachmentsResult = z.infer<typeof downloadAttachmentsOutputSchema>;
type IssueImagesResult = z.infer<typeof issueImagesOutputSchema>;

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

type JiraAttachmentResponse = {
  content?: string;
  filename?: string;
  id?: string;
  mimeType?: string;
  size?: number;
};

type JiraIssueAttachmentsResponse = {
  fields?: {
    attachment?: JiraAttachmentResponse[];
  };
};

type JiraAttachment = {
  contentUrl?: string;
  filename: string;
  id: string;
  mimeType?: string;
  size: number;
};

type AttachmentBinary = {
  data: Buffer;
  mimeType: string;
};

const ATTACHMENT_MAX_BYTES = 50 * 1024 * 1024;

const IMAGE_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/svg+xml",
  "image/bmp",
]);

const AMBIGUOUS_MIME_TYPES = new Set([
  "application/octet-stream",
  "application/binary",
]);

const IMAGE_EXTENSION_TO_MIME_TYPE = new Map([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
  [".svg", "image/svg+xml"],
  [".bmp", "image/bmp"],
]);

const ATTACHMENT_EXTENSION_TO_MIME_TYPE = new Map([
  ...IMAGE_EXTENSION_TO_MIME_TYPE.entries(),
  [".pdf", "application/pdf"],
  [".txt", "text/plain"],
  [".json", "application/json"],
  [".csv", "text/csv"],
  [".log", "text/plain"],
  [".zip", "application/zip"],
]);

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

  throw new JiraRequestError(
    `Jira request failed with status ${response.status}.`,
    response.status,
    await getResponseDetails(response),
  );
}

async function getResponseDetails(response: Response): Promise<string | undefined> {
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

  return details || undefined;
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

function normalizeAttachment(issueKey: string, attachment: JiraAttachmentResponse): JiraAttachment {
  if (!attachment.id) {
    throw new JiraRequestError(`Attachment on ${issueKey} is missing an id.`);
  }

  if (!attachment.filename) {
    throw new JiraRequestError(
      `Attachment ${attachment.id} on ${issueKey} is missing a filename.`,
    );
  }

  return {
    contentUrl: attachment.content,
    filename: attachment.filename,
    id: attachment.id,
    mimeType: attachment.mimeType,
    size: attachment.size ?? 0,
  };
}

function getMimeTypeFromFilename(filename: string): string | undefined {
  return ATTACHMENT_EXTENSION_TO_MIME_TYPE.get(extname(filename).toLowerCase());
}

function normalizeMimeType(mimeType: string | undefined): string | undefined {
  return mimeType?.split(";", 1)[0]?.trim().toLowerCase() || undefined;
}

function shouldSendAuthHeader(config: JiraConfig, contentUrl: string): boolean {
  try {
    return new URL(contentUrl).origin === new URL(config.baseUrl).origin;
  } catch {
    return false;
  }
}

function resolveAttachmentMimeType(
  mimeType: string | undefined,
  filename: string,
): string {
  return normalizeMimeType(mimeType) || getMimeTypeFromFilename(filename) || "application/octet-stream";
}

function resolveImageMimeType(
  mimeType: string | undefined,
  filename: string,
): string | undefined {
  const normalizedMimeType = normalizeMimeType(mimeType);
  if (normalizedMimeType && IMAGE_MIME_TYPES.has(normalizedMimeType)) {
    return normalizedMimeType;
  }

  if (
    !normalizedMimeType ||
    AMBIGUOUS_MIME_TYPES.has(normalizedMimeType)
  ) {
    const extensionMimeType = IMAGE_EXTENSION_TO_MIME_TYPE.get(
      extname(filename).toLowerCase(),
    );
    if (extensionMimeType) {
      return extensionMimeType;
    }
  }

  return undefined;
}

async function getIssueAttachments(
  config: JiraConfig,
  issueKey: string,
): Promise<JiraAttachment[]> {
  const url = buildIssueUrl(config, issueKey);
  url.searchParams.set("fields", "attachment");

  const issue = await jiraRequest<JiraIssueAttachmentsResponse>(config, url, {
    method: "GET",
  });

  return (issue?.fields?.attachment ?? []).map((attachment) =>
    normalizeAttachment(issueKey, attachment),
  );
}

async function fetchAttachmentBinary(
  config: JiraConfig,
  issueKey: string,
  attachment: JiraAttachment,
): Promise<AttachmentBinary> {
  if (!attachment.contentUrl) {
    throw new JiraRequestError(
      `Attachment ${attachment.filename} on ${issueKey} has no content URL.`,
    );
  }

  const headers: HeadersInit = {
    Accept: "*/*",
  };
  if (shouldSendAuthHeader(config, attachment.contentUrl)) {
    headers.Authorization = getAuthHeader(config);
  }

  const response = await fetch(attachment.contentUrl, {
    headers,
  });

  if (!response.ok) {
    throw new JiraRequestError(
      `Attachment download failed with status ${response.status}.`,
      response.status,
      await getResponseDetails(response),
    );
  }

  const arrayBuffer = await response.arrayBuffer();
  if (arrayBuffer.byteLength > ATTACHMENT_MAX_BYTES) {
    throw new JiraRequestError(
      `Attachment ${attachment.filename} is ${arrayBuffer.byteLength} bytes, which exceeds the 50 MB inline limit.`,
    );
  }

  return {
    data: Buffer.from(arrayBuffer),
    mimeType: resolveAttachmentMimeType(
      response.headers.get("content-type") ?? attachment.mimeType,
      attachment.filename,
    ),
  };
}

function formatDownloadAttachmentsText(result: DownloadAttachmentsResult): string {
  const message = result.message ?? `Fetched ${result.downloaded} of ${result.total} attachments.`;
  const attachmentNames =
    result.attachments.length > 0
      ? result.attachments.map((attachment) => attachment.filename).join(", ")
      : "(none)";
  const failedText =
    result.failed.length > 0
      ? result.failed.map((failure) => `${failure.filename}: ${failure.error}`).join("; ")
      : "(none)";

  return `${message}\nAttachments: ${attachmentNames}\nFailed: ${failedText}`;
}

function formatIssueImagesText(result: IssueImagesResult): string {
  const message = result.message ?? `Fetched ${result.downloaded} of ${result.totalImages} image attachments.`;
  const imageNames =
    result.images.length > 0
      ? result.images.map((image) => image.filename).join(", ")
      : "(none)";
  const failedText =
    result.failed.length > 0
      ? result.failed.map((failure) => `${failure.filename}: ${failure.error}`).join("; ")
      : "(none)";

  return `${message}\nImages: ${imageNames}\nFailed: ${failedText}`;
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

  server.registerTool(
    "jira_download_attachments",
    {
      title: "Download Jira attachments",
      description:
        "Fetch all Jira issue attachments and return them as embedded MCP resources for agent inspection.",
      inputSchema: attachmentInputSchema,
      outputSchema: downloadAttachmentsOutputSchema,
    },
    async ({ issueKey }) => {
      const config = getJiraConfig();
      const attachments = await getIssueAttachments(config, issueKey);
      const downloadedAttachments: AttachmentMetadata[] = [];
      const failed: AttachmentFailure[] = [];
      const content: Array<
        | { type: "text"; text: string }
        | {
            type: "resource";
            resource: {
              uri: string;
              mimeType: string;
              blob: string;
            };
          }
      > = [];

      for (const attachment of attachments) {
        if (attachment.size > ATTACHMENT_MAX_BYTES) {
          failed.push({
            filename: attachment.filename,
            error:
              `Attachment is ${attachment.size} bytes, which exceeds the 50 MB inline limit.`,
          });
          continue;
        }

        try {
          const binary = await fetchAttachmentBinary(config, issueKey, attachment);
          downloadedAttachments.push({
            id: attachment.id,
            filename: attachment.filename,
            mimeType: binary.mimeType,
            size: binary.data.length,
          });
          content.push({
            type: "resource",
            resource: {
              uri: `attachment:///${issueKey}/${attachment.id}/${encodeURIComponent(attachment.filename)}`,
              mimeType: binary.mimeType,
              blob: binary.data.toString("base64"),
            },
          });
        } catch (error: unknown) {
          failed.push({
            filename: attachment.filename,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      const result: DownloadAttachmentsResult = {
        issueKey,
        total: attachments.length,
        downloaded: downloadedAttachments.length,
        attachments: downloadedAttachments,
        failed,
        ...(attachments.length === 0
          ? { message: `No attachments found for ${issueKey}.` }
          : {}),
      };

      return {
        content: [{ type: "text", text: formatDownloadAttachmentsText(result) }, ...content],
        structuredContent: result,
      };
    },
  );

  server.registerTool(
    "jira_get_issue_images",
    {
      title: "Get Jira issue images",
      description:
        "Fetch image attachments from a Jira issue and return them as inline image content for vision-capable agents.",
      inputSchema: attachmentInputSchema,
      outputSchema: issueImagesOutputSchema,
    },
    async ({ issueKey }) => {
      const config = getJiraConfig();
      const attachments = await getIssueAttachments(config, issueKey);
      const imageAttachments = attachments
        .map((attachment) => ({
          attachment,
          resolvedMimeType: resolveImageMimeType(
            attachment.mimeType,
            attachment.filename,
          ),
        }))
        .filter(
          (
            candidate,
          ): candidate is {
            attachment: JiraAttachment;
            resolvedMimeType: string;
          } => Boolean(candidate.resolvedMimeType),
        );
      const downloadedImages: AttachmentMetadata[] = [];
      const failed: AttachmentFailure[] = [];
      const imageContent: Array<{
        type: "image";
        data: string;
        mimeType: string;
      }> = [];

      for (const { attachment, resolvedMimeType } of imageAttachments) {
        if (attachment.size > ATTACHMENT_MAX_BYTES) {
          failed.push({
            filename: attachment.filename,
            error:
              `Image is ${attachment.size} bytes, which exceeds the 50 MB inline limit.`,
          });
          continue;
        }

        try {
          const binary = await fetchAttachmentBinary(config, issueKey, attachment);
          const fetchedImageMimeType = resolveImageMimeType(
            binary.mimeType,
            attachment.filename,
          );
          if (!fetchedImageMimeType) {
            failed.push({
              filename: attachment.filename,
              error: `Downloaded content was not recognized as an image (reported MIME type: ${binary.mimeType}).`,
            });
            continue;
          }

          downloadedImages.push({
            id: attachment.id,
            filename: attachment.filename,
            mimeType: fetchedImageMimeType,
            size: binary.data.length,
          });
          imageContent.push({
            type: "image",
            data: binary.data.toString("base64"),
            mimeType: fetchedImageMimeType,
          });
        } catch (error: unknown) {
          failed.push({
            filename: attachment.filename,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      const result: IssueImagesResult = {
        issueKey,
        totalImages: imageAttachments.length,
        downloaded: downloadedImages.length,
        images: downloadedImages,
        failed,
        ...(imageAttachments.length === 0
          ? { message: `No image attachments found for ${issueKey}.` }
          : {}),
      };

      return {
        content: [{ type: "text", text: formatIssueImagesText(result) }, ...imageContent],
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

function isDirectExecution(): boolean {
  const entryPath = process.argv[1];

  if (!entryPath) {
    return false;
  }

  try {
    return import.meta.url === pathToFileURL(realpathSync(entryPath)).href;
  } catch {
    return import.meta.url === pathToFileURL(entryPath).href;
  }
}

if (isDirectExecution()) {
  runServer().catch((error: unknown) => {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    console.error(message);
    process.exit(1);
  });
}
