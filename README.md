# mcp-jira-labels

Tiny MCP server for a few focused Jira operations:

- add a label to an issue
- remove a label from an issue
- fetch attachments from an issue as embedded resources
- fetch image attachments from an issue as inline images

It uses Jira token-style credentials over the REST API with Basic auth. No OAuth.

## What it supports

- **Jira Cloud**: email + API token
- **Basic-auth-compatible Jira setups**: username/email + token

If your Jira Server or Data Center instance expects bearer-token auth for PATs instead of Basic auth, this server does not implement that mode.

## Environment variables

Required:

```bash
JIRA_BASE_URL=https://your-company.atlassian.net
JIRA_USER=you@example.com
JIRA_TOKEN=your-token-here
```

Optional:

```bash
# Defaults to 3. For some Jira Server/DC installs, set this to 2.
JIRA_API_VERSION=3
```

Compatibility aliases are also supported:

- `JIRA_EMAIL` or `JIRA_USERNAME` instead of `JIRA_USER`
- `JIRA_API_TOKEN` or `JIRA_PAT` instead of `JIRA_TOKEN`

## Install

```bash
npm install
npm run build
```

## MCP tools

- `jira_add_label`
- `jira_remove_label`
- `jira_download_attachments`
- `jira_get_issue_images`

Label tools take:

- `issueKey` — like `PROJ-123`
- `label` — the label to add or remove

The server returns whether anything changed and the current label list after the operation.

Attachment tools take:

- `issueKey` — like `PROJ-123`

`jira_download_attachments` returns a text summary plus one embedded MCP resource per attachment, with the file contents base64-encoded for client-side inspection.

`jira_get_issue_images` returns a text summary plus one inline MCP image block per image attachment so vision-capable agents can inspect screenshots and other image files directly.

Notes for attachments:

- files over 50 MB are skipped instead of being inlined, based on both Jira metadata and the actual downloaded payload size
- image detection falls back to the filename extension when Jira reports an ambiguous MIME type
- non-image attachments are excluded from `jira_get_issue_images`
- Basic auth is only attached when the attachment download URL is on the same origin as `JIRA_BASE_URL`

## Claude Desktop example

Add this to your MCP config:

```json
{
  "mcpServers": {
    "jira-labels": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-jira-labels/dist/index.js"],
      "env": {
        "JIRA_BASE_URL": "https://your-company.atlassian.net",
        "JIRA_USER": "you@example.com",
        "JIRA_TOKEN": "your-api-token",
        "JIRA_API_VERSION": "3"
      }
    }
  }
}
```

For Jira Server / Data Center, use your server URL, credentials that your instance accepts via Basic auth, and usually `JIRA_API_VERSION=2`.

## Notes

- The server uses the Jira issue update API with label `add` / `remove` operations, so it does **not** replace the full label set.
- If the requested label state already matches reality, the tool returns a no-op result instead of forcing an update.
