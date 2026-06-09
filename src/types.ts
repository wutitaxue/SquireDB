export type ConnectionKind = "mysql" | "milvus" | "sqlite" | "redis";

export type RedisKeyValue =
  | { type: "string"; value: string }
  | { type: "list"; values: string[]; truncated: boolean; total: number }
  | { type: "set"; values: string[]; truncated: boolean; total: number }
  | { type: "hash"; entries: [string, string][]; truncated: boolean; total: number }
  | { type: "zset"; entries: [string, number][]; truncated: boolean; total: number }
  | { type: "none" }
  | { type: "other"; type_name: string };

export type RedisScanResult = {
  cursor: number;
  keys: string[];
};

export type Connection = {
  id: number | null;
  name: string;
  host: string;
  port: number;
  username: string;
  database: string | null;
  kind: ConnectionKind;
  created_at?: string | null;
  last_used_at?: string | null;
};

export type ColumnMeta = { name: string; type_name: string };

export type TableMetaForTree = {
  name: string;
  kind: string;
  estimated_rows: number;
  comment: string;
};

export type ColumnMetaForTree = {
  name: string;
  data_type: string;
  column_type: string;
  is_primary: boolean;
  is_indexed: boolean;
  is_foreign_key: boolean;
  nullable: boolean;
};

export type EditTarget = {
  schema: string;
  table: string;
  pk_columns: string[];
};

export type QueryResult = {
  columns: ColumnMeta[];
  rows: unknown[][];
  elapsed_ms: number;
  rows_affected: number | null;
  editable: EditTarget | null;
};

export type ColumnValue = {
  column: string;
  value: unknown;
};

export type MutationResult = {
  rows_affected: number;
  sql: string;
  last_insert_id: number | null;
};

export type Injection = { sql: string; autorun: boolean; nonce: number };

export type EmbeddingProvider = "openai" | "azure";

export type AiModelView = {
  id: number;
  name: string;
  base_url: string;
  model: string;
  enable_thinking: boolean | null;
  has_api_key: boolean;
  is_active: boolean;
};

export type EmbeddingModelView = {
  id: number;
  name: string;
  provider: EmbeddingProvider;
  base_url: string;
  model: string;
  deployment: string;
  api_version: string;
  dimensions: number | null;
  has_api_key: boolean;
  is_active: boolean;
};

export type ActiveAiSummary = {
  id: number | null;
  name: string | null;
  model: string | null;
};

export type ActiveEmbeddingSummary = {
  id: number | null;
  name: string | null;
  model: string | null;
};

export type McpStatus = {
  enabled: boolean;
  bindPort: number;
  readOnly: boolean;
  allowedConnIds: number[];
  running: boolean;
  actualPort: number;
  requiresRestart: boolean;
};

export type HistoryEntry = {
  id: number;
  connection_id: number;
  sql: string;
  elapsed_ms: number | null;
  rows_affected: number | null;
  rows_returned: number | null;
  error: string | null;
  executed_at: string;
};

export type Annotation = {
  id: number;
  connection_id: number;
  database_name: string;
  table_name: string;
  column_name: string | null;
  semantic_role: string | null;
  pii_type: string | null;
  ai_comment: string | null;
  analyzed_at: string;
};

export type Relation = {
  id: number;
  connection_id: number;
  from_db: string;
  from_table: string;
  from_column: string;
  to_db: string;
  to_table: string;
  to_column: string;
  confidence: number;
  source: string;
  analyzed_at: string;
};

export type AnalyzeReport = {
  tables_analyzed: number;
  columns_analyzed: number;
  annotations_written: number;
  relations_written: number;
  pii_columns: number;
  elapsed_ms: number;
};

export type AiRelationsReport = {
  proposed: number;
  accepted: number;
  rejected_unknown_endpoint: number;
  elapsed_ms: number;
  rejections: string[];
};

export type SqlFixSuggestion = {
  explanation: string;
  fixed_sql: string;
};

export type QuerySuggestion = {
  title: string;
  sql: string;
};

export type ChartConfig = {
  type: string;
  x_axis: string;
  y_axis: string;
  series: string | null;
  title: string;
  reasoning: string | null;
};

export const CHART_TYPES = ["bar", "line", "pie", "scatter", "area"] as const;

