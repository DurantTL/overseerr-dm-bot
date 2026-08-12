---
tags:
  - project/overseerr-dm-bot
  - graph
reviewed: 2026-08-11
source_commit: b656155
---

# Project graph

This note joins the architectural map in [[Architecture]], the behavior in [[Core Workflows]], the durable state in [[Data and Operations]], and the delivery plan in [[Backlog]].

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
        Discord --> Index[index.js orchestration]
        Webhooks --> Index
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

## Delivery graph

Solid arrows are explicit dependencies. Dashed arrows are the sequence recommended by the live tracking issue rather than hard technical blockers.

```mermaid
flowchart TD
    I122[#122 Placeholder config] -.-> I125[#125 Diagnosable fatal config]
    I125 -.-> I116[#116 Dashboard search]
    I116 -.-> I117[#117 Dashboard actions]
    I117 -.-> I127[#127 Pending approval expiry]
    I127 -.-> I133[#133 Extract route handlers]

    I118[#118 Headless approval gate] -->|blocks| I119[#119 Dashboard approve or deny]
    I116 -.->|coordinates with| I123[#123 Who requested]
    I117 -.->|pairs with| I134[#134 Sweep preview]
    I119 -.->|shares pending list| I127

    Reliability[Silent failure] --> I122
    Reliability --> I125
    Reliability --> I129[#129 Persistent limits]
    Reliability --> I131[#131 Verified backups]

    DashboardParity[Dashboard parity] --> I116
    DashboardParity --> I117
    DashboardParity --> I120[#120 Tier setup]
    DashboardParity --> I118
    DashboardParity --> I119
    DashboardParity --> I121[#121 Passkeys]
    DashboardParity --> I134

    MemberExperience[Member experience] --> I123
    MemberExperience --> I126[#126 Cross-source dedupe]
    MemberExperience --> I127
    MemberExperience --> I128[#128 Failure and stall notices]

    Foundations[Foundations] --> I130[#130 File-backed secrets]
    Foundations --> I133
    StoragePlanning[Storage planning] --> I132[#132 Capacity forecast]
```

## Request and recovery pipeline

```mermaid
flowchart LR
    Request[Member request] --> Gate{Admin or trusted?}
    Gate -->|No| Pending[SQLite pending gate]
    Pending --> Approval[Discord approval]
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
    Available --> Notify[Requester DM and subscribers]
```

See [[Core Workflows]] for the conditions and safety gates behind these edges.
