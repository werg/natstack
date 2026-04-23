# Non-Interactive Deployments

How to run natstack without a human present to answer consent prompts — CI pipelines, scheduled jobs, server-side deployments, and containers.

## Overview

When natstack starts with `--non-interactive` (or `credentials.nonInteractive: true` in `natstack.yml`), any call to `requestConsent` or `beginConsent` throws `NonInteractiveConsentRequired` if no valid credential is already stored for the requested provider and scopes.

Non-interactive flows are preferred in this mode:
- **Service accounts** (`service-account` flow)
- **Bot tokens** (`bot-token` flow)
- **GitHub App installations** (`github-app-installation` flow)
- **CLI piggyback** (`cli-piggyback` flow)

## Configuration

### natstack.yml

```yaml
credentials:
  nonInteractive: true
  providers:
    google:
      clientId: "your-service-account-client-id"
```

### Environment Variables

| Variable | Description |
|----------|-------------|
| `NATSTACK_SERVICE_ACCOUNT_PATH` | Path to a service account JSON file (default: `~/.natstack/service-account.json`) |
| `GITHUB_APP_ID` | GitHub App ID for installation token flow |
| `GITHUB_APP_PRIVATE_KEY` | PEM private key content or path to `.pem` file |
| `GITHUB_APP_INSTALLATION_ID` | GitHub App installation ID |
| `COMPOSIO_API_KEY` | Composio API key for the bridge flow |

## Bootstrapping Credentials

### Google Service Account

1. Create a service account in the Google Cloud Console
2. Download the JSON key file
3. Set `NATSTACK_SERVICE_ACCOUNT_PATH=/path/to/service-account.json`

```bash
export NATSTACK_SERVICE_ACCOUNT_PATH=/etc/natstack/google-sa.json
natstack start --non-interactive
```

### GitHub App

1. Create a GitHub App with the required permissions
2. Install the app on your organization/repos
3. Set the environment variables:

```bash
export GITHUB_APP_ID=12345
export GITHUB_APP_PRIVATE_KEY=/etc/natstack/github-app.pem
export GITHUB_APP_INSTALLATION_ID=67890
natstack start --non-interactive
```

### Bot Tokens (Slack, Discord, Telegram)

Pre-seed a bot token in the credential store:

```bash
mkdir -p ~/.natstack/credentials/slack/bot
cat > ~/.natstack/credentials/slack/bot.json << 'EOF'
{
  "providerId": "slack",
  "connectionId": "bot",
  "connectionLabel": "CI Bot",
  "accountIdentity": { "providerUserId": "bot" },
  "accessToken": "xoxb-your-bot-token",
  "scopes": ["chat:write", "channels:read"]
}
EOF
chmod 600 ~/.natstack/credentials/slack/bot.json
```

### CLI Piggyback

If the CI environment has `gh`, `gcloud`, or `az` authenticated:

```bash
# GitHub via gh CLI
gh auth login --with-token < /etc/natstack/github-token

# Google via gcloud
gcloud auth activate-service-account --key-file=/etc/natstack/google-sa.json

# Then natstack picks up the tokens via cli-piggyback flow
natstack start --non-interactive
```

## Docker / Containers

```dockerfile
FROM node:22-slim
COPY service-account.json /etc/natstack/
ENV NATSTACK_SERVICE_ACCOUNT_PATH=/etc/natstack/service-account.json
```

```yaml
# docker-compose.yml
services:
  natstack:
    environment:
      - NATSTACK_SERVICE_ACCOUNT_PATH=/etc/natstack/service-account.json
      - GITHUB_APP_ID=12345
      - GITHUB_APP_PRIVATE_KEY_FILE=/etc/natstack/github-app.pem
      - GITHUB_APP_INSTALLATION_ID=67890
    volumes:
      - ./secrets:/etc/natstack:ro
    command: ["natstack", "start", "--non-interactive"]
```

## Error Handling

When a credential is needed but unavailable in non-interactive mode:

```
Error: NonInteractiveConsentRequired
  Provider: google
  Scopes: gmail_readonly, gmail_send
  
  No valid credential found. In non-interactive mode, credentials must be
  pre-seeded via service accounts, bot tokens, or CLI piggyback.
  
  See: docs/non-interactive-deployments.md
```

## Security Notes

- Service account keys and bot tokens are long-lived secrets. Rotate them regularly.
- Use `chmod 600` on credential files. The credential store enforces 0o600 permissions.
- In CI, prefer short-lived tokens (GitHub App installation tokens expire in 1 hour) over PATs.
- Never commit credentials to the repository. Use environment variables or mounted secrets.
