# Jira MCP Bridge

This project exposes Jira REST API operations as a local MCP server that any AI agent can use.

## When To Use This

Use this bridge when:

- you have a Jira API token or personal access token
- Jira does not expose an official MCP endpoint
- Claude/VS Code can launch a local MCP server

The traffic flow is:

`Claude/VS Code -> local MCP server -> Jira REST API`

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
export JIRA_BASE_URL="https://your-jira-instance"
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

## VS Code + GitHub Copilot (Remote SSH)

Use this setup when VS Code runs on a different machine and connects to the Linux host via Remote SSH.

### Prerequisites

- VS Code 1.99+ with **GitHub Copilot** and **GitHub Copilot Chat** extensions
- `chat.mcp.enabled` set to `true` in VS Code settings
- Remote SSH connected to the Linux host

### 1. Clone and build on the remote host

SSH into the host and run:

```bash
mkdir -p ~/projects && cd ~/projects
git clone https://github.com/berilevi/Jira-MCP-Bridge.git
cd Jira-MCP-Bridge
npm install
npm run build
```

### 2. Set credentials on the remote host

Add to `~/.bashrc` on the remote machine:

```bash
export JIRA_BASE_URL="https://your-jira-instance"
export JIRA_AUTH_MODE="dc_pat"          # or cloud_basic
export JIRA_TOKEN="your-token"
# export JIRA_EMAIL="you@example.com"   # only for cloud_basic
```

Then reload: `source ~/.bashrc`

### 3. Configure MCP in VS Code

With Remote SSH connected, run `Ctrl+Shift+P` → `MCP: Add Server` and fill in:

- **Type:** stdio
- **Command:** `node`
- **Args:** `/home/<user>/projects/Jira-MCP-Bridge/dist/index.js`
- **Name:** `jira-bridge`
- **Save to:** Remote Settings

This creates `/home/<user>/.vscode-server/data/User/mcp.json`:

```json
{
  "servers": {
    "jira-bridge": {
      "type": "stdio",
      "command": "node",
      "args": ["/home/<user>/projects/Jira-MCP-Bridge/dist/index.js"]
    }
  }
}
```

### 4. Verify and use

- `Ctrl+Shift+P` → `MCP: List Servers` — confirm `jira-bridge` shows as running
- Open Copilot Chat (`Ctrl+Alt+I`) → switch to **Agent** mode
- Click the 🔧 tools icon in the input bar — `jira-bridge` tools will be listed
- Ask naturally: *"show my open Jira tickets"* or *"what's the status of PROJ-123?"*

> VS Code spawns the MCP server as a subprocess on the remote host, so it inherits the shell environment and picks up credentials automatically — no tokens needed in the config file.

## Notes

- Keep tokens in environment variables where possible.
- For Jira Cloud rich text comments, the bridge converts plain text into Atlassian Document Format automatically.
- Issue create and update tools accept raw Jira `fields` and `update` payloads, so you can use custom fields without changing the bridge.