export type ExplainNode = {
  kind: string;
  label: string;
  details: Record<string, string>;
  risks: string[];
  children: ExplainNode[];
};

export type TableAccess = {
  table_name: string;
  access_type: string | null;
  possible_keys: string[];
  key: string | null;
  key_length: string | null;
  used_columns: string[];
  rows_examined: number | null;
  filtered: number | null;
  cost: number | null;
  attached_condition: string | null;
  using_index: boolean;
  using_filesort: boolean;
  using_temporary_table: boolean;
};

export type ExplainResult = {
  raw_json: unknown;
  tree: ExplainNode;
  tables: TableAccess[];
  risks: string[];
};

export type ExplainExplanation = {
  summary: string;
  bottleneck: string;
  severity: string;
  advice: string;
};

export type ExplainSqlResponse = {
  plan: ExplainResult;
  explanation: ExplainExplanation | null;
  ai_error: string | null;
};

export type SlowQuery = {
  digest: string;
  digest_text: string;
  schema_name: string | null;
  count_star: number;
  avg_ms: number;
  max_ms: number;
  total_ms: number;
  avg_rows_examined: number;
  avg_rows_sent: number;
  no_index_used: number;
  no_good_index_used: number;
  first_seen: string | null;
  last_seen: string | null;
};

export type PerfStatus = {
  mysql_version: string;
  performance_schema: boolean;
  slow_query_log: boolean;
  long_query_time: number;
  log_output: string;
  slow_query_log_file: string | null;
  digest_table_available: boolean;
};

export type IndexRecommendation = {
  table: string;
  columns: string[];
  index_type: string;
  reason: string;
  alter_sql: string;
};

export type IndexRecommendations = {
  recommendations: IndexRecommendation[];
  expected_benefit: string;
  cost_warning: string;
};

export type InvolvedTableRef = { database: string; table: string };

export type ProcessRow = {
  id: number;
  user: string | null;
  host: string | null;
  db: string | null;
  command: string | null;
  time: number;
  state: string | null;
  info: string | null;
};

export type RuntimeStatus = {
  uptime: number;
  threads_running: number;
  threads_connected: number;
  threads_cached: number;
  queries: number;
  slow_queries: number;
  aborted_connects: number;
  innodb_rows_read: number;
  innodb_rows_inserted: number;
  innodb_rows_updated: number;
  innodb_rows_deleted: number;
  bytes_sent: number;
  bytes_received: number;
};

export type VariableEntry = { name: string; value: string };

export type DiffColumnInfo = {
  name: string;
  column_type: string;
  nullable: boolean;
  default: string | null;
  extra: string;
  comment: string;
  ordinal: number;
};

export type DiffColumnChange = {
  name: string;
  source: DiffColumnInfo;
  target: DiffColumnInfo;
  differences: string[];
};

export type DiffIndexInfo = {
  name: string;
  columns: string[];
  unique: boolean;
};

export type TableDiff = {
  name: string;
  columns_added: DiffColumnInfo[];
  columns_removed: DiffColumnInfo[];
  columns_changed: DiffColumnChange[];
  indexes_added: DiffIndexInfo[];
  indexes_removed: DiffIndexInfo[];
};

export type MigrationStatement = {
  kind: string;
  table: string;
  sql: string;
  destructive: boolean;
};

export type DiffReport = {
  source_db: string;
  target_db: string;
  tables_added: string[];
  tables_removed: string[];
  tables_changed: TableDiff[];
  migrations: MigrationStatement[];
  source_creates: Record<string, string>;
};

export type MigrationRisk = {
  index: number;
  level: string;
  reason: string;
};

export type MigrationRiskReport = {
  assessments: MigrationRisk[];
};

export type RedundantIndex = {
  database: string;
  table: string;
  index_a: string;
  index_a_cols: string;
  index_b: string;
  index_b_cols: string;
  connection_id?: number;
  connection_name?: string;
};

export type UnusedIndex = {
  database: string;
  table: string;
  index: string;
  connection_id?: number;
  connection_name?: string;
};

export type IndexHealth = {
  redundant: RedundantIndex[];
  unused: UnusedIndex[];
  total_indexes: number;
  unused_unavailable_reason: string | null;
};

export type HealthTableRef = {
  database: string;
  table: string;
  connection_id?: number;
  connection_name?: string;
};

