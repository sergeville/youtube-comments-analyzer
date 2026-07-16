Below is a practical plan you can give to Codex, Claude Code, or another developer to build the page.

Neo4j’s official JavaScript driver can connect a Node.js application to Neo4j, while `react-force-graph-3d` provides a React-based force-directed 3D renderer with node/link selection, dragging, zooming, and camera controls. It renders through Three.js and WebGL. ([Graph Database & Analytics][1])

# Neo4j 3D Graph Explorer Implementation Plan

## 1. Objective

Create an interactive web page that displays Neo4j nodes and relationships in a navigable 3D environment.

The user must be able to:

* View nodes as 3D objects.
* View Neo4j relationships as connecting lines.
* Rotate, zoom, pan, and fly through the graph.
* Search for nodes.
* Filter nodes by label and relationships by type.
* Select a node and inspect its properties.
* Expand a selected node to reveal its neighbors.
* Trace relationships between selected nodes.
* hide unrelated nodes.
* Return to the complete graph view.
* Open related project, sprint, task, document, or code records.
* Refresh the visualization when Neo4j data changes.

The page should support Synapse and Archon concepts such as:

* Organization
* Project
* Goal
* Plan
* Sprint
* Epic
* Story
* Task
* Agent
* Document
* Repository
* File
* Class
* Function
* Decision
* Dependency

---

# 2. Important Design Decision

Do not automatically send every Neo4j node and relationship to the browser.

A full database dump will eventually cause:

* Slow Neo4j queries.
* Large network responses.
* Browser memory problems.
* Unreadable visual clutter.
* Slow 3D physics simulation.
* Poor node-selection accuracy.

The page can represent the entire graph, but it should load the graph progressively.

Use these navigation levels:

1. Initial overview
2. Label or project filtering
3. Selected-node neighborhood
4. Path exploration
5. Progressive expansion
6. Full graph mode for small databases only

Default initial limits:

* 300 nodes
* 700 relationships
* Maximum expansion of 100 new nodes per request
* Maximum traversal depth of 2
* Configurable hard limit of 5,000 rendered nodes

These values should be configurable rather than hard-coded.

---

# 3. Recommended Technology Stack

## Frontend

* Next.js
* React
* TypeScript
* `react-force-graph-3d`
* Three.js
* Tailwind CSS
* Zustand for graph-view state
* TanStack Query for API requests and caching

## Backend

* Next.js API routes or a separate FastAPI/Node.js service
* Official Neo4j JavaScript driver
* Cypher queries
* Optional APOC procedures
* Server-side graph data normalization

## Database

* Neo4j
* Neo4j indexes and constraints
* APOC Core where useful

## Initial Rendering Library

Use:

```text
react-force-graph-3d
```

This provides a fast initial implementation while retaining access to Three.js objects for custom node rendering.

Do not build the complete force engine from scratch during the first release.

---

# 4. Proposed Architecture

```text
┌─────────────────────────────────────────────┐
│              Neo4j 3D Page                  │
│                                             │
│  Search   Filters   Layout   Controls       │
│                                             │
│  ┌───────────────────────────────────────┐  │
│  │        3D Graph Visualization         │  │
│  │                                       │  │
│  │    Project ── Goal ── Sprint          │  │
│  │       │                  │             │  │
│  │    Document            Task           │  │
│  └───────────────────────────────────────┘  │
│                                             │
│  Selected Node Inspector                    │
└──────────────────────┬──────────────────────┘
                       │ HTTPS/JSON
                       ▼
┌─────────────────────────────────────────────┐
│              Graph API Layer                │
│                                             │
│  /api/graph/overview                        │
│  /api/graph/search                          │
│  /api/graph/node/:id                        │
│  /api/graph/node/:id/neighbors              │
│  /api/graph/path                            │
│  /api/graph/schema                          │
│  /api/graph/statistics                      │
└──────────────────────┬──────────────────────┘
                       │ Neo4j Driver
                       ▼
┌─────────────────────────────────────────────┐
│                    Neo4j                    │
│                                             │
│  Nodes, labels, properties, relationships   │
└─────────────────────────────────────────────┘
```

