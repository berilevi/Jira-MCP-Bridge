# Jira MCP Bridge

This project exposes Jira REST API operations as a local MCP server that Claude can use.

## When To Use This

Use this bridge when:

- you have a Jira API token or personal access token
- Jira does not expose an official MCP endpoint
- Claude can launch a local MCP server

The traffic flow is:

`Claude -> local MCP server -> Jira REST API`

## Jira Type: Cloud vs Data Center

The reliable check is Jira's server info endpoint, not just the hostname:

- `GET /rest/api/3/serverInfo`
- fallback: `GET /rest/api/2/serverInfo`

This bridge includes a `jira_detect_instance` tool that runs that check for you.

Practical hints:

- Jira Cloud often uses `*.atlassian.net`, but custom domains exist, so that is not definitive.
- Jira Cloud API token auth uses your Atlassian email plus token as Basic auth.
- Jira Data Center or Server personal access tokens typically use Bearer auth.

## Supported Auth Modes

If you are unsure, start with:

```bash
export JIRA_AUTH_MODE="auto"
```

The bridge will use:

- Cloud Basic auth when `JIRA_EMAIL` is set
- Bearer PAT auth when `JIRA_EMAIL` is not set

What the token itself usually tells you:

- If you created the token in your Atlassian account security settings and you also have an Atlassian account email, that is usually Jira Cloud.
- If you created a personal access token inside a self-hosted Jira instance, that is usually Jira Data Center or Server.

### Jira Cloud

Set:

```bash
export JIRA_BASE_URL="https://your-domain.atlassian.net"
export JIRA_AUTH_MODE="cloud_basic"
export JIRA_EMAIL="you@example.com"
export JIRA_TOKEN="your-api-token"
```

### Jira Data Center / Server

Set:

```bash
export JIRA_BASE_URL="https://jira.example.com"
export JIRA_AUTH_MODE="dc_pat"
export JIRA_TOKEN="your-personal-access-token"
unset JIRA_EMAIL
```

## Available Tools

- `jira_detect_instance`
- `jira_whoami`
- `jira_list_projects`
- `jira_search_issues`
- `jira_get_issue`
- `jira_create_issue`
- `jira_update_issue`
- `jira_add_comment`
- `jira_list_transitions`
- `jira_transition_issue`

## Setup

Install dependencies and build:

```bash
npm install
npm run build
```

Then either:

1. Add the server to Claude directly:

```bash
claude mcp add jira-bridge -e JIRA_BASE_URL="$JIRA_BASE_URL" -e JIRA_AUTH_MODE="$JIRA_AUTH_MODE" -e JIRA_EMAIL="$JIRA_EMAIL" -e JIRA_TOKEN="$JIRA_TOKEN" -- node /home/beri/projects/jira/dist/index.js
```

2. Or edit `.mcp.json` with your real values and let the client load the project MCP config.

## Notes

- Keep tokens in environment variables where possible.
- For Jira Cloud rich text comments, the bridge converts plain text into Atlassian Document Format automatically.
- Issue create and update tools accept raw Jira `fields` and `update` payloads, so you can use custom fields without changing the bridge.