export type FragmentedTable = {
  database: string;
  table: string;
  data_free_mb: number;
  data_length_mb: number;
  fragmentation_ratio: number;
  connection_id?: number;
  connection_name?: string;
};

export type TableSize = {
  database: string;
  table: string;
  rows: number;
  data_mb: number;
  index_mb: number;
  total_mb: number;
  connection_id?: number;
  connection_name?: string;
};

export type TableHealth = {
  no_primary_key: HealthTableRef[];
  fragmented: FragmentedTable[];
  largest: TableSize[];
};

export type RemoteRootUser = {
  user: string;
  host: string;
};

export type SecurityCheck = {
  ssl_enabled: boolean;
  require_secure_transport: boolean;
  remote_root: RemoteRootUser[];
  mysql_user_unavailable_reason: string | null;
};

export type HealthReport = {
  elapsed_ms: number;
  server_version: string;
  databases_scanned: string[];
  indexes: IndexHealth;
  tables: TableHealth;
  slow_queries: SlowQuery[];
  security: SecurityCheck;
};

export type HealthOverview = {
  score: number;
  summary: string;
  priorities: string[];
};

export type HealthReportResponse = {
  report: HealthReport;
  ai_overview: HealthOverview | null;
  ai_error: string | null;
};

export type ConnSecurity = {
  connection_id: number;
  connection_name: string;
  check: SecurityCheck;
};

export type ProjectHealthReport = {
  elapsed_ms: number;
  project_id: number;
  project_name: string;
  indexes: IndexHealth;
  tables: TableHealth;
  security_by_connection: ConnSecurity[];
  project_tables_count: number;
  scanned_databases: string[];
  missing_connection_ids: number[];
  missing_connection_names: string[];
};

export type ProjectHealthResponse = {
  report: ProjectHealthReport;
  ai_overview: HealthOverview | null;
  ai_error: string | null;
};

export type OnboardingColumn = {
  name: string;
  data_type: string;
  is_primary: boolean;
  is_indexed: boolean;
  comment: string;
};

export type OnboardingTable = {
  name: string;
  estimated_rows: number;
  data_mb: number;
  comment: string;
  columns: OnboardingColumn[];
};

export type OnboardingFk = {
  from_table: string;
  from_column: string;
  to_table: string;
  to_column: string;
};

export type OnboardingSnapshot = {
  database: string;
  server_version: string;
  tables: OnboardingTable[];
  fks: OnboardingFk[];
  total_tables: number;
  elapsed_ms: number;
};

export type OnboardingEntity = {
  table: string;
  purpose: string;
  importance: string;
};

export type OnboardingFlow = {
  name: string;
  description: string;
  tables: string[];
};

export type OnboardingProject = {
  name: string;
  description: string;
  tables: string[];
  primary_table: string;
};

export type OnboardingReport = {
  overview: string;
  domain_guess: string;
  core_entities: OnboardingEntity[];
  business_flows: OnboardingFlow[];
  suggested_projects: OnboardingProject[];
  next_steps: string[];
};

export type OnboardingResponse = {
  snapshot: OnboardingSnapshot;
  report: OnboardingReport | null;
  ai_error: string | null;
};

export type BriefingColumn = {
  name: string;
  data_type: string;
  is_primary: boolean;
  is_indexed: boolean;
  comment: string;
};

export type BriefingTableRef = {
  connection_id: number;
  connection_name: string;
  database: string;
  table: string;
  alias: string | null;
  is_primary: boolean;
  closed: boolean;
  estimated_rows: number;
  data_mb: number;
  comment: string;
  columns: BriefingColumn[];
};

export type BriefingRelation = {
  from_connection_id: number;
  from_db: string;
  from_table: string;
  from_column: string;
  to_connection_id: number;
  to_db: string;
  to_table: string;
  to_column: string;
  cardinality: string;
  source: string;
  cross_db: boolean;
  cross_conn: boolean;
};

export type ProjectBriefingSnapshot = {
  project_id: number;
  project_name: string;
  project_description: string | null;
  tables: BriefingTableRef[];
  relations: BriefingRelation[];
  total_tables: number;
  total_relations: number;
  missing_connection_ids: number[];
  elapsed_ms: number;
};

export type BriefingKeyRelation = {
  from_table: string;
  to_table: string;
  via: string;
  reads_like: string;
};