---

# 5. Page Layout

Create the route:

```text
/graph/3d
```

The page should have five main areas.

## 5.1 Top Toolbar

Include:

* Graph search
* Project selector
* Node-label filters
* Relationship-type filters
* Layout selector
* Reset camera button
* Fit graph button
* Pause/resume simulation
* Refresh button
* Full-screen button
* Settings button

## 5.2 Left Filter Panel

Show:

* Available Neo4j labels
* Number of nodes for each label
* Available relationship types
* Relationship counts
* Active project
* Maximum traversal depth
* Minimum relationship count
* Property-based filters
* Saved graph views

Example:

```text
Node Labels

☑ Project          14
☑ Goal             37
☑ Sprint           82
☑ Task            426
☐ Document       1,208
☐ Function       4,892

Relationships

☑ CONTAINS
☑ DEPENDS_ON
☑ IMPLEMENTS
☑ BELONGS_TO
☐ REFERENCES
```

## 5.3 Main 3D Canvas

The main canvas should occupy most of the page.

Features:

* Orbit camera
* Mouse zoom
* Node dragging
* Node hover
* Node selection
* Relationship hover
* Direction arrows
* Relationship animation
* Dynamic labels
* Background grid or star field
* Selection highlighting
* Neighbor highlighting
* Camera focus animation

## 5.4 Right Node Inspector

When a node is selected, display:

```text
Node title
Neo4j internal/application ID
Labels
Node type
Status
Owner
Parent
Creation date
Updated date
Properties
Incoming relationships
Outgoing relationships
Connected-node count
```

Actions:

* Focus
* Expand neighbors
* Hide node
* Hide unrelated nodes
* Find path
* Pin node
* Open source record
* Copy node ID
* Copy Cypher query

## 5.5 Bottom Status Bar

Display:

* Nodes currently rendered
* Relationships currently rendered
* Hidden nodes
* Selected node
* Active filters
* Query execution time
* Rendering frame rate
* Simulation status

---

# 6. Graph Data Contract

The frontend should not consume raw Neo4j driver records.

Normalize all results on the server.

## Node Format

```typescript
export interface GraphNode {
  id: string;
  labels: string[];
  primaryLabel: string;
  name: string;
  properties: Record<string, unknown>;

  visual: {
    size: number;
    group: string;
    icon?: string;
  };

  metadata?: {
    connectionCount?: number;
    sourceUrl?: string;
    projectId?: string;
  };
}
```

## Relationship Format

```typescript
export interface GraphRelationship {
  id: string;
  source: string;
  target: string;
  type: string;
  properties: Record<string, unknown>;

  visual?: {
    width?: number;
    animated?: boolean;
  };
}
```

## Graph Response

```typescript
export interface GraphResponse {
  nodes: GraphNode[];
  links: GraphRelationship[];

  pagination?: {
    hasMore: boolean;
    nextCursor?: string;
  };

  metadata: {
    nodeCount: number;
    relationshipCount: number;
    queryDurationMs: number;
    truncated: boolean;
  };
}
```

Use application-level IDs whenever possible.

Neo4j internal element IDs can be included as metadata, but the frontend should not depend exclusively on them as permanent business identifiers.

---

# 7. Backend API

## 7.1 Graph Schema

```text
GET /api/graph/schema
```

Returns:

* Node labels
* Relationship types
* Property names
* Counts
* Supported filters

Example response:

```json
{
  "labels": [
    {
      "name": "Project",
      "count": 14
    },
    {
      "name": "Task",
      "count": 426
    }
  ],
  "relationshipTypes": [
    {
      "name": "CONTAINS",
      "count": 520
    }
  ]
}
```

## 7.2 Overview

```text
GET /api/graph/overview
```

Parameters:

```text
projectId
labels
relationshipTypes
limit
relationshipLimit
layout
```

