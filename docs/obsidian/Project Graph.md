---
tags:
  - project/overseerr-dm-bot
  - graph
reviewed: 2026-08-16
source_commit: 1a803ac
---

# Project graph

This note joins the architectural map in [[Architecture]], the behavior in [[Core Workflows]], the
durable state in [[Data and Operations]], and the dated delivery plan in [[Backlog]].

## Runtime topology

```mermaid
flowchart LR
    Members[Discord members] --> Discord[Discord commands and interactions]
    Admins[Administrators] --> Discord
    Admins --> Dashboard[Admin dashboard]

    Seerr[Seerr] --> Webhooks[Express webhook routes]
    Plex[Plex] --> Webhooks
    Tautulli[Tautulli] --> Webhooks
    Browser[Browser or tunnel] --> Dashboard
    EdgeAgents[Regional edge agents] <--> AgentAPI[Agent API]

    subgraph Bot[Node.js bot process]
        Bootstrap[bootstrap.js validation] --> Index[index.js composition]
        Discord --> Index
        Webhooks --> Routes[src/routes handlers]
        Routes --> Index
        Dashboard --> Index
        AgentAPI --> Index
        Sweeps[Scheduled sweeps] --> Index
        Index --> Services[src service modules]
        Services --> SQLite[(SQLite)]
    end

    Services <--> Seerr
    Services <--> Plex
    Services <--> Tautulli
    Services <--> Arrs[Sonarr and Radarr]
    Services <--> Prowlarr[Prowlarr]
    Services <--> Premiumize[Premiumize]
    Services <--> RTorrent[rTorrent seedbox]
    Services <--> Storage[Media and staging storage]
    EdgeAgents <--> Syncthing[Syncthing and local media]
```

## Current delivery graph

Solid arrows are explicit dependencies; grouped issues can otherwise proceed independently.

```mermaid
flowchart TD
    Review[#175 Repository review] --> Security[#176 HTTP admission]
    Review --> Sessions[#177 Session signing]
    Review --> AppFactory[#178 HTTP extraction]
    Review --> Migrations[#179 Versioned migrations]
    Review --> Runtime[#180 Runtime and agent CI]
    AppFactory --> DashboardCache[#189 Dashboard caching]

    Review --> Registry[#186 Automation registry]
    Registry --> DashboardOps[#187 Dashboard correctness]
    Registry --> HttpLifecycle[#188 HTTP during Discord outage]

    Review --> Origin[#190 Dashboard origin]
    Review --> HTTPS[#191 Public HTTPS]
    HTTPS --> Origin

    Review --> Fallback[#181 Fallback verification]
    Fallback --> California[#182 California promotion]
    Review --> TVGranularity[#183 Season-level TV planning]
    TVGranularity -.->|before unrestricted TV promotion| California

    Review --> Delivery[#184 Supply-chain and releases]
    Review --> Docs[#185 Docs and repository policy]
```

## Request and recovery pipeline

```mermaid
flowchart LR
    Request[Member request] --> Gate{Admin or trusted?}
    Gate -->|No| Pending[SQLite pending gate]
    Pending --> Approval[Discord or dashboard approval]
    Gate -->|Yes| SeerrRequest[Create attributed Seerr request]
    Approval --> SeerrRequest
    SeerrRequest --> Public[Public indexers through arr]
    Public -->|Found| Download[Download and import]
    Public -->|Nothing found| Escalation[Escalation watch]
    Escalation -->|Eligible or approved| AvistaZ[AvistaZ search]
    AvistaZ --> Seedbox[rTorrent seedbox]
    Seedbox --> Stage[rclone staging]
    Stage --> Import[Sonarr or Radarr import]
    Download --> Available[Plex availability]
    Import --> Available
    Available --> Notify[Requester and subscriber notices]
```

See [[Core Workflows]] for the conditions and safety gates behind these edges.