export type ProjectBriefingReport = {
  overview: string;
  focus_summary: string;
  core_entities: OnboardingEntity[];
  business_flows: OnboardingFlow[];
  key_relations: BriefingKeyRelation[];
  next_steps: string[];
};

export type ProjectBriefingResponse = {
  snapshot: ProjectBriefingSnapshot;
  report: ProjectBriefingReport | null;
  ai_error: string | null;
};

export type ImpactColumnMeta = {
  database: string;
  table: string;
  column: string;
  data_type: string;
  column_type: string;
  nullable: boolean;
  default: string | null;
  column_key: string;
  comment: string;
};

export type ViewReference = {
  database: string;
  view: string;
  snippet: string;
};

export type RoutineReference = {
  database: string;
  name: string;
  routine_type: string;
  snippet: string;
};

export type TriggerReference = {
  database: string;
  trigger: string;
  event_table: string;
  event: string;
  snippet: string;
};

export type FkReference = {
  from_db: string;
  from_table: string;
  from_column: string;
  to_db: string;
  to_table: string;
  to_column: string;
  direction: string;
};

export type HistoryReference = {
  count: number;
  recent_sql: string[];
};

export type ImpactReport = {
  column: ImpactColumnMeta;
  views: ViewReference[];
  routines: RoutineReference[];
  triggers: TriggerReference[];
  fks: FkReference[];
  history: HistoryReference;
  views_scan_error: string | null;
  routines_scan_error: string | null;
  triggers_scan_error: string | null;
  elapsed_ms: number;
};

export type ChangeScenario = {
  action: string;
  level: string;
  breaks: string[];
};

export type ImpactAssessment = {
  risk_summary: string;
  overall_level: string;
  change_scenarios: ChangeScenario[];
  before_action_advice: string[];
};

export type ImpactResponse = {
  report: ImpactReport;
  assessment: ImpactAssessment | null;
  ai_error: string | null;
};

export type PropagationEdge = {
  from_connection_id: number;
  from_db: string;
  from_table: string;
  from_column: string;
  to_connection_id: number;
  to_db: string;
  to_table: string;
  to_column: string;
  cardinality: string;
  source: string;
  cross_db: boolean;
  cross_conn: boolean;
};

export type PropagationPath = {
  depth: number;
  edges: PropagationEdge[];
};

export type ProjectImpactReport = {
  project_id: number;
  project_name: string;
  column: ImpactColumnMeta;
  connection_id: number;
  connection_name: string;
  propagation_paths: PropagationPath[];
  views: ViewReference[];
  routines: RoutineReference[];
  triggers: TriggerReference[];
  fks: FkReference[];
  history: HistoryReference;
  views_scan_error: string | null;
  routines_scan_error: string | null;
  triggers_scan_error: string | null;
  elapsed_ms: number;
};

export type ProjectImpactResponse = {
  report: ProjectImpactReport;
  assessment: ImpactAssessment | null;
  ai_error: string | null;
};

export type TableCommentReport = {
  columns_documented: number;
  elapsed_ms: number;
};

export type ProjectSlowQuery = SlowQuery & {
  connection_id: number;
  connection_name: string;
  matched_tables: string[];
};

export type ConnPerfStatus = {
  connection_id: number;
  connection_name: string;
  status: PerfStatus | null;
  error: string | null;
};

export type ConnScanError = {
  connection_id: number;
  connection_name: string;
  error: string;
};

export type ProjectSlowQueryReport = {
  elapsed_ms: number;
  project_id: number;
  project_name: string;
  queries: ProjectSlowQuery[];
  perf_by_connection: ConnPerfStatus[];
  total_scanned: number;
  total_matched: number;
  scanned_connection_ids: number[];
  missing_connection_ids: number[];
  missing_connection_names: string[];
  scan_errors: ConnScanError[];
};

export type ProjectSlowOverview = {
  summary: string;
  hotspot_tables: string[];
  priorities: string[];
};

export type ProjectSlowQueryResponse = {
  report: ProjectSlowQueryReport;
  ai_overview: ProjectSlowOverview | null;
  ai_error: string | null;
};