Purpose:

Load the starting graph.

The overview should prioritize important nodes rather than randomly selecting records.

Suggested priority:

1. Active projects
2. Active goals
3. Current sprints
4. Blocked tasks
5. High-connectivity nodes
6. Recent decisions
7. Important documents

## 7.3 Node Details

```text
GET /api/graph/node/:id
```

Returns:

* Complete properties
* Labels
* Relationship summary
* Source link
* Audit metadata

## 7.4 Expand Neighbors

```text
GET /api/graph/node/:id/neighbors
```

Parameters:

```text
depth=1
limit=100
direction=both
labels=
relationshipTypes=
```

This endpoint supports progressive graph exploration.

## 7.5 Search

```text
GET /api/graph/search?q=
```

Search fields:

* Name
* Title
* ID
* Description
* Project name
* Task name
* Document path
* File path
* Function name

Return lightweight search results first.

The graph page loads the selected node and its neighborhood only after selection.

## 7.6 Path Search

```text
POST /api/graph/path
```

Request:

```json
{
  "sourceId": "goal-123",
  "targetId": "function-981",
  "maxDepth": 8,
  "relationshipTypes": [
    "CONTAINS",
    "IMPLEMENTS",
    "DEPENDS_ON"
  ]
}
```

Response:

* Matching path
* Nodes
* Relationships
* Path length
* Relationship sequence

## 7.7 Graph Statistics

```text
GET /api/graph/statistics
```

Returns:

* Total nodes
* Total relationships
* Counts by label
* Counts by relationship type
* Highly connected nodes
* Orphan nodes
* Recently changed nodes

---

# 8. Example Cypher Queries

## Overview Query

```cypher
MATCH (n)
WHERE any(label IN labels(n) WHERE label IN $labels)
OPTIONAL MATCH (n)-[r]-(m)
WHERE type(r) IN $relationshipTypes
RETURN n, r, m
LIMIT $limit
```

This query is acceptable only as an initial prototype.

The production query should separately limit nodes and relationships so that a highly connected node does not produce an uncontrolled result.

## Selected Node

```cypher
MATCH (n)
WHERE n.id = $nodeId
RETURN n
LIMIT 1
```

## One-Hop Neighborhood

```cypher
MATCH (n)
WHERE n.id = $nodeId
MATCH (n)-[r]-(neighbor)
WHERE
  size($relationshipTypes) = 0
  OR type(r) IN $relationshipTypes
RETURN n, r, neighbor
LIMIT $limit
```

## Directional Neighborhood

```cypher
MATCH (n)
WHERE n.id = $nodeId
MATCH (n)-[r]->(neighbor)
RETURN n, r, neighbor
LIMIT $limit
```

## Search

```cypher
MATCH (n)
WHERE
  toLower(coalesce(n.name, "")) CONTAINS toLower($query)
  OR toLower(coalesce(n.title, "")) CONTAINS toLower($query)
  OR toLower(coalesce(n.description, "")) CONTAINS toLower($query)
  OR toLower(coalesce(n.id, "")) CONTAINS toLower($query)
RETURN n
LIMIT 25
```

## Shortest Path

```cypher
MATCH (source), (target)
WHERE source.id = $sourceId
  AND target.id = $targetId
MATCH path = shortestPath(
  (source)-[*..8]-(target)
)
RETURN path
LIMIT 1
```

Production path queries must use controlled maximum depths and, where possible, approved relationship types.

---

# 9. Visual Mapping

Create one visual configuration registry.

```typescript
export const NODE_STYLES = {
  Organization: {
    shape: "sphere",
    size: 18
  },
  Project: {
    shape: "sphere",
    size: 15
  },
  Goal: {
    shape: "diamond",
    size: 12
  },
  Sprint: {
    shape: "box",
    size: 10
  },
  Epic: {
    shape: "octahedron",
    size: 9
  },
  Story: {
    shape: "box",
    size: 8
  },
  Task: {
    shape: "sphere",
    size: 7
  },
  Document: {
    shape: "box",
    size: 6
  },
  File: {
    shape: "box",
    size: 5
  },
  Function: {
    shape: "sphere",
    size: 4
  }
};
```

