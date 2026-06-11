export type AgentId =
  | "health"
  | "performance"
  | "schema-diff"
  | "impact"
  | "onboarding"
  | "analyze"
  | "infer-relations"
  | "dictionary"
  | "er-diagram"
  | "deadlock"
  | "repair";

export type QueryTab = {
  id: string;
  kind: "query";
  name: string;
  connectionId: number;
};
export type AgentTab = { id: string; kind: "agent"; agent: AgentId; name: string };
export type ProjectDrillTab = {
  id: string;
  kind: "project-drill";
  name: string;
};
export type ProjectAgentTab = {
  id: string;
  kind: "project-agent";
  agent: ProjectAgentId;
  name: string;
};
export type MilvusSearchTab = {
  id: string;
  kind: "milvus-search";
  name: string;
  connectionId: number;
  database: string;
  collection: string;
};

export type RedisKeyTab = {
  id: string;
  kind: "redis-key";
  name: string;
  connectionId: number;
  db: number;
  rkey: string;
};

export type RedisConsoleTab = {
  id: string;
  kind: "redis-console";
  name: string;
  connectionId: number;
  db: number;
};

export type TableDesignerTab = {
  id: string;
  kind: "table-designer";
  name: string;
  connectionId: number;
  database: string;
  /** null = create-new-table mode */
  table: string | null;
};

export type Tab =
  | QueryTab
  | AgentTab
  | ProjectDrillTab
  | ProjectAgentTab
  | MilvusSearchTab
  | RedisKeyTab
  | RedisConsoleTab
  | TableDesignerTab;

export function milvusSearchTabId(
  connectionId: number,
  database: string,
  collection: string,
): string {
  return `milvus-search:${connectionId}:${database}:${collection}`;
}

export function redisKeyTabId(connectionId: number, db: number, key: string): string {
  return `redis-key:${connectionId}:${db}:${key}`;
}

export function redisConsoleTabId(connectionId: number, db: number): string {
  return `redis-console:${connectionId}:${db}`;
}

export function tableDesignerTabId(
  connectionId: number,
  database: string,
  table: string | null,
): string {
  return `table-designer:${connectionId}:${database}:${table ?? "__new__"}`;
}

export type ProjectAgentId =
  | "briefing"
  | "health"
  | "impact"
  | "slow-query"
  | "schema-diff"
  | "dictionary"
  | "er-diagram";

export const PROJECT_AGENT_META: Record<
  ProjectAgentId,
  { name: string; sub: string; icon: string }
> = {
  briefing: { name: "Briefing", sub: "AI digest of this project", icon: "📋" },
  health: { name: "Health", sub: "Scan tables in this project", icon: "🏥" },
  impact: { name: "Impact", sub: "Cross-project deps", icon: "🎯" },
  "slow-query": { name: "Slow Query", sub: "Limited to project tables", icon: "🐢" },
  "schema-diff": { name: "Schema Diff", sub: "Compare envs for this project", icon: "🔁" },
  dictionary: { name: "Dictionary", sub: "Annotated schema export", icon: "📖" },
  "er-diagram": { name: "ER Diagram", sub: "Mermaid · cross-conn", icon: "🗺" },
};

export const PROJECT_AGENT_ORDER: ProjectAgentId[] = [
  "briefing",
  "health",
  "impact",
  "slow-query",
  "schema-diff",
  "dictionary",
  "er-diagram",
];

export const PROJECT_DRILL_TAB_ID = "project-drill:default";

export function projectAgentTabId(a: ProjectAgentId): string {
  return `project-agent:${a}`;
}

export const AGENT_META: Record<
  AgentId,
  { name: string; sub: string; icon: string; pill?: { text: string; tone: "crit" | "warn" | "info" | "ok" } }
> = {
  health: {
    name: "Health Check",
    sub: "Scan database",
    icon: "📋",
  },
  performance: {
    name: "Performance",
    sub: "Slow queries · status",
    icon: "🐢",
  },
  "schema-diff": {
    name: "Schema Diff",
    sub: "Compare two databases",
    icon: "🔄",
  },
  impact: {
    name: "Impact Analysis",
    sub: "Column dependencies",
    icon: "🎯",
  },
  onboarding: {
    name: "Onboarding",
    sub: "AI summarize this DB",
    icon: "🤖",
  },
  analyze: {
    name: "Analyze Schema",
    sub: "Heuristic scan · PII",
    icon: "🔍",
  },
  "infer-relations": {
    name: "AI Infer Relations",
    sub: "Fill missing FKs",
    icon: "🪄",
  },
  dictionary: {
    name: "Data Dictionary",
    sub: "PII · relations",
    icon: "📖",
  },
  "er-diagram": {
    name: "ER Diagram",
    sub: "Mermaid · auto layout",
    icon: "🗺",
  },
  deadlock: {
    name: "Deadlock",
    sub: "Parse · AI root cause",
    icon: "🔒",
    pill: { text: "DBA", tone: "crit" },
  },
  repair: {
    name: "Data Repair",
    sub: "Safe DELETE / UPDATE",
    icon: "🛠",
    pill: { text: "writes", tone: "crit" },
  },
};

export function agentTabId(agent: AgentId): string {
  return `agent:${agent}`;
}

export const QUERY_TAB_ID = "query:default";

export function queryTabId(connectionId: number): string {
  return `query:${connectionId}`;
}

export type AppMode =
  | { kind: "home" }
  | { kind: "connection"; connectionId: number }
  | { kind: "project"; projectId: number };

/**
 * Stable key for storing per-workspace tabs and state. Home has no key
 * (no tabs in home view).
 */
export function workspaceKey(mode: AppMode): string {
  switch (mode.kind) {
    case "home":
      return "home";
    case "connection":
      return `conn:${mode.connectionId}`;
    case "project":
      return `proj:${mode.projectId}`;
  }
}

/** Drill record persisted per project — sidebar #6 "Recent drills". */
export type DrillHistoryEntry = {
  id: number;
  project_id: number;
  connection_id: number;
  database_name: string;
  table_name: string;
  column_name: string;
  value_json: string;
  executed_at: string;
};