export type ProjectSchemaDiffReport = {
  elapsed_ms: number;
  project_id: number;
  project_name: string;
  source_connection_id: number;
  source_connection_name: string;
  source_db: string;
  target_connection_id: number;
  target_connection_name: string;
  target_db: string;
  scope_tables: string[];
  scope_tables_missing_source: string[];
  scope_tables_missing_target: string[];
  diff: DiffReport;
};

export type ProjectSchemaDiffResponse = {
  report: ProjectSchemaDiffReport;
  risk: MigrationRiskReport | null;
  ai_error: string | null;
};

export type RepairInvestigationQuery = {
  purpose: string;
  sql: string;
  rows: Record<string, unknown>[];
  row_count: number;
  truncated: boolean;
  elapsed_ms: number;
  error: string | null;
};

export type RepairInvestigation = {
  queries: RepairInvestigationQuery[];
};

export type RepairStrategy = {
  kind: string;
  target_table: string;
  strategy_summary: string;
  final_sql: string;
  estimated_rows: number;
  count_probe_sql: string;
  risks: string[];
  where_clause: string;
};

export type RepairSession = {
  id: number;
  connection_id: number;
  database_name: string;
  scope_tables_json: string | null;
  goal: string;
  state: string;
  investigation_json: string | null;
  strategy_json: string | null;
  backup_table_name: string | null;
  final_sql: string | null;
  executed_rows: number | null;
  error: string | null;
  created_at: string;
  updated_at: string;
};

export type DictColumn = {
  name: string;
  data_type: string;
  column_type: string;
  column_key: string;
  nullable: boolean;
  default: string | null;
  comment: string;
  semantic_role: string | null;
  pii_type: string | null;
  ai_comment: string | null;
};

export type DictTable = {
  connection_id: number;
  connection_name: string;
  database: string;
  table: string;
  alias: string | null;
  is_primary: boolean;
  closed: boolean;
  estimated_rows: number;
  data_mb: number;
  comment: string;
  columns: DictColumn[];
};

export type DictRelation = {
  from_connection_id: number;
  from_connection_name: string;
  from_db: string;
  from_table: string;
  from_column: string;
  to_connection_id: number;
  to_connection_name: string;
  to_db: string;
  to_table: string;
  to_column: string;
  cardinality: string;
  source: string;
  cross_db: boolean;
  cross_conn: boolean;
};

export type ProjectDictionarySnapshot = {
  project_id: number;
  project_name: string;
  project_description: string | null;
  generated_at: string;
  tables: DictTable[];
  relations: DictRelation[];
  total_tables: number;
  total_relations: number;
  missing_connection_ids: number[];
  missing_connection_names: string[];
  pii_columns_count: number;
  annotated_columns_count: number;
  elapsed_ms: number;
};

export type ProjectDictionaryResponse = {
  snapshot: ProjectDictionarySnapshot;
  markdown: string;
  html: string;
  ai_summary: string | null;
  ai_error: string | null;
};

export type ErColumn = {
  name: string;
  data_type: string;
  column_type: string;
  column_key: string;
  nullable: boolean;
  pii_type: string | null;
};

export type ErTable = {
  connection_id: number;
  connection_name: string;
  database: string;
  table: string;
  alias: string | null;
  is_primary: boolean;
  closed: boolean;
  columns: ErColumn[];
};

export type ErRelation = {
  from_connection_id: number;
  from_connection_name: string;
  from_db: string;
  from_table: string;
  from_column: string;
  to_connection_id: number;
  to_connection_name: string;
  to_db: string;
  to_table: string;
  to_column: string;
  cardinality: string;
  source: string;
  cross_db: boolean;
  cross_conn: boolean;
};

export type ErSnapshot = {
  scope: "connection" | "project";
  scope_label: string;
  connection_id: number | null;
  project_id: number | null;
  database: string | null;
  generated_at: string;
  tables: ErTable[];
  relations: ErRelation[];
  total_tables: number;
  total_relations: number;
  missing_connection_ids: number[];
  missing_connection_names: string[];
  truncated: boolean;
  truncated_limit: number | null;
  elapsed_ms: number;
};

export type ErDiagramResponse = {
  snapshot: ErSnapshot;
  mermaid: string;
  ai_overview: string | null;
  ai_error: string | null;
};

export type Project = {
  id: number | null;
  name: string;
  description: string | null;
  created_at?: string | null;
};