The implementation can assign distinct colors by label, but the meaning must not depend only on color.

Also use:

* Shape
* Node size
* Icon
* Label
* Glow
* Border
* Opacity

## Node Size

Size can represent:

* Hierarchy level
* Importance
* Number of connections
* Priority
* Risk
* Activity

Recommended default:

```text
Base size by node type
+
Small connection-count adjustment
+
Selected or alert-state adjustment
```

Do not make highly connected nodes so large that they hide surrounding nodes.

## Relationship Appearance

Examples:

```text
CONTAINS       Solid line
DEPENDS_ON     Dashed line
BLOCKS         Strong animated line
IMPLEMENTS     Directional line
REFERENCES     Thin line
OWNED_BY       Short directional line
DUPLICATES     Warning line
```

Show relationship labels only:

* On hover
* On selection
* Above a zoom threshold
* When the relationship filter contains very few types

Showing every relationship label at once will make the graph unreadable.

---

# 10. Interaction Rules

## Single Click

* Select node.
* Open inspector.
* Highlight direct neighbors.
* Dim unrelated nodes.

## Double Click

* Expand node neighborhood.
* Focus camera on selected node.

## Right Click

Open a context menu:

* Expand incoming
* Expand outgoing
* Expand all
* Hide
* Pin
* Find path from this node
* Find path to this node
* Open source
* Copy ID

## Hover

Show a small tooltip:

```text
Node name
Primary label
Status
Number of connections
```

## Background Click

* Clear selection.
* Restore graph opacity.

## Shift + Click

* Select multiple nodes.
* Compare properties.
* Start path analysis.

## Drag

* Reposition node.
* Optionally pin it at its new position.

---

# 11. Semantic Zoom

The amount of information shown should depend on camera distance.

## Far View

Display:

* Organizations
* Projects
* Major goals
* Major domains

Hide:

* Labels
* Small relationships
* Documents
* Files
* Functions

## Medium View

Display:

* Projects
* Goals
* Sprints
* Epics
* Important tasks
* Major dependencies

## Near View

Display:

* Stories
* Tasks
* Agents
* Decisions
* Documents
* Detailed relationship arrows

## Close View

Display:

* Files
* Classes
* Functions
* Complete node labels
* Property preview
* Code relationships

Semantic zoom should change visibility and detail. It should not automatically issue a database request every time the camera moves.

Database expansion should remain an intentional user action.

---

# 12. Layout Modes

Support multiple ways to organize the graph.

## Force-Directed

Default exploration mode.

Nodes naturally form clusters based on relationships.

## Hierarchical

Example hierarchy:

```text
Organization
  → Project
    → Goal
      → Sprint
        → Epic
          → Story
            → Task
```

Map hierarchy depth to the vertical axis.

## Project Galaxy

Each project becomes a separated cluster.

```text
Project at center
Goals in inner orbit
Sprints in second orbit
Tasks in outer orbit
Documents and files around related tasks
```

## Time Layout

Map time to one axis:

```text
X = creation or execution time
Y = project/domain
Z = hierarchy or importance
```

## Dependency Layout

Place upstream dependencies on one side and downstream dependents on the other.

## Fixed Coordinates

Allow nodes to store saved coordinates:

```text
visual_x
visual_y
visual_z
```

This permits a curated layout to remain stable between sessions.

---

# 13. State Management

The page should track:

```typescript
interface GraphViewState {
  nodes: GraphNode[];
  links: GraphRelationship[];

  selectedNodeIds: string[];
  hoveredNodeId?: string;

  hiddenNodeIds: Set<string>;
  pinnedNodeIds: Set<string>;
  expandedNodeIds: Set<string>;

  enabledLabels: Set<string>;
  enabledRelationshipTypes: Set<string>;

  activeProjectId?: string;
  searchQuery: string;

  layoutMode:
    | "force"
    | "hierarchy"
    | "galaxy"
    | "timeline"
    | "dependency";

  simulationPaused: boolean;
  semanticZoomLevel: number;
}
```

