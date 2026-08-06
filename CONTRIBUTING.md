# Contributing to net-monitor

Thanks for your interest! Here's how to get started.

## Development setup

**Requirements:** Node.js ≥ 18, npm

```bash
git clone https://github.com/YOUR_USERNAME/net-monitor.git
cd net-monitor
npm install
node server.js
```

Open https://localhost:9222 (self-signed cert — accept the browser warning).

## Project structure

```
net-monitor/
├── server.js          # Express server, all API routes, scheduler
├── public/
│   ├── index.html     # Single-page app shell
│   ├── app.js         # All frontend logic (~2100 lines, monolith — refactor planned)
│   └── style.css      # Styles + CSS variables for theming
├── data/              # Runtime data (gitignored): devices, history, settings
├── certs/             # TLS certificates (gitignored)
└── install.sh / .bat  # Dependency install scripts
```

## Pull requests

1. Fork the repo, create a feature branch: `git checkout -b feat/your-feature`
2. Keep commits small and focused
3. Test manually: add a device, check monitoring, verify alerts
4. Open a PR with a clear description of what changed and why

## Reporting bugs

Use [GitHub Issues](../../issues) with the **bug** label.
Include: OS, Node.js version, steps to reproduce, what you expected vs what happened.

## Feature requests

Open a [Discussion](../../discussions) or an Issue with the **enhancement** label.
Check the [Roadmap](../../projects) first — it may already be planned.

## Code style

- No formatter enforced yet — match the style of the surrounding code
- ES2020+, no TypeScript (for now)
- No external UI frameworks — vanilla JS + CSS variables