export type ProjectTable = {
  id: number;
  project_id: number;
  connection_id: number;
  database_name: string;
  table_name: string;
  alias: string | null;
  is_primary: number;
};

export type ProjectRelation = {
  id: number;
  project_id: number;
  from_connection_id: number;
  from_db: string;
  from_table: string;
  from_column: string;
  to_connection_id: number;
  to_db: string;
  to_table: string;
  to_column: string;
  cardinality: string;
  source: string;
};

export const CARDINALITIES = ["1-1", "1-N", "N-1", "N-N"] as const;

export type DrillNode = {
  direction: string;
  relation_id: number;
  from_table: string;
  from_column: string;
  to_connection_id: number;
  to_db: string;
  to_table: string;
  to_column: string;
  cardinality: string;
  label: string;
  rows: Record<string, unknown>[];
  truncated: boolean;
  elapsed_ms: number;
  error: string | null;
  missing_connection: boolean;
};

export type DrillResult = {
  connection_id: number;
  db: string;
  table: string;
  column: string;
  value: unknown;
  primary: Record<string, unknown> | null;
  primary_elapsed_ms: number;
  related: DrillNode[];
  total_elapsed_ms: number;
};

export type DrillContext = {
  connectionId: number;
  db: string;
  table: string;
  column: string;
  value: unknown;
  label: string;
};

export const emptyConnection: Connection = {
  id: null,
  name: "",
  host: "localhost",
  port: 3306,
  username: "root",
  database: null,
  kind: "mysql",
};

export const emptyMilvusConnection: Connection = {
  id: null,
  name: "",
  host: "localhost",
  port: 19530,
  username: "",
  database: null,
  kind: "milvus",
};

export const emptySqliteConnection: Connection = {
  id: null,
  name: "",
  host: "",
  port: 0,
  username: "",
  database: null,
  kind: "sqlite",
};

export const emptyRedisConnection: Connection = {
  id: null,
  name: "",
  host: "localhost",
  port: 6379,
  username: "",
  database: "0",
  kind: "redis",
};

// ============================================================================
// Milvus types
// ============================================================================

export type MilvusCollectionInfo = { name: string };

export type MilvusField = {
  name: string;
  data_type: string;
  is_primary: boolean;
  auto_id: boolean;
  nullable: boolean;
  dim: number | null;
  description: string;
  element_type: string | null;
};

export type MilvusIndex = {
  field_name: string;
  index_name: string;
  index_type: string;
  metric_type: string | null;
  params: unknown;
};

export type MilvusCollectionDescription = {
  name: string;
  description: string;
  fields: MilvusField[];
  indexes: MilvusIndex[];
  row_count: number | null;
  auto_id: boolean;
  enable_dynamic_field: boolean;
};

export type MilvusSearchHit = {
  fields: Record<string, unknown>;
  distance: number;
};

export type MilvusSearchResponse = {
  hits: MilvusSearchHit[];
  elapsed_ms: number;
};

export type MilvusQueryResponse = {
  rows: Record<string, unknown>[];
  elapsed_ms: number;
};

export const SYSTEM_DBS = new Set([
  "information_schema",
  "performance_schema",
  "mysql",
  "sys",
]);

export type DeadlockLockEntry = {
  kind: string;
  state: "waiting" | "holding" | string;
  mode: string;
  database: string | null;
  table: string | null;
  index: string | null;
  gap: boolean;
  record_text: string | null;
  raw: string;
};

export type DeadlockTransaction = {
  slot: number;
  mysql_thread_id: number | null;
  txn_id: string | null;
  query_started_seconds_ago: number | null;
  status: string | null;
  os_thread_handle: string | null;
  thread_query_id: string | null;
  user_host: string | null;
  statement: string | null;
  locks: DeadlockLockEntry[];
  victim: boolean;
};

export type DeadlockReport = {
  detected_at: string | null;
  server_time: string | null;
  transactions: DeadlockTransaction[];
  victim_slot: number | null;
  raw_section: string;
};

export type DeadlockAnalysis = {
  summary: string;
  conflict_cycle: string;
  root_cause: string;
  recommendations: string[];
};

export type DeadlockResponse = {
  has_deadlock: boolean;
  report: DeadlockReport | null;
  status_truncated: boolean;
  status_chars: number;
  message: string | null;
  ai_analysis: DeadlockAnalysis | null;
  ai_error: string | null;
};