Graph merging must deduplicate by ID.

When expanding a node:

1. Request new neighborhood.
2. Merge unseen nodes.
3. Merge unseen relationships.
4. Preserve selected and pinned state.
5. Restart physics simulation briefly.
6. Stop simulation after stabilization.

---

# 14. Performance Strategy

## Backend Controls

* Enforce maximum result limits.
* Enforce traversal-depth limits.
* Add query timeouts.
* Parameterize Cypher queries.
* Never accept raw Cypher directly from the browser.
* Return only required properties in overview queries.
* Fetch full properties only when the user selects a node.
* Add indexes for application IDs and search fields.

## Frontend Controls

* Render labels only when needed.
* Reduce link particles on large graphs.
* Pause the physics engine after stabilization.
* Avoid creating complex Three.js objects for every small node.
* Use lower geometry detail for distant or unselected nodes.
* Debounce search and filter changes.
* Cache graph requests.
* Dispose removed Three.js resources.
* Use incremental graph updates.
* Display a warning before entering very large graph mode.

## Suggested Rendering Tiers

```text
Tier 1: 0–500 nodes
Full visual effects and labels

Tier 2: 501–2,000 nodes
Reduced labels and relationship animation

Tier 3: 2,001–5,000 nodes
Basic geometry and selected labels only

Tier 4: Above 5,000 nodes
Require filtering, clustering, or server-side aggregation
```

---

# 15. Clustering

Large graphs need aggregation.

Support virtual cluster nodes such as:

```text
Project: GarageOS
Tasks: 426
Documents: 1,208
Functions: 4,892
```

Selecting the cluster reveals its contents progressively.

Possible clustering dimensions:

* Neo4j label
* Project
* Domain
* Module
* Sprint
* Status
* Owner
* Repository
* Directory
* Community-detection result

Cluster nodes are visualization objects. They do not have to be stored as actual Neo4j nodes unless they represent real domain concepts.

---

# 16. Security

Neo4j credentials must never be sent to the browser.

Use this connection flow:

```text
Browser
  → authenticated application API
    → Neo4j driver
      → Neo4j
```

Requirements:

* Store credentials in server environment variables.
* Use a read-only Neo4j account for the first release.
* Authorize graph access by project.
* Validate all query parameters.
* Use parameterized Cypher.
* Limit allowed labels and relationship types.
* Log expensive graph requests.
* Prevent unrestricted arbitrary Cypher execution.
* Redact sensitive properties before serialization.

Example environment variables:

```text
NEO4J_URI=
NEO4J_USERNAME=
NEO4J_PASSWORD=
NEO4J_DATABASE=
```

---

# 17. Suggested Project Structure

```text
src/
├── app/
│   ├── graph/
│   │   └── 3d/
│   │       └── page.tsx
│   │
│   └── api/
│       └── graph/
│           ├── overview/
│           │   └── route.ts
│           ├── schema/
│           │   └── route.ts
│           ├── search/
│           │   └── route.ts
│           ├── statistics/
│           │   └── route.ts
│           ├── path/
│           │   └── route.ts
│           └── node/
│               └── [id]/
│                   ├── route.ts
│                   └── neighbors/
│                       └── route.ts
│
├── components/
│   └── graph-3d/
│       ├── Graph3DCanvas.tsx
│       ├── GraphToolbar.tsx
│       ├── GraphFilterPanel.tsx
│       ├── NodeInspector.tsx
│       ├── NodeTooltip.tsx
│       ├── GraphContextMenu.tsx
│       ├── GraphLegend.tsx
│       ├── GraphStatusBar.tsx
│       ├── GraphSearch.tsx
│       └── GraphSettings.tsx
│
├── lib/
│   ├── neo4j/
│   │   ├── driver.ts
│   │   ├── queries.ts
│   │   ├── normalize.ts
│   │   └── security.ts
│   │
│   └── graph/
│       ├── styles.ts
│       ├── layouts.ts
│       ├── clustering.ts
│       ├── graph-merge.ts
│       └── semantic-zoom.ts
│
├── stores/
│   └── graph-view-store.ts
│
└── types/
    └── graph.ts
```

