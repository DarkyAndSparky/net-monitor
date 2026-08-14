# Changelog

All notable changes to this project will be documented in this file.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.0.0/)
Versioning: [Semantic Versioning](https://semver.org/)

---

## [Unreleased]

### Planned
- SQLite migration (replacing JSON file storage)
- Server-Sent Events for real-time UI updates
- Remote agent for host metrics (CPU / RAM / disk)
- Traffic monitoring via SNMP ifOctets / MikroTik API
- Prometheus `/metrics` exporter endpoint
- Docker / docker-compose support
- Email (SMTP) alert channel
- Maintenance windows / silence rules

---

## [0.9.0-beta] — 2026-08-06

### Added
- Device registry with pagination, filters, bulk operations, CSV export
- Interactive network map (SVG, drag & drop, tree layout, subnets)
- Ping monitoring with 7-day sparkline history
- Alerts: Telegram bot + Webhook, escalation, incidents log
- Integrations: MikroTik RouterOS API, UniFi Controller, Cisco SSH
- Network discovery: ping sweep, ARP, MNDP, auto-topology
- SNMP monitoring and TCP port checks (optional feature flags)
- Role-based access: admin / viewer + audit log
- HTTPS with self-signed cert generator, brute-force protection
- Backup / restore (JSON), CSV export
- Dark / light theme toggle
- Branding customization (logo, title, accent color)