---

# 18. Implementation Phases

## Phase 1 — Neo4j Connection and Data Contract

Deliverables:

* Install the Neo4j JavaScript driver.
* Configure the server-side Neo4j connection.
* Add environment validation.
* Create node and relationship TypeScript interfaces.
* Create Neo4j record normalization.
* Implement connection health check.
* Add application-ID indexes where needed.

Acceptance criteria:

* The application connects to Neo4j.
* A server-side query returns normalized JSON.
* Neo4j credentials are not visible in browser requests.
* Neo4j integer values serialize safely.

---

## Phase 2 — Basic 3D Graph Page

Deliverables:

* Create `/graph/3d`.
* Install `react-force-graph-3d`.
* Render normalized nodes and relationships.
* Add camera rotation, zoom, and node dragging.
* Add basic node labels.
* Add relationship arrows.
* Add loading and error states.

Acceptance criteria:

* At least 100 nodes and their relationships render correctly.
* Every relationship connects valid source and target nodes.
* The user can rotate and zoom.
* Clicking a node identifies it reliably.
* The graph resizes with the page.

---

## Phase 3 — Node Inspector and Progressive Expansion

Deliverables:

* Create node-detail endpoint.
* Create neighborhood endpoint.
* Add right-side inspector.
* Add single-click selection.
* Add double-click expansion.
* Add focus-camera animation.
* Deduplicate expanded nodes and relationships.
* Add pin and hide actions.

Acceptance criteria:

* Selecting a node shows its properties.
* Expanding a node loads only its neighborhood.
* Expanding the same node twice does not create duplicates.
* The selected node remains visible during graph updates.
* Users can hide and restore nodes.

---

## Phase 4 — Search and Filters

Deliverables:

* Add server-side search.
* Add node-label filters.
* Add relationship-type filters.
* Add project filter.
* Add active-filter summary.
* Add clear-filters action.
* Add search-result camera focus.

Acceptance criteria:

* Searching for a known ID finds the node.
* Label filters update the graph.
* Relationship filters hide unrelated links.
* Selecting a search result loads it if it is not already rendered.
* Filters do not destroy pinned-node state.

---

## Phase 5 — Semantic Zoom and Visual Registry

Deliverables:

* Create node-style registry.
* Assign shape and size by node type.
* Add zoom-based labels.
* Add far, medium, near, and close detail levels.
* Highlight neighbors.
* Dim unrelated nodes.
* Add legend.

Acceptance criteria:

* Distant views remain readable.
* Labels appear only at useful zoom levels.
* Selected nodes are visually distinct.
* Node meaning is not communicated only through color.
* The legend matches the current graph styles.

---

## Phase 6 — Layout Modes

Deliverables:

* Force layout
* Hierarchical layout
* Project galaxy layout
* Timeline layout
* Dependency layout
* Layout-switching control
* Saved node positions

Acceptance criteria:

* The user can switch layouts without reloading the page.
* Selected and pinned nodes remain selected.
* Layout changes do not lose graph data.
* Saved positions can be restored.

---

## Phase 7 — Paths, Clustering, and Large-Graph Controls

Deliverables:

* Add shortest-path endpoint.
* Add two-node path-selection mode.
* Add cluster nodes.
* Add project and label aggregation.
* Add rendering tiers.
* Add graph-size warnings.
* Add server-enforced query limits.

Acceptance criteria:

* The user can select two nodes and display their path.
* Large result sets are clustered or rejected with a useful message.
* The browser remains responsive at the defined production node limit.
* The page reports when results are truncated.

---

## Phase 8 — Production Hardening

Deliverables:

* Authentication
* Project authorization
* Query logging
* Query timeout handling
* Rate limiting
* Error boundaries
* Performance monitoring
* Browser compatibility tests
* Accessibility support
* Unit and integration tests

Acceptance criteria:

* Unauthorized projects cannot be queried.
* Expensive requests are limited and logged.
* Failed Neo4j queries produce readable errors.
* The page works in current Chrome, Edge, Firefox, and Safari.
* Core graph navigation can be used without relying entirely on color.

---

# 19. Testing Plan

## Unit Tests

Test:

* Neo4j record normalization
* Integer conversion
* Node deduplication
* Relationship deduplication
* Graph merging
* Style selection
* Filter logic
* Semantic zoom decisions
* Query parameter validation

## API Integration Tests

Test:

* Overview response
* Node detail
* Neighborhood expansion
* Search
* Path query
* Missing node
* Invalid project access
* Excessive depth
* Excessive node limit
* Neo4j unavailable

## UI Tests

Test:

* Canvas loads
* Node selection
* Inspector opens
* Search focuses node
* Filters update view
* Node expansion
* Pin and hide
* Layout change
* Reset camera
* Full-screen mode
* Path selection

## Performance Tests

Measure:

* Time to first graph
* Query duration
* JSON payload size
* Initial rendering time
* Frame rate
* Expansion time
* Memory usage
* Performance at 500, 2,000, and 5,000 nodes

---

# 20. Definition of Done

The first production release is complete when:

* `/graph/3d` displays live Neo4j data.
* Nodes and relationships are correctly normalized.
* Neo4j credentials remain server-side.
* Users can search, select, inspect, expand, hide, and pin nodes.
* Users can filter labels and relationship types.
* Users can focus the camera on a selected node.
* Large graph requests are controlled.
* The browser does not attempt to load the entire database by default.
* Graph results show whether they were truncated.
* Node access follows project permissions.
* The page includes automated tests.
* Error and loading states are complete.

---

# 21. Recommended First Release Scope

Build these features first:

1. Neo4j server connection
2. Overview endpoint
3. Normalized graph data contract
4. `/graph/3d` page
5. Force-directed 3D graph
6. Node selection
7. Node inspector
8. Neighborhood expansion
9. Label and relationship filters
10. Search
11. Camera focus and reset
12. Query and rendering limits

Delay these features until the foundation is stable:

* Virtual reality
* Augmented reality
* Complex particle systems
* Photorealistic node models
* Real-time multiplayer cursors
* Graph editing
* AI-generated graph layouts
* Rendering tens of thousands of independent nodes

---

# 22. Future Synapse and Archon Integration

After the main explorer is stable, connect it to Archon navigation.

Examples:

```text
Project node
  → Open project dashboard

Sprint node
  → Open Sprint Kanban

Task node
  → Open task editor

Document node
  → Open document viewer

File node
  → Open repository file

Agent node
  → Open agent activity panel

Goal node
  → Open Goal Graph

Conflict node
  → Open governance conflict report
```

Add operator-focused graph views:

* Goal-to-task traceability
* Task ownership
* Duplicate work detection
* Project inheritance
* Blocked dependency chains
* Document-to-code traceability
* Agent activity
* Governance violations
* Unowned nodes
* Orphaned tasks
* Missing parent goals

The 3D page should be an exploration and analysis surface, not the source of truth. Neo4j remains the graph-data source, while Archon remains the operator surface for changing tasks, goals, ownership, and governance state.

The central rule is **progressive loading rather than rendering the entire database at once**. `react-force-graph-3d` already supports 3D force layouts, camera interaction, node dragging, and node/link events, making it a strong base for the first release. ([GitHub][2])

[1]: https://neo4j.com/docs/javascript-manual/current/?utm_source=chatgpt.com "Build applications with Neo4j and JavaScript"
[2]: https://github.com/vasturiano/react-force-graph?utm_source=chatgpt.com "vasturiano/react-force-graph: React component for 2D, 3D, ..."
